import {
  ACCOUNT_ATTEMPT_LIMIT as CONFIG_ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_COOLDOWN_MS as CONFIG_ACCOUNT_COOLDOWN_MS
} from "../config/redeemConstants.js";

export const ACCOUNT_ATTEMPT_LIMIT = CONFIG_ACCOUNT_ATTEMPT_LIMIT;
export const ACCOUNT_COOLDOWN_MS = CONFIG_ACCOUNT_COOLDOWN_MS;

const CLOCK_SKEW_MS = 5000;
const DEFAULT_COOLDOWN_REASON = "该账号 24 小时内已提交 3 次，已封存 24 小时，避免触发后台限制";
const ACTIVE_TASK_STATUSES = new Set([
  "pending_dispatch",
  "submitting",
  "queued",
  "dispatched",
  "running",
  "processing",
  "local_ready",
  "querying",
  "dispatching",
  "submitted"
]);
const PERMANENT_TOKEN_RESERVATION_STATUSES = new Set(["success", "pm_unavailable"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccessToken(value) {
  return String(value || "").trim();
}

function getNow(options = {}) {
  const value = Number(options.now);
  return Number.isFinite(value) ? value : Date.now();
}

function getActiveCooldownUntil(item, now) {
  const until = Number(item?.cooldownUntil || item?.until || 0);
  return until > now ? until : 0;
}

function normalizeAttempts(value, now) {
  const cutoff = now - ACCOUNT_COOLDOWN_MS;
  return (Array.isArray(value) ? value : [])
    .map((timestamp) => Number(timestamp || 0))
    .filter((timestamp) => timestamp > cutoff && timestamp <= now + CLOCK_SKEW_MS)
    .sort((left, right) => left - right);
}

function isInAttemptWindow(timestamp, now) {
  return timestamp > now - ACCOUNT_COOLDOWN_MS && timestamp <= now + CLOCK_SKEW_MS;
}

function positiveTimestamp(value) {
  const timestamp = Number(value || 0);
  return timestamp > 0 ? timestamp : 0;
}

function normalizeAttemptCount(value) {
  return Math.min(ACCOUNT_ATTEMPT_LIMIT, Math.max(Number(value || 0), 0));
}

function normalizeEntryAttempts(item, now) {
  const rawAttempts = Array.isArray(item) ? item : item?.attempts;
  const attempts = normalizeAttempts(rawAttempts, now);
  const rawAttemptCount = normalizeAttemptCount(item?.attemptCount);
  const syntheticTimestamp = positiveTimestamp(item?.lastAttemptAt || item?.updatedAt || item?.firstAttemptAt);

  if (rawAttemptCount > attempts.length && isInAttemptWindow(syntheticTimestamp, now)) {
    while (attempts.length < rawAttemptCount) {
      attempts.push(syntheticTimestamp);
    }
  }

  return normalizeAttempts(attempts, now);
}

function createLedgerEntry(email, item, now) {
  const attempts = normalizeEntryAttempts(item, now);
  const cooldownUntil = getActiveCooldownUntil(item, now);
  const cooldownReason = cooldownUntil
    ? String(item?.cooldownReason || item?.reason || DEFAULT_COOLDOWN_REASON).trim()
    : "";
  const rawAttemptCount = normalizeAttemptCount(item?.attemptCount);
  const attemptCount = Math.min(
    ACCOUNT_ATTEMPT_LIMIT,
    cooldownUntil ? Math.max(attempts.length, rawAttemptCount) : attempts.length
  );

  if (!attempts.length && !cooldownUntil && !attemptCount) return null;

  const firstAttemptAt =
    attempts[0] ||
    (attemptCount
      ? positiveTimestamp(item?.firstAttemptAt || item?.lastAttemptAt || item?.updatedAt) || now
      : 0);
  const lastAttemptAt =
    attempts[attempts.length - 1] ||
    (attemptCount
      ? positiveTimestamp(item?.lastAttemptAt || item?.updatedAt || item?.firstAttemptAt) || firstAttemptAt
      : 0);

  return {
    email,
    attempts,
    attemptCount,
    firstAttemptAt,
    lastAttemptAt,
    cooldownUntil,
    cooldownReason,
    updatedAt: positiveTimestamp(item?.updatedAt) || lastAttemptAt || now
  };
}

function normalizeCooldowns(value, now) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([email, item]) => {
        const normalizedEmail = normalizeEmail(item?.email || email);
        const until = Number(item?.until || item?.cooldownUntil || 0);
        if (!normalizedEmail || until <= now) return null;
        return [
          normalizedEmail,
          {
            email: normalizedEmail,
            until,
            reason: String(item?.reason || item?.cooldownReason || DEFAULT_COOLDOWN_REASON).trim()
          }
        ];
      })
      .filter(Boolean)
  );
}

