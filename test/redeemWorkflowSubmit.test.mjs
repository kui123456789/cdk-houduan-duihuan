import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPooledSubmitRows,
  getSubmitAccountAvailability,
  isContinuationBlockingRow,
  mergeMissingQueryRows
} from "../src/state/redeemWorkflow.js";
import { useRedeemSubmit } from "../src/hooks/useRedeemSubmit.js";

test("buildPooledSubmitRows never pairs the same access token with two CDKs", () => {
  const accounts = [
    {
      lineNumber: 1,
      email: "first@example.com",
      accessToken: "same-at-token",
      source: "first@example.com---pw---2fa---same-at-token---t1"
    },
    {
      lineNumber: 2,
      email: "second@example.com",
      accessToken: "same-at-token",
      source: "second@example.com---pw---2fa---same-at-token---t2"
    },
    {
      lineNumber: 3,
      email: "third@example.com",
      accessToken: "unique-at-token",
      source: "third@example.com---pw---2fa---unique-at-token---t3"
    }
  ];
  const cdkeys = [
    { lineNumber: 1, cdkey: "CDK-001", channel: "ideal", channelLabel: "IDEAL 排队" },
    { lineNumber: 2, cdkey: "CDK-002", channel: "ideal", channelLabel: "IDEAL 排队" }
  ];

  const result = buildPooledSubmitRows({
    accounts,
    cdkeys,
    existingRows: [],
    blockedEmails: new Set()
  });

  assert.deepEqual(
    result.rows.map((row) => [row.email, row.accessToken, row.cdkey]),
    [
      ["first@example.com", "same-at-token", "CDK-001"],
      ["third@example.com", "unique-at-token", "CDK-002"]
    ]
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].reason, "AT 重复，已跳过，避免同一账号同时消耗多张卡密");
});

test("mergeMissingQueryRows ignores hidden history when creating visible query rows", () => {
  const rows = mergeMissingQueryRows(
    [
      {
        id: "history-1",
        cdkey: "CDK-A",
        status: "failed",
        statusLocked: true,
        autoCycleHandled: true,
        statusOwner: false
      }
    ],
    [
      {
        cdkey: "CDK-A",
        cdkeyLineNumber: 1,
        status: "unused"
      }
    ]
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[1].cdkey, "CDK-A");
  assert.equal(rows[1].status, "unused");
  assert.match(rows[1].id, /^query-extra-/);
});

test("buildPooledSubmitRows skips access tokens reserved by prior pool submissions", () => {
  const accounts = [
    {
      lineNumber: 1,
      email: "first@example.com",
      accessToken: "already-used-token",
      source: "first@example.com---pw---2fa---already-used-token---t1"
    },
    {
      lineNumber: 2,
      email: "second@example.com",
      accessToken: "next-token",
      source: "second@example.com---pw---2fa---next-token---t2"
    }
  ];
  const cdkeys = [
    { lineNumber: 1, cdkey: "CDK-001", channel: "ideal", channelLabel: "IDEAL 排队" },
    { lineNumber: 2, cdkey: "CDK-002", channel: "ideal", channelLabel: "IDEAL 排队" }
  ];

  const result = buildPooledSubmitRows({
    accounts,
    cdkeys,
    existingRows: [],
    blockedEmails: new Set(),
    reservedAccessTokens: ["already-used-token"]
  });

  assert.deepEqual(
    result.rows.map((row) => [row.email, row.accessToken, row.cdkey]),
    [["second@example.com", "next-token", "CDK-001"]]
  );
  assert.equal(result.errors[0].type, "account_reserved_token");
  assert.match(result.errors[0].reason, /本次兑换链路使用/);
});

test("account availability blocks an AT already owned by another active email row", () => {
  const availability = getSubmitAccountAvailability({
    accounts: [
      {
        email: "alias@example.com",
        accessToken: "shared-active-token"
      }
    ],
    rowList: [
      {
        email: "original@example.com",
        accessToken: "shared-active-token",
        cdkey: "CDK-OLD",
        status: "pending_dispatch",
        statusOwner: true
      }
    ]
  });

  assert.equal(availability.availableAccounts.length, 0);
  assert.equal(availability.blockedAccessTokens.has("shared-active-token"), true);
});

test("recent not-found submission remains a continuation blocking row", () => {
  const now = 4_000_000;
  assert.equal(
    isContinuationBlockingRow(
      {
        email: "reserved@example.com",
        accessToken: "reserved-token",
        cdkey: "CDK-OLD",
        status: "not_found",
        statusOwner: true,
        staleStatusGuard: true,
        retryHoldUntil: now + 60_000
      },
      { now }
    ),
    true
  );
});

