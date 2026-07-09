import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedPolling } from "../src/services/serializedPolling.js";
import {
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
