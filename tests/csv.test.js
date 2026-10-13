import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsersCSV } from "../public/user-csv.js";
import { permittedRole, publicAuthPaths } from "../server/auth.js";
test("CSV import handles quoted commas, CRLF, BOM and six-character passwords", () => {
  const [user] = parseUsersCSV(
    '\uFEFFemail,name,role,password\r\nUSER@example.com,"Name, \"\"quoted\"\"",staff,Ab9!xy\r\n',
  );
  assert.equal(user.email, "user@example.com");
  assert.equal(user.name, 'Name, "quoted"');
  assert.equal(user.password.length, 6);
});
test("CSV import validates the entire file before creating accounts", () => {
  const header = "email,name,role,password\n";
  for (const row of [
    "bad,name,staff,123456",
    "a@example.com,name,owner,123456",
    "a@example.com,name,student,123456",
    "a@example.com,name,staff,12345",
    'a@example.com,"unclosed,staff,123456',
    'a@example.com,"closed"junk,staff,123456',
    "a@example.com,name,staff,123456,extra",
  ])
    assert.throws(() => parseUsersCSV(header + row));
  assert.throws(() =>
    parseUsersCSV(
      header +
        "a@example.com,Name,staff,123456\nA@example.com,Name,staff,123456",
    ),
  );
  assert.throws(() =>
    parseUsersCSV(
      header +
        Array.from(
          { length: 201 },
          (_, i) => `a${i}@example.com,Name,staff,123456`,
        ).join("\n"),
    ),
  );
});
test("only explicit account routes and roles are allowed", () => {
  assert.equal(publicAuthPaths.has("/sign-up/email"), false);
  assert.equal(publicAuthPaths.has("/admin/create-user"), false);
  assert.equal(permittedRole("admin,student"), false);
  assert.equal(permittedRole("student"), false);
});
