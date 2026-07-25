import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { runMigrations } from "../server/db/migrate.js";
import { createJobRepository } from "../server/repositories/jobRepository.js";
import { createAccountLimitService } from "../server/services/accountLimitService.js";
import {
  createProcessSecretStore,
  createRedeemService
} from "../server/services/redeemService.js";

async function createHarness() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  const repository = createJobRepository(pool);
  const accountLimitService = createAccountLimitService(pool);
  const service = createRedeemService({
    repository,
    accountLimitService,
    secretStore: createProcessSecretStore(),
    hashKey: "idempotency-test-key",
    executeRedeem: async () => ({ status: 200, body: { ok: true, items: [] } })
  });
  return { pool, repository, service };
}

function jobInput({ cdkey = "CDK-ONE", email = "user@example.com" } = {}) {
  return {
    apiKey: "api-secret",
    items: [{ cdkey, email, access_token: `token-${email}`, channel: "upi" }]
  };
}

test("same idempotency key returns one job and one reserved attempt", async () => {
  const { pool, service } = await createHarness();
  const first = await service.createJob(jobInput(), { idempotencyKey: "same-request" });
  const replay = await service.createJob(jobInput(), { idempotencyKey: "same-request" });
  assert.equal(replay.id, first.id);

  const jobs = await pool.query("SELECT COUNT(*)::int AS count FROM redeem_jobs");
  const attempts = await pool.query("SELECT COUNT(*)::int AS count FROM redeem_attempts");
  const limits = await pool.query("SELECT attempt_count FROM account_limits");
  const keys = await pool.query("SELECT key_hash FROM idempotency_keys");
  assert.equal(jobs.rows[0].count, 1);
  assert.equal(attempts.rows[0].count, 1);
  assert.equal(limits.rows[0].attempt_count, 1);
  assert.equal(keys.rows[0].key_hash.length, 64);
  assert.notEqual(keys.rows[0].key_hash, "same-request");
  await pool.end();
});

test("same idempotency key with a different request is rejected", async () => {
  const { pool, service } = await createHarness();
  await service.createJob(jobInput(), { idempotencyKey: "conflicting-request" });
  await assert.rejects(
    () => service.createJob(jobInput({ cdkey: "CDK-TWO" }), { idempotencyKey: "conflicting-request" }),
    (error) => error?.code === "IDEMPOTENCY_CONFLICT"
  );
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM redeem_jobs")).rows[0].count, 1);
  await pool.end();
});

test("active CDK uniqueness rolls back the losing job and account reservation", async () => {
  const { pool, service } = await createHarness();
  await service.createJob(jobInput(), { idempotencyKey: "first-cdk" });
  await assert.rejects(
    () => service.createJob(
      jobInput({ email: "other@example.com" }),
      { idempotencyKey: "duplicate-cdk" }
    ),
    (error) => error?.code === "ACTIVE_CDK_EXISTS"
  );
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM redeem_jobs")).rows[0].count, 1);
  const limits = await pool.query("SELECT account_hash, attempt_count FROM account_limits");
  assert.equal(limits.rowCount, 1);
  assert.equal(limits.rows[0].attempt_count, 1);
  await pool.end();
});

test("a fourth job for the same account is blocked without partial records", async () => {
  const { pool, service } = await createHarness();
  for (let index = 1; index <= 3; index += 1) {
    await service.createJob(
      jobInput({ cdkey: `CDK-${index}` }),
      { idempotencyKey: `attempt-${index}` }
    );
  }
  await assert.rejects(
    () => service.createJob(jobInput({ cdkey: "CDK-4" }), { idempotencyKey: "attempt-4" }),
    (error) => error?.code === "ACCOUNT_ATTEMPT_LIMIT"
  );
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM redeem_jobs")).rows[0].count, 3);
  assert.equal((await pool.query("SELECT attempt_count FROM account_limits")).rows[0].attempt_count, 3);
  await pool.end();
});

test("cancelling releases the active CDK and retry appends a new reserved attempt", async () => {
  const { pool, service } = await createHarness();
  const created = await service.createJob(jobInput(), { idempotencyKey: "cancel-retry" });
  await service.cancelJob(created.id);
  assert.deepEqual(
    (await pool.query("SELECT status FROM redeem_attempts ORDER BY attempt_number")).rows,
    [{ status: "cancelled" }]
  );

  await service.retryJob(created.id);
  assert.deepEqual(
    (await pool.query("SELECT status FROM redeem_attempts ORDER BY attempt_number")).rows,
    [{ status: "cancelled" }, { status: "queued" }]
  );
  assert.equal((await pool.query("SELECT attempt_count FROM account_limits")).rows[0].attempt_count, 2);
  await pool.end();
});
