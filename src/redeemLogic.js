export const DELIMITER = "---";
export const MAX_BATCH_SIZE = 100;
export const CDK_POOLS = [
  {
    id: "vip",
    label: "VIP 通道",
    shortLabel: "VIP",
    description: "优先通道卡密池",
    placeholder: "VIP-CDK-001\nVIP-CDK-002"
  },
  {
    id: "ideal",
    label: "IDEAL 排队",
    shortLabel: "IDEAL",
    description: "IDEAL 队列卡密池",
    placeholder: "IDEAL-CDK-001\nIDEAL-CDK-002"
  },
  {
    id: "upi",
    label: "UPI 排队",
    shortLabel: "UPI",
    description: "UPI 队列卡密池",
    placeholder: "UPI-CDK-001\nUPI-CDK-002"
  }
];

export const STATUS_META = {
  local_ready: { label: "待提交", tone: "muted", terminal: false },
  submitting: { label: "提交中", tone: "info", terminal: false },
  querying: { label: "查询中", tone: "info", terminal: false },
  queued: { label: "排队中", tone: "pending", terminal: false },
  submitted: { label: "已提交", tone: "pending", terminal: false },
  pending_dispatch: { label: "等待兑换", tone: "pending", terminal: false },
  dispatching: { label: "派发中", tone: "pending", terminal: false },
  dispatched: { label: "已派发", tone: "pending", terminal: false },
  running: { label: "兑换中", tone: "running", terminal: false },
  processing: { label: "兑换中", tone: "running", terminal: false },
  success: { label: "兑换成功", tone: "success", terminal: true },
  failed: { label: "兑换失败", tone: "danger", terminal: true },
  timeout: { label: "兑换超时", tone: "warning", terminal: true },
  cancelled: { label: "已取消", tone: "muted", terminal: true },
  rejected: { label: "已拒绝", tone: "danger", terminal: true },
  invalid: { label: "无效", tone: "danger", terminal: true },
  approve_blocked: { label: "审批受阻", tone: "danger", terminal: true },
  pm_unavailable: { label: "账号风控不可用", tone: "danger", terminal: true },
  awaiting_payment_expiry: { label: "等待支付队列过期", tone: "warning", terminal: true },
  unused: { label: "未使用", tone: "muted", terminal: true },
  not_found: { label: "未找到", tone: "muted", terminal: true },
  unknown: { label: "未知状态", tone: "muted", terminal: true }
};

export const EXTERNAL_STATUSES = new Set([
  "pending_dispatch",
  "queued",
  "submitted",
  "dispatching",
  "dispatched",
  "running",
  "processing",
  "success",
  "failed",
  "timeout",
  "cancelled",
  "rejected",
  "invalid",
  "approve_blocked",
  "pm_unavailable",
  "awaiting_payment_expiry",
  "unused",
  "not_found"
]);

export const FAILED_RETRY_STATUSES = new Set([
  "failed",
  "timeout",
  "rejected",
  "invalid",
  "approve_blocked",
  "awaiting_payment_expiry"
]);

export const NON_RETRYABLE_STATUSES = new Set(["pm_unavailable"]);
const STALE_REDEEM_STATUSES = new Set(["cancelled", "failed", "timeout"]);
const NON_PROGRESS_GUARD_STATUSES = new Set(["unknown", "ok"]);
const DAILY_LIMIT_HOLD_STATUSES = new Set(["cancelled", "failed", "timeout", "rejected", "unknown"]);

export function statusLabel(status) {
  return STATUS_META[status]?.label || status || "未查询";
}

export function isTerminalStatus(status) {
  return STATUS_META[status]?.terminal === true;
}

export function appendImportedText(current, imported) {
  const nextText = String(imported || "").replace(/^\ufeff/, "");
  if (!nextText.trim()) return current;
  if (!String(current || "").trim()) return nextText;
  const prefix = String(current);
  const separator = /\r?\n$/.test(prefix) ? "" : "\n";
  return `${prefix}${separator}${nextText.replace(/^(\r?\n)+/, "")}`;
}

