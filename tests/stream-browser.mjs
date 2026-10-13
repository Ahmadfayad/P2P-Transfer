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
          process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : chromium.executablePath()),
      }
    : {}),
});
const rooms = [],
  contexts = [],
  errors = [],
  measurements = [];
async function setup({ direct = false, disk = false, slow = 0 } = {}) {
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
  await staffContext.addInitScript(
    ({ disk, slow }) => {
      window.testWrites = [];
      window.testAborted = false;
      window.testClosed = false;
      window.showSaveFilePicker = disk
        ? async () => ({
            createWritable: async () => ({
              write: async (bytes) => {
                if (slow) await new Promise((r) => setTimeout(r, slow));
                window.testWrites.push(new Uint8Array(bytes));
              },
              close: async () => {
                window.testClosed = true;
              },
              abort: async () => {
                window.testAborted = true;
                window.testWrites = [];
              },
            }),
          })
        : undefined;
    },
    { disk, slow },
  );
  const staff = await staffContext.newPage(),
    guest = await guestContext.newPage();
  for (const p of [staff, guest]) p.on("pageerror", (e) => errors.push(e.name));
  await login(staff, base);
  await staff.goto(base);
  await staff.locator("#desk-name").fill("Streaming test");
  await staff.getByRole("button", { name: "Open desk" }).click();
  await staff
    .getByRole("button", { name: "Copy invitation link", exact: true })
    .waitFor();
  const invitation = await staff.evaluate(async () => {
    const db = await import("/storage.js");
    const s = await db.get(
      "sessions",
      sessionStorage.getItem("exchange-session"),
    );
    const { fingerprint } = await import("/crypto.js");
    return {
      room: s.room,
      invite: s.invite,
      key: await fingerprint(s.publicKey),
      token: s.token,
    };
  });
  rooms.push({
    id: invitation.room,
    token: invitation.token,
    request: staff.request,
  });
  await guest.goto(
    base +
      "/#" +
      new URLSearchParams({
        room: invitation.room,
        invite: invitation.invite,
        key: invitation.key,
      }),
  );
  await guest.locator("#student-name").fill("Sensitive test student");
  if (!baseline) {
    await guest
      .locator("#student-email")
      .fill("sensitive-person@example.invalid");
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
  if (!baseline)
    await pair.staff
      .getByRole("button", { name: "Receive & save", exact: true })
      .click({ timeout: 30000 });
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
  const start = performance.now();
  await send(pair, name, bytes);
  if (options.direct) {
    await pair.staff.waitForFunction(() => window.testWrites.length >= 2);
    await pair.staff.evaluate(() =>
      window.testConnections.forEach((pc) => pc.close()),
    );
  }
  let digest;
  if (options.disk) {
    await pair.staff
      .getByText("Saved to disk ✓", { exact: true })
      .waitFor({ timeout: 120000 });
    digest = await pair.staff.evaluate(async () => {
      const blob = new Blob(window.testWrites);
      return Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    });
    assert.equal(await pair.staff.evaluate(() => window.testClosed), true);
  } else {
    await pair.staff
      .getByText(baseline ? "Received ✓" : "Received ✓ · download ready", {
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
        .getByText("Download initiated · disk save unconfirmed", {
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
    receiver: options.disk ? "disk-api-test-double" : "browser-download",
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
  await pair.staffContext.close();
  await pair.guestContext.close();
}
try {
  await basic({ disk: false });
  if (!baseline && process.env.COMPAT_ONLY !== "1") {
    await basic({ disk: true, direct: true, slow: 80 });
    const pair = await setup({ disk: true, slow: 250 });
    await send(pair, "interruption.pdf", payload(20 * 1048576));
    await pair.staff.waitForFunction(() => window.testWrites.length >= 2);
    await pair.staff.reload();
    await pair.staff
      .getByText("Interrupted — resend needed", { exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(
      await pair.staff.evaluate(async () => {
        const db = await import("/storage.js");
        return (await db.all("files")).length;
      }),
      0,
    );
    console.log(
      "PASS refresh interruption asks for resend and does not persist new contents",
    );
    const revoked = await setup({ disk: true, slow: 250 });
    await send(revoked, "revoked.pdf", payload(20 * 1048576));
    await revoked.staff.waitForFunction(() => window.testWrites.length >= 2);
    await revoked.staff
      .getByRole("button", { name: "End connection", exact: true })
      .click();
    await revoked.staff.waitForFunction(() => window.testAborted);
    console.log("PASS staff revocation aborts the disk write");
    const rejected = await setup();
    await rejected.guest.locator("#files").setInputFiles({
      name: "reject.pdf",
      mimeType: "application/pdf",
      buffer: payload(1048576),
    });
    await rejected.staff
      .getByRole("button", { name: "Reject file", exact: true })
      .click();
    await rejected.guest
      .getByText("Interrupted — resend needed", { exact: true })
      .waitFor({ timeout: 30000 });
    console.log("PASS file rejection does not start a content stream");
    const disabled = await setup({ disk: true, slow: 250 });
    await send(disabled, "account-revoked.pdf", payload(20 * 1048576));
    await disabled.staff.waitForFunction(() => window.testWrites.length >= 2);
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
      await disabled.staff.waitForFunction(
        () => window.testAborted,
        {},
        { timeout: 30000 },
      );
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
        "PASS disabling the staff account cancels active streams and invalidates employee leases",
      );
    } finally {
      await adminPage.request.post(base + "/api/admin/status", {
        data: { userId: employee.id, disabled: false },
      });
    }
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
