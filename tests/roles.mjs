import { chromium } from "playwright";
import { login, cleanupAuthFixtures } from "./auth-helper.mjs";
import { readFile } from "node:fs/promises";
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
  await page.getByLabel("Desk name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Open desk" }).click();
  await page.getByRole("button", { name: "Copy invitation link" }).waitFor();
  const saved = await page.evaluate(async () => {
    const db = await import("/storage.js");
    const s = await db.get(
      "sessions",
      sessionStorage.getItem("exchange-session"),
    );
    const { fingerprint } = await import("/crypto.js");
    return {
      owner: { room: s.room, token: s.token },
      invite: {
        room: s.room,
        invite: s.invite,
        key: await fingerprint(s.publicKey),
      },
    };
  });
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
  await desk.getByRole("button", { name: "End desk session" }).waitFor();
  await desk
    .getByRole("heading", { name: "First desk", exact: true })
    .waitFor();
  await guest.reload();
  await guest.getByText("Your student connection", { exact: true }).waitFor();
  await guest
    .getByRole("heading", { name: "Other desk", exact: true })
    .waitFor();
  console.log(
    "PASS separate tabs retain their own desk and student roles after refresh",
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
