// Exercise the compiled Worker and hibernating sockets on a disposable loopback runtime.
// Fixture employee headers exist ONLY in this test entry, never in the deployed Worker.
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { identity } from "../public/crypto.js";

const bundle = await readFile(resolve(process.env.WORKER_TEST_BUNDLE || "worker-build/worker.js"), "utf8");
const entry = `
import worker, { TransferHub } from './native-worker.js';
export { TransferHub };
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/fixture/')) {
    const actor = request.headers.get('X-Test-Actor');
    if (!actor) return new Response('Fixture only', {status:403});
    const headers = new Headers(request.headers);
    headers.set('X-Account-ID', actor); headers.set('X-Account-Role', 'staff');
    const protocols = (headers.get('Sec-WebSocket-Protocol') || '').split(',').map(x=>x.trim());
    if (protocols.length===2) headers.set('Authorization', 'Bearer '+protocols[1]);
    url.pathname = url.pathname.replace('/fixture/', '/api/');
    return env.HUB.get(env.HUB.idFromName('exchange')).fetch(new Request(url, new Request(request,{headers})));
  }
  return worker.fetch(request, env);
}};`;
const runtime = new Miniflare({
  modules: [
    { type: "ESModule", path: resolve("tests/native-entry.js"), contents: entry },
    { type: "ESModule", path: resolve("tests/native-worker.js"), contents: bundle },
  ],
  compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
  durableObjects: { HUB: { className: "TransferHub", useSQLite: true } },
  bindings: {},
});
const sockets = [];
try {
  const url = await runtime.ready;
  const api = async (path, headers, body) => fetch(new URL(path, url), {
    method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const keys = await identity();
  const room = await (await api("/fixture/rooms", { "X-Test-Actor": "owner" }, { name: "Fixture", publicKey: keys.publicKey })).json();
  const owner = { "X-Test-Actor": "owner", Authorization: "Bearer " + room.token };
  const connect = (path, protocols, headers = {}) => new Promise((resolveSocket, reject) => {
    const socketURL = new URL(path, url); socketURL.protocol = "ws:";
    const socket = new WebSocket(socketURL, protocols, { headers }); sockets.push(socket);
    socket.once("open", () => resolveSocket(socket)); socket.once("error", reject);
  });
  const desk = await connect(`/fixture/rooms/${room.id}/wake`, ["uos-staff-v1", room.token], { "X-Test-Actor": "owner" });
  const message = (socket) => new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error("Notification did not arrive")), 3000);
    socket.once("message", (data) => { clearTimeout(timeout); resolveMessage(data.toString()); });
  });
  const joinedNotice = message(desk);
  const guest = await (await api(`/api/rooms/${room.id}/join`, { "X-Guest-Access": "1", "X-Invite": room.invite }, { name: "Fixture guest", publicKey: keys.publicKey })).json();
  assert.equal(await joinedNotice, "changed");
  const visitor = { "X-Guest-Access": "1", Authorization: "Bearer " + guest.token };
  const guestSocket = await connect(`/api/rooms/${room.id}/wake`, ["uos-guest-v1", guest.token]);
  assert.equal(guestSocket.protocol, "uos-guest-v1");
  const approvedNotice = message(guestSocket);
  assert.equal((await api(`/fixture/rooms/${room.id}/peers/${guest.id}`, owner, { state: "approved" })).status, 200);
  assert.equal(await approvedNotice, "changed");
  assert.deepEqual(await (await api(`/api/rooms/${room.id}/ice`, visitor)).json(), { enabled: false });
  // Private desk keys alone, another employee's key, forged headers and wrong origins fail.
  await assert.rejects(connect(`/api/rooms/${room.id}/wake`, ["uos-guest-v1", room.token]));
  await assert.rejects(connect(`/fixture/rooms/${room.id}/wake`, ["uos-staff-v1", room.token], { "X-Test-Actor": "other" }));
  await assert.rejects(connect(`/api/rooms/${room.id}/wake`, ["uos-guest-v1", guest.token], { Origin: "https://attacker.invalid", "X-Account-ID": "owner", "X-Account-Role": "admin" }));
  const declinedNotice = message(guestSocket);
  const closed = new Promise((done) => guestSocket.once("close", done));
  await api(`/fixture/rooms/${room.id}/peers/${guest.id}`, owner, { state: "declined" });
  assert.equal(await declinedNotice, "changed"); await closed;
  await assert.rejects(connect(`/api/rooms/${room.id}/wake`, ["uos-guest-v1", guest.token]));
  console.log("PASS native Worker WebSocket upgrades, private-token headers, push approval, revocation, ownership and origins");
} finally {
  for (const socket of sockets) socket.terminate();
  await runtime.dispose();
}