function parseAccountLine(source, lineNumber) {
  const parts = source.split(DELIMITER).map((part) => part.trim());
  if (parts.length !== 5) {
    return {
      error: {
        lineNumber,
        source,
        reason: `账号必须是 5 段：邮箱---密码---2fa---at---时间戳，当前 ${parts.length} 段`
      }
    };
  }

  const emptyIndex = parts.findIndex((part) => !part);
  if (emptyIndex !== -1) {
    return {
      error: {
        lineNumber,
        source,
        reason: `第 ${emptyIndex + 1} 段不能为空`
      }
    };
  }

  const [email, password, twofa, accessToken, timestamp] = parts;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      error: {
        lineNumber,
        source,
        reason: "第 1 段必须是邮箱"
      }
    };
  }

  return {
    account: {
      lineNumber,
      source,
      email,
      password,
      twofa,
      accessToken,
      timestamp,
      exportLine: [email, password, twofa, timestamp].join(DELIMITER)
    }
  };
}

function collectAccounts(text, options = {}) {
  const accounts = [];
  const errors = [];
  const outputLines = [];
  const seenEmails = new Map();
  let duplicateCount = 0;
  let invalidCount = 0;

  String(text || "")
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const source = rawLine.trim();
      if (!source) return;

      const parsed = parseAccountLine(source, lineNumber);
      if (parsed.error) {
        invalidCount += 1;
        errors.push({ ...parsed.error, type: "account_format" });
        if (options.keepRejectedLines) outputLines.push(source);
        return;
      }

      const account = parsed.account;
      const emailKey = account.email.toLowerCase();
      if (seenEmails.has(emailKey)) {
        duplicateCount += 1;
        errors.push({
          lineNumber,
          source,
          type: "account_duplicate",
          reason: `账号重复，已自动去重；首次出现在第 ${seenEmails.get(emailKey)} 行`
        });
        return;
      }

      seenEmails.set(emailKey, lineNumber);
      accounts.push(account);
      if (options.keepInvalidLines) outputLines.push(account.source);
    });

  return {
    accounts,
    errors,
    text: outputLines.join("\n"),
    accountCount: accounts.length,
    duplicateCount,
    invalidCount
  };
}

export function normalizeAccountText(text) {
  return collectAccounts(text, { keepInvalidLines: true });
}

export function inspectAccountText(text) {
  return collectAccounts(text, { keepInvalidLines: true, keepRejectedLines: true });
}

export function parseAccounts(text) {
  const { accounts, errors } = collectAccounts(text);
  return { accounts, errors };
}

export function parseCdkeys(text) {
  return parseCdkeyPools(text);
}

export function parseCdkeyPools(input) {
  const cdkeys = [];
  const errors = [];
  const seen = new Map();

  normalizeCdkeyInput(input).forEach((pool) => {
    String(pool.text || "")
      .split(/\r?\n/)
      .forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const cdkey = rawLine.trim();
      if (!cdkey) return;

      if (seen.has(cdkey)) {
        const first = seen.get(cdkey);
        errors.push({
          lineNumber,
          source: cdkey,
          poolId: pool.id,
          poolLabel: pool.label,
          reason: `CDK 重复，首次出现在 ${first.poolLabel} 第 ${first.lineNumber} 行`
        });
        return;
      }

      seen.set(cdkey, { lineNumber, poolLabel: pool.label });
      cdkeys.push({
        lineNumber,
        cdkey,
        source: cdkey,
        channel: pool.id,
        channelLabel: pool.label,
        poolId: pool.id,
        poolLabel: pool.label
      });
    });
  });

  return { cdkeys, errors };
}

function normalizeCdkeyInput(input) {
  if (typeof input === "string") {
    return [{ id: "default", label: "CDK", text: input }];
  }

  if (Array.isArray(input)) {
    return input.map((pool, index) => ({
      id: pool.id || `pool-${index + 1}`,
      label: pool.label || pool.title || `卡密池 ${index + 1}`,
      text: pool.text || pool.value || ""
    }));
  }

  const source = input && typeof input === "object" ? input : {};
  const knownPools = CDK_POOLS.map((pool) => ({
    id: pool.id,
    label: pool.label,
    text: source[pool.id] || ""
  }));
  const extraPools = Object.keys(source)
    .filter((key) => !CDK_POOLS.some((pool) => pool.id === key))
    .map((key) => ({
      id: key,
      label: key,
      text: source[key] || ""
    }));

  return [...knownPools, ...extraPools];
}

