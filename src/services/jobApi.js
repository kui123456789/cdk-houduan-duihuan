export const JOB_IDS_STORAGE_KEY = "cdkRedeem.jobIds.v1";
export const JOB_MODE_STORAGE_KEY = "cdkRedeem.jobModeEnabled";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const JOB_MODE_STORAGE_ALLOWLIST = new Set([
  JOB_IDS_STORAGE_KEY,
  JOB_MODE_STORAGE_KEY,
  "cdkRedeem.uiSettings"
]);

function normalizeJobId(value) {
  const id = String(value || "").trim();
  return id && id.length <= 128 ? id : "";
}

export function readJobIds(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(JOB_IDS_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(normalizeJobId).filter(Boolean))];
  } catch {
    return [];
  }
}

export function writeJobIds(storage, jobIds) {
  const normalized = [...new Set((jobIds || []).map(normalizeJobId).filter(Boolean))];
  try {
    storage?.setItem?.(JOB_IDS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Storage may be unavailable; the server job still continues.
  }
  return normalized;
}

export function rememberJobId(storage, jobId) {
  const id = normalizeJobId(jobId);
  if (!id) return readJobIds(storage);
  return writeJobIds(storage, [...readJobIds(storage), id]);
}

export function clearLegacyWorkflowStorageForJobMode(storage) {
  const keys = [];
  try {
    for (let index = 0; index < Number(storage?.length || 0); index += 1) {
      const key = storage.key(index);
      if (key?.startsWith("cdkRedeem.") && !JOB_MODE_STORAGE_ALLOWLIST.has(key)) keys.push(key);
    }
  } catch {
    return 0;
  }
  keys.forEach((key) => {
    try { storage.removeItem(key); } catch { /* keep clearing */ }
  });
  return keys.length;
}

export function isJobModeEnabled(storage, buildValue = import.meta.env?.VITE_JOB_MODE_ENABLED) {
  const normalizedBuildValue = String(buildValue || "").trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalizedBuildValue)) return true;
  try {
    return ["1", "true", "yes"].includes(
      String(storage?.getItem?.(JOB_MODE_STORAGE_KEY) || "").trim().toLowerCase()
    );
  } catch {
    return false;
  }
}

function mapJobStatus(job, item) {
  const itemStatus = String(item?.status || "").trim().toLowerCase();
  if (itemStatus === "succeeded") {
    const resultStatus = String(item?.result?.status || item?.result?.state || "").trim();
    return resultStatus || "success";
  }
  if (itemStatus === "failed") return String(item?.result?.status || "failed");
  if (itemStatus === "cancelled") return "cancelled";
  if (itemStatus === "running") return "running";
  if (String(job?.status || "") === "cancel_requested") return "running";
  return "queued";
}

export function mapJobItemToStatus(job, item) {
  const result = item?.result && typeof item.result === "object" ? item.result : {};
  const status = mapJobStatus(job, item);
  const active = !TERMINAL_JOB_STATUSES.has(String(job?.status || ""));
  const retryable = ["failed", "cancelled"].includes(String(job?.status || ""));
  return {
    ...result,
    id: `job-item-${item.id}`,
    jobId: job.id,
    jobItemId: item.id,
    cdkey: item.cdkey,
    channel: item.channel,
    status,
    reason: result.reason || result.message || item.errorCode || "",
    can_cancel: active,
    can_retry: retryable,
    can_reuse_token: retryable,
    found: true,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

export function jobsToProxyPayload(jobs, cdkeys = null) {
  const filter = Array.isArray(cdkeys)
    ? new Set(cdkeys.map((value) => String(value || "").trim()).filter(Boolean))
    : null;
  const items = (jobs || []).flatMap((job) =>
    (job?.items || [])
      .filter((item) => !filter || filter.has(String(item?.cdkey || "").trim()))
      .map((item) => mapJobItemToStatus(job, item))
  );
  return { ok: true, items, batchCount: jobs?.length || 0, jobs: jobs || [] };
}

export function mergeJobRows(rows, jobs) {
  const existing = Array.isArray(rows) ? rows : [];
  const incoming = jobsToProxyPayload(jobs).items;
  const byItemId = new Map(existing.map((row) => [String(row?.jobItemId || ""), row]));
  const byCdkey = new Map(existing.map((row) => [String(row?.cdkey || ""), row]));
  const incomingIds = new Set(incoming.map((row) => row.jobItemId));
  const merged = incoming.map((row) => {
    const current = byItemId.get(row.jobItemId) || byCdkey.get(row.cdkey) || {};
    return { ...current, ...row, id: current.id || row.id, selected: current.selected === true };
  });
  return [
    ...existing.filter((row) => row?.jobItemId && !incomingIds.has(row.jobItemId)),
    ...merged
  ];
}

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  const random = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `job-${Date.now()}-${random || Math.random().toString(16).slice(2)}`;
}

export function createJobApi({ fetchImpl = fetch, storage = globalThis.localStorage } = {}) {
  async function requestJson(path, options = {}) {
    const response = await fetchImpl(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.headers || {}) },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `请求失败：${response.status}`);
    return payload;
  }

  async function createJob(input, options = {}) {
    const payload = await requestJson("/api/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey || createIdempotencyKey()
      },
      body: JSON.stringify(input)
    });
    if (payload.job?.id) rememberJobId(storage, payload.job.id);
    return payload.job;
  }

  async function getJob(jobId) {
    const payload = await requestJson(`/api/jobs/${encodeURIComponent(jobId)}`);
    return payload.job;
  }

  async function listJobs() {
    const ids = readJobIds(storage);
    const results = await Promise.allSettled(ids.map((id) => getJob(id)));
    return results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  }

  async function getEvents(jobId, after = 0) {
    const payload = await requestJson(
      `/api/jobs/${encodeURIComponent(jobId)}/events?after=${encodeURIComponent(after)}`
    );
    return payload.events || [];
  }

  async function mutate(jobId, action) {
    const payload = await requestJson(
      `/api/jobs/${encodeURIComponent(jobId)}/${action}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
    return payload.job;
  }

  async function mutateByCdkeys(cdkeys, action) {
    const target = new Set((cdkeys || []).map((value) => String(value || "").trim()).filter(Boolean));
    const jobs = await listJobs();
    const matched = jobs.filter((job) =>
      (job.items || []).some((item) => target.has(String(item.cdkey || "").trim()))
    );
    const updated = [];
    for (const job of matched) updated.push(await mutate(job.id, action));
    return updated;
  }

  return {
    createJob,
    getJob,
    listJobs,
    getEvents,
    cancelJob: (jobId) => mutate(jobId, "cancel"),
    retryJob: (jobId) => mutate(jobId, "retry"),
    cancelByCdkeys: (cdkeys) => mutateByCdkeys(cdkeys, "cancel"),
    retryByCdkeys: (cdkeys) => mutateByCdkeys(cdkeys, "retry")
  };
}

export function isTerminalJob(job) {
  return TERMINAL_JOB_STATUSES.has(String(job?.status || ""));
}
