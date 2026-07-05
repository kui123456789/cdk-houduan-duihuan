import {
  DEFAULT_UI_SETTINGS,
  DEFAULT_WORKSPACE_TAB,
  STORAGE_KEYS,
  WORKSPACE_TABS
} from "../config/redeemConstants.js";
import { normalizeAutoCycleState, normalizeFailedAccount } from "../state/redeemWorkflow.js";
import { normalizeAccountLedger } from "../workflow/accountLedger.js";

export const WORKFLOW_SNAPSHOT_VERSION = 1;

const SENSITIVE_ROW_FIELDS = ["password", "twofa", "accessToken", "exportLine", "rawLine"];
const SENSITIVE_ACCOUNT_FIELDS = ["password", "twofa", "accessToken", "exportLine", "rawLine", "source"];

function getNow(options = {}) {
  const value = Number(options.now);
  return Number.isFinite(value) ? value : Date.now();
}

function shouldPersistSensitive(options = {}) {
  return options.persistSensitive !== false;
}

function parseStoredValue(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readStorageKey(storage, key) {
  try {
    return storage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorageKey(storage, key, value) {
  try {
    if (!storage || typeof storage.setItem !== "function") return false;
    storage.setItem(key, value);
    return true;
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
    return false;
  }
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function normalizeRows(value) {
  return Array.isArray(value)
    ? value.filter((row) => row && typeof row === "object").map((row) => ({ ...row }))
    : [];
}

function sanitizeRows(rows, persistSensitive) {
  return normalizeRows(rows).map((row) => {
    if (persistSensitive) return row;
    const sanitized = { ...row };
    SENSITIVE_ROW_FIELDS.forEach((field) => {
      sanitized[field] = "";
    });
    return sanitized;
  });
}

function sanitizeAccountList(value, persistSensitive) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((item) => normalizeFailedAccount(item))
    .filter(Boolean)
    .map((account) => {
      if (persistSensitive) return account;
      const sanitized = { ...account };
      SENSITIVE_ACCOUNT_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
          sanitized[field] = "";
        }
      });
      return sanitized;
    });
}

function sanitizeAutoCycleState(value, persistSensitive) {
  const normalized = normalizeAutoCycleState(value);
  if (persistSensitive) return normalized;
  return {
    ...normalized,
    queue: normalized.queue.map((account) => {
      const sanitized = { ...account };
      SENSITIVE_ACCOUNT_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
          sanitized[field] = "";
        }
      });
      return sanitized;
    })
  };
}

function normalizeExportLines(value) {
  const lines = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  return [...new Set(lines.map((line) => String(line || "").trim()).filter(Boolean))];
}

function normalizePlusExports(value) {
  const source = normalizeObject(value);
  return {
    upi: normalizeExportLines(source.upi),
    ideal: normalizeExportLines(source.ideal)
  };
}

function normalizeDownloadedExportCounts(value) {
  const source = normalizeObject(value);
  return {
    upi: Math.max(Number(source.upi || 0), 0),
    ideal: Math.max(Number(source.ideal || 0), 0)
  };
}

function normalizeWorkspaceTab(value) {
  const id = String(value || "").trim();
  return WORKSPACE_TABS.some((tab) => tab.id === id) ? id : DEFAULT_WORKSPACE_TAB;
}

function normalizeUiSettings(value) {
  const source = normalizeObject(value);
  return {
    ...DEFAULT_UI_SETTINGS,
    activeWorkspaceTab: normalizeWorkspaceTab(source.activeWorkspaceTab),
    activeDetailRowId: String(source.activeDetailRowId || ""),
    showApiKey: source.showApiKey === true,
    pollingEnabled: source.pollingEnabled === true
  };
}

function getLegacyValue(legacy, key) {
  if (!legacy || typeof legacy !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(legacy, key)) return legacy[key];
  const storageKey = STORAGE_KEYS[key];
  if (storageKey && Object.prototype.hasOwnProperty.call(legacy, storageKey)) {
    return legacy[storageKey];
  }
  return undefined;
}

export function sanitizeWorkflowSnapshot(snapshot, options = {}) {
  const source = normalizeObject(snapshot);
  const persistSensitive = shouldPersistSensitive(options);
  const sanitized = {
    version: WORKFLOW_SNAPSHOT_VERSION,
    savedAt: Number(source.savedAt || 0) || getNow(options),
    rows: sanitizeRows(source.rows, persistSensitive),
    accountLedger: normalizeAccountLedger(source.accountLedger, { now: getNow(options) }),
    accountCooldowns: normalizeObject(source.accountCooldowns),
    autoCycleState: sanitizeAutoCycleState(source.autoCycleState, persistSensitive),
    failedAccounts: sanitizeAccountList(source.failedAccounts, persistSensitive),
    plusExports: normalizePlusExports(source.plusExports),
    downloadedExportCounts: normalizeDownloadedExportCounts(source.downloadedExportCounts),
    activityLog: Array.isArray(source.activityLog) ? source.activityLog : [],
    ui: normalizeUiSettings(source.ui)
  };

  if (Object.prototype.hasOwnProperty.call(source, "apiKey")) {
    sanitized.apiKey = persistSensitive ? String(source.apiKey || "") : "";
  }

  return sanitized;
}

export function loadWorkflowSnapshot(storage, options = {}) {
  const raw = readStorageKey(storage, STORAGE_KEYS.workflowSnapshot);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Number(parsed.version) !== WORKFLOW_SNAPSHOT_VERSION) return null;
  return sanitizeWorkflowSnapshot(parsed, options);
}

export function saveWorkflowSnapshot(storage, snapshot, options = {}) {
  try {
    const sanitized = sanitizeWorkflowSnapshot(snapshot, options);
    return writeStorageKey(storage, STORAGE_KEYS.workflowSnapshot, JSON.stringify(sanitized))
      ? sanitized
      : null;
  } catch {
    return null;
  }
}

export function migrateLegacyWorkflowSnapshot(legacy = {}, options = {}) {
  return sanitizeWorkflowSnapshot(
    {
      version: WORKFLOW_SNAPSHOT_VERSION,
      savedAt: getNow(options),
      rows: parseStoredValue(getLegacyValue(legacy, "rows"), []),
      accountLedger: parseStoredValue(getLegacyValue(legacy, "accountAttemptLedger"), {}),
      accountCooldowns: parseStoredValue(getLegacyValue(legacy, "accountCooldowns"), {}),
      autoCycleState: parseStoredValue(getLegacyValue(legacy, "autoCycleState"), {}),
      failedAccounts: parseStoredValue(getLegacyValue(legacy, "failedAccounts"), []),
      plusExports: parseStoredValue(getLegacyValue(legacy, "plusExports"), {}),
      downloadedExportCounts: parseStoredValue(getLegacyValue(legacy, "downloadedExportCounts"), {}),
      ui: parseStoredValue(getLegacyValue(legacy, "uiSettings"), {})
    },
    options
  );
}
