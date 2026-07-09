import {
  DELIMITER,
  getSubscriptionLabel,
  statusLabel
} from "../redeemLogic.js";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACTIVE_BACKEND_STATUSES,
  DAILY_LIMIT_DISPLAY_REASON
} from "../config/redeemConstants.js";

const DEFAULT_PRESENTATION_DEPS = {
  canRetryVisibleRow: () => false,
  canCancelRow: () => false,
  isHistoricalAutoCycleRow: () => false,
  isRowAccountCooling: () => false,
  formatRowCooldownReason: () => "",
  isAccountDailyLimitReason,
  formatDailyLimitDisplayReason: getDailyLimitDisplayReason
};

function resolveDeps(deps = {}) {
  return {
    ...DEFAULT_PRESENTATION_DEPS,
    ...(deps || {})
  };
}

export function compactStatus(status) {
  const normalized = String(status || "").trim();
  const labels = {
    local_ready: "待提交",
    submitting: "提交中",
    querying: "查询中",
    query_failed: "查询失败",
    queued: "排队",
    submitted: "已提交",
    pending_dispatch: "待兑换",
    dispatching: "派发中",
    dispatched: "已派发",
    running: "兑换中",
    processing: "兑换中",
    success: "已使用",
    failed: "失败",
    timeout: "超时",
    cancelled: "已取消",
    rejected: "拒绝",
    invalid: "无效",
    approve_blocked: "审批阻塞",
    pm_unavailable: "账号风控",
    awaiting_payment_expiry: "等支付过期",
    unused: "未使用",
    not_found: "未找到",
    unknown: "未知"
  };
  return labels[normalized] || statusLabel(normalized);
}

export function getRowRedeemProgress(row, deps = {}) {
  const {
    isHistoricalAutoCycleRow: isHistoryRow,
    isRowAccountCooling: isCooling
  } = resolveDeps(deps);

  if (isHistoryRow(row)) {
    return { percent: 100, label: "历史", tone: "muted" };
  }

  const status = String(row?.status || "").trim();
  const statusStillMoving =
    ACTIVE_BACKEND_STATUSES.has(status) || ["local_ready", "submitting", "querying"].includes(status);
  if (isCooling(row) && !statusStillMoving) {
    return { percent: 100, label: "冷却", tone: "warning" };
  }

  const progressByStatus = {
    local_ready: { percent: 10, label: "待提交", tone: "pending" },
    submitting: { percent: 15, label: "提交中", tone: "info" },
    querying: { percent: 15, label: "查询中", tone: "info" },
    query_failed: { percent: 100, label: "查询失败", tone: "warning" },
    queued: { percent: 25, label: "排队", tone: "pending" },
    submitted: { percent: 25, label: "已提交", tone: "pending" },
    pending_dispatch: { percent: 25, label: "待兑换", tone: "pending" },
    dispatching: { percent: 50, label: "派发中", tone: "info" },
    dispatched: { percent: 55, label: "已派发", tone: "info" },
    running: { percent: 75, label: "兑换中", tone: "running" },
    processing: { percent: 75, label: "处理中", tone: "running" },
    success: { percent: 100, label: "成功", tone: "success" },
    failed: { percent: 100, label: "失败", tone: "danger" },
    rejected: { percent: 100, label: "拒绝", tone: "danger" },
    timeout: { percent: 100, label: "超时", tone: "warning" },
    invalid: { percent: 100, label: "无效", tone: "danger" },
    approve_blocked: { percent: 100, label: "审批阻塞", tone: "danger" },
    pm_unavailable: { percent: 100, label: "风控", tone: "danger" },
    awaiting_payment_expiry: { percent: 100, label: "等支付", tone: "warning" },
    cancelled: { percent: 100, label: "已取消", tone: "muted" },
    not_found: { percent: 100, label: "未找到", tone: "muted" },
    unused: { percent: 100, label: "未使用", tone: "muted" },
    unknown: { percent: 100, label: "未知", tone: "muted" }
  };

  return progressByStatus[status] || { percent: 0, label: compactStatus(status) || "-", tone: "muted" };
}

export function formatAttemptNumber(row) {
  const attempt = Number(row?.accountAttemptNumber || 0);
  if (!attempt) return "-";
  const safeAttempt = Math.min(Math.max(attempt, 1), ACCOUNT_ATTEMPT_LIMIT);
  return `${safeAttempt}/${ACCOUNT_ATTEMPT_LIMIT} 次`;
}

