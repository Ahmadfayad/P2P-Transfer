import { test } from "node:test";
import assert from "node:assert/strict";
import { safeMessage, record } from "../public/diagnostics.js";
import { diagnosticRoute, diagnosticRecord } from "../public/protocol.js";
test("diagnostics redact credentials, invitation URLs and email addresses", () => {
  const result = safeMessage(
    "failed https://site/student#invite=secret person@example.com " +
      "a".repeat(64),
  );
  assert.equal(result.includes("secret"), false);
  assert.equal(result.includes("person@example.com"), false);
  assert.equal(result.includes("a".repeat(64)), false);
  let saved;
  globalThis.sessionStorage = { setItem: (_, value) => (saved = value) };
  record("test", {
    status: 503,
    password: "sensitive",
    token: "sensitive",
    filename: "private.pdf",
    headers: { Authorization: "sensitive" },
  });
  record("test", {
    message: "Sensitive student-name 123456 private.pdf student@example.com",
    name: "Student",
    email: "student@example.com",
    studentId: "123456",
    encryptionKey: "sensitive",
  });
  assert.equal(saved.includes("sensitive"), false);
  assert.equal(saved.includes("private.pdf"), false);
  delete globalThis.sessionStorage;
});
test("free-form messages, paths and structured values cannot leak into logs", () => {
  let saved;
  globalThis.sessionStorage = { setItem: (_, value) => (saved = value) };
  try {
    const secret = "transcript.pdf password=short6";
    assert.equal(safeMessage(secret), "Error");
    assert.equal(safeMessage("TimeoutError"), "TimeoutError");
    record(secret, {
      message: secret,
      state: secret,
      status: { password: "short6" },
      route: "/api/auth/password=short6",
      requestId: secret,
      ray: secret,
    });
    assert.equal(saved.includes("short6"), false);
    assert.equal(saved.includes("transcript.pdf"), false);
    assert.equal(JSON.parse(saved).at(-1).route, "[unknown-route]");
    assert.equal(
      JSON.stringify(
        diagnosticRecord({
          room: secret,
          route: secret,
          method: secret,
          request_id: secret,
          message: secret,
          password: "short6",
          status: { filename: secret },
        }),
      ).includes("short6"),
      false,
    );
    const room = crypto.randomUUID(),
      transfer = crypto.randomUUID();
    const path = `/api/rooms/${room}/transfers/${transfer}/chunks/42?token=short6`;
    assert.equal(
      diagnosticRoute(path),
      "/api/rooms/:room/transfers/:transfer/chunks/:index",
    );
    assert.equal(diagnosticRoute(diagnosticRoute(path)), diagnosticRoute(path));
    assert.equal(
      diagnosticRoute(`/api/rooms/${room}/transcript.pdf`),
      "[unknown-route]",
    );
  } finally {
    delete globalThis.sessionStorage;
  }
});
