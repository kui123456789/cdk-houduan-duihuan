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
import { createRedeemWorker } from "../server/workers/redeemWorker.js";

function createRepository(job) {
  const calls = [];
  const state = structuredClone(job);
  let claimed = false;
  return {
    calls,
    state,
    async recoverExpiredLeases() {
      calls.push(["recover"]);
      return 0;
    },
    async claimNextJob({ workerId }) {
      calls.push(["claim", workerId]);
      if (claimed) return null;
      claimed = true;
      state.status = "running";
      state.leaseOwner = workerId;
      return structuredClone(state);
    },
    async heartbeatJob(jobId, workerId) {
      calls.push(["heartbeat", jobId, workerId]);
      return true;
    },
    async getJob() {
      return structuredClone(state);
    },
    async createAttempt(input) {
      calls.push(["attempt", input]);
      return { id: `attempt-${input.itemId}`, attemptNumber: 1, ...input };
    },
    async completeAttempt(attemptId, input) {
      calls.push(["complete-attempt", attemptId, input]);
      return { id: attemptId, ...input };
    },
    async updateItem(itemId, input) {
      calls.push(["item", itemId, input]);
      const item = state.items.find((candidate) => candidate.id === itemId);
      Object.assign(item, input);
      return structuredClone(item);
    },
    async updateJobStatus(jobId, input) {
      calls.push(["job", jobId, input]);
      Object.assign(state, input);
      return structuredClone(state);
    },
    async appendEvent(input) {
      calls.push(["event", input]);
      return input;
    }
  };
}

function queuedJob() {
  return {
    id: "job-1",
    status: "queued",
    items: [
      { id: "item-1", status: "queued", cdkeyHash: "hash-1" },
      { id: "item-2", status: "queued", cdkeyHash: "hash-2" }
    ]
  };
}

test("worker claims one leased job and records every processing step", async () => {
  const repository = createRepository(queuedJob());
  const processed = [];
  const worker = createRedeemWorker({
    repository,
    workerId: "worker-a",
    heartbeatMs: 5,
    processItem: async ({ item }) => {
      processed.push(item.id);
      return { status: "succeeded", result: { upstreamStatus: "queued" } };
    }
  });

  const result = await worker.runOnce();
  assert.equal(result.status, "completed");
  assert.deepEqual(processed, ["item-1", "item-2"]);
  assert.equal(repository.state.status, "completed");
  assert.deepEqual(repository.state.items.map((item) => item.status), ["succeeded", "succeeded"]);
  const eventTypes = repository.calls
    .filter(([type]) => type === "event")
    .map(([, event]) => event.type);
  assert.deepEqual(eventTypes, [
    "job_started",
    "attempt_started",
    "item_succeeded",
    "attempt_started",
    "item_succeeded",
    "job_completed"
  ]);
});

test("worker observes server cancellation and does not process remaining items", async () => {
  const repository = createRepository(queuedJob());
  let processed = 0;
  const worker = createRedeemWorker({
    repository,
    workerId: "worker-b",
    processItem: async () => {
      processed += 1;
      repository.state.cancelRequestedAt = new Date().toISOString();
      return { status: "succeeded", result: {} };
    }
  });

  const result = await worker.runOnce();
  assert.equal(processed, 1);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(repository.state.items.map((item) => item.status), ["succeeded", "cancelled"]);
  assert.ok(repository.calls.some(([, event]) => event?.type === "job_cancelled"));
});

test("worker records item failures and completes the job as failed", async () => {
  const repository = createRepository({ ...queuedJob(), items: [queuedJob().items[0]] });
  const worker = createRedeemWorker({
    repository,
    processItem: async () => {
      const error = new Error("upstream failed");
      error.code = "UPSTREAM_FAILED";
      throw error;
    }
  });

  const result = await worker.runOnce();
  assert.equal(result.status, "failed");
  assert.equal(repository.state.items[0].status, "failed");
  const failure = repository.calls.find(([, event]) => event?.type === "item_failed")?.[1];
  assert.equal(failure.payload.errorCode, "UPSTREAM_FAILED");
  assert.doesNotMatch(JSON.stringify(failure), /upstream failed/);
});

test("worker starts the attempt reserved at submission instead of creating a duplicate", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  const repository = createJobRepository(pool);
  const service = createRedeemService({
    repository,
    accountLimitService: createAccountLimitService(pool),
    secretStore: createProcessSecretStore(),
    hashKey: "worker-integration-key",
    executeRedeem: async () => ({ status: 200, body: { ok: true, items: [] } })
  });
  const job = await service.createJob({
    apiKey: "api-key",
    items: [{
      cdkey: "CDK-WORKER",
      email: "worker@example.com",
      access_token: "worker-token",
      channel: "upi"
    }]
  }, { idempotencyKey: "worker-job" });
  await repository.updateJobStatus(job.id, {
    status: "running",
    leaseOwner: "integration-worker",
    leaseExpiresAt: new Date(Date.now() + 30_000)
  });
  let claimed = false;
  const workerRepository = {
    ...repository,
    async recoverExpiredLeases() { return 0; },
    async claimNextJob() {
      if (claimed) return null;
      claimed = true;
      return repository.getJob(job.id);
    }
  };
  const worker = createRedeemWorker({
    repository: workerRepository,
    workerId: "integration-worker",
    processItem: async () => ({ status: "succeeded", result: { upstreamStatus: "queued" } })
  });

  const completed = await worker.runOnce();
  assert.equal(completed.id, job.id);
  assert.equal(completed.status, "completed");
  const attempts = await pool.query(
    "SELECT attempt_number, status FROM redeem_attempts ORDER BY attempt_number"
  );
  assert.deepEqual(attempts.rows, [{ attempt_number: 1, status: "completed" }]);
  await pool.end();
});
