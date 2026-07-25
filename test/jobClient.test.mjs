import assert from "node:assert/strict";
import test from "node:test";
import {
  JOB_IDS_STORAGE_KEY,
  clearLegacyWorkflowStorageForJobMode,
  createJobApi,
  jobsToProxyPayload,
  mergeJobRows,
  readJobIds,
  writeJobIds
} from "../src/services/jobApi.js";
import { hasActiveJobs, shouldRefreshForStorageEvent } from "../src/hooks/useJobs.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

test("job storage contains IDs only and job mode removes legacy workflow data", () => {
  const storage = memoryStorage({
    "cdkRedeem.apiKey": "fake-key",
    "cdkRedeem.workflowSnapshot.v1": JSON.stringify({ accessToken: "fake-token" }),
    "cdkRedeem.uiSettings": "{}"
  });
  writeJobIds(storage, ["job-1", "job-1", "job-2"]);
  clearLegacyWorkflowStorageForJobMode(storage);

  assert.deepEqual(readJobIds(storage), ["job-1", "job-2"]);
  assert.equal(storage.getItem("cdkRedeem.apiKey"), null);
  assert.equal(storage.getItem("cdkRedeem.workflowSnapshot.v1"), null);
  assert.equal(storage.getItem("cdkRedeem.uiSettings"), "{}");
  assert.doesNotMatch([...storage.values.values()].join("\n"), /fake-key|fake-token/);
});

test("job client submits an idempotency key and remembers the returned Job ID", async () => {
  const storage = memoryStorage();
  let request;
  const api = createJobApi({
    storage,
    fetchImpl: async (path, options) => {
      request = { path, options };
      return { ok: true, json: async () => ({ job: { id: "job-created", items: [] } }) };
    }
  });

  await api.createJob({ apiKey: "fake-api-key", items: [] }, { idempotencyKey: "idem-1" });
  assert.equal(request.path, "/api/jobs");
  assert.equal(request.options.headers["Idempotency-Key"], "idem-1");
  assert.deepEqual(JSON.parse(storage.getItem(JOB_IDS_STORAGE_KEY)), ["job-created"]);
  assert.doesNotMatch(storage.getItem(JOB_IDS_STORAGE_KEY), /fake-api-key/);
});

test("server Jobs reconstruct and merge task rows without losing in-memory export data", () => {
  const jobs = [{
    id: "job-1",
    status: "completed",
    items: [{ id: "item-1", cdkey: "CDK-1", channel: "upi", status: "succeeded", result: { status: "success" } }]
  }];
  const payload = jobsToProxyPayload(jobs);
  assert.equal(payload.items[0].status, "success");
  assert.equal(payload.items[0].jobId, "job-1");

  const merged = mergeJobRows([{ id: "local-1", cdkey: "CDK-1", email: "user@example.com", selected: true }], jobs);
  assert.equal(merged[0].id, "local-1");
  assert.equal(merged[0].email, "user@example.com");
  assert.equal(merged[0].jobItemId, "item-1");
  assert.equal(merged[0].selected, true);
});

test("job client maps selected CDKs to owning cancel and retry endpoints", async () => {
  const storage = memoryStorage({ [JOB_IDS_STORAGE_KEY]: JSON.stringify(["job-action"]) });
  const paths = [];
  const api = createJobApi({
    storage,
    fetchImpl: async (path) => {
      paths.push(path);
      return {
        ok: true,
        json: async () => ({
          job: {
            id: "job-action",
            status: path.endsWith("/cancel") ? "cancelled" : "failed",
            items: [{ id: "item-action", cdkey: "CDK-ACTION", status: "failed" }]
          }
        })
      };
    }
  });

  await api.cancelByCdkeys(["CDK-ACTION"]);
  await api.retryByCdkeys(["CDK-ACTION"]);
  assert.deepEqual(paths, [
    "/api/jobs/job-action",
    "/api/jobs/job-action/cancel",
    "/api/jobs/job-action",
    "/api/jobs/job-action/retry"
  ]);
});

test("active-job and cross-tab storage helpers drive polling and synchronization", () => {
  assert.equal(hasActiveJobs([{ status: "running" }]), true);
  assert.equal(hasActiveJobs([{ status: "completed" }]), false);
  assert.equal(shouldRefreshForStorageEvent({ key: JOB_IDS_STORAGE_KEY }), true);
  assert.equal(shouldRefreshForStorageEvent({ key: "unrelated" }), false);
});
