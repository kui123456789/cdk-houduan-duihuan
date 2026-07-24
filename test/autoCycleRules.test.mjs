import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_FAILURE_STATUSES,
  RESUBMIT_REDEEM_STATUSES
} from "../src/config/redeemConstants.js";
import {
  buildAutoCycleReservedAccessTokens,
  buildAutoCycleReservedEmails,
  isAutoCycleFailureCandidate,
  reserveAutoCycleReplacementAccessToken,
  reserveAutoCycleReplacementEmail,
  shouldReleaseCdkeyForNextAccount,
  useAutoCycle
} from "../src/hooks/useAutoCycle.js";
import { canRetryRow, normalizeStatusItem } from "../src/redeemLogic.js";
import { canResubmitRedeemRow } from "../src/state/redeemWorkflow.js";

test("retryable failed row is an auto-cycle candidate", () => {
  assert.equal(
    isAutoCycleFailureCandidate({ status: "failed", can_retry: true, can_reuse_token: true }),
    true
  );
});

test("pm_unavailable is not a normal auto-cycle candidate", () => {
  assert.equal(
    isAutoCycleFailureCandidate({ status: "pm_unavailable", can_retry: true }),
    false
  );
});

test("daily limit failure releases CDK for next account", () => {
  assert.equal(
    shouldReleaseCdkeyForNextAccount({
      status: "failed",
      reason: "该邮箱今日提交次数已达上限（3 次），请 24 小时后再试"
    }),
    true
  );
});

test("payment timeout failures remain retryable and trigger auto-cycle", () => {
  const reasons = [
    "支付超时未检测到付款，请重试；如已付款请联系客服",
    "checkout-give-up: dispatched > 10min without paymentUrl"
  ];

  reasons.forEach((message) => {
    const normalized = normalizeStatusItem({
      cdkey: "CDK-PAYMENT-TIMEOUT",
      status: "dispatched",
      message,
      has_access_token: true
    });
    const row = {
      ...normalized,
      id: `row-${message}`,
      email: "failed@example.com",
      accessToken: "access-token",
      channel: "ideal",
      statusOwner: true
    };

    assert.equal(row.status, "timeout");
    assert.equal(canRetryRow(row), true);
    assert.equal(canResubmitRedeemRow(row), true);
    assert.equal(isAutoCycleFailureCandidate(row), true);
  });
});

test("unused account submission releases its CDK for the next account", () => {
  assert.equal(
    isAutoCycleFailureCandidate({
      id: "unused-account-task",
      email: "old@example.com",
      accessToken: "old-token",
      cdkey: "CDK-A",
      status: "unused",
      accountAttemptNumber: 1,
      statusOwner: true
    }),
    true
  );
});

test("unused account submission counts toward the 3-attempt cooldown rule", () => {
  assert.equal(ATTEMPT_FAILURE_STATUSES.has("unused"), true);
  assert.equal(RESUBMIT_REDEEM_STATUSES.has("unused"), true);
});

test("auto-cycle reserves active and successful emails as replacement targets", () => {
  const reserved = buildAutoCycleReservedEmails(
    [
      { email: "Done@Example.com", status: "success", statusOwner: true },
      { email: "Running@Example.com", status: "running", statusOwner: true },
      { email: "History@Example.com", status: "success", statusOwner: false },
      { email: "Cancelled@Example.com", status: "cancelled", statusOwner: true }
    ],
    [{ email: "Failed@Example.com", status: "failed" }]
  );

  assert.equal(reserved.has("done@example.com"), true);
  assert.equal(reserved.has("running@example.com"), true);
  assert.equal(reserved.has("failed@example.com"), true);
  assert.equal(reserved.has("history@example.com"), false);
  assert.equal(reserved.has("cancelled@example.com"), false);
});

test("auto-cycle reserves a selected replacement immediately", () => {
  const reserved = buildAutoCycleReservedEmails([], [{ email: "failed@example.com" }]);
  const queue = [
    { email: "first@example.com" },
    { email: "second@example.com" }
  ];
  const pickNext = () =>
    queue.find((account) => !reserved.has(String(account.email || "").trim().toLowerCase()));

  const first = pickNext();
  reserveAutoCycleReplacementEmail(reserved, first);
  const second = pickNext();

  assert.equal(first.email, "first@example.com");
  assert.equal(second.email, "second@example.com");
});

