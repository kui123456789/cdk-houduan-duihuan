import { normalizeAccountText } from "./accountParsing.js";
import { createEmptyEmailVerificationState } from "./emailVerification.js";
import { createEmptySubscriptionState } from "./subscriptionDiagnostics.js";

export const ACCOUNT_AUDIT_STATUS_META = {
  banned: { label: "已封禁", tone: "danger" },
  plus_verified: { label: "Plus 已验证", tone: "success" },
  plus_pending_email: { label: "Plus 待邮箱验证", tone: "warning" },
  not_plus: { label: "非 Plus", tone: "muted" },
  token_invalid: { label: "Token 失效", tone: "danger" },
  no_account: { label: "账号不存在", tone: "danger" },
  check_failed: { label: "检查失败", tone: "danger" },
  pending: { label: "待检查", tone: "muted" }
};

export const ACCOUNT_AUDIT_FILTERS = [
  { id: "all", label: "全部" },
  { id: "plus_verified", label: "Plus 已验证" },
  { id: "plus_pending_email", label: "Plus 待邮箱" },
  { id: "banned", label: "已封禁" },
  { id: "not_plus", label: "非 Plus" },
  { id: "token_invalid", label: "Token 失效" },
  { id: "no_account", label: "账号不存在" },
  { id: "check_failed", label: "检查失败" },
  { id: "pending", label: "待检查" }
];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function getAccountAuditRowKey(row) {
  return [normalizeEmail(row?.email), String(row?.accessToken || "").trim(), String(row?.pickupUrl || "").trim()].join("|");
}

export function createAccountAuditRow(account, index = 0) {
  return {
    id: `account-audit-${index + 1}-${normalizeEmail(account?.email) || "unknown"}`,
    lineNumber: Number(account?.lineNumber || index + 1),
    source: String(account?.source || ""),
    email: String(account?.email || "").trim(),
    password: String(account?.password || ""),
    twofa: String(account?.twofa || ""),
    pickupUrl: String(account?.pickupUrl || "").trim(),
    accessToken: String(account?.accessToken || "").trim(),
    timestamp: String(account?.timestamp || "").trim(),
    inputFormat: String(account?.inputFormat || ""),
    ...createEmptySubscriptionState(),
    ...createEmptyEmailVerificationState()
  };
}

export function buildAccountAuditRows(inputText) {
  const validation = normalizeAccountText(inputText);
  return {
    ...validation,
    rows: validation.accounts.map((account, index) => createAccountAuditRow(account, index))
  };
}

export function getAccountAuditStatus(row) {
  if (row?.emailBanned === true || row?.emailVerificationStatus === "banned") return "banned";

  const subscriptionCategory = String(row?.subscriptionCategory || "");
  const subscriptionStatus = String(row?.subscriptionStatus || "");
  if (subscriptionStatus === "plus" || subscriptionCategory === "plus") {
    if (row?.emailPlusVerified === true || row?.emailVerificationStatus === "verified") return "plus_verified";
    if (["error"].includes(String(row?.emailVerificationStatus || ""))) return "check_failed";
    return "plus_pending_email";
  }
  if (subscriptionCategory === "token_invalid") return "token_invalid";
  if (subscriptionCategory === "no_account") return "no_account";
  if (subscriptionStatus === "not_plus" || subscriptionCategory === "not_plus") return "not_plus";
  if (subscriptionStatus === "missing_token" || subscriptionCategory === "missing_token") return "check_failed";
  if (subscriptionStatus === "error" || subscriptionCategory === "unknown") return "check_failed";
  if (row?.emailVerificationStatus === "error") return "check_failed";
  return "pending";
}

export function getAccountAuditStatusMeta(row) {
  const status = getAccountAuditStatus(row);
  return { status, ...(ACCOUNT_AUDIT_STATUS_META[status] || ACCOUNT_AUDIT_STATUS_META.pending) };
}

export function getAccountAuditCounts(rows = []) {
  const counts = Object.fromEntries(Object.keys(ACCOUNT_AUDIT_STATUS_META).map((key) => [key, 0]));
  (rows || []).forEach((row) => {
    const status = getAccountAuditStatus(row);
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

export function filterAccountAuditRows(rows, filter = "all") {
  if (filter === "all") return rows || [];
  return (rows || []).filter((row) => getAccountAuditStatus(row) === filter);
}

export function getAccountAuditExportRows(rows, filter) {
  return filterAccountAuditRows(rows, filter)
    .map((row) => String(row?.source || "").trim())
    .filter(Boolean);
}
