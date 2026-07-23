import {
  createRedeemRow,
  DELIMITER,
  statusLabel
} from "../redeemLogic.js";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_ATTEMPT_WINDOW_MS,
  ACTIVE_BACKEND_STATUSES,
  AUTO_CYCLE_MAX_ROUNDS,
  EMPTY_PREFLIGHT_SUMMARY,
  RESUBMIT_REDEEM_STATUSES
} from "../config/redeemConstants.js";
import {
  formatCooldownUntil,
  isLimitCooldownReason,
  isRowAccountCooling,
  shouldBlockFourthAttempt
} from "./accountLifecycle.js";
import {
  getAccountAvailabilityFacts,
  getReservedAccountAccessTokens,
  isAccountTaskReservationRow,
  normalizeAccountLedger
} from "../workflow/accountLedger.js";

export function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeAccessToken(value) {
  return String(value || "").trim();
}

export function clampRound(value) {
  const round = Math.max(Number(value || 1), 1);
  return Math.min(round, AUTO_CYCLE_MAX_ROUNDS);
}

export function normalizeQueuedAccount(account, addedRound = 1) {
  const email = String(account?.email || "").trim().toLowerCase();
  if (!email) return null;
  const password = String(account?.password || "");
  const twofa = String(account?.twofa || "");
  const accessToken = String(account?.accessToken || "");
  const timestamp = String(account?.timestamp || "");
  return {
    email,
    password,
    twofa,
    accessToken,
    timestamp,
    source:
      account?.source ||
      [email, password, twofa, accessToken, timestamp].join(DELIMITER),
    exportLine: account?.exportLine || [email, password, twofa, timestamp].join(DELIMITER),
    addedRound: clampRound(account?.addedRound || addedRound)
  };
}

export function normalizeAccountQueue(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const queue = [];
  source.forEach((item) => {
    const account = normalizeQueuedAccount(item);
    if (!account || seen.has(account.email)) return;
    seen.add(account.email);
    queue.push(account);
  });
  return queue;
}

export function normalizeAutoCycleState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const roundUsage =
    source.roundUsage && typeof source.roundUsage === "object" && !Array.isArray(source.roundUsage)
      ? source.roundUsage
      : {};

  return {
    enabled: source.enabled === true,
    currentRound: clampRound(source.currentRound || 1),
    cursorIndex: Math.max(Number(source.cursorIndex || 0), 0),
    queue: normalizeAccountQueue(source.queue),
    roundUsage: Object.fromEntries(
      Object.entries(roundUsage).map(([round, emails]) => [
        String(clampRound(round)),
        normalizeStringArray(emails).map((email) => email.toLowerCase())
      ])
    ),
    handledRowIds: normalizeStringArray(source.handledRowIds),
    failedEmails: [],
    completedEmails: normalizeStringArray(source.completedEmails).map((email) => email.toLowerCase())
  };
}

export function getAutoCycleQueueKey(queue) {
  return (queue || [])
    .map((account) => {
      const normalized = normalizeQueuedAccount(account);
      if (!normalized) return "";
      return [
        normalized.email,
        normalized.password,
        normalized.twofa,
        normalized.accessToken,
        normalized.timestamp,
        normalized.source,
        normalized.exportLine,
        normalized.addedRound
      ].join("\u001f");
    })
    .filter(Boolean)
    .join("|");
}

