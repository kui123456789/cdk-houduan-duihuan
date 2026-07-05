import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreflightSummary,
  canSubmitPreflightItem
} from "../src/state/cdkPreflight.js";

test("canSubmitPreflightItem allows not_found CDK status", () => {
  assert.equal(canSubmitPreflightItem({ status: "not_found" }), true);
});

test("canSubmitPreflightItem allows missing CDK status item", () => {
  assert.equal(canSubmitPreflightItem(null), true);
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

test("legacy explicit available flags override conflicting success status", () => {
  assert.equal(canSubmitPreflightItem({ status: "success", rawStatus: { used: false } }), true);
  assert.equal(canSubmitPreflightItem({ status: "success", rawStatus: { available: true } }), true);
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

test("plain unknown CDK status remains blocked", () => {
  assert.equal(canSubmitPreflightItem({ status: "unknown" }), false);
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
  assert.equal(summary.available, 2);
  assert.equal(summary.used, 1);
  assert.equal(summary.busy, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.skipped, 3);
  assert.equal(summary.submitted, 2);
  assert.equal(summary.waitingAccounts, 3);
  assert.equal(summary.waitingCdkeys, 4);
});
