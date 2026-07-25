import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { withTransaction } from "../server/db/index.js";
import { runMigrations } from "../server/db/migrate.js";
import { createAccountLimitService } from "../server/services/accountLimitService.js";

async function createHarness() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  return { pool, service: createAccountLimitService(pool) };
}

test("server account limit allows three attempts in 24 hours and blocks the fourth", async () => {
  const { pool, service } = await createHarness();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const limit = await withTransaction(pool, (client) =>
      service.reserveAttempt(client, "account-hash")
    );
    assert.equal(limit.attemptCount, attempt);
  }

  await assert.rejects(
    () => withTransaction(pool, (client) => service.reserveAttempt(client, "account-hash")),
    (error) => error?.code === "ACCOUNT_ATTEMPT_LIMIT" && error?.status === 429
  );
  const persisted = await service.getLimit("account-hash");
  assert.equal(persisted.attemptCount, 3);
  await pool.end();
});

test("third failed attempt starts a database-timed cooldown and an expired window resets", async () => {
  const { pool, service } = await createHarness();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await withTransaction(pool, (client) => service.reserveAttempt(client, "cooldown-hash"));
  }
  const cooled = await service.recordFailure("cooldown-hash", { reason: "attempt_limit" });
  assert.equal(cooled.attemptCount, 3);
  assert.ok(new Date(cooled.cooldownUntil).getTime() > Date.now() + 23 * 60 * 60 * 1000);

  await assert.rejects(
    () => withTransaction(pool, (client) => service.reserveAttempt(client, "cooldown-hash")),
    (error) => error?.code === "ACCOUNT_COOLDOWN"
  );
  await pool.query(
    `UPDATE account_limits
     SET window_started_at = CURRENT_TIMESTAMP - INTERVAL '25 hours',
         cooldown_until = CURRENT_TIMESTAMP - INTERVAL '1 hour'`
  );
  const reset = await withTransaction(pool, (client) =>
    service.reserveAttempt(client, "cooldown-hash")
  );
  assert.equal(reset.attemptCount, 1);
  assert.equal(reset.cooldownUntil, null);
  await pool.end();
});

test("account reservations lock the server row before checking the limit", async () => {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      if (text.includes("INSERT INTO account_limits")) return { rowCount: 1, rows: [] };
      if (text.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            account_hash: "locked-account",
            attempt_count: 0,
            window_started_at: null,
            cooldown_until: null,
            server_now: new Date()
          }]
        };
      }
      if (text.includes("UPDATE account_limits")) {
        return {
          rowCount: 1,
          rows: [{ account_hash: "locked-account", attempt_count: 1 }]
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  };
  const service = createAccountLimitService({ query() {} });
  await service.reserveAttempt(client, "locked-account");
  assert.ok(queries.some((query) => /SELECT[\s\S]+FOR UPDATE/.test(query)));
});
