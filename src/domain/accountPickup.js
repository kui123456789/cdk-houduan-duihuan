import { createEmptyEmailVerificationState } from "./emailVerification.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeToken(value) {
  return String(value || "").trim();
}

export function extractPickupUrl(value) {
  const parts = String(value || "")
    .split("---")
    .map((part) => part.trim());
  return parts.find((part) => /^https?:\/\//i.test(part)) || "";
}

function buildPickupLookups(accounts = []) {
  const byToken = new Map();
  const byEmail = new Map();

  accounts.forEach((account) => {
    const pickupUrl = String(account?.pickupUrl || "").trim() || extractPickupUrl(account?.source);
    if (!pickupUrl) return;
    const token = normalizeToken(account?.accessToken);
    const email = normalizeEmail(account?.email);
    if (token) byToken.set(token, pickupUrl);
    if (email) byEmail.set(email, pickupUrl);
  });

  return { byToken, byEmail };
}

function resolvePickupUrl(item, lookups) {
  const direct = String(item?.pickupUrl || "").trim();
  if (direct) return direct;
  const embedded = [item?.source, item?.rawLine, item?.exportLine]
    .map(extractPickupUrl)
    .find(Boolean);
  if (embedded) return embedded;
  const tokenMatch = lookups.byToken.get(normalizeToken(item?.accessToken));
  if (tokenMatch) return tokenMatch;
  return lookups.byEmail.get(normalizeEmail(item?.email)) || "";
}

export function enrichRowsWithPickupUrls(rows = [], accounts = []) {
  const lookups = buildPickupLookups(accounts);
  let changed = false;
  const nextRows = (rows || []).map((row) => {
    if (String(row?.pickupUrl || "").trim()) return row;
    const pickupUrl = resolvePickupUrl(row, lookups);
    if (!pickupUrl) return row;
    changed = true;
    return {
      ...row,
      ...(["missing_url", "subscription_only"].includes(row?.emailVerificationCategory)
        ? createEmptyEmailVerificationState()
        : {}),
      pickupUrl
    };
  });
  return changed ? nextRows : rows;
}

export function enrichAccountLedgerPickupUrls(ledger = {}, accounts = []) {
  const source = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : {};
  const lookups = buildPickupLookups(accounts);
  let changed = false;
  const entries = Object.entries(source).map(([email, entry]) => {
    if (!Array.isArray(entry?.redemptionAttempts)) return [email, entry];
    let attemptsChanged = false;
    const redemptionAttempts = entry.redemptionAttempts.map((attempt) => {
      if (String(attempt?.pickupUrl || "").trim()) return attempt;
      const pickupUrl = resolvePickupUrl({ ...attempt, email: attempt?.email || email }, lookups);
      if (!pickupUrl) return attempt;
      attemptsChanged = true;
      return { ...attempt, pickupUrl };
    });
    if (!attemptsChanged) return [email, entry];
    changed = true;
    return [email, { ...entry, redemptionAttempts }];
  });
  return changed ? Object.fromEntries(entries) : ledger;
}
