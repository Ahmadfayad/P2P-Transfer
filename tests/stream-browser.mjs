import { chromium, firefox, webkit } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const { login, credentials, cleanupAuthFixtures, testHeaders } = await import(
  process.env.LOOPBACK_RELIABILITY === "1"
    ? "./loopback-auth-helper.mjs"
    : "./auth-helper.mjs"
);
const base = process.env.TEST_URL || "http://127.0.0.1:8788";
const baseline = process.env.BASELINE === "1";
const engine = process.env.BROWSER || "chromium";
const browser = await { chromium, firefox, webkit }[engine].launch({
  headless: true,
  ...(engine === "chromium"
    ? {
        executablePath:
          process.env.CHROME_PATH ||
          (process.platform === "win32"
            ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
            : chromium.executablePath()),
      }
    : {}),
});
const rooms = [],
  contexts = [],
  errors = [],
  measurements = [];
async function setup({ direct = false, clock = false } = {}) {
  const staffContext = await browser.newContext({
      extraHTTPHeaders: testHeaders(base),
    }),
    guestContext = await browser.newContext({
      extraHTTPHeaders: testHeaders(base),
    });
  contexts.push(staffContext, guestContext);
  for (const ctx of [staffContext, guestContext]) {
    if (!direct)
      await ctx.addInitScript(() => {
        window.RTCPeerConnection = class {
          constructor() {
            throw new Error("RTC disabled by test");
          }
        };
      });
    else
      await ctx.addInitScript(() => {
        const Native = RTCPeerConnection;
        window.testConnections = [];
        window.RTCPeerConnection = class extends Native {
          constructor(...args) {
            super(...args);
            window.testConnections.push(this);
          }
        };
      });
  }
  const staff = await staffContext.newPage(),
    guest = await guestContext.newPage();
  for (const p of [staff, guest]) p.on("pageerror", (e) => errors.push(e.name));
  if (clock) {
    await staff.clock.install();
    await guest.clock.install();
  }
  await login(staff, base);
  await staff.goto(base);
  const created = staff.waitForResponse(
    (r) => r.url().endsWith("/api/rooms") && r.request().method() === "POST",
  );
  await staff.getByRole("button", { name: "Open desk" }).click();
  const roomResponse = await created;
  assert.equal(
    roomResponse.status(),
    201,
    "Desk creation must succeed before showing its QR",
  );
  const room = await roomResponse.json();
  await staff
    .getByRole("button", { name: "Copy invitation link", exact: true })
    .waitFor();
  await staff.evaluate(() => {
    navigator.clipboard.writeText = async (value) => {
      window.testLink = value;
    };
  });
  await staff
    .getByRole("button", { name: "Copy invitation link", exact: true })
    .click();
  const link = await staff.evaluate(() => window.testLink);
  const printed = Object.fromEntries(
    new URLSearchParams(new URL(link).hash.slice(1)),
  );
  const invitation = {
    room: room.id,
    token: room.token,
    invite: room.invite,
    desk: printed.desk,
    code: printed.code,
  };
  assert.equal(
    room.expires > Date.now() && room.expires <= Date.now() + 8 * 3600000,
    true,
  );
  assert.equal(await staff.locator("#desk-name").inputValue(), room.name);
  rooms.push({
    id: invitation.room,
    token: invitation.token,
    request: staff.request,
    desk: invitation.desk,
  });
  await guest.goto(link);
  await guest.locator("#student-name").fill("Sensitive test student");
  if (!baseline) {
    await guest.locator("#student-id").fill("sensitive-id-987");
  }
  await guest.getByRole("button", { name: "Request connection" }).click();
  if (!baseline) {
    await guest.locator("#student-phase").waitFor();
    assert.equal(await guest.locator("#files").isEnabled(), false);
  }
  await staff.getByRole("button", { name: "Approve", exact: true }).click();
  await guest.waitForFunction(() => !document.querySelector("#files").disabled);
  return { staff, guest, staffContext, guestContext, invitation };
}
function payload(size) {
  const bytes = Buffer.alloc(size, 42);
  bytes.write("%PDF-1.7\n");
  return bytes;
}
async function send(pair, name, bytes) {
  await pair.guest
    .locator("#files")
    .setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
}
async function basic(options) {
  const pair = await setup(options),
    bytes = payload(8 * 1048576),
    name = "sensitive-document.pdf";
  if (options.direct)
    await pair.staff.waitForFunction(
      () =>
        window.testConnections.some((pc) => pc.connectionState === "connected"),
      {},
      { timeout: 30000 },
    );
  let apiRequests = 0,
    uploads = 0;
  for (const p of [pair.staff, pair.guest])
    p.on("request", (r) => {
      if (r.url().includes("/api/")) apiRequests++;
      if (r.method() === "POST" && r.url().includes("/stream")) uploads++;
    });
  if (options.direct)
    await pair.staff.evaluate(() => {
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      window.testConsumed = 0;
      crypto.subtle.decrypt = async (...args) => {
        await new Promise((r) => setTimeout(r, 80));
        const data = await decrypt(...args);
        window.testConsumed++;
        return data;
      };
    });
  const start = performance.now();
  await send(pair, name, bytes);
  if (options.direct) {
    await pair.staff.waitForFunction(() => window.testConsumed >= 2);
    await pair.staff.evaluate(() =>
      window.testConnections.forEach((pc) => pc.close()),
    );
  }
  let digest;
  {
    await pair.staff
      .getByText(baseline ? "Received ✓" : "Received — download to keep it", {
        exact: true,
      })
      .waitFor({ timeout: 120000 });
    const downloaded = pair.staff.waitForEvent("download");
    await pair.staff
      .getByRole("button", {
        name: baseline ? "Save a copy" : "Download document",
        exact: true,
      })
      .click();
    const actual = await readFile(await (await downloaded).path());
    digest = createHash("sha256").update(actual).digest("hex");
    if (!baseline)
      await pair.staff
        .getByText("Download started", {
          exact: true,
        })
        .waitFor();
  }
  assert.equal(digest, createHash("sha256").update(bytes).digest("hex"));
  const elapsedMs = Math.round(performance.now() - start);
  measurements.push({
    transport: baseline
      ? "legacy-chunk-relay"
      : options.direct
        ? "direct-then-https"
        : "https-stream",
    bytes: bytes.length,
    elapsedMs,
    apiRequests,
    uploads,
    receiver: "browser-download",
  });
  if (!baseline) {
    for (const p of [pair.staff, pair.guest])
      assert.equal(
        await p.evaluate(async () => {
          const db = await import("/storage.js");
          return (
            (await db.all("files")).length + (await db.all("chunks")).length
          );
        }),
        0,
      );
    await pair.guest.locator(".diagnostics summary").click();
    const downloaded = pair.guest.waitForEvent("download");
    await pair.guest
      .getByRole("button", { name: "Download system log" })
      .click();
    const report = await readFile(await (await downloaded).path(), "utf8");
    for (const secret of [
      "Sensitive test student",
      "sensitive-person@example.invalid",
      "sensitive-id-987",
      name,
      pair.invitation.invite,
      pair.invitation.token,
    ])
      assert.equal(report.includes(secret), false);
  }
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/stream-" + engine + "-performance.json",
    JSON.stringify(measurements, null, 2),
  );
  console.log(
    "PASS exact bytes, save-status distinction, nonpersistent buffers and diagnostic redaction: " +
      measurements.at(-1).transport +
      " " +
      elapsedMs +
      " ms",
  );
  if (!baseline) {
    assert.equal(
      await pair.staff.getByRole("button", { name: "Receive & save" }).count(),
      0,
    );
    assert.equal(
      (await pair.staff.locator(".presence.green").count()) > 0,
      true,
    );
    await pair.staff
      .locator("#recipient")
      .selectOption({ label: "Sensitive test student · sensitive-id-987" });
    await pair.staff.locator("#files").setInputFiles({
      name: "return.pdf",
      mimeType: "application/pdf",
      buffer: bytes,
    });
    await pair.guest
      .getByText("Received — download to keep it", { exact: true })
      .waitFor({ timeout: 120000 });
    const back = pair.guest.waitForEvent("download");
    await pair.guest
      .getByRole("button", { name: "Download document", exact: true })
      .click();
    assert.deepEqual(await readFile(await (await back).path()), bytes);
    await pair.guest.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await pair.guest.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await pair.guest.screenshot({
      path: "test-results/student-mobile.png",
      fullPage: true,
    });
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VwkAAAAASUVORK5CYII=",
      "base64",
    );
    await pair.staff.locator("#files").setInputFiles({
      name: "preview.png",
      mimeType: "image/png",
      buffer: image,
    });
    await pair.guest.locator(".file-thumbnail").waitFor({ timeout: 30000 });
    assert.equal(
      await pair.guest
        .locator(".file-thumbnail")
        .evaluate((img) => img.complete && img.naturalWidth === 1),
      true,
    );
    const imageRow = pair.guest
      .locator(".file")
      .filter({ has: pair.guest.getByText("preview.png", { exact: true }) });
    await imageRow
      .getByRole("button", { name: "Preview", exact: true })
      .click();
    await pair.guest.locator("#preview-content img").waitFor();
    await pair.guest.getByRole("button", { name: "Close preview" }).click();
    await pair.staff.screenshot({
      path: "test-results/staff-auto-receive.png",
      fullPage: true,
    });
    pair.guest.once("dialog", (dialog) => dialog.accept());
    await pair.guest
      .getByRole("button", { name: "Change desk", exact: true })
      .click();
    await pair.guest.locator("#student-start").waitFor();
    await pair.staff
      .getByText("Ended connections (1)", { exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(await pair.staff.locator(".presence.red").count(), 1);
    await pair.guest.reload();
    await pair.guest.locator("#student-start").waitFor();
    console.log(
      "PASS automatic reception in both directions, mobile layout, presence, desk switching and no session restoration",
    );
  }
  await pair.staffContext.close();
  await pair.guestContext.close();
}
try {
  await basic({});
  if (!baseline && process.env.COMPAT_ONLY !== "1") {
    await basic({ direct: true });
    // Slow decryption keeps an automatically accepted transfer active for cancellation checks.
    const slowReceive = async (pair) => {
      await pair.staff.evaluate(() => {
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        window.testConsumed = 0;
        crypto.subtle.decrypt = async (...args) => {
          await new Promise((r) => setTimeout(r, 300));
          const bytes = await decrypt(...args);
          window.testConsumed++;
          return bytes;
        };
      });
      await send(pair, "interruption.pdf", payload(20 * 1048576));
      await pair.staff.waitForFunction(() => window.testConsumed >= 2);
    };
    const pair = await setup();
    await slowReceive(pair);
    await pair.staff.reload();
    await pair.staff.getByRole("button", { name: "Open desk" }).waitFor();
    await pair.guest
      .getByText("Interrupted — send again", { exact: true })
      .waitFor({ timeout: 60000 });
    assert.equal(
      await pair.staff.evaluate(async () => {
        const db = await import("/storage.js");
        return (
          (await db.all("sessions")).length +
          (await db.all("files")).length +
          (await db.all("chunks")).length
        );
      }),
      0,
    );
    console.log(
      "PASS refresh does not restore a session or persist document contents",
    );
    const revoked = await setup();
    await slowReceive(revoked);
    await revoked.staff
      .getByRole("button", { name: "End connection", exact: true })
      .click();
    await revoked.staff
      .getByText("Interrupted — send again", { exact: true })
      .waitFor({ timeout: 30000 });
    console.log("PASS staff revocation interrupts automatic reception");
    const disabled = await setup();
    await slowReceive(disabled);
    const adminContext = await browser.newContext({
      extraHTTPHeaders: testHeaders(base),
    });
    contexts.push(adminContext);
    const adminPage = await adminContext.newPage();
    await login(adminPage, base, "admin");
    const employee = (
      await (await adminPage.request.get(base + "/api/admin/users")).json()
    ).users.find((u) => u.email === credentials.staff.email);
    try {
      assert.equal(
        (
          await adminPage.request.post(base + "/api/admin/status", {
            data: { userId: employee.id, disabled: true },
          })
        ).status(),
        200,
      );
      await disabled.staff
        .getByText("Interrupted — send again", { exact: true })
        .waitFor({ timeout: 30000 });
      assert.equal(
        (
          await disabled.staff.request.post(
            base + "/api/rooms/" + disabled.invitation.room + "/lease",
            {
              data: {},
              headers: { Authorization: "Bearer " + disabled.invitation.token },
            },
          )
        ).status(),
        401,
      );
      console.log(
        "PASS account revocation cancels automatic reception and leases",
      );
    } finally {
      assert.equal(
        (
          await adminPage.request.post(base + "/api/admin/status", {
            data: { userId: employee.id, disabled: false },
          })
        ).status(),
        200,
      );
    }
  }
  if (!baseline && process.env.COMPAT_ONLY !== "1") {
    const expiring = await setup({ clock: true });
    await expiring.staff.clock.fastForward(600001);
    await expiring.guest.clock.fastForward(600001);
    await expiring.staff
      .getByRole("button", { name: "End desk session" })
      .waitFor();
    await expiring.guest
      .getByRole("heading", { name: "This session has ended" })
      .waitFor();
    assert.equal(await expiring.staff.locator("#files").isEnabled(), true);
    assert.equal(await expiring.guest.locator("#files").isEnabled(), false);
    console.log(
      "PASS student expires independently while the staff desk stays open",
    );
  }
  assert.deepEqual(errors, []);
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/" +
      (baseline ? "baseline" : "stream-" + engine) +
      "-performance.json",
    JSON.stringify(measurements, null, 2),
  );
  console.log(JSON.stringify(measurements));
} finally {
  const cleanupContext = await browser.newContext({
    extraHTTPHeaders: testHeaders(base),
  });
  const cleanupPage = await cleanupContext.newPage();
  await login(cleanupPage, base);
  for (const room of rooms)
    await cleanupPage.request
      .delete(base + "/api/rooms/" + room.id, {
        headers: {
          Authorization: "Bearer " + room.token,
          ...testHeaders(base),
        },
      })
      .catch(() => {});
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await cleanupContext.close();
  await browser.close();
  await cleanupAuthFixtures();
}
