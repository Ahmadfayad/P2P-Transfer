import {
  CHUNK_SIZE,
  WINDOW_SIZE,
  LOCAL_LIMIT,
  chunkCount,
  chunkLength,
  validFile,
  validSignature,
  fileType,
} from "./protocol.js";
import * as db from "./storage.js";
import { shared, encrypt, decrypt, fingerprint } from "./crypto.js";
import { Direct } from "./direct.js";
import { trackedFetch, record } from "./diagnostics.js";
import { Wake } from "./wake.js";

export async function request(
  path,
  { method = "GET", body, token, headers = {}, signal } = {},
) {
  if (token) headers.Authorization = "Bearer " + token;
  if (body && !(body instanceof Uint8Array)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await trackedFetch("/api" + path, {
    method,
    body,
    headers,
    cache: "no-store",
    signal: signal || AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(
      detail.error || "The service is temporarily unavailable.",
    );
    error.status = response.status;
    throw error;
  }
  return response;
}
export async function finishFile(file) {
  if (file.blob) return;
  const saved = await db.get("files", file.id);
  if (saved?.blob) {
    Object.assign(file, saved);
    return;
  }
  const chunks = (await db.all("chunks"))
    .filter((c) => c.transfer === file.id)
    .sort((a, b) => a.index - b.index);
  if (
    chunks.length !== chunkCount(file.size) ||
    chunks.some((c, i) => c.index !== i)
  ) {
    const finished = await db.get("files", file.id);
    if (finished?.blob) {
      Object.assign(file, finished);
      return;
    }
    throw new Error("Saved chunks are missing. Ask the sender to resend.");
  }
  const blob = new Blob(
    chunks.map((c) => c.data),
    { type: fileType(file.name) },
  );
  if (blob.size !== file.size) throw new Error("File verification failed.");
  file.blob = blob;
  file.completed = Date.now();
  await db.transaction(["files", "chunks"], (s) => {
    s.files.put(file);
    for (const c of chunks) s.chunks.delete(c.id);
  });
}
export class Exchange {
  constructor(session, changed, wake = () => {}) {
    this.session = session;
    this.changed = changed;
    this.cursor = 0;
    this.keys = new Map();
    this.sent = new Map();
    this.retries = new Map();
    this.stopped = false;
    this.wake = wake;
    this.signals = new Map();
    this.direct = new Direct(
      session,
      (to, data) =>
        this.api("/events", {
          method: "POST",
          body: { to, kind: "signal", data },
        }),
      () => { this.changed(this.state); this.wake(); },
      async () => (await this.api("/ice", { signal: AbortSignal.timeout(8000) })).json(),
    );
  }
  watch() { this.notifications ||= new Wake(this.session, () => { if (!this.stopped) this.wake(); }); }
  api(path, options = {}) {
    return request("/rooms/" + this.session.room + path, {
      ...options,
      token: this.session.token,
      headers: {
        ...options.headers,
        ...(this.session.guest ? { "X-Guest-Access": "1" } : {}),
      },
    });
  }
  async key(peer, state) {
    if (!this.keys.has(peer)) {
      const publicKey =
        peer === "desk"
          ? state.room.publicKey
          : state.peers.find((p) => p.id === peer)?.publicKey;
      if (!publicKey) throw new Error("The recipient is no longer available.");
      this.keys.set(peer, await shared(this.session.privateKey, publicKey));
    }
    return this.keys.get(peer);
  }
  async queue(file, to) {
    if (
      !validFile(file) ||
      !validSignature(await file.slice(0, 16).arrayBuffer(), file.name)
    )
      throw new Error(
        "Choose a valid PDF, DOCX, PNG or JPG file, up to 150 MB.",
      );
    const files = await db.all("files");
    if (files.reduce((sum, f) => sum + f.size, 0) + file.size > LOCAL_LIMIT)
      throw new Error(
        "Device storage is full. Save and remove older files first.",
      );
    const id = crypto.randomUUID();
    await db.put("files", {
      id,
      room: this.session.room,
      from: this.session.self,
      to,
      name: file.name,
      size: file.size,
      blob: file,
      kind: "outgoing",
      created: Date.now(),
    });
    this.changed();
    return id;
  }
  async attempt(id, action) {
    const retry = this.retries.get(id);
    if (retry?.after > Date.now()) return false;
    try {
      await action();
      this.retries.delete(id);
      return true;
    } catch (error) {
      if ([401, 410].includes(error.status)) throw error;
      const attempts = (retry?.attempts || 0) + 1;
      const delay = Math.min(30000, 3000 * 2 ** Math.min(attempts - 1, 4));
      this.retries.set(id, {
        attempts,
        after: Date.now() + delay,
        message: error.message,
      });
      this.transferError ||= error;
      record("transfer-retry", {
        status: error.status,
        attempts,
        duration: delay,
        message: error.name,
      });
      return false;
    }
  }
  async tick() {
    this.transferError = null;
    const state = await (await this.api("/state?since=" + this.cursor)).json();
    this.state = state;
    if (
      (await fingerprint(state.room.publicKey)) !==
      (await fingerprint(this.session.deskKey || this.session.publicKey))
    )
      throw new Error(
        "The desk identity changed. Stop and ask for a new invitation.",
      );
    const own = state.peers.find((p) => p.id === this.session.self);
    const approved = new Set(
      this.session.self === "desk"
        ? state.peers.filter((p) => p.state === "approved").map((p) => p.id)
        : own?.state === "approved"
          ? ["desk"]
          : [],
    );
    this.direct.retain(approved);
    for (const event of state.events) {
      if (event.kind === "signal" && approved.has(event.from)) {
        const pending = (this.signals.get(event.from) || Promise.resolve()).then(() => {
          if (!this.stopped && this.direct.allowed?.has(event.from))
            return this.direct.signal(event.from, event.data);
        }).catch(() => {});
        this.signals.set(event.from, pending);
      }
      this.cursor = event.id;
    }
    if (this.session.self === "desk")
      for (const peer of state.peers.filter((p) => p.state === "approved"))
        this.direct.start(peer.id).catch(() => {});
    if (this.session.self !== "desk" && own?.state !== "approved") {
      this.changed(state);
      return false;
    }
    const files = await db.all("files");
    for (const t of state.transfers.filter((t) => t.state === "received")) {
      const file = files.find((f) => f.id === t.id);
      if (file && !file.received) {
        file.received = t.received;
        file.fromName =
          t.sender === "desk"
            ? "Desk"
            : state.peers.find((p) => p.id === t.sender)?.name || t.sender;
        file.toName =
          t.recipient === "desk"
            ? "Desk"
            : state.peers.find((p) => p.id === t.recipient)?.name ||
              t.recipient;
        await db.put("files", file);
        this.sent.delete(t.id);
      }
    }
    let active = false;
    for (const file of files.filter(
      (f) => f.room === this.session.room && f.kind === "outgoing",
    )) {
      if (!state.transfers.some((t) => t.id === file.id)) {
        if (
          this.session.self === "desk" &&
          !state.peers.some((p) => p.id === file.to && p.state === "approved")
        )
          continue;
        const offered = await this.attempt(file.id, () =>
          this.api("/transfers", {
            method: "POST",
            body: {
              id: file.id,
              name: file.name,
              size: file.size,
              to: file.to,
            },
          }),
        );
        active ||= offered;
      }
    }
    for (const row of state.transfers) {
      if (this.stopped) break;
      const t = { ...row, from: row.sender, to: row.recipient };
      if (t.state === "rejected" || t.state === "received") {
        this.retries.delete(t.id);
        continue;
      }
      const advanced = await this.attempt(t.id, async () => {
        if (t.to === this.session.self) {
          await this.receive(t, files, state);
          row.next = t.next;
        }
        else if (t.state === "accepted") await this.send(t, files, state);
      });
      active ||= advanced;
    }
    this.changed(state);
    if (this.transferError && !active) throw this.transferError;
    return active;
  }
  async send(t, files, state) {
    const file = files.find((f) => f.id === t.id && f.kind === "outgoing");
    if (!file?.blob)
      throw new Error(
        "The original file is missing from this device. Cancel and resend it.",
      );
    if (t.next >= chunkCount(t.size)) return;
    let window = this.sent.get(t.id);
    if (!window) this.sent.set(t.id, (window = new Map()));
    for (const index of window.keys())
      if (index < t.next) window.delete(index);
    const uploads = [];
    for (let index = t.next; index < Math.min(chunkCount(t.size), t.next + WINDOW_SIZE); index++) {
      uploads.push((async () => {
        let chunk = window.get(index);
        if (chunk?.stored || (chunk?.direct && Date.now() - chunk.time < 1500)) return;
        if (!chunk) {
          const bytes = await encrypt(
            await this.key(t.to, state), t, index,
            await file.blob.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).arrayBuffer(),
          );
          chunk = { bytes, time: Date.now() };
          window.set(index, chunk);
          chunk.direct = (!this.direct.pilot || t.turnAllowed) && this.direct.upload(t.to, t.id, index, bytes);
        } else if (chunk.direct) {
          // A channel can remain open after ICE fails. Stop paying this delay for every chunk.
          this.direct.fallback(t.to);
          chunk.direct = false;
        }
        record("send-chunk", { index, size: chunk.bytes.byteLength, state: chunk.direct ? "direct" : "https" });
        if (!chunk.direct) {
          await this.api("/transfers/" + t.id + "/chunks/" + index, { method: "PUT", body: chunk.bytes });
          chunk.stored = true;
        }
      })());
    }
    // Settle the whole bounded window before retrying, so uploads never overlap ticks.
    const results = await Promise.allSettled(uploads);
    const failure = results.find((r) => r.status === "rejected");
    if (failure) throw failure.reason;
  }
  async receive(t, files, state) {
    let file = files.find((f) => f.id === t.id);
    if (!file) {
      if (files.reduce((sum, f) => sum + f.size, 0) + t.size > LOCAL_LIMIT) {
        await this.api("/transfers/" + t.id + "/reject", {
          method: "POST",
          body: {
            reason:
              "Recipient device storage is full. Save older files and resend.",
          },
        });
        return;
      }
      file = {
        id: t.id,
        room: t.room,
        from: t.from,
        to: t.to,
        name: t.name,
        size: t.size,
        next: 0,
        kind: "incoming",
        created: t.created,
      };
      await db.put("files", file);
      files.push(file);
    }
    if (t.state === "offered") {
      await this.api("/transfers/" + t.id + "/accept", { method: "POST" });
      return;
    }
    const total = chunkCount(t.size);
    if (t.next > file.next && !file.blob)
      throw new Error(
        "Saved chunks are missing. Keep this page open and ask the sender to resend.",
      );
    const batch = state.batchAcks === true;
    while (file.next > t.next) {
      const next = Math.min(file.next, t.next + (batch ? WINDOW_SIZE : 1));
      await this.api("/transfers/" + t.id + "/ack", {
        method: "POST",
        body: { next, ...(batch ? { batch: true } : {}) },
      });
      t.next = next;
    }
    const acknowledged = t.next;
    // Drain only the existing relay window, saving each chunk before its ordered ACK.
    for (let drained = 0; file.next < total && drained < WINDOW_SIZE; drained++) {
      let bytes = this.direct.take(t.from, t.id, t.next);
      if (!bytes) {
        const response = await this.api(
          "/transfers/" + t.id + "/chunks/" + t.next,
        );
        if (response.status === 204) break;
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      let plain;
      try {
        plain = await decrypt(await this.key(t.from, state), t, t.next, bytes);
        if (
          plain.byteLength !== chunkLength(t.size, t.next) ||
          (t.next === 0 && !validSignature(plain, t.name))
        )
          throw new Error("Invalid file.");
      } catch {
        await this.api("/transfers/" + t.id + "/reject", {
          method: "POST",
          body: {
            reason:
              "File verification failed. Please resend the original document.",
          },
        });
        return;
      }
      file.next++;
      await db.transaction(["chunks", "files"], (s) => {
        s.chunks.put({
          id: t.id + ":" + t.next,
          transfer: t.id,
          index: t.next,
          data: plain,
        });
        s.files.put(file);
      });
      t.next = file.next;
      if (!batch) await this.api("/transfers/" + t.id + "/ack", {
        method: "POST", body: { next: file.next },
      });
    }
    if (batch && t.next > acknowledged) {
      await this.api("/transfers/" + t.id + "/ack", {
        method: "POST",
        body: { next: file.next, batch: true },
      });
    }
    if (file.next < total) return;
    await finishFile(file);
    await this.api("/transfers/" + t.id + "/complete", {
      method: "POST",
      body: { size: file.size, integrity: "verified" },
    });
  }
  stop() {
    this.stopped = true;
    this.direct.close();
    this.notifications?.close();
  }
}
