import { chunkCount, chunkLength } from "../public/protocol.js";
export const BATCH_FRAMES = 8;
const timeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Stream stalled; ask the sender to resend.")),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};
export class StreamRelay {
  constructor() {
    this.channels = new Map();
  }
  receive(t, index, assert) {
    if (this.channels.has(t.id))
      throw Object.assign(new Error("A receiver is already connected."), {
        status: 409,
      });
    if (this.channels.size >= 4)
      throw Object.assign(
        new Error("Four streams are already active. Try again shortly."),
        { status: 429 },
      );
    const stream = new TransformStream();
    const entry = {
      id: t.id,
      room: t.room,
      sender: t.sender,
      recipient: t.recipient,
      next: index,
      writer: stream.writable.getWriter(),
      assert,
      busy: false,
    };
    this.channels.set(t.id, entry);
    entry.timer = setInterval(() => {
      try {
        assert();
      } catch {
        this.cancel(t.id);
      }
    }, 5000);
    entry.writer.closed.catch(() => this.cancel(t.id));
    return stream.readable;
  }
  async upload(t, index, body) {
    const entry = this.channels.get(t.id);
    if (!entry || entry.busy || index !== entry.next)
      throw Object.assign(
        new Error("The receiver is not ready at this offset."),
        { status: 409 },
      );
    entry.busy = true;
    const end = Math.min(chunkCount(t.size), index + BATCH_FRAMES);
    let expected = 0;
    for (let i = index; i < end; i++) expected += chunkLength(t.size, i) + 28;
    const reader = body.getReader();
    let count = 0;
    try {
      entry.assert();
      while (true) {
        const { value, done } = await timeout(reader.read(), 45000);
        if (done) break;
        count += value.byteLength;
        if (count > expected)
          throw new Error("Invalid encrypted stream length.");
        for (let offset = 0; offset < value.length; offset += 65536) {
          entry.assert();
          await timeout(
            entry.writer.write(value.subarray(offset, offset + 65536)),
            45000,
          );
        }
      }
      if (count !== expected)
        throw new Error(
          "The upload was interrupted; ask the sender to resend.",
        );
      entry.next = end;
      if (end === chunkCount(t.size)) {
        await timeout(entry.writer.close(), 45000);
        this.release(t.id);
      }
      return end;
    } catch (error) {
      this.cancel(t.id);
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      entry.busy = false;
      reader.releaseLock();
    }
  }
  release(id) {
    const entry = this.channels.get(id);
    if (entry) clearInterval(entry.timer);
    this.channels.delete(id);
  }
  cancel(id) {
    const entry = this.channels.get(id);
    this.release(id);
    entry?.writer
      .abort(
        new Error(
          "Transfer interrupted or access revoked. Resend the document.",
        ),
      )
      .catch(() => {});
  }
  cancelWhere(test) {
    for (const entry of this.channels.values())
      if (test(entry)) this.cancel(entry.id);
  }
}
