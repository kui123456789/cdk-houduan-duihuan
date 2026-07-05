import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCdkUsageStats,
  computeRequestStatusCounts,
  getLatestRowsByCdkey
} from "../src/state/redeemSelectors.js";

test("getLatestRowsByCdkey prefers status owner", () => {
  const rows = [
    { id: "old", cdkey: "A", status: "failed", statusOwner: false },
    { id: "new", cdkey: "A", status: "pending_dispatch", statusOwner: true }
  ];
  assert.deepEqual(getLatestRowsByCdkey(rows).map((row) => row.id), ["new"]);
});

test("computeCdkUsageStats has only used and unused buckets", () => {
  const stats = computeCdkUsageStats(
    [
      { cdkey: "A", channelLabel: "UPI 排队" },
      { cdkey: "B", channelLabel: "IDEAL 排队" }
    ],
    [{ cdkey: "A", status: "success" }],
    (row) => row.cdkey
  );
  assert.equal(stats.usedCount, 1);
  assert.equal(stats.unusedCount, 1);
  assert.equal(stats.usedText, "A");
  assert.equal(stats.unusedText, "B · IDEAL 排队");
});

test("computeCdkUsageStats annotates duplicate successful emails", () => {
  const stats = computeCdkUsageStats(
    [
      { cdkey: "A", channelLabel: "IDEAL 排队" },
      { cdkey: "B", channelLabel: "IDEAL 排队" }
    ],
    [
      { cdkey: "A", channelLabel: "IDEAL 排队", email: "same@example.com", status: "success" },
      { cdkey: "B", channelLabel: "IDEAL 排队", email: "same@example.com", status: "success" }
    ],
    (row) => `${row.cdkey}:${row.email}:${row.cdkSuccessEmailCount}`
  );

  assert.equal(stats.usedCount, 2);
  assert.equal(stats.duplicateSuccessEmailCount, 1);
  assert.equal(stats.usedText, "A:same@example.com:2\nB:same@example.com:2");
});

test("computeCdkUsageStats ignores rows outside current input for pool counts", () => {
  const stats = computeCdkUsageStats(
    [],
    [{ cdkey: "A", status: "unused" }],
    (row) => `${row.cdkey}:${row.status}`
  );
  assert.equal(stats.usedCount, 0);
  assert.equal(stats.unusedCount, 0);
  assert.equal(stats.unusedText, "");
});

test("computeCdkUsageStats keeps total scoped to current input CDKs", () => {
  const stats = computeCdkUsageStats(
    Array.from({ length: 9 }, (_, index) => ({
      cdkey: `INPUT-${index + 1}`,
      channelLabel: "IDEAL 排队"
    })),
    [
      { cdkey: "OLD-1", status: "success" },
      { cdkey: "OLD-2", status: "success" },
      { cdkey: "OLD-3", status: "success" },
      { cdkey: "OLD-4", status: "success" },
      { cdkey: "OLD-5", status: "success" },
      ...Array.from({ length: 9 }, (_, index) => ({
        cdkey: `INPUT-${index + 1}`,
        status: "unused"
      }))
    ],
    (row) => row.cdkey
  );

  assert.equal(stats.total, 9);
  assert.equal(stats.usedCount, 0);
  assert.equal(stats.unusedCount, 9);
});

test("computeRequestStatusCounts groups moving states", () => {
  const counts = computeRequestStatusCounts({
    pending_dispatch: 2,
    dispatched: 1,
    running: 3,
    failed: 4,
    timeout: 1
  });
  assert.equal(counts.waiting, 2);
  assert.equal(counts.dispatched, 1);
  assert.equal(counts.running, 3);
  assert.equal(counts.failed, 4);
});
