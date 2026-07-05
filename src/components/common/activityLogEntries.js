const DEFAULT_MAX_VISIBLE_ENTRIES = 20;
const DEFAULT_MAX_SYNTHETIC_ERRORS = 8;
const SYNTHETIC_TIME_BASE = 1_700_000_000_000;

function normalizeText(value) {
  return String(value || "").trim();
}

function stableNumberHash(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function stableSyntheticTimestamp(key, index = 0) {
  return SYNTHETIC_TIME_BASE + (stableNumberHash(key) % 86_400_000) + index;
}

function createSyntheticErrorEntry(error, index) {
  const lineNumber = normalizeText(error?.lineNumber);
  const reason = normalizeText(error?.reason) || "未提供原因";
  const source = normalizeText(error?.source);
  const key = [lineNumber || "log", reason, source, index].join("|");

  return {
    id: `synthetic-error-${lineNumber || "log"}-${stableNumberHash(key).toString(36)}-${index}`,
    createdAt: stableSyntheticTimestamp(key, index),
    level: "warning",
    action: "validation",
    message: reason,
    meta: lineNumber ? `第 ${lineNumber} 行` : "校验提示",
    source
  };
}

function createSyntheticEntries({ entries, errors, statusMessage, lastUpdatedAt, maxSyntheticErrors }) {
  const realEntries = Array.isArray(entries) ? entries : [];
  const realErrors = Array.isArray(errors) ? errors : [];
  const synthetic = [];

  if (!realEntries.length && normalizeText(statusMessage)) {
    const key = `status|${normalizeText(statusMessage)}|${normalizeText(lastUpdatedAt)}`;
    synthetic.push({
      id: `synthetic-status-${stableNumberHash(key).toString(36)}`,
      createdAt: stableSyntheticTimestamp(key),
      level: "info",
      action: "status",
      message: statusMessage,
      meta: lastUpdatedAt || "尚未更新"
    });
  }

  realErrors.slice(0, maxSyntheticErrors).forEach((error, index) => {
    synthetic.push(createSyntheticErrorEntry(error, index));
  });

  const hiddenErrorCount = realErrors.length - maxSyntheticErrors;
  if (hiddenErrorCount > 0) {
    const key = `validation-summary|${realErrors.length}|${hiddenErrorCount}`;
    synthetic.push({
      id: `synthetic-error-summary-${realErrors.length}-${hiddenErrorCount}`,
      createdAt: stableSyntheticTimestamp(key, maxSyntheticErrors),
      level: "warning",
      action: "validation",
      message: `另 ${hiddenErrorCount} 条校验/预检问题`,
      meta: "校验汇总",
      source: ""
    });
  }

  return synthetic;
}

export function buildActivityLogEntries({
  entries = [],
  errors = [],
  statusMessage = "",
  lastUpdatedAt = "",
  maxEntries = DEFAULT_MAX_VISIBLE_ENTRIES,
  maxSyntheticErrors = DEFAULT_MAX_SYNTHETIC_ERRORS
} = {}) {
  const realEntries = Array.isArray(entries) ? entries : [];
  const syntheticEntries = createSyntheticEntries({
    entries: realEntries,
    errors,
    statusMessage,
    lastUpdatedAt,
    maxSyntheticErrors
  });
  const realEntryBudget = Math.max(maxEntries - syntheticEntries.length, 0);

  return [...realEntries.slice(0, realEntryBudget), ...syntheticEntries];
}
