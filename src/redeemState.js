import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_COOLDOWN_MS,
  ACTIVE_BACKEND_STATUSES
} from "./config/redeemConstants.js";

export { ACCOUNT_ATTEMPT_LIMIT, ACCOUNT_COOLDOWN_MS };
export {
  classifyCdkeyPreflight,
  isExplicitCancelReason
} from "./state/cdkPreflight.js";

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function isCooldownReason(value) {
  const text = String(value || "");
  return (
    /提交次数已达上限/.test(text) ||
    /今日提交次数.*上限/.test(text) ||
    /账号.*已尝试\s*3\s*次/.test(text) ||
    /超过\s*3\s*次限制/.test(text) ||
    (/24\s*(小时|h|H)?\s*后/.test(text) && /(再试|重试|才可|才能|可以|提交|兑换)/.test(text))
  );
}

export function getAttemptCount(email, attemptLedger, now = Date.now()) {
  const key = normalizeEmail(email);
  const item = attemptLedger?.[key];
  const attempts = Array.isArray(item?.attempts) ? item.attempts : Array.isArray(item) ? item : [];
  const cutoff = now - ACCOUNT_COOLDOWN_MS;
  return attempts
    .map((timestamp) => Number(timestamp || 0))
    .filter((timestamp) => timestamp > cutoff && timestamp <= now + 5000).length;
}

export function getNextAttemptCount(email, attemptLedger, now = Date.now()) {
  return Math.min(ACCOUNT_ATTEMPT_LIMIT, getAttemptCount(email, attemptLedger, now) + 1);
}

export function isFourthAttemptBlocked(email, attemptLedger, now = Date.now()) {
  return getAttemptCount(email, attemptLedger, now) >= ACCOUNT_ATTEMPT_LIMIT;
}

export function isCooling(email, cooldowns, now = Date.now()) {
  const key = normalizeEmail(email);
  const item = cooldowns?.[key];
  return Boolean(item?.until && Number(item.until) > now);
}

export function computeAccountFacts({
  accounts = [],
  rows = [],
  cooldowns = {},
  attemptLedger = {},
  processedEmails = new Set(),
  now = Date.now()
} = {}) {
  const accountEmails = new Set(accounts.map((account) => normalizeEmail(account?.email)).filter(Boolean));
  const activeTaskEmails = new Set(
    rows
      .filter((row) => row?.email && row?.statusOwner !== false && row?.hidden !== true)
      .filter((row) => ACTIVE_BACKEND_STATUSES.has(String(row.status || "")) || ["local_ready", "submitting"].includes(String(row.status || "")))
      .map((row) => normalizeEmail(row.email))
  );

  const facts = {
    pool: accounts.length,
    available: 0,
    cooling: 0,
    attemptBlocked: 0,
    taskOccupied: 0,
    processed: 0,
    unavailable: 0,
    blockedEmails: new Set(),
    availableAccounts: []
  };

  for (const account of accounts) {
    const email = normalizeEmail(account?.email);
    if (!email) continue;
    if (processedEmails.has(email)) {
      facts.processed += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    if (isCooling(email, cooldowns, now)) {
      facts.cooling += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    if (isFourthAttemptBlocked(email, attemptLedger, now)) {
      facts.attemptBlocked += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    if (activeTaskEmails.has(email)) {
      facts.taskOccupied += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    facts.available += 1;
    facts.availableAccounts.push(account);
  }

  facts.unavailable = [...accountEmails].filter((email) => facts.blockedEmails.has(email)).length;
  return facts;
}

export function computeRowProgress(row) {
  const status = String(row?.status || "unknown").toLowerCase();
  const reason = String(row?.reason || row?.failureReason || row?.accountCooldownReason || "");
  if (status === "success") return { label: "成功", percent: 100, tone: "success" };
  if (["failed", "rejected", "timeout", "invalid", "approve_blocked", "pm_unavailable", "awaiting_payment_expiry"].includes(status)) {
    if (row?.accountCooldownUntil || isCooldownReason(reason)) {
      return { label: "冷却", percent: 100, tone: "warning" };
    }
    return { label: "失败", percent: 100, tone: "danger" };
  }
  if (status === "cancelled") return { label: "已取消", percent: 100, tone: "muted" };
  if (["not_found", "unused", "unknown"].includes(status)) return { label: "未使用", percent: 100, tone: "muted" };
  if (["running", "processing"].includes(status)) return { label: "兑换中", percent: 75, tone: "active" };
  if (["dispatching", "dispatched"].includes(status)) return { label: "已派发", percent: 55, tone: "active" };
  if (["queued", "submitted", "pending_dispatch"].includes(status)) return { label: "待兑换", percent: 25, tone: "pending" };
  return { label: "准备中", percent: 15, tone: "pending" };
}