export function buildSubmitRows(accountText, cdkeyInput) {
  const { accounts, errors: accountErrors } = parseAccounts(accountText);
  const { cdkeys, errors: cdkeyErrors } = parseCdkeyPools(cdkeyInput);
  const errors = [...accountErrors, ...cdkeyErrors];
  const pairCount = Math.min(accounts.length, cdkeys.length);

  const rows = Array.from({ length: pairCount }, (_, index) =>
    createRedeemRow({
      id: `submit-${index}-${accounts[index].lineNumber}-${cdkeys[index].lineNumber}`,
      index,
      account: accounts[index],
      cdkey: cdkeys[index],
      status: "local_ready"
    })
  );

  for (let index = pairCount; index < accounts.length; index += 1) {
    errors.push({
      lineNumber: accounts[index].lineNumber,
      source: accounts[index].source,
      reason: "缺少对应 CDK，提交时跳过；补充卡密后可继续兑换"
    });
  }

  for (let index = pairCount; index < cdkeys.length; index += 1) {
    errors.push({
      lineNumber: cdkeys[index].lineNumber,
      source: cdkeys[index].cdkey,
      poolId: cdkeys[index].poolId,
      poolLabel: cdkeys[index].poolLabel,
      reason: `${cdkeys[index].poolLabel} 缺少对应账号，提交时跳过；可单独查询状态`
    });
  }

  return { rows, errors, accountCount: accounts.length, cdkeyCount: cdkeys.length };
}

