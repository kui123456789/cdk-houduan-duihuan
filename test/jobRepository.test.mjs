import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { runMigrations } from "../server/db/migrate.js";
import { createJobRepository } from "../server/repositories/jobRepository.js";

async function createHarness() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  return { memory, pool, repository: createJobRepository(pool) };
}

test("jobs migration is repeatable and can be rolled back", async () => {
  const { pool } = await createHarness();
  await runMigrations(pool);

  const applied = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
  assert.deepEqual(applied.rows.map((row) => row.name), ["001_jobs.sql"]);

  for (const table of [
    "redeem_jobs",
    "redeem_job_items",
    "redeem_attempts",
    "redeem_events",
    "idempotency_keys",
    "account_limits"
  ]) {
    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [table]
    );
    assert.equal(result.rowCount, 1, `${table} should exist`);
  }

  await runMigrations(pool, { direction: "down" });
  const removed = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'redeem_jobs'"
  );
  assert.equal(removed.rowCount, 0);
  await pool.end();
});

test("repository creates and queries jobs, items, attempts, and append-only events", async () => {
  const { pool, repository } = await createHarness();
  const created = await repository.createJob({
    source: "test",
    credentialMode: "secret_ref",
    metadata: { pool: "ideal" },
    items: [
      {
        cdkey: "CDK-ONE",
        cdkeyHash: "cdk-hash-one",
        channel: "ideal",
        accountHash: "account-hash-one",
        tokenHash: "token-hash-one",
        secretRef: "secret://job/one"
      },
      {
        cdkey: "CDK-TWO",
        cdkeyHash: "cdk-hash-two",
        channel: "pix",
        accountHash: "account-hash-two",
        tokenHash: "token-hash-two",
        secretRef: "secret://job/two"
      }
    ]
  });

  assert.equal(created.status, "queued");
  assert.equal(created.items.length, 2);
  const firstItem = created.items[0];

  const firstAttempt = await repository.createAttempt({
    jobId: created.id,
    itemId: firstItem.id,
    status: "running",
    trigger: "initial",
    cdkeyHash: firstItem.cdkeyHash,
    accountHash: firstItem.accountHash,
    tokenHash: firstItem.tokenHash
  });
  await repository.completeAttempt(firstAttempt.id, {
    status: "failed",
    errorCode: "UPSTREAM_TIMEOUT",
    errorMessage: "upstream timed out"
  });
  const secondAttempt = await repository.createAttempt({
    jobId: created.id,
    itemId: firstItem.id,
    status: "running",
    trigger: "retry",
    cdkeyHash: firstItem.cdkeyHash,
    accountHash: firstItem.accountHash,
    tokenHash: firstItem.tokenHash
  });

  assert.equal(firstAttempt.attemptNumber, 1);
  assert.equal(secondAttempt.attemptNumber, 2);

  await repository.appendEvent({
    jobId: created.id,
    itemId: firstItem.id,
    attemptId: secondAttempt.id,
    type: "attempt_started",
    payload: { attemptNumber: 2 }
  });

  const job = await repository.getJob(created.id);
  const attempts = await repository.listAttempts(created.id);
  const events = await repository.listEvents(created.id);

  assert.equal(job.items.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.attemptNumber), [1, 2]);
  assert.deepEqual(events.map((event) => event.type), ["job_created", "attempt_started"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  await pool.end();
});

test("idempotency keys are unique within a scope", async () => {
  const { pool, repository } = await createHarness();
  const job = await repository.createJob({ items: [] });
  const input = {
    scope: "jobs:create",
    keyHash: "same-key-hash",
    requestHash: "same-request-hash",
    jobId: job.id
  };

  await repository.createIdempotencyKey(input);
  await assert.rejects(
    () => repository.createIdempotencyKey(input),
    (error) => error?.code === "23505"
  );
  await pool.end();
});

test("repository refuses raw credentials in persisted JSON", async () => {
  const { pool, repository } = await createHarness();

  await assert.rejects(
    () => repository.createJob({ metadata: { password: "must-not-persist" } }),
    (error) => error?.code === "SENSITIVE_DATA_REJECTED"
  );
  await assert.rejects(
    () => repository.createJob({ metadata: { nested: { accessToken: "must-not-persist" } } }),
    (error) => error?.code === "SENSITIVE_DATA_REJECTED"
  );

  const persisted = await pool.query("SELECT COUNT(*)::int AS count FROM redeem_jobs");
  assert.equal(persisted.rows[0].count, 0);
  await pool.end();
});
