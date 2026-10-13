import {
  CHUNK_SIZE,
  WINDOW_SIZE,
  chunkCount,
  chunkLength,
  validFile,
  validKey,
  publicKey,
  uuid,
  diagnosticRoute,
  diagnosticRecord,
} from "../public/protocol.js";
import { createAuth, permittedRole, publicAuthPaths } from "./auth.js";
import { parseUsersCSV } from "../public/user-csv.js";
import { turnPilot } from "./turn.js";
import { StreamRelay, BATCH_FRAMES } from "./stream-relay.js";

const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const hash = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function check(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
function label(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 64 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
async function validatePublicKey(key) {
  check(validKey(key), 400, "Invalid public key.");
  try {
    await crypto.subtle.importKey(
      "jwk",
      publicKey(key),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new HttpError(400, "Invalid public key.");
  }
}
async function readBody(request, limit) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "Request too large.");
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const incoming = new Headers(request.headers);
    incoming.set("X-Request-ID", requestId);
    request = new Request(request, { headers: incoming });
    const wakeUpgrade =
      request.method === "GET" &&
      /^\/api\/rooms\/[0-9a-f-]{36}\/wake$/.test(url.pathname) &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",")
      .map((v) => v.trim());
    if (
      wakeUpgrade &&
      protocols.length === 2 &&
      ["uos-staff-v1", "uos-guest-v1"].includes(protocols[0]) &&
      /^[a-f0-9]{64}$/.test(protocols[1])
    ) {
      const headers = new Headers(request.headers);
      headers.set("Authorization", "Bearer " + protocols[1]);
      headers.set(
        "X-Guest-Access",
        protocols[0] === "uos-guest-v1" ? "1" : "0",
      );
      request = new Request(request, { headers });
    }
    let response;
    if (url.pathname.startsWith("/api/")) {
      const origin = request.headers.get("Origin");
      if (
        origin &&
        origin !== url.origin &&
        !(env.FRONTEND_ORIGINS || "").split(",").includes(origin)
      )
        response = json(
          { error: "Cross-origin requests are not allowed." },
          403,
        );
      else if (url.pathname === "/api/health")
        response = json({ ok: true, protocol: 4 });
      else {
        try {
          if (
            (request.headers.get("X-Guest-Access") === "1" ||
              (request.headers.has("X-Stream-Lease") &&
                !url.pathname.endsWith("/lease"))) &&
            /^\/api\/rooms\/[0-9a-f-]{36}\//.test(url.pathname)
          ) {
            const headers = new Headers(request.headers);
            for (const name of [
              "X-Account-ID",
              "X-Account-Role",
              "X-Account-Name",
              "X-Setup-Key",
            ])
              headers.delete(name);
            headers.set(
              "X-Access-Mode",
              request.headers.get("X-Guest-Access") === "1" ? "guest" : "lease",
            );
            response = await env.HUB.get(env.HUB.idFromName("exchange")).fetch(
              new Request(request, { headers }),
            );
          } else {
            const auth = createAuth(env);
            if (url.pathname.startsWith("/api/auth/")) {
              check(
                publicAuthPaths.has(url.pathname.slice(9)) &&
                  ["GET", "POST"].includes(request.method),
                404,
                "Page not found.",
              );
              if (request.method === "POST") {
                const body = await readBody(request, 8192);
                if (url.pathname === "/api/auth/sign-in/email") {
                  let credentials;
                  try {
                    credentials = JSON.parse(new TextDecoder().decode(body));
                  } catch {
                    throw new HttpError(400, "Invalid request.");
                  }
                  check(
                    typeof credentials?.email === "string" &&
                      credentials.email.length <= 254,
                    400,
                    "Enter your email.",
                  );
                  const limit = await env.HUB.get(
                    env.HUB.idFromName("exchange"),
                  ).fetch(
                    new Request("https://internal/login-limit", {
                      method: "POST",
                      body: JSON.stringify({
                        email: credentials.email.trim().toLowerCase(),
                      }),
                    }),
                  );
                  if (!limit.ok)
                    throw new HttpError(
                      limit.status,
                      "Too many sign-in attempts for this account. Please wait a minute.",
                    );
                }
                request = new Request(request.url, {
                  method: request.method,
                  headers: request.headers,
                  body,
                });
              }
              const revoking = [
                "/api/auth/sign-out",
                "/api/auth/change-password",
              ].includes(url.pathname)
                ? await auth.api.getSession({ headers: request.headers })
                : null;
              response = await auth.handler(request);
              if (response.ok && revoking?.user)
                await env.HUB.get(env.HUB.idFromName("exchange")).fetch(
                  new Request("https://internal/revoke-account", {
                    method: "POST",
                    body: JSON.stringify({ account: revoking.user.id }),
                  }),
                );
            } else {
              const account = await auth.api.getSession({
                headers: request.headers,
              });
              check(
                account?.user &&
                  !account.user.banned &&
                  permittedRole(account.user.role),
                401,
                "Please sign in.",
              );
              if (
                url.pathname === "/api/admin/diagnostics" &&
                request.method === "GET"
              ) {
                check(
                  account.user.role === "admin",
                  403,
                  "Administrator access required.",
                );
                response = await env.HUB.get(
                  env.HUB.idFromName("exchange"),
                ).fetch(new Request("https://internal/system-log"));
              } else if (url.pathname.startsWith("/api/admin/")) {
                const mutation =
                  request.method === "POST" ? request.clone() : null;
                response = await administration(request, auth, account.user);
                if (
                  response.ok &&
                  [
                    "/api/admin/role",
                    "/api/admin/status",
                    "/api/admin/password",
                  ].includes(url.pathname)
                ) {
                  const body = await mutation.json();
                  await env.HUB.get(env.HUB.idFromName("exchange")).fetch(
                    new Request("https://internal/revoke-account", {
                      method: "POST",
                      body: JSON.stringify({ account: body.userId }),
                    }),
                  );
                }
              } else {
                if (url.pathname === "/api/rooms" && request.method === "POST")
                  check(
                    ["admin", "staff"].includes(account.user.role),
                    403,
                    "Only staff can open a desk.",
                  );
                const headers = new Headers(request.headers);
                headers.delete("X-Access-Mode");
                headers.set("X-Account-ID", account.user.id);
                headers.set("X-Account-Role", account.user.role);
                headers.set(
                  "X-Account-Name",
                  encodeURIComponent(account.user.name),
                );
                headers.delete("X-Setup-Key");
                response = await env.HUB.get(
                  env.HUB.idFromName("exchange"),
                ).fetch(new Request(request, { headers }));
              }
            }
          }
        } catch (error) {
          const status = Number.isInteger(error.status)
            ? error.status
            : Number.isInteger(error.statusCode)
              ? error.statusCode
              : 503;
          response = json(
            {
              error:
                status < 500
                  ? error.body?.message || error.message
                  : "Account service unavailable. Please try again.",
            },
            status,
          );
        }
      }
    } else
      response = await env.ASSETS.fetch(
        url.pathname === "/student"
          ? new Request(new URL("/", url), request)
          : request,
      );
    const headers = new Headers(response.headers);
    headers.set("X-Request-ID", requestId);
    headers.set("X-App-Version", "stream-v1");
    if (
      url.pathname.startsWith("/api/") &&
      response.status >= 400 &&
      !url.pathname.startsWith("/api/rooms/")
    ) {
      await env.HUB?.get(env.HUB.idFromName("exchange"))
        .fetch(
          new Request("https://internal/system-event", {
            method: "POST",
            body: JSON.stringify({
              requestId,
              route: diagnosticRoute(url.pathname),
              method: request.method,
              status: response.status,
            }),
          }),
        )
        .catch(() => {});
    }
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    headers.set(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
    if (response.status === 101)
      return new Response(null, {
        status: 101,
        headers,
        webSocket: response.webSocket,
      });
    return new Response(response.body, { status: response.status, headers });
  },
};