export function buildContinuationSubmitRows(accountText, cdkeyInput, existingRows = [], options = {}) {
  const { accounts, errors: accountErrors } = parseAccounts(accountText);
  const { cdkeys, errors: cdkeyErrors } = parseCdkeyPools(cdkeyInput);
  const errors = [...accountErrors, ...cdkeyErrors];
  const rowOffset = Number.isFinite(options.rowOffset)
    ? Math.max(Number(options.rowOffset), 0)
    : existingRows.length;
  const existingEmails = new Set(
    existingRows
      .map((row) => String(row?.email || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const existingCdkeys = new Set(
    existingRows
      .map((row) => String(row?.cdkey || "").trim())
      .filter(Boolean)
  );
  const availableAccounts = accounts.filter(
    (account) => !existingEmails.has(account.email.toLowerCase())
  );
  const availableCdkeys = cdkeys.filter((cdkey) => !existingCdkeys.has(cdkey.cdkey));
  const pairCount = Math.min(availableAccounts.length, availableCdkeys.length);

  const rows = Array.from({ length: pairCount }, (_, index) =>
    createRedeemRow({
      id: `submit-continue-${rowOffset + index}-${availableAccounts[index].lineNumber}-${availableCdkeys[index].lineNumber}`,
      index: rowOffset + index,
      account: availableAccounts[index],
      cdkey: availableCdkeys[index],
      status: "local_ready"
    })
  );

  for (let index = pairCount; index < availableAccounts.length; index += 1) {
    errors.push({
      lineNumber: availableAccounts[index].lineNumber,
      source: availableAccounts[index].source,
      reason: "缺少对应 CDK，提交时跳过；补充卡密后可继续兑换"
    });
  }

  for (let index = pairCount; index < availableCdkeys.length; index += 1) {
    errors.push({
      lineNumber: availableCdkeys[index].lineNumber,
      source: availableCdkeys[index].cdkey,
      poolId: availableCdkeys[index].poolId,
      poolLabel: availableCdkeys[index].poolLabel,
      reason: `${availableCdkeys[index].poolLabel} 缺少对应账号，提交时跳过；可单独查询状态`
    });
  }

  return {
    rows,
    errors,
    accountCount: accounts.length,
    cdkeyCount: cdkeys.length,
    skippedExistingAccountCount: accounts.length - availableAccounts.length,
    skippedExistingCdkeyCount: cdkeys.length - availableCdkeys.length
  };
}

export function buildQueryRows(accountText, cdkeyInput) {
  const { accounts, errors: accountErrors } = parseAccounts(accountText);
  const { cdkeys, errors: cdkeyErrors } = parseCdkeyPools(cdkeyInput);
  const errors = [...cdkeyErrors];
  const rows = cdkeys.map((cdkey, index) => {
    const account = accounts[index] || null;
    return createRedeemRow({
      id: `query-${index}-${cdkey.lineNumber}`,
      index,
      account,
      cdkey,
      status: "querying"
    });
  });

  if (accountText.trim()) {
    errors.push(...accountErrors);
  }

  return { rows, errors, accountCount: accounts.length, cdkeyCount: cdkeys.length };
}

export function createRedeemRow({ id, index, account, cdkey, status }) {
  return {
    id,
    displayIndex: index + 1,
    accountLineNumber: account?.lineNumber || null,
    cdkeyLineNumber: cdkey.lineNumber,
    channel: cdkey.channel || cdkey.poolId || "",
    channelLabel: cdkey.channelLabel || cdkey.poolLabel || "",
    email: account?.email || "",
    password: account?.password || "",
    twofa: account?.twofa || "",
    accessToken: account?.accessToken || "",
    timestamp: account?.timestamp || "",
    exportLine: account?.exportLine || "",
    cdkey: cdkey.cdkey,
    originalCdkey: cdkey.cdkey,
    status,
    reason: "",
    can_cancel: false,
    can_retry: false,
    can_reuse_token: false,
    has_access_token: Boolean(account?.accessToken),
    ...createEmptySubscriptionState(),
    selected: false,
    retryRequestedAt: 0,
    retryHoldUntil: 0,
    staleStatusGuard: false,
    staleStatusGuardStartedAt: 0,
    attemptRound: 1,
    attemptNumber: 1,
    parentRowId: "",
    autoCycle: false,
    autoCycleSourceEmail: "",
    autoCycleHandled: false,
    autoCycleNextRowId: "",
    statusLocked: false,
    statusOwner: false,
    rawStatus: null
  };
}

export function normalizeStatusItem(item) {
  const cdkey = String(
    item?.cdkey ?? item?.cdKey ?? item?.cd_key ?? item?.cdk ?? item?.key ?? ""
  ).trim();

  let status = normalizeRemoteStatus(
    item?.status ?? item?.state ?? item?.result ?? getRemoteMessage(item)
  );
  if (!status && item?.found === false) status = "not_found";
  if (!status && item?.success === true) status = "success";
  if (!status && item?.cancelled === true) status = "cancelled";
  if (status === "canceled") status = "cancelled";
  if (hasDailySubmissionLimit(item)) status = "failed";
  if (!status) status = "unknown";

  return {
    cdkey,
    channel: String(item?.channel ?? item?.pool ?? item?.queue ?? item?.redeem_channel ?? "").trim(),
    status: EXTERNAL_STATUSES.has(status) ? status : status || "unknown",
    reason: getRemoteReason(item, status),
    can_cancel: isTruthy(item?.can_cancel),
    can_retry: isTruthy(item?.can_retry),
    can_reuse_token: isTruthy(item?.can_reuse_token),
    has_access_token: isTruthy(item?.has_access_token),
    rawStatus: item
  };
}

export function normalizeRemoteStatus(value) {
  if (isDailySubmissionLimitText(value)) return "failed";

  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!normalized) return "";
  if (normalized === "approve_blocked") return "approve_blocked";
  if (normalized === "pm_unavailable") return "pm_unavailable";
  if (normalized === "awaiting_payment_expiry") return "awaiting_payment_expiry";
  if (/兑换成功|成功|已兑换|已使用|已用/.test(normalized)) return "success";
  if (/提交失败|兑换失败|充值失败|失败|超时|拒绝|已拒绝|取消|已取消/.test(normalized)) {
    if (/超时/.test(normalized)) return "timeout";
    if (/拒绝/.test(normalized)) return "rejected";
    if (/取消/.test(normalized)) return "cancelled";
    return "failed";
  }
  if (/未找到|不存在/.test(normalized)) return "not_found";
  if (/无效|不可用/.test(normalized)) return "invalid";
  if (/未使用|未兑换|可用/.test(normalized)) return "unused";
  if (/waiting|queue|br_recharge|进入兑换队列|兑换队列|等待系统处理|等待.*接单|任务.*等待/.test(normalized)) return "queued";
  if (/等待处理|待处理|待兑换|待派发/.test(normalized)) return "pending_dispatch";
  if (/派发中|正在派发/.test(normalized)) return "dispatching";
  if (/已派发/.test(normalized)) return "dispatched";
  if (/兑换中|处理中|进行中|正在兑换/.test(normalized)) return "processing";
  if (/已提交|已接收|排队/.test(normalized)) return "submitted";
  if (["succeeded", "redeemed", "used"].includes(normalized)) return "success";
  if (["failure", "error"].includes(normalized)) return "failed";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["notused", "not_used", "unredeemed"].includes(normalized)) return "unused";
  return normalized;
}

function isDailySubmissionLimitText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return (
    /提交次数已达上限/.test(text) ||
    /今日提交次数.*上限/.test(text) ||
    (/已达上限/.test(text) && /24\s*(小时|h|H)?/.test(text)) ||
    (/24\s*(小时|h|H)?\s*后/.test(text) && /(再试|重试|才可|才能|可以|提交|兑换)/.test(text))
  );
}

function hasDailySubmissionLimit(item) {
  return [
    item?.message,
    item?.error,
    item?.error_message,
    item?.errorMessage,
    item?.reason,
    item?.result,
    item?.state,
    item?.status
  ].some(isDailySubmissionLimitText);
}

