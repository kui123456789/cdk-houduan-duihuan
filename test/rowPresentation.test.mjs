import assert from "node:assert/strict";
import test from "node:test";
import { canRetryRow } from "../src/redeemLogic.js";
import {
  compactStatus,
  formatAttemptNumber,
  formatCdkUsageLine,
  formatFailureReason,
  getEmailVerificationTone,
  getRowRedeemProgress,
  getSubscriptionTone
} from "../src/state/rowPresentation.js";

test("compactStatus returns compact Chinese status labels", () => {
  assert.equal(compactStatus("pending_dispatch"), "待兑换");
  assert.equal(compactStatus("running"), "兑换中");
  assert.equal(compactStatus("pm_unavailable"), "账号风控");
});

test("formatAttemptNumber clamps visible account attempts", () => {
  assert.equal(formatAttemptNumber({ accountAttemptNumber: 1 }), "1/3 次");
  assert.equal(formatAttemptNumber({ accountAttemptNumber: 4 }), "3/3 次");
  assert.equal(
    formatAttemptNumber({ queryOnly: true, rowKind: "query", accountAttemptNumber: 0 }),
    "仅查询"
  );
  assert.equal(formatAttemptNumber({}), "-");
});

test("getRowRedeemProgress maps row status to progress display", () => {
  assert.deepEqual(getRowRedeemProgress({ status: "pending_dispatch" }), {
    percent: 50,
    label: "等待充值",
    tone: "pending"
  });
  assert.deepEqual(getRowRedeemProgress({ status: "dispatching" }), {
    percent: 70,
    label: "系统接单",
    tone: "info"
  });
  assert.deepEqual(getRowRedeemProgress({ status: "running" }), {
    percent: 85,
    label: "充值处理中",
    tone: "running"
  });
  assert.deepEqual(getRowRedeemProgress({ status: "success" }), {
    percent: 100,
    label: "成功",
    tone: "success"
  });
  assert.deepEqual(getRowRedeemProgress({ status: "query_failed" }), {
    percent: 100,
    label: "查询失败",
    tone: "warning"
  });
});

test("getSubscriptionTone maps plus timeout and checking states", () => {
  assert.equal(getSubscriptionTone({ subscriptionCategory: "plus" }), "success");
  assert.equal(getSubscriptionTone({ subscriptionCategory: "timeout" }), "danger");
  assert.equal(getSubscriptionTone({ subscriptionStatus: "checking" }), "info");
});

test("getEmailVerificationTone distinguishes verified and blocked mailboxes", () => {
  assert.equal(getEmailVerificationTone({ emailVerificationStatus: "verified" }), "success");
  assert.equal(getEmailVerificationTone({ emailVerificationStatus: "not_found" }), "warning");
  assert.equal(getEmailVerificationTone({ emailVerificationStatus: "missing_url" }), "danger");
});

test("formatFailureReason marks retryable recharge failures", () => {
  assert.equal(
    formatFailureReason(
      { status: "failed", reason: "充值失败", can_retry: true },
      { canRetryVisibleRow: () => true }
    ),
    "充值失败（可重试）"
  );
});

test("formatFailureReason does not label query-only failures as retryable", () => {
  const row = {
    queryOnly: true,
    rowKind: "query",
    cdkey: "CDK-QUERY-ONLY",
    status: "failed",
    reason: "兑换失败",
    can_retry: true,
    can_reuse_token: true,
    has_access_token: true
  };

  assert.equal(formatAttemptNumber(row), "仅查询");
  assert.equal(
    formatFailureReason(row, { canRetryVisibleRow: canRetryRow }),
    "兑换失败"
  );
});

test("formatCdkUsageLine shows used account and duplicate success warning", () => {
  assert.equal(
    formatCdkUsageLine({
      cdkey: "PE78-JPPB-AE8T-2U6E",
      channelLabel: "IDEAL 排队",
      email: "same@example.com",
      status: "success",
      cdkSuccessEmailCount: 2
    }),
    "PE78-JPPB-AE8T-2U6E · IDEAL 排队 · 使用账号：same@example.com · 兑换成功 · 同邮箱多卡密成功 2 张"
  );
});

test("formatCdkUsageLine does not show a used account for unused CDKs", () => {
  assert.equal(
    formatCdkUsageLine({
      cdkey: "MISSING-CDK",
      channelLabel: "IDEAL 排队",
      email: "old@example.com",
      status: "unused",
      reason: "后端未返回该卡密，按未使用处理"
    }),
    "MISSING-CDK · IDEAL 排队 · 未使用 · 后端未返回该卡密，按未使用处理"
  );
});
