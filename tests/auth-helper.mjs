import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createAuth } from "../server/auth.js";
const vars = Object.fromEntries(
  readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const auth = createAuth(vars),
  context = await auth.$context;
export const credentials = {};
export function testHeaders(base) {
  return {
    Origin: base,
    ...(process.env.VERCEL_PROTECTION_BYPASS
      ? { "x-vercel-protection-bypass": process.env.VERCEL_PROTECTION_BYPASS }
      : {}),
  };
}
const fixtureUsers = [];
for (const [key, role] of [
  ["admin", "admin"],
  ["staff", "staff"],
  ["otherStaff", "staff"],
  ["student", "staff"],
]) {
  const old = await context.internalAdapter.findUserByEmail(
    `exchange-test-${key.toLowerCase()}@example.invalid`,
  );
  if (old) {
    await context.internalAdapter.updateUser(old.user.id, { banned: true });
    await context.internalAdapter.deleteUserSessions(old.user.id);
  }
  const email = `exchange-test-${key.toLowerCase()}-${randomBytes(6).toString("hex")}@example.invalid`,
    password = randomBytes(20).toString("base64url");
  const { user } = await auth.api.createUser({
    body: { email, password, name: "Test " + key, role },
  });
  fixtureUsers.push(user.id);
  credentials[key] = { email, password };
}
export async function cleanupAuthFixtures(additionalIds = []) {
  const base = process.env.TEST_URL || "http://127.0.0.1:8788";
  const signed = await fetch(base + "/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...testHeaders(base) },
    body: JSON.stringify(credentials.admin),
  });
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (signed.ok && cookie) {
    const headers = { Cookie: cookie, ...testHeaders(base) };
    const response = await fetch(base + "/api/admin/desks", { headers });
    if (response.ok) {
      const owned = new Set([...fixtureUsers, ...additionalIds]);
      for (const desk of (await response.json()).desks.filter((d) =>
        owned.has(d.account),
      )) {
        if (desk.room)
          await fetch(base + "/api/admin/desks/" + desk.id, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ rotate: true }),
          });
        const removed = await fetch(base + "/api/admin/desks/" + desk.id, {
          method: "DELETE",
          headers,
        });
        if (!removed.ok)
          throw new Error("Fixture desk cleanup failed: " + removed.status);
      }
    }
  }

  for (const id of [...fixtureUsers, ...additionalIds]) {
    await context.internalAdapter.deleteUser(id);
  }
}
export async function makeLegacyStudentFixture() {
  const result = await context.internalAdapter.findUserByEmail(
    credentials.student.email,
  );
  await context.internalAdapter.updateUser(result.user.id, { role: "student" });
}
export async function login(page, base, key = "staff") {
  const response = await page.request.post(base + "/api/auth/sign-in/email", {
    data: credentials[key],
    headers: testHeaders(base),
  });
  if (!response.ok())
    throw new Error(
      "Test sign-in failed: " +
        response.status() +
        " " +
        (await response.text()),
    );
}
