import {
  CHUNK_SIZE,
  WINDOW_SIZE,
  chunkCount,
  chunkLength,
  validFile,
  validKey,
  publicKey,
  uuid,
} from "../public/protocol.js";

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
    let response;
    if (url.pathname.startsWith("/api/")) {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin)
        response = json(
          { error: "Cross-origin requests are not allowed." },
          403,
        );
      else if (url.pathname === "/api/health")
        response = json({ ok: true, protocol: 3 });
      else
        response = await env.HUB.get(env.HUB.idFromName("exchange")).fetch(
          request,
        );
    } else response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  },
};

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
      CREATE INDEX IF NOT EXISTS peers_room ON peers(room);
      CREATE INDEX IF NOT EXISTS transfers_room ON transfers(room);
      CREATE INDEX IF NOT EXISTS events_target ON events(room, recipient, id);
    `);
  }
  rows(query, ...args) {
    return [...this.sql.exec(query, ...args)];
  }
  one(query, ...args) {
    return this.rows(query, ...args)[0];
  }
  cleanup() {
    const now = Date.now();
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
    this.sql.exec("DELETE FROM limits WHERE expires <= ?", now);
  }
  async alarm() {
    this.cleanup();
    if (this.one("SELECT count(*) AS n FROM rooms").n)
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }
  rate(id, max) {
    const found = this.one("SELECT * FROM limits WHERE id = ?", id);
    const count = found && found.expires > Date.now() ? found.count : 0;
    check(count < max, 429, "Too many attempts. Please try again later.");
    this.sql.exec(
      "INSERT OR REPLACE INTO limits VALUES (?, ?, ?)",
      id,
      count + 1,
      found && found.expires > Date.now()
        ? found.expires
        : Date.now() + 60 * 60 * 1000,
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
  async fetch(request) {
    try {
      return await this.handle(request);
    } catch (error) {
      return json(
        {
          error: error.status
            ? error.message
            : "The service could not complete this request. Your transfer can be retried.",
        },
        error.status || 500,
      );
    }
  }
  async handle(request) {
    const url = new URL(request.url);
    const method = request.method;
    const segments = url.pathname.split("/").filter(Boolean);
    const chunkRequest = method === "PUT" && segments[5] === "chunks";
    const bytes = ["POST", "PUT", "DELETE"].includes(method)
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
    if (method === "POST" && url.pathname === "/api/rooms") {
      this.cleanup();
      check(
        this.env.DESK_SETUP_KEY && this.env.DESK_SETUP_KEY.length >= 16,
        503,
        "Desk access has not been configured.",
      );
      this.rate(
        "setup:" +
          (await hash(request.headers.get("CF-Connecting-IP") || "local")),
        20,
      );
      check(
        (await hash(request.headers.get("X-Setup-Key") || "")) ===
          (await hash(this.env.DESK_SETUP_KEY)),
        403,
        "Incorrect desk access key.",
      );
      check(
        label(body.name) && validKey(body.publicKey),
        400,
        "Enter a desk name and a valid public key.",
      );
      await validatePublicKey(body.publicKey);
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
        this.one("SELECT count(*) AS n FROM peers WHERE room = ?", roomId).n <
          20,
        429,
        "This desk is full. Please try again later.",
      );
      this.sql.exec(
        "INSERT INTO peers VALUES (?, ?, ?, ?, ?, ?, ?)",
        roomId,
        id,
        secretHash,
        body.name.trim(),
        JSON.stringify(publicKey(body.publicKey)),
        "pending",
        Date.now(),
      );
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
    if (method === "GET" && segments[3] === "state" && segments.length === 4) {
      const since = Number(url.searchParams.get("since") || 0);
      check(
        Number.isSafeInteger(since) && since >= 0,
        400,
        "Invalid event cursor.",
      );
      if (peer)
        this.sql.exec(
          "UPDATE peers SET seen = ? WHERE id = ?",
          Date.now(),
          who,
        );
      const peers =
        who === "desk"
          ? this.rows(
              "SELECT id, name, public_key, state, seen FROM peers WHERE room = ?",
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
              "SELECT * FROM transfers WHERE room = ? AND (sender = ? OR recipient = ?) ORDER BY created",
              roomId,
              who,
              who,
            );
      const events = this.rows(
        "SELECT id, sender, payload FROM events WHERE room = ? AND recipient = ? AND id > ? ORDER BY id LIMIT 60",
        roomId,
        who,
        since,
      );
      return json({
        room: {
          id: roomId,
          name: room.name,
          expires: room.expires,
          publicKey: JSON.parse(room.public_key),
        },
        self: who,
        peers: peers.map((p) => ({
          id: p.id,
          name: p.name,
          publicKey: JSON.parse(p.public_key),
          state: p.state,
          seen: p.seen,
        })),
        transfers,
        events: events.map((e) => ({
          id: e.id,
          from: e.sender,
          ...JSON.parse(e.payload),
        })),
      });
    }
    if (method === "DELETE" && segments.length === 3) {
      check(who === "desk", 403, "Only the desk can end a session.");
      this.sql.exec("UPDATE rooms SET expires = 0 WHERE id = ?", roomId);
      this.cleanup();
      return json({ ended: true });
    }
    if (method === "POST" && segments[3] === "peers" && segments.length === 5) {
      check(who === "desk", 403, "Only the desk can approve a connection.");
      check(
        ["approved", "declined"].includes(body.state),
        400,
        "Invalid approval.",
      );
      check(
        this.one(
          "SELECT id FROM peers WHERE room = ? AND id = ?",
          roomId,
          segments[4],
        ),
        404,
        "Student not found.",
      );
      this.sql.exec(
        "UPDATE peers SET state = ? WHERE room = ? AND id = ?",
        body.state,
        roomId,
        segments[4],
      );
      if (body.state === "declined") {
        this.sql.exec(
          "DELETE FROM chunks WHERE transfer IN (SELECT id FROM transfers WHERE room = ? AND (sender = ? OR recipient = ?) AND state != 'received')",
          roomId,
          segments[4],
          segments[4],
        );
        this.sql.exec(
          "UPDATE transfers SET state = 'rejected', error = 'The desk ended this connection.' WHERE room = ? AND (sender = ? OR recipient = ?) AND state != 'received'",
          roomId,
          segments[4],
          segments[4],
        );
      }
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
        "INSERT INTO transfers(id, room, sender, recipient, name, size, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        body.id,
        roomId,
        who,
        to,
        body.name,
        body.size,
        "offered",
        Date.now(),
      );
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
      return json({ accepted: true });
    }
    if (method === "POST" && action === "reject" && segments.length === 6) {
      check(
        t.state !== "received",
        409,
        "A received file cannot be cancelled.",
      );
      this.sql.exec(
        "UPDATE transfers SET state = 'rejected', error = ? WHERE id = ?",
        typeof body.reason === "string"
          ? body.reason.slice(0, 120)
          : "Transfer cancelled.",
        t.id,
      );
      this.sql.exec("DELETE FROM chunks WHERE transfer = ?", t.id);
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
      if (method === "PUT") {
        check(who === t.sender, 403, "Only the sender can upload this file.");
        check(
          bytes.length === chunkLength(t.size, index) + 28,
          400,
          "The chunk has the wrong size.",
        );
        if (
          index < t.next ||
          this.one(
            "SELECT idx FROM chunks WHERE transfer = ? AND idx = ?",
            t.id,
            index,
          )
        )
          return json({ next: t.next });
        check(
          index < t.next + WINDOW_SIZE,
          409,
          "Wait for the receiver before sending more.",
        );
        check(
          this.one("SELECT coalesce(sum(length(body)), 0) AS n FROM chunks").n +
            bytes.length <=
            MAX_BUFFER,
          429,
          "The relay is busy. Your file will resume shortly.",
        );
        this.sql.exec(
          "INSERT INTO chunks VALUES (?, ?, ?)",
          t.id,
          index,
          bytes.buffer,
        );
        return json({ stored: true }, 201);
      }
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
          body.next <= t.next + 1,
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
      this.sql.exec(
        "UPDATE transfers SET state = 'received', received = coalesce(received, ?) WHERE id = ?",
        Date.now(),
        t.id,
      );
      this.sql.exec("DELETE FROM chunks WHERE transfer = ?", t.id);
      return json({ received: true });
    }
    throw new HttpError(404, "Page not found.");
  }
}
