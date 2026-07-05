import {
  ACTIVE_BACKEND_STATUSES,
  EMPTY_PREFLIGHT_SUMMARY
} from "../config/redeemConstants.js";

function toCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function hasOwnValue(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function getBooleanFlag(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (!hasOwnValue(source, key)) continue;
    const value = source[key];
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "是"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "否"].includes(normalized)) return false;
    }
  }
  return null;
}

function getBooleanFlagFromSources(sources, keys) {
  for (const source of sources) {
    const value = getBooleanFlag(source, keys);
    if (value !== null) return value;
  }
  return null;
}

function getSummarySeed(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {};
  return {
    ...(options.summary && typeof options.summary === "object" ? options.summary : {}),
    ...options
  };
}

function getPreflightItem(entry) {
  if (entry && typeof entry === "object") {
    if (hasOwnValue(entry, "preflightItem")) return entry.preflightItem;
    if (hasOwnValue(entry, "item")) return entry.item;
  }
  return entry;
}

function getPreflightBlockedReason(entry) {
  if (!entry || typeof entry !== "object") return "";
  return String(entry.blockedReason || entry.blockingReason || "").trim();
}

const USED_FLAG_KEYS = ["used", "is_used", "redeemed", "consumed", "is_redeemed"];
const AVAILABLE_FLAG_KEYS = ["available", "can_redeem", "redeemable", "unused"];
const RETRY_FLAG_KEYS = ["can_retry"];
const REUSE_TOKEN_FLAG_KEYS = ["can_reuse_token"];
const ACCESS_TOKEN_FLAG_KEYS = ["has_access_token"];

export function isExplicitCancelReason(value) {
  const text = String(value || "");
  return /用户取消|已取消兑换|CDK\s*可重新提交|可重新提交/.test(text);
}

export function classifyCdkeyPreflight(item, blockedReason = "") {
  if (blockedReason) {
    return { usable: false, bucket: "busy", used: false, occupied: true, reason: blockedReason };
  }
  if (!item) {
    return { usable: true, bucket: "available", used: false, occupied: false, reason: "" };
  }

  const status = String(item.status || item.state || item.result || "").trim().toLowerCase();
  const raw = item.rawStatus || item;
  const flagSources = [item, raw];
  const usedFlag = getBooleanFlag(raw, USED_FLAG_KEYS);
  const availableFlag = getBooleanFlag(raw, AVAILABLE_FLAG_KEYS);
  const reason = String(
    item.reason || item.message || item.error_message || raw.reason || raw.message || raw.error || ""
  ).trim();

  if (
    ["unused", "not_found"].includes(status) ||
    (status === "" && usedFlag !== true) ||
    usedFlag === false ||
    availableFlag === true
  ) {
    return { usable: true, bucket: "available", used: false, occupied: false, reason: "" };
  }

  if (status === "cancelled" || ((status === "failed" || status === "timeout") && isExplicitCancelReason(reason))) {
    return { usable: true, bucket: "available", used: false, occupied: false, reason };
  }

  if (
    ["failed", "timeout"].includes(status) &&
    getBooleanFlagFromSources(flagSources, RETRY_FLAG_KEYS) === true &&
    getBooleanFlagFromSources(flagSources, REUSE_TOKEN_FLAG_KEYS) === true &&
    getBooleanFlagFromSources(flagSources, ACCESS_TOKEN_FLAG_KEYS) === true
  ) {
    return { usable: true, bucket: "available", used: false, occupied: false, reason };
  }

  if (status === "success" || usedFlag === true) {
    return { usable: false, bucket: "used", used: true, occupied: false, reason: reason || "卡密已使用，未提交" };
  }

  if (ACTIVE_BACKEND_STATUSES.has(status) || ["local_ready", "submitting"].includes(status)) {
    return { usable: false, bucket: "busy", used: false, occupied: true, reason: reason || "卡密占用中，未提交" };
  }

  if (
    status === "unknown" ||
    /查询失败|返回异常|状态无法确认|无返回|未返回/.test(reason)
  ) {
    return { usable: true, bucket: "available", used: false, occupied: false, reason };
  }

  return {
    usable: false,
    bucket: "unknown",
    used: false,
    occupied: false,
    reason: reason || "卡密状态无法确认，未提交"
  };
}

export function canSubmitPreflightItem(item, blockedReason = "") {
  return classifyCdkeyPreflight(item, blockedReason).usable;
}

export function buildPreflightSummary(items = [], options = {}) {
  const entries = Array.isArray(items) ? items : [];
  const seed = getSummarySeed(options);
  const summary = {
    ...EMPTY_PREFLIGHT_SUMMARY,
    checked: hasOwnValue(seed, "checked") ? toCount(seed.checked) : entries.length,
    waitingAccounts: toCount(seed.waitingAccounts),
    waitingCdkeys: toCount(seed.waitingCdkeys),
    submitted: toCount(seed.submitted)
  };

  entries.forEach((entry) => {
    const classification = classifyCdkeyPreflight(
      getPreflightItem(entry),
      getPreflightBlockedReason(entry)
    );
    const bucket = classification.bucket || "unknown";
    if (hasOwnValue(summary, bucket)) {
      summary[bucket] += 1;
    } else {
      summary.unknown += 1;
    }
  });

  summary.skipped = summary.used + summary.busy + summary.unknown;
  return summary;
}

export function getBlockingCdkeyReasons(rowList) {
  const reasons = new Map();
  (rowList || []).forEach((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey) return;
    const status = String(row?.status || "");
    if (row?.statusOwner === true && (ACTIVE_BACKEND_STATUSES.has(status) || ["local_ready", "submitting"].includes(status))) {
      reasons.set(cdkey, "卡密已有当前兑换任务，未提交");
      return;
    }
    if (status === "success") {
      reasons.set(cdkey, "卡密已使用，未提交");
    }
  });
  return reasons;
}