async function administration(request, auth, user) {
  check(user.role === "admin", 403, "Administrator access required.");
  const url = new URL(request.url),
    headers = request.headers;
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    const offset = Number(url.searchParams.get("offset") || 0);
    check(Number.isSafeInteger(offset) && offset >= 0, 400, "Invalid page.");
    return json(
      await auth.api.listUsers({
        headers,
        query: {
          limit: 50,
          offset,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      }),
    );
  }
  check(request.method === "POST", 404, "Page not found.");
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBody(request, 8192)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request.");
  }
  check(
    body && typeof body === "object" && !Array.isArray(body),
    400,
    "Invalid request.",
  );
  if (url.pathname === "/api/admin/users") {
    // Reuse the CSV validation at the server boundary, including the six-character minimum.
    const values = [body.email, body.name, body.role, body.password];
    check(
      values.every((v) => typeof v === "string"),
      400,
      "Enter email, name, role and password.",
    );
    const csv = values
      .map((v) => '"' + v.replaceAll('"', '""') + '"')
      .join(",");
    let imported;
    try {
      [imported] = parseUsersCSV("email,name,role,password\n" + csv);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const result = await auth.api.createUser({ headers, body: imported });
    return json({ user: result.user }, 201);
  }
  check(
    typeof body.userId === "string" && body.userId.length <= 128,
    400,
    "Invalid user.",
  );
  const target = await auth.api.getUser({
    headers,
    query: { id: body.userId },
  });
  check(
    target?.role !== "admin" && body.userId !== user.id,
    403,
    "Administrator accounts cannot be changed here.",
  );
  if (url.pathname === "/api/admin/role") {
    check(permittedRole(body.role), 400, "Invalid role.");
    return json(
      await auth.api.setRole({
        headers,
        body: { userId: body.userId, role: body.role },
      }),
    );
  }
  if (url.pathname === "/api/admin/status") {
    check(typeof body.disabled === "boolean", 400, "Invalid status.");
    return json(
      body.disabled
        ? await auth.api.banUser({
            headers,
            body: {
              userId: body.userId,
              banReason: "Disabled by administrator",
            },
          })
        : await auth.api.unbanUser({ headers, body: { userId: body.userId } }),
    );
  }
  if (url.pathname === "/api/admin/password") {
    check(
      typeof body.password === "string" &&
        body.password.length >= 6 &&
        body.password.length <= 128,
      400,
      "Password must contain 6 to 128 characters.",
    );
    await auth.api.setUserPassword({
      headers,
      body: { userId: body.userId, newPassword: body.password },
    });
    await auth.api.revokeUserSessions({
      headers,
      body: { userId: body.userId },
    });
    return json({ ok: true });
  }
  throw new HttpError(404, "Page not found.");
}

