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
import {
  canAutomaticallyRetryBackendJob,
  canCancelRow,
  canRetryRow,
  isQueryOnlyRow,
  normalizeStatusItem
} from "../src/redeemLogic.js";
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

test("a cooldown row locked without a replacement remains an auto-cycle candidate", () => {
  assert.equal(
    isAutoCycleFailureCandidate(
      {
        id: "stranded",
        email: "stranded@example.com",
        cdkey: "CDK-STRANDED",
        status: "failed",
        statusOwner: false,
        statusLocked: true,
        autoCycleHandled: true,
        autoCycleNextRowId: ""
      },
      {
        isAutoCycleEnabled: () => true,
        isCooldownReleaseCandidate: () => true,
        requiresRowId: true,
        requiresEmail: true,
        requiresCdkey: true
      }
    ),
    true
  );
});

test("automatic backend retry requires all reusable-task capability flags", () => {
  const row = {
    id: "retryable-task",
    rowKind: "redeem",
    cdkey: "CDK-RETRY",
    status: "failed",
    statusOwner: true,
    can_retry: true,
    can_reuse_token: true,
    has_access_token: true
  };

  assert.equal(canAutomaticallyRetryBackendJob(row), true);
  assert.equal(canAutomaticallyRetryBackendJob({ ...row, can_retry: false }), false);
  assert.equal(canAutomaticallyRetryBackendJob({ ...row, can_reuse_token: false }), false);
  assert.equal(canAutomaticallyRetryBackendJob({ ...row, has_access_token: false }), false);
  assert.equal(canAutomaticallyRetryBackendJob({ ...row, rowKind: "query", queryOnly: true }), false);
});

test("query-only rows cannot become retryable or cancellable backend jobs", () => {
  const row = {
    id: "query-only-failed",
    queryOnly: true,
    rowKind: "query",
    email: "",
    accessToken: "",
    cdkey: "CDK-QUERY-ONLY",
    status: "failed",
    can_retry: true,
    can_cancel: true,
    can_reuse_token: true,
    has_access_token: true
  };

  assert.equal(isQueryOnlyRow(row), true);
  assert.equal(canRetryRow(row), false);
  assert.equal(canCancelRow(row), false);
});

test("legacy rows without local account credentials are still recognized as query-only", () => {
  const row = {
    id: "query-legacy-1",
    cdkey: "CDK-LEGACY-QUERY",
    status: "pending_dispatch",
    can_retry: true,
    can_cancel: true,
    can_reuse_token: true,
    has_access_token: true
  };

  assert.equal(isQueryOnlyRow(row), true);
  assert.equal(canRetryRow(row), false);
  assert.equal(canCancelRow(row), false);
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

test("manual account switch submits a replacement and restarts polling", async () => {
  const failedRow = {
    id: "failed-1",
    displayIndex: 1,
    email: "old@example.com",
    accessToken: "old-token",
    cdkey: "CDK-A",
    channel: "ideal",
    channelLabel: "IDEAL",
    status: "failed",
    can_retry: false,
    can_reuse_token: true,
    statusOwner: true
  };
  const rowsRef = { current: [failedRow] };
  const autoCycleRef = { current: { enabled: false, handledRowIds: [], currentRound: 1 } };
  let startPollingCalled = false;
  let submitRequested = false;
  let recordedAttemptRows = [];

  const { switchAccountsForRows } = useAutoCycle({
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
    recordAccountSubmissionAttempts: (rows) => {
      recordedAttemptRows = rows;
      return new Map([["next@example.com", 1]]);
    },
    getResolvedAttemptNumber: () => 1,
    getPollableCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    canResubmitRedeemRow: () => true,
    canRetryVisibleFailedRow: () => false,
    isDailyLimitFailureRow: () => false,
    isCooldownReleaseCandidate: () => false,
    isAttemptExhaustedReleaseCandidate: () => false,
    isLocalAttemptLimitFailureRow: () => false,
    getDailyLimitDisplayReason: () => "",
    formatFailureReason: () => "兑换失败",
    maskEmail: (email) => email,
    maskCdkey: (cdkey) => cdkey
  });

  const switched = await switchAccountsForRows([failedRow]);

  assert.equal(switched, true);
  assert.equal(autoCycleRef.current.enabled, true);
  assert.equal(submitRequested, true);
  assert.equal(startPollingCalled, true);
  const replacement = rowsRef.current.find((row) => row.id === "auto-1");
  const historicalRow = rowsRef.current.find((row) => row.id === failedRow.id);
  assert.equal(replacement.cdkey, failedRow.cdkey);
  assert.equal(replacement.accessToken, "next-token");
  assert.notEqual(replacement.accessToken, failedRow.accessToken);
  assert.equal(replacement.status, "unknown");
  assert.equal(replacement.can_retry, false);
  assert.equal(recordedAttemptRows.length, 0);
  assert.equal(historicalRow.statusOwner, false);
  assert.equal(historicalRow.autoCycleHandled, true);
});

test("cooldown task stays retryable when the pool is empty and switches after an account is added", async () => {
  const failedRow = {
    id: "cooled-1",
    email: "cooled@example.com",
    accessToken: "cooled-token",
    cdkey: "CDK-COOLED",
    channel: "kakao",
    channelLabel: "KAKAO",
    status: "failed",
    statusOwner: true,
    statusLocked: false,
    autoCycleHandled: false
  };
  const rowsRef = { current: [failedRow] };
  const autoCycleRef = { current: { enabled: true, handledRowIds: [], currentRound: 1 } };
  let replacementAccount = null;

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
    callProxy: async () => ({ items: [] }),
    registerCooldownsFromRows: (rows) => rows,
    startPolling: () => {},
    getPollableCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getRedeemAccounts: () => (replacementAccount ? [replacementAccount] : []),
    mergeAccountsIntoAutoCycleState: (state) => state,
    commitAutoCycleState: (state) => {
      autoCycleRef.current = state;
    },
    getNextAutoCycleAccount: (state) => ({ account: replacementAccount, state }),
    createAutoCycleRow: (sourceRow, account) => ({
      id: "replacement-1",
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
    recordAccountSubmissionAttempts: () => new Map(),
    getResolvedAttemptNumber: () => 1,
    canResubmitRedeemRow: () => true,
    canRetryVisibleFailedRow: () => false,
    isDailyLimitFailureRow: () => false,
    isCooldownReleaseCandidate: () => true,
    isAttemptExhaustedReleaseCandidate: () => false,
    isLocalAttemptLimitFailureRow: () => false,
    getDailyLimitDisplayReason: () => "",
    formatFailureReason: () => "充值失败",
    maskEmail: (email) => email,
    maskCdkey: (cdkey) => cdkey
  });

  await processAutoCycleFailures(rowsRef.current);

  assert.equal(rowsRef.current[0].statusOwner, true);
  assert.equal(rowsRef.current[0].statusLocked, false);
  assert.equal(rowsRef.current[0].autoCycleHandled, false);
  assert.deepEqual(autoCycleRef.current.handledRowIds, []);

  replacementAccount = { email: "next@example.com", accessToken: "next-token" };
  await processAutoCycleFailures(rowsRef.current);

  const replacement = rowsRef.current.find((row) => row.id === "replacement-1");
  assert.equal(replacement.email, "next@example.com");
  assert.equal(replacement.cdkey, failedRow.cdkey);
});
