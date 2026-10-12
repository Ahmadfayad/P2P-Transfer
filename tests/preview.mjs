import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { login, cleanupAuthFixtures } from "./auth-helper.mjs";
const base = process.env.TEST_URL || "http://127.0.0.1:8787";
let pdf = "%PDF-1.4\n";
const offsets = [0];
const stream = "BT /F1 20 Tf 50 750 Td (Document preview works) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += i + 1 + " 0 obj\n" + objects[i] + "\nendobj\n";
}
const xref = Buffer.byteLength(pdf);
pdf +=
  "xref\n0 6\n0000000000 65535 f \n" +
  offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("") +
  "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
  xref +
  "\n%%EOF\n";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, base);
  await page.goto(base);
  await page.getByRole("button", { name: "Open desk" }).waitFor();
  await page.evaluate(async (pdf) => {
    const db = await import("/storage.js");
    for (const [name, text, mime] of [
      ["preview.pdf", pdf, "application/pdf"],
      [
        "fake.pdf",
        "%PDF-1.7\n<html><script>parent.previewAttack=true</script></html>",
        "text/html",
      ],
    ]) {
      const blob = new Blob([text], { type: mime });
      await db.put("files", {
        id: crypto.randomUUID(),
        room: crypto.randomUUID(),
        kind: "incoming",
        from: "desk",
        to: "test",
        name,
        size: blob.size,
        blob,
        created: Date.now(),
        completed: Date.now(),
      });
    }
  }, pdf);
  await page.reload();
  const row = (name) =>
    page
      .locator(".file")
      .filter({ has: page.getByText(name, { exact: true }) });
  await row("preview.pdf")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("#preview-content iframe")?.contentDocument
        ?.contentType === "application/pdf",
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/pdf-preview.png",
    fullPage: true,
  });
  console.log("PASS valid PDF loads the native PDF viewer");
  await page.getByRole("button", { name: "Close preview" }).click();
  await row("fake.pdf")
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("#preview-content iframe")?.contentDocument
        ?.contentType === "application/pdf",
  );
  assert.equal(await page.evaluate(() => window.previewAttack), undefined);
  console.log(
    "PASS HTML content and a false MIME claim cannot execute in PDF preview",
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await cleanupAuthFixtures();
}
