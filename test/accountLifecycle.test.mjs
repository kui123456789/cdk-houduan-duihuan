import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_ATTEMPT_LIMIT } from "../src/config/redeemConstants.js";
import {
  applyCooldownMarkersToRows,
  getCooledEmailSet,
  normalizeAccountCooldowns,
  syncAttemptLimitCooldownState,
  shouldBlockFourthAttempt
} from "../src/state/accountLifecycle.js";

test("normalizeAccountCooldowns drops expired cooldowns", () => {
  const now = 1000;
  assert.deepEqual(
    normalizeAccountCooldowns(
      {
        "expired@example.com": { until: now, reason: "old" },
        "Active@Example.COM": { until: now + 5000, reason: "still active", startedAt: 500 },
        "cooldown-prop@example.com": { cooldownUntil: now + 6000 }
      },
      now
    ),
    {
      "active@example.com": {
        email: "active@example.com",
        until: now + 5000,
        reason: "still active",
        startedAt: 500
      },
      "cooldown-prop@example.com": {
        email: "cooldown-prop@example.com",
        until: now + 6000,
        reason: "今日提交次数已达上限，封存 24 小时",
        startedAt: now
      }
    }
  );
});

test("getCooledEmailSet returns active lower-case emails", () => {
  const now = 2000;
  const cooledEmails = getCooledEmailSet(
    {
      "UPPER@Example.COM": { until: now + 1 },
      "expired@example.com": { until: now - 1 }
    },
    now
  );

  assert.deepEqual([...cooledEmails], ["upper@example.com"]);
});

test("applyCooldownMarkersToRows marks failed rows but clears success rows", () => {
  const now = 3000;
  const reason = "该账号今日提交次数已达上限，请 24 小时后再试";
  const rows = [
    {
      id: "failed-row",
      status: "failed",
      email: "User@Example.COM",
      accountAttemptNumber: 1
    },
    {
      id: "success-row",
      status: "success",
      email: "user@example.com",
      accountCooldownUntil: now + 1000,
      accountCooldownReason: "old cooldown"
    }
  ];

  const result = applyCooldownMarkersToRows(
    rows,
    {
      "user@example.com": {
        until: now + 5000,
        reason
      }
    },
    now
  );

  assert.equal(result[0].accountCooldownUntil, now + 5000);
  assert.equal(result[0].accountCooldownReason, reason);
  assert.equal(result[0].accountAttemptNumber, ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(result[1].accountCooldownUntil, 0);
  assert.equal(result[1].accountCooldownReason, "");
});

test("shouldBlockFourthAttempt allows third attempt but blocks fourth attempt", () => {
  assert.equal(shouldBlockFourthAttempt(ACCOUNT_ATTEMPT_LIMIT - 1), false);
  assert.equal(shouldBlockFourthAttempt(ACCOUNT_ATTEMPT_LIMIT), true);
});

test("failed rows enter cooldown when the account ledger already has three attempts", () => {
  const now = 10_000;
  const result = syncAttemptLimitCooldownState({
    ledger: {
      "limited@example.com": {
        attempts: [now - 3000, now - 2000, now - 1000]
      }
    },
    cooldowns: {},
    rows: [{
      id: "failed-row",
      email: "Limited@Example.com",
      status: "failed",
      can_retry: true,
      accountAttemptNumber: 1
    }],
    now
  });

  assert.deepEqual(result.cooledEmails, ["limited@example.com"]);
  assert.ok(result.cooldowns["limited@example.com"].until > now);
  assert.equal(result.rows[0].accountAttemptNumber, ACCOUNT_ATTEMPT_LIMIT);
  assert.ok(result.rows[0].accountCooldownUntil > now);
});

test("the third in-flight attempt does not enter cooldown before it fails", () => {
  const now = 20_000;
  const result = syncAttemptLimitCooldownState({
    ledger: {
      "running@example.com": {
        attempts: [now - 3000, now - 2000, now - 1000]
      }
    },
    cooldowns: {},
    rows: [{
      id: "running-row",
      email: "running@example.com",
      status: "pending_dispatch",
      accountAttemptNumber: ACCOUNT_ATTEMPT_LIMIT
    }],
    now
  });

  assert.deepEqual(result.cooledEmails, []);
  assert.deepEqual(result.cooldowns, {});
  assert.equal(result.rows[0].accountCooldownUntil, undefined);
});
