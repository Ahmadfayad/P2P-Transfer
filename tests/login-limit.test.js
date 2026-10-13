import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TransferHub } from "../server/worker.js";
test("login limits are atomic per account so one account cannot block a university NAT", async () => {
  const database = new DatabaseSync(":memory:");
  const hub = new TransferHub(
    {
      storage: {
        setAlarm: async () => {},
        sql: {
          exec(query, ...values) {
            if (!values.length && query.includes(";")) {
              database.exec(query);
              return [];
            }
            return database.prepare(query).all(...values);
          },
        },
      },
    },
    {},
  );
  const login = (email) =>
    hub.fetch(
      new Request("https://internal/login-limit", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    );
  const requests = await Promise.all(
    Array.from({ length: 11 }, () => login("first@example.com")),
  );
  assert.equal(requests.filter((r) => r.status === 200).length, 10);
  assert.equal(requests.filter((r) => r.status === 429).length, 1);
  assert.equal((await login("second@example.com")).status, 200);
  database.close();
});
