import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedPolling } from "../src/services/serializedPolling.js";
import {
  retryDelayedStatusItems,
  queryStatusCredentialGroups,
  markCredentialBlockedRows,
  markQueryRowsFailed,
  summarizeStatusQueryResult
} from "../src/hooks/useRedeemPolling.js";

test("old polling session does not schedule again after restart", async () => {
  const timers = [];
  const calls = [];
  let resolveFirst;
  const firstQuery = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const polling = createSerializedPolling({
    intervalMs: 5,
    query: async (cdkeys, options) => {
      calls.push({ cdkeys, options });
      if (calls.length === 1) await firstQuery;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => {}
  });

  polling.start(["OLD"]);
  const oldTickPromise = timers.shift()();
  polling.start(["NEW"]);
  resolveFirst();
  await oldTickPromise;

  assert.equal(calls[0].cdkeys[0], "OLD");
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(calls[1].cdkeys[0], "NEW");
});

test("status query summary counts returned and missing CDKs", () => {
  const summary = summarizeStatusQueryResult(
    ["A", "B", "C", "D", "E"],
    [
      { cdkey: "A", status: "success" },
      { cdKey: "B", status: "success" },
      { cd_key: "C", status: "success" },
      { cdk: "D", status: "success" },
      { cdkey: "OUTSIDE", status: "success" }
    ]
  );

  assert.equal(summary.requestedCount, 5);
  assert.equal(summary.returnedCount, 4);
  assert.equal(summary.missingCount, 1);
  assert.deepEqual(summary.missingCdkeys, ["E"]);
});

test("status query retries delayed not-found CDKs until the backend returns a real status", async () => {
  const retryCalls = [];
  const retryNotices = [];

  const result = await retryDelayedStatusItems({
    cdkeys: ["A", "B"],
    items: [
      { cdkey: "A", status: "not_found", message: "暂未找到" },
      { cdkey: "B", status: "success" }
    ],
    queryStatus: async (cdkeys) => {
      retryCalls.push(cdkeys);
      return { items: [{ cdkey: "A", status: "queued" }] };
    },
    wait: async () => {},
    onRetry: (notice) => retryNotices.push(notice)
  });

  assert.deepEqual(retryCalls, [["A"]]);
  assert.equal(retryNotices[0].attempt, 1);
  assert.equal(retryNotices[0].maxRetries, 3);
  assert.deepEqual(result.unresolvedCdkeys, []);
  assert.equal(result.retryAttempts, 1);
  assert.equal(result.items.find((item) => item.cdkey === "A").status, "queued");
  assert.equal(result.items.find((item) => item.cdkey === "B").status, "success");
});

test("status query treats persistent not-found as unused after the delayed-status limit", async () => {
  const retryCalls = [];

  const result = await retryDelayedStatusItems({
    cdkeys: ["A"],
    items: [{ cdkey: "A", status: "not_found" }],
    queryStatus: async (cdkeys) => {
      retryCalls.push(cdkeys);
      return { items: [{ cdkey: "A", status: "not_found" }] };
    },
    wait: async () => {}
  });

  assert.equal(result.retryAttempts, 3);
  assert.deepEqual(retryCalls, [["A"], ["A"], ["A"]]);
  assert.deepEqual(result.unresolvedCdkeys, ["A"]);
  assert.equal(result.items[0].status, "unused");
  assert.equal(result.items[0].reason, "后端未找到兑换记录，按未使用处理");
});

test("markQueryRowsFailed only recovers rows still stuck in querying", () => {
  const rows = [
    { id: "query", cdkey: "A", status: "querying", reason: "" },
    { id: "running", cdkey: "B", status: "running", reason: "兑换中" },
    { id: "other", cdkey: "C", status: "querying", reason: "" }
  ];

  const nextRows = markQueryRowsFailed(rows, ["A", "B"], "兑换后台请求超时");

  assert.notEqual(nextRows, rows);
  assert.equal(nextRows[0].status, "query_failed");
  assert.equal(nextRows[0].reason, "兑换后台请求超时");
  assert.equal(nextRows[0].can_cancel, false);
  assert.equal(nextRows[0].can_retry, false);
  assert.equal(nextRows[0].rawStatus.localQueryError, true);
  assert.equal(nextRows[1], rows[1]);
  assert.equal(nextRows[2], rows[2]);
});

test("status query sends Session CDKs with Session credential mode and blocks ordinary CDKs", async () => {
  const calls = [];
  const result = await queryStatusCredentialGroups({
    rows: [
      { cdkey: "A", sourceType: "session", statusOwner: true },
      { cdkey: "B", sourceType: "account", statusOwner: true }
    ],
    cdkeys: ["A", "B"],
    hasUserApiKey: false,
    callProxy: async (path, body, options) => {
      calls.push({ path, body, options });
      return { ok: true, batchCount: 1, items: [{ cdkey: "A", status: "success" }] };
    }
  });

  assert.deepEqual(calls, [
    {
      path: "/api/redeem/status",
      body: { cdkeys: ["A"] },
      options: { credentialMode: "session" }
    }
  ]);
  assert.deepEqual(result.blockedCdkeys, ["B"]);
  assert.deepEqual(result.payload.items, [{ cdkey: "A", status: "success" }]);
});

test("markCredentialBlockedRows records a local API key error", () => {
  const rows = [
    { id: "blocked", cdkey: "B", status: "running", statusOwner: true },
    { id: "session", cdkey: "A", status: "running", statusOwner: true }
  ];
  const nextRows = markCredentialBlockedRows(rows, ["B"], "请先填写外部 API Key");

  assert.equal(nextRows[0].status, "query_failed");
  assert.equal(nextRows[0].reason, "请先填写外部 API Key");
  assert.equal(nextRows[0].rawStatus.localCredentialError, true);
  assert.equal(nextRows[1], rows[1]);
});
