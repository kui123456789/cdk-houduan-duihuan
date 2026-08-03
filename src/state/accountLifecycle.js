import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_COOLDOWN_MS,
  ATTEMPT_FAILURE_STATUSES,
  LOCAL_ATTEMPT_LIMIT_REASON
} from "../config/redeemConstants.js";
import { isQueryOnlyRow } from "../domain/statusMeta.js";

export function normalizeAccountCooldowns(value, now = Date.now()) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const entries = Object.entries(source)
    .map(([email, item]) => {
      const normalizedEmail = String(email || item?.email || "").trim().toLowerCase();
      const until = Number(item?.until || item?.cooldownUntil || 0);
      if (!normalizedEmail || until <= now) return null;
      return [
        normalizedEmail,
        {
          email: normalizedEmail,
          until,
          reason: String(item?.reason || "今日提交次数已达上限，封存 24 小时").trim(),
          startedAt: Number(item?.startedAt || now)
        }
      ];
    })
    .filter(Boolean);
  return Object.fromEntries(entries);
}

export function getCooledEmailSet(cooldowns, now = Date.now()) {
  return new Set(Object.keys(normalizeAccountCooldowns(cooldowns, now)));
}

export function getAccountCooldown(email, cooldowns, now = Date.now()) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;
  const normalized = normalizeAccountCooldowns(cooldowns, now);
  return normalized[normalizedEmail] || null;
}

export function isAccountDailyLimitReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return false;
  return (
    /提交次数已达上限/.test(text) ||
    /今日提交次数.*上限/.test(text) ||
    (/已达上限/.test(text) && /24\s*(小时|h|H)?/.test(text)) ||
    (/24\s*(小时|h|H)?\s*后/.test(text) && /(再试|重试|才可|才能|可以|提交|兑换)/.test(text))
  );
}

export function isLimitCooldownReason(reason) {
  const text = String(reason || "").trim();
  return (
    isAccountDailyLimitReason(text) ||
    /24\s*小时内已提交\s*3\s*次/.test(text) ||
    /最多尝试\s*3\s*次/.test(text)
  );
}

export function formatCooldownUntil(until) {
  const date = new Date(Number(until || 0));
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

export function isRowAccountCooling(row, now = Date.now()) {
  return Number(row?.accountCooldownUntil || 0) > now;
}

export function formatRowCooldownReason(row, now = Date.now()) {
  return isRowAccountCooling(row, now)
    ? `账号已封存至 ${formatCooldownUntil(row.accountCooldownUntil)}`
    : "";
}

export function shouldBlockFourthAttempt(accountAttemptNumber) {
  return Number(accountAttemptNumber || 0) >= ACCOUNT_ATTEMPT_LIMIT;
}

export function applyCooldownMarkersToRows(rowList, cooldowns, now = Date.now()) {
  const normalized = normalizeAccountCooldowns(cooldowns, now);
  return (rowList || []).map((row) => {
    if (isQueryOnlyRow(row)) {
      if (
        !row?.accountCooldownUntil &&
        !row?.accountCooldownReason &&
        Number(row?.accountAttemptNumber || 0) === 0
      ) {
        return row;
      }
      return {
        ...row,
        accountCooldownUntil: 0,
        accountCooldownReason: "",
        accountAttemptNumber: 0
      };
    }
    if (String(row?.status || "") === "success") {
      if (!row?.accountCooldownUntil && !row?.accountCooldownReason) return row;
      return {
        ...row,
        accountCooldownUntil: 0,
        accountCooldownReason: ""
      };
    }
    const email = String(row?.email || "").trim().toLowerCase();
    const cooldown = email ? normalized[email] : null;
    if (!cooldown) {
      if (!row?.accountCooldownUntil && !row?.accountCooldownReason) return row;
      return {
        ...row,
        accountCooldownUntil: 0,
        accountCooldownReason: ""
      };
    }
    return {
      ...row,
      accountCooldownUntil: cooldown.until,
      accountCooldownReason: cooldown.reason,
      accountAttemptNumber: isLimitCooldownReason(cooldown.reason)
        ? ACCOUNT_ATTEMPT_LIMIT
        : row.accountAttemptNumber
    };
  });
}

function getLedgerAttemptCount(ledger, email) {
  const entry = ledger && typeof ledger === "object" ? ledger[email] : null;
  if (Array.isArray(entry?.attempts)) return entry.attempts.length;
  return Math.max(Number(entry?.count || 0), 0);
}

export function syncAttemptLimitCooldownState({
  ledger = {},
  cooldowns = {},
  rows = [],
  now = Date.now()
} = {}) {
  let nextCooldowns = normalizeAccountCooldowns(cooldowns, now);
  let cooldownsChanged = false;
  const cooledEmails = [];

  Object.entries(nextCooldowns).forEach(([email, cooldown]) => {
    if (
      String(cooldown?.reason || "") === LOCAL_ATTEMPT_LIMIT_REASON &&
      getLedgerAttemptCount(ledger, email) < ACCOUNT_ATTEMPT_LIMIT
    ) {
      delete nextCooldowns[email];
      cooldownsChanged = true;
    }
  });

  const reconciledRows = (Array.isArray(rows) ? rows : []).map((row) => {
    if (isQueryOnlyRow(row)) return row;
    const email = String(row?.email || "").trim().toLowerCase();
    const ledgerCount = email ? getLedgerAttemptCount(ledger, email) : 0;
    const accountAttemptNumber = Math.min(
      Math.max(Number(row?.accountAttemptNumber || 0), ledgerCount || 0, 1),
      ACCOUNT_ATTEMPT_LIMIT
    );
    return Number(row?.accountAttemptNumber || 0) === accountAttemptNumber
      ? row
      : { ...row, accountAttemptNumber };
  });

  reconciledRows.forEach((row) => {
    if (isQueryOnlyRow(row)) return;
    const email = String(row?.email || "").trim().toLowerCase();
    if (!email || getLedgerAttemptCount(ledger, email) < ACCOUNT_ATTEMPT_LIMIT) return;
    if (!ATTEMPT_FAILURE_STATUSES.has(String(row?.status || ""))) return;
    if (nextCooldowns[email]) return;

    nextCooldowns[email] = {
      email,
      until: now + ACCOUNT_COOLDOWN_MS,
      reason: LOCAL_ATTEMPT_LIMIT_REASON,
      startedAt: now
    };
    cooledEmails.push(email);
    cooldownsChanged = true;
  });

  const markedRows = applyCooldownMarkersToRows(reconciledRows, nextCooldowns, now);
  const rowsChanged = markedRows.some((row, index) => row !== rows[index]);
  return {
    cooldowns: nextCooldowns,
    rows: markedRows,
    cooledEmails,
    changed: cooldownsChanged || rowsChanged
  };
}