export class TransferHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, invite TEXT NOT NULL, public_key TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (room TEXT NOT NULL, id TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT NOT NULL, public_key TEXT NOT NULL, state TEXT NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, room TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, state TEXT NOT NULL, next INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, received INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS chunks (transfer TEXT NOT NULL, idx INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(transfer, idx));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_bindings (room TEXT NOT NULL, peer TEXT NOT NULL, account TEXT NOT NULL, PRIMARY KEY(room, peer));
      CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, room TEXT, request_id TEXT, method TEXT, route TEXT, status INTEGER, duration INTEGER);
      CREATE TABLE IF NOT EXISTS turn_transfers (id TEXT PRIMARY KEY, room TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS peers_room ON peers(room);
      CREATE INDEX IF NOT EXISTS peers_token ON peers(room, token);
      CREATE INDEX IF NOT EXISTS transfers_room ON transfers(room);
      CREATE INDEX IF NOT EXISTS transfers_sender ON transfers(room, sender);
      CREATE INDEX IF NOT EXISTS transfers_recipient ON transfers(room, recipient);
      CREATE INDEX IF NOT EXISTS events_target ON events(room, recipient, id);
    `);
    this.relay = new StreamRelay();
    this.leases = new Map();
    this.versions = new Map();
    this.waiters = new Map();
    for (const [table, name, type] of [
      ["transfers", "mode", "TEXT DEFAULT 'legacy'"],
      ["transfers", "save_state", "TEXT DEFAULT ''"],
      ["peers", "email", "TEXT DEFAULT ''"],
      ["peers", "student_id", "TEXT DEFAULT ''"],
    ]) {
      if (
        !this.rows("PRAGMA table_info(" + table + ")").some(
          (column) => column.name === name,
        )
      )
        this.sql.exec(
          "ALTER TABLE " + table + " ADD COLUMN " + name + " " + type,
        );
    }
  }
  rows(query, ...args) {
    return [...this.sql.exec(query, ...args)];
  }
  wake(room) {
    this.versions.set(room, (this.versions.get(room) || 0) + 1);
    for (const done of this.waiters.get(room) || []) done();
  }
  async wait(room) {
    const pending = [...this.waiters.values()].reduce(
      (n, set) => n + set.size,
      0,
    );
    check(pending < 100, 429, "Connection updates are busy. Retry shortly.");
    let timer, finish;
    const set = this.waiters.get(room) || new Set();
    this.waiters.set(room, set);
    try {
      await new Promise((resolve) => {
        finish = resolve;
        set.add(finish);
        timer = setTimeout(resolve, 20000);
      });
    } finally {
      clearTimeout(timer);
      set.delete(finish);
      if (!set.size) this.waiters.delete(room);
    }
  }
  one(query, ...args) {
    return this.rows(query, ...args)[0];
  }
  diagnosticRecords(query, ...args) {
    return this.rows(query, ...args).map(diagnosticRecord);
  }
  notify(roomId, targets) {
    const room = this.one("SELECT expires FROM rooms WHERE id = ?", roomId);
    for (const ws of this.ctx.getWebSockets?.("room:" + roomId) || []) {
      try {
        const info = ws.deserializeAttachment();
        const active = room?.expires > Date.now() && info.expires > Date.now();
        if (!active) {
          ws.close(1000, "Session changed");
          continue;
        }
        if (!targets || targets.includes(info.who)) ws.send("changed");
        if (
          info.who !== "desk" &&
          this.one(
            "SELECT state FROM peers WHERE id = ? AND room = ?",
            info.who,
            roomId,
          )?.state === "declined"
        )
          ws.close(1000, "Session changed");
      } catch {
        /* A closed notification socket cannot block a saved transfer. */
      }
    }
  }
  webSocketMessage(ws) {
    ws.close(1008, "Notifications only");
  }
  webSocketClose(ws) {
    ws.close(1000, "Closed");
  }
  webSocketError(ws) {
    ws.close(1011, "Unavailable");
  }
  cleanup() {
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM turn_transfers WHERE expires <= ? OR room NOT IN (SELECT id FROM rooms WHERE expires > ?)",
      now,
      now,
    );
    this.sql.exec(
      "DELETE FROM chunks WHERE transfer IN (SELECT id FROM transfers WHERE room IN (SELECT id FROM rooms WHERE expires <= ?))",
      now,
    );
    this.sql.exec(
      "DELETE FROM transfers WHERE room IN (SELECT id FROM rooms WHERE expires <= ?)",
      now,
    );
    this.sql.exec(
      "DELETE FROM peers WHERE room IN (SELECT id FROM rooms WHERE expires <= ?)",
      now,
    );
    this.sql.exec(
      "DELETE FROM events WHERE created < ? OR room IN (SELECT id FROM rooms WHERE expires <= ?)",
      now - 10 * 60 * 1000,
      now,
    );
    this.sql.exec("DELETE FROM rooms WHERE expires <= ?", now);
    this.sql.exec(
      "DELETE FROM account_bindings WHERE room NOT IN (SELECT id FROM rooms)",
    );
    this.sql.exec("DELETE FROM limits WHERE expires <= ?", now);
  }
  async alarm() {
    this.cleanup();
    if (this.one("SELECT count(*) AS n FROM rooms").n)
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }
  rate(id, max, period = 60 * 60 * 1000) {
    const found = this.one("SELECT * FROM limits WHERE id = ?", id);
    const count = found && found.expires > Date.now() ? found.count : 0;
    check(count < max, 429, "Too many attempts. Please try again later.");
    this.sql.exec(
      "INSERT OR REPLACE INTO limits VALUES (?, ?, ?)",
      id,
      count + 1,
      found && found.expires > Date.now() ? found.expires : Date.now() + period,
    );
  }
  approved(room, peer) {
    return (
      peer === "desk" ||
      this.one("SELECT state FROM peers WHERE room = ? AND id = ?", room, peer)
        ?.state === "approved"
    );
  }
  transfer(room, id, who) {
    const t = this.one(
      "SELECT * FROM transfers WHERE room = ? AND id = ?",
      room,
      id,
    );
    check(
      t && (t.sender === who || t.recipient === who),
      404,
      "Transfer not found.",
    );
    check(
      this.approved(room, t.sender) && this.approved(room, t.recipient),
      403,
      "This connection is not approved.",
    );
    return t;
  }
  declinePeer(room, peer, reason) {
    this.relay.cancelWhere(
      (t) => t.room === room && (t.sender === peer || t.recipient === peer),
    );
    this.sql.exec(
      "UPDATE peers SET state = 'declined' WHERE room = ? AND id = ?",
      room,
      peer,
    );
    this.sql.exec(
      "DELETE FROM chunks WHERE transfer IN (SELECT id FROM transfers WHERE room = ? AND (sender = ? OR recipient = ?) AND state != 'received')",
      room,
      peer,
      peer,
    );
    this.sql.exec(
      "UPDATE transfers SET state = 'rejected', error = ? WHERE room = ? AND (sender = ? OR recipient = ?) AND state != 'received'",
      reason,
      room,
      peer,
      peer,
    );
  }
  async fetch(request) {
    const started = Date.now();
    let response;
    try {
      response = await this.handle(request);
    } catch (error) {
      response = json(
        {
          error: error.status
            ? error.message
            : "The service could not complete this request. Your transfer can be retried.",
        },
        error.status || 500,
      );
    }
    const path = new URL(request.url).pathname;
    if (
      response.ok &&
      request.method !== "GET" &&
      path.startsWith("/api/rooms/") &&
      !path.endsWith("/lease")
    )
      this.wake(path.split("/")[3]);
    if (
      path.startsWith("/api/rooms/") &&
      !path.endsWith("/diagnostics") &&
      (response.status >= 400 ||
        (request.method !== "GET" &&
          !path.includes("/chunks/") &&
          !path.endsWith("/ack") &&
          !path.endsWith("/events")))
    ) {
      this.sql.exec(
        "INSERT INTO diagnostics (time, room, request_id, method, route, status, duration) VALUES (?, ?, ?, ?, ?, ?, ?)",
        Date.now(),
        uuid(path.split("/")[3]) ? path.split("/")[3] : null,
        uuid(request.headers.get("X-Request-ID"))
          ? request.headers.get("X-Request-ID")
          : null,
        ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"].includes(
          request.method,
        )
          ? request.method
          : "[unknown-method]",
        diagnosticRoute(path),
        response.status,
        Date.now() - started,
      );
      this.sql.exec(
        "DELETE FROM diagnostics WHERE time < ? OR id <= (SELECT max(id) - 2000 FROM diagnostics)",
        Date.now() - 86400000,
      );
    }
    return response;
  }
  async handle(request) {
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === "/system-log" && method === "GET")
      return json(
        this.diagnosticRecords(
          "SELECT time, room, request_id, method, route, status, duration FROM diagnostics ORDER BY id DESC LIMIT 300",
        ),
      );
    const segments = url.pathname.split("/").filter(Boolean);
    const chunkRequest = method === "PUT" && segments[5] === "chunks";
    const streamRequest = method === "POST" && segments[5] === "stream";
    const bytes =
      !streamRequest && ["POST", "PUT", "DELETE"].includes(method)
        ? await readBody(request, chunkRequest ? CHUNK_SIZE + 28 : 32768)
        : new Uint8Array();
    let body = {};
    if (bytes.length && !chunkRequest) {
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new HttpError(400, "Invalid request.");
      }
      check(
        body && typeof body === "object" && !Array.isArray(body),
        400,
        "Invalid request.",
      );
    }
    if (url.pathname === "/system-event" && method === "POST") {
      this.sql.exec(
        "INSERT INTO diagnostics (time, request_id, method, route, status, duration) VALUES (?, ?, ?, ?, ?, ?)",
        Date.now(),
        uuid(body.requestId) ? body.requestId : null,
        ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"].includes(
          body.method,
        )
          ? body.method
          : "[unknown-method]",
        diagnosticRoute(body.route),
        body.status,
        0,
      );
      this.sql.exec(
        "DELETE FROM diagnostics WHERE time < ? OR id <= (SELECT max(id) - 2000 FROM diagnostics)",
        Date.now() - 86400000,
      );
      return json({ ok: true });
    }
    if (url.pathname === "/revoke-account" && method === "POST") {
      for (const room of this.rows(
        "SELECT room FROM account_bindings WHERE account = ? AND peer = 'desk'",
        body.account,
      )) {
        this.relay.cancelWhere((t) => t.room === room.room);
        this.sql.exec(
          "UPDATE transfers SET state = 'rejected', error = 'Employee access revoked; resend after reconnecting.' WHERE room = ? AND state NOT IN ('received', 'rejected')",
          room.room,
        );
        this.wake(room.room);
      }
      for (const [key, lease] of this.leases)
        if (lease.account === body.account) {
          this.leases.delete(key);
          this.wake(key.split(":")[0]);
          this.relay.cancelWhere((t) => t.room === key.split(":")[0]);
        }
      return json({ revoked: true });
    }
    if (method === "POST" && url.pathname === "/login-limit") {
      check(
        typeof body.email === "string" && body.email.length <= 254,
        400,
        "Invalid email.",
      );
      this.rate("login:" + (await hash(body.email)), 10, 60000);
      this.sql.exec("DELETE FROM limits WHERE expires <= ?", Date.now());
      return json({ ok: true });
    }
    if (method === "POST" && url.pathname === "/api/rooms") {
      this.cleanup();
      check(
        request.headers.get("X-Account-ID") &&
          ["admin", "staff"].includes(request.headers.get("X-Account-Role")),
        403,
        "Only signed-in staff can open a desk.",
      );
      this.rate(
        "setup:" +
          (await hash(request.headers.get("CF-Connecting-IP") || "local")),
        20,
      );
      check(
        label(body.name) && validKey(body.publicKey),
        400,
        "Enter a desk name and a valid public key.",
      );
      await validatePublicKey(body.publicKey);
      check(
        body.email === undefined ||
          body.email === "" ||
          (typeof body.email === "string" &&
            body.email.length <= 254 &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)),
        400,
        "Enter a valid email address.",
      );
      check(
        body.studentId === undefined ||
          body.studentId === "" ||
          label(body.studentId),
        400,
        "Enter a valid student ID.",
      );
      const id = crypto.randomUUID(),
        owner = token(),
        invite = token(),
        expires = Date.now() + SESSION_MS;
      const ownerHash = await hash(owner),
        inviteSecretHash = await hash(invite);
      check(
        this.one("SELECT count(*) AS n FROM rooms").n < 10,
        429,
        "All desk sessions are in use. End an old session first.",
      );
      this.sql.exec(
        "INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?)",
        id,
        body.name.trim(),
        ownerHash,
        inviteSecretHash,
        JSON.stringify(publicKey(body.publicKey)),
        expires,
      );
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      this.sql.exec(
        "INSERT INTO account_bindings VALUES (?, ?, ?)",
        id,
        "desk",
        request.headers.get("X-Account-ID"),
      );
      return json({ id, token: owner, invite, expires }, 201);
    }
    check(
      segments[0] === "api" && segments[1] === "rooms" && uuid(segments[2]),
      404,
      "Page not found.",
    );
    const roomId = segments[2];
    // Compute credentials before reading room state so asynchronous work cannot retain a stale approval.
    const credential = await hash(
      (request.headers.get("Authorization") || "").replace(/^Bearer /, ""),
    );
    const inviteHash = await hash(request.headers.get("X-Invite") || "");
    const room = this.one("SELECT * FROM rooms WHERE id = ?", roomId);
    check(
      room && room.expires > Date.now(),
      410,
      "This desk session has ended. Ask for a new desk link.",
    );
    if (method === "POST" && segments[3] === "join" && segments.length === 4) {
      if (request.headers.has("X-Account-Name"))
        body.name = decodeURIComponent(request.headers.get("X-Account-Name"));
      check(
        request.headers.get("X-Account-ID") ||
          request.headers.get("X-Access-Mode") === "guest",
        401,
        "Please sign in.",
      );
      this.rate(
        "join:" +
          roomId +
          ":" +
          (await hash(request.headers.get("CF-Connecting-IP") || "local")),
        40,
      );
      check(inviteHash === room.invite, 403, "This desk link is not valid.");
      check(
        label(body.name) && validKey(body.publicKey),
        400,
        "Enter a name or student ID.",
      );
      check(
        body.email === undefined ||
          body.email === "" ||
          (typeof body.email === "string" &&
            body.email.length <= 254 &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)),
        400,
        "Enter a valid email address.",
      );
      check(
        body.studentId === undefined ||
          body.studentId === "" ||
          label(body.studentId),
        400,
        "Enter a valid student ID.",
      );
      await validatePublicKey(body.publicKey);
      const id = crypto.randomUUID(),
        secret = token(),
        secretHash = await hash(secret);
      check(
        this.one("SELECT expires FROM rooms WHERE id = ?", roomId)?.expires >
          Date.now(),
        410,
        "This desk session has ended.",
      );
      check(
        this.one(
          "SELECT count(*) AS n FROM peers WHERE room = ? AND state != 'declined'",
          roomId,
        ).n < 20,
        429,
        "This desk is full. Please try again later.",
      );
      check(
        this.one("SELECT count(*) AS n FROM peers WHERE room = ?", roomId).n <
          200,
        429,
        "This session has reached its visitor history limit. Open a new desk session.",
      );
      this.sql.exec(
        "INSERT INTO peers(room, id, token, name, public_key, state, seen, email, student_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        roomId,
        id,
        secretHash,
        body.name.trim(),
        JSON.stringify(publicKey(body.publicKey)),
        "pending",
        Date.now(),
        typeof body.email === "string" &&
          body.email.length <= 254 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
          ? body.email
          : "",
        typeof body.studentId === "string" && label(body.studentId)
          ? body.studentId.trim()
          : "",
      );
      this.sql.exec(
        "INSERT INTO account_bindings VALUES (?, ?, ?)",
        roomId,
        id,
        request.headers.get("X-Access-Mode") === "guest"
          ? "guest:" + id
          : request.headers.get("X-Account-ID"),
      );
      this.notify(roomId, ["desk"]);
      return json(
        {
          id,
          token: secret,
          publicKey: JSON.parse(room.public_key),
          expires: room.expires,
          name: room.name,
        },
        201,
      );
    }
    let who = "desk";
    let peer;
    if (credential !== room.owner) {
      peer = this.one(
        "SELECT * FROM peers WHERE room = ? AND token = ?",
        roomId,
        credential,
      );
      check(
        peer,
        401,
        "Your connection key is no longer valid. Please reopen the desk link.",
      );
      who = peer.id;
    }
    const lease = this.leases.get(roomId + ":" + who);
    const leased =
      request.headers.get("X-Access-Mode") === "lease" &&
      lease?.expires > Date.now() &&
      lease.token === request.headers.get("X-Stream-Lease");
    if (request.headers.get("X-Access-Mode") === "lease")
      check(leased, 401, "Employee connection expired. Sign in again.");
    if (who === "desk" && !leased)
      check(
        ["admin", "staff"].includes(request.headers.get("X-Account-Role")),
        403,
        "Only staff can use this desk.",
      );
    const binding = this.one(
      "SELECT account FROM account_bindings WHERE room = ? AND peer = ?",
      roomId,
      who,
    );
    // A valid private room token can claim a pre-login session once; new sessions are bound at creation.
    if (!binding && request.headers.get("X-Account-ID"))
      this.sql.exec(
        "INSERT INTO account_bindings VALUES (?, ?, ?)",
        roomId,
        who,
        request.headers.get("X-Account-ID"),
      );
    check(
      (binding?.account ||
        this.one(
          "SELECT account FROM account_bindings WHERE room = ? AND peer = ?",
          roomId,
          who,
        )?.account) ===
        (request.headers.get("X-Access-Mode") === "guest" && who !== "desk"
          ? "guest:" + who
          : leased
            ? lease.account
            : request.headers.get("X-Account-ID")),
      403,
      "This desk session belongs to another account. Open a new session.",
    );
    if (method === "GET" && segments[3] === "wake" && segments.length === 4) {
      const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
        .split(",")
        .map((v) => v.trim());
      const protocol = who === "desk" ? "uos-staff-v1" : "uos-guest-v1";
      check(
        request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
          protocols.length === 2 &&
          protocols[0] === protocol &&
          /^[a-f0-9]{64}$/.test(protocols[1]),
        400,
        "Invalid notification connection.",
      );
      check(
        !peer || peer.state !== "declined",
        403,
        "This connection has ended.",
      );
      check(
        this.ctx.acceptWebSocket && typeof WebSocketPair !== "undefined",
        503,
        "Notifications unavailable.",
      );
      this.rate("wake:" + roomId + ":" + who, 60);
      const tag = "peer:" + roomId + ":" + who;
      const previous = this.ctx.getWebSockets(tag);
      if (previous.length >= 2) previous[0].close(1000, "Connection replaced");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["room:" + roomId, tag]);
      pair[1].serializeAttachment({
        room: roomId,
        who,
        expires: Math.min(room.expires, Date.now() + 600000),
      });
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": protocol },
      });
    }
    if (method === "GET" && segments[3] === "ice" && segments.length === 4) {
      check(this.approved(roomId, who), 403, "Wait for desk approval.");
      this.rate("ice:" + roomId + ":" + who, 12);
      const pilot = turnPilot(this.env);
      return json(
        pilot
          ? {
              enabled: true,
              iceServers: pilot.iceServers,
              expires: pilot.expires,
              iceTransportPolicy: "relay",
            }
          : { enabled: false },
      );
    }
    if (method === "POST" && segments[3] === "lease" && segments.length === 4) {
      check(
        who === "desk" && request.headers.get("X-Account-ID"),
        403,
        "Employee access required.",
      );
      const entry = lease || {
        token: token(),
        account: request.headers.get("X-Account-ID"),
      };
      entry.expires = Date.now() + 90000;
      this.leases.set(roomId + ":" + who, entry);
      return json({ token: entry.token, expires: entry.expires });
    }
    if (
      method === "GET" &&
      segments[3] === "diagnostics" &&
      segments.length === 4
    ) {
      check(
        who === "desk",
        403,
        "Only the desk owner can export server records.",
      );
      return json(
        this.diagnosticRecords(
          "SELECT time, request_id, method, route, status, duration FROM diagnostics WHERE room = ? ORDER BY id DESC LIMIT 300",
          roomId,
        ),
      );
    }
    if (method === "GET" && segments[3] === "state" && segments.length === 4) {
      if (
        url.searchParams.get("wait") === "1" &&
        url.searchParams.get("version") ===
          String(this.versions.get(roomId) || 0)
      ) {
        await this.wait(roomId);
        check(
          this.one("SELECT expires FROM rooms WHERE id = ?", roomId)?.expires >
            Date.now(),
          410,
          "Session ended.",
        );
        if (leased)
          check(
            this.leases.get(roomId + ":" + who) === lease &&
              lease.expires > Date.now(),
            401,
            "Employee access revoked.",
          );
      }
      const since = Number(url.searchParams.get("since") || 0);
      check(
        Number.isSafeInteger(since) && since >= 0,
        400,
        "Invalid event cursor.",
      );
      if (peer && Date.now() - peer.seen > 30000)
        this.sql.exec(
          "UPDATE peers SET seen = ? WHERE id = ?",
          Date.now(),
          who,
        );
      const peers =
        who === "desk"
          ? this.rows(
              "SELECT id, name, public_key, state, seen, email, student_id FROM peers WHERE room = ?",
              roomId,
            )
          : [
              this.one(
                "SELECT id, name, public_key, state, seen FROM peers WHERE id = ?",
                who,
              ),
            ];
      const transfers =
        who === "desk"
          ? this.rows(
              "SELECT * FROM transfers WHERE room = ? ORDER BY created",
              roomId,
            )
          : this.rows(
              "SELECT * FROM transfers WHERE room = ? AND sender = ? UNION ALL SELECT * FROM transfers WHERE room = ? AND recipient = ? ORDER BY created",
              roomId,
              who,
              roomId,
              who,
            );
      const events = this.rows(
        "SELECT id, sender, payload FROM events WHERE room = ? AND recipient = ? AND id > ? ORDER BY id LIMIT 60",
        roomId,
        who,
        since,
      );
      const pilot = turnPilot(this.env);
      const allowed = new Set(
        pilot
          ? this.rows(
              "SELECT id FROM turn_transfers WHERE room = ? AND expires > ?",
              roomId,
              Date.now(),
            ).map((r) => r.id)
          : [],
      );
      return json({
        room: {
          version: this.versions.get(roomId) || 0,
          id: roomId,
          name: room.name,
          expires: room.expires,
          publicKey: JSON.parse(room.public_key),
        },
        self: who,
        batchAcks: true,
        peers: peers.map((p) => ({
          id: p.id,
          name: p.name,
          publicKey: JSON.parse(p.public_key),
          state: p.state,
          seen: p.seen,
          email: p.email || "",
          studentId: p.student_id || "",
        })),
        transfers: transfers.map((t) => ({
          ...t,
          turnAllowed: allowed.has(t.id),
        })),
        turnEnabled: Boolean(pilot),
        events: events.map((e) => ({
          id: e.id,
          from: e.sender,
          ...JSON.parse(e.payload),
        })),
      });
    }
    if (method === "POST" && segments[3] === "leave" && segments.length === 4) {
      check(who !== "desk", 403, "Only a visitor can leave this connection.");
      this.declinePeer(roomId, who, "The visitor left this connection.");
      this.notify(roomId, ["desk", who]);
      return json({ left: true });
    }
    if (method === "DELETE" && segments.length === 3) {
      check(who === "desk", 403, "Only the desk can end a session.");
      this.relay.cancelWhere((t) => t.room === roomId);
      this.sql.exec("UPDATE rooms SET expires = 0 WHERE id = ?", roomId);
      this.cleanup();
      this.notify(roomId);
      return json({ ended: true });
    }
    if (method === "POST" && segments[3] === "peers" && segments.length === 5) {
      check(who === "desk", 403, "Only the desk can approve a connection.");
      check(
        ["approved", "declined"].includes(body.state),
        400,
        "Invalid approval.",
      );
      const targetPeer = this.one(
        "SELECT id, state FROM peers WHERE room = ? AND id = ?",
        roomId,
        segments[4],
      );
      check(targetPeer, 404, "Student not found.");
      check(
        body.state !== "approved" || targetPeer.state !== "declined",
        409,
        "This request has ended. Ask the student to request a new connection.",
      );
      if (body.state === "declined") {
        this.declinePeer(
          roomId,
          segments[4],
          "The desk ended this connection.",
        );
      } else
        this.sql.exec(
          "UPDATE peers SET state = ? WHERE room = ? AND id = ?",
          body.state,
          roomId,
          segments[4],
        );
      this.notify(roomId, ["desk", segments[4]]);
      return json({ state: body.state });
    }
    if (
      method === "POST" &&
      segments[3] === "events" &&
      segments.length === 4
    ) {
      const target = body.to;
      check(
        (who === "desk" && uuid(target)) ||
          (who !== "desk" && target === "desk"),
        403,
        "Messages can only pass between a student and the desk.",
      );
      check(
        this.approved(roomId, who) && this.approved(roomId, target),
        403,
        "Wait for desk approval.",
      );
      check(
        ["signal", "chat"].includes(body.kind) &&
          body.data &&
          typeof body.data === "object" &&
          JSON.stringify(body.data).length <= 20000,
        400,
        "Invalid message.",
      );
      if (body.kind === "signal")
        check(
          uuid(body.data.generation) &&
            ["offer", "answer", "ice"].includes(body.data.type),
          400,
          "Invalid connection message.",
        );
      if (body.kind === "chat")
        check(
          typeof body.data.encrypted === "string" &&
            body.data.encrypted.length <= 6000,
          400,
          "Invalid chat message.",
        );
      const n = this.one(
        "SELECT count(*) AS n FROM events WHERE room = ? AND sender = ? AND created > ?",
        roomId,
        who,
        Date.now() - 60000,
      ).n;
      check(n < 120, 429, "Please wait before sending more messages.");
      this.sql.exec(
        "DELETE FROM events WHERE created < ?",
        Date.now() - 600000,
      );
      check(
        this.one("SELECT count(*) AS n FROM events").n < 2000,
        429,
        "The message queue is busy. Please try again.",
      );
      this.sql.exec(
        "INSERT INTO events(room, sender, recipient, payload, created) VALUES (?, ?, ?, ?, ?)",
        roomId,
        who,
        target,
        JSON.stringify({ kind: body.kind, data: body.data }),
        Date.now(),
      );
      this.notify(roomId, [target]);
      return json({ queued: true }, 201);
    }
    if (
      method === "POST" &&
      segments[3] === "transfers" &&
      segments.length === 4
    ) {
      check(
        uuid(body.id) && validFile(body),
        400,
        "Use a PDF, DOCX, PNG or JPG file up to 150 MB.",
      );
      const to = body.to;
      check(
        (who === "desk" && uuid(to)) || (who !== "desk" && to === "desk"),
        403,
        "Choose an approved recipient.",
      );
      check(
        this.approved(roomId, who) && this.approved(roomId, to),
        403,
        "Wait for desk approval.",
      );
      const existing = this.one(
        "SELECT * FROM transfers WHERE id = ?",
        body.id,
      );
      check(
        body.mode === "stream-v1",
        426,
        "Refresh this page to use encrypted streaming. Existing saved files are retained.",
      );
      if (existing) {
        check(
          existing.room === roomId &&
            existing.sender === who &&
            existing.recipient === to &&
            existing.name === body.name &&
            existing.size === body.size,
          409,
          "This transfer ID is already in use.",
        );
        return json(existing);
      }
      check(
        this.one("SELECT count(*) AS n FROM transfers WHERE room = ?", roomId)
          .n < 100,
        429,
        "This session has reached its transfer limit. Start a new desk session.",
      );
      this.sql.exec(
        "INSERT INTO transfers(id, room, sender, recipient, name, size, state, created, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        body.id,
        roomId,
        who,
        to,
        body.name,
        body.size,
        "offered",
        Date.now(),
        "stream-v1",
      );
      const pilot = turnPilot(this.env);
      if (pilot) {
        // Reserve conservatively for both directions/retries; never expand the free pilot silently.
        const budgetId = "turn-bytes:" + new Date().toISOString().slice(0, 7);
        const budget = this.one(
          "SELECT count, expires FROM limits WHERE id = ?",
          budgetId,
        );
        const used = budget?.expires > Date.now() ? budget.count : 0;
        if (used + body.size * 4 <= pilot.maxBytes) {
          this.sql.exec(
            "INSERT OR REPLACE INTO limits VALUES (?, ?, ?)",
            budgetId,
            used + body.size * 4,
            Date.UTC(
              new Date().getUTCFullYear(),
              new Date().getUTCMonth() + 1,
              1,
            ),
          );
          this.sql.exec(
            "INSERT INTO turn_transfers VALUES (?, ?, ?)",
            body.id,
            roomId,
            pilot.expires,
          );
        }
      }
      this.notify(roomId, [to]);
      return json({ id: body.id }, 201);
    }
    check(
      segments[3] === "transfers" && uuid(segments[4]),
      404,
      "Page not found.",
    );
    const t = this.transfer(roomId, segments[4], who);
    const action = segments[5];
    const total = chunkCount(t.size);
    if (
      t.mode === "stream-v1" &&
      action === "stream-status" &&
      method === "GET" &&
      segments.length === 6
    ) {
      check(
        who === t.sender && t.state === "accepted",
        403,
        "Only the approved sender can stream.",
      );
      const entry = this.relay.channels.get(t.id);
      return json({ ready: Boolean(entry), next: entry?.next ?? t.next });
    }
    if (
      t.mode === "stream-v1" &&
      action === "stream" &&
      segments.length === 6
    ) {
      check(
        t.state === "accepted",
        409,
        "This transfer is no longer accepted.",
      );
      const index = Number(request.headers.get("X-Stream-Index"));
      check(
        request.headers.has("X-Stream-Index") &&
          Number.isSafeInteger(index) &&
          index >= t.next &&
          index < total,
        400,
        "Invalid stream offset.",
      );
      if (method === "GET") {
        check(
          who === t.recipient,
          403,
          "Only the recipient can receive this stream.",
        );
        this.rate("stream-open:" + t.id, 6);
        const readable = this.relay.receive(t, index, () => {
          check(
            this.one("SELECT expires FROM rooms WHERE id = ?", roomId)
              ?.expires > Date.now(),
            410,
            "Session ended.",
          );
          check(
            this.transfer(roomId, t.id, who).state === "accepted",
            403,
            "Transfer revoked.",
          );
          if (leased)
            check(
              this.leases.get(roomId + ":" + who) === lease &&
                lease.expires > Date.now(),
              401,
              "Employee connection expired.",
            );
          const deskLease = this.leases.get(roomId + ":desk");
          check(
            deskLease?.expires > Date.now(),
            401,
            "Employee connection expired.",
          );
        });
        this.sql.exec(
          "UPDATE transfers SET next = ? WHERE id = ?",
          index,
          t.id,
        );
        return new Response(readable, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store, no-transform",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      check(
        method === "POST" && who === t.sender && request.body,
        403,
        "Only the sender can upload this stream.",
      );
      this.rate("stream-upload:" + t.id, Math.ceil(total / BATCH_FRAMES) + 6);
      const next = await this.relay.upload(t, index, request.body);
      this.sql.exec(
        "UPDATE transfers SET next = max(next, ?) WHERE id = ?",
        next,
        t.id,
      );
      return json({ next });
    }
    if (
      t.mode === "stream-v1" &&
      method === "POST" &&
      action === "progress" &&
      segments.length === 6
    ) {
      check(
        who === t.recipient &&
          t.state === "accepted" &&
          Number.isSafeInteger(body.next) &&
          body.next >= t.next &&
          body.next <= total,
        403,
        "Invalid verified progress.",
      );
      this.sql.exec(
        "UPDATE transfers SET next = ? WHERE id = ?",
        body.next,
        t.id,
      );
      return json({ next: body.next });
    }
    if (method === "POST" && action === "saved" && segments.length === 6) {
      check(
        who === t.recipient &&
          t.state === "received" &&
          ["download-initiated", "disk-saved"].includes(body.state),
        403,
        "Invalid save receipt.",
      );
      this.sql.exec(
        "UPDATE transfers SET save_state = ? WHERE id = ?",
        body.state,
        t.id,
      );
      return json({ saved: true });
    }
    if (method === "POST" && action === "accept" && segments.length === 6) {
      check(
        who === t.recipient && ["offered", "accepted"].includes(t.state),
        409,
        "This file cannot be accepted.",
      );
      this.sql.exec(
        "UPDATE transfers SET state = 'accepted' WHERE id = ?",
        t.id,
      );
      this.notify(roomId, [t.sender]);
      return json({ accepted: true });
    }
    if (method === "POST" && action === "reject" && segments.length === 6) {
      check(
        t.state !== "received",
        409,
        "A received file cannot be cancelled.",
      );
      this.sql.exec(
        "UPDATE transfers SET state = 'rejected', error = 'Transfer cancelled or interrupted; please resend.' WHERE id = ?",
        t.id,
      );
      this.sql.exec("DELETE FROM chunks WHERE transfer = ?", t.id);
      this.notify(roomId, [t.sender, t.recipient]);
      this.relay.cancel(t.id);
      return json({ rejected: true });
    }
    if (action === "chunks" && segments.length === 7) {
      const index = Number(segments[6]);
      check(
        Number.isInteger(index) &&
          index >= 0 &&
          index < total &&
          t.state === "accepted",
        400,
        "Invalid file chunk.",
      );
      if (method === "PUT")
        throw new HttpError(
          426,
          "Persistent uploads are disabled. Refresh and resend using streaming.",
        );
      if (method === "GET") {
        check(
          who === t.recipient,
          403,
          "Only the recipient can download this file.",
        );
        const chunk = this.one(
          "SELECT body FROM chunks WHERE transfer = ? AND idx = ?",
          t.id,
          index,
        );
        return chunk
          ? new Response(chunk.body, {
              headers: {
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-store",
              },
            })
          : new Response(null, {
              status: 204,
              headers: { "Cache-Control": "no-store" },
            });
      }
    }
    if (method === "POST" && action === "ack" && segments.length === 6) {
      check(
        who === t.recipient && t.state === "accepted",
        403,
        "Only the recipient can acknowledge this file.",
      );
      check(
        Number.isInteger(body.next) &&
          body.next >= 0 &&
          body.next <= total &&
          body.next <= t.next + (body.batch === true ? WINDOW_SIZE : 1),
        400,
        "Acknowledge chunks in order.",
      );
      if (body.next > t.next) {
        this.sql.exec(
          "UPDATE transfers SET next = ? WHERE id = ?",
          body.next,
          t.id,
        );
        this.sql.exec(
          "DELETE FROM chunks WHERE transfer = ? AND idx < ?",
          t.id,
          body.next,
        );
      }
      if (body.next > t.next) this.notify(roomId, [t.sender]);
      return json({ next: Math.max(t.next, body.next) });
    }
    if (method === "POST" && action === "complete" && segments.length === 6) {
      check(
        who === t.recipient && ["accepted", "received"].includes(t.state),
        403,
        "Only the recipient can confirm receipt.",
      );
      check(
        t.next === total &&
          body.size === t.size &&
          body.integrity === "verified",
        409,
        "This file is not complete.",
      );
      if (t.mode === "stream-v1") {
        check(
          ["received", "download-initiated", "disk-saved"].includes(
            body.saveState,
          ),
          400,
          "Invalid save status.",
        );
        this.sql.exec(
          "UPDATE transfers SET save_state = ? WHERE id = ?",
          body.saveState,
          t.id,
        );
      }
      this.sql.exec(
        "UPDATE transfers SET state = 'received', received = coalesce(received, ?) WHERE id = ?",
        Date.now(),
        t.id,
      );
      this.sql.exec("DELETE FROM chunks WHERE transfer = ?", t.id);
      this.notify(roomId, [t.sender, t.recipient]);
      return json({ received: true });
    }
    throw new HttpError(404, "Page not found.");
  }
}
