import { ACCOUNT_ATTEMPT_LIMIT } from "../config/redeemConstants.js";

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