export function mergeAccountsIntoAutoCycleQueue(state, accounts, options = {}) {
  const normalized = normalizeAutoCycleState(state);
  const addedRound = options.addedRound ?? normalized.currentRound;
  const isAccountCooling = options.isAccountCooling || (() => false);
  const isAccountAttemptBlocked = options.isAccountAttemptBlocked || (() => false);
  const completedEmails = new Set(normalized.completedEmails);
  const queue = [...normalized.queue];
  const indexByEmail = new Map(queue.map((account, index) => [account.email, index]));
  let changed = false;

  (accounts || []).forEach((account) => {
    const queued = normalizeQueuedAccount(account, addedRound);
    if (!queued || completedEmails.has(queued.email)) return;
    if (isAccountCooling(queued.email)) return;
    if (isAccountAttemptBlocked(queued.email)) return;

    const existingIndex = indexByEmail.get(queued.email);
    if (existingIndex == null) {
      indexByEmail.set(queued.email, queue.length);
      queue.push(queued);
      changed = true;
      return;
    }

    const existing = queue[existingIndex];
    const nextQueued = {
      ...queued,
      addedRound: existing.addedRound || queued.addedRound
    };
    if (getAutoCycleQueueKey([existing]) === getAutoCycleQueueKey([nextQueued])) return;
    queue[existingIndex] = nextQueued;
    changed = true;
  });

  if (!changed) return normalized;
  return {
    ...normalized,
    queue
  };
}

export function normalizeFailedAccount(item) {
  const account = normalizeQueuedAccount(item, item?.failedRound || item?.addedRound || 1);
  if (!account) return null;
  return {
    ...account,
    failedRound: clampRound(item?.failedRound || item?.attemptRound || AUTO_CYCLE_MAX_ROUNDS),
    failedReason: String(item?.failedReason || item?.reason || "").trim(),
    failedCdkey: String(item?.failedCdkey || item?.cdkey || "").trim(),
    failedAt: String(item?.failedAt || "")
  };
}

export function normalizeAccountAttemptLedger(value, now = Date.now()) {
  const normalized = normalizeAccountLedger(value, { now });
  return Object.fromEntries(
    Object.entries(normalized).map(([email, item]) => [
      email,
      {
        email,
        attempts: item.attempts,
        attemptCount: item.attemptCount,
        firstAttemptAt: item.firstAttemptAt,
        lastAttemptAt: item.lastAttemptAt,
        cooldownUntil: item.cooldownUntil,
        cooldownReason: item.cooldownReason,
        updatedAt: item.updatedAt,
        ...(item.redemptionAttempts?.length
          ? { redemptionAttempts: item.redemptionAttempts.map((attempt) => ({ ...attempt })) }
          : {})
      }
    ])
  );
}

export function getAccountAttemptInfo(email, ledger, now = Date.now()) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return { count: 0, attempts: [], limitReached: false, resetAt: 0 };
  }
  const normalized = normalizeAccountAttemptLedger(ledger, now);
  const attempts = normalized[normalizedEmail]?.attempts || [];
  const resetAt = attempts.length >= ACCOUNT_ATTEMPT_LIMIT ? attempts[0] + ACCOUNT_ATTEMPT_WINDOW_MS : 0;
  return {
    count: attempts.length,
    attempts,
    limitReached: attempts.length >= ACCOUNT_ATTEMPT_LIMIT,
    resetAt
  };
}

export function isAccountAttemptLimitReached(email, ledger, now = Date.now()) {
  return getAccountAttemptInfo(email, ledger, now).limitReached;
}

export function sanitizeLegacyAccountAttemptRows(rowList, ledger = {}, now = Date.now()) {
  let changed = false;
  const nextRows = (rowList || []).map((row) => {
    const rawAttempt = Number(row?.accountAttemptNumber || 0);
    const cooldownReason = String(row?.accountCooldownReason || row?.reason || "").trim();
    if (
      Number(row?.accountCooldownUntil || 0) > now &&
      isLimitCooldownReason(cooldownReason) &&
      rawAttempt !== ACCOUNT_ATTEMPT_LIMIT
    ) {
      changed = true;
      return {
        ...row,
        accountAttemptNumber: ACCOUNT_ATTEMPT_LIMIT
      };
    }
    if (!row?.email) return row;
    const ledgerCount = getAccountAttemptInfo(row.email, ledger, now).count;
    const accountAttemptNumber = Math.min(
      Math.max(ledgerCount || 0, rawAttempt || 0, 1),
      ACCOUNT_ATTEMPT_LIMIT
    );
    if (row && rawAttempt === accountAttemptNumber) {
      return row;
    }
    changed = true;
    return {
      ...row,
      accountAttemptNumber
    };
  });
  return changed ? nextRows : rowList;
}

