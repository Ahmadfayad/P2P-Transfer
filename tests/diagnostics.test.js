import { test } from "node:test";
import assert from "node:assert/strict";
import { safeMessage, record } from "../public/diagnostics.js";
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
  assert.equal(saved.includes("sensitive"), false);
  assert.equal(saved.includes("private.pdf"), false);
  delete globalThis.sessionStorage;
});