test("auto-cycle reserves active and selected access tokens", () => {
  const reserved = buildAutoCycleReservedAccessTokens(
    [
      { email: "done@example.com", accessToken: "done-token", status: "success", statusOwner: true },
      { email: "history@example.com", accessToken: "history-token", status: "success", statusOwner: false }
    ],
    [{ email: "failed@example.com", accessToken: "failed-token", status: "failed" }]
  );

  reserveAutoCycleReplacementAccessToken(reserved, { accessToken: "selected-token" });

  assert.equal(reserved.has("done-token"), true);
  assert.equal(reserved.has("failed-token"), true);
  assert.equal(reserved.has("selected-token"), true);
  assert.equal(reserved.has("history-token"), false);
});

test("auto-cycle reserves an AT while its submitted status is still unconfirmed", () => {
  const reserved = buildAutoCycleReservedAccessTokens([
    {
      email: "reserved@example.com",
      accessToken: "reserved-token",
      status: "not_found",
      statusOwner: true,
      staleStatusGuard: true,
      retryHoldUntil: Date.now() + 60_000
    }
  ]);

  assert.equal(reserved.has("reserved-token"), true);
});

test("auto-cycle restarts polling after submitting a replacement", async () => {
  const failedRow = {
    id: "failed-1",
    displayIndex: 1,
    email: "old@example.com",
    accessToken: "old-token",
    cdkey: "CDK-A",
    channel: "ideal",
    channelLabel: "IDEAL",
    status: "failed",
    can_retry: true,
    can_reuse_token: true,
    statusOwner: true
  };
  const rowsRef = { current: [failedRow] };
  const autoCycleRef = { current: { enabled: true, handledRowIds: [], currentRound: 1 } };
  let startPollingCalled = false;
  let submitRequested = false;

  const { processAutoCycleFailures } = useAutoCycle({
    rowsRef,
    autoCycleRef,
    autoCycleScheduleTimerRef: { current: null },
    autoCycleProcessingRef: { current: false },
    setRows: (nextRows) => {
      rowsRef.current = typeof nextRows === "function" ? nextRows(rowsRef.current) : nextRows;
    },
    setStatusMessage: () => {},
    setLastUpdatedAt: () => {},
    callProxy: async (path) => {
      submitRequested = path === "/api/redeem/submit";
      return { items: [] };
    },
    registerCooldownsFromRows: (rows) => rows,
    startPolling: () => {
      startPollingCalled = true;
    },
    getRedeemAccounts: () => [{ email: "next@example.com", accessToken: "next-token" }],
    mergeAccountsIntoAutoCycleState: (state) => state,
    commitAutoCycleState: (state) => {
      autoCycleRef.current = state;
    },
    getNextAutoCycleAccount: (state) => ({
      account: { email: "next@example.com", accessToken: "next-token" },
      state
    }),
    createAutoCycleRow: (sourceRow, account) => ({
      id: "auto-1",
      displayIndex: 2,
      parentRowId: sourceRow.id,
      autoCycle: true,
      autoCycleSourceEmail: sourceRow.email,
      email: account.email,
      accessToken: account.accessToken,
      cdkey: sourceRow.cdkey,
      channel: sourceRow.channel,
      channelLabel: sourceRow.channelLabel,
      status: "submitting"
    }),
    forgetDeletedRows: () => {},
    recordAccountSubmissionAttempts: () => new Map([["next@example.com", 1]]),
    getResolvedAttemptNumber: () => 1,
    getPollableCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    canRetryVisibleFailedRow: () => true,
    isDailyLimitFailureRow: () => false,
    isCooldownReleaseCandidate: () => false,
    isAttemptExhaustedReleaseCandidate: () => false,
    isLocalAttemptLimitFailureRow: () => false,
    getDailyLimitDisplayReason: () => "",
    formatFailureReason: () => "兑换失败",
    maskEmail: (email) => email,
    maskCdkey: (cdkey) => cdkey
  });

  await processAutoCycleFailures(rowsRef.current);

  assert.equal(submitRequested, true);
  assert.equal(startPollingCalled, true);
});
