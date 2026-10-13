import { chromium } from "playwright";
import assert from "node:assert/strict";
import {
  login,
  credentials,
  cleanupAuthFixtures,
  testHeaders,
} from "./auth-helper.mjs";
const base = process.env.TEST_URL || "http://127.0.0.1:8788";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const contexts = [],
  rooms = [];
try {
  const staffContext = await browser.newContext({
    extraHTTPHeaders: testHeaders(base),
  });
  const guestContext = await browser.newContext({
    extraHTTPHeaders: testHeaders(base),
  });
  contexts.push(staffContext, guestContext);
  const staff = await staffContext.newPage(),
    guest = await guestContext.newPage();
  await login(staff, base);
  await staff.goto(base);
  await staff.locator("#print-desk").waitFor();
  const desk = await (
    await staff.request.post(base + "/api/desks", { data: {} })
  ).json();
  const link =
    base +
    "/student#" +
    new URLSearchParams({ desk: desk.id, code: desk.code });
  await guest.goto(link);
  await guest
    .getByText(
      "Test staff’s desk is currently unavailable. Please ask staff to open it.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await guest.locator('input[type="url"]').count(), 0);
  assert.equal(await staff.locator("#desk-location").count(), 0);
  await staff.request.post(base + "/api/desks", { data: { location: "Registrar Desk 4" } });
  const created = staff.waitForResponse(
    (r) => r.url().endsWith("/api/rooms") && r.request().method() === "POST",
  );
  await staff.getByRole("button", { name: "Open desk" }).click();
  rooms.push(
    await (
      await created.catch(async () => {
        throw new Error(
          "Desk open failed: " +
            (await staff.locator("#message").textContent()),
        );
      })
    ).json(),
  );
  await guest.getByRole("button", { name: "Check desk again" }).click();
  await guest
    .getByText("You’re joining Test staff’s desk · Registrar Desk 4", {
      exact: true,
    })
    .waitFor();
  await guest.locator("#student-name").fill("Fixture student");
  await guest.locator("#student-id").fill("U000123");
  await guest.getByRole("button", { name: "Request connection" }).click();
  await staff
    .getByText("Fixture student · U000123", { exact: true })
    .first()
    .waitFor();
  await staff.locator("#approval-approve").click();
  await guest.waitForFunction(() => !document.querySelector("#files").disabled);
  assert.equal(await guest.locator("#room-name").textContent(), "Staff: Test staff");
  assert.match(await guest.locator("#session-note").textContent(), /Your details: Fixture student · U000123/);
  await staff.getByRole("button", { name: "Extend 10 minutes" }).click();
  await staff.waitForFunction(() =>
    document.querySelector("#sending-to").textContent.includes("U000123"),
  );
  await staff.evaluate(() => {
    window.print = () => {
      window.testPrinted = true;
    };
  });
  await staff.locator("#print-desk-active").click();
  await staff.waitForFunction(() => window.testPrinted);
  await staff.emulateMedia({ media: "print" });
  assert.equal(await staff.locator(".print-sheet").isVisible(), true);
  assert.equal(await staff.locator("#workspace").isVisible(), false);
  await staff.screenshot({
    path: "test-results/printed-desk-sheet.png",
    fullPage: true,
  });
  await staff.emulateMedia({ media: "screen" });
  await guest.getByRole("button", { name: "Change desk", exact: true }).click();
  await guest
    .getByRole("heading", { name: "Scan the QR at your desk" })
    .waitFor();
  staff.once("dialog", (dialog) => dialog.accept());
  await staff.getByRole("button", { name: "End desk session" }).click();
  await staff.getByRole("button", { name: "Open desk" }).waitFor();
  const reopened = staff.waitForResponse(
    (r) => r.url().endsWith("/api/rooms") && r.request().method() === "POST",
  );
  await staff.getByRole("button", { name: "Open desk" }).click();
  rooms.push(await (await reopened).json());
  await staff.getByRole("button", { name: "Copy invitation link" }).waitFor();
  const same = await (
    await staff.request.post(base + "/api/desks", { data: {} })
  ).json();
  assert.equal(same.id, desk.id);
  assert.equal(same.code, desk.code);
  await staff.getByRole("button", { name: "Sign out", exact: true }).click();
  await staff.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  const closed = await guest.request.get(base + "/api/desks/" + desk.id, {
    headers: { "X-Desk-Code": desk.code },
  });
  assert.equal((await closed.json()).available, false);
  const otherContext = await browser.newContext({
    extraHTTPHeaders: testHeaders(base),
  });
  contexts.push(otherContext);
  const other = await otherContext.newPage();
  await login(other, base, "otherStaff");
  await other.goto(base);
  await other.locator("#print-desk").waitFor();
  const otherDesk = await (
    await other.request.post(base + "/api/desks", { data: {} })
  ).json();
  const adminContext = await browser.newContext({
    extraHTTPHeaders: testHeaders(base),
  });
  contexts.push(adminContext);
  const admin = await adminContext.newPage();
  await login(admin, base, "admin");
  await admin.goto(base + "/admin.html");
  const row = admin.locator('.desk-admin-row[data-desk-id="' + desk.id + '"]');
  await row.waitFor();
  await row.locator("input").nth(0).fill("Registrar Desk 12");
  await row.locator("input").nth(1).fill(credentials.otherStaff.email);
  await row.getByRole("button", { name: "Save desk" }).click();
  await admin
    .getByText("Desk updated. Staff should refresh before opening it.", {
      exact: true,
    })
    .waitFor();
  const reassigned = await (
    await guest.request.get(base + "/api/desks/" + desk.id, {
      headers: { "X-Desk-Code": desk.code },
    })
  ).json();
  assert.equal(reassigned.name, "Test otherStaff");
  assert.equal(reassigned.location, "Registrar Desk 12");
  assert.equal(
    (await (await other.request.post(base + "/api/desks", { data: {} })).json())
      .id,
    desk.id,
  );
  await login(staff, base);
  assert.equal(
    (await (await staff.request.post(base + "/api/desks", { data: {} })).json())
      .id,
    otherDesk.id,
  );
  admin.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Replace printed QR" }).click();
  await admin
    .getByText("QR replaced. Staff must refresh and print the new QR.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (
      await guest.request.get(base + "/api/desks/" + desk.id, {
        headers: { "X-Desk-Code": desk.code },
      })
    ).status(),
    404,
  );
  assert.equal(
    (
      await staff.request.post(base + "/api/admin/desks/" + otherDesk.id, {
        data: { rotate: true },
      })
    ).status(),
    403,
  );
  console.log(
    "PASS closed/open/reopened printed QR, student identity/ID, physical QR switching, extend, print sheet, logout closure, admin reassignment/swap and replacement authorization",
  );
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await cleanupAuthFixtures();
}
