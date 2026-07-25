import assert from "node:assert/strict";
import test from "node:test";
import { createRedeemApi } from "../src/services/redeemApi.js";

test("callProxy sends API key and JSON body to local proxy", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "secret",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.queryStatuses(["A"]);
  assert.equal(request.path, "/api/redeem/status");
  assert.deepEqual(JSON.parse(request.options.body), { apiKey: "secret", cdkeys: ["A"] });
});

test("callProxy throws when API key is missing", async () => {
  const api = createRedeemApi({ getApiKey: () => "" });
  await assert.rejects(() => api.queryStatuses(["A"]), /请先填写外部 API Key/);
});

test("callProxy allows Session credential mode without a browser API key", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.callProxy(
    "/api/redeem/status",
    { cdkeys: ["A"] },
    { credentialMode: "session" }
  );

  assert.deepEqual(JSON.parse(request.options.body), {
    credentialMode: "session",
    cdkeys: ["A"]
  });
});

test("callProxy keeps a user API key when Session mode is requested", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "user-key",
    fetchImpl: async (_path, options) => {
      request = options;
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.callProxy(
    "/api/redeem/status",
    { cdkeys: ["A"] },
    { credentialMode: "session" }
  );

  assert.deepEqual(JSON.parse(request.body), {
    apiKey: "user-key",
    credentialMode: "session",
    cdkeys: ["A"]
  });
});

test("callProxy returns a partial batch payload instead of discarding successful results", async () => {
  const api = createRedeemApi({
    getApiKey: () => "user-key",
    fetchImpl: async () => ({
      ok: true,
      status: 207,
      json: async () => ({
        ok: false,
        partial: true,
        processedCount: 100,
        remainingCount: 1,
        items: [{ cdkey: "CDK-0", status: "queued" }]
      })
    })
  });

  const payload = await api.callProxy("/api/redeem/submit", { items: [{ cdkey: "CDK-0" }] });
  assert.equal(payload.partial, true);
  assert.equal(payload.items[0].cdkey, "CDK-0");
});

test("subscription check does not require external API key", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, category: "not_plus" })
      };
    }
  });

  await api.checkSubscription("token-1");
  assert.equal(request.path, "/api/subscription/check");
  assert.deepEqual(JSON.parse(request.options.body), { token: "token-1" });
});

test("email Plus check sends the pickup URL and redemption time without an API key", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, category: "verified" })
      };
    }
  });

  await api.checkPlusEmail("https://mail.example.com/inbox/code", "2026-07-23T10:00:00Z");
  assert.equal(request.path, "/api/subscription/email-check");
  assert.deepEqual(JSON.parse(request.options.body), {
    pickupUrl: "https://mail.example.com/inbox/code",
    redeemedAt: "2026-07-23T10:00:00Z"
  });
});

test("job mode submits through the Job API and reads server-owned status", async () => {
  const calls = [];
  const job = {
    id: "job-1",
    status: "running",
    items: [{ id: "item-1", cdkey: "CDK-1", channel: "upi", status: "running", result: {} }]
  };
  const jobApi = {
    async createJob(body) { calls.push(["create", body]); return job; },
    async listJobs() { calls.push(["list"]); return [job]; },
    async cancelByCdkeys(cdkeys) { calls.push(["cancel", cdkeys]); return [{ ...job, status: "cancelled" }]; },
    async retryByCdkeys(cdkeys) { calls.push(["retry", cdkeys]); return [{ ...job, status: "queued" }]; }
  };
  const api = createRedeemApi({ getApiKey: () => "fake-key", jobModeEnabled: true, jobApi });

  const submitted = await api.callProxy("/api/redeem/submit", {
    items: [{ cdkey: "CDK-1", access_token: "fake-token", channel: "upi" }]
  });
  const status = await api.queryStatuses(["CDK-1"]);
  await api.cancelJobs(["CDK-1"]);
  await api.retryJobs(["CDK-1"]);

  assert.equal(submitted.items[0].jobId, "job-1");
  assert.equal(status.items[0].status, "running");
  assert.deepEqual(calls.map(([name]) => name), ["create", "list", "cancel", "retry"]);
});
