import assert from "node:assert/strict";
import test from "node:test";
import { canRetryRow, isQueryOnlyRow } from "../src/redeemLogic.js";
import {
  buildInputQueryPlan,
  buildPooledSubmitRows,
  ensureUniqueRowIds,
  getCurrentTaskRows,
  getVisibleRequestRows,
  getSubmitAccountAvailability,
  isContinuationBlockingRow,
  isHistoricalAutoCycleRow,
  mergeAccountsIntoAutoCycleQueue,
  mergeMissingQueryRows,
  restoreQueryAccountOwnership,
  restoreOrphanedAutoCycleRows
} from "../src/state/redeemWorkflow.js";
import {
  selectAccountsForAvailableCdkeys,
  selectSubmitAccountsForCredential,
  useRedeemSubmit
} from "../src/hooks/useRedeemSubmit.js";
import { getAccountCooldown } from "../src/state/accountLifecycle.js";

test("selectAccountsForAvailableCdkeys limits Session refresh work to usable CDKs", () => {
  const accounts = Array.from({ length: 100 }, (_, index) => ({ email: `user-${index}@example.com` }));
  assert.equal(selectAccountsForAvailableCdkeys(accounts, [{ cdkey: "CDK-1" }]).length, 1);
  assert.equal(selectAccountsForAvailableCdkeys(accounts, []).length, 0);
});

test("selectSubmitAccountsForCredential allows direct AT and Session accounts with the server key", () => {
  const ordinary = { email: "ordinary@example.com", sourceType: "account" };
  const session = { email: "session@example.com", sourceType: "session" };

  assert.deepEqual(
    selectSubmitAccountsForCredential([ordinary, session], { hasUserApiKey: false }),
    {
      accounts: [ordinary, session],
      blockedAccounts: [],
      credentialMode: "server"
    }
  );
  assert.deepEqual(
    selectSubmitAccountsForCredential([ordinary, session], { hasUserApiKey: true }),
    {
      accounts: [ordinary, session],
      blockedAccounts: [],
      credentialMode: ""
    }
  );
});

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

