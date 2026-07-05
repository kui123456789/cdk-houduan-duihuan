import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedPolling } from "../src/services/serializedPolling.js";
import { summarizeStatusQueryResult } from "../src/hooks/useRedeemPolling.js";

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