export function batchCount(count) {
  return Math.ceil(count / 100) || 0;
}

export function isAccountTaskRow(row) {
  return Boolean(row?.email || row?.accessToken || row?.exportLine);
}

export function isActiveBackendTaskRow(row) {
  return Boolean(row?.cdkey && ACTIVE_BACKEND_STATUSES.has(String(row.status || "")));
}

export function isHistoricalAutoCycleRow(row) {
  return (
    row?.statusLocked === true &&
    row?.autoCycleHandled === true &&
    row?.statusOwner !== true &&
    !isActiveBackendTaskRow(row)
  );
}

export function getSubmitAccountAvailability({
  accounts = [],
  rowList = [],
  cycleState = {},
  cooldowns = {},
  attemptLedger = {},
  failedAccounts = []
} = {}) {
  const accountEmails = new Set((accounts || []).map((account) => normalizeEmail(account?.email)).filter(Boolean));
  const facts = getAccountAvailabilityFacts({
    accounts,
    rows: rowList,
    ledger: attemptLedger,
    cooldowns
  });
  const categories = {
    completed: new Set(),
    failedGroup: new Set(),
    pmUnavailable: new Set()
  };

  const addEmail = (set, email) => {
    const normalized = normalizeEmail(email);
    if (normalized) set.add(normalized);
  };

  normalizeStringArray(cycleState?.completedEmails).forEach((email) => addEmail(categories.completed, email));

  (rowList || []).forEach((row) => {
    const email = normalizeEmail(row?.email);
    if (!email) return;
    const status = String(row?.status || "");
    if (status === "success") addEmail(categories.completed, email);
    if (status === "pm_unavailable") {
      addEmail(categories.pmUnavailable, email);
    }
  });

  const blockedEmails = new Set([
    ...facts.blockedEmails,
    ...Object.values(categories).flatMap((category) => [...category])
  ]);
  const blockedAccessTokens = getReservedAccountAccessTokens(rowList);
  const availableAccounts = (accounts || []).filter(
    (account) =>
      !blockedEmails.has(normalizeEmail(account?.email)) &&
      !blockedAccessTokens.has(normalizeAccessToken(account?.accessToken))
  );
  const countInAccounts = (set) => [...accountEmails].filter((email) => set.has(email)).length;
  const unavailableCount = Math.max(accounts.length - availableAccounts.length, 0);

  return {
    blockedEmails,
    blockedAccessTokens,
    availableAccounts,
    counts: {
      total: accounts.length,
      available: availableAccounts.length,
      unavailable: unavailableCount,
      cooling: facts.cooling,
      attemptLimited: facts.attemptLimited,
      activeTask: facts.activeTask,
      completed: countInAccounts(categories.completed),
      completedPlus: facts.completedPlus,
      failedGroup: countInAccounts(categories.failedGroup),
      pmUnavailable: countInAccounts(categories.pmUnavailable),
      locked: countInAccounts(categories.pmUnavailable)
    }
  };
}

export function getBlockedSubmitEmails(rowList, cycleState, cooldowns, attemptLedger = {}, failedAccounts = []) {
  return getSubmitAccountAvailability({
    rowList,
    cycleState,
    cooldowns,
    attemptLedger,
    failedAccounts
  }).blockedEmails;
}