function getRemoteMessage(item) {
  return String(
    item?.message ??
      item?.error ??
      item?.error_message ??
      item?.errorMessage ??
      item?.reason ??
      item?.status ??
      item?.state ??
      item?.result ??
      ""
  ).trim();
}

function getRemoteReason(item, normalizedStatus) {
  const directReason = String(
    item?.message ??
      item?.error ??
      item?.error_message ??
      item?.errorMessage ??
      item?.reason ??
      ""
  ).trim();
  if (directReason) return directReason;

  const fallbackReason = String(item?.result ?? item?.state ?? "").trim();
  if (!fallbackReason) return "";
  return normalizeRemoteStatus(fallbackReason) === normalizedStatus ? "" : fallbackReason;
}

function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    return ["true", "1", "yes", "y", "是"].includes(value.trim().toLowerCase());
  }
  return false;
}

function buildStatusMergeTargets(rows) {
  const countsByCdkey = new Map();
  const targetByCdkey = new Map();

  rows.forEach((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey) return;
    countsByCdkey.set(cdkey, (countsByCdkey.get(cdkey) || 0) + 1);
  });

  rows.forEach((row, index) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey) return;
    const preferred = row?.statusOwner === true;
    const active = row?.statusLocked !== true && row?.autoCycleHandled !== true;
    const current = targetByCdkey.get(cdkey);
    if (
      !current ||
      (preferred && !current.preferred) ||
      (!current.preferred && active && !current.active) ||
      (preferred === current.preferred && active === current.active)
    ) {
      targetByCdkey.set(cdkey, { index, preferred, active });
    }
  });

  return { countsByCdkey, targetByCdkey };
}

export function mergeStatusRows(rows, statusItems, options = {}) {
  const now = Date.now();
  const force = options.force === true;
  const { countsByCdkey, targetByCdkey } = buildStatusMergeTargets(rows);
  const statusByCdkey = new Map(
    statusItems
      .map(normalizeStatusItem)
      .filter((item) => item.cdkey)
      .map((item) => [item.cdkey, item])
  );

  return rows.map((row, index) => {
    const cdkey = String(row?.cdkey || "").trim();
    const duplicatedCdkey = (countsByCdkey.get(cdkey) || 0) > 1;
    if (duplicatedCdkey && targetByCdkey.get(cdkey)?.index !== index) return row;
    if (row.statusLocked && !force) return row;
    const item = statusByCdkey.get(cdkey);
    if (!item) return row;
    const nextStatus = item.status;

    if (shouldHoldRetryStatus(row, nextStatus, now)) {
      return {
        ...row,
        channel: item.channel || row.channel,
        channelLabel: row.channelLabel,
        rawStatus: item.rawStatus
      };
    }

    if (shouldHoldDailyLimitStatus(row, item, nextStatus, now)) {
      return {
        ...row,
        channel: item.channel || row.channel,
        channelLabel: row.channelLabel,
        rawStatus: item.rawStatus
      };
    }

    return {
      ...row,
      ...(nextStatus === "success" ? {} : createEmptySubscriptionState()),
      status: nextStatus,
      channel: item.channel || row.channel,
      channelLabel: row.channelLabel,
      reason: item.reason,
      can_cancel: item.can_cancel,
      can_retry: item.can_retry,
      can_reuse_token: item.can_reuse_token,
      has_access_token: item.has_access_token,
      retryRequestedAt: 0,
      retryHoldUntil: 0,
      staleStatusGuard: false,
      staleStatusGuardStartedAt: 0,
      rawStatus: item.rawStatus
    };
  });
}

export function shouldHoldRetryStatus(row, nextStatus, now = Date.now()) {
  const status = String(nextStatus || "");
  if (row?.staleStatusGuard === true) {
    if (!EXTERNAL_STATUSES.has(status) || NON_PROGRESS_GUARD_STATUSES.has(status)) return true;
  }
  if (!STALE_REDEEM_STATUSES.has(status)) return false;
  const holdUntil = Number(row?.retryHoldUntil || 0);
  return holdUntil > now || row?.staleStatusGuard === true;
}

function shouldHoldDailyLimitStatus(row, item, nextStatus, now = Date.now()) {
  const status = String(nextStatus || "");
  const cooldownUntil = Number(row?.accountCooldownUntil || 0);
  const hasDailyLimitReason =
    isDailySubmissionLimitText(row?.reason) || isDailySubmissionLimitText(row?.accountCooldownReason);
  if (!hasDailyLimitReason || cooldownUntil <= now) return false;
  if (isDailySubmissionLimitText(item?.reason)) return false;
  if (!DAILY_LIMIT_HOLD_STATUSES.has(status)) return false;
  return true;
}

