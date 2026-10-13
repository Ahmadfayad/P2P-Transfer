import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamRelay } from "../server/stream-relay.js";
import { CHUNK_SIZE } from "../public/protocol.js";
test("relay applies backpressure and cancellation without storing file contents", async () => {
  const relay = new StreamRelay(),
    t = {
      id: crypto.randomUUID(),
      room: "room",
      sender: "student",
      recipient: "desk",
      size: CHUNK_SIZE,
    };
  const response = relay.receive(t, 0, () => {});
  let finished = false;
  const uploading = relay
    .upload(t, 0, new Blob([new Uint8Array(CHUNK_SIZE + 28)]).stream())
    .then(() => (finished = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(finished, false);
  const reader = response.getReader();
  let count = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    count += value.length;
    await new Promise((r) => setTimeout(r, 1));
  }
  await uploading;
  assert.equal(count, CHUNK_SIZE + 28);
  assert.equal(relay.channels.size, 0);
  const revoked = { ...t, id: crypto.randomUUID() };
  let permitted = true;
  const stream = relay.receive(revoked, 0, () => {
    if (!permitted) throw new Error("revoked");
  });
  const reading = stream.getReader();
  const upload = relay.upload(
    revoked,
    0,
    new Blob([new Uint8Array(CHUNK_SIZE + 28)]).stream(),
  );
  const rejected = assert.rejects(upload);
  await reading.read();
  permitted = false;
  await assert.rejects(reading.read());
  await rejected;
  assert.equal(relay.channels.size, 0);
});
test("relay bounds concurrency and rejects duplicate receivers and invalid upload offsets", async () => {
  const relay = new StreamRelay();
  const entries = [];
  try {
    for (let i = 0; i < 4; i++) {
      const t = { id: crypto.randomUUID(), room: "room", size: 8 };
      entries.push(t);
      relay.receive(t, 0, () => {});
    }
    assert.throws(() => relay.receive(entries[0], 0, () => {}), /already/);
    assert.throws(() => relay.receive({ id: "fifth" }, 0, () => {}), /Four/);
    await assert.rejects(
      relay.upload(entries[0], 1, new Blob([new Uint8Array(36)]).stream()),
      /offset/,
    );
  } finally {
    relay.cancelWhere(() => true);
  }
});
test("relay detects truncated and oversized encrypted bodies", async () => {
  for (const length of [35, 37]) {
    const relay = new StreamRelay(),
      t = { id: crypto.randomUUID(), room: "r", size: 8 };
    const reader = relay.receive(t, 0, () => {}).getReader();
    const consuming = (async () => {
      while (!(await reader.read()).done) {}
    })();
    const failed = assert.rejects(consuming);
    await assert.rejects(
      relay.upload(t, 0, new Blob([new Uint8Array(length)]).stream()),
    );
    await failed;
    assert.equal(relay.channels.size, 0);
  }
});

test(
  "a stalled receiver is disconnected after the bounded stall deadline",
  { timeout: 55000 },
  async () => {
    const relay = new StreamRelay(),
      t = { id: crypto.randomUUID(), room: "room", size: 8 };
    relay.receive(t, 0, () => {});
    const started = Date.now();
    await assert.rejects(
      relay.upload(t, 0, new Blob([new Uint8Array(36)]).stream()),
      /stalled/,
    );
    assert.ok(Date.now() - started >= 44000);
    assert.equal(relay.channels.size, 0);
  },
);