export function buildPooledSubmitRows({
  accounts,
  cdkeys,
  existingRows,
  blockedEmails,
  availableAccounts: preparedAccounts,
  reservedAccessTokens = [],
  rowOffset = 0
}) {
  const rawAvailableAccounts =
    preparedAccounts ||
    accounts.filter((account) => !blockedEmails.has(normalizeEmail(account.email)));
  const reservedTokenSet = new Set(
    [...(reservedAccessTokens || [])].map((token) => normalizeAccessToken(token)).filter(Boolean)
  );
  const seenAccessTokens = new Map();
  const availableAccounts = [];
  const duplicateTokenErrors = [];

  rawAvailableAccounts.forEach((account) => {
    const accessToken = normalizeAccessToken(account?.accessToken);
    if (accessToken && reservedTokenSet.has(accessToken)) {
      duplicateTokenErrors.push({
        lineNumber: account.lineNumber,
        source: account.source || account.email || "",
        type: "account_reserved_token",
        reason: "AT 已在本次兑换链路使用，已跳过，避免同一账号消耗多张卡密"
      });
      return;
    }
    if (accessToken && seenAccessTokens.has(accessToken)) {
      duplicateTokenErrors.push({
        lineNumber: account.lineNumber,
        source: account.source || account.email || "",
        type: "account_duplicate_token",
        reason: "AT 重复，已跳过，避免同一账号同时消耗多张卡密"
      });
      return;
    }
    if (accessToken) seenAccessTokens.set(accessToken, account.lineNumber || availableAccounts.length + 1);
    availableAccounts.push(account);
  });

  const pairCount = Math.min(availableAccounts.length, cdkeys.length);
  const rows = Array.from({ length: pairCount }, (_, index) =>
    createRedeemRow({
      id: `submit-pool-${rowOffset + index}-${availableAccounts[index].lineNumber}-${cdkeys[index].lineNumber}`,
      index: rowOffset + index,
      account: availableAccounts[index],
      cdkey: cdkeys[index],
      status: "local_ready"
    })
  );

  const errors = [...duplicateTokenErrors];
  for (let index = pairCount; index < availableAccounts.length; index += 1) {
    errors.push({
      lineNumber: availableAccounts[index].lineNumber,
      source: availableAccounts[index].source,
      reason: "缺少可用 CDK，等待补充卡密后继续兑换"
    });
  }

  for (let index = pairCount; index < cdkeys.length; index += 1) {
    errors.push({
      lineNumber: cdkeys[index].lineNumber,
      source: cdkeys[index].cdkey,
      poolId: cdkeys[index].poolId,
      poolLabel: cdkeys[index].poolLabel,
      reason: `${cdkeys[index].poolLabel} 暂无对应账号，等待后续导入账号`
    });
  }

  return {
    rows,
    errors,
    availableAccountCount: availableAccounts.length,
    availableCdkCount: cdkeys.length,
    waitingAccounts: Math.max(availableAccounts.length - cdkeys.length, 0),
    waitingCdkeys: Math.max(cdkeys.length - availableAccounts.length, 0),
    existingRows
  };
}

export function isContinuationBlockingRow(row, options = {}) {
  const now = Number.isFinite(Number(options?.now)) ? Number(options.now) : Date.now();
  const status = String(row?.status || "");
  return (
    isAccountTaskRow(row) &&
    (status === "success" || isAccountTaskReservationRow(row, { now }))
  );
}

export function getRowAccountAttemptValue(row) {
  return Number(row?.accountAttemptNumber || 0);
}

export function isRowAccountAttemptExhausted(row) {
  return shouldBlockFourthAttempt(getRowAccountAttemptValue(row));
}

export function getResubmitBlockReason(row) {
  if (rowHasPmUnavailable(row)) return "账号风控不可用";
  if (isRowAccountCooling(row)) {
    return `账号已封存至 ${formatCooldownUntil(row.accountCooldownUntil)}`;
  }
  if (isRowAccountAttemptExhausted(row)) {
    return `账号已达到 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次，第四次直接判定失败`;
  }

  const status = String(row?.status || "");
  if (!RESUBMIT_REDEEM_STATUSES.has(status)) {
    return `当前状态 ${statusLabel(status)} 不可重新兑换`;
  }

  if (!row?.email) return "缺少邮箱";
  if (!row?.accessToken) return "缺少 at";
  if (!row?.cdkey) return "缺少 CDK";
  if (!row?.channel) return "缺少渠道";

  return "";
}

