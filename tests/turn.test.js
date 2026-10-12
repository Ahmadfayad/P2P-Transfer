import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { turnPilot } from "../server/turn.js";
import { TransferHub } from "../server/worker.js";
import { identity } from "../public/crypto.js";
import { CHUNK_SIZE } from "../public/protocol.js";

const pilot = () => ({
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  maxBytes: 128,
  iceServers: [{ urls: "turns:standard.relay.metered.ca:443?transport=tcp", username: "fixture-turn-user", credential: "fixture-turn-password" }],
});

test("TURN pilot rejects expired, unbounded and arbitrary-server configurations", () => {
  const config = pilot();
  assert.equal(turnPilot({}), null);
  assert.equal(turnPilot({ TURN_PILOT_CONFIG: JSON.stringify(config) }).iceServers.length, 1);
  for (const invalid of [
    { ...config, expiresAt: new Date(0).toISOString() },
    { ...config, expiresAt: new Date(Date.now() + 2 * 86400000).toISOString() },
    { ...config, maxBytes: 2 ** 40 },
    { ...config, iceServers: [{ ...config.iceServers[0], urls: "turns:attacker.invalid:443" }] },
  ]) assert.equal(turnPilot({ TURN_PILOT_CONFIG: JSON.stringify(invalid) }), null);
});

test("TURN credentials require approval/ownership and the pilot byte reservation stops at its cap", async () => {
  const database = new DatabaseSync(":memory:");
  const sent = [], closed = [];
  const ctx = {
    storage: { setAlarm: async () => {}, sql: { exec(query, ...args) {
      if (!args.length && query.includes(";")) { database.exec(query); return []; }
      return database.prepare(query).all(...args.map((v) => v instanceof ArrayBuffer ? Buffer.from(v) : v));
    } } },
    getWebSockets: () => sockets,
  };
  const hub = new TransferHub(ctx, { TURN_PILOT_CONFIG: JSON.stringify(pilot()) });
  const staff = { "X-Account-ID": "owner", "X-Account-Role": "staff" };
  const keys = await identity();
  const send = (path, headers, body) => hub.fetch(new Request("https://fixture/api/rooms" + path, {
    method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  let sockets = [];
  try {
    const room = await (await send("", staff, { name: "Fixture", publicKey: keys.publicKey })).json();
    const owner = { ...staff, Authorization: "Bearer " + room.token };
    const guest = await (await send("/" + room.id + "/join", { "X-Access-Mode": "guest", "X-Invite": room.invite }, { name: "Fixture guest", publicKey: keys.publicKey })).json();
    const visitor = { "X-Access-Mode": "guest", Authorization: "Bearer " + guest.token };
    assert.equal((await send(`/${room.id}/ice`, visitor)).status, 403);
    assert.equal((await send(`/${room.id}/ice`, { ...owner, "X-Account-ID": "other" })).status, 403);
    await send(`/${room.id}/peers/${guest.id}`, owner, { state: "approved" });
    const ice = await (await send(`/${room.id}/ice`, visitor)).json();
    assert.equal(ice.enabled, true);
    assert.equal(ice.iceTransportPolicy, "relay");
    const batchId = crypto.randomUUID();
    await send(`/${room.id}/transfers`, visitor, { id: batchId, name: "batch.pdf", size: CHUNK_SIZE * 6, to: "desk" });
    await send(`/${room.id}/transfers/${batchId}/accept`, owner, {});
    assert.equal((await send(`/${room.id}/transfers/${batchId}/ack`, owner, { next: 5, batch: true })).status, 400);
    assert.equal((await send(`/${room.id}/transfers/${batchId}/ack`, owner, { next: 4 })).status, 400);
    assert.equal((await send(`/${room.id}/transfers/${batchId}/ack`, visitor, { next: 4, batch: true })).status, 403);
    assert.equal((await send(`/${room.id}/transfers/${batchId}/ack`, owner, { next: 4, batch: true })).status, 200);
    assert.equal((await send(`/${room.id}/transfers/${batchId}/ack`, owner, { next: 4, batch: true })).status, 200);
    for (let i = 0; i < 3; i++) {
      assert.equal((await send(`/${room.id}/transfers`, visitor, { id: crypto.randomUUID(), name: "fixture.pdf", size: 16, to: "desk" })).status, 201);
    }
    const state = await (await send(`/${room.id}/state`, visitor)).json();
    assert.deepEqual(state.transfers.filter((t) => t.id !== batchId).map((t) => t.turnAllowed), [true, true, false]);
    const attachment = { room: room.id, who: guest.id, expires: Date.now() + 60000 };
    sockets = [{ deserializeAttachment: () => attachment, send: (message) => sent.push(message), close: () => closed.push(true) }];
    await send(`/${room.id}/peers/${guest.id}`, owner, { state: "declined" });
    assert.deepEqual(sent, ["changed"]);
    assert.equal(closed.length, 1);
    assert.equal((await send(`/${room.id}/ice`, visitor)).status, 403);
    const log = JSON.stringify(await (await send(`/${room.id}/diagnostics`, owner)).json());
    for (const secret of ["fixture.pdf", "fixture-turn-password", room.token, guest.token]) assert.equal(log.includes(secret), false);
    attachment.expires = 0;
    hub.notify(room.id);
    assert.equal(sent.length, 1);
  } finally { database.close(); }
});