test("pool-scoped zero-row submit skips cancelled fallback and returns continuation summary", async () => {
  const rowsRef = {
    current: [
      {
        id: "cancelled-1",
        status: "cancelled",
        cdkey: "OLD-CDK",
        email: "old@example.com",
        accessToken: "old-token"
      }
    ]
  };
  let callProxyCalled = false;

  const { submitRedeems } = useRedeemSubmit({
    rowsRef,
    accountValidation: {
      accounts: [{ email: "next@example.com", accessToken: "next-token" }],
      errors: []
    },
    submitCdkeyValidation: { cdkeys: [], errors: [] },
    getSubmitCdkeyValidation: (poolId) => ({
      cdkeys: [{ cdkey: "VIP-CDK", poolId, poolLabel: "VIP" }],
      errors: []
    }),
    autoCycleRef: { current: {} },
    accountCooldownsRef: { current: {} },
    accountAttemptLedgerRef: { current: {} },
    failedAccountsRef: { current: [] },
    failedRetryRows: [],
    setRows: (nextRows) => {
      rowsRef.current = typeof nextRows === "function" ? nextRows(rowsRef.current) : nextRows;
    },
    setErrors: () => {},
    setIsBusy: () => {},
    setStatusMessage: () => {},
    setPreflightSummary: () => {},
    setLastUpdatedAt: () => {},
    showToast: () => {},
    selectWorkspaceTab: () => {},
    stopPolling: () => {},
    startPolling: () => {},
    queryStatuses: async () => [],
    callProxy: async () => {
      callProxyCalled = true;
      throw new Error("cancelled fallback should not run for pool-scoped no-submit");
    },
    getRowCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: () => [],
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async () => ({
      availableCdkeys: [],
      errors: [],
      summary: { available: 0, used: 1, unknown: 0 }
    }),
    getSubmitAccountAvailability: () => ({
      blockedEmails: new Set(),
      availableAccounts: [{ email: "next@example.com", accessToken: "next-token" }]
    }),
    buildPooledSubmitRows: () => ({
      rows: [],
      waitingAccounts: 1,
      waitingCdkeys: 0,
      errors: []
    }),
    buildNoSubmitMessage: () => "no submit",
    isHistoricalAutoCycleRow: () => false,
    isContinuationBlockingRow: () => false,
    isCancelledResubmitRow: (row) => row.status === "cancelled",
    canRetryVisibleRow: () => false,
    canResubmitRedeemRow: () => true,
    isAccountAttemptBlocked: () => false,
    syncAttemptCooldowns: () => {},
    getAccountAttemptInfo: () => ({ limitReached: false, count: 0 }),
    getAccountCooldown: () => null,
    formatCooldownUntil: () => "",
    getResubmitBlockReason: () => "",
    describeSelectedRow: () => "",
    batchCount: () => 1,
    prepareAutoCycleForSubmit: () => {},
    decorateInitialAutoCycleRows: (rows) => rows,
    forgetDeletedRows: () => {},
    markSubmittedRowsInAutoCycle: () => {},
    recordAccountSubmissionAttempts: () => new Map(),
    getSubmittedAttemptNumber: () => 1,
    registerCooldownsFromRows: (rows) => rows,
    scheduleAutoCycleFailures: () => 0,
    releaseCancelledRowsToAutoCycle: () => {}
  });

  const summary = await submitRedeems({ poolId: "vip", poolLabel: "VIP" });

  assert.equal(callProxyCalled, false);
  assert.deepEqual(summary, {
    submitted: 0,
    poolId: "vip",
    waitingAccounts: 1,
    pollableCdkeys: []
  });
});

