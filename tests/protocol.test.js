import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { TransferHub } from "../server/worker.js";
import { identity, shared, encrypt, decrypt } from "../public/crypto.js";
import {
  CHUNK_SIZE,
  chunkCount,
  chunkLength,
  validFile,
  validSignature,
  csvCell,
} from "../public/protocol.js";
import { Direct } from "../public/direct.js";

test("file boundaries, canonical types and spreadsheet formula protection", () => {
  assert.equal(validFile({ name: "unsafe.html", size: 100 }), false);
  assert.equal(validFile({ name: "../file.pdf", size: 100 }), false);
  assert.equal(validFile({ name: "file.pdf", size: 0 }), false);
  assert.equal(validFile({ name: "file.pdf", size: 151 * 1048576 }), false);
  assert.equal(
    validSignature(new TextEncoder().encode("<html>"), "file.pdf"),
    false,
  );
  assert.equal(
    validSignature(new TextEncoder().encode("%PDF-1.7"), "file.pdf"),
    true,
  );
  assert.equal(chunkCount(CHUNK_SIZE + 1), 2);
  assert.equal(chunkLength(CHUNK_SIZE + 1, 1), 1);
  assert.equal(csvCell(' =HYPERLINK("x")'), '"\' =HYPERLINK(""x"")"');
});
test("end-to-end encryption binds file identity, direction and chunk position", async () => {
  const a = await identity(),
    b = await identity();
  const ak = await shared(a.privateKey, b.publicKey),
    bk = await shared(b.privateKey, a.publicKey);
  const t = {
    room: crypto.randomUUID(),
    id: crypto.randomUUID(),
    from: "a",
    to: "b",
    name: "file.pdf",
    size: 8,
  };
  const bytes = new TextEncoder().encode("%PDF-1.7");
  const cipher = await encrypt(ak, t, 0, bytes);
  assert.deepEqual(new Uint8Array(await decrypt(bk, t, 0, cipher)), bytes);
  await assert.rejects(decrypt(bk, { ...t, name: "other.pdf" }, 0, cipher));
  await assert.rejects(decrypt(bk, t, 1, cipher));
  cipher[15] ^= 1;
  await assert.rejects(decrypt(bk, t, 0, cipher));
});

