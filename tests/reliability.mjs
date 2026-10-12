// Isolated loopback relay: no deployment, real accounts or secrets are used.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { TransferHub } from "../server/worker.js";
import { WebSocketServer } from "ws";

const database = new DatabaseSync(":memory:");
const sockets = new Set();
const hub = new TransferHub(
  {
    getWebSockets: (tag) => [...sockets].filter((ws) => ws.readyState === 1 && (!tag || ws.tags.includes(tag))),
    storage: {
      setAlarm: async () => {},
      sql: {
        exec(query, ...args) {
          if (!args.length && query.includes(";")) {
            database.exec(query);
            return [];
          }
          return database
            .prepare(query)
            .all(
              ...args.map((v) =>
                v instanceof ArrayBuffer ? Buffer.from(v) : v,
              ),
            );
        },
      },
    },
  },
  {},
);
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/api/auth/get-session" || req.url === "/api/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/api/health"
            ? { ok: true, protocol: 3 }
            : {
                user: {
                  id: "fixture-owner",
                  name: "Fixture staff",
                  role: "staff",
                },
              },
        ),
      );
    } else if (req.url.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers(req.headers);
      if (headers.get("X-Guest-Access") === "1")
        headers.set("X-Access-Mode", "guest");
      else {
        headers.set("X-Account-ID", "fixture-owner");
        headers.set("X-Account-Role", "staff");
      }
      const response = await hub.fetch(
        new Request("http://fixture" + req.url, {
          method: req.method,
          headers,
          ...(["GET", "HEAD"].includes(req.method)
            ? {}
            : { body: Buffer.concat(chunks) }),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } else if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><main></main>");
    } else if (["/ui", "/student"].includes(req.url)) {
      res.setHeader("Content-Type", "text/html");
      res.end(await readFile(new URL("../public/index.html", import.meta.url)));
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(await readFile(new URL("../public/style.css", import.meta.url)));
    } else if (/^\/(?:vendor\/)?[a-z-]+\.js$/.test(req.url)) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(new URL("../public" + req.url, import.meta.url)));
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch {
    res.writeHead(500);
    res.end();
  }
});
const socketServer = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] });
server.on("upgrade", async (req, socket, head) => {
  try {
    const match = req.url.match(/^\/api\/rooms\/([0-9a-f-]{36})\/wake$/);
    const protocols = (req.headers["sec-websocket-protocol"] || "").split(",").map((p) => p.trim());
    if (!match || protocols.length !== 2 || !/^[a-f0-9]{64}$/.test(protocols[1])) throw new Error("Invalid fixture socket");
    const headers = new Headers(req.headers);
    headers.set("Authorization", "Bearer " + protocols[1]);
    if (protocols[0] === "uos-guest-v1") headers.set("X-Access-Mode", "guest");
    else { headers.set("X-Account-ID", "fixture-owner"); headers.set("X-Account-Role", "staff"); }
    const response = await hub.fetch(new Request(`http://fixture/api/rooms/${match[1]}/state`, { headers }));
    if (!response.ok) throw new Error("Unauthorized fixture socket");
    const state = await response.json();
    if (state.peers.find((p) => p.id === state.self)?.state === "declined") throw new Error("Ended fixture socket");
    socketServer.handleUpgrade(req, socket, head, (ws) => {
      ws.tags = ["room:" + match[1]];
      ws.deserializeAttachment = () => ({ room: match[1], who: state.self, expires: Date.now() + 600000 });
      sockets.add(ws);
      ws.on("message", () => hub.webSocketMessage(ws));
      ws.on("close", () => sockets.delete(ws));
    });
  } catch { socket.destroy(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  const [staff, guest] = await Promise.all(
    contexts.map((ctx) => ctx.newPage()),
  );
  const errors = [];
  for (const page of [staff, guest]) {
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.RTCPeerConnection = class {
        constructor() {
          throw new Error("RTC blocked in fixture");
        }
      };
      sessionStorage.setItem(
        "system-log",
        JSON.stringify([
          {
            event: "browser-error",
            message: "transcript.pdf password=short6",
            route: "/api/secret=short6",
            time: new Date().toISOString(),
          },
        ]),
      );
    });
    await page.goto(base);
  }
  const room = await staff.evaluate(async () => {
    const db = await import("/storage.js"),
      crypto = await import("/crypto.js");
    const { request, Exchange } = await import("/transfer.js");
    db.useAccount("fixture-owner");
    const keys = await crypto.identity();
    const room = await (
      await request("/rooms", {
        method: "POST",
        body: { name: "Fixture", publicKey: keys.publicKey },
      })
    ).json();
    window.session = {
      id: "staff",
      room: room.id,
      self: "desk",
      token: room.token,
      ...keys,
    };
    await db.put("sessions", window.session);
    window.exchange = new Exchange(window.session, () => {});
    return room;
  });
  const peer = await guest.evaluate(async (room) => {
    const db = await import("/storage.js"),
      crypto = await import("/crypto.js");
    const { request, Exchange } = await import("/transfer.js");
    db.useAccount("fixture-guest");
    const keys = await crypto.identity();
    const peer = await (
      await request(`/rooms/${room.id}/join`, {
        method: "POST",
        headers: { "X-Guest-Access": "1", "X-Invite": room.invite },
        body: { name: "Fixture visitor", publicKey: keys.publicKey },
      })
    ).json();
    window.session = {
      id: "guest",
      room: room.id,
      self: peer.id,
      token: peer.token,
      guest: true,
      deskKey: peer.publicKey,
      ...keys,
    };
    await db.put("sessions", window.session);
    window.exchange = new Exchange(window.session, () => {});
    return peer;
  }, room);
  await staff.evaluate(async (peer) => {
    await window.exchange.api("/peers/" + peer.id, {
      method: "POST",
      body: { state: "approved" },
    });
  }, peer);
  const ids = await staff.evaluate(async (peer) => {
    const db = await import("/storage.js");
    const missing = crypto.randomUUID();
    await db.put("files", {
      id: missing,
      room: window.session.room,
      from: "desk",
      to: peer.id,
      name: "missing.pdf",
      size: 8,
      kind: "outgoing",
    });
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(42);
    bytes.set(new TextEncoder().encode("%PDF-1.7"));
    const healthy = await window.exchange.queue(
      new File([bytes], "healthy.pdf"),
      peer.id,
    );
    return { missing, healthy };
  }, peer);
  const tick = async (page) =>
    page.evaluate(async () => {
      try {
        await window.exchange.tick();
        return null;
      } catch (e) {
        return { name: e.name, message: e.message };
      }
    });
  await staff.evaluate((ids) => {
    const api = window.exchange.api.bind(window.exchange);
    let failed = false;
    window.exchange.api = (path, options) => {
      if (
        !failed &&
        path === "/transfers" &&
        options?.body.id === ids.missing
      ) {
        failed = true;
        const error = new Error("Synthetic offer failure");
        error.status = 503;
        return Promise.reject(error);
      }
      return api(path, options);
    };
  }, ids);
  await tick(staff);
  await tick(guest);
  assert.equal(
    database
      .prepare("SELECT count(*) AS n FROM transfers WHERE id = ?")
      .get(ids.missing).n,
    0,
  );
  assert.equal(
    database
      .prepare("SELECT state FROM transfers WHERE id = ?")
      .get(ids.healthy).state,
    "accepted",
  );
  await staff.evaluate((id) => {
    window.exchange.retries.get(id).after = 0;
  }, ids.missing);
  // Lose an acknowledgement response after the relay has committed it.
  await guest.route("**/ack", async (route) => {
    await route.fetch();
    await route.abort("failed");
    await guest.unroute("**/ack");
  });
  await staff.evaluate((peer) => {
    const api = window.exchange.api.bind(window.exchange);
    window.uploadMetrics = { calls: 0, active: 0, maximum: 0 };
    // Simulate a nominally connected channel that silently loses all packets.
    window.exchange.direct.peers.set(peer.id, {
      pc: { connectionState: "connected", iceConnectionState: "connected", close() {} },
      channel: { readyState: "open", bufferedAmount: 0, send() {}, close() {} },
      attempts: 1, started: Date.now(),
    });
    window.exchange.api = async (path, options) => {
      if (options?.method !== "PUT") return api(path, options);
      const metrics = window.uploadMetrics;
      metrics.calls++;
      metrics.maximum = Math.max(metrics.maximum, ++metrics.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return await api(path, options);
      } finally { metrics.active--; }
    };
  }, peer);
  await tick(staff);
  assert.equal(await staff.evaluate(() => window.uploadMetrics.calls), 0);
  await staff.evaluate(() => {
    for (const chunks of window.exchange.sent.values())
      for (const chunk of chunks.values()) chunk.time = 0;
  });
  await tick(staff);
  assert.equal(await staff.evaluate((peer) => window.exchange.direct.peers.get(peer.id).relayOnly, peer), true);
  assert.equal(database.prepare("SELECT count(*) AS n FROM chunks WHERE transfer = ?").get(ids.healthy).n, 4);
  assert.deepEqual(await staff.evaluate(() => window.uploadMetrics), { calls: 4, active: 0, maximum: 4 });
  await tick(staff);
  assert.equal(await staff.evaluate(() => window.uploadMetrics.calls), 4);
  console.log("PASS stalled direct packets switch to four concurrent HTTPS chunks without duplicate stored uploads");
  await tick(guest);
  assert.equal(database.prepare("SELECT next FROM transfers WHERE id = ?").get(ids.healthy).next, 4);
  assert.equal(await guest.evaluate(async (id) => (await (await import("/storage.js")).get("files", id)).next, ids.healthy), 4);
  // Refresh with both verified chunks and the missing-source failure retained.
  for (const [page, account, id] of [
    [staff, "fixture-owner", "staff"],
    [guest, "fixture-guest", "guest"],
  ]) {
    await page.reload();
    await page.evaluate(
      async ({ account, id }) => {
        const db = await import("/storage.js"),
          { Exchange } = await import("/transfer.js");
        db.useAccount(account);
        window.session = await db.get("sessions", id);
        window.exchange = new Exchange(window.session, () => {});
      },
      { account, id },
    );
  }
  // A bad first transfer must not prevent the healthy second file's exact receipt.
  for (let i = 0; i < 50; i++) {
    await tick(staff);
    await tick(guest);
    if (
      database
        .prepare("SELECT state FROM transfers WHERE id = ?")
        .get(ids.healthy)?.state === "received"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(
    database
      .prepare("SELECT state FROM transfers WHERE id = ?")
      .get(ids.healthy).state,
    "received",
  );
  assert.equal(
    database
      .prepare("SELECT state FROM transfers WHERE id = ?")
      .get(ids.missing).state,
    "accepted",
  );
  assert.equal(
    await guest.evaluate(async (id) => {
      const db = await import("/storage.js");
      const file = await db.get("files", id),
        bytes = new Uint8Array(await file.blob.arrayBuffer());
      return (
        bytes.length === 3 * 1024 * 1024 &&
        new TextDecoder().decode(bytes.slice(0, 8)) === "%PDF-1.7" &&
        bytes.slice(8).every((n) => n === 42)
      );
    }, ids.healthy),
    true,
  );
  console.log(
    "PASS exact persisted bytes after refresh/lost ACK despite a broken earlier transfer",
  );
  // Historical signals must not recreate a direct connection after revocation.
  await staff.evaluate(async (peer) => {
    await window.exchange.api("/peers/" + peer.id, {
      method: "POST",
      body: { state: "declined" },
    });
  }, peer);
  database
    .prepare(
      "INSERT INTO events(room,sender,recipient,payload,created) VALUES(?,?,?,?,?)",
    )
    .run(
      room.id,
      "desk",
      peer.id,
      JSON.stringify({
        kind: "signal",
        data: { type: "offer", generation: crypto.randomUUID(), sdp: "stale" },
      }),
      Date.now(),
    );
  assert.equal(
    await guest.evaluate(async () => {
      let signals = 0;
      window.exchange.direct.signal = async () => {
        signals++;
      };
      await window.exchange.tick();
      return signals;
    }),
    0,
  );
  assert.equal(
    await guest.evaluate(
      async (id) =>
        Boolean((await (await import("/storage.js")).get("files", id)).blob),
      ids.healthy,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS revoked approval ignores stale offers and preserves received documents",
  );
  await guest.evaluate(async () => {
    const { setDiagnosticSnapshot } = await import("/diagnostics.js");
    setDiagnosticSnapshot(() => ({
      role: "guest",
      server: [
        {
          time: Date.now(),
          route: "/api/password=short6/transcript.pdf",
          room: "short6",
          method: "transcript.pdf",
          request_id: "short6",
          message: "transcript.pdf",
          password: "short6",
          status: 503,
        },
      ],
    }));
  });
  await guest.locator(".diagnostics summary").click();
  const downloadReady = guest.waitForEvent("download");
  await guest.locator(".diagnostics button").click();
  const download = await downloadReady,
    stream = await download.createReadStream();
  const parts = [];
  for await (const part of stream) parts.push(part);
  const log = Buffer.concat(parts).toString();
  assert.equal(JSON.parse(log).format, 2);
  for (const secret of [
    "short6",
    "transcript.pdf",
    "healthy.pdf",
    room.token,
    room.invite,
    peer.token,
  ])
    assert.equal(log.includes(secret), false);
  console.log(
    "PASS format-2 downloaded log sanitizes old events and excludes file names and credentials",
  );
  const staffContext = await browser.newContext();
  const studentContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const secondContext = await browser.newContext();
  const uiStaff = await staffContext.newPage(),
    uiStudent = await studentContext.newPage(),
    uiSecond = await secondContext.newPage();
  for (const page of [uiStaff, uiStudent, uiSecond])
    page.on("pageerror", (error) => errors.push(error.message));
  await uiStaff.goto(base + "/ui");
  await uiStaff.locator("#desk-name").fill("Student Services");
  await uiStaff.locator("#desk-form button").click();
  await uiStaff.locator("#workspace").waitFor();
  const invitation = await uiStaff.evaluate(async () => {
    const db = await import("/storage.js"),
      { fingerprint } = await import("/crypto.js");
    const session = await db.get(
      "sessions",
      sessionStorage.getItem("exchange-session"),
    );
    return {
      room: session.room,
      invite: session.invite,
      key: await fingerprint(session.publicKey),
    };
  });
  const invitationURL = base + "/student#" + new URLSearchParams(invitation);
  let studentAuthRequests = 0;
  uiStudent.on("request", (req) => {
    if (req.url().includes("/api/auth/")) studentAuthRequests++;
  });
  // Hold the entry module to inspect the first paint before student routing runs.
  let releaseModule;
  const moduleReady = new Promise((resolve) => {
    releaseModule = resolve;
  });
  await uiStudent.route("**/app.js", async (route) => {
    await moduleReady;
    await route.continue();
  });
  await uiStudent.goto(invitationURL, { waitUntil: "commit" });
  await uiStudent.locator("#login").waitFor({ state: "attached" });
  assert.equal(await uiStudent.locator("#login").isVisible(), false);
  releaseModule();
  await uiStudent.locator("#student-gate[open]").waitFor();
  await mkdir("test-results", { recursive: true });
  await uiStudent.screenshot({ path: "test-results/student-entry.png" });
  await uiStudent
    .locator("#student-name")
    .fill("U12345 <script>alert(1)</script>");
  const approvalStarted = Date.now();
  await uiStudent.locator("#join-form button").click();
  await uiStudent
    .getByRole("heading", { name: "Waiting for staff approval" })
    .waitFor();
  await uiStaff.locator("#approval-dialog[open]").waitFor({ timeout: 4000 });
  assert.ok(Date.now() - approvalStarted < 4000, "Push approval must not wait for the 15-second idle poll");
  assert.equal(await uiStudent.locator("#workspace").isVisible(), false);
  assert.equal(await uiStudent.locator("#student-waiting-spinner").isVisible(), true);
  assert.equal(await uiStudent.locator("#student-waiting-spinner").evaluate(
    (el) => getComputedStyle(el).animationName), "waiting-turn");
  assert.equal(await uiStudent.locator("#files").isDisabled(), true);
  await uiStudent.locator("#files").setInputFiles({
    name: "before-approval.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7"),
  });
  assert.equal(
    await uiStudent.evaluate(
      async () => (await (await import("/storage.js")).all("files")).length,
    ),
    0,
  );
  await uiStudent.screenshot({ path: "test-results/student-waiting.png" });
  await uiStudent.keyboard.press("Escape");
  assert.equal(
    await uiStudent.locator("#student-gate").evaluate((el) => el.open),
    true,
  );
  const beforeReload = database
    .prepare("SELECT count(*) AS n FROM peers WHERE room = ?")
    .get(invitation.room).n;
  await uiStudent.reload();
  await uiStudent
    .getByRole("heading", { name: "Waiting for staff approval" })
    .waitFor();
  assert.equal(
    database
      .prepare("SELECT count(*) AS n FROM peers WHERE room = ?")
      .get(invitation.room).n,
    beforeReload,
  );
  assert.equal(await uiStudent.locator("#login").isVisible(), false);
  assert.equal(
    await uiStudent.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await uiSecond.goto(invitationURL);
  await uiSecond.locator("#student-name").fill("U67890");
  await uiSecond.locator("#join-form button").click();
  await uiSecond
    .getByRole("heading", { name: "Waiting for staff approval" })
    .waitFor();
  await uiStaff.locator("#approval-dialog[open]").waitFor({ timeout: 20000 });
  await uiStaff.screenshot({ path: "test-results/staff-approval.png" });
  assert.equal(
    await uiStaff.locator("#approval-identity").textContent(),
    "U12345 <script>alert(1)</script>",
  );
  assert.equal(await uiStaff.locator("#approval-identity script").count(), 0);
  await uiStaff.locator("#approval-reject").click();
  await uiStaff.locator("#ended-connections").waitFor({ state: "visible" });
  assert.equal(await uiStaff.locator("#ended-connections").evaluate((el) => el.open), false);
  assert.equal((await uiStaff.locator("#connections").textContent()).includes("U12345"), false);
  await uiStudent
    .getByRole("heading", { name: "Request not accepted" })
    .waitFor({ timeout: 20000 });
  await uiStaff
    .locator("#approval-identity")
    .filter({ hasText: "U67890" })
    .waitFor();
  await uiStaff.locator("#approval-approve").click();
  await uiSecond.locator("#workspace").waitFor({ timeout: 20000 });
  assert.equal(await uiSecond.locator("#files").isEnabled(), true);
  assert.equal(await uiSecond.locator("#student-waiting-spinner").isVisible(), false);
  // A stale heartbeat is inactivity, not a revoked approval. Resume the same ID.
  await uiStaff.route("**/state?*", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    for (const peer of state.peers)
      if (peer.state === "approved") peer.seen = Date.now() - 60000;
    await route.fulfill({ response, json: state });
  });
  await uiStaff.evaluate(() => dispatchEvent(new Event("online")));
  await uiStaff.locator("#connections").getByText("Approved · page inactive; waiting to reconnect", { exact: true }).waitFor();
  await uiStaff.unroute("**/state?*");
  await uiStaff.evaluate(() => dispatchEvent(new Event("online")));
  await uiStaff.locator("#connections").getByText("Reconnected — same session", { exact: true }).waitFor();
  await uiSecond.reload();
  await uiSecond.locator("#workspace").waitFor();
  assert.equal(
    await uiSecond.locator("#student-gate").evaluate((el) => el.open),
    false,
  );
  await uiStudent.locator("#student-cancel").click();
  await uiStudent
    .getByRole("heading", { name: "Connect to the desk" })
    .waitFor();
  await uiStudent.locator("#student-name").fill("U12345 <script>alert(1)</script>");
  await uiStudent.locator("#join-form button").click();
  await uiStudent.getByRole("heading", { name: "Waiting for staff approval" }).waitFor();
  await uiStaff.locator("#approval-returning").waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await uiStaff.locator("#approval-returning").textContent(), "Returning name/ID — check identity");
  assert.equal(await uiStudent.locator("#workspace").isVisible(), false);
  await uiStaff.locator("#approval-reject").click();
  await uiStudent.getByRole("heading", { name: "Request not accepted" }).waitFor({ timeout: 20000 });
  await uiStudent.locator("#student-cancel").click();
  await uiStudent.getByRole("heading", { name: "Connect to the desk" }).waitFor();
  await uiStudent.locator("#student-name").fill("Cancel this request");
  await uiStudent.locator("#join-form button").click();
  await uiStudent
    .getByRole("heading", { name: "Waiting for staff approval" })
    .waitFor();
  await uiStudent.locator("#student-cancel").click();
  await uiStudent
    .getByRole("heading", { name: "Connect to the desk" })
    .waitFor();
  assert.equal(
    database
      .prepare("SELECT state FROM peers WHERE room = ? AND name = ?")
      .get(invitation.room, "Cancel this request").state,
    "declined",
  );
  assert.equal(studentAuthRequests, 0);
  assert.deepEqual(errors, []);
  // Employee sign-in still appears when no employee session is present.
  const loggedOut = await staffContext.newPage();
  await loggedOut.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null }),
  );
  await loggedOut.goto(base + "/ui");
  await loggedOut.locator("#login").waitFor();
  await uiSecond.locator("#files").setInputFiles({
    name: "ui-saved.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nSaved UI regression document"),
  });
  await uiStaff
    .locator("#file-list .file")
    .filter({ hasText: "ui-saved.pdf" })
    .getByText("Received", { exact: false })
    .waitFor({ timeout: 30000 });
  await uiSecond
    .locator("#file-list .file")
    .filter({ hasText: "ui-saved.pdf" })
    .getByText("Received", { exact: false })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await uiStaff.evaluate(async () => {
      const file = (await (await import("/storage.js")).all("files")).find(
        (f) => f.name === "ui-saved.pdf",
      );
      return file.blob.text();
    }),
    "%PDF-1.7\nSaved UI regression document",
  );
  await uiStaff
    .locator("#approval-dialog[open]")
    .waitFor({ state: "hidden", timeout: 20000 });
  uiStaff.on("dialog", (dialog) => dialog.accept());
  await uiStaff.locator("#leave").click();
  await uiSecond
    .getByRole("heading", { name: "This session has ended" })
    .waitFor({ timeout: 20000 });
  await uiSecond.locator("#student-saved").click();
  await uiSecond.locator("#saved-card").waitFor();
  assert.equal(
    await uiSecond
      .locator("#saved-list")
      .getByText("ui-saved.pdf", { exact: true })
      .isVisible(),
    true,
  );
  await uiSecond.reload();
  await uiSecond
    .getByRole("heading", { name: "This session has ended" })
    .waitFor();
  await uiSecond.locator("#student-saved").click();
  await uiSecond
    .locator("#saved-list")
    .getByText("ui-saved.pdf", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS student first paint, name popup, locked waiting/reload, queued staff approval/rejection, cancellation and employee login",
  );
} finally {
  await browser?.close();
  for (const ws of sockets) ws.terminate();
  socketServer.close();
  await new Promise((resolve) => server.close(resolve));
  database.close();
}
