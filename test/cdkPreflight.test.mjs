import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFailedPreflightResult,
  buildPreflightSummary,
  canSubmitPreflightItem
} from "../src/state/cdkPreflight.js";

test("buildFailedPreflightResult fails closed when the status request fails", () => {
  const cdkeys = [
    { cdkey: "CDK-A", lineNumber: 1, poolId: "vip", poolLabel: "VIP" },
    { cdkey: "CDK-B", lineNumber: 2, poolId: "vip", poolLabel: "VIP" }
  ];
  const result = buildFailedPreflightResult(cdkeys, "network down");

  assert.deepEqual(result.availableCdkeys, []);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].reason, "卡密状态查询失败，请重试：network down");
  assert.equal(result.summary.checked, 2);
  assert.equal(result.summary.unknown, 2);
  assert.equal(result.summary.available, 0);
});

test("canSubmitPreflightItem allows not_found CDK status", () => {
  assert.equal(canSubmitPreflightItem({ status: "not_found" }), true);
});

test("canSubmitPreflightItem blocks a missing CDK status item", () => {
  assert.equal(canSubmitPreflightItem(null), false);
});

test("canSubmitPreflightItem blocks successful CDK status", () => {
  assert.equal(canSubmitPreflightItem({ status: "success" }), false);
});

test("canSubmitPreflightItem blocks running CDK status", () => {
  assert.equal(canSubmitPreflightItem({ status: "running" }), false);
});

test("legacy available rawStatus flags can be submitted", () => {
  assert.equal(canSubmitPreflightItem({ status: "unknown", rawStatus: { available: "true" } }), true);
  assert.equal(canSubmitPreflightItem({ status: "unknown", rawStatus: { used: "false" } }), true);
  assert.equal(canSubmitPreflightItem({ status: "unknown", rawStatus: { redeemable: true } }), true);
});

test("successful status overrides conflicting legacy available flags", () => {
  assert.equal(canSubmitPreflightItem({ status: "success", rawStatus: { used: false } }), false);
  assert.equal(canSubmitPreflightItem({ status: "success", rawStatus: { available: true } }), false);
});

test("legacy used alias flags block submit", () => {
  assert.equal(canSubmitPreflightItem({ rawStatus: { consumed: true } }), false);
  assert.equal(canSubmitPreflightItem({ rawStatus: { is_redeemed: true } }), false);
});

test("cancelled and explicitly resubmittable CDK statuses can be submitted", () => {
  assert.equal(canSubmitPreflightItem({ status: "cancelled", rawStatus: { consumed: true } }), true);
  assert.equal(
    canSubmitPreflightItem({ status: "failed", reason: "用户取消，CDK 可重新提交" }),
    true
  );
});

test("failed reusable token status can be submitted", () => {
  assert.equal(
    canSubmitPreflightItem({
      status: "failed",
      can_retry: "true",
      can_reuse_token: 1,
      has_access_token: "yes"
    }),
    true
  );
});

test("plain unknown and malformed CDK statuses fail closed", () => {
  assert.equal(canSubmitPreflightItem({ status: "unknown" }), false);
  assert.equal(canSubmitPreflightItem({}), false);
  assert.equal(canSubmitPreflightItem({ status: "unknown", reason: "返回异常" }), false);
});

test("buildPreflightSummary counts CDK buckets and preserves submit planning counts", () => {
  const summary = buildPreflightSummary(
    [
      { status: "not_found" },
      null,
      { status: "success" },
      { status: "running" },
      { status: "unknown" }
    ],
    {
      submitted: 2,
      waitingAccounts: 3,
      waitingCdkeys: 4
    }
  );

  assert.equal(summary.checked, 5);
  assert.equal(summary.available, 1);
  assert.equal(summary.used, 1);
  assert.equal(summary.busy, 1);
  assert.equal(summary.unknown, 2);
  assert.equal(summary.skipped, 4);
  assert.equal(summary.submitted, 2);
  assert.equal(summary.waitingAccounts, 3);
  assert.equal(summary.waitingCdkeys, 4);
});
