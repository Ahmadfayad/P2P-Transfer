import { chromium } from "playwright";
import { login, cleanupAuthFixtures } from "./auth-helper.mjs";
const base = process.env.TEST_URL || "http://127.0.0.1:8787";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
const rooms = [];
async function openDesk(page, name) {
  await login(page, base, name === "Other desk" ? "otherStaff" : "staff");
  await page.goto(base);
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/rooms") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Open desk" }).click();
  const room = await (await created).json();
  await page.getByRole("button", { name: "Copy invitation link" }).waitFor();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (value) => {
      window.testLink = value;
    };
  });
  await page.getByRole("button", { name: "Copy invitation link" }).click();
  const link = await page.evaluate(() => window.testLink);
  const saved = {
    owner: { room: room.id, token: room.token },
    invite: Object.fromEntries(
      new URLSearchParams(new URL(link).hash.slice(1)),
    ),
  };
  rooms.push(saved.owner);
  saved.owner.request = page.request;
  return saved.invite;
}
try {
  const first = await browser.newContext(),
    second = await browser.newContext();
  const desk = await first.newPage(),
    otherDesk = await second.newPage();
  const own = await openDesk(desk, "First desk"),
    other = await openDesk(otherDesk, "Other desk");
  const guest = await first.newPage();
  await guest.goto(base + "/#" + new URLSearchParams(other));
  await guest.locator("#student-name").fill("Guest");
  await guest.getByRole("button", { name: "Request connection" }).click();
  await guest
    .getByRole("heading", { name: "Waiting for staff approval" })
    .waitFor();
  await otherDesk.locator("#approval-approve").click({ timeout: 20000 });
  await guest.getByText("Your student connection", { exact: true }).waitFor();
  await desk.reload();
  await desk.getByRole("button", { name: "Open desk" }).waitFor();
  await guest.reload();
  await guest.locator("#desk-link").waitFor();
  console.log(
    "PASS refresh preserves employee login but does not restore desk or guest sessions",
  );
  const ownGuest = await first.newPage();
  await ownGuest.goto(base + "/#" + new URLSearchParams(own));
  await ownGuest.locator("#student-name").fill("Own guest");
  await ownGuest.getByRole("button", { name: "Request connection" }).click();
  await ownGuest
    .locator("#student-error")
    .filter({
      hasText:
        "This browser owns this desk. Open its student invitation on a separate device or browser profile.",
    })
    .waitFor();
  console.log(
    "PASS joining a desk as its student cannot mix sender/receiver storage in the same profile",
  );
} finally {
  for (const room of rooms)
    await room.request
      .delete(base + "/api/rooms/" + room.room, {
        headers: { Authorization: "Bearer " + room.token },
      })
      .catch(() => {});
  await browser.close();
  await cleanupAuthFixtures();
}