test("pool continuation submit does not reuse access tokens reserved by previous pools", async () => {
  const rowsRef = { current: [] };
  const submittedBodies = [];
  const accounts = [
    {
      lineNumber: 1,
      email: "first@example.com",
      accessToken: "first-token",
      source: "first@example.com---pw---2fa---first-token---t1"
    },
    {
      lineNumber: 2,
      email: "second@example.com",
      accessToken: "second-token",
      source: "second@example.com---pw---2fa---second-token---t2"
    }
  ];
  const cdkeys = [
    {
      lineNumber: 1,
      cdkey: "POOL2-CDK-1",
      channel: "ideal",
      channelLabel: "IDEAL 排队",
      poolId: "ideal",
      poolLabel: "IDEAL"
    },
    {
      lineNumber: 2,
      cdkey: "POOL2-CDK-2",
      channel: "ideal",
      channelLabel: "IDEAL 排队",
      poolId: "ideal",
      poolLabel: "IDEAL"
    }
  ];

  const { submitRedeems } = useRedeemSubmit({
    rowsRef,
    accountValidation: { accounts, errors: [] },
    submitCdkeyValidation: { cdkeys, errors: [] },
    getSubmitCdkeyValidation: () => ({ cdkeys, errors: [] }),
    autoCycleRef: { current: {} },
    accountCooldownsRef: { current: {} },
    accountAttemptLedgerRef: { current: {} },
    failedAccountsRef: { current: [] },
    failedRetryRows: [],
    setRows: (nextRows) => {
      rowsRef.current = typeof nextRows === "function" ? nextRows(rowsRef.current) : nextRows;
    },
    setErrors: () => {},
    setIsBusy: () => {},
    setStatusMessage: () => {},
    setPreflightSummary: () => {},
    setLastUpdatedAt: () => {},
    showToast: () => {},
    selectWorkspaceTab: () => {},
    stopPolling: () => {},
    startPolling: () => {},
    queryStatuses: async (_cdkeys, options = {}) => options.baseRows || rowsRef.current,
    callProxy: async (_path, body) => {
      submittedBodies.push(body);
      return { items: [] };
    },
    getRowCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: () => [],
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async (targetCdkeys) => ({
      availableCdkeys: targetCdkeys,
      errors: [],
      summary: { available: targetCdkeys.length, used: 0, unknown: 0 }
    }),
    getSubmitAccountAvailability: () => ({
      blockedEmails: new Set(),
      availableAccounts: accounts
    }),
    buildPooledSubmitRows,
    buildNoSubmitMessage: () => "no submit",
    isHistoricalAutoCycleRow: () => false,
    isContinuationBlockingRow: () => false,
    isCancelledResubmitRow: () => false,
    canRetryVisibleRow: () => false,
    canResubmitRedeemRow: () => true,
    isAccountAttemptBlocked: () => false,
    syncAttemptCooldowns: () => {},
    getAccountAttemptInfo: () => ({ limitReached: false, count: 0 }),
    getAccountCooldown: () => null,
    formatCooldownUntil: () => "",
    getResubmitBlockReason: () => "",
    describeSelectedRow: () => "",
    batchCount: () => 1,
    prepareAutoCycleForSubmit: () => {},
    decorateInitialAutoCycleRows: (rows) => rows,
    forgetDeletedRows: () => {},
    markSubmittedRowsInAutoCycle: () => {},
    recordAccountSubmissionAttempts: () => new Map([["second@example.com", 1]]),
    getSubmittedAttemptNumber: () => 1,
    registerCooldownsFromRows: (rows) => rows,
    scheduleAutoCycleFailures: () => 0,
    releaseCancelledRowsToAutoCycle: () => {}
  });

  const summary = await submitRedeems({
    poolId: "ideal",
    poolLabel: "IDEAL",
    reservedAccessTokens: ["first-token"]
  });

  assert.equal(submittedBodies.length, 1);
  assert.deepEqual(submittedBodies[0].items, [
    {
      cdkey: "POOL2-CDK-1",
      access_token: "second-token",
      channel: "ideal"
    }
  ]);
  assert.deepEqual(summary.submittedAccessTokens, ["second-token"]);
});