test("mergeMissingQueryRows recovers account ownership from hidden history", () => {
  const rows = mergeMissingQueryRows(
    [
      {
        id: "history-1",
        cdkey: "CDK-A",
        email: "owner@example.com",
        accessToken: "owner-token",
        sourceType: "session",
        accountLineNumber: 7,
        accountAttemptNumber: 2,
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
  assert.equal(rows[1].email, "owner@example.com");
  assert.equal(rows[1].accessToken, "owner-token");
  assert.equal(rows[1].sourceType, "session");
  assert.equal(rows[1].accountLineNumber, 7);
  assert.equal(rows[1].accountAttemptNumber, 2);
  assert.match(rows[1].id, /^query-extra-/);
});

test("mergeMissingQueryRows keeps truly unknown CDKs as query-only rows", () => {
  const rows = mergeMissingQueryRows([], [{ cdkey: "CDK-UNKNOWN", status: "unused" }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, undefined);
  assert.equal(rows[0].accessToken, undefined);
});

test("mergeMissingQueryRows gives different CDKs collision-free ids", () => {
  const baseRows = [{ id: "existing", cdkey: "CDK-EXISTING", status: "success" }];
  const first = mergeMissingQueryRows(baseRows, [
    { cdkey: "CDK-A", cdkeyLineNumber: 1, status: "unused" }
  ]);
  const second = mergeMissingQueryRows(baseRows, [
    { cdkey: "CDK-B", cdkeyLineNumber: 1, status: "unused" }
  ]);

  assert.notEqual(first[1].id, second[1].id);
});

test("ensureUniqueRowIds repairs duplicate persisted row ids", () => {
  const rows = ensureUniqueRowIds([
    { id: "query-extra-23-1", cdkey: "CDK-A" },
    { id: "query-extra-23-1", cdkey: "CDK-B" }
  ]);

  assert.equal(rows[0].id, "query-extra-23-1");
  assert.notEqual(rows[1].id, rows[0].id);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
});

test("account-scoped status query keeps only CDKs paired with emails", () => {
  const accounts = [
    { lineNumber: 1, email: "first@example.com", accessToken: "first-token" },
    { lineNumber: 2, email: "second@example.com", accessToken: "second-token" }
  ];
  const cdkeys = ["CDK-A", "CDK-B", "CDK-C", "CDK-D"].map((cdkey, index) => ({
    lineNumber: index + 1,
    cdkey,
    channel: "kakao",
    channelLabel: "KAKAO 排队",
    poolId: "kakao",
    poolLabel: "KAKAO"
  }));
  const existingRows = cdkeys.map((cdkey, index) => ({
    id: `query-only-${index}`,
    cdkey: cdkey.cdkey,
    status: "failed",
    can_retry: true,
    statusOwner: true
  }));

  const plan = buildInputQueryPlan({ accounts, cdkeys, existingRows });

  assert.deepEqual(
    plan.rows.map((row) => [row.email, row.cdkey]),
    [
      ["first@example.com", "CDK-A"],
      ["second@example.com", "CDK-B"]
    ]
  );
  assert.deepEqual(plan.selectedCdkeys.map((item) => item.cdkey), ["CDK-A", "CDK-B"]);
  assert.deepEqual(plan.unpairedCdkeys.map((item) => item.cdkey), ["CDK-C", "CDK-D"]);
  assert.equal(plan.rows.some((row) => !row.email), false);
  assert.equal(plan.rows.some((row) => row.cdkey === "CDK-C" || row.cdkey === "CDK-D"), false);
});

test("status query without accounts still supports query-only CDKs", () => {
  const cdkeys = [
    { lineNumber: 1, cdkey: "CDK-ONLY", channel: "ideal", channelLabel: "IDEAL 排队" }
  ];

  const plan = buildInputQueryPlan({ accounts: [], cdkeys, existingRows: [] });

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].cdkey, "CDK-ONLY");
  assert.equal(plan.rows[0].email, "");
  assert.equal(plan.rows[0].queryOnly, true);
  assert.equal(plan.rows[0].rowKind, "query");
  assert.equal(plan.rows[0].attemptRound, 0);
  assert.equal(plan.rows[0].attemptNumber, 0);
  assert.equal(plan.rows[0].accountAttemptNumber, 0);
  assert.equal(isQueryOnlyRow(plan.rows[0]), true);
  assert.deepEqual(plan.unpairedCdkeys, []);
});

test("repeated query without accounts replaces old query-only rows and keeps redeem rows", () => {
  const existingRows = [
    {
      id: "redeem-history",
      email: "owner@example.com",
      accessToken: "owner-token",
      exportLine: "owner@example.com---owner-token",
      cdkey: "CDK-REDEEMED",
      status: "failed",
      statusOwner: true
    },
    {
      id: "explicit-query-only",
      queryOnly: true,
      rowKind: "query",
      email: "",
      accessToken: "",
      cdkey: "CDK-OLD-EXPLICIT",
      status: "failed"
    },
    {
      id: "query-legacy-only",
      email: "",
      accessToken: "",
      cdkey: "CDK-OLD-LEGACY",
      status: "unused"
    }
  ];
  const cdkeys = [
    { lineNumber: 1, cdkey: "CDK-NEW", channel: "ideal", channelLabel: "IDEAL 排队" }
  ];

  const plan = buildInputQueryPlan({ accounts: [], cdkeys, existingRows });

  assert.deepEqual(plan.rows.map((row) => row.cdkey), ["CDK-REDEEMED", "CDK-NEW"]);
  assert.equal(plan.rows[0].id, "redeem-history");
  assert.equal(plan.rows[0].email, "owner@example.com");
  assert.equal(isQueryOnlyRow(plan.rows[0]), false);
  assert.equal(isQueryOnlyRow(plan.rows[1]), true);
  assert.equal(plan.rows.some((row) => row.id === "explicit-query-only"), false);
  assert.equal(plan.rows.some((row) => row.id === "query-legacy-only"), false);
});

test("query-only rows stay visible as results but are not current redeem tasks", () => {
  const queryOnlyRow = {
    id: "query-result",
    queryOnly: true,
    rowKind: "query",
    cdkey: "CDK-QUERY-RESULT",
    status: "unused"
  };
  const redeemRow = {
    id: "redeem-task",
    queryOnly: false,
    rowKind: "redeem",
    accessToken: "access-token",
    cdkey: "CDK-REDEEM",
    status: "running"
  };

  assert.deepEqual(getCurrentTaskRows([queryOnlyRow, redeemRow]), [redeemRow]);
});

test("restoreQueryAccountOwnership repairs persisted query-only rows", () => {
  const rows = restoreQueryAccountOwnership([
    {
      id: "history-owner",
      cdkey: "CDK-PERSISTED",
      email: "persisted@example.com",
      accessToken: "persisted-token",
      status: "failed",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    },
    {
      id: "query-only-current",
      cdkey: " cdk-persisted ",
      email: "",
      accessToken: "",
      status: "pending_dispatch",
      reason: "重试已发送，等待后台更新",
      statusOwner: true
    }
  ]);

  assert.equal(rows[1].email, "persisted@example.com");
  assert.equal(rows[1].accessToken, "persisted-token");
  assert.equal(rows[1].status, "pending_dispatch");
  assert.equal(rows[1].reason, "重试已发送，等待后台更新");
});

test("restoreOrphanedAutoCycleRows revives one current task for each hidden CDK", () => {
  const rows = restoreOrphanedAutoCycleRows([
    {
      id: "hidden-a",
      cdkey: "CDK-A",
      status: "failed",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false,
      autoCycleNextRowId: "missing-a"
    },
    {
      id: "hidden-b-old",
      cdkey: "CDK-B",
      status: "failed",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    },
    {
      id: "hidden-b-latest",
      cdkey: "CDK-B",
      status: "failed",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    }
  ]);

  assert.deepEqual(
    getCurrentTaskRows(rows).map((row) => row.id),
    ["hidden-a", "hidden-b-latest"]
  );
  assert.equal(rows[0].statusOwner, true);
  assert.equal(rows[0].autoCycleNextRowId, "");
  assert.equal(rows[1].statusOwner, false);
  assert.equal(rows[2].statusLocked, false);
});

test("restoreOrphanedAutoCycleRows keeps history hidden when a current replacement exists", () => {
  const original = [
    {
      id: "hidden",
      cdkey: "CDK-A",
      status: "failed",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    },
    {
      id: "replacement",
      cdkey: "CDK-A",
      status: "pending_dispatch",
      statusLocked: false,
      autoCycleHandled: false,
      statusOwner: true
    }
  ];

  const rows = restoreOrphanedAutoCycleRows(original);
  assert.equal(rows, original);
  assert.deepEqual(getCurrentTaskRows(rows).map((row) => row.id), ["replacement"]);
});

test("getVisibleRequestRows hides cooling and historical rows without deleting active state", () => {
  const now = 1_000;
  const rows = [
    {
      id: "visible",
      cdkey: "CDK-VISIBLE",
      status: "pending_dispatch",
      statusOwner: true,
      accountCooldownUntil: 0
    },
    {
      id: "cooling",
      cdkey: "CDK-COOLING",
      status: "failed",
      statusOwner: true,
      accountCooldownUntil: now + 60_000
    },
    {
      id: "history",
      cdkey: "CDK-HISTORY",
      status: "failed",
      statusOwner: false,
      statusLocked: true,
      autoCycleHandled: true
    }
  ];

  assert.deepEqual(getVisibleRequestRows(rows, now).map((row) => row.id), ["visible"]);
  assert.equal(rows.length, 3);
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

test("account availability blocks accounts archived in the failed group", () => {
  const availability = getSubmitAccountAvailability({
    accounts: [
      { email: "failed@example.com", accessToken: "failed-token" },
      { email: "ready@example.com", accessToken: "ready-token" }
    ],
    failedAccounts: [
      {
        email: "FAILED@example.com",
        failedReason: "自动换号已达到最大轮次"
      }
    ]
  });

  assert.deepEqual(
    availability.availableAccounts.map((account) => account.email),
    ["ready@example.com"]
  );
  assert.equal(availability.blockedEmails.has("failed@example.com"), true);
  assert.equal(availability.counts.failedGroup, 1);
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
      accessToken: "second-token",
      channel: "ideal"
    }
  ]);
  assert.deepEqual(summary.submittedAccessTokens, ["second-token"]);
});

test("direct AT submit without a user key uses the server credential", async () => {
  const rowsRef = { current: [] };
  const events = [];
  const accounts = [
    {
      lineNumber: 1,
      email: "ordinary@example.com",
      accessToken: "ordinary-token",
      sourceType: "account",
      source: "ordinary@example.com---ordinary-token"
    },
    {
      lineNumber: 2,
      email: "session@example.com",
      accessToken: "session-token",
      sourceType: "session",
      source: "session-json"
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
    hasUserApiKey: () => false,
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
    callProxy: async (_path, body, options) => {
      events.push(`submit:${body.items[0].access_token}:${options?.credentialMode || ""}`);
      return { items: [] };
    },
    getRowCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: (rows) => rows.map((row) => row.cdkey).filter(Boolean),
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async (targetCdkeys, _existingRows, options) => {
      events.push(`preflight:${options?.credentialMode || ""}`);
      return {
        availableCdkeys: targetCdkeys,
        errors: [],
        summary: { available: targetCdkeys.length, used: 0, unknown: 0 }
      };
    },
    getSubmitAccountAvailability: ({ accounts: candidateAccounts }) => ({
      blockedEmails: new Set(),
      availableAccounts: candidateAccounts
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
    recordAccountSubmissionAttempts: () => new Map([["session@example.com", 1]]),
    getSubmittedAttemptNumber: () => 1,
    registerCooldownsFromRows: (rows) => rows,
    scheduleAutoCycleFailures: () => 0,
    releaseCancelledRowsToAutoCycle: () => {}
  });

  await submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.deepEqual(
    events,
    [
      "stopPolling",
      "preflight:server",
      "submit:ordinary-token:server",
      "startPolling:CDK-A",
      "queryStatuses:CDK-A"
    ]
  );
  assert.equal(rowsRef.current[0].credentialMode, "server");
});

test("retryRows restarts polling after the retry request", async () => {
  const retryRow = {
    id: "retry-1",
    email: "retry@example.com",
    accessToken: "retry-token",
    cdkey: "CDK-RETRY",
    sourceType: "session",
    status: "failed",
    can_retry: true,
    can_reuse_token: true
  };
  const rowsRef = { current: [retryRow] };
  let startPollingCalled = false;
  let retryRequested = false;
  let retryCredentialMode = "";

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
    hasUserApiKey: () => false,
    stopPolling: () => {},
    startPolling: () => {
      startPollingCalled = true;
    },
    queryStatuses: async () => rowsRef.current,
    callProxy: async (path, _body, options) => {
      retryRequested = path === "/api/redeem/retry";
      retryCredentialMode = options?.credentialMode || "";
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
  assert.equal(retryCredentialMode, "server");
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

function createActionHarness(rows, payload, options = {}) {
  const rowsRef = { current: rows };
  const queried = [];
  const released = [];
  const requestedPaths = [];
  const requestedCalls = [];
  let recordedRows = [];
  const hook = useRedeemSubmit({
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
    hasUserApiKey: () => false,
    stopPolling: () => {},
    startPolling: () => {},
    queryStatuses: async (cdkeys) => {
      queried.push(...cdkeys);
      return rowsRef.current;
    },
    callProxy: async (path, body, callOptions) => {
      requestedPaths.push(path);
      requestedCalls.push({ path, body, options: callOptions });
      return payload;
    },
    getRowCdkeys: (targetRows) => targetRows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: () => [],
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async () => ({ availableCdkeys: [], errors: [], summary: {} }),
    getSubmitAccountAvailability: () => ({ blockedEmails: new Set(), availableAccounts: [] }),
    buildPooledSubmitRows,
    buildNoSubmitMessage: () => "no submit",
    isHistoricalAutoCycleRow: () => false,
    isContinuationBlockingRow: () => false,
    isCancelledResubmitRow: () => false,
    canRetryVisibleRow: options.canRetryVisibleRow || (() => true),
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
    decorateInitialAutoCycleRows: (value) => value,
    forgetDeletedRows: () => {},
    markSubmittedRowsInAutoCycle: () => {},
    recordAccountSubmissionAttempts: (targetRows) => {
      recordedRows = targetRows;
      return new Map();
    },
    getSubmittedAttemptNumber: (row) => row.accountAttemptNumber || 1,
    registerCooldownsFromRows: (value) => value,
    scheduleAutoCycleFailures: () => 0,
    releaseCancelledRowsToAutoCycle: (targetRows) => released.push(...targetRows)
  });
  return {
    ...hook,
    rowsRef,
    queried,
    released,
    requestedPaths,
    requestedCalls,
    getRecordedRows: () => recordedRows
  };
}

test("retryRows never sends a backend request for a query-only failure", async () => {
  const queryOnlyRow = {
    id: "query-only-failed",
    queryOnly: true,
    rowKind: "query",
    email: "",
    accessToken: "",
    cdkey: "CDK-QUERY-ONLY",
    status: "failed",
    can_retry: true,
    can_reuse_token: true,
    has_access_token: true
  };
  const harness = createActionHarness(
    [queryOnlyRow],
    { items: [{ cdkey: queryOnlyRow.cdkey, status: "queued" }] },
    { canRetryVisibleRow: canRetryRow }
  );

  await harness.retryRows([queryOnlyRow]);

  assert.deepEqual(harness.requestedPaths, []);
  assert.equal(harness.rowsRef.current[0].status, "failed");
});

test("partial cancel response releases only the explicitly confirmed CDK", async () => {
  const rows = [
    { id: "a", cdkey: "CDK-A", sourceType: "session", status: "running", staleStatusGuard: true },
    { id: "b", cdkey: "CDK-B", sourceType: "session", status: "running", staleStatusGuard: true }
  ];
  const harness = createActionHarness(rows, {
    items: [{ cdkey: "CDK-A", status: "cancelled" }],
    backend: { emptyResponse: false, itemCount: 1 }
  });

  await harness.runJobAction({
    path: "/api/redeem/cancel",
    rowsToAct: rows,
    pendingMessage: "cancel",
    doneMessage: "cancelled",
    clearStaleStatusGuard: true,
    afterSuccess: ({ rowsToAct }) => harness.released.push(...rowsToAct)
  });

  assert.deepEqual(harness.released.map((row) => row.cdkey), ["CDK-A"]);
  assert.equal(harness.rowsRef.current.find((row) => row.id === "a").staleStatusGuard, false);
  assert.equal(harness.rowsRef.current.find((row) => row.id === "b").staleStatusGuard, true);
  assert.deepEqual(harness.queried, ["CDK-A", "CDK-B"]);
});

test("empty retry response does not count attempts and protects the task while status is unconfirmed", async () => {
  const rows = [
    { id: "a", cdkey: "CDK-A", sourceType: "session", status: "failed", can_retry: true }
  ];
  const harness = createActionHarness(rows, {
    items: [],
    backend: { emptyResponse: true, itemCount: 0 }
  });

  await harness.runJobAction({
    path: "/api/redeem/retry",
    rowsToAct: rows,
    pendingMessage: "retry",
    doneMessage: "retried",
    afterActionStatus: "pending_dispatch",
    afterActionReason: "retry sent",
    countAccountAttempt: true
  });

  assert.deepEqual(harness.getRecordedRows(), []);
  assert.equal(harness.rowsRef.current[0].status, "pending_dispatch");
  assert.equal(harness.rowsRef.current[0].can_retry, false);
  assert.equal(harness.rowsRef.current[0].staleStatusGuard, true);
  assert.ok(Number(harness.rowsRef.current[0].retryHoldUntil || 0) > 0);
  assert.deepEqual(harness.queried, ["CDK-A"]);
});

test("unchanged failed task details do not fake a confirmed retry or consume an attempt", async () => {
  const row = {
    id: "failed-task",
    cdkey: "CDK-FAILED-TASK",
    channel: "ideal",
    status: "failed",
    can_retry: true,
    can_reuse_token: true,
    has_access_token: true
  };
  const harness = createActionHarness(
    [row],
    {
      items: [
        {
          task_id: "existing-task-id",
          cdkey: row.cdkey,
          status: "failed",
          can_retry: true,
          can_reuse_token: true,
          has_access_token: true
        }
      ]
    },
    { canRetryVisibleRow: canRetryRow }
  );

  await harness.retryRows([row]);

  assert.deepEqual(harness.getRecordedRows(), []);
  assert.equal(harness.rowsRef.current[0].status, "failed");
  assert.equal(harness.rowsRef.current[0].staleStatusGuard, false);
  assert.equal(harness.rowsRef.current[0].retryHoldUntil, 0);
});

test("retry request carries the failed row channel", async () => {
  const row = {
    id: "retry-channel",
    email: "channel@example.com",
    accessToken: "channel-at",
    cdkey: "CDK-CHANNEL",
    channel: "ideal",
    status: "failed",
    can_retry: true,
    can_reuse_token: true,
    has_access_token: true
  };
  const harness = createActionHarness(
    [row],
    { items: [{ cdkey: row.cdkey, status: "queued", retried: true }] },
    { canRetryVisibleRow: canRetryRow }
  );

  await harness.retryRows([row]);

  const retryCall = harness.requestedCalls.find((call) => call.path === "/api/redeem/retry");
  assert.equal(retryCall.body.channel, "ideal");
  assert.deepEqual(retryCall.body.cdkeys, ["CDK-CHANNEL"]);
});

function createInitialSubmitHarness({
  rows = [],
  accounts = [],
  cdkeys = [],
  cooldowns = {},
  canRetryVisibleRow = () => false,
  automaticRetryInFlightRef = { current: new Set() },
  callProxy
} = {}) {
  const rowsRef = { current: rows };
  const submittedBodies = [];
  const queried = [];
  const polling = [];
  const busyStates = [];
  const statusMessages = [];
  const scheduledRows = [];
  let recordedRows = [];

  const hook = useRedeemSubmit({
    rowsRef,
    accountValidation: { accounts, errors: [] },
    submitCdkeyValidation: { cdkeys, errors: [] },
    getSubmitCdkeyValidation: () => ({ cdkeys, errors: [] }),
    autoCycleRef: { current: {} },
    accountCooldownsRef: { current: cooldowns },
    accountAttemptLedgerRef: { current: {} },
    failedAccountsRef: { current: [] },
    failedRetryRows: [],
    setRows: (nextRows) => {
      rowsRef.current = typeof nextRows === "function" ? nextRows(rowsRef.current) : nextRows;
    },
    setErrors: () => {},
    setIsBusy: (value) => busyStates.push(value),
    setStatusMessage: (message) => statusMessages.push(String(message || "")),
    setPreflightSummary: () => {},
    setLastUpdatedAt: () => {},
    showToast: () => {},
    selectWorkspaceTab: () => {},
    hasUserApiKey: () => true,
    prepareSubmitAccounts: async (candidateAccounts) => ({ accounts: candidateAccounts, errors: [] }),
    stopPolling: () => {},
    startPolling: (targetCdkeys) => polling.push([...targetCdkeys]),
    queryStatuses: async (targetCdkeys, options = {}) => {
      queried.push([...targetCdkeys]);
      return options.baseRows || rowsRef.current;
    },
    callProxy: async (path, body, options) => {
      submittedBodies.push({ path, body, options });
      if (callProxy) return callProxy(path, body, options);
      return {
        items: body.items.map((item) => ({ cdkey: item.cdkey, status: "queued" }))
      };
    },
    getRowCdkeys: (targetRows) => targetRows.map((row) => row.cdkey).filter(Boolean),
    getPollableCdkeys: (targetRows) => targetRows.map((row) => row.cdkey).filter(Boolean),
    getBackendResponseNotice: () => "",
    preflightCdkeysForSubmit: async (targetCdkeys) => ({
      availableCdkeys: targetCdkeys,
      queriedCdkeys: targetCdkeys.map((item) => item.cdkey),
      errors: [],
      summary: { available: targetCdkeys.length, used: 0, unknown: 0 }
    }),
    getSubmitAccountAvailability,
    buildPooledSubmitRows,
    buildNoSubmitMessage: () => "没有可提交的新账号",
    isHistoricalAutoCycleRow,
    isContinuationBlockingRow,
    canRetryVisibleRow,
    canResubmitRedeemRow: () => true,
    isAccountAttemptBlocked: () => false,
    syncAttemptCooldowns: () => {},
    getAccountAttemptInfo: () => ({ limitReached: false, count: 0 }),
    getAccountCooldown,
    formatCooldownUntil: () => "",
    getResubmitBlockReason: () => "",
    describeSelectedRow: (row) => row.email || row.cdkey || "task",
    batchCount: () => 1,
    prepareAutoCycleForSubmit: () => {},
    decorateInitialAutoCycleRows: (value) => value,
    forgetDeletedTaskRows: () => {},
    forgetDeletedRows: () => {},
    markSubmittedRowsInAutoCycle: () => {},
    recordAccountSubmissionAttempts: (targetRows) => {
      recordedRows = targetRows;
      return new Map(targetRows.map((row) => [row.email, 1]));
    },
    getSubmittedAttemptNumber: () => 1,
    registerCooldownsFromRows: (value) => value,
    scheduleAutoCycleFailures: (targetRows) => {
      scheduledRows.push(targetRows);
      return targetRows.filter((row) => row.status === "failed").length;
    },
    releaseCancelledRowsToAutoCycle: () => {},
    automaticRetryInFlightRef
  });

  return {
    ...hook,
    rowsRef,
    submittedBodies,
    queried,
    polling,
    busyStates,
    statusMessages,
    scheduledRows,
    getRecordedRows: () => recordedRows
  };
}

test("start redeem ignores selected cooling history and submits the newly imported account", async () => {
  const now = Date.now();
  const oldAccount = {
    lineNumber: 1,
    email: "old@example.com",
    accessToken: "old-token",
    source: "old@example.com---old-token"
  };
  const newAccount = {
    lineNumber: 2,
    email: "new@example.com",
    accessToken: "new-token",
    source: "new@example.com---new-token"
  };
  const oldRow = {
    id: "old-row",
    email: oldAccount.email,
    accessToken: oldAccount.accessToken,
    cdkey: "OLD-CDK",
    channel: "ideal",
    status: "failed",
    selected: true,
    accountCooldownUntil: now + 60_000,
    accountCooldownReason: "24 小时内已提交 3 次"
  };
  const harness = createInitialSubmitHarness({
    rows: [oldRow],
    accounts: [oldAccount, newAccount],
    cdkeys: [
      {
        lineNumber: 1,
        cdkey: "NEW-CDK",
        channel: "ideal",
        channelLabel: "IDEAL 排队",
        poolId: "ideal",
        poolLabel: "IDEAL"
      }
    ],
    cooldowns: {
      [oldAccount.email]: {
        email: oldAccount.email,
        until: now + 60_000,
        reason: "24 小时内已提交 3 次"
      }
    }
  });

  await harness.submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.equal(harness.submittedBodies.length, 1);
  assert.deepEqual(harness.submittedBodies[0].body.items, [
    {
      cdkey: "NEW-CDK",
      access_token: "new-token",
      accessToken: "new-token",
      channel: "ideal"
    }
  ]);
  assert.equal(harness.rowsRef.current.some((row) => row.id === oldRow.id), true);
  assert.equal(harness.rowsRef.current.find((row) => row.id === oldRow.id).status, "failed");
  assert.equal(harness.rowsRef.current.some((row) => row.email === newAccount.email), true);
});

test("start redeem never falls back to a selected cancelled task when no new account is available", async () => {
  const now = Date.now();
  const oldAccount = {
    lineNumber: 1,
    email: "old@example.com",
    accessToken: "old-token",
    source: "old@example.com---old-token"
  };
  const oldRow = {
    id: "cancelled-old-row",
    email: oldAccount.email,
    accessToken: oldAccount.accessToken,
    cdkey: "OLD-CDK",
    channel: "ideal",
    status: "cancelled",
    selected: true,
    accountCooldownUntil: now + 60_000
  };
  const harness = createInitialSubmitHarness({
    rows: [oldRow],
    accounts: [oldAccount],
    cdkeys: [{ lineNumber: 1, cdkey: "NEW-CDK", channel: "ideal", poolId: "ideal" }],
    cooldowns: {
      [oldAccount.email]: { email: oldAccount.email, until: now + 60_000, reason: "冷却中" }
    }
  });

  const summary = await harness.submitRedeems();

  assert.equal(harness.submittedBodies.length, 0);
  assert.equal(summary.submitted, 0);
  assert.equal(harness.rowsRef.current[0].status, "cancelled");
  assert.ok(harness.statusMessages.some((message) => message.includes("没有可提交的新账号")));
});

test("submit failure stays non-retryable until status reconciliation confirms failure", async () => {
  const account = {
    lineNumber: 1,
    email: "new@example.com",
    accessToken: "new-token",
    source: "new@example.com---new-token"
  };
  const harness = createInitialSubmitHarness({
    accounts: [account],
    cdkeys: [{ lineNumber: 1, cdkey: "CDK-ERROR", channel: "ideal", poolId: "ideal" }],
    callProxy: async () => {
      throw new Error("network unavailable");
    }
  });

  await harness.submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.equal(harness.rowsRef.current.length, 1);
  assert.equal(harness.rowsRef.current[0].status, "unknown");
  assert.equal(harness.rowsRef.current[0].can_retry, false);
  assert.match(harness.rowsRef.current[0].reason, /状态未确认.*network unavailable/);
  assert.deepEqual(harness.busyStates, [true, false]);
  assert.deepEqual(harness.polling, [["CDK-ERROR"]]);
  assert.deepEqual(harness.queried, [["CDK-ERROR"]]);
  assert.deepEqual(harness.getRecordedRows(), []);
});

test("unconfirmed initial submit response does not enter retry or consume an attempt", async () => {
  const account = {
    lineNumber: 1,
    email: "new@example.com",
    accessToken: "new-token",
    source: "new@example.com---new-token"
  };
  const harness = createInitialSubmitHarness({
    accounts: [account],
    cdkeys: [{ lineNumber: 1, cdkey: "CDK-UNCONFIRMED", channel: "ideal", poolId: "ideal" }],
    callProxy: async () => ({
      items: [],
      backend: { emptyResponse: true, itemCount: 0 }
    })
  });

  await harness.submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.equal(harness.rowsRef.current.length, 1);
  assert.equal(harness.rowsRef.current[0].status, "unknown");
  assert.equal(harness.rowsRef.current[0].can_retry, false);
  assert.match(harness.rowsRef.current[0].reason, /响应未确认/);
  assert.deepEqual(harness.getRecordedRows(), []);
  assert.deepEqual(harness.queried, [["CDK-UNCONFIRMED"]]);
});

test("direct AT first retryable backend failure immediately enters retry", async () => {
  const account = {
    lineNumber: 1,
    email: "direct-at@example.com",
    accessToken: "direct-at-token",
    credentialKind: "access_token",
    sourceType: "account",
    source: "direct-at@example.com---direct-at-token"
  };
  const harness = createInitialSubmitHarness({
    accounts: [account],
    cdkeys: [{ lineNumber: 1, cdkey: "CDK-RETRY-FIRST", channel: "ideal", poolId: "ideal" }],
    canRetryVisibleRow: canRetryRow,
    callProxy: async (path) => {
      if (path === "/api/redeem/retry") {
        return {
          items: [{ cdkey: "CDK-RETRY-FIRST", status: "queued" }]
        };
      }
      return {
        items: [
          {
            task_id: "task-retry-first",
            cdkey: "CDK-RETRY-FIRST",
            status: "failed",
            reason: "temporary backend failure",
            can_retry: true,
            can_reuse_token: true,
            has_access_token: true
          }
        ]
      };
    }
  });

  await harness.submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.deepEqual(
    harness.submittedBodies.map(({ path }) => path),
    ["/api/redeem/submit", "/api/redeem/retry"]
  );
  assert.equal(
    harness.submittedBodies[0].body.items[0].access_token,
    "direct-at-token"
  );
});

for (const scenario of [
  {
    name: "throws",
    retryResponse: async () => {
      throw new Error("retry transport unavailable");
    }
  },
  {
    name: "is unconfirmed",
    retryResponse: async () => ({
      items: [],
      backend: { emptyResponse: true, itemCount: 0 }
    })
  }
]) {
  test(`automatic retry ${scenario.name} protects the row before auto-cycle`, async () => {
    const cdkey = `CDK-AUTO-RETRY-${scenario.name.toUpperCase().replace(/\s+/g, "-")}`;
    const account = {
      lineNumber: 1,
      email: `${scenario.name.replace(/\s+/g, "-")}@example.com`,
      accessToken: `at-${scenario.name}`,
      credentialKind: "access_token",
      sourceType: "account"
    };
    const harness = createInitialSubmitHarness({
      accounts: [account],
      cdkeys: [{ lineNumber: 1, cdkey, channel: "ideal", poolId: "ideal" }],
      canRetryVisibleRow: canRetryRow,
      callProxy: async (path) => {
        if (path === "/api/redeem/retry") return scenario.retryResponse();
        return {
          items: [
            {
              task_id: `task-${scenario.name}`,
              cdkey,
              status: "failed",
              reason: "temporary backend failure",
              can_retry: true,
              can_reuse_token: true,
              has_access_token: true
            }
          ]
        };
      }
    });

    await harness.submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

    const row = harness.rowsRef.current.find((candidate) => candidate.cdkey === cdkey);
    assert.ok(["unknown", "pending_dispatch"].includes(row.status), row.status);
    assert.equal(row.can_retry, false);
    assert.equal(row.staleStatusGuard, true);
    assert.ok(Number(row.retryHoldUntil || 0) > 0);
    assert.equal(
      harness.scheduledRows.some((rows) =>
        rows.some((candidate) => candidate.cdkey === cdkey && candidate.status === "failed")
      ),
      false
    );
  });
}

test("an in-flight automatic retry cannot release the same CDK to auto-cycle", async () => {
  const cdkey = "CDK-AUTO-RETRY-IN-FLIGHT";
  const automaticRetryInFlightRef = { current: new Set([cdkey]) };
  const harness = createInitialSubmitHarness({
    accounts: [
      {
        lineNumber: 1,
        email: "in-flight@example.com",
        accessToken: "in-flight-at",
        credentialKind: "access_token",
        sourceType: "account"
      }
    ],
    cdkeys: [{ lineNumber: 1, cdkey, channel: "ideal", poolId: "ideal" }],
    canRetryVisibleRow: canRetryRow,
    automaticRetryInFlightRef,
    callProxy: async (path) => {
      assert.notEqual(path, "/api/redeem/retry");
      return {
        items: [
          {
            task_id: "task-in-flight",
            cdkey,
            status: "failed",
            reason: "temporary backend failure",
            can_retry: true,
            can_reuse_token: true,
            has_access_token: true
          }
        ]
      };
    }
  });

  await harness.submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.equal(
    harness.scheduledRows.some((rows) =>
      rows.some((row) => row.cdkey === cdkey && row.status === "failed")
    ),
    false
  );
  assert.equal(automaticRetryInFlightRef.current.has(cdkey), true);
});

test("immediate validation failure does not create a local attempt or trigger auto-cycle", async () => {
  const account = {
    lineNumber: 1,
    email: "invalid@example.com",
    accessToken: "invalid-token",
    source: "invalid@example.com---invalid-token"
  };
  const harness = createInitialSubmitHarness({
    accounts: [account],
    cdkeys: [{ lineNumber: 1, cdkey: "CDK-REJECTED", channel: "ideal", poolId: "ideal" }],
    callProxy: async () => ({
      items: [
        {
          cdkey: "CDK-REJECTED",
          status: "failed",
          reason: "access token validation failed"
        }
      ]
    })
  });

  await harness.submitRedeems({ poolId: "ideal", poolLabel: "IDEAL" });

  assert.equal(harness.rowsRef.current.length, 1);
  assert.equal(harness.rowsRef.current[0].status, "unknown");
  assert.equal(harness.rowsRef.current[0].can_retry, false);
  assert.match(harness.rowsRef.current[0].reason, /响应未确认/);
  assert.deepEqual(harness.getRecordedRows(), []);
  assert.deepEqual(harness.queried, [["CDK-REJECTED"]]);
  assert.equal(harness.scheduledRows.length, 1);
  assert.equal(harness.scheduledRows[0].some((row) => row.status === "failed"), false);
});

test("auto-cycle queue skips cooling accounts and accepts newly imported accounts", () => {
  const state = mergeAccountsIntoAutoCycleQueue(
    { enabled: true, currentRound: 1, queue: [] },
    [
      { email: "old@example.com", accessToken: "old-token" },
      { email: "new@example.com", accessToken: "new-token" }
    ],
    {
      isAccountCooling: (email) => email === "old@example.com",
      isAccountAttemptBlocked: () => false
    }
  );

  assert.deepEqual(state.queue.map((account) => account.email), ["new@example.com"]);
});