export function formatFailureReason(row, deps = {}) {
  const {
    canRetryVisibleRow,
    formatRowCooldownReason,
    isAccountDailyLimitReason: isDailyLimitReason,
    formatDailyLimitDisplayReason
  } = resolveDeps(deps);
  const reason = String(row?.reason || "").trim();
  const cooldownReason = formatRowCooldownReason(row);
  let visibleReason = reason;
  if (String(row?.status || "") === "pm_unavailable") {
    visibleReason = "账号风控不可用";
  } else if (isDailyLimitReason(reason)) {
    visibleReason = formatDailyLimitDisplayReason(row);
  } else if (/充值失败|兑换失败/.test(reason) && canRetryVisibleRow(row)) {
    visibleReason = `${reason}（可重试）`;
  }
  if (cooldownReason) {
    return visibleReason ? `${visibleReason}；${cooldownReason}` : cooldownReason;
  }
  return visibleReason;
}

export function getSubscriptionTone(row) {
  switch (row.subscriptionCategory) {
    case "plus":
      return "success";
    case "not_plus":
    case "missing_token":
      return "warning";
    case "token_invalid":
    case "no_account":
    case "http_error":
    case "timeout":
    case "network_error":
    case "remote_error":
    case "bad_response":
    case "unknown":
      return "danger";
    default:
      break;
  }

  switch (row.subscriptionStatus) {
    case "checking":
      return "info";
    case "plus":
      return "success";
    case "plus_missing_time":
      return "warning";
    case "not_plus":
    case "missing_token":
      return "warning";
    case "error":
      return "danger";
    default:
      return row.status === "success" ? "pending" : "";
  }
}

export function formatCdkUsageLine(row, deps = {}) {
  const channel = row.channelLabel || row.channel || "";
  const status = statusLabel(row.status);
  const email = String(row.email || "").trim();
  const account = row.status === "success" && email ? ` · 使用账号：${email}` : "";
  const duplicateSuccessCount = Number(row.cdkSuccessEmailCount || 0);
  const duplicateWarning =
    duplicateSuccessCount > 1 ? ` · 同邮箱多卡密成功 ${duplicateSuccessCount} 张` : "";
  const normalizedReason = formatFailureReason(row, deps);
  const reason =
    normalizedReason &&
    normalizedReason !== row.status &&
    normalizedReason !== status
      ? ` · ${normalizedReason}`
      : "";
  return `${row.cdkey}${channel ? ` · ${channel}` : ""}${account} · ${status}${duplicateWarning}${reason}`;
}

export function formatBackendRedeemLine(row, deps = {}) {
  const resolvedDeps = resolveDeps(deps);
  const channel = row.channelLabel || row.channel || "-";
  const failureReason = formatFailureReason(row, resolvedDeps);
  const reason = failureReason ? ` · 原因：${failureReason}` : "";
  const cancelFlag = resolvedDeps.canCancelRow(row) ? "可取消" : "不可取消";
  const retryFlag = resolvedDeps.canRetryVisibleRow(row) ? "可重试" : "不可重试";
  const tokenFlag = row.has_access_token ? "有token" : "无token";
  return `${row.cdkey} · ${channel} · ${compactStatus(row.status)}${reason} · ${cancelFlag} · ${retryFlag} · ${tokenFlag}`;
}

export function formatAccountStatusLine(row, deps = {}) {
  const status = row.status || "-";
  const plusLabel = getSubscriptionLabel(row);
  const reason =
    formatFailureReason(row, deps) ||
    row.subscriptionReason ||
    (row.status === "success" && row.isPlus !== true ? "兑换成功但未确认 Plus" : "-");
  return [
    row.email || "仅查询 CDK",
    row.cdkey || "-",
    formatAttemptNumber(row),
    status,
    statusLabel(status),
    plusLabel,
    reason
  ].join(DELIMITER);
}

function isAccountDailyLimitReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return false;
  return (
    /提交次数已达上限/.test(text) ||
    /今日提交次数.*上限/.test(text) ||
    (/已达上限/.test(text) && /24\s*(小时|h|H)?/.test(text)) ||
    (/24\s*(小时|h|H)?\s*后/.test(text) && /(再试|重试|才可|才能|可以|提交|兑换)/.test(text))
  );
}

function getRowReasonText(row) {
  const rawStatus = row?.rawStatus || {};
  return String(
    row?.reason ||
      row?.failureReason ||
      row?.message ||
      row?.error_message ||
      row?.errorMessage ||
      row?.result ||
      row?.state ||
      row?.status ||
      row?.accountCooldownReason ||
      rawStatus?.status ||
      rawStatus?.message ||
      rawStatus?.error ||
      rawStatus?.error_message ||
      rawStatus?.errorMessage ||
      rawStatus?.reason ||
      rawStatus?.result ||
      rawStatus?.state ||
      ""
  ).trim();
}

function getDailyLimitDisplayReason(row, suffix = "") {
  const reason = getRowReasonText(row);
  if (reason && isAccountDailyLimitReason(reason)) {
    const cooldownText = /封存|24\s*(小时|h|H)?\s*后/.test(reason) ? "" : "；已封存 24 小时";
    return `${reason}${cooldownText}${suffix}`;
  }
  const prefix = reason ? `${reason}；` : "";
  return `${prefix}${DAILY_LIMIT_DISPLAY_REASON}${suffix}`;
}
