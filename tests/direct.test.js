import test from "node:test";
import assert from "node:assert/strict";
import { Direct } from "../public/direct.js";

test("an open channel on failed ICE never delays HTTPS fallback", () => {
  const direct = new Direct({ self: "desk" }, async () => {});
  let packets = 0;
  const entry = {
    pc: { connectionState: "failed", iceConnectionState: "disconnected" },
    channel: { readyState: "open", bufferedAmount: 0, send: () => packets++ },
  };
  direct.peers.set("peer", entry);
  assert.equal(direct.upload("peer", crypto.randomUUID(), 0, new Uint8Array(36)), false);
  assert.equal(packets, 0);
  entry.pc.connectionState = "connected";
  entry.pc.iceConnectionState = "connected";
  assert.equal(direct.available("peer"), true);
  direct.fallback("peer");
  assert.equal(direct.available("peer"), false);
});

test("optional offer upload does not hold up the HTTPS transfer tick", async () => {
  const direct = new Direct({ self: "desk" }, () => new Promise(() => {}));
  direct.create = (peer, generation) => {
    const entry = {
      generation,
      pc: {
        createOffer: async () => ({ type: "offer", sdp: "fixture" }),
        setLocalDescription: async () => {},
        localDescription: { sdp: "fixture" },
      },
    };
    direct.peers.set(peer, entry);
    return entry;
  };
  let timeout;
  try {
    await Promise.race([
      direct.start("peer"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Signaling blocked HTTPS")), 1000);
      }),
    ]);
  } finally { clearTimeout(timeout); }
});
