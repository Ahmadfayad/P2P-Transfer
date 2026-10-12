// Isolated loopback relay: no deployment, real accounts or secrets are used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { TransferHub } from "../server/worker.js";

const database = new DatabaseSync(":memory:");
const hub = new TransferHub(
  {
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
    if (req.url.startsWith("/api/")) {
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
    } else if (/^\/[a-z-]+\.js$/.test(req.url)) {
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
    const bytes = new Uint8Array(1024 * 1024).fill(42);
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
  await tick(staff);
  await tick(guest);
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
        bytes.length === 1024 * 1024 &&
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
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  database.close();
}