function getLedgerNormalizationNow(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const timestamps = Object.values(source).flatMap((item) => [
    ...(Array.isArray(item) ? item : Array.isArray(item?.attempts) ? item.attempts : []),
    item?.firstAttemptAt,
    item?.lastAttemptAt,
    item?.updatedAt
  ]);
  return Math.max(0, ...timestamps.map(Number).filter(Number.isFinite));
}

function isLimitCooldownReason(reason) {
  const text = String(reason || "").trim();
  return (
    /提交次数已达上限/.test(text) ||
    /今日提交次数.*上限/.test(text) ||
    /24\s*小时内已提交\s*3\s*次/.test(text) ||
    /最多尝试\s*3\s*次/.test(text)
  );
}

function isCompletedPlus(row) {
  return (
    String(row?.status || "").toLowerCase() === "success" &&
    (String(row?.subscriptionStatus || "").toLowerCase() === "plus" ||
      row?.subscriptionActive === true)
  );
}

export function isAccountTaskReservationRow(row, options = {}) {
  const now = getNow(options);
  if (row?.hidden === true || row?.statusOwner === false) return false;
  if (ACTIVE_TASK_STATUSES.has(String(row?.status || "").toLowerCase())) return true;
  return row?.staleStatusGuard === true && Number(row?.retryHoldUntil || 0) > now;
}

export function getReservedAccountAccessTokens(rows = [], options = {}) {
  const reserved = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const status = String(row?.status || "").toLowerCase();
    const reservedByStatus = PERMANENT_TOKEN_RESERVATION_STATUSES.has(status);
    if (!reservedByStatus && !isAccountTaskReservationRow(row, options)) continue;
    const accessToken = normalizeAccessToken(row?.accessToken);
    if (accessToken) reserved.add(accessToken);
  }

  return reserved;
}

export function normalizeAccountLedger(value, options = {}) {
  const now = getNow(options);
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([email, item]) => {
        const normalizedEmail = normalizeEmail(item?.email || email);
        if (!normalizedEmail) return null;
        const entry = createLedgerEntry(normalizedEmail, item, now);
        return entry ? [normalizedEmail, entry] : null;
      })
      .filter(Boolean)
  );
}

export function recordAccountSubmitAttempt(ledger, email, options = {}) {
  const now = getNow(options);
  const normalizedEmail = normalizeEmail(email);
  const normalized = normalizeAccountLedger(ledger, { now });
  if (!normalizedEmail) return normalized;

  const lifecycle = getAccountLifecycle(normalized, normalizedEmail, { now });
  if (lifecycle.cooling) return normalized;
  if (lifecycle.attemptCount >= ACCOUNT_ATTEMPT_LIMIT) {
    return startAccountCooldown(normalized, normalizedEmail, {
      now,
      reason: options.reason || DEFAULT_COOLDOWN_REASON,
      forceAttemptLimit: true
    });
  }

  const current = normalized[normalizedEmail] || {
    email: normalizedEmail,
    attempts: []
  };
  const attempts = normalizeAttempts([...(current.attempts || []), now], now);
  return {
    ...normalized,
    [normalizedEmail]: createLedgerEntry(
      normalizedEmail,
      {
        ...current,
        attempts,
        updatedAt: now
      },
      now
    )
  };
}

export function startAccountCooldown(ledger, email, options = {}) {
  const now = getNow(options);
  const normalizedEmail = normalizeEmail(email);
  const normalized = normalizeAccountLedger(ledger, { now });
  if (!normalizedEmail) return normalized;

  const current = normalized[normalizedEmail] || {
    email: normalizedEmail,
    attempts: []
  };
  const attempts = [...(current.attempts || [])];
  if (options.forceAttemptLimit === true) {
    while (attempts.length < ACCOUNT_ATTEMPT_LIMIT) {
      attempts.push(now);
    }
  }

  return {
    ...normalized,
    [normalizedEmail]: createLedgerEntry(
      normalizedEmail,
      {
        ...current,
        attempts,
        attemptCount: options.forceAttemptLimit === true ? ACCOUNT_ATTEMPT_LIMIT : current.attemptCount,
        cooldownUntil: Number(options.until || options.cooldownUntil || 0) || now + ACCOUNT_COOLDOWN_MS,
        cooldownReason: options.reason || current.cooldownReason || DEFAULT_COOLDOWN_REASON,
        updatedAt: now
      },
      now
    )
  };
}

