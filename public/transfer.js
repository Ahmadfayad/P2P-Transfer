import {
  CHUNK_SIZE,
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

export async function request(
  path,
  { method = "GET", body, token, headers = {} } = {},
) {
  if (token) headers.Authorization = "Bearer " + token;
  if (body && !(body instanceof Uint8Array)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch("/api" + path, {
    method,
    body,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
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
export class Exchange {
  constructor(session, changed) {
    this.session = session;
    this.changed = changed;
    this.cursor = 0;
    this.keys = new Map();
    this.sent = new Map();
    this.stopped = false;
    this.direct = new Direct(
      session,
      (to, data) =>
        this.api("/events", {
          method: "POST",
          body: { to, kind: "signal", data },
        }),
      () => this.changed(this.state),
    );
  }
  api(path, options = {}) {
    return request("/rooms/" + this.session.room + path, {
      ...options,
      token: this.session.token,
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
  async tick() {
    const state = await (await this.api("/state?since=" + this.cursor)).json();
    this.state = state;
    if (
      (await fingerprint(state.room.publicKey)) !==
      (await fingerprint(this.session.deskKey || this.session.publicKey))
    )
      throw new Error(
        "The desk identity changed. Stop and ask for a new invitation.",
      );
    for (const event of state.events) {
      if (event.kind === "signal")
        await this.direct.signal(event.from, event.data).catch(() => {});
      this.cursor = event.id;
    }
    const own = state.peers.find((p) => p.id === this.session.self);
    if (this.session.self === "desk")
      for (const peer of state.peers.filter((p) => p.state === "approved"))
        await this.direct.start(peer.id).catch(() => {});
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
        await this.api("/transfers", {
          method: "POST",
          body: { id: file.id, name: file.name, size: file.size, to: file.to },
        });
        active = true;
      }
    }
    for (const row of state.transfers) {
      if (this.stopped) break;
      const t = { ...row, from: row.sender, to: row.recipient };
      if (t.state === "rejected" || t.state === "received") continue;
      active = true;
      if (t.to === this.session.self) await this.receive(t, files, state);
      else if (t.state === "accepted") await this.send(t, files, state);
    }
    this.changed(state);
    return active;
  }
  async send(t, files, state) {
    const file = files.find((f) => f.id === t.id && f.kind === "outgoing");
    if (!file?.blob)
      throw new Error(
        "The original file is missing from this device. Cancel and resend it.",
      );
    if (t.next >= chunkCount(t.size)) return;
    const previous = this.sent.get(t.id);
    if (previous?.index === t.next && Date.now() - previous.time < 1500) return;
    const bytes =
      previous?.index === t.next
        ? previous.bytes
        : await encrypt(
            await this.key(t.to, state),
            t,
            t.next,
            await file.blob
              .slice(t.next * CHUNK_SIZE, (t.next + 1) * CHUNK_SIZE)
              .arrayBuffer(),
          );
    const direct =
      previous?.index !== t.next &&
      this.direct.upload(t.to, t.id, t.next, bytes);
    if (!direct)
      await this.api("/transfers/" + t.id + "/chunks/" + t.next, {
        method: "PUT",
        body: bytes,
      });
    this.sent.set(t.id, { index: t.next, bytes, time: Date.now() });
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
    if (file.next > t.next) {
      await this.api("/transfers/" + t.id + "/ack", {
        method: "POST",
        body: { next: t.next + 1 },
      });
      return;
    }
    if (file.next < total) {
      let bytes = this.direct.take(t.from, t.id, t.next);
      if (!bytes) {
        const response = await this.api(
          "/transfers/" + t.id + "/chunks/" + t.next,
        );
        if (response.status === 204) return;
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
      await this.api("/transfers/" + t.id + "/ack", {
        method: "POST",
        body: { next: file.next },
      });
      return;
    }
    if (!file.blob) {
      const chunks = (await db.all("chunks"))
        .filter((c) => c.transfer === t.id)
        .sort((a, b) => a.index - b.index);
      if (chunks.length !== total || chunks.some((c, i) => c.index !== i))
        throw new Error("Saved chunks are missing. Ask the sender to resend.");
      const blob = new Blob(
        chunks.map((c) => c.data),
        { type: fileType(file.name) },
      );
      if (blob.size !== t.size) throw new Error("File verification failed.");
      file.blob = blob;
      file.completed = Date.now();
      await db.transaction(["files", "chunks"], (s) => {
        s.files.put(file);
        for (const c of chunks) s.chunks.delete(c.id);
      });
    }
    await this.api("/transfers/" + t.id + "/complete", {
      method: "POST",
      body: { size: file.size, integrity: "verified" },
    });
  }
  stop() {
    this.stopped = true;
    this.direct.close();
  }
}