export function createEmptySubscriptionState() {
  return {
    subscriptionStatus: "idle",
    subscriptionCategory: "",
    subscriptionTitle: "",
    subscriptionPlanType: "",
    subscriptionPlan: "",
    subscriptionTimestamp: "",
    hasActiveSubscription: null,
    subscriptionReason: "",
    subscriptionRetryable: false,
    subscriptionHttpStatus: "",
    subscriptionRemoteMessage: "",
    subscriptionCheckedAt: "",
    isPlus: false
  };
}

const SUBSCRIPTION_DIAGNOSTIC_META = {
  plus: { title: "Plus", message: "已确认活跃 Plus", retryable: false },
  not_plus: { title: "非 Plus", message: "不是活跃 Plus", retryable: false },
  missing_token: { title: "缺少 at", message: "缺少 at/access_token，无法判断 Plus", retryable: false },
  token_invalid: { title: "Token 失效", message: "token 失效或无权限", retryable: false },
  no_account: { title: "账号不存在", message: "订阅接口未找到该账号", retryable: false },
  http_error: { title: "接口错误", message: "订阅接口返回 HTTP 错误，可点击查Plus重试", retryable: true },
  timeout: { title: "接口超时", message: "订阅接口请求超时，可点击查Plus重试", retryable: true },
  network_error: { title: "网络错误", message: "服务器无法连接订阅接口，可点击查Plus重试", retryable: true },
  remote_error: { title: "接口返回失败", message: "订阅接口返回失败，可点击查Plus重试", retryable: true },
  bad_response: { title: "返回异常", message: "订阅接口返回内容无法识别，可点击查Plus重试", retryable: true },
  unknown: { title: "未知", message: "订阅检查结果未知，可点击查Plus重试", retryable: true }
};

function normalizeSubscriptionCategory(value) {
  const category = String(value || "").trim();
  return SUBSCRIPTION_DIAGNOSTIC_META[category] ? category : "unknown";
}

function pickSubscriptionText(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text && text.trim()) return text.trim();
  }
  return "";
}

function getDiagnosticPayload(payload) {
  if (payload?.diagnostic && typeof payload.diagnostic === "object") return payload.diagnostic;
  if (payload?.subscription?.diagnostic && typeof payload.subscription.diagnostic === "object") {
    return payload.subscription.diagnostic;
  }
  if (payload?.category || payload?.title || payload?.message || payload?.httpStatus) return payload;
  return {};
}

function classifySubscriptionIssue(message, httpStatus) {
  const text = String(message || "").trim().toLowerCase();
  if (/empty[-_\s]?token|token\s*不能为空|缺少\s*at|缺少.*token/.test(text)) {
    return "missing_token";
  }
  if (
    Number(httpStatus) === 401 ||
    /jwt[-_\s]?expired|token[-_\s]?401|unauthori[sz]ed|invalid.*token|token.*invalid|token.*expired|expired.*token|jwt.*过期|token.*过期/.test(
      text
    )
  ) {
    return "token_invalid";
  }
  if (/no[-_\s]?account|account.*not.*found|账号不存在|未找到.*账号|没有.*账号/.test(text)) {
    return "no_account";
  }
  if (/timeout|超时/.test(text)) return "timeout";
  if (/network|fetch failed|econn|enotfound|无法连接|网络/.test(text)) return "network_error";
  return "";
}

function createSubscriptionDiagnosticState(input = {}, fallbackCategory = "unknown") {
  const category = normalizeSubscriptionCategory(input.category || fallbackCategory);
  const meta = SUBSCRIPTION_DIAGNOSTIC_META[category];
  const message = pickSubscriptionText(input.message, input.reason, input.remoteMessage, meta.message);
  return {
    subscriptionCategory: category,
    subscriptionTitle: pickSubscriptionText(input.title, meta.title),
    subscriptionReason: message,
    subscriptionRetryable: input.retryable ?? meta.retryable,
    subscriptionHttpStatus: input.httpStatus == null || input.httpStatus === "" ? "" : String(input.httpStatus),
    subscriptionRemoteMessage: pickSubscriptionText(input.remoteMessage, input.error, input.code),
    subscriptionCheckedAt: pickSubscriptionText(input.checkedAt) || formatDateTime(new Date())
  };
}

