import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { neon } from "@neondatabase/serverless";
import { NeonDialect } from "kysely-neon";
const instances = new WeakMap();

export function createAuth(env) {
  if (instances.has(env)) return instances.get(env);
  if (!env.DATABASE_URL || !env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL)
    throw new Error("Account service has not been configured.");
  const sql = neon(env.DATABASE_URL);
  async function passwordInput(password) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.BETTER_AUTH_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password)),
    );
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const auth = betterAuth({
    appName: "Document Exchange",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: (env.FRONTEND_ORIGINS || "").split(",").filter(Boolean),
    database: {
      dialect: new NeonDialect({ neon: sql }),
      type: "postgres",
      transaction: false,
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 6,
      maxPasswordLength: 128,
      // bcrypt runs in Postgres to keep expensive hashing within the free Worker's CPU limit.
      password: {
        hash: async (password) => {
          if (password.length < 6 || password.length > 128)
            throw new Error("Password must contain 6 to 128 characters.");
          const input = await passwordInput(password);
          const [row] =
            await sql`SELECT crypt(${input}, gen_salt('bf', 12)) AS hash`;
          return "bcrypt-hmac-v1:" + row.hash;
        },
        verify: async ({ hash, password }) => {
          if (!hash.startsWith("bcrypt-hmac-v1:") || password.length > 128)
            return false;
          const input = await passwordInput(password),
            stored = hash.slice(15);
          const [row] =
            await sql`SELECT crypt(${input}, ${stored}) = ${stored} AS valid`;
          return row.valid;
        },
      },
    },
    session: { expiresIn: 8 * 60 * 60, cookieCache: { enabled: false } },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [user] =
              await sql`SELECT role FROM "user" WHERE id = ${session.userId}`;
            if (!permittedRole(user?.role))
              throw new APIError("FORBIDDEN", {
                message:
                  "Employee accounts only. Students must use the desk QR code.",
              });
            return { data: session };
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 100 } },
    },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    plugins: [
      admin({
        defaultRole: "staff",
        roles: { admin: adminAc, staff: userAc },
      }),
    ],
  });
  instances.set(env, auth);
  return auth;
}

export function permittedRole(role) {
  return ["admin", "staff"].includes(role);
}
export const publicAuthPaths = new Set([
  "/sign-in/email",
  "/sign-out",
  "/get-session",
  "/change-password",
]);
