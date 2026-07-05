import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  classifyCdkeyPreflight,
  computeAccountFacts,
  computeRowProgress,
  getNextAttemptCount,
  isCooldownReason,
  isFourthAttemptBlocked
} from "../src/redeemState.js";

test("missing CDK status item means unused and available", () => {
  assert.deepEqual(classifyCdkeyPreflight(undefined), {
    usable: true,
    bucket: "available",
    used: false,
    occupied: false,
    reason: ""
  });
});

test("returned success CDK is used and not submitable", () => {
  const result = classifyCdkeyPreflight({ status: "success", reason: "兑换成功" });
  assert.equal(result.usable, false);
  assert.equal(result.used, true);
});

test("explicit cancelled failed CDK can be resubmitted", () => {
  const result = classifyCdkeyPreflight({ status: "failed", reason: "用户取消，CDK 可重新提交" });
  assert.equal(result.usable, true);
  assert.equal(result.bucket, "available");
});

test("plain unknown CDK item is blocked instead of fail-open", () => {
  const result = classifyCdkeyPreflight({ status: "unknown", reason: "返回异常" });
  assert.equal(result.usable, false);
  assert.equal(result.bucket, "unknown");
  assert.equal(result.reason, "返回异常");
});

test("failed CDK is available only when backend says retry can reuse token", () => {
  assert.equal(classifyCdkeyPreflight({ status: "failed", reason: "充值失败" }).usable, false);
  assert.equal(
    classifyCdkeyPreflight({
      status: "failed",
      reason: "充值失败，可重试",
      can_retry: true,
      can_reuse_token: true,
      has_access_token: true
    }).usable,
    true
  );
});

test("cooldown reason is detected from backend text", () => {
  assert.equal(isCooldownReason("该邮箱今日提交次数已达上限（3 次），请 24 小时后再试"), true);
});

test("third attempt is allowed and fourth is blocked", () => {
  const email = "a@example.com";
  const now = 10000;
  const attempts = [now - 3000, now - 2000];
  assert.equal(getNextAttemptCount(email, { [email]: { attempts } }, now), ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(isFourthAttemptBlocked(email, { [email]: { attempts } }, now), false);
  assert.equal(
    isFourthAttemptBlocked(email, { [email]: { attempts: [...attempts, now - 1000] } }, now),
    true
  );
});

test("account facts separate pool, available, cooling, attempts, processed, and active tasks", () => {
  const now = 10000;
  const accounts = [
    { email: "free@example.com" },
    { email: "cool@example.com" },
    { email: "done@example.com" },
    { email: "busy@example.com" },
    { email: "max@example.com" }
  ];
  const facts = computeAccountFacts({
    accounts,
    rows: [{ email: "busy@example.com", status: "pending_dispatch", statusOwner: true }],
    cooldowns: { "cool@example.com": { until: now + 5000 } },
    attemptLedger: { "max@example.com": { attempts: [now - 3000, now - 2000, now - 1000] } },
    processedEmails: new Set(["done@example.com"]),
    now
  });
  assert.equal(facts.pool, 5);
  assert.equal(facts.available, 1);
  assert.equal(facts.cooling, 1);
  assert.equal(facts.processed, 1);
  assert.equal(facts.taskOccupied, 1);
  assert.equal(facts.attemptBlocked, 1);
  assert.equal(facts.availableAccounts[0].email, "free@example.com");
});

test("row progress shows cooldown as warning at 100 percent", () => {
  const progress = computeRowProgress({ status: "failed", reason: "今日提交次数已达上限，请 24 小时后再试" });
  assert.deepEqual(progress, { label: "冷却", percent: 100, tone: "warning" });
});
