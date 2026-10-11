import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = process.env.TEST_URL || "http://127.0.0.1:8787";
const setup =
  process.env.DESK_SETUP_KEY ||
  (await readFile(".dev.vars", "utf8")).trim().split("=")[1];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const errors = [];
const contexts = [];
const payload = Buffer.alloc(8 * 1048576, 42);
payload.write("%PDF-1.7\n");
const digest = createHash("sha256").update(payload).digest("hex");
async function client(direct) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  if (!direct)
    await ctx.addInitScript(() => {
      window.RTCPeerConnection = class {
        constructor() {
          throw new Error("RTC blocked for this test.");
        }
      };
    });
  else
    await ctx.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      window.testConnections = [];
      window.RTCPeerConnection = class extends Native {
        constructor(...args) {
          super(...args);
          window.testConnections.push(this);
        }
      };
    });
  const page = await ctx.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return { ctx, page };
}
async function localDigest(page, name) {
  return page.evaluate(async (name) => {
    const db = await import("/storage.js");
    const file = (await db.all("files")).find(
      (f) => f.name === name && f.completed,
    );
    if (!file) return null;
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await file.blob.arrayBuffer()),
      ),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
  }, name);
}
async function waitReceipt(page, name) {
  await page
    .locator(".file")
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByText("Received ✓", { exact: true })
    .waitFor({ timeout: 120000 });
}
try {
  for (const direct of [false, true]) {
    const { page: desk } = await client(direct),
      { page: student, ctx: studentContext } = await client(direct);
    await student.setViewportSize({ width: 390, height: 844 });
    await desk.goto(base);
    await desk.getByLabel("Desk name", { exact: true }).fill("Test desk");
    await desk.getByLabel("Desk access key").fill(setup);
    await desk.getByRole("button", { name: "Open desk" }).click();
    await desk.getByRole("button", { name: "Copy invitation link" }).waitFor();
    const saved = await desk.evaluate(async () => {
      const db = await import("/storage.js");
      const s = await db.get(
        "sessions",
        localStorage.getItem("exchange-session"),
      );
      const { fingerprint } = await import("/crypto.js");
      return {
        room: s.room,
        invite: s.invite,
        key: await fingerprint(s.publicKey),
      };
    });
    await student.goto(base + "/#" + new URLSearchParams(saved));
    await student
      .getByLabel("Your name or student ID")
      .fill("Student " + (direct ? "direct" : "HTTPS"));
    await student.getByRole("button", { name: "Request connection" }).click();
    await desk
      .getByRole("button", { name: "Approve", exact: true })
      .click({ timeout: 20000 });
    const name = direct ? "direct.pdf" : "recovery.pdf";
    let relayUploads = 0;
    if (direct) {
      await student
        .getByText("Direct + HTTPS recovery", { exact: true })
        .waitFor({ timeout: 30000 });
      console.log("PASS real direct data channel negotiated");
      await student.route("**/chunks/*", async (route) => {
        if (route.request().method() === "PUT") relayUploads++;
        await route.continue();
      });
    }
    let lostAck = false;
    if (!direct)
      await desk.route("**/ack", async (route) => {
        if (!lostAck) {
          lostAck = true;
          await route.fetch();
          await route.abort();
        } else await route.continue();
      });
    await student
      .locator("#files")
      .setInputFiles({ name, mimeType: "application/pdf", buffer: payload });
    if (!direct) {
      await desk.waitForFunction(
        () => document.querySelector("progress")?.value >= 2,
        {},
        { timeout: 30000 },
      );
      await studentContext.setOffline(true);
      await desk.reload();
      await student.reload().catch(() => {});
      await studentContext.setOffline(false);
      await student.goto(base);
    } else {
      await desk.waitForFunction(
        () => document.querySelector("progress")?.value >= 2,
        {},
        { timeout: 30000 },
      );
      await desk.evaluate(() =>
        window.testConnections.forEach((pc) => pc.close()),
      );
    }
    await waitReceipt(student, name);
    await waitReceipt(desk, name);
    assert.equal(await localDigest(desk, name), digest);
    console.log(
      "PASS " +
        (direct ? "direct-capable" : "RTC-blocked HTTPS") +
        " transfer, durable receipt and exact bytes" +
        (!direct
          ? " after refresh, offline interruption and lost acknowledgement"
          : ""),
    );
    if (!direct) assert.equal(lostAck, true);
    if (direct) {
      assert.ok(
        relayUploads > 0 && relayUploads < 16,
        "Expected direct chunks followed by HTTPS fallback after closing the data channel.",
      );
      console.log(
        "PASS direct channel failure resumes the same file over HTTPS",
      );
      const approved = await desk
        .locator("#recipient option")
        .nth(1)
        .getAttribute("value");
      await desk.locator("#recipient").selectOption(approved);
      await desk
        .locator("#files")
        .setInputFiles({
          name: "returned.pdf",
          mimeType: "application/pdf",
          buffer: payload,
        });
      await waitReceipt(student, "returned.pdf");
      assert.equal(await localDigest(student, "returned.pdf"), digest);
      console.log("PASS desk-to-student transfer");
    }
    await desk.reload();
    assert.equal(await localDigest(desk, name), digest);
    console.log("PASS completed file survives receiver refresh");
    await mkdir("test-results", { recursive: true });
    await desk.screenshot({
      path: "test-results/desk-" + (direct ? "direct" : "https") + ".png",
      fullPage: true,
    });
    await student.screenshot({
      path: "test-results/student-" + (direct ? "direct" : "https") + ".png",
      fullPage: true,
    });
    desk.once("dialog", (dialog) => dialog.accept());
    await desk.getByRole("button", { name: "End desk session" }).click();
    await desk.getByRole("heading", { name: "Saved on this device" }).waitFor();
    assert.equal(await localDigest(desk, name), digest);
    console.log("PASS ending session preserves saved documents");
    for (const ctx of contexts.splice(0)) await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS no browser exceptions");
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
