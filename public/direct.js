// Direct connections are an optional speed boost. HTTPS remains available throughout.
import { record } from "./diagnostics.js";
export class Direct {
  constructor(session, send, changed = () => {}, configuration = null) {
    this.session = session;
    this.send = send;
    this.changed = changed;
    this.peers = new Map();
    this.inbox = new Map();
    this.pendingIce = new Map();
    this.configuration = configuration;
    this.starting = new Set();
    this.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  }
  prepare() {
    if (!this.configuration) return Promise.resolve();
    return this.preparing ||= Promise.resolve().then(this.configuration).then((config) => {
      if (config.enabled && Array.isArray(config.iceServers)) {
        this.iceServers = config.iceServers;
        this.pilot = true;
        this.expires = config.expires;
      }
    }).catch(() => {});
  }
  create(peer, generation) {
    const previous = this.peers.get(peer);
    previous?.pc.close();
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(this.pilot ? { iceTransportPolicy: "relay" } : {}),
    });
    const entry = {
      pc,
      generation,
      ice: this.pendingIce.get(peer + ":" + generation) || [],
      started: Date.now(),
      attempts: (previous?.attempts || 0) + 1,
    };
    this.peers.set(peer, entry);
    for (const event of [
      "connectionstatechange",
      "iceconnectionstatechange",
      "icegatheringstatechange",
      "signalingstatechange",
    ])
      pc.addEventListener(event, () =>
        record("webrtc-" + event, {
          state: pc.connectionState,
          ice: pc.iceConnectionState,
          signaling: pc.signalingState,
          attempts: entry.attempts,
        }),
      );
    this.pendingIce.delete(peer + ":" + generation);
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.send(peer, {
          generation,
          type: "ice",
          candidate: e.candidate.toJSON(),
        }).catch(() => {});
    };
    const attach = (channel) => {
      entry.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = channel.onclose = () => this.changed();
      channel.onmessage = (e) => {
        if (this.peers.get(peer) !== entry || (this.allowed && !this.allowed.has(peer))) return;
        if (
          !(e.data instanceof ArrayBuffer) ||
          e.data.byteLength < 44 ||
          e.data.byteLength > 65576
        )
          return;
        const bytes = new Uint8Array(e.data);
        const id = new TextDecoder().decode(bytes.subarray(0, 36));
        const view = new DataView(e.data);
        const index = view.getUint32(36);
        const part = view.getUint16(40);
        const count = view.getUint16(42);
        if (count < 1 || count > 10 || part >= count) return;
        const key = peer + ":" + id + ":" + index;
        let item = this.inbox.get(key);
        if (!item) {
          if (this.inbox.size >= 8)
            this.inbox.delete(this.inbox.keys().next().value);
          item = { parts: new Array(count), count, time: Date.now() };
          this.inbox.set(key, item);
        }
        if (item.count === count) {
          item.parts[part] = bytes.slice(44);
          if (item.parts.filter(Boolean).length === count) this.changed();
        }
      };
    };
    pc.ondatachannel = (e) => attach(e.channel);
    if (this.session.self === "desk")
      attach(pc.createDataChannel("documents", { ordered: true }));
    return entry;
  }
  async start(peer) {
    if (this.starting.has(peer)) return;
    const current = this.peers.get(peer);
    if (
      current &&
      (this.available(peer) || current.relayOnly ||
        current.attempts >= 3 ||
        Date.now() - current.started < 60000)
    )
      return;
    this.starting.add(peer);
    try {
      await this.prepare();
      if (this.allowed && !this.allowed.has(peer)) return;
      const generation = crypto.randomUUID();
      const entry = this.create(peer, generation);
      await entry.pc.setLocalDescription(await entry.pc.createOffer());
      this.send(peer, { generation, type: "offer", sdp: entry.pc.localDescription.sdp }).catch(() => {});
    } finally { this.starting.delete(peer); }
  }
  async signal(peer, data) {
    await this.prepare();
    if (this.allowed && !this.allowed.has(peer)) return;
    let entry = this.peers.get(peer);
    // Separate HTTPS requests may deliver ICE candidates before the offer.
    if (data.type === "ice" && entry?.generation !== data.generation) {
      const key = peer + ":" + data.generation;
      if (!this.pendingIce.has(key)) {
        if (this.pendingIce.size >= 20)
          this.pendingIce.delete(this.pendingIce.keys().next().value);
        this.pendingIce.set(key, []);
      }
      const candidates = this.pendingIce.get(key);
      if (candidates.length < 32) candidates.push(data.candidate);
      return;
    }
    if (data.type === "offer" && this.session.self !== "desk") {
      if (entry?.generation !== data.generation)
        entry = this.create(peer, data.generation);
      await entry.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      await entry.pc.setLocalDescription(await entry.pc.createAnswer());
      this.send(peer, {
        generation: data.generation,
        type: "answer",
        sdp: entry.pc.localDescription.sdp,
      }).catch(() => {});
    } else if (entry?.generation === data.generation) {
      if (data.type === "answer")
        await entry.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      if (data.type === "ice") entry.ice.push(data.candidate);
    }
    if (entry?.pc.remoteDescription)
      for (const candidate of entry.ice.splice(0))
        await entry.pc.addIceCandidate(candidate);
  }
  available(peer) {
    const entry = this.peers.get(peer);
    return Boolean(
      entry && !entry.relayOnly && (!this.pilot || this.expires > Date.now()) &&
      entry.pc.connectionState === "connected" &&
      ["connected", "completed"].includes(entry.pc.iceConnectionState) &&
      entry.channel?.readyState === "open",
    );
  }
  fallback(peer) {
    const entry = this.peers.get(peer);
    if (entry) entry.relayOnly = true;
  }
  upload(peer, id, index, bytes) {
    const channel = this.peers.get(peer)?.channel;
    if (
      !this.available(peer) ||
      channel.bufferedAmount > 2 * 1024 * 1024
    )
      return false;
    const size = 60000,
      count = Math.ceil(bytes.length / size);
    try {
      for (let part = 0; part < count; part++) {
        const data = bytes.subarray(part * size, (part + 1) * size),
          packet = new Uint8Array(44 + data.length);
        packet.set(new TextEncoder().encode(id));
        const view = new DataView(packet.buffer);
        view.setUint32(36, index);
        view.setUint16(40, part);
        view.setUint16(42, count);
        packet.set(data, 44);
        channel.send(packet);
      }
      return true;
    } catch {
      return false;
    }
  }
  take(peer, id, index) {
    for (const [key, item] of this.inbox)
      if (Date.now() - item.time > 15000) this.inbox.delete(key);
    const key = peer + ":" + id + ":" + index,
      item = this.inbox.get(key);
    if (
      !item ||
      item.parts.some((x) => !x) ||
      item.parts.filter(Boolean).length !== item.count
    )
      return null;
    this.inbox.delete(key);
    const result = new Uint8Array(item.parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of item.parts) {
      result.set(p, offset);
      offset += p.length;
    }
    return result;
  }
  retain(approved) {
    this.allowed = approved;
    for (const [peer, item] of this.peers) {
      if (approved.has(peer)) continue;
      item.channel?.close?.();
      item.pc.close();
      this.peers.delete(peer);
    }
    for (const key of this.inbox.keys())
      if (!approved.has(key.split(":")[0])) this.inbox.delete(key);
    for (const key of this.pendingIce.keys())
      if (!approved.has(key.split(":")[0])) this.pendingIce.delete(key);
  }
  close() {
    this.retain(new Set());
    this.peers.clear();
    this.inbox.clear();
    this.pendingIce.clear();
  }
}