test("submit starts polling immediately after accepted submit before status refresh", async () => {
  const rowsRef = { current: [] };
  const events = [];
  const accounts = [
    {
      lineNumber: 1,
      email: "first@example.com",
      accessToken: "first-token",
      source: "first@example.com---pw---2fa---first-token---t1"
    }
  ];
  const cdkeys = [
    {
      lineNumber: 1,
      cdkey: "CDK-A",
      channel: "ideal",
      channelLabel: "IDEAL 排队",
      poolId: "ideal",
      poolLabel: "IDEAL"
    }
  ];

  const { submitRedeems } = useRedeemSubmit({
    rowsRef,
    accountValidation: { accounts, errors: [] },
    submitCdkeyValidation: { cdkeys, errors: [] },
    getSubmitCdkeyValidation: () => ({ cdkeys, errors: [] }),
    autoCycleRef: { current: {} },
    accountCooldownsRef: { current: {} },
    accountAttemptLedgerRef: { current: {} },
    failedAccountsRef: { current: [] },
    failedRetryRows: [],
    setRows: (nextRows) => {
      rowsRef.current = typeof nextRows === "function" ? nextRows(rowsRef.current) : nextRows;
    },
    setErrors: () => {},
    setIsBusy: () => {},
    setStatusMessage: () => {},
    setPreflightSummary: () => {},
    setLastUpdatedAt: () => {},
    showToast: () => {},
    selectWorkspaceTab: () => {},
    stopPolling: () => {
      events.push("stopPolling");
    },
    startPolling: (pollingCdkeys) => {
      events.push(`startPolling:${pollingCdkeys.join(",")}`);
    },
    queryStatuses: async (_cdkeys, options = {}) => {
      events.push(`queryStatuses:${_cdkeys.join(",")}`);
      return options.baseRows || rowsRef.current;
    },
    callProxy: async () => ({ items: [] }),
    getRowCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async (targetCdkeys) => ({
      availableCdkeys: targetCdkeys,
      errors: [],
      summary: { available: targetCdkeys.length, used: 0, unknown: 0 }
    }),
    getSubmitAccountAvailability: () => ({
      blockedEmails: new Set(),
      availableAccounts: accounts
    }),
    buildPooledSubmitRows,
    buildNoSubmitMessage: () => "no submit",
    isHistoricalAutoCycleRow: () => false,
    isContinuationBlockingRow: () => false,
    isCancelledResubmitRow: () => false,
    canRetryVisibleRow: () => false,
    canResubmitRedeemRow: () => true,
    isAccountAttemptBlocked: () => false,
    syncAttemptCooldowns: () => {},
    getAccountAttemptInfo: () => ({ limitReached: false, count: 0 }),
    getAccountCooldown: () => null,
    formatCooldownUntil: () => "",
    getResubmitBlockReason: () => "",
    describeSelectedRow: () => "",
    batchCount: () => 1,
    prepareAutoCycleForSubmit: () => {},
    decorateInitialAutoCycleRows: (rows) => rows,
    forgetDeletedRows: () => {},
    markSubmittedRowsInAutoCycle: () => {},
    recordAccountSubmissionAttempts: () => new Map([["first@example.com", 1]]),
    getSubmittedAttemptNumber: () => 1,
    registerCooldownsFromRows: (rows) => rows,
    scheduleAutoCycleFailures: () => 0,
    releaseCancelledRowsToAutoCycle: () => {}
  });

  await submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.deepEqual(
    events.filter((event) => event.startsWith("startPolling") || event.startsWith("queryStatuses")),
    ["startPolling:CDK-A", "queryStatuses:CDK-A"]
  );
});

test("retryRows restarts polling after the retry request", async () => {
  const retryRow = {
    id: "retry-1",
    email: "retry@example.com",
    accessToken: "retry-token",
    cdkey: "CDK-RETRY",
    status: "failed",
    can_retry: true,
    can_reuse_token: true
  };
  const rowsRef = { current: [retryRow] };
  let startPollingCalled = false;
  let retryRequested = false;

  const { retryRows } = useRedeemSubmit({
    rowsRef,
    accountValidation: { accounts: [], errors: [] },
    submitCdkeyValidation: { cdkeys: [], errors: [] },
    getSubmitCdkeyValidation: () => ({ cdkeys: [], errors: [] }),
    autoCycleRef: { current: {} },
    accountCooldownsRef: { current: {} },
    accountAttemptLedgerRef: { current: {} },
    failedAccountsRef: { current: [] },
    failedRetryRows: [],
    setRows: (nextRows) => {
      rowsRef.current = typeof nextRows === "function" ? nextRows(rowsRef.current) : nextRows;
    },
    setErrors: () => {},
    setIsBusy: () => {},
    setStatusMessage: () => {},
    setPreflightSummary: () => {},
    setLastUpdatedAt: () => {},
    showToast: () => {},
    selectWorkspaceTab: () => {},
    stopPolling: () => {},
    startPolling: () => {
      startPollingCalled = true;
    },
    queryStatuses: async () => rowsRef.current,
    callProxy: async (path) => {
      retryRequested = path === "/api/redeem/retry";
      return { items: [] };
    },
    getRowCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async () => ({ availableCdkeys: [], errors: [], summary: {} }),
    getSubmitAccountAvailability: () => ({ blockedEmails: new Set(), availableAccounts: [] }),
    buildPooledSubmitRows,
    buildNoSubmitMessage: () => "no submit",
    isHistoricalAutoCycleRow: () => false,
    isContinuationBlockingRow: () => false,
    isCancelledResubmitRow: () => false,
    canRetryVisibleRow: () => true,
    canResubmitRedeemRow: () => false,
    isAccountAttemptBlocked: () => false,
    syncAttemptCooldowns: () => {},
    getAccountAttemptInfo: () => ({ limitReached: false, count: 0 }),
    getAccountCooldown: () => null,
    formatCooldownUntil: () => "",
    getResubmitBlockReason: () => "",
    describeSelectedRow: () => "",
    batchCount: () => 1,
    prepareAutoCycleForSubmit: () => {},
    decorateInitialAutoCycleRows: (rows) => rows,
    forgetDeletedRows: () => {},
    markSubmittedRowsInAutoCycle: () => {},
    recordAccountSubmissionAttempts: () => new Map([["retry@example.com", 1]]),
    getSubmittedAttemptNumber: () => 1,
    registerCooldownsFromRows: (rows) => rows,
    scheduleAutoCycleFailures: () => 0,
    releaseCancelledRowsToAutoCycle: () => {}
  });

  await retryRows([retryRow]);

  assert.equal(retryRequested, true);
  assert.equal(startPollingCalled, true);
});

