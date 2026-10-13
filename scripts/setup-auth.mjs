import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../server/auth.js";
import { neon } from "@neondatabase/serverless";
const vars = Object.fromEntries(
  readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
if (!vars.BETTER_AUTH_SECRET) {
  vars.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  appendFileSync(
    ".dev.vars",
    `\nBETTER_AUTH_SECRET=${vars.BETTER_AUTH_SECRET}\n`,
  );
}
if (!vars.BETTER_AUTH_URL) {
  vars.BETTER_AUTH_URL = "http://127.0.0.1:8788";
  appendFileSync(".dev.vars", `\nBETTER_AUTH_URL=${vars.BETTER_AUTH_URL}\n`);
}
const auth = createAuth(vars);
await neon(vars.DATABASE_URL)`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
const migration = await getMigrations(auth.options);
if (migration.toBeCreated.length || Object.keys(migration.toBeAdded).length)
  writeFileSync(
    "server/auth-schema.sql",
    "CREATE EXTENSION IF NOT EXISTS pgcrypto;\n\n" +
      (await migration.compileMigrations()),
  );
await migration.runMigrations();
console.log("Authentication schema ready.");
const email = process.env.ADMIN_EMAIL || "aalbalbissi@sharjah.ac.ae";
const existing = await (
  await auth.$context
).internalAdapter.findUserByEmail(email);
if (!existing) {
  const password = randomBytes(12).toString("base64url");
  await auth.api.createUser({
    body: { email, name: "Administrator", role: "admin", password },
  });
  writeFileSync(
    "../ADMIN-ACCESS-PRIVATE.txt",
    `Document Exchange administrator\nEmail: ${email}\nTemporary password: ${password}\nSign in at https://uos-document-exchange.uos-document-exchange.workers.dev and change your password. Keep this file private.\n`,
  );
  console.log(
    "Administrator created. Credentials saved in ADMIN-ACCESS-PRIVATE.txt outside Git.",
  );
} else console.log("Administrator already exists; password unchanged.");
