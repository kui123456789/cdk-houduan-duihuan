import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_COOLDOWN_MS,
  getAccountAvailabilityFacts,
  getAccountLifecycle,
  normalizeAccountLedger,
  recordAccountSubmitAttempt,
  startAccountCooldown
} from "../src/workflow/accountLedger.js";
import {
  getAccountAttemptInfo,
  normalizeAccountAttemptLedger
} from "../src/state/redeemWorkflow.js";

test("recordAccountSubmitAttempt allows third attempt and blocks fourth", () => {
  const email = " User@Example.COM ";
  const now = 1_000_000;
  let ledger = {};

  ledger = recordAccountSubmitAttempt(ledger, email, { now });
  ledger = recordAccountSubmitAttempt(ledger, email, { now: now + 1000 });
  ledger = recordAccountSubmitAttempt(ledger, email, { now: now + 2000 });

  const thirdAttempt = getAccountLifecycle(ledger, email, { now: now + 2000 });
  assert.equal(thirdAttempt.email, "user@example.com");
  assert.equal(thirdAttempt.attemptCount, ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(thirdAttempt.limitReached, true);
  assert.equal(thirdAttempt.cooling, false);
  assert.equal(thirdAttempt.canSubmit, false);
  assert.equal(thirdAttempt.lastAllowedAttemptReached, true);

  ledger = recordAccountSubmitAttempt(ledger, email, { now: now + 3000 });
  const fourthAttempt = getAccountLifecycle(ledger, email, { now: now + 3000 });

  assert.equal(fourthAttempt.attemptCount, ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(fourthAttempt.limitReached, true);
  assert.equal(fourthAttempt.cooling, true);
  assert.equal(fourthAttempt.canSubmit, false);
  assert.equal(fourthAttempt.cooldownUntil, now + 3000 + ACCOUNT_COOLDOWN_MS);
  assert.match(fourthAttempt.reason, /24|上限/);
});

test("backend daily limit immediately sets 3/3 and cooldown", () => {
  const now = 2_000_000;
  const ledger = startAccountCooldown({}, "Limit@Example.COM", {
    now,
    reason: "今日提交次数已达上限，请 24 小时后再试",
    forceAttemptLimit: true
  });

  const lifecycle = getAccountLifecycle(ledger, "limit@example.com", { now });
  assert.equal(lifecycle.attemptCount, ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(lifecycle.limitReached, true);
  assert.equal(lifecycle.cooling, true);
  assert.equal(lifecycle.canSubmit, false);
  assert.equal(lifecycle.cooldownUntil, now + ACCOUNT_COOLDOWN_MS);
});

test("getAccountAvailabilityFacts separates pool, available, cooling, active, completed", () => {
  const now = 3_000_000;
  let ledger = startAccountCooldown({}, "cool@example.com", {
    now,
    forceAttemptLimit: true
  });
  ledger = recordAccountSubmitAttempt(ledger, "twice@example.com", { now });
  ledger = recordAccountSubmitAttempt(ledger, "twice@example.com", { now: now + 1 });
  ledger = recordAccountSubmitAttempt(ledger, "third@example.com", { now });
  ledger = recordAccountSubmitAttempt(ledger, "third@example.com", { now: now + 1 });
  ledger = recordAccountSubmitAttempt(ledger, "third@example.com", { now: now + 2 });

  const facts = getAccountAvailabilityFacts({
    accounts: [
      { email: "free@example.com" },
      { email: "cool@example.com" },
      { email: "busy@example.com" },
      { email: "plus@example.com" },
      { email: "active-plus@example.com" },
      { email: "twice@example.com" },
      { email: "third@example.com" }
    ],
    rows: [
      { email: "busy@example.com", status: "querying" },
      { email: "plus@example.com", status: "success", subscriptionStatus: "plus" },
      { email: "active-plus@example.com", status: "success", subscriptionActive: true }
    ],
    ledger,
    now
  });

  assert.equal(facts.pool, 7);
  assert.equal(facts.available, 2);
  assert.equal(facts.cooling, 1);
  assert.equal(facts.attemptLimited, 2);
  assert.equal(facts.activeTask, 1);
  assert.equal(facts.completedPlus, 2);
  assert.deepEqual(
    facts.availableAccounts.map((account) => account.email),
    ["free@example.com", "twice@example.com"]
  );
  assert.deepEqual([...facts.blockedEmails].sort(), [
    "active-plus@example.com",
    "busy@example.com",
    "cool@example.com",
    "plus@example.com",
    "third@example.com"
  ]);
});

test("getAccountAvailabilityFacts keeps cooldown-only emails blocked outside the account pool", () => {
  const now = 3_500_000;
  const facts = getAccountAvailabilityFacts({
    accounts: [{ email: "free@example.com" }],
    cooldowns: {
      "cooldown-only@example.com": {
        until: now + 1000,
        reason: "今日提交次数已达上限"
      }
    },
    now
  });

  assert.equal(facts.pool, 1);
  assert.equal(facts.available, 1);
  assert.equal(facts.cooling, 0);
  assert.deepEqual([...facts.blockedEmails], ["cooldown-only@example.com"]);
});

test("normalizeAccountLedger drops expired attempt window entries", () => {
  const now = 4_000_000;
  const ledger = normalizeAccountLedger(
    {
      "Expired@Example.COM": {
        attempts: [
          now - ACCOUNT_COOLDOWN_MS - 1,
          now - 1000,
          now + 6000
        ]
      }
    },
    { now }
  );

  assert.deepEqual(Object.keys(ledger), ["expired@example.com"]);
  assert.deepEqual(ledger["expired@example.com"].attempts, [now - 1000]);
  assert.equal(ledger["expired@example.com"].attemptCount, 1);
});

test("legacy attempts ledger can be normalized", () => {
  const now = 5_000_000;
  const ledger = normalizeAccountLedger(
    {
      "Legacy@Example.COM": {
        attempts: [now - 2000, now - 1000]
      }
    },
    { now }
  );

  assert.deepEqual(ledger, {
    "legacy@example.com": {
      email: "legacy@example.com",
      attempts: [now - 2000, now - 1000],
      attemptCount: 2,
      firstAttemptAt: now - 2000,
      lastAttemptAt: now - 1000,
      cooldownUntil: 0,
      cooldownReason: "",
      updatedAt: now - 1000
    }
  });
});

test("count-only ledger can be normalized when timestamps are still in window", () => {
  const now = 6_000_000;
  const ledger = normalizeAccountLedger(
    {
      "CountOnly@Example.COM": {
        attemptCount: 2,
        lastAttemptAt: now - 1000,
        updatedAt: now - 500
      }
    },
    { now }
  );

  assert.equal(ledger["countonly@example.com"].attemptCount, 2);
  assert.deepEqual(ledger["countonly@example.com"].attempts, [now - 1000, now - 1000]);
  assert.equal(ledger["countonly@example.com"].lastAttemptAt, now - 1000);
  assert.equal(ledger["countonly@example.com"].updatedAt, now - 500);
});

test("redeemWorkflow normalizes count-only attempt ledger for stored UI state", () => {
  const now = 7_000_000;
  const storedLedger = {
    "a@example.com": {
      attemptCount: 2,
      lastAttemptAt: now - 1000
    }
  };

  const normalized = normalizeAccountAttemptLedger(storedLedger, now);
  assert.deepEqual(normalized["a@example.com"].attempts, [now - 1000, now - 1000]);

  const info = getAccountAttemptInfo("a@example.com", storedLedger, now);
  assert.equal(info.count, 2);
  assert.equal(info.limitReached, false);
});
