import { chromium, firefox, webkit } from "playwright";
import assert from "node:assert/strict";
const engine = process.env.BROWSER || "chromium";
const browser = await { chromium, firefox, webkit }[engine].launch({
  headless: true,
  ...(engine === "chromium"
    ? {
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      }
    : {}),
});
import { pdfFixture } from "./pdf-fixture.mjs";
const pdf = pdfFixture();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:8788/student");
  await page.evaluate(async (text) => {
    const { openPDF } = await import("/pdf-preview.js");
    document.querySelector("#preview").showModal();
    await openPDF(
      new Blob([text], { type: "application/pdf" }),
      document.querySelector("#preview-content"),
    );
  }, pdf);
  await page.waitForFunction(() =>
    document.querySelector("canvas[data-rendered='1']"),
  );
  assert.equal(
    await page.evaluate(() => {
      const c = document.querySelector("canvas[data-rendered]");
      return c
        .getContext("2d")
        .getImageData(0, 0, c.width, c.height)
        .data.some((value, i) => i % 4 !== 3 && value < 100);
    }),
    true,
  );
  assert.match(
    await page.locator("#preview-content .visually-hidden").textContent(),
    /Phone preview works/,
  );
  await page.getByRole("button", { name: "Next page" }).click();
  await page.waitForFunction(() =>
    document.querySelector("canvas[data-rendered='2']"),
  );
  await page.getByRole("button", { name: "Previous page" }).click();
  await page.waitForFunction(() =>
    document.querySelector("canvas[data-rendered='1']"),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: "test-results/mobile-pdf-" + engine + ".png" });
  await page.getByRole("button", { name: "Close preview" }).click();
  await page.waitForFunction(
    () => !document.querySelector("#preview-content canvas"),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS two-page phone PDF canvas, page navigation, visible text and cleanup: " +
      engine,
  );
} finally {
  await browser.close();
}