export function normalizeSubscriptionResult(payload) {
  const source = unwrapSubscriptionPayload(payload);
  const diagnosticPayload = getDiagnosticPayload(payload);
  const okValue = source?.ok;
  const okText = String(okValue ?? "").trim().toLowerCase();
  const planType = String(source?.plan_type ?? "").trim();
  const subscriptionPlan = String(source?.subscription_plan ?? "").trim();
  const apiSubscriptionTimestamp = getSubscriptionTimestamp(source);
  const hasActiveSubscription = isTruthy(source?.has_active_subscription);
  const planIsPlus = isPlusPlan(planType, subscriptionPlan);
  const errorReason = getSubscriptionReason(source, okText);
  const diagnosticMessage = pickSubscriptionText(
    diagnosticPayload.message,
    diagnosticPayload.remoteMessage,
    errorReason
  );
  const diagnosticCategory =
    diagnosticPayload.category ||
    classifySubscriptionIssue(diagnosticMessage, diagnosticPayload.httpStatus);
  const hasPlanInfo =
    Boolean(planType || subscriptionPlan) ||
    Object.prototype.hasOwnProperty.call(source, "has_active_subscription");
  const explicitError =
    okValue === false ||
    (typeof okValue === "string" && okText && !["ok", "true"].includes(okText)) ||
    Boolean(source?.error) ||
    (Boolean(errorReason) && !hasPlanInfo);
  const diagnosticIsError =
    diagnosticCategory &&
    !["plus", "not_plus"].includes(diagnosticCategory);

  if (explicitError || diagnosticIsError || (!hasPlanInfo && !errorReason && !diagnosticCategory)) {
    const fallbackCategory =
      diagnosticCategory ||
      classifySubscriptionIssue(errorReason, diagnosticPayload.httpStatus) ||
      (hasPlanInfo ? "remote_error" : "bad_response");
    const diagnostic = createSubscriptionDiagnosticState(
      {
        ...diagnosticPayload,
        category: fallbackCategory,
        message: diagnosticMessage || errorReason || diagnosticPayload.message
      },
      fallbackCategory
    );
    return {
      ...createEmptySubscriptionState(),
      ...diagnostic,
      subscriptionStatus: diagnostic.subscriptionCategory === "missing_token" ? "missing_token" : "error",
      subscriptionPlanType: planType,
      subscriptionPlan,
      subscriptionTimestamp: apiSubscriptionTimestamp,
      hasActiveSubscription
    };
  }

  const isPlus = planIsPlus && hasActiveSubscription === true;
  const browserSubscriptionTimestamp = isPlus && !apiSubscriptionTimestamp
    ? formatDateTime(new Date())
    : "";
  const subscriptionTimestamp = apiSubscriptionTimestamp || browserSubscriptionTimestamp;
  const category = isPlus ? "plus" : "not_plus";
  const reason = isPlus
    ? browserSubscriptionTimestamp
      ? "订阅接口未返回 Plus 时间，已使用浏览器当前时间"
      : "已确认活跃 Plus"
    : planIsPlus
      ? "Plus 套餐但没有活跃订阅"
      : `非 Plus 套餐：${planType || subscriptionPlan || "未知"}`;
  const diagnostic = createSubscriptionDiagnosticState(
    {
      ...diagnosticPayload,
      category,
      message: reason,
      retryable: false
    },
    category
  );

  return {
    subscriptionStatus: isPlus ? "plus" : "not_plus",
    ...diagnostic,
    subscriptionPlanType: planType,
    subscriptionPlan,
    subscriptionTimestamp,
    hasActiveSubscription,
    isPlus
  };
}

export function normalizeSubscriptionError(message, details = {}) {
  const category =
    details.category ||
    classifySubscriptionIssue(message, details.httpStatus) ||
    "unknown";
  const diagnostic = createSubscriptionDiagnosticState(
    {
      ...details,
      category,
      message
    },
    category
  );
  return {
    ...createEmptySubscriptionState(),
    ...diagnostic,
    subscriptionStatus: diagnostic.subscriptionCategory === "missing_token" ? "missing_token" : "error"
  };
}

export function getSubscriptionLabel(row) {
  if (row.status !== "success") return "-";

  switch (row.subscriptionStatus) {
    case "checking":
      return "检查中";
    case "plus":
      return row.subscriptionTitle || "Plus";
    case "plus_missing_time":
      return "Plus 缺时间";
    case "not_plus":
      return row.subscriptionTitle || "非 Plus";
    case "missing_token":
      return row.subscriptionTitle || "缺少 at";
    case "error":
      return row.subscriptionTitle || "检查失败";
    default:
      return row.accessToken ? "待检查" : "缺少 at";
  }
}