export function rowHasPmUnavailable(row) {
  const rawStatus = row?.rawStatus || {};
  const values = [
    row?.status,
    row?.reason,
    row?.failureReason,
    row?.message,
    row?.error_message,
    row?.errorMessage,
    rawStatus?.status,
    rawStatus?.state,
    rawStatus?.result,
    rawStatus?.reason,
    rawStatus?.message,
    rawStatus?.error,
    rawStatus?.error_message,
    rawStatus?.errorMessage
  ];
  return values.some((value) => String(value || "").toLowerCase().includes("pm_unavailable"));
}

export function canResubmitRedeemRow(row) {
  return !getResubmitBlockReason(row);
}

export function describeSelectedRow(row) {
  const index = row?.displayIndex || row?.accountLineNumber || row?.cdkeyLineNumber;
  const prefix = index ? `第 ${index} 行` : "选中项";
  return row?.email ? `${prefix} ${row.email}` : prefix;
}

export function getRowCdkeys(rowList) {
  return [
    ...new Set(
      (rowList || [])
        .map((row) => String(row?.cdkey || "").trim())
        .filter(Boolean)
    )
  ];
}

export function getCurrentTaskRows(rowList) {
  return (rowList || []).filter((row) => !isHistoricalAutoCycleRow(row));
}

export function restoreOrphanedAutoCycleRows(rowList = []) {
  const rows = Array.isArray(rowList) ? rowList : [];
  const currentCdkeys = new Set(
    getCurrentTaskRows(rows)
      .map((row) => String(row?.cdkey || "").trim())
      .filter(Boolean)
  );
  const orphanIndexByCdkey = new Map();

  rows.forEach((row, index) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey || currentCdkeys.has(cdkey) || !isHistoricalAutoCycleRow(row)) return;
    orphanIndexByCdkey.set(cdkey, index);
  });

  if (!orphanIndexByCdkey.size) return rows;

  return rows.map((row, index) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (orphanIndexByCdkey.get(cdkey) !== index) return row;
    return {
      ...row,
      autoCycleHandled: false,
      statusLocked: false,
      statusOwner: true,
      autoCycleNextRowId: ""
    };
  });
}

export function mergeMissingQueryRows(baseRows = [], queryRows = []) {
  const sourceRows = Array.isArray(baseRows) ? baseRows : [];
  const seenVisibleCdkeys = new Set(
    getCurrentTaskRows(sourceRows).map((row) => String(row?.cdkey || "").trim()).filter(Boolean)
  );
  const nextRows = [...sourceRows];

  (Array.isArray(queryRows) ? queryRows : []).forEach((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey || seenVisibleCdkeys.has(cdkey)) return;
    seenVisibleCdkeys.add(cdkey);
    nextRows.push({
      ...row,
      id: `query-extra-${nextRows.length}-${row.cdkeyLineNumber || nextRows.length + 1}`,
      displayIndex: nextRows.length + 1
    });
  });

  return nextRows;
}

export function summarizeErrorReasons(errorList, limit = 2) {
  const counts = new Map();
  (errorList || []).forEach((error) => {
    const reason = String(error?.reason || "").trim();
    if (!reason) return;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  });
  const entries = [...counts.entries()];
  if (!entries.length) return "";
  const shown = entries.slice(0, limit).map(([reason, count]) => `${reason}${count > 1 ? ` ${count} 条` : ""}`);
  const extra = entries.length > limit ? `，另 ${entries.length - limit} 类原因` : "";
  return `${shown.join("；")}${extra}`;
}

