import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { identity } from "../public/crypto.js";
import {
  login,
  credentials,
  cleanupAuthFixtures,
  testHeaders,
  makeLegacyStudentFixture,
} from "./auth-helper.mjs";
const base = process.env.TEST_URL || "http://127.0.0.1:8788";
const administrator = credentials.admin;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const imported = [];
let adminPage;
try {
  const guest = await browser.newPage({ extraHTTPHeaders: testHeaders(base) });
  const errors = [];
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(base);
  await guest.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await guest.locator("#welcome").isVisible(), false);
  assert.equal(
    (await guest.request.post(base + "/api/rooms", { data: {} })).status(),
    401,
  );
  assert.equal(
    (await guest.request.get(base + "/api/admin/users")).status(),
    401,
  );
  assert.equal(
    (
      await guest.request.post(base + "/api/auth/sign-up/email", {
        data: {
          name: "Denied",
          email: "denied@example.invalid",
          password: "123456",
        },
      })
    ).status(),
    404,
  );
  console.log(
    "PASS visitors see login and cannot access transfer/admin APIs or register themselves",
  );
  adminPage = await browser.newPage({ extraHTTPHeaders: testHeaders(base) });
  adminPage.on("pageerror", (e) => errors.push(e.message));
  await adminPage.goto(base + "/admin.html");
  await adminPage
    .getByLabel("Email", { exact: true })
    .fill(administrator.email);
  await adminPage
    .getByLabel("Password", { exact: true })
    .fill(administrator.password);
  await adminPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await adminPage
    .getByRole("heading", { name: "Manage users", exact: true })
    .waitFor();
  const email = `csv-test-${randomBytes(6).toString("hex")}@example.invalid`,
    password = randomBytes(3).toString("hex");
  const csv = `email,name,role,password\r\n${email},"Imported, person",staff,${password}\r\n`;
  await adminPage.getByLabel("Users CSV").setInputFiles({
    name: "users.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await adminPage
    .getByText("1 valid users. Review them before importing.", { exact: true })
    .waitFor();
  assert.equal(
    await adminPage
      .locator("#csv-preview")
      .innerText()
      .then((t) => t.includes(password)),
    false,
  );
  await adminPage
    .getByRole("button", { name: "Import users", exact: true })
    .click();
  await adminPage
    .getByText("1 created · 0 failed · 0 remaining", { exact: true })
    .waitFor();
  const users = await (
    await adminPage.request.get(base + "/api/admin/users")
  ).json();
  const user = users.users.find((u) => u.email === email);
  assert.ok(user);
  imported.push(user.id);
  const invalid = await adminPage.request.post(base + "/api/admin/users", {
    data: {
      email: `short-${email}`,
      name: "Short",
      role: "student",
      password: "12345",
    },
  });
  assert.equal(invalid.status(), 400);
  const student = await browser.newPage({
    extraHTTPHeaders: testHeaders(base),
  });
  assert.equal(
    (
      await student.request.post(base + "/api/auth/sign-in/email", {
        data: { email, password },
      })
    ).status(),
    200,
  );
  await student.goto(base);
  await student.getByRole("button", { name: "Open desk" }).waitFor();
  assert.equal(
    (await student.request.get(base + "/api/admin/users")).status(),
    403,
  );
  await student.reload();
  await student.getByRole("button", { name: "Sign out" }).waitFor();
  console.log(
    "PASS CSV preview/import, exact six-character login, five-character rejection, employee permissions and session reload",
  );
  assert.equal(
    (
      await adminPage.request.post(base + "/api/admin/role", {
        data: { userId: user.id, role: "staff" },
      })
    ).status(),
    200,
  );
  await student.reload();
  await student.getByRole("button", { name: "Open desk" }).waitFor();
  const deskResponse = await student.request.post(base + "/api/rooms", {
    data: {
      name: "Role desk",
      publicKey: (
        await student.evaluate(async () =>
          (await import("/crypto.js")).identity(),
        )
      ).publicKey,
    },
  });
  assert.equal(deskResponse.status(), 201);
  const room = await deskResponse.json();
  const visitor = await browser.newPage({
    extraHTTPHeaders: testHeaders(base),
  });
  await login(visitor, base, "student");
  assert.equal(
    (
      await visitor.request.get(base + "/api/rooms/" + room.id + "/state", {
        headers: {
          Authorization: "Bearer " + room.token,
          "X-Account-ID": user.id,
          "X-Account-Role": "admin",
        },
      })
    ).status(),
    403,
  );
  const joined = await visitor.request.post(
    base + "/api/rooms/" + room.id + "/join",
    {
      data: {
        name: "Impersonated staff member",
        publicKey: (await identity()).publicKey,
      },
      headers: { "X-Invite": room.invite, "X-Account-Name": "Impersonated" },
    },
  );
  assert.equal(joined.status(), 201);
  const state = await (
    await student.request.get(base + "/api/rooms/" + room.id + "/state", {
      headers: { Authorization: "Bearer " + room.token },
    })
  ).json();
  assert.equal(state.peers[0].name, "Test student");
  console.log(
    "PASS copied room credentials and forged account names/roles cannot impersonate another user",
  );
  assert.equal(
    (
      await student.request.delete(base + "/api/rooms/" + room.id, {
        headers: { Authorization: "Bearer " + room.token },
      })
    ).status(),
    200,
  );
  const other = await browser.newPage({ extraHTTPHeaders: testHeaders(base) });
  await login(other, base, "student");
  assert.equal(
    (
      await other.request.get(base + "/api/rooms/" + room.id + "/state", {
        headers: { Authorization: "Bearer " + room.token },
      })
    ).status(),
    410,
  );
  await adminPage.request.post(base + "/api/admin/password", {
    data: { userId: user.id, password: "New-7482" },
  });
  assert.equal(
    (await student.request.get(base + "/api/admin/users")).status(),
    401,
  );
  assert.equal(
    (
      await student.request.post(base + "/api/auth/sign-in/email", {
        data: { email, password },
      })
    ).status(),
    401,
  );
  assert.equal(
    (
      await student.request.post(base + "/api/auth/sign-in/email", {
        data: { email, password: "New-7482" },
      })
    ).status(),
    200,
  );
  await adminPage.request.post(base + "/api/admin/status", {
    data: { userId: user.id, disabled: true },
  });
  assert.equal(
    (await student.request.post(base + "/api/rooms", { data: {} })).status(),
    401,
  );
  assert.equal(
    (
      await student.request.post(base + "/api/auth/sign-in/email", {
        data: { email, password: "New-7482" },
      })
    ).status(),
    403,
  );
  console.log(
    "PASS role changes, password reset revokes sessions, disabled accounts lose access",
  );
  const signedInAdmin = await (
    await adminPage.request.get(base + "/api/auth/get-session")
  ).json();
  assert.equal(
    (
      await adminPage.request.post(base + "/api/admin/role", {
        data: { userId: signedInAdmin.user.id, role: "student" },
      })
    ).status(),
    403,
  );
  await guest
    .getByLabel("Email", { exact: true })
    .fill(credentials.staff.email);
  await guest
    .getByLabel("Password", { exact: true })
    .fill(credentials.staff.password);
  await guest.getByRole("button", { name: "Sign in", exact: true }).click();
  await guest.getByRole("button", { name: "Open desk" }).waitFor();
  await guest.evaluate(async () => {
    const old = await new Promise((resolve, reject) => {
      const request = indexedDB.open("document-exchange-v3", 1);
      request.onupgradeneeded = () => {
        for (const name of ["sessions", "files", "chunks"])
          request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = old.transaction("files", "readwrite");
      const blob = new Blob(["%PDF-1.7\nLegacy saved file"], {
        type: "application/pdf",
      });
      tx.objectStore("files").put({
        id: crypto.randomUUID(),
        room: crypto.randomUUID(),
        kind: "incoming",
        from: "desk",
        to: "test",
        name: "earlier.pdf",
        size: blob.size,
        blob,
        created: Date.now(),
        completed: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    old.close();
  });
  await guest.reload();
  await guest
    .getByRole("button", { name: "Recover earlier files", exact: true })
    .click();
  await guest.getByText("earlier.pdf", { exact: true }).waitFor();
  console.log(
    "PASS pre-login saved files can be recovered without deleting their original copy",
  );
  await guest.getByRole("button", { name: "Change password" }).click();
  await guest
    .getByLabel("Current password", { exact: true })
    .fill(credentials.staff.password);
  await guest.getByLabel("New password", { exact: true }).fill("Own-9348");
  await guest
    .getByRole("button", { name: "Save password", exact: true })
    .click();
  await guest
    .getByText("Password changed. Other sign-ins have ended.", { exact: true })
    .waitFor();
  await guest.getByRole("button", { name: "Close", exact: true }).click();
  await guest.getByRole("button", { name: "Sign out", exact: true }).click();
  await guest.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await guest.getByText("earlier.pdf", { exact: true }).isVisible(),
    false,
  );
  await guest
    .getByLabel("Email", { exact: true })
    .fill(credentials.student.email);
  await guest
    .getByLabel("Password", { exact: true })
    .fill(credentials.student.password);
  await guest.getByRole("button", { name: "Sign in", exact: true }).click();
  await guest.getByRole("button", { name: "Sign out" }).waitFor();
  assert.equal(
    await guest.getByText("earlier.pdf", { exact: true }).count(),
    0,
  );
  assert.equal(await guest.locator("#legacy-recovery").isVisible(), false);
  console.log(
    "PASS signing in as another person cannot reveal the previous account's saved documents",
  );
  await makeLegacyStudentFixture();
  assert.equal(
    (await guest.request.post(base + "/api/rooms", { data: {} })).status(),
    401,
  );
  assert.equal(
    (
      await guest.request.post(base + "/api/auth/sign-in/email", {
        data: credentials.student,
      })
    ).status(),
    403,
  );
  console.log(
    "PASS legacy student accounts cannot retain employee access or sign in",
  );
  await mkdir("test-results", { recursive: true });
  await adminPage.evaluate(() => window.scrollTo(0, 0));
  await adminPage.screenshot({
    path: "test-results/admin.png",
    fullPage: false,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS protected administrator, password change and sign-out; no browser errors",
  );
} finally {
  for (const userId of imported)
    await adminPage?.request
      .post(base + "/api/admin/status", { data: { userId, disabled: true } })
      .catch(() => {});
  await browser.close();
  await cleanupAuthFixtures(imported);
}
