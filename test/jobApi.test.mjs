import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/app.js";
import {
  createProcessSecretStore,
  createRedeemService
} from "../server/services/redeemService.js";

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createService() {
  const calls = [];
  const job = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "queued",
    items: [{ id: "item-1", status: "queued", cdkey: "CDK-1" }]
  };
  return {
    calls,
    async createJob(input, context) {
      calls.push(["create", input, context]);
      return job;
    },
    async getJob(jobId) {
      calls.push(["get", jobId]);
      return jobId === job.id ? job : null;
    },
    async listEvents(jobId, options) {
      calls.push(["events", jobId, options]);
      return [{ sequence: 2, type: "attempt_started" }];
    },
    async cancelJob(jobId, context) {
      calls.push(["cancel", jobId, context]);
      return { ...job, status: "cancel_requested" };
    },
    async retryJob(jobId, context) {
      calls.push(["retry", jobId, context]);
      return { ...job, status: "queued" };
    }
  };
}

test("Job API creates, reads, lists events, cancels and retries jobs", async () => {
  const jobService = createService();
  const app = createApp({ config: { nodeEnv: "test" }, jobService });

  await withServer(app, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "request-1" },
      body: JSON.stringify({
        apiKey: "shared-secret",
        items: [{ cdkey: "CDK-1", access_token: "access-secret", channel: "upi" }]
      })
    });
    assert.equal(created.status, 202);
    assert.equal((await created.json()).job.id, "00000000-0000-4000-8000-000000000001");
    assert.equal(jobService.calls[0][2].idempotencyKey, "request-1");

    const fetched = await fetch(`${baseUrl}/api/jobs/00000000-0000-4000-8000-000000000001`);
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).job.status, "queued");

    const events = await fetch(
      `${baseUrl}/api/jobs/00000000-0000-4000-8000-000000000001/events?after=1&limit=25`
    );
    assert.equal(events.status, 200);
    assert.deepEqual((await events.json()).events, [{ sequence: 2, type: "attempt_started" }]);

    const cancelled = await fetch(
      `${baseUrl}/api/jobs/00000000-0000-4000-8000-000000000001/cancel`,
      { method: "POST" }
    );
    assert.equal(cancelled.status, 202);
    assert.equal((await cancelled.json()).job.status, "cancel_requested");

    const retried = await fetch(
      `${baseUrl}/api/jobs/00000000-0000-4000-8000-000000000001/retry`,
      { method: "POST" }
    );
    assert.equal(retried.status, 202);
    assert.equal((await retried.json()).job.status, "queued");
  });
});

test("Job API returns bounded public errors and 404 for missing jobs", async () => {
  const jobService = createService();
  jobService.createJob = async () => {
    const error = new Error("invalid access_token must not leak");
    error.status = 400;
    error.code = "INVALID_JOB";
    throw error;
  };
  const app = createApp({ config: { nodeEnv: "test" }, jobService });

  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/jobs/00000000-0000-4000-8000-000000000099`);
    assert.equal(missing.status, 404);

    const failed = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] })
    });
    assert.equal(failed.status, 400);
    const payload = await failed.json();
    assert.equal(payload.code, "INVALID_JOB");
    assert.doesNotMatch(JSON.stringify(payload), /access_token/i);
  });
});

test("redeem service persists only fingerprints and secret references", async () => {
  let persisted;
  let forwarded;
  const repository = {
    async createJob(input) {
      persisted = input;
      return { id: "job-secret", status: "queued", ...input };
    }
  };
  const service = createRedeemService({
    repository,
    secretStore: createProcessSecretStore(),
    hashKey: "test-hash-key",
    executeRedeem: async (request) => {
      forwarded = request;
      return {
        status: 200,
        body: { ok: true, items: [{ cdkey: "CDK-SECRET", status: "success" }] }
      };
    }
  });

  const job = await service.createJob({
    apiKey: "api-secret",
    items: [{ cdkey: "CDK-SECRET", access_token: "token-secret", channel: "upi" }]
  });
  assert.equal(job.items[0].secretRef, undefined);
  assert.equal(job.items[0].tokenHash, undefined);
  assert.equal(persisted.items[0].tokenHash.length, 64);
  assert.equal(persisted.items[0].cdkeyHash.length, 64);
  assert.doesNotMatch(JSON.stringify(persisted), /api-secret|token-secret/);

  await service.processItem({
    job: { id: "job-secret" },
    item: persisted.items[0],
    attempt: { id: "attempt-secret" }
  });
  assert.equal(forwarded.body.apiKey, "api-secret");
  assert.equal(forwarded.body.items[0].access_token, "token-secret");
});