export function formatAccountAvailabilityReason(availability) {
  const counts = availability?.counts;
  if (!counts) return "";
  const parts = [];
  if (counts.cooling) parts.push(`冷却 ${counts.cooling}`);
  if (counts.attemptLimited) {
    parts.push(`已达 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次 ${counts.attemptLimited}`);
  }
  if (counts.activeTask) parts.push(`正在兑换/待处理 ${counts.activeTask}`);
  if (counts.completed) parts.push(`已处理 ${counts.completed}`);
  if (counts.pmUnavailable || counts.locked) {
    parts.push(`风控不可用 ${counts.pmUnavailable || counts.locked}`);
  }
  return parts.join("，");
}

export function isStaleSubmitPlanningError(error) {
  const reason = String(error?.reason || "");
  return [
    "缺少可用 CDK",
    "暂无对应账号",
    "卡密状态预检失败",
    "卡密已有当前兑换任务",
    "卡密已使用，未提交",
    "卡密状态查询失败，请重试"
  ].some((marker) => reason.includes(marker));
}

export function buildNoSubmitMessage(
  preflightSummary,
  prepared,
  errorList,
  hasExistingAccountTasks,
  accountAvailability
) {
  const summary = preflightSummary || EMPTY_PREFLIGHT_SUMMARY;
  const availableAccountCount = Number(prepared?.availableAccountCount || 0);
  const availableCdkCount = Number(prepared?.availableCdkCount || summary.available || 0);
  const waitingAccountCount = Number(prepared?.waitingAccounts || 0);
  const accountTotal = Number(accountAvailability?.counts?.total || 0);
  const accountAvailabilityReason = formatAccountAvailabilityReason(accountAvailability);
  const preflightText = summary.checked
    ? `CDK 预检：可用 ${summary.available} 张，已使用 ${summary.used} 张，占用中 ${summary.busy} 张，查询失败 ${summary.unknown} 张`
    : "没有检测到可用 CDK";
  const reasonText = summarizeErrorReasons(errorList);

  if (availableAccountCount > 0 && availableCdkCount === 0) {
    return `${preflightText}；还有 ${availableAccountCount} 个可用账号，但当前没有可提交的 CDK，账号会继续留在队列等待卡密。${reasonText ? `原因：${reasonText}` : "请补充未使用卡密，或先查询卡密状态。"}`;
  }

  if (availableAccountCount === 0 && availableCdkCount > 0) {
    if (accountTotal > 0) {
      return `${preflightText}；有 ${availableCdkCount} 张可用 CDK，但 ${accountTotal} 个账号都不可用${accountAvailabilityReason ? `：${accountAvailabilityReason}` : ""}。请导入新账号或等待冷却账号恢复。`;
    }
    return `${preflightText}；有 ${availableCdkCount} 张可用 CDK，但没有可用账号。请导入账号或等待冷却账号恢复。`;
  }

  if (hasExistingAccountTasks) {
    return prepared?.availableAccountCount
      ? `${preflightText}；还有 ${waitingAccountCount || availableAccountCount} 个账号在等待可用 CDK，补充卡密或卡密确认可用后会继续兑换。`
      : `${preflightText}；没有新的账号/CDK 可续接提交，已存在或已处理的账号不会重复提交。`;
  }

  return `${preflightText}；没有可提交的账号/CDK 配对。${reasonText ? `原因：${reasonText}` : ""}`;
}

export function markRowsUsedInAutoCycle(state, usedRows) {
  const nextState = normalizeAutoCycleState(state);
  const roundKey = String(nextState.currentRound);
  const used = new Set(nextState.roundUsage[roundKey] || []);
  let cursorIndex = nextState.cursorIndex;
  usedRows.forEach((row) => {
    const email = String(row.email || "").trim().toLowerCase();
    if (!email) return;
    used.add(email);
    const queueIndex = nextState.queue.findIndex((account) => account.email === email);
    if (queueIndex >= 0 && queueIndex >= cursorIndex) {
      cursorIndex = queueIndex + 1;
    }
  });
  return {
    ...nextState,
    cursorIndex,
    roundUsage: {
      ...nextState.roundUsage,
      [roundKey]: [...used]
    }
  };
}