export function clearAccountLifecycleBlocks({ emails = [], ledger = {}, cooldowns = {}, rows = [] } = {}) {
  const targetEmails = new Set((Array.isArray(emails) ? emails : []).map(normalizeEmail).filter(Boolean));
  const ledgerSource = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : {};
  const retainedLedger = Object.fromEntries(
    Object.entries(ledgerSource).filter(([email, item]) => !targetEmails.has(normalizeEmail(item?.email || email)))
  );
  const normalizedLedger = normalizeAccountLedger(retainedLedger, {
    now: getLedgerNormalizationNow(retainedLedger)
  });
  const normalizedCooldowns = normalizeCooldowns(cooldowns, 0);

  for (const email of targetEmails) {
    delete normalizedCooldowns[email];
  }

  return {
    ledger: normalizedLedger,
    cooldowns: normalizedCooldowns,
    rows: (Array.isArray(rows) ? rows : []).map((row) => {
      const email = normalizeEmail(row?.email);
      if (!email || !targetEmails.has(email)) return row;
      return {
        ...row,
        accountCooldownUntil: 0,
        accountCooldownReason: "",
        accountAttemptNumber: 0,
        attemptNumber: 0
      };
    }),
    restoredEmails: [...targetEmails]
  };
}

export function getAccountLifecycle(ledger, email, options = {}) {
  const now = getNow(options);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      email: "",
      attemptCount: 0,
      cooling: false,
      canSubmit: false,
      cooldownUntil: 0,
      reason: "",
      limitReached: false
    };
  }

  const normalized = normalizeAccountLedger(ledger, { now });
  const entry = normalized[normalizedEmail];
  const attemptCount = Math.min(
    ACCOUNT_ATTEMPT_LIMIT,
    Number(entry?.attemptCount || entry?.attempts?.length || 0)
  );
  const cooldownUntil = Number(entry?.cooldownUntil || 0);
  const cooling = cooldownUntil > now;
  const limitReached = attemptCount >= ACCOUNT_ATTEMPT_LIMIT;

  return {
    email: normalizedEmail,
    attemptCount,
    attempts: entry?.attempts || [],
    cooling,
    canSubmit: !cooling && !limitReached,
    cooldownUntil: cooling ? cooldownUntil : 0,
    reason: cooling ? String(entry?.cooldownReason || DEFAULT_COOLDOWN_REASON).trim() : "",
    limitReached,
    lastAllowedAttemptReached: limitReached
  };
}

export function getAccountAvailabilityFacts({
  accounts = [],
  rows = [],
  ledger = {},
  cooldowns = {},
  now = Date.now()
} = {}) {
  const normalizedLedger = normalizeAccountLedger(ledger, { now });
  const normalizedCooldowns = normalizeCooldowns(cooldowns, now);
  const accountList = Array.isArray(accounts) ? accounts : [];
  const accountEmails = new Set(accountList.map((account) => normalizeEmail(account?.email)).filter(Boolean));
  const categories = {
    cooling: new Set(),
    attemptLimited: new Set(),
    activeTask: new Set(),
    completedPlus: new Set()
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const email = normalizeEmail(row?.email);
    if (!email) continue;
    if (isAccountTaskReservationRow(row, { now })) categories.activeTask.add(email);
    if (isCompletedPlus(row)) categories.completedPlus.add(email);
  }

  const lifecycleEmails = new Set([
    ...accountEmails,
    ...Object.keys(normalizedLedger),
    ...Object.keys(normalizedCooldowns)
  ]);

  for (const email of lifecycleEmails) {
    const lifecycle = getAccountLifecycle(normalizedLedger, email, { now });
    const externalCooldown = normalizedCooldowns[email];
    const cooling = lifecycle.cooling || Boolean(externalCooldown);
    if (lifecycle.limitReached) categories.attemptLimited.add(email);
    if (!cooling) continue;
    categories.cooling.add(email);
    if (
      lifecycle.limitReached ||
      isLimitCooldownReason(lifecycle.reason) ||
      isLimitCooldownReason(externalCooldown?.reason)
    ) {
      categories.attemptLimited.add(email);
    }
  }

  const blockedEmails = new Set(Object.values(categories).flatMap((category) => [...category]));
  const availableAccounts = accountList.filter((account) => !blockedEmails.has(normalizeEmail(account?.email)));
  const countInAccounts = (set) => [...accountEmails].filter((email) => set.has(email)).length;

  return {
    pool: accountList.length,
    available: availableAccounts.length,
    cooling: countInAccounts(categories.cooling),
    attemptLimited: countInAccounts(categories.attemptLimited),
    activeTask: countInAccounts(categories.activeTask),
    completedPlus: countInAccounts(categories.completedPlus),
    availableAccounts,
    blockedEmails
  };
}