function service() {
  const database = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      setAlarm: async () => {},
      sql: {
        exec(query, ...args) {
          if (!args.length && query.includes(";")) {
            database.exec(query);
            return [];
          }
          const statement = database.prepare(query);
          const values = args.map((v) =>
            v instanceof ArrayBuffer ? Buffer.from(v) : v,
          );
          return statement.all(...values);
        },
      },
    },
  };
  return {
    hub: new TransferHub(ctx, {}),
    database,
  };
}
test("QR guests need an invitation and private peer token, cannot impersonate a desk", async () => {
  const { hub, database } = service();
  const key = (await identity()).publicKey;
  const room = await (
    await hub.fetch(
      new Request("https://test/api/rooms", {
        method: "POST",
        headers: { "X-Account-ID": "owner", "X-Account-Role": "staff" },
        body: JSON.stringify({ name: "Desk", publicKey: key }),
      }),
    )
  ).json();
  const env = { HUB: { idFromName: () => "hub", get: () => hub } };
  const guest = (suffix, method = "GET", body, token, invite) =>
    worker.fetch(
      new Request("https://test/api/rooms/" + room.id + suffix, {
        method,
        headers: {
          "X-Guest-Access": "1",
          "X-Account-ID": "owner",
          "X-Account-Role": "admin",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(invite ? { "X-Invite": invite } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
    );
  assert.equal(
    (await guest("/join", "POST", { name: "Visitor", publicKey: key })).status,
    403,
  );
  const response = await guest(
    "/join",
    "POST",
    { name: "Visitor", publicKey: key },
    null,
    room.invite,
  );
  assert.equal(response.status, 201);
  const peer = await response.json();
  assert.equal(
    (await guest("/state", "GET", undefined, peer.token)).status,
    200,
  );
  assert.equal(
    (await guest("/state", "GET", undefined, room.token)).status,
    403,
  );
  assert.equal(
    (await guest("/diagnostics", "GET", undefined, peer.token)).status,
    403,
  );
  assert.equal(
    (
      await guest(
        "/transfers",
        "POST",
        { id: crypto.randomUUID(), to: "desk", name: "file.pdf", size: 8 },
        peer.token,
      )
    ).status,
    403,
  );
  assert.equal((await guest("/state")).status, 401);
  const staffLog = await hub.fetch(
    new Request("https://test/api/rooms/" + room.id + "/diagnostics", {
      headers: {
        Authorization: "Bearer " + room.token,
        "X-Account-ID": "owner",
        "X-Account-Role": "staff",
      },
    }),
  );
  assert.equal(staffLog.status, 200);
  assert.ok((await staffLog.json()).some((e) => e.status === 403));
  database.close();
});

test("authenticated relay rejects impersonation, supports retry and requires recipient receipt", async () => {
  const { hub, database } = service();
  const api = async (path, method = "GET", body, token, headers = {}) => {
    if (path !== "/rooms")
      headers = {
        "X-Account-ID": "test-account",
        "X-Account-Role": "staff",
        ...headers,
      };
    if (token) headers.Authorization = "Bearer " + token;
    return hub.fetch(
      new Request("https://example.test/api" + path, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : body instanceof Uint8Array
              ? body
              : JSON.stringify(body),
      }),
    );
  };
  const key = (await identity()).publicKey;
  assert.equal(
    (await api("/rooms", "POST", { name: "Desk", publicKey: key })).status,
    403,
  );
  const invalidKey = { ...key, x: "A".repeat(43), y: "A".repeat(43) };
  assert.equal(
    (
      await api(
        "/rooms",
        "POST",
        { name: "Desk", publicKey: invalidKey },
        null,
        { "X-Account-ID": "test-account", "X-Account-Role": "staff" },
      )
    ).status,
    400,
  );
  const room = await (
    await api("/rooms", "POST", { name: "Desk", publicKey: key }, null, {
      "X-Account-ID": "test-account",
      "X-Account-Role": "staff",
    })
  ).json();
  const base = "/rooms/" + room.id;
  assert.equal(
    (
      await api(base + "/state", "GET", undefined, room.token, {
        "X-Account-ID": "another-account",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/rooms", "POST", { name: "Desk", publicKey: key }, null, {
        "X-Account-ID": "student",
        "X-Account-Role": "student",
      })
    ).status,
    403,
  );
  database.prepare("DELETE FROM account_bindings WHERE room = ?").run(room.id);
  assert.equal(
    (await api(base + "/state", "GET", undefined, room.token)).status,
    200,
  );
  assert.equal(
    (
      await api(base + "/state", "GET", undefined, room.token, {
        "X-Account-ID": "another-account",
      })
    ).status,
    403,
  );
  const join = async (name) =>
    (
      await api(base + "/join", "POST", { name, publicKey: key }, null, {
        "X-Invite": room.invite,
      })
    ).json();
  const student = await join("Student"),
    stranger = await join("Stranger");
  assert.equal(
    (await api(base + "/state", "GET", undefined, room.invite)).status,
    401,
  );
  assert.equal(
    (
      await api(
        base + "/peers/" + student.id,
        "POST",
        { state: "approved" },
        stranger.token,
      )
    ).status,
    403,
  );
  const id = crypto.randomUUID(),
    file = { id, name: "file.pdf", size: CHUNK_SIZE + 8, to: "desk" };
  assert.equal(
    (await api(base + "/transfers", "POST", file, student.token)).status,
    403,
  );
  assert.equal(
    (
      await api(
        base + "/peers/" + student.id,
        "POST",
        { state: "approved" },
        room.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await api(base + "/transfers", "POST", file, student.token)).status,
    201,
  );
  assert.equal(
    (await api(base + "/transfers", "POST", file, student.token)).status,
    200,
  );
  assert.equal(
    (
      await api(
        base + "/transfers",
        "POST",
        { ...file, name: "changed.pdf" },
        student.token,
      )
    ).status,
    409,
  );
  const t = base + "/transfers/" + id;
  assert.equal(
    (await api(t + "/accept", "POST", {}, student.token)).status,
    409,
  );
  assert.equal((await api(t + "/accept", "POST", {}, room.token)).status, 200);
  assert.equal(
    (
      await api(
        t + "/chunks/0",
        "PUT",
        new Uint8Array(CHUNK_SIZE + 28),
        stranger.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (await api(t + "/chunks/0", "PUT", new Uint8Array(30), student.token))
      .status,
    400,
  );
  assert.equal(
    (
      await api(
        t + "/chunks/0",
        "PUT",
        new Uint8Array(CHUNK_SIZE + 28),
        student.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await api(
        t + "/chunks/0",
        "PUT",
        new Uint8Array(CHUNK_SIZE + 28),
        student.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await api(t + "/chunks/0", "GET", undefined, student.token)).status,
    403,
  );
  assert.equal(
    (await api(t + "/chunks/0", "GET", undefined, room.token)).status,
    200,
  );
  assert.equal(
    (await api(t + "/ack", "POST", { next: 2 }, room.token)).status,
    400,
  );
  assert.equal(
    (
      await api(
        t + "/complete",
        "POST",
        { size: file.size, integrity: "verified" },
        room.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (await api(t + "/ack", "POST", { next: 1 }, room.token)).status,
    200,
  );
  assert.equal(
    (await api(t + "/ack", "POST", { next: 1 }, room.token)).status,
    200,
  );
  assert.equal(
    (await api(t + "/chunks/0", "GET", undefined, room.token)).status,
    204,
  );
  assert.equal(
    (await api(t + "/chunks/1", "PUT", new Uint8Array(36), student.token))
      .status,
    201,
  );
  assert.equal(
    (await api(t + "/ack", "POST", { next: 2 }, room.token)).status,
    200,
  );
  assert.equal(
    (
      await api(
        t + "/complete",
        "POST",
        { size: file.size, integrity: "verified" },
        student.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        t + "/complete",
        "POST",
        { size: file.size, integrity: "verified" },
        room.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(
        t + "/complete",
        "POST",
        { size: file.size, integrity: "verified" },
        room.token,
      )
    ).status,
    200,
  );
  const returned = {
    id: crypto.randomUUID(),
    name: "return.pdf",
    size: 8,
    to: student.id,
  };
  assert.equal(
    (await api(base + "/transfers", "POST", returned, room.token)).status,
    201,
  );
  const state = await (
    await api(base + "/state", "GET", undefined, student.token)
  ).json();
  assert.equal(state.transfers.find((t) => t.id === id).state, "received");
  assert.equal(
    state.transfers.find((t) => t.id === returned.id).recipient,
    student.id,
  );
  const otherState = await (
    await api(base + "/state", "GET", undefined, stranger.token)
  ).json();
  assert.equal(otherState.transfers.length, 0);
  assert.equal(state.peers.length, 1);
  const hub2 = new TransferHub(hub.ctx, hub.env);
  assert.equal(
    (
      await hub2.fetch(
        new Request("https://example.test/api" + base + "/state", {
          headers: {
            Authorization: "Bearer " + room.token,
            "X-Account-ID": "test-account",
            "X-Account-Role": "staff",
          },
        }),
      )
    ).status,
    200,
  );
  assert.equal((await api(base, "DELETE", {}, student.token)).status, 403);
  assert.equal((await api(base, "DELETE", {}, room.token)).status, 200);
  assert.equal(
    (await api(base + "/state", "GET", undefined, student.token)).status,
    410,
  );
  assert.equal(database.prepare("SELECT count(*) AS n FROM chunks").get().n, 0);
  database.close();
});
test("cross-origin API access is blocked and responses have a restrictive policy", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/health", {
      headers: { Origin: "https://evil.test" },
    }),
    {},
  );
  assert.equal(response.status, 403);
  assert.match(
    response.headers.get("Content-Security-Policy"),
    /frame-ancestors 'none'/,
  );
});
test("blocked RTC cannot endlessly consume free signaling quota", async () => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class {
    addEventListener() {}
    createDataChannel() {
      return { readyState: "connecting" };
    }
    async createOffer() {
      return { type: "offer", sdp: "test" };
    }
    async setLocalDescription(d) {
      this.localDescription = d;
    }
    close() {}
  };
  try {
    let offers = 0;
    const direct = new Direct({ self: "desk" }, async () => {
      offers++;
    });
    const peer = crypto.randomUUID();
    for (let i = 0; i < 10; i++) {
      if (direct.peers.has(peer)) direct.peers.get(peer).started = 0;
      await direct.start(peer);
    }
    assert.equal(offers, 3);
    direct.close();
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});
test("ICE that arrives before the offer is retained until remote description exists", async () => {
  const previous = globalThis.RTCPeerConnection;
  const applied = [];
  globalThis.RTCPeerConnection = class {
    addEventListener() {}
    async setRemoteDescription(d) {
      this.remoteDescription = d;
    }
    async createAnswer() {
      return { type: "answer", sdp: "test" };
    }
    async setLocalDescription(d) {
      this.localDescription = d;
    }
    async addIceCandidate(candidate) {
      assert.ok(this.remoteDescription);
      applied.push(candidate);
    }
    close() {}
  };
  try {
    const direct = new Direct({ self: "student" }, async () => {});
    const generation = crypto.randomUUID(),
      candidate = { candidate: "early" };
    await direct.signal("desk", { generation, type: "ice", candidate });
    assert.equal(applied.length, 0);
    await direct.signal("desk", { generation, type: "offer", sdp: "test" });
    assert.deepEqual(applied, [candidate]);
    assert.equal(direct.pendingIce.size, 0);
    direct.close();
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});
