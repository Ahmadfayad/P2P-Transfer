export const credentials = {
  staff: { email: "staff@fixture.invalid", password: "fixture-only" },
  admin: { email: "admin@fixture.invalid", password: "fixture-only" },
};
export const testHeaders = (base) => ({ Origin: base });
export async function login(page, base, key = "staff") {
  const response = await page.request.post(base + "/api/auth/sign-in/email", {
    data: credentials[key],
  });
  if (!response.ok()) throw new Error("Loopback fixture sign-in failed");
}
export async function cleanupAuthFixtures() {}
