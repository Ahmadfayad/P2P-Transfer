import {
  CHUNK_SIZE,
  chunkCount,
  chunkLength,
  validFile,
  validSignature,
  fileType,
} from "./protocol.js";
import { shared, encrypt, decrypt, fingerprint } from "./crypto.js";
import { Direct } from "./direct.js";
import { request } from "./transfer.js";
import { record } from "./diagnostics.js";
const BATCH = 8,
  MEMORY_LIMIT = 16 * 1048576;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class Exchange {
  constructor(session, changed) {
    this.session = session;
    this.changed = changed;
    this.cursor = 0;
    this.keys = new Map();
    this.files = new Map();
    this.jobs = new Map();
    this.stopped = false;
    this.longPoll = true;
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
    if (path.startsWith("/peers/") && options.body?.state === "declined") {
      const peer = path.split("/")[2];
      for (const [id, controller] of this.jobs) {
        const file = this.files.get(id);
        if (file?.from === peer || file?.to === peer) controller.abort();
      }
      this.direct.peers.get(peer)?.pc.close();
    }
    return request("/rooms/" + this.session.room + path, {
      ...options,
      token: this.session.token,
      headers: {
        ...options.headers,
        ...(this.session.guest
          ? { "X-Guest-Access": "1" }
          : this.lease && path !== "/lease"
            ? { "X-Stream-Lease": this.lease }
            : {}),
      },
    });
  }
  async renew() {
    if (this.session.self === "desk" && Date.now() >= (this.renewAt || 0)) {
      const lease = await (await this.api("/lease", { method: "POST" })).json();
      this.lease = lease.token;
      this.renewAt = Date.now() + 30000;
    }
  }
  async key(peer) {
    if (!this.keys.has(peer)) {
      const key =
        peer === "desk"
          ? this.state.room.publicKey
          : this.state.peers.find((p) => p.id === peer)?.publicKey;
      if (!key) throw new Error("The recipient is unavailable.");
      this.keys.set(peer, await shared(this.session.privateKey, key));
    }
    return this.keys.get(peer);
  }
  async queue(file, to) {
    if (
      !validFile(file) ||
      !validSignature(await file.slice(0, 16).arrayBuffer(), file.name)
    )
      throw new Error("Choose a valid PDF, DOCX, PNG or JPG, up to 150 MB.");
    if (
      this.files.size >= 100 ||
      [...this.files.values()].some(
        (f) => f.to === to && f.kind === "outgoing" && !f.received && !f.error,
      )
    )
      throw new Error(
        "Finish or cancel the current file for this recipient first.",
      );
    const entry = {
      id: crypto.randomUUID(),
      room: this.session.room,
      from: this.session.self,
      to,
      name: file.name,
      size: file.size,
      blob: file,
      kind: "outgoing",
      created: Date.now(),
      transient: true,
      next: 0,
    };
    this.files.set(entry.id, entry);
    try {
      await this.api("/transfers", {
        method: "POST",
        body: {
          id: entry.id,
          name: entry.name,
          size: entry.size,
          to,
          mode: "stream-v1",
        },
      });
    } catch (error) {
      this.files.delete(entry.id);
      throw error;
    }
    this.changed(this.state);
    return entry.id;
  }
  async tick() {
    await this.renew();
    const path =
      "/state?since=" +
      this.cursor +
      "&wait=1&version=" +
      (this.version ?? "initial");
    let response;
    try {
      response = await this.api(path, { signal: AbortSignal.timeout(25000) });
    } catch (error) {
      if (error.status !== 401 || !this.lease) throw error;
      this.renewAt = 0;
      await this.renew();
      response = await this.api(path, { signal: AbortSignal.timeout(25000) });
    }
    const state = await response.json();
    this.version = state.room.version;
    if (
      (await fingerprint(state.room.publicKey)) !==
      (await fingerprint(this.session.deskKey || this.session.publicKey))
    )
      throw new Error(
        "The desk identity changed. Request a new QR invitation.",
      );
    this.state = state;
    this.direct.retain(
      new Set(
        state.peers
          .filter((p) => p.state === "approved")
          .map((p) => (this.session.self === "desk" ? p.id : "desk")),
      ),
    );
    for (const event of state.events) {
      await this.direct.signal(event.from, event.data).catch(() => {});
      this.cursor = event.id;
    }
    if (this.session.self === "desk")
      for (const peer of state.peers.filter((p) => p.state === "approved"))
        await this.direct.start(peer.id).catch(() => {});
    for (const row of state.transfers.filter((t) => t.mode === "stream-v1")) {
      if (this.discarded?.has(row.id)) continue;
      let file = this.files.get(row.id);
      if (!file) {
        file = {
          id: row.id,
          room: row.room,
          from: row.sender,
          to: row.recipient,
          name: row.name,
          size: row.size,
          kind: row.recipient === this.session.self ? "incoming" : "outgoing",
          created: row.created,
          transient: true,
        };
        this.files.set(row.id, file);
        if (
          row.state === "accepted" ||
          (row.state === "offered" && file.kind === "outgoing")
        ) {
          file.error =
            "This page refreshed during a temporary transfer. Ask the student to resend the document.";
          await this.api("/transfers/" + row.id + "/reject", {
            method: "POST",
            body: {},
          }).catch(() => {});
        }
      }
      if (row.received) file.received = row.received;
      if (row.save_state) file.saveState = row.save_state;
      if (row.state === "rejected") {
        file.error ||= "Transfer cancelled. Please resend.";
        this.jobs.get(row.id)?.abort();
      }
      if (
        file.kind === "outgoing" &&
        row.state === "accepted" &&
        !file.error &&
        !file.sent &&
        !this.jobs.has(row.id)
      )
        this.startJob(row, (controller) => this.send(row, file, controller));
    }
    this.changed(state);
    return state.transfers.some(
      (t) => !["received", "rejected"].includes(t.state),
    );
  }
  startJob(row, action) {
    const controller = new AbortController();
    this.jobs.set(row.id, controller);
    action(controller)
      .catch(async (error) => {
        const file = this.files.get(row.id);
        if (file) {
          file.error = file.completed
            ? "File verified locally, but its receipt could not be confirmed. Check the saved file before resending."
            : "Transfer interrupted or rejected. Please resend the document.";
          if (!file.completed && file.kind === "incoming")
            file.blob = undefined;
          file.memoryReserved = false;
        }
        record("stream-failed", { message: error.name, status: error.status });
        await this.api("/transfers/" + row.id + "/reject", {
          method: "POST",
          body: {},
        }).catch(() => {});
      })
      .finally(() => {
        this.jobs.delete(row.id);
        this.changed(this.state);
      });
  }
  check(controller) {
    if (this.stopped || controller.signal.aborted)
      throw new Error("Transfer cancelled.");
  }
  async send(row, file, controller) {
    const started = performance.now(),
      t = { ...row, from: row.sender, to: row.recipient };
    const key = await this.key(t.to),
      total = chunkCount(t.size);
    let index = 0;
    if (this.direct.available(t.to)) {
      this.direct.streamAcks.set(t.id, 0);
      let sent = 0,
        progress = Date.now(),
        ack = 0;
      while (ack < total && this.direct.available(t.to)) {
        this.check(controller);
        const next = this.direct.streamAcks.get(t.id) || 0;
        if (next > ack) {
          ack = next;
          progress = Date.now();
          file.next = ack;
          this.changed(this.state);
        }
        if (sent < total && sent < ack + 4) {
          const bytes = await encrypt(
            key,
            t,
            sent,
            await file.blob
              .slice(
                sent * CHUNK_SIZE,
                Math.min(t.size, (sent + 1) * CHUNK_SIZE),
              )
              .arrayBuffer(),
          );
          if (this.direct.upload(t.to, t.id, sent, bytes)) {
            sent++;
            this.direct.streamSent.set(t.id, sent);
          } else await sleep(20);
        } else await sleep(20);
        if (Date.now() - progress > 5000) break;
      }
      if ((this.direct.streamAcks.get(t.id) || 0) === total) {
        file.sent = true;
        record("stream-sent", {
          state: "direct",
          size: t.size,
          duration: Math.round(performance.now() - started),
        });
        return;
      }
      this.direct.peers.get(t.to)?.pc.close();
      record("stream-fallback", { state: "https" });
    }
    let ready;
    const waiting = Date.now();
    while (!ready?.ready) {
      this.check(controller);
      ready = await (
        await this.api("/transfers/" + t.id + "/stream-status", {
          signal: controller.signal,
        })
      ).json();
      if (Date.now() - waiting > 45000)
        throw new Error("Receiver did not connect.");
      if (!ready.ready) await sleep(200);
    }
    index = ready.next;
    while (index < total) {
      this.check(controller);
      const end = Math.min(index + BATCH, total),
        frames = [];
      for (let i = index; i < end; i++)
        frames.push(
          await encrypt(
            key,
            t,
            i,
            await file.blob
              .slice(i * CHUNK_SIZE, Math.min(t.size, (i + 1) * CHUNK_SIZE))
              .arrayBuffer(),
          ),
        );
      await this.api("/transfers/" + t.id + "/stream", {
        method: "POST",
        body: new Blob(frames, { type: "application/octet-stream" }),
        headers: { "X-Stream-Index": String(index) },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(120000),
        ]),
      });
      index = end;
      file.next = index;
      this.changed(this.state);
    }
    file.sent = true;
    record("stream-sent", {
      state: "https",
      size: t.size,
      duration: Math.round(performance.now() - started),
    });
  }
  async receiveFile(id) {
    const row = this.state.transfers.find((t) => t.id === id),
      file = this.files.get(id);
    if (!row || row.state !== "offered" || this.jobs.has(id) || file.accepting)
      return;
    if (
      this.jobs.size +
        [...this.files.values()].filter((f) => f.accepting).length >=
      4
    )
      throw new Error(
        "Finish one of the four active transfers before receiving another file.",
      );
    file.accepting = true;
    this.changed(this.state);
    let writer;
    try {
      if (typeof showSaveFilePicker === "function") {
        const handle = await showSaveFilePicker({ suggestedName: file.name });
        writer = await handle.createWritable();
      } else {
        const occupied = [...this.files.values()]
          .filter((f) => f.kind === "incoming" && (f.blob || f.memoryReserved))
          .reduce((n, f) => n + f.size, 0);
        if (occupied + file.size > MEMORY_LIMIT)
          throw new Error(
            "This browser supports temporary downloads up to 16 MB. Use desktop Chrome or Edge to stream larger files directly to disk.",
          );
        file.memoryReserved = true;
      }
      await this.api("/transfers/" + id + "/accept", { method: "POST" });
      this.startJob(row, (controller) =>
        this.receive(row, file, writer, controller),
      );
    } catch (error) {
      file.memoryReserved = false;
      await writer?.abort().catch(() => {});
      if (error.name !== "AbortError") throw error;
    } finally {
      file.accepting = false;
      this.changed(this.state);
    }
  }
  async receive(row, file, writer, controller) {
    const t = { ...row, from: row.sender, to: row.recipient },
      key = await this.key(t.from),
      total = chunkCount(t.size),
      parts = [];
    const started = performance.now();
    let index = 0,
      reader,
      directWaiting = Date.now();
    const consume = async (cipher) => {
      this.check(controller);
      const bytes = new Uint8Array(await decrypt(key, t, index, cipher));
      if (
        bytes.length !== chunkLength(t.size, index) ||
        (index === 0 && !validSignature(bytes, t.name))
      )
        throw new Error("File integrity verification failed.");
      if (writer) await writer.write(bytes);
      else parts.push(bytes);
      index++;
      file.next = index;
      this.changed(this.state);
    };
    try {
      while (index < total) {
        this.check(controller);
        const cipher = this.direct.take(t.from, t.id, index);
        if (cipher) {
          await consume(cipher);
          this.direct.ack(t.from, t.id, index);
          directWaiting = Date.now();
          if (index % BATCH === 0)
            await this.api("/transfers/" + t.id + "/progress", {
              method: "POST",
              body: { next: index },
            });
        } else if (
          this.direct.available(t.from)
            ? Date.now() - directWaiting < 7000
            : Date.now() - directWaiting < 2000
        )
          await sleep(20);
        else break;
      }
      if (index < total) {
        const response = await this.api("/transfers/" + t.id + "/stream", {
          headers: { "X-Stream-Index": String(index) },
          signal: controller.signal,
        });
        reader = response.body.getReader();
        let block = new Uint8Array(),
          offset = 0;
        const read = async () => {
          let timer;
          return Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Receive stream stalled.")),
                45000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
        };
        while (index < total) {
          const length = chunkLength(t.size, index) + 28,
            cipher = new Uint8Array(length);
          let filled = 0;
          while (filled < length) {
            this.check(controller);
            if (offset === block.length) {
              const part = await read();
              if (part.done) throw new Error("Truncated stream.");
              block = part.value;
              offset = 0;
            }
            const count = Math.min(length - filled, block.length - offset);
            cipher.set(block.subarray(offset, offset + count), filled);
            offset += count;
            filled += count;
          }
          await consume(cipher);
        }
        if (offset !== block.length || !(await read()).done)
          throw new Error("Unexpected trailing stream data.");
      }
      this.check(controller);
      if (writer) {
        await writer.close();
        file.saveState = "disk-saved";
      } else {
        file.blob = new Blob(parts, { type: fileType(file.name) });
        file.saveState = "received";
      }
      file.completed = Date.now();
      await this.api("/transfers/" + t.id + "/progress", {
        method: "POST",
        body: { next: total },
      });
      await this.api("/transfers/" + t.id + "/complete", {
        method: "POST",
        body: {
          size: t.size,
          integrity: "verified",
          saveState: file.saveState,
        },
      });
      file.received = Date.now();
      record("stream-received", {
        size: t.size,
        state: file.saveState,
        duration: Math.round(performance.now() - started),
      });
    } catch (error) {
      await writer?.abort().catch(() => {});
      throw error;
    } finally {
      await reader?.cancel().catch(() => {});
    }
  }
  async saved(file, state) {
    file.saveState = state;
    await this.api("/transfers/" + file.id + "/saved", {
      method: "POST",
      body: { state },
    });
  }
  stop() {
    this.stopped = true;
    for (const job of this.jobs.values()) job.abort();
    this.direct.close();
  }
}
