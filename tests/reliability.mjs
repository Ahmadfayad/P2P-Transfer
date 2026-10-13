// CI-only loopback: synthetic identities and an in-memory database, no deployment credentials.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
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
const users = [
  {
    id: "fixture-staff",
    email: "staff@fixture.invalid",
    name: "Fixture staff",
    role: "staff",
    banned: false,
  },
  {
    id: "fixture-admin",
    email: "admin@fixture.invalid",
    name: "Fixture admin",
    role: "admin",
    banned: false,
  },
];
const server = createServer(async (req, res) => {
  try {
    const actor = users.find((u) =>
      req.headers.cookie?.includes("fixture=" + u.role),
    );
    const send = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/auth/sign-in/email") {
      let body = "";
      for await (const bytes of req) body += bytes;
      const user = users.find((u) => u.email === JSON.parse(body).email);
      if (!user || user.banned) return send({ error: "Fixture denied" }, 403);
      res.setHeader(
        "Set-Cookie",
        "fixture=" + user.role + "; Path=/; HttpOnly; SameSite=Lax",
      );
      return send({ user });
    }
    if (req.url === "/api/auth/get-session")
      return send(actor && !actor.banned ? { user: actor } : null);
    if (req.url === "/api/health") return send({ ok: true, protocol: 4 });
    if (req.url === "/api/admin/users")
      return actor?.role === "admin" ? send({ users }) : send({}, 403);
    if (req.url === "/api/admin/status") {
      if (actor?.role !== "admin") return send({}, 403);
      let body = "";
      for await (const bytes of req) body += bytes;
      const command = JSON.parse(body),
        target = users.find((u) => u.id === command.userId);
      target.banned = command.disabled;
      await hub.fetch(
        new Request("https://internal/revoke-account", {
          method: "POST",
          body: JSON.stringify({ account: target.id }),
        }),
      );
      return send({ ok: true });
    }
    if (req.url.startsWith("/api/")) {
      const headers = new Headers(req.headers);
      for (const key of [
        "X-Account-ID",
        "X-Account-Role",
        "X-Account-Name",
        "X-Access-Mode",
      ])
        headers.delete(key);
      if (headers.get("X-Guest-Access") === "1")
        headers.set("X-Access-Mode", "guest");
      else if (headers.has("X-Stream-Lease") && !req.url.endsWith("/lease"))
        headers.set("X-Access-Mode", "lease");
      else {
        if (!actor || actor.banned)
          return send({ error: "Please sign in" }, 401);
        headers.set("X-Account-ID", actor.id);
        headers.set("X-Account-Role", actor.role);
      }
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const request = new Request("http://fixture" + req.url, {
        method: req.method,
        headers,
        signal: controller.signal,
        ...(["GET", "HEAD"].includes(req.method)
          ? {}
          : { body: Readable.toWeb(req), duplex: "half" }),
      });
      const response = await hub.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const stream = Readable.fromWeb(response.body);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      } else res.end();
      return;
    }
    const path = ["/", "/student"].includes(req.url) ? "/index.html" : req.url;
    if (!/^\/(?:vendor\/)?[a-z.-]+$/.test(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(new URL("../public" + path, import.meta.url)));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    } else res.destroy();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.TEST_URL = "http://127.0.0.1:" + server.address().port;
process.env.LOOPBACK_RELIABILITY = "1";
process.env.CHROME_PATH ||= chromium.executablePath();
try {
  await import("./stream-browser.mjs");
} finally {
  hub.relay.cancelWhere(() => true);
  for (const room of hub.waiters.keys()) hub.wake(room);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  database.close();
}