export function getSuccessExportsByPool(rows) {
  return rows.reduce(
    (acc, row) => {
      const exportLine = getPlusExportLine(row);
      if (row.status !== "success" || row.isPlus !== true || !exportLine) return acc;
      const channel = String(row.channel || "").trim().toLowerCase();
      if (channel === "upi") {
        acc.upi.push(exportLine);
      } else if (channel === "ideal" || channel === "vip") {
        acc.ideal.push(exportLine);
      }
      return acc;
    },
    { upi: [], ideal: [] }
  );
}

export function getPlusExportLine(row) {
  const subscriptionTimestamp = String(row?.subscriptionTimestamp || "").trim();
  if (!row?.email || !row?.password || !row?.twofa || !subscriptionTimestamp) return "";
  return [row.email, row.password, row.twofa, subscriptionTimestamp].join(DELIMITER);
}

function unwrapSubscriptionPayload(payload) {
  if (payload?.subscription && typeof payload.subscription === "object") return payload.subscription;
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function normalizePlan(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isPlusPlan(planType, subscriptionPlan) {
  const normalizedType = normalizePlan(planType);
  const normalizedPlan = normalizePlan(subscriptionPlan);
  if (normalizedType === "plus") return true;
  if (["free", "pro", "team"].includes(normalizedType)) return false;
  return normalizedPlan === "plus" || normalizedPlan.includes("plus");
}

function getSubscriptionReason(source, okText) {
  const explicitReason = String(
    source?.reason ?? source?.message ?? source?.error ?? source?.error_message ?? ""
  ).trim();
  if (explicitReason) return explicitReason;
  if (okText && !["ok", "true"].includes(okText)) return okText;
  return "";
}

function getSubscriptionTimestamp(source) {
  const timestampValue =
    source?.expires_at ??
    source?.renews_at ??
    source?.expire_at ??
    source?.renew_at ??
    source?.expired_at ??
    source?.renewed_at ??
    source?.current_period_end ??
    source?.period_end ??
    source?.paid_until ??
    source?.valid_until ??
    source?.subscription_expires_at ??
    source?.subscription_renews_at ??
    source?.plus_expires_at ??
    source?.plus_renews_at ??
    source?.expiresAt ??
    source?.renewsAt ??
    source?.currentPeriodEnd ??
    source?.paidUntil ??
    source?.validUntil ??
    source?.activated_at ??
    source?.started_at ??
    source?.start_at ??
    source?.created_at ??
    source?.purchased_at ??
    "";

  return normalizeSubscriptionTimestamp(timestampValue);
}

function normalizeSubscriptionTimestamp(value) {
  if (value == null || value === "") return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
    return formatDateTime(new Date(milliseconds));
  }

  const text = String(value).trim();
  if (!text) return "";

  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const milliseconds = text.length >= 13 ? numeric : numeric * 1000;
    return formatDateTime(new Date(milliseconds));
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return text.includes("T") ? text.replace("T", " ") : text;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateTime(parsed);
  }

  return "";
}

function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function countStatuses(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.total += 1;
      acc[row.status] = (acc[row.status] || 0) + 1;
      if (row.status === "success") acc.success += 1;
      return acc;
    },
    { total: 0, success: 0 }
  );
}

export function canCancelRow(row) {
  return (
    row.can_cancel === true ||
    ["pending_dispatch", "queued", "submitted"].includes(String(row.status || ""))
  );
}

function hasPmUnavailableMarker(row) {
  const rawStatus = row?.rawStatus || {};
  const values = [
    row?.status,
    row?.reason,
    row?.failureReason,
    row?.message,
    rawStatus?.status,
    rawStatus?.state,
    rawStatus?.result,
    rawStatus?.reason,
    rawStatus?.message
  ];
  return values.some((value) => String(value || "").toLowerCase().includes("pm_unavailable"));
}

export function canRetryRow(row) {
  const status = String(row?.status || "");
  if (hasPmUnavailableMarker(row)) return false;
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  if (FAILED_RETRY_STATUSES.has(status)) return true;

  return (
    row.can_retry === true &&
    row.can_reuse_token === true &&
    row.has_access_token === true
  );
}

export function canRetryFailedRow(row) {
  return FAILED_RETRY_STATUSES.has(String(row?.status || "")) && canRetryRow(row);
}