test("submit logs the exact CDKs queried during preflight", async () => {
  const rowsRef = { current: [] };
  const statusMessages = [];
  const accounts = [
    {
      lineNumber: 1,
      email: "first@example.com",
      accessToken: "first-token",
      source: "first@example.com---pw---2fa---first-token---t1"
    }
  ];
  const cdkeys = [
    {
      lineNumber: 1,
      cdkey: "CDK-A",
      channel: "ideal",
      channelLabel: "IDEAL 排队",
      poolId: "ideal",
      poolLabel: "IDEAL"
    },
    {
      lineNumber: 2,
      cdkey: "CDK-B",
      channel: "ideal",
      channelLabel: "IDEAL 排队",
      poolId: "ideal",
      poolLabel: "IDEAL"
    }
  ];

  const { submitRedeems } = useRedeemSubmit({
    rowsRef,
    accountValidation: { accounts, errors: [] },
    submitCdkeyValidation: { cdkeys, errors: [] },
    getSubmitCdkeyValidation: () => ({ cdkeys, errors: [] }),
    autoCycleRef: { current: {} },
    accountCooldownsRef: { current: {} },
    accountAttemptLedgerRef: { current: {} },
    failedAccountsRef: { current: [] },
    failedRetryRows: [],
    setRows: (nextRows) => {
      rowsRef.current = typeof nextRows === "function" ? nextRows(rowsRef.current) : nextRows;
    },
    setErrors: () => {},
    setIsBusy: () => {},
    setStatusMessage: (message) => {
      statusMessages.push(String(message || ""));
    },
    setPreflightSummary: () => {},
    setLastUpdatedAt: () => {},
    showToast: () => {},
    selectWorkspaceTab: () => {},
    stopPolling: () => {},
    startPolling: () => {},
    queryStatuses: async (_cdkeys, options = {}) => options.baseRows || rowsRef.current,
    callProxy: async () => ({ items: [] }),
    getRowCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: () => [],
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async (targetCdkeys) => ({
      availableCdkeys: targetCdkeys.slice(0, 1),
      queriedCdkeys: ["CDK-A", "CDK-B"],
      errors: [],
      summary: { available: 1, used: 0, unknown: 0 }
    }),
    getSubmitAccountAvailability: () => ({
      blockedEmails: new Set(),
      availableAccounts: accounts
    }),
    buildPooledSubmitRows,
    buildNoSubmitMessage: () => "no submit",
    isHistoricalAutoCycleRow: () => false,
    isContinuationBlockingRow: () => false,
    isCancelledResubmitRow: () => false,
    canRetryVisibleRow: () => false,
    canResubmitRedeemRow: () => true,
    isAccountAttemptBlocked: () => false,
    syncAttemptCooldowns: () => {},
    getAccountAttemptInfo: () => ({ limitReached: false, count: 0 }),
    getAccountCooldown: () => null,
    formatCooldownUntil: () => "",
    getResubmitBlockReason: () => "",
    describeSelectedRow: () => "",
    batchCount: () => 1,
    prepareAutoCycleForSubmit: () => {},
    decorateInitialAutoCycleRows: (rows) => rows,
    forgetDeletedRows: () => {},
    markSubmittedRowsInAutoCycle: () => {},
    recordAccountSubmissionAttempts: () => new Map([["first@example.com", 1]]),
    getSubmittedAttemptNumber: () => 1,
    registerCooldownsFromRows: (rows) => rows,
    scheduleAutoCycleFailures: () => 0,
    releaseCancelledRowsToAutoCycle: () => {}
  });

  await submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.ok(
    statusMessages.some((message) =>
      message.includes("IDEAL：正在预检 2 张 CDK 状态")
    ),
    statusMessages.join("\n")
  );
  assert.ok(
    statusMessages.some((message) =>
      message.includes("IDEAL：本次实际查询 CDK 2 张：CDK-A、CDK-B")
    ),
    statusMessages.join("\n")
  );
});
