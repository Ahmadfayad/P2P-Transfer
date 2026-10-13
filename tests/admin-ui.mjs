import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import {
  credentials,
  cleanupAuthFixtures,
  testHeaders,
} from "./auth-helper.mjs";
const base = process.env.TEST_URL || "http://127.0.0.1:8788";
const admin = credentials.admin;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const owned = [],
  errors = [];
try {
  const page = await browser.newPage({ extraHTTPHeaders: testHeaders(base) });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/admin.html");
  await page.getByLabel("Email", { exact: true }).fill(admin.email);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  assert.equal(
    await page.locator("#login-form input[name=password]").getAttribute("type"),
    "text",
  );
  await page
    .getByRole("button", { name: "Hide password", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Add user", exact: true }).waitFor();
  let creates = 0;
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname === "/api/admin/users"
    )
      creates++;
  });
  for (const role of ["staff", "admin"]) {
    const email = `manual-ui-${role}-${randomBytes(6).toString("hex")}@example.invalid`;
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const dialog = page.locator("#add-user-dialog");
    await dialog
      .getByLabel("Full name", { exact: true })
      .fill("Manual " + role);
    await dialog.getByLabel("Email address", { exact: true }).fill(email);
    await dialog.getByLabel("Account role", { exact: true }).selectOption(role);
    assert.ok(
      (await page.locator("#new-role-description").innerText()).length > 25,
    );
    await dialog
      .getByLabel("Temporary password", { exact: true })
      .fill("12345");
    await dialog.getByRole("button", { name: "Create user" }).click();
    assert.equal(
      await dialog
        .locator("input[name=password]")
        .evaluate((input) => input.validity.tooShort),
      true,
    );
    const before = creates;
    await dialog
      .getByLabel("Temporary password", { exact: true })
      .fill("Six-82");
    await dialog
      .getByRole("button", { name: "Show password", exact: true })
      .click();
    assert.equal(
      await dialog.locator("input[name=password]").getAttribute("type"),
      "text",
    );
    await dialog.getByRole("button", { name: "Create user" }).click();
    await page.locator("#users").getByText(email, { exact: true }).waitFor();
    assert.equal(creates, before + 1);
    const result = await (
      await page.request.get(base + "/api/admin/users")
    ).json();
    const user = result.users.find((u) => u.email === email);
    assert.equal(user.role, role);
    owned.push(user.id);
    assert.equal(await dialog.locator("input[name=password]").inputValue(), "");
  }
  console.log(
    "PASS manual creation for both employee roles, six-character passwords, validation and password clearing",
  );
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  await page
    .locator("#add-user-dialog")
    .getByLabel("Full name")
    .fill("Duplicate");
  const users = await (
    await page.request.get(base + "/api/admin/users")
  ).json();
  const duplicate = users.users.find((u) => u.id === owned[0]);
  await page
    .locator("#add-user-dialog")
    .getByLabel("Email address")
    .fill(duplicate.email);
  await page
    .locator("#add-user-dialog")
    .getByLabel("Temporary password")
    .fill("Six-82");
  await page
    .locator("#add-user-dialog")
    .getByRole("button", { name: "Create user" })
    .click();
  await page.waitForFunction(
    () => document.getElementById("add-user-error").textContent.length > 0,
  );
  assert.equal(
    await page.locator("#add-user-dialog").evaluate((d) => d.open),
    true,
  );
  await page.getByRole("button", { name: "Close add user" }).click();
  await mkdir("test-results", { recursive: true });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/admin-redesign.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/admin-redesign-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  assert.equal(
    await page
      .locator("#add-user-dialog")
      .evaluate((d) => d.getBoundingClientRect().width <= innerWidth),
    true,
  );
  await page.screenshot({ path: "test-results/add-user-mobile.png" });
  await page.getByRole("button", { name: "Close add user" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  await page.screenshot({ path: "test-results/login-redesign-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS duplicate errors, login interaction and mobile layout with no overflow or script errors",
  );
} finally {
  await browser.close();
  await cleanupAuthFixtures(owned);
}
