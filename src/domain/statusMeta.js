import { createEmptySubscriptionState } from "./subscriptionDiagnostics.js";

export const STATUS_META = {
  local_ready: { label: "待提交", tone: "muted", terminal: false },
  submitting: { label: "提交中", tone: "info", terminal: false },
  querying: { label: "查询中", tone: "info", terminal: false },
  query_failed: { label: "查询失败", tone: "warning", terminal: true },
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
const STALE_REDEEM_STATUSES = new Set([
  "cancelled",
  "failed",
  "timeout",
  "not_found",
  "unused"
]);
const NON_PROGRESS_GUARD_STATUSES = new Set(["unknown", "ok"]);
const DAILY_LIMIT_HOLD_STATUSES = new Set(["cancelled", "failed", "timeout", "rejected", "unknown"]);

export function statusLabel(status) {
  return STATUS_META[status]?.label || status || "未查询";
}

export function isTerminalStatus(status) {
  return STATUS_META[status]?.terminal === true;
}

export function normalizeStatusItem(item) {
  const cdkey = String(
    item?.cdkey ?? item?.cdKey ?? item?.cd_key ?? item?.cdk ?? item?.key ?? ""
  ).trim();
  const explicitCancellation = hasExplicitCancellation(item);

  let status = normalizeRemoteStatus(
    item?.status ?? item?.state ?? item?.result ?? getRemoteMessage(item)
  );
  if (!status && item?.found === false) status = "not_found";
  if (!status && item?.success === true) status = "success";
  if (!status && item?.cancelled === true) status = "cancelled";
  if (status === "canceled") status = "cancelled";
  if (hasDailySubmissionLimit(item)) status = "failed";
  if (explicitCancellation) status = "cancelled";
  if (!status) status = "unknown";

  return {
    cdkey,
    channel: String(item?.channel ?? item?.pool ?? item?.queue ?? item?.redeem_channel ?? "").trim(),
    status: EXTERNAL_STATUSES.has(status) ? status : status || "unknown",
    reason: getRemoteReason(item, status),
    can_cancel: isTruthy(item?.can_cancel),
    can_retry: explicitCancellation || isTruthy(item?.can_retry),
    can_reuse_token: explicitCancellation || isTruthy(item?.can_reuse_token),
    has_access_token: isTruthy(item?.has_access_token),
    redemptionTimestamp: status === "success" ? getRedemptionTimestamp(item) : "",
    explicitCancellation,
    missingStatusItem: item?.missingStatusItem === true,
    rawStatus: item
  };
}

function getRedemptionTimestamp(item) {
  const value = [
    item?.finished_at,
    item?.finishedAt,
    item?.completed_at,
    item?.completedAt,
    item?.redeemed_at,
    item?.redeemedAt,
    item?.success_at,
    item?.successAt,
    item?.updated_at,
    item?.updatedAt
  ].find((candidate) => String(candidate ?? "").trim());

  return String(value ?? "").trim();
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

function isExplicitCancellationText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return (
    /用户取消/.test(text) ||
    /已取消兑换/.test(text) ||
    /取消成功/.test(text) ||
    /已取消/.test(text) ||
    /取消.*兑换/.test(text) ||
    /CDK\s*可重新提交/i.test(text) ||
    /卡密.*可重新提交/.test(text)
  );
}

function collectPrimitiveTexts(value, seen = new WeakSet()) {
  if (value == null) return [];
  if (["string", "number", "boolean"].includes(typeof value)) return [String(value)];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPrimitiveTexts(item, seen));
  }
  return Object.values(value).flatMap((item) => collectPrimitiveTexts(item, seen));
}

function hasExplicitCancellation(item) {
  const commonFields = [
    item?.message,
    item?.error,
    item?.error_message,
    item?.errorMessage,
    item?.reason,
    item?.result,
    item?.state,
    item?.status
  ];
  return (
    commonFields.some(isExplicitCancellationText) ||
    collectPrimitiveTexts(item).some(isExplicitCancellationText)
  );
}

function getExplicitCancellationReason(item) {
  return collectPrimitiveTexts(item).find(isExplicitCancellationText) || "";
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
  if (normalizedStatus === "cancelled") {
    const cancellationReason = getExplicitCancellationReason(item);
    if (cancellationReason) return cancellationReason;
  }

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

    if (shouldHoldRetryStatus(row, item, now)) {
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
      has_access_token: item.has_access_token || (item.explicitCancellation === true && Boolean(row.accessToken)),
      retryRequestedAt: 0,
      retryHoldUntil: 0,
      staleStatusGuard: false,
      staleStatusGuardStartedAt: 0,
      accountCooldownUntil: nextStatus === "success" ? 0 : row.accountCooldownUntil,
      accountCooldownReason: nextStatus === "success" ? "" : row.accountCooldownReason,
      redemptionTimestamp:
        nextStatus === "success"
          ? item.redemptionTimestamp || row.redemptionTimestamp || ""
          : "",
      rawStatus: item.rawStatus
    };
  });
}

export function shouldHoldRetryStatus(row, itemOrStatus, now = Date.now()) {
  const item =
    itemOrStatus && typeof itemOrStatus === "object"
      ? itemOrStatus
      : { status: itemOrStatus };
  if (item.explicitCancellation === true) return false;
  const status = String(item.status || "");
  if (row?.staleStatusGuard === true && item.missingStatusItem === true) return true;
  if (row?.staleStatusGuard === true) {
    if (!EXTERNAL_STATUSES.has(status) || NON_PROGRESS_GUARD_STATUSES.has(status)) return true;
  }
  if (!STALE_REDEEM_STATUSES.has(status)) return false;
  const holdUntil = Number(row?.retryHoldUntil || 0);
  return holdUntil > now;
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
