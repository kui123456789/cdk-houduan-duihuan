import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ClipboardCopy,
  Download,
  FileSearch,
  Loader2,
  Play,
  Shield,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import {
  CDK_POOLS,
  DELIMITER,
  STATUS_META,
  appendImportedText,
  buildQueryRows,
  canCancelRow,
  canRetryFailedRow,
  canRetryRow,
  countStatuses,
  createRedeemRow,
  getPlusExportLine,
  getSubscriptionLabel,
  getSuccessExportsByPool,
  isTerminalStatus,
  normalizeAccountText,
  normalizeStatusItem,
  parseCdkeyPools,
  statusLabel
} from "./redeemLogic";
import {
  buildPreflightSummary,
  classifyCdkeyPreflight as classifyCdkeyPreflightState,
  getBlockingCdkeyReasons
} from "./state/cdkPreflight";
import {
  chooseSubmitPoolDecision,
  restrictCdkeyPoolsToPool
} from "./state/cdkPoolSelection";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_ATTEMPT_WINDOW_MS,
  ACCOUNT_COOLDOWN_MS,
  ATTEMPT_FAILURE_STATUSES,
  DAILY_LIMIT_DISPLAY_REASON,
  DAILY_LIMIT_REDEEM_STATUSES,
  EMPTY_PREFLIGHT_SUMMARY,
  LOCAL_ATTEMPT_LIMIT_REASON,
  RESUBMIT_REDEEM_STATUSES,
  STORAGE_KEYS
} from "./config/redeemConstants";
import {
  readStored,
  readStoredJson,
  removeStoredValue,
  writeStored
} from "./storage/redeemStorage";
import {
  loadWorkflowSnapshot,
  saveWorkflowSnapshot
} from "./storage/workflowPersistence";
import {
  computeCdkUsageStats,
  computeRequestStatusCounts,
  getLatestRowsByCdkey
} from "./state/redeemSelectors";
import {
  compactStatus,
  formatAccountStatusLine,
  formatAttemptNumber,
  formatBackendRedeemLine,
  formatCdkUsageLine,
  formatFailureReason,
  getRowRedeemProgress,
  getSubscriptionTone
} from "./state/rowPresentation";
import {
  applyCooldownMarkersToRows,
  formatCooldownUntil,
  formatRowCooldownReason,
  getAccountCooldown,
  getCooledEmailSet,
  isAccountDailyLimitReason,
  isLimitCooldownReason,
  isRowAccountCooling,
  normalizeAccountCooldowns
} from "./state/accountLifecycle";
import {
  batchCount,
  buildNoSubmitMessage,
  buildPooledSubmitRows,
  canResubmitRedeemRow,
  describeSelectedRow,
  getAccountAttemptInfo,
  getAutoCycleQueueKey,
  getBlockedSubmitEmails,
  getCurrentTaskRows,
  getResubmitBlockReason,
  getRowCdkeys,
  getSubmitAccountAvailability,
  isAccountAttemptLimitReached,
  isAccountTaskRow,
  isActiveBackendTaskRow,
  isContinuationBlockingRow,
  isHistoricalAutoCycleRow,
  isRowAccountAttemptExhausted,
  isStaleSubmitPlanningError,
  mergeAccountsIntoAutoCycleQueue,
  markRowsUsedInAutoCycle,
  normalizeAccountAttemptLedger,
  normalizeAutoCycleState,
  normalizeAccessToken,
  normalizeEmail,
  normalizeFailedAccount,
  normalizeStringArray,
  sanitizeLegacyAccountAttemptRows
} from "./state/redeemWorkflow";
import { createRedeemApi } from "./services/redeemApi";
import { WorkspacePanel, WorkspaceTabs } from "./components/common/WorkspaceTabs";
import { CdkPoolPickerDialog } from "./components/execute/CdkPoolPickerDialog";
import { ExecutionControlPanel } from "./components/execute/ExecutionControlPanel";
import { PrepWorkspace } from "./components/prep/PrepWorkspace";
import { ResultWorkspace } from "./components/export/ResultWorkspace";
import { RequestStatusPanel } from "./components/request/RequestStatusPanel";
import { ActivityLog } from "./components/common/ActivityLog";
import { useAccountInput } from "./hooks/useAccountInput";
import { useSubscriptionChecks } from "./hooks/useSubscriptionChecks";
import { useRedeemPolling } from "./hooks/useRedeemPolling";
import { useAutoCycle } from "./hooks/useAutoCycle";
import { useRedeemSubmit } from "./hooks/useRedeemSubmit";
import { useRedeemUiSettings, normalizeUiSettings } from "./hooks/useRedeemUiSettings";
import { buildRedeemViewModel } from "./hooks/useRedeemViewModel";
import {
  appendActivityLog,
  compactActivityLog
} from "./workflow/activityLog";
import { clearAccountLifecycleBlocks } from "./workflow/accountLedger";

function createEmptyCdkPools() {
  return Object.fromEntries(CDK_POOLS.map((pool) => [pool.id, ""]));
}

function countLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

function loadStored(key) {
  return readStored(window.localStorage, key);
}

function saveStored(key, value) {
  writeStored(window.localStorage, key, value);
}

function removeStored(key) {
  removeStoredValue(window.localStorage, key);
}

function loadStoredJson(key, fallback) {
  return readStoredJson(window.localStorage, key, fallback);
}

function loadStoredCdkeyPools() {
  try {
    const parsed = loadStoredJson(STORAGE_KEYS.cdkeyPools, {});
    return {
      ...createEmptyCdkPools(),
      ...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {})
    };
  } catch {
    return createEmptyCdkPools();
  }
}

function loadStoredRows() {
  const rows = loadStoredJson(STORAGE_KEYS.rows, []);
  if (!Array.isArray(rows)) return [];
  const now = Date.now();
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      ...row,
      selected: false,
      retryRequestedAt: Number(row.retryRequestedAt || 0),
      retryHoldUntil: Number(row.retryHoldUntil || 0),
      staleStatusGuard: row.staleStatusGuard === true,
      staleStatusGuardStartedAt: Number(row.staleStatusGuardStartedAt || 0),
      accountCooldownUntil: Number(row.accountCooldownUntil || 0),
      accountCooldownReason: String(row.accountCooldownReason || ""),
      originalCdkey: row.originalCdkey || row.cdkey || "",
      attemptRound: 1,
      attemptNumber: Math.max(Number(row.attemptNumber || 1), 1),
      accountAttemptNumber: normalizeStoredAccountAttemptNumber(row, now),
      parentRowId: String(row.parentRowId || ""),
      autoCycle: row.autoCycle === true,
      autoCycleSourceEmail: String(row.autoCycleSourceEmail || ""),
      autoCycleHandled: row.autoCycleHandled === true,
      autoCycleNextRowId: String(row.autoCycleNextRowId || ""),
      statusLocked: row.statusLocked === true,
      statusOwner: row.statusOwner === true
    }));
}

function normalizeStoredAccountAttemptNumber(row, now = Date.now()) {
  const rawAttempt = Number(row?.accountAttemptNumber || 0);
  const cooldownReason = String(row?.accountCooldownReason || row?.reason || "").trim();
  const hasActiveLimitCooldown =
    Number(row?.accountCooldownUntil || 0) > now && isLimitCooldownReason(cooldownReason);

  if (hasActiveLimitCooldown) return ACCOUNT_ATTEMPT_LIMIT;
  if (rawAttempt >= 1) {
    return Math.min(Math.max(rawAttempt, 1), ACCOUNT_ATTEMPT_LIMIT);
  }
  return 1;
}

function loadStoredErrors() {
  const errors = loadStoredJson(STORAGE_KEYS.errors, []);
  return Array.isArray(errors) ? errors : [];
}

function normalizeExportLines(value) {
  const lines = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  return [...new Set(lines.map((line) => String(line || "").trim()).filter(Boolean))];
}

function normalizePlusExports(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    upi: normalizeExportLines(source.upi),
    ideal: normalizeExportLines(source.ideal)
  };
}

function loadStoredPlusExports() {
  return normalizePlusExports(loadStoredJson(STORAGE_KEYS.plusExports, {}));
}

function normalizeDownloadedExportCounts(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    upi: Math.max(Number(source.upi || 0), 0),
    ideal: Math.max(Number(source.ideal || 0), 0)
  };
}

function loadStoredDownloadedExportCounts() {
  return normalizeDownloadedExportCounts(loadStoredJson(STORAGE_KEYS.downloadedExportCounts, {}));
}

function loadStoredAutoCycleState() {
  return normalizeAutoCycleState(loadStoredJson(STORAGE_KEYS.autoCycleState, {}));
}

function normalizeStoredFailedAccounts(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const items = [];
  source.forEach((item) => {
    const normalized = normalizeFailedAccount(item);
    if (!normalized || seen.has(normalized.email)) return;
    seen.add(normalized.email);
    items.push(normalized);
  });
  return items;
}

function loadStoredFailedAccounts() {
  return normalizeStoredFailedAccounts(loadStoredJson(STORAGE_KEYS.failedAccounts, []));
}

function loadStoredAccountCooldowns() {
  return normalizeAccountCooldowns(loadStoredJson(STORAGE_KEYS.accountCooldowns, {}));
}

function loadStoredAccountAttemptLedger() {
  return normalizeAccountAttemptLedger(loadStoredJson(STORAGE_KEYS.accountAttemptLedger, {}));
}

function loadStoredUiSettings() {
  const settings = loadStoredJson(STORAGE_KEYS.uiSettings, {});
  return normalizeUiSettings(settings);
}

function saveUiSettings(nextSettings) {
  const currentSettings = loadStoredUiSettings();
  saveStored(
    STORAGE_KEYS.uiSettings,
    JSON.stringify({
      ...currentSettings,
      ...nextSettings
    })
  );
}

function canRetryVisibleRow(row) {
  return canRetryRow(row) && !isRowAccountCooling(row) && !isRowAccountAttemptExhausted(row);
}

function canRetryVisibleFailedRow(row) {
  return canRetryFailedRow(row) && !isRowAccountCooling(row) && !isRowAccountAttemptExhausted(row);
}

function isDailyLimitFailureRow(row) {
  return (
    DAILY_LIMIT_REDEEM_STATUSES.has(String(row?.status || "")) &&
    isAccountDailyLimitReason(getRowReasonText(row))
  );
}

function isCooldownReleaseCandidate(row) {
  const status = String(row?.status || "");
  return (
    Boolean(row?.email && row?.cdkey) &&
    RESUBMIT_REDEEM_STATUSES.has(status) &&
    (isRowAccountCooling(row) || isLocalAttemptLimitFailureRow(row))
  );
}

function isAttemptExhaustedReleaseCandidate(row) {
  return (
    Boolean(row?.email && row?.cdkey) &&
    isRowAccountAttemptExhausted(row) &&
    canRetryFailedRow(row)
  );
}

function isLocalAttemptLimitFailureRow(row) {
  return (
    Boolean(row?.email) &&
    ATTEMPT_FAILURE_STATUSES.has(String(row?.status || "")) &&
    isRowAccountAttemptExhausted(row)
  );
}

function isCancelledResubmitRow(row) {
  return String(row?.status || "") === "cancelled" && canResubmitRedeemRow(row);
}

function getAccountEmailsFromText(text) {
  return new Set(
    String(text || "")
      .split(/\r?\n/)
      .map((line) => getAccountEmailFromLine(line))
      .filter(Boolean)
  );
}

function findActiveAccountRowsMissingFromText(text, sourceRows) {
  const nextEmails = getAccountEmailsFromText(text);
  return sourceRows.filter(
    (row) =>
      isActiveBackendTaskRow(row) &&
      row.email &&
      !nextEmails.has(String(row.email || "").trim().toLowerCase())
  );
}

function getBackendResponseNotice(payload, emptyDetailText) {
  const backend = payload?.backend;
  if (!backend || typeof backend !== "object") return "";
  if (backend.emptyResponse) return "后端响应为空，已继续处理";
  if (Number(backend.itemCount || 0) === 0) return emptyDetailText;
  return "";
}

function withBackendNotice(message, payload, emptyDetailText) {
  const notice = getBackendResponseNotice(payload, emptyDetailText);
  return notice ? `${message}；${notice}` : message;
}

function isPlusAccountRow(row) {
  return row?.status === "success" && row?.isPlus === true && Boolean(row?.email);
}

function getAccountEmailFromLine(line) {
  return String(line || "").split(DELIMITER)[0]?.trim().toLowerCase() || "";
}

function removeAccountLinesByEmail(text, emailsToRemove) {
  if (!emailsToRemove.size) return text;
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return !emailsToRemove.has(getAccountEmailFromLine(trimmed));
    })
    .join("\n");
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

function getDailyLimitArchiveReason(row) {
  return getDailyLimitDisplayReason(row, "");
}

const APP_ROW_PRESENTATION_DEPS = {
  canRetryVisibleRow,
  canCancelRow,
  isHistoricalAutoCycleRow,
  isRowAccountCooling,
  formatRowCooldownReason,
  isAccountDailyLimitReason,
  formatDailyLimitDisplayReason: getDailyLimitDisplayReason
};

function formatFailureReasonForApp(row) {
  return formatFailureReason(row, APP_ROW_PRESENTATION_DEPS);
}

function getRowRedeemProgressForApp(row) {
  return getRowRedeemProgress(row, APP_ROW_PRESENTATION_DEPS);
}

function formatCdkUsageLineForApp(row) {
  return formatCdkUsageLine(row, APP_ROW_PRESENTATION_DEPS);
}

function formatBackendRedeemLineForApp(row) {
  return formatBackendRedeemLine(row, APP_ROW_PRESENTATION_DEPS);
}

function formatAccountStatusLineForApp(row) {
  return formatAccountStatusLine(row, APP_ROW_PRESENTATION_DEPS);
}

function maskEmail(email) {
  const text = String(email || "").trim();
  if (!text || !text.includes("@")) return text || "-";
  const [name, domain] = text.split("@");
  const safeName = name.length <= 2 ? `${name[0] || ""}***` : `${name.slice(0, 2)}***`;
  const domainParts = domain.split(".");
  const domainHead = domainParts[0] || "";
  const safeDomain = `${domainHead.slice(0, 1) || "*"}***${domainParts.length > 1 ? `.${domainParts.slice(1).join(".")}` : ""}`;
  return `${safeName}@${safeDomain}`;
}

function maskCdkey(cdkey) {
  const text = String(cdkey || "").trim();
  if (!text) return "-";
  if (text.length <= 10) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function buildAutoCycleNotice(autoCycleAddedCount, dailyLimitHandledCount, hasDailyLimitWaitingAccount) {
  if (autoCycleAddedCount) {
    return dailyLimitHandledCount
      ? `，已封存 ${dailyLimitHandledCount} 个账号 24 小时并自动换号 ${autoCycleAddedCount} 条`
      : `，已自动换号 ${autoCycleAddedCount} 条`;
  }
  return hasDailyLimitWaitingAccount ? "，自动换号没有可用账号，请补充账号" : "";
}

function removeCdkeyLinesByValue(pools, cdkeysToRemove) {
  if (!cdkeysToRemove.size) return pools;
  return Object.fromEntries(
    Object.entries(pools || {}).map(([poolId, text]) => [
      poolId,
      String(text || "")
        .split(/\r?\n/)
        .filter((line) => {
          const cdkey = line.trim();
          return cdkey && !cdkeysToRemove.has(cdkey);
        })
        .join("\n")
    ])
  );
}

function trimConsumedCdkeysFromPools(pools, consumedCount) {
  let remainingToSkip = Math.max(Number(consumedCount || 0), 0);
  if (!remainingToSkip) return pools;

  const nextPools = { ...(pools || {}) };
  CDK_POOLS.forEach((pool) => {
    const lines = String(nextPools[pool.id] || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!remainingToSkip) {
      nextPools[pool.id] = lines.join("\n");
      return;
    }

    const skipCount = Math.min(remainingToSkip, lines.length);
    remainingToSkip -= skipCount;
    nextPools[pool.id] = lines.slice(skipCount).join("\n");
  });

  return nextPools;
}

function mergeMissingQueryRows(baseRows, queryRows) {
  const seenCdkeys = new Set(
    baseRows.map((row) => String(row?.cdkey || "").trim()).filter(Boolean)
  );
  const nextRows = [...baseRows];

  queryRows.forEach((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey || seenCdkeys.has(cdkey)) return;
    seenCdkeys.add(cdkey);
    nextRows.push({
      ...row,
      id: `query-extra-${nextRows.length}-${row.cdkeyLineNumber || nextRows.length + 1}`,
      displayIndex: nextRows.length + 1
    });
  });

  return nextRows;
}

function getPlusExportBucket(row) {
  const channel = String(row?.channel || "").trim().toLowerCase();
  if (channel === "upi") return "upi";
  if (channel === "ideal" || channel === "vip") return "ideal";
  return "";
}

function isPlusRowInExportBucket(row, bucket) {
  return isPlusAccountRow(row) && getPlusExportBucket(row) === bucket;
}

function mergePlusExportRows(currentExports, rowsToArchive) {
  const nextExports = normalizePlusExports(currentExports);
  rowsToArchive.forEach((row) => {
    const bucket = getPlusExportBucket(row);
    const line = getPlusExportLine(row);
    if (!bucket || !line || nextExports[bucket].includes(line)) return;
    nextExports[bucket].push(line);
  });
  return nextExports;
}

function mergeExportGroups(archived, live) {
  return normalizeExportLines([...(archived || []), ...(live || [])]).join("\n");
}

function formatFailedAccountLine(account) {
  const normalized = normalizeFailedAccount(account);
  if (!normalized) return "";
  return normalized.source || [
    normalized.email,
    normalized.password,
    normalized.twofa,
    normalized.accessToken,
    normalized.timestamp
  ].join(DELIMITER);
}

async function readTextFile(file) {
  return await file.text();
}

export default function App() {
  const [initialWorkflowSnapshot] = useState(() => loadWorkflowSnapshot(window.localStorage));
  const [initialUiSettings] = useState(
    () => initialWorkflowSnapshot?.ui || loadStoredUiSettings()
  );
  const [accountText, setAccountTextState] = useState(() => loadStored(STORAGE_KEYS.accountText));
  const [cdkeyPools, setCdkeyPools] = useState(() => loadStoredCdkeyPools());
  const [apiKey, setApiKey] = useState(() => loadStored(STORAGE_KEYS.apiKey));
  const {
    activeWorkspaceTab,
    selectWorkspaceTab,
    activeDetailRowId,
    setActiveDetailRowId,
    showApiKey,
    setShowApiKey,
    toggleApiKeyVisible
  } = useRedeemUiSettings(initialUiSettings, { saveUiSettings });
  const [rows, setRows] = useState(() => initialWorkflowSnapshot?.rows || loadStoredRows());
  const [plusExports, setPlusExports] = useState(
    () => initialWorkflowSnapshot?.plusExports || loadStoredPlusExports()
  );
  const [downloadedExportCounts, setDownloadedExportCounts] = useState(
    () => initialWorkflowSnapshot?.downloadedExportCounts || loadStoredDownloadedExportCounts()
  );
  const [autoCycleState, setAutoCycleState] = useState(
    () => initialWorkflowSnapshot?.autoCycleState || loadStoredAutoCycleState()
  );
  const [failedAccounts, setFailedAccounts] = useState(
    () => initialWorkflowSnapshot?.failedAccounts || loadStoredFailedAccounts()
  );
  const [accountCooldowns, setAccountCooldowns] = useState(
    () => initialWorkflowSnapshot?.accountCooldowns || loadStoredAccountCooldowns()
  );
  const [accountAttemptLedger, setAccountAttemptLedger] = useState(() =>
    initialWorkflowSnapshot?.accountLedger || loadStoredAccountAttemptLedger()
  );
  const [errors, setErrors] = useState(() => loadStoredErrors());
  const [accountNotice, setAccountNotice] = useState(() => loadStored(STORAGE_KEYS.accountNotice));
  const [isBusy, setIsBusy] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [statusMessage, setStatusMessageState] = useState(
    () => loadStored(STORAGE_KEYS.statusMessage) || "等待输入账号和 CDK"
  );
  const [activityLog, setActivityLog] = useState(() =>
    compactActivityLog(initialWorkflowSnapshot?.activityLog)
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => loadStored(STORAGE_KEYS.lastUpdatedAt));
  const apiKeyRef = useRef(apiKey);
  const redeemApiRef = useRef(null);
  const pollingControllerRef = useRef(null);
  const queryStatusesRef = useRef(null);
	  const pollingInFlightRef = useRef(false);
	  const latestAcceptedPollingSeqRef = useRef(0);
	  const pollingSessionRef = useRef(0);
	  const isPollingRef = useRef(false);
  const autoCycleScheduleTimerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const subscriptionCacheRef = useRef(new Map());
  const accountTextRef = useRef(accountText);
  const redeemAccountsRef = useRef([]);
  const statusMessageRef = useRef(statusMessage);
  const rowsRef = useRef(rows);
  const autoCycleRef = useRef(autoCycleState);
  const failedAccountsRef = useRef(failedAccounts);
  const accountCooldownsRef = useRef(accountCooldowns);
  const accountAttemptLedgerRef = useRef(accountAttemptLedger);
  const deletedRowIdsRef = useRef(new Set());
  const autoCycleProcessingRef = useRef(false);
  const autoCycleHandlersRef = useRef({});
  const lastSubmitPoolRef = useRef("");
  const pendingPoolContinuationRef = useRef(null);
  const attemptedSubmitPoolIdsRef = useRef(new Set());
  const attemptedSubmitAccessTokensRef = useRef(new Set());
  const [toastMessage, setToastMessage] = useState("");
  const [toastTone, setToastTone] = useState("success");
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [pendingDeleteRows, setPendingDeleteRows] = useState([]);
  const [pendingAccountTextChange, setPendingAccountTextChange] = useState(null);
  const [showCdkImportDialog, setShowCdkImportDialog] = useState(false);
  const [importPoolId, setImportPoolId] = useState(CDK_POOLS[0]?.id || "vip");
  const [importCdkText, setImportCdkText] = useState("");
  const [preflightSummary, setPreflightSummary] = useState(EMPTY_PREFLIGHT_SUMMARY);
  const [poolPickerState, setPoolPickerState] = useState({
    open: false,
    mode: "start",
    choices: []
  });
  const [poolContinuationVersion, setPoolContinuationVersion] = useState(0);

  function setAccountText(nextTextOrUpdater) {
    const nextText =
      typeof nextTextOrUpdater === "function"
        ? nextTextOrUpdater(accountTextRef.current)
        : nextTextOrUpdater;
    accountTextRef.current = nextText;
    setAccountTextState(nextText);
  }

  function setStatusMessage(nextMessageOrUpdater, options = {}) {
    const previousMessage = statusMessageRef.current;
    const nextMessage =
      typeof nextMessageOrUpdater === "function"
        ? nextMessageOrUpdater(previousMessage)
        : nextMessageOrUpdater;
    const normalizedMessage = String(nextMessage || "");
    const previousText = String(previousMessage || "").trim();
    const nextText = normalizedMessage.trim();

    statusMessageRef.current = normalizedMessage;
    setStatusMessageState(normalizedMessage);

    if (options.log !== false && nextText && nextText !== previousText) {
      setActivityLog((prev) =>
        appendActivityLog(prev, {
          level: "info",
          action: "status",
          message: nextText
        })
      );
    }
  }

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    accountTextRef.current = accountText;
  }, [accountText]);

  useEffect(() => {
    setRows((prev) => {
      const sanitized = sanitizeLegacyAccountAttemptRows(prev, accountAttemptLedgerRef.current);
      if (sanitized === prev) return prev;
      rowsRef.current = sanitized;
      return sanitized;
    });
  }, []);

  useEffect(() => {
    autoCycleRef.current = autoCycleState;
  }, [autoCycleState]);

  useEffect(() => {
    failedAccountsRef.current = failedAccounts;
  }, [failedAccounts]);

  useEffect(() => {
    accountCooldownsRef.current = accountCooldowns;
  }, [accountCooldowns]);

  useEffect(() => {
    accountAttemptLedgerRef.current = accountAttemptLedger;
  }, [accountAttemptLedger]);

  useEffect(() => {
    const storedCdkeys = getRowCdkeys(rowsRef.current);
    if (apiKey.trim() && storedCdkeys.length) {
      queryStatuses(storedCdkeys, {
        silent: true,
        forceRemote: true,
        skipAutoCycle: true,
        baseRows: rowsRef.current
      });
    }

    if (initialUiSettings.pollingEnabled) {
      if (!apiKey.trim()) {
        saveUiSettings({ pollingEnabled: false });
        return () => stopPolling({ persist: false });
      }

      const pollingCdkeys = getRowCdkeys(rowsRef.current);
      if (pollingCdkeys.length) {
        startPolling(pollingCdkeys, {
          forceRemote: true,
          keepPollingWhenTerminal: true
        });
        setStatusMessage(`已恢复状态轮询：每 5 秒同步 ${pollingCdkeys.length} 个 CDK 和账号状态`);
      } else {
        saveUiSettings({ pollingEnabled: false });
      }
    }

    return () => {
      stopPolling({ persist: false });
      clearAutoCycleScheduleTimer();
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    saveStored(STORAGE_KEYS.accountText, accountText);
  }, [accountText]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.cdkeyPools, JSON.stringify(cdkeyPools));
  }, [cdkeyPools]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.rows, JSON.stringify(rows));
  }, [rows]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.plusExports, JSON.stringify(plusExports));
  }, [plusExports]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.downloadedExportCounts, JSON.stringify(downloadedExportCounts));
  }, [downloadedExportCounts]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.autoCycleState, JSON.stringify(autoCycleState));
  }, [autoCycleState]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.failedAccounts, JSON.stringify(failedAccounts));
  }, [failedAccounts]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.accountCooldowns, JSON.stringify(accountCooldowns));
  }, [accountCooldowns]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.accountAttemptLedger, JSON.stringify(accountAttemptLedger));
  }, [accountAttemptLedger]);

  useEffect(() => {
    saveWorkflowSnapshot(
      window.localStorage,
      {
        rows,
        accountLedger: accountAttemptLedger,
        accountCooldowns,
        autoCycleState,
	        failedAccounts,
	        plusExports,
	        downloadedExportCounts,
	        activityLog,
	        ui: {
          activeWorkspaceTab,
          activeDetailRowId,
          showApiKey,
          pollingEnabled: isPollingRef.current
        }
      },
      { persistSensitive: true }
    );
  }, [
	    accountAttemptLedger,
	    accountCooldowns,
	    activityLog,
	    activeDetailRowId,
    activeWorkspaceTab,
    autoCycleState,
    downloadedExportCounts,
    failedAccounts,
    isPolling,
    plusExports,
    rows,
    showApiKey
  ]);

  useEffect(() => {
    syncAttemptCooldowns(accountAttemptLedger, { silent: true });
  }, [accountAttemptLedger]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.errors, JSON.stringify(errors));
  }, [errors]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.accountNotice, accountNotice);
  }, [accountNotice]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.statusMessage, statusMessage);
  }, [statusMessage]);

  useEffect(() => {
    saveStored(STORAGE_KEYS.lastUpdatedAt, lastUpdatedAt);
  }, [lastUpdatedAt]);

  const currentTaskRows = useMemo(() => getCurrentTaskRows(rows), [rows]);
  const statusCounts = useMemo(() => countStatuses(currentTaskRows), [currentTaskRows]);
  const groupedStatusCounts = useMemo(() => computeRequestStatusCounts(statusCounts), [statusCounts]);
  const resubmittableCount = currentTaskRows.filter(canResubmitRedeemRow).length;
  const cooldownTaskCount = currentTaskRows.filter((row) => isRowAccountCooling(row)).length;
  const successExports = useMemo(() => {
    const grouped = getSuccessExportsByPool(rows);
    return {
      upi: mergeExportGroups(plusExports.upi, grouped.upi),
      ideal: mergeExportGroups(plusExports.ideal, grouped.ideal)
    };
  }, [plusExports, rows]);
  const visibleRequestRows = useMemo(() => rows.filter((row) => !isHistoricalAutoCycleRow(row)), [rows]);
  const hiddenHistoryRowCount = rows.length - visibleRequestRows.length;
  const selectedRows = useMemo(
    () => visibleRequestRows.filter((row) => row.selected),
    [visibleRequestRows]
  );
  const {
    checkPlusSubscriptions,
    recheckPlusRows,
    canRecheckSubscriptionRow
  } = useSubscriptionChecks({
    redeemApiRef,
    subscriptionCacheRef,
    rowsRef,
    setRows,
    setStatusMessage,
    showToast,
    setIsBusy,
    getRedeemApi,
    filterDeletedRows,
    getRows: () => rowsRef.current,
    getSelectedRows: () => selectedRows,
    isHistoricalRow: isHistoricalAutoCycleRow
  });
  const { queryStatuses, startPolling, stopPolling } = useRedeemPolling({
    callProxy,
    rowsRef,
    isPollingRef,
    pollingControllerRef,
    pollingInFlightRef,
    latestAcceptedPollingSeqRef,
    pollingSessionRef,
    queryStatusesRef,
    setRows,
    setIsBusy,
    setIsPolling,
    setStatusMessage,
    setLastUpdatedAt,
    saveUiSettings,
    withBackendNotice,
    registerCooldownsFromRows,
    filterDeletedRows,
    checkPlusSubscriptions,
    scheduleAutoCycleFailures
  });
  queryStatusesRef.current = queryStatuses;
  const failedRetryRows = useMemo(() => currentTaskRows.filter(canRetryVisibleFailedRow), [currentTaskRows]);
  const plusAccountRows = useMemo(() => rows.filter(isPlusAccountRow), [rows]);
  const selectedRecheckPlusRows = useMemo(
    () => selectedRows.filter(canRecheckSubscriptionRow),
    [selectedRows]
  );
  const plusAccountRowKey = useMemo(
    () => plusAccountRows.map((row) => row.id).join("|"),
    [plusAccountRows]
  );
  const canCopyUpiSuccess = successExports.upi.length > 0;
  const canCopyIdealSuccess = successExports.ideal.length > 0;
  const accountValidation = useMemo(() => normalizeAccountText(accountText), [accountText]);
  const activeAccountCooldowns = useMemo(
    () => normalizeAccountCooldowns(accountCooldowns),
    [accountCooldowns]
  );
  const cooledEmailSet = useMemo(
    () => getCooledEmailSet(activeAccountCooldowns),
    [activeAccountCooldowns]
  );
  const cooledEmailKey = useMemo(() => [...cooledEmailSet].sort().join("|"), [cooledEmailSet]);
  const redeemAccountText = useMemo(
    () => removeAccountLinesByEmail(accountText, cooledEmailSet),
    [accountText, cooledEmailKey]
  );
  const redeemAccountValidation = useMemo(
    () => normalizeAccountText(redeemAccountText),
    [redeemAccountText]
  );
  redeemAccountsRef.current = redeemAccountValidation.accounts;
  const accountAvailability = useMemo(
    () =>
      getSubmitAccountAvailability({
        accounts: accountValidation.accounts,
        rowList: rows,
        cycleState: autoCycleState,
        cooldowns: accountCooldowns,
        attemptLedger: accountAttemptLedger,
        failedAccounts
      }),
    [accountAttemptLedger, accountCooldowns, accountValidation.accounts, autoCycleState, failedAccounts, rows]
  );
  const cdkeyValidation = useMemo(() => parseCdkeyPools(cdkeyPools), [cdkeyPools]);
  const validCdkCount = cdkeyValidation.cdkeys.length;
  const archivedSuccessCount = useMemo(
    () => normalizeExportLines(plusExports.upi).length + normalizeExportLines(plusExports.ideal).length,
    [plusExports]
  );
  const downloadedSuccessCount =
    Number(downloadedExportCounts.upi || 0) + Number(downloadedExportCounts.ideal || 0);
  const taskCdkeyCount = useMemo(
    () =>
      new Set(
        rows
          .filter((row) => isAccountTaskRow(row) && row.cdkey)
          .map((row) => String(row.cdkey || "").trim())
      ).size,
    [rows]
  );
  const submitCdkeyPools = cdkeyPools;
  const submitCdkeyValidation = useMemo(() => parseCdkeyPools(cdkeyPools), [cdkeyPools]);
  function getSubmitCdkeyValidation(poolId) {
    const restrictedPools = poolId ? restrictCdkeyPoolsToPool(cdkeyPools, poolId) : cdkeyPools;
    return parseCdkeyPools(restrictedPools);
  }
  const availableCdkCount = submitCdkeyValidation.cdkeys.length;
  const cdkUsageStats = useMemo(
    () => computeCdkUsageStats(cdkeyValidation.cdkeys, rows, formatCdkUsageLineForApp),
    [cdkeyValidation.cdkeys, rows]
  );
  const backendRedeemText = useMemo(
    () => rows.map(formatBackendRedeemLineForApp).join("\n"),
    [rows]
  );
  const accountStatusText = useMemo(
    () => getLatestRowsByCdkey(rows).filter(isAccountTaskRow).map(formatAccountStatusLineForApp).join("\n"),
    [rows]
  );
  const rawAccountLineCount = useMemo(() => countLines(accountText), [accountText]);
  const accountLineCount = accountValidation.accountCount;
  const accountAvailabilityCounts = accountAvailability.counts;
  const activeAccountLineCount = accountAvailabilityCounts.available;
  const cooldownAccountCount = accountAvailabilityCounts.cooling;
  const attemptLimitedAccountCount = accountAvailabilityCounts.attemptLimited;
  const restorableCooldownAccountCount = useMemo(
    () =>
      getRestorableCooldownEmails({
        accounts: accountValidation.accounts,
        cooldowns: activeAccountCooldowns,
        ledger: accountAttemptLedger,
        rows
      }).size,
    [accountAttemptLedger, accountValidation.accounts, activeAccountCooldowns, rows]
  );
  const activeTaskAccountCount = accountAvailabilityCounts.activeTask;
  const completedAccountCount = accountAvailabilityCounts.completed;
  const processedPlusAccountCount = archivedSuccessCount + downloadedSuccessCount;
  const estimatedImportedAccountCount = accountLineCount + processedPlusAccountCount;
  const accountInputStatusText = accountLineCount
    ? `账号池 ${accountLineCount} 个；可兑换 ${activeAccountLineCount} 个` +
      (cooldownAccountCount ? `；冷却中 ${cooldownAccountCount} 个` : "") +
      (attemptLimitedAccountCount ? `；已达 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次 ${attemptLimitedAccountCount} 个` : "") +
      (activeTaskAccountCount ? `；兑换中/待处理 ${activeTaskAccountCount} 个` : "") +
      (processedPlusAccountCount
        ? `；已处理 Plus ${processedPlusAccountCount} 个，估算原导入 ${estimatedImportedAccountCount} 个`
        : "") +
      (rawAccountLineCount > accountLineCount ? `；${rawAccountLineCount - accountLineCount} 行需检查` : "")
    : processedPlusAccountCount
      ? `账号输入已清空；已处理 Plus ${processedPlusAccountCount} 个`
      : "等待账号输入";
  const redeemablePairCount = Math.min(activeAccountLineCount, availableCdkCount);
  const missingCdkeyAccountCount = Math.max(activeAccountLineCount - availableCdkCount, 0);
  const extraCdkeyCount = Math.max(availableCdkCount - activeAccountLineCount, 0);
  const hasPreflightSummary = preflightSummary.checked > 0;
  const preflightAttentionCount =
    preflightSummary.used + preflightSummary.busy + preflightSummary.unknown;
  const displayedAvailableCdkCount = hasPreflightSummary
    ? preflightSummary.available
    : availableCdkCount;
  const displayedRedeemablePairCount = hasPreflightSummary
    ? preflightSummary.submitted
    : redeemablePairCount;
  const displayedWaitingAccounts = hasPreflightSummary
    ? preflightSummary.waitingAccounts
    : missingCdkeyAccountCount;
  const displayedWaitingCdkeys = hasPreflightSummary
    ? preflightSummary.waitingCdkeys
    : extraCdkeyCount;
  const accountInputIssueCount = accountValidation.errors.length;
  const taskIssueCount = Number(statusCounts.skipped || 0);
  const accountQueueKey = useMemo(
    () => getAutoCycleQueueKey(redeemAccountValidation.accounts),
    [redeemAccountValidation.accounts]
  );
  const autoCycleBlockedEmails = useMemo(
    () => getBlockedSubmitEmails(rows, autoCycleState, accountCooldowns, accountAttemptLedger, failedAccounts),
    [accountAttemptLedger, accountCooldowns, autoCycleState, failedAccounts, rows]
  );
  const autoCycleQueueRemaining = useMemo(() => {
    if (!autoCycleState.enabled) return 0;
    return autoCycleState.queue.filter(
      (account) => account?.email && !autoCycleBlockedEmails.has(account.email)
    ).length;
  }, [autoCycleBlockedEmails, autoCycleState]);
  const autoCycleHandlers = useAutoCycle({
    rowsRef,
    autoCycleRef,
    autoCycleScheduleTimerRef,
    autoCycleProcessingRef,
    setRows,
    setStatusMessage,
    setLastUpdatedAt,
    callProxy,
    registerCooldownsFromRows,
    startPolling,
    getRedeemAccounts: () => redeemAccountsRef.current,
    mergeAccountsIntoAutoCycleState,
    commitAutoCycleState,
    getNextAutoCycleAccount,
    createAutoCycleRow,
    forgetDeletedRows,
    recordAccountSubmissionAttempts,
    getResolvedAttemptNumber,
    getPollableCdkeys,
    canRetryVisibleFailedRow,
    isDailyLimitFailureRow,
    isCooldownReleaseCandidate,
    isAttemptExhaustedReleaseCandidate,
    isLocalAttemptLimitFailureRow,
    getDailyLimitDisplayReason,
    formatFailureReason: formatFailureReasonForApp,
    maskEmail,
    maskCdkey
  });
  autoCycleHandlersRef.current = autoCycleHandlers;
  const {
    retryFailedRows,
    retryOrResubmitRows,
    runJobAction,
    submitRedeems
  } = useRedeemSubmit({
    rowsRef,
    accountValidation,
    submitCdkeyValidation,
    getSubmitCdkeyValidation,
    autoCycleRef,
    accountCooldownsRef,
    accountAttemptLedgerRef,
    failedAccountsRef,
    failedRetryRows,
    setRows,
    setErrors,
    setIsBusy,
    setStatusMessage,
    setPreflightSummary,
    setLastUpdatedAt,
    showToast,
    selectWorkspaceTab,
    stopPolling,
    startPolling,
    queryStatuses,
    callProxy,
    getRowCdkeys,
    getPollableCdkeys,
    getBackendResponseNotice,
    preflightCdkeysForSubmit,
    getSubmitAccountAvailability,
    buildPooledSubmitRows,
    buildNoSubmitMessage,
    isHistoricalAutoCycleRow,
    isContinuationBlockingRow,
    isCancelledResubmitRow,
    canRetryVisibleRow,
    canResubmitRedeemRow,
    isAccountAttemptBlocked,
    syncAttemptCooldowns,
    getAccountAttemptInfo,
    getAccountCooldown,
    formatCooldownUntil,
    getResubmitBlockReason,
    describeSelectedRow,
    batchCount,
    prepareAutoCycleForSubmit,
    decorateInitialAutoCycleRows,
    forgetDeletedRows,
    markSubmittedRowsInAutoCycle,
    recordAccountSubmissionAttempts,
    getSubmittedAttemptNumber,
    registerCooldownsFromRows,
    scheduleAutoCycleFailures,
    releaseCancelledRowsToAutoCycle
  });
  useEffect(() => {
    if (!autoCycleState.enabled || isBusy) return;

    const currentRows = getCurrentTaskRows(rowsRef.current);
    const cancelledRows = currentRows.filter(
      (row) => String(row.status || "") === "cancelled" && row.email
    );
    if (cancelledRows.length) {
      const notice = releaseCancelledRowsToAutoCycle(cancelledRows);
      if (notice) setStatusMessage(`已同步旧取消任务：${notice}`);
      return;
    }

    const releaseRows = currentRows.filter(isAutoCycleFailureCandidate);
    if (releaseRows.length) {
      scheduleAutoCycleFailures(rowsRef.current, { silent: false });
      return;
    }

    if (currentRows.length) return;

    const current = normalizeAutoCycleState(autoCycleRef.current);
    const roundKey = String(current.currentRound);
    const queueEmails = new Set(current.queue.map((account) => account.email));
    const releasableEmails = new Set(
      normalizeStringArray(current.roundUsage[roundKey])
        .map((email) => email.toLowerCase())
        .filter(
	          (email) =>
	            queueEmails.has(email) &&
	            !current.completedEmails.includes(email) &&
	            !activeAccountCooldowns[email]
	        )
    );
    const releasedCount = releaseEmailsToCurrentAutoCycleRound(releasableEmails);
    if (!releasedCount) return;

    clearStaleSubmitPlanningState();
    const message = `已恢复 ${releasedCount} 个旧取消账号回队列`;
    setStatusMessage(message);
    showToast(message);
  }, [activeAccountCooldowns, autoCycleState, isBusy, rows]);

	  useEffect(() => {
	    if (!autoCycleState.enabled) return;
	    let nextState = mergeAccountsIntoAutoCycleState(
	      autoCycleRef.current,
	      redeemAccountValidation.accounts,
	      autoCycleRef.current.currentRound
	    );
	    const currentAccountEmails = new Set(
	      redeemAccountValidation.accounts.map((account) => normalizeEmail(account.email)).filter(Boolean)
	    );
	    const prunedQueue = nextState.queue.filter((account) => currentAccountEmails.has(account.email));
	    if (prunedQueue.length !== nextState.queue.length) {
	      nextState = {
	        ...nextState,
	        queue: prunedQueue,
	        cursorIndex: Math.min(nextState.cursorIndex, prunedQueue.length)
	      };
	    }
    const previousQueueKey = getAutoCycleQueueKey(autoCycleRef.current.queue);
    const nextQueueKey = getAutoCycleQueueKey(nextState.queue);
    if (nextQueueKey !== previousQueueKey) {
      commitAutoCycleState(nextState);
      setStatusMessage(`已同步自动换号队列：当前队列 ${nextState.queue.length} 个`);
    }
  }, [accountQueueKey, autoCycleState.enabled, autoCycleState.currentRound, failedAccounts.length]);

  useEffect(() => {
    if (!plusAccountRowKey) return;
    deletePlusAccounts(plusAccountRows, { auto: true, keepRows: true });
  }, [plusAccountRowKey]);

  useEffect(() => {
    const pending = pendingPoolContinuationRef.current;
    if (!pending || isBusy || poolPickerState.open) return;
    if (Number(pending.waitingAccounts || 0) <= 0) {
      pendingPoolContinuationRef.current = null;
      return;
    }

    const poolId = String(pending.poolId || lastSubmitPoolRef.current || "").trim();
    if (!poolId) {
      pendingPoolContinuationRef.current = null;
      return;
    }

    const poolRows = getCurrentTaskRows(rowsRef.current).filter(
      (row) => String(row?.submitPoolId || "") === poolId
    );
    if (!poolRows.length || poolRows.some((row) => !isTerminalStatus(row.status))) return;

    const availability = getSubmitAccountAvailability({
      accounts: accountValidation.accounts,
      rowList: rowsRef.current,
      cycleState: autoCycleRef.current,
      cooldowns: accountCooldownsRef.current,
      attemptLedger: accountAttemptLedgerRef.current,
      failedAccounts: failedAccountsRef.current
    });
    const continuationAvailableAccounts = availability.availableAccounts.filter((account) => {
      const accessToken = normalizeAccessToken(account?.accessToken);
      return !accessToken || !attemptedSubmitAccessTokensRef.current.has(accessToken);
    });
    if (!continuationAvailableAccounts.length) {
      pendingPoolContinuationRef.current = null;
      attemptedSubmitPoolIdsRef.current = new Set();
      attemptedSubmitAccessTokensRef.current = new Set();
      return;
    }

    pendingPoolContinuationRef.current = null;
    startRedeemWithPoolDecision({ continuation: true });
  }, [
    accountAttemptLedger,
    accountCooldowns,
    accountValidation.accounts,
    autoCycleState,
    cdkeyPools,
    failedAccounts,
    isBusy,
    poolContinuationVersion,
    poolPickerState.open,
    rows
  ]);

  function handleApiKeyChange(value) {
    apiKeyRef.current = value;
    setApiKey(value);
    saveStored(STORAGE_KEYS.apiKey, value);
  }

  function clearSavedConfig() {
    apiKeyRef.current = "";
    setApiKey("");
    setShowApiKey(false);
    removeStored("cdkRedeem.baseUrl");
    removeStored(STORAGE_KEYS.apiKey);
    saveUiSettings({ showApiKey: false });
    setStatusMessage("已清除浏览器本地保存的 API Key");
  }

	  function resetPreflightSummary() {
	    setPreflightSummary(EMPTY_PREFLIGHT_SUMMARY);
	  }

	  function removeEmailsFromAccountTracking(emailsToRemove, options = {}) {
	    const normalizedEmails = new Set(
	      [...(emailsToRemove || [])].map((email) => normalizeEmail(email)).filter(Boolean)
	    );
	    if (!normalizedEmails.size) return;

	    removeEmailsFromAutoCycle(normalizedEmails, options);

	    setAccountCooldowns((prev) => {
	      const next = { ...prev };
	      let changed = false;
	      normalizedEmails.forEach((email) => {
	        if (!Object.prototype.hasOwnProperty.call(next, email)) return;
	        delete next[email];
	        changed = true;
	      });
	      if (!changed) return prev;
	      accountCooldownsRef.current = next;
	      return next;
	    });

	    setAccountAttemptLedger((prev) => {
	      const next = { ...prev };
	      let changed = false;
	      normalizedEmails.forEach((email) => {
	        if (!Object.prototype.hasOwnProperty.call(next, email)) return;
	        delete next[email];
	        changed = true;
	      });
	      if (!changed) return prev;
	      accountAttemptLedgerRef.current = next;
	      return next;
	    });

	    setFailedAccounts((prev) => {
	      const next = prev.filter((account) => !normalizedEmails.has(normalizeEmail(account?.email)));
	      if (next.length === prev.length) return prev;
	      failedAccountsRef.current = next;
	      return next;
	    });
	  }

  const {
    handleAccountTextChange,
    handleAccountTextPaste,
    cleanupAccountText,
    handleAccountFileUpload,
    exportAccountInput,
    applyAccountTextEdit,
    applyAccountTextPaste,
    applyAccountTextCleanup
  } = useAccountInput({
    accountText,
    accountTextRef,
    setAccountText,
    setAccountNotice,
    setErrors,
    showToast,
    setStatusMessage,
    resetPreflightSummary,
    requestAccountInputRemovalConfirmation
  });

  function closePoolPicker() {
    setPoolPickerState({
      open: false,
      mode: "start",
      choices: []
    });
  }

  function getAvailableSubmitAccountCount() {
    const availability = getSubmitAccountAvailability({
      accounts: accountValidation.accounts,
      rowList: rowsRef.current,
      cycleState: autoCycleRef.current,
      cooldowns: accountCooldownsRef.current,
      attemptLedger: accountAttemptLedgerRef.current,
      failedAccounts: failedAccountsRef.current
    });
    return availability.availableAccounts.filter((account) => {
      const accessToken = normalizeAccessToken(account?.accessToken);
      return !accessToken || !attemptedSubmitAccessTokensRef.current.has(accessToken);
    }).length;
  }

  async function submitWithPool(poolId) {
    const selectedPoolId = String(poolId || "").trim();
    if (!selectedPoolId) return;

    closePoolPicker();
    attemptedSubmitPoolIdsRef.current = new Set([
      ...attemptedSubmitPoolIdsRef.current,
      selectedPoolId
    ]);
    const pool = CDK_POOLS.find((item) => item.id === selectedPoolId);
    const summary = await submitRedeems({
      poolId: selectedPoolId,
      poolLabel: pool?.label || pool?.shortLabel || selectedPoolId,
      reservedAccessTokens: [...attemptedSubmitAccessTokensRef.current]
    });

    if (!summary) {
      pendingPoolContinuationRef.current = null;
      return;
    }

    const submittedPoolId = String(summary.poolId || selectedPoolId);
    lastSubmitPoolRef.current = submittedPoolId;
    (summary.submittedAccessTokens || []).forEach((token) => {
      const normalizedToken = String(token || "").trim();
      if (normalizedToken) attemptedSubmitAccessTokensRef.current.add(normalizedToken);
    });
    const waitingAccounts = Number(summary.waitingAccounts || 0);

    if (!summary.submitted) {
      pendingPoolContinuationRef.current = null;
      if (waitingAccounts > 0 && getAvailableSubmitAccountCount() > 0) {
        await startRedeemWithPoolDecision({ continuation: true });
      }
      return;
    }

    if (waitingAccounts > 0) {
      pendingPoolContinuationRef.current = {
        poolId: submittedPoolId,
        waitingAccounts
      };
      setPoolContinuationVersion((version) => version + 1);
      return;
    }

    pendingPoolContinuationRef.current = null;
    attemptedSubmitPoolIdsRef.current = new Set();
    attemptedSubmitAccessTokensRef.current = new Set();
  }

  async function startRedeemWithPoolDecision(options = {}) {
    const selectedTaskRows = rowsRef.current.filter(
      (row) => row.selected && !isHistoricalAutoCycleRow(row)
    );
    if (selectedTaskRows.length) {
      closePoolPicker();
      await submitRedeems();
      return;
    }

    const continuation = options.continuation === true;
    if (!continuation) {
      attemptedSubmitPoolIdsRef.current = new Set();
      attemptedSubmitAccessTokensRef.current = new Set();
      lastSubmitPoolRef.current = "";
      pendingPoolContinuationRef.current = null;
    }
    const decision = chooseSubmitPoolDecision(
      cdkeyPools,
      continuation ? { excludePoolIds: [...attemptedSubmitPoolIdsRef.current] } : {}
    );

    if (decision.kind === "empty") {
      closePoolPicker();
      attemptedSubmitPoolIdsRef.current = new Set();
      attemptedSubmitAccessTokensRef.current = new Set();
      if (continuation) {
        const message = "没有可继续提交的其他卡密池";
        setStatusMessage(message);
        showToast(message, "error");
        return;
      }
      await submitRedeems();
      return;
    }

    if (decision.kind === "direct") {
      closePoolPicker();
      await submitWithPool(decision.poolId);
      return;
    }

    setPoolPickerState({
      open: true,
      mode: continuation ? "continue" : "start",
      choices: decision.choices
    });
  }

  function requestAccountInputRemovalConfirmation(nextAccountState, mode) {
    const missingActiveRows = findActiveAccountRowsMissingFromText(
      nextAccountState.text,
      rowsRef.current
    );
    if (!missingActiveRows.length) return false;

    const message = `账号输入将移除 ${missingActiveRows.length} 个仍在后端兑换的账号；请先确认`;
    setPendingAccountTextChange({
      mode,
      state: nextAccountState,
      missingActiveRows
    });
    setStatusMessage(message);
    showToast(message, "error");
    return true;
  }

  function applyPendingAccountTextChange() {
    if (!pendingAccountTextChange) return;
    const { mode, state } = pendingAccountTextChange;
    setPendingAccountTextChange(null);
    if (mode === "paste") {
      applyAccountTextPaste(state);
      return;
    }
    if (mode === "cleanup") {
      applyAccountTextCleanup(state);
      return;
    }
    applyAccountTextEdit(state);
  }

  async function handlePoolFileUpload(event, poolId) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await readTextFile(file);
    updateCdkPool(poolId, text);
    const pool = CDK_POOLS.find((item) => item.id === poolId);
    setStatusMessage(`已读取 ${pool?.label || poolId} 文件：${file.name}`);
  }

  function updateCdkPool(poolId, value) {
    resetPreflightSummary();
    setCdkeyPools((prev) => ({
      ...prev,
      [poolId]: value
    }));
  }

  function openCdkImportDialog(poolId = importPoolId) {
    setImportPoolId(poolId);
    setImportCdkText("");
    setShowCdkImportDialog(true);
  }

  function confirmCdkImport() {
    const text = String(importCdkText || "").replace(/^\ufeff/, "");
    const addedCount = countLines(text);
    const pool = CDK_POOLS.find((item) => item.id === importPoolId);
    if (!addedCount) {
      const message = "没有可导入的卡密";
      setStatusMessage(message);
      showToast(message, "error");
      return;
    }

    setCdkeyPools((prev) => ({
      ...prev,
      [importPoolId]: appendImportedText(prev[importPoolId] || "", text)
    }));
    resetPreflightSummary();
    setShowCdkImportDialog(false);
    setImportCdkText("");
    const message = `已追加 ${addedCount} 条卡密到 ${pool?.label || importPoolId}`;
    setStatusMessage(message);
    showToast(message);
  }

  function handleCdkPoolPaste(event, poolId) {
    const pastedText = event.clipboardData?.getData("text");
    if (!pastedText) return;

    event.preventDefault();
    const target = event.currentTarget;
    const currentValue = cdkeyPools[poolId] || "";
    const start = target.selectionStart ?? currentValue.length;
    const end = target.selectionEnd ?? start;
    updateCdkPool(poolId, `${currentValue.slice(0, start)}${pastedText}${currentValue.slice(end)}`);
    const pool = CDK_POOLS.find((item) => item.id === poolId);
    setStatusMessage(`已粘贴 ${pool?.label || poolId} 卡密`);
  }

  function validateConfig() {
    if (!apiKey.trim()) {
      throw new Error("请先填写外部 API Key");
    }
  }

  function getRedeemApi() {
    if (!redeemApiRef.current) {
      redeemApiRef.current = createRedeemApi({
        getApiKey: () => apiKeyRef.current
      });
    }
    return redeemApiRef.current;
  }

  function filterDeletedRows(rowList) {
    const deletedIds = deletedRowIdsRef.current;
    if (!deletedIds.size) return rowList;
    const filtered = (rowList || []).filter((row) => !deletedIds.has(row?.id));
    return filtered.length === rowList.length ? rowList : filtered;
  }

  function forgetDeletedRows(rowList) {
    const deletedIds = deletedRowIdsRef.current;
    if (!deletedIds.size) return;
    (rowList || []).forEach((row) => {
      if (row?.id) deletedIds.delete(row.id);
    });
  }

  async function callProxy(path, body) {
    return getRedeemApi().callProxy(path, body);
  }

  async function preflightCdkeysForSubmit(cdkeys, existingRows) {
    const cleanCdkeys = [...new Set(cdkeys.map((item) => item.cdkey).filter(Boolean))];
    const blockingReasons = getBlockingCdkeyReasons(existingRows);
    let payload = { items: [], batchCount: 0 };
    let preflightError = "";
    if (cleanCdkeys.length) {
      try {
        payload = await callProxy("/api/redeem/status", { cdkeys: cleanCdkeys });
      } catch (error) {
        preflightError = error?.message || "状态接口请求失败";
      }
    }
    const normalizedByCdkey = new Map(
      (payload.items || [])
        .map(normalizeStatusItem)
        .filter((item) => item.cdkey)
        .map((item) => [item.cdkey, item])
    );

    const availableCdkeys = [];
    const errors = [];
    const summaryEntries = [];

    cdkeys.forEach((cdkey) => {
      if (preflightError) {
        summaryEntries.push({ preflightItem: { status: "unknown" } });
        errors.push({
          lineNumber: cdkey.lineNumber,
          source: cdkey.cdkey,
          poolId: cdkey.poolId,
          poolLabel: cdkey.poolLabel,
          reason: `卡密状态查询失败，请重试：${preflightError}`
        });
        return;
      }

      const item = normalizedByCdkey.get(cdkey.cdkey);
      const blockedReason = blockingReasons.get(cdkey.cdkey) || "";
      const classification = classifyCdkeyPreflightState(item, blockedReason);
      summaryEntries.push({ preflightItem: item, blockedReason });

      if (classification.usable) {
        availableCdkeys.push(cdkey);
        return;
      }

      errors.push({
        lineNumber: cdkey.lineNumber,
        source: cdkey.cdkey,
        poolId: cdkey.poolId,
        poolLabel: cdkey.poolLabel,
        reason: classification.reason
      });
    });

    const summary = buildPreflightSummary(summaryEntries, { checked: cdkeys.length });
    return {
      payload,
      availableCdkeys,
      errors,
      summary
    };
  }

  function commitAutoCycleState(nextState) {
    const normalized = normalizeAutoCycleState(nextState);
    autoCycleRef.current = normalized;
    setAutoCycleState(normalized);
    return normalized;
  }

	  function removeEmailsFromAutoCycle(emailsToRemove, options = {}) {
	    if (!emailsToRemove.size) return;
	    const current = autoCycleRef.current;
	    const completedEmails = new Set(current.completedEmails);
	    emailsToRemove.forEach((email) => {
	      if (options.completed) completedEmails.add(email);
	    });
    const removedBeforeCursor = current.queue
      .slice(0, current.cursorIndex)
      .filter((account) => emailsToRemove.has(account.email)).length;
    const nextQueue = current.queue.filter((account) => !emailsToRemove.has(account.email));
    const nextCursorIndex = Math.min(
      Math.max(current.cursorIndex - removedBeforeCursor, 0),
      nextQueue.length
    );
    commitAutoCycleState({
      ...current,
	      queue: nextQueue,
	      cursorIndex: nextCursorIndex,
	      completedEmails: [...completedEmails],
	      failedEmails: []
	    });
	  }

  function clearStaleSubmitPlanningState() {
    setPreflightSummary(EMPTY_PREFLIGHT_SUMMARY);
    setErrors((prev) => prev.filter((error) => !isStaleSubmitPlanningError(error)));
  }

  function releaseEmailsToCurrentAutoCycleRound(emailsToRelease) {
    const emailSet = new Set(
      [...(emailsToRelease || [])]
        .map((email) => String(email || "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (!emailSet.size || !autoCycleRef.current.enabled) return 0;

    const current = normalizeAutoCycleState(autoCycleRef.current);
    const queueIndexByEmail = new Map(
      current.queue.map((account, index) => [account.email, index])
    );
    const releaseIndexes = [...emailSet]
      .map((email) => queueIndexByEmail.get(email))
      .filter((index) => Number.isInteger(index));
    if (!releaseIndexes.length) return 0;

    const queueEmails = new Set([...emailSet].filter((email) => queueIndexByEmail.has(email)));
    const roundKey = String(current.currentRound);
    const currentRoundUsage = normalizeStringArray(current.roundUsage[roundKey]).map((email) =>
      email.toLowerCase()
    );
    const currentRoundUsedSet = new Set(currentRoundUsage);
    const releasableEmails = [...queueEmails].filter((email) => {
      const queueIndex = queueIndexByEmail.get(email);
      return currentRoundUsedSet.has(email) || queueIndex < current.cursorIndex;
    });
    if (!releasableEmails.length) return 0;

    const releasableSet = new Set(releasableEmails);
    const nextRoundUsage = {
      ...current.roundUsage,
      [roundKey]: currentRoundUsage.filter((email) => !releasableSet.has(email))
    };
    const nextCursorIndex = Math.min(
      current.cursorIndex,
      ...releasableEmails.map((email) => queueIndexByEmail.get(email))
    );

    commitAutoCycleState({
      ...current,
      cursorIndex: nextCursorIndex,
      roundUsage: nextRoundUsage
    });
    return releasableEmails.length;
  }

  function releaseCancelledRowsToAutoCycle(cancelledRows) {
    const emails = new Set(
      (cancelledRows || [])
        .map((row) => String(row.email || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const releasedCount = releaseEmailsToCurrentAutoCycleRound(emails);
    if (!releasedCount) return "";

    clearStaleSubmitPlanningState();
    const message = `已释放 ${releasedCount} 个账号回队列`;
    showToast(message);
    return message;
  }

  function markSubmittedRowsInAutoCycle(rowsToMark) {
    if (!rowsToMark?.length) return;
    const baseState = normalizeAutoCycleState({ ...autoCycleRef.current, enabled: true });
    let nextState = mergeAccountsIntoAutoCycleState(
      baseState,
      redeemAccountValidation.accounts,
      baseState.currentRound
    );
    nextState = markRowsUsedInAutoCycle(nextState, rowsToMark);
    commitAutoCycleState(nextState);
  }

  function isAccountCooling(email, now = Date.now()) {
    return Boolean(getAccountCooldown(email, accountCooldownsRef.current, now));
  }

  function isAccountAttemptBlocked(email, now = Date.now()) {
    return isAccountAttemptLimitReached(email, accountAttemptLedgerRef.current, now);
  }

  function getNextAccountAttemptNumber(email, now = Date.now()) {
    const info = getAccountAttemptInfo(email, accountAttemptLedgerRef.current, now);
    return Math.min(info.count + 1, ACCOUNT_ATTEMPT_LIMIT);
  }

  function getResolvedAttemptNumber(row, submittedCount = 0) {
    return Math.min(
      Math.max(
        Number(submittedCount || 0),
        Number(row?.accountAttemptNumber || 0),
        Number(row?.attemptNumber || 0),
        1
      ),
      ACCOUNT_ATTEMPT_LIMIT
    );
  }

  function getSubmittedAttemptNumber(row, attemptCountByEmail) {
    const email = String(row?.email || "").trim().toLowerCase();
    return getResolvedAttemptNumber(row, attemptCountByEmail.get(email));
  }

  function syncAttemptCooldowns(ledger, options = {}) {
    const now = Date.now();
    const normalizedLedger = normalizeAccountAttemptLedger(ledger, now);
    let nextCooldowns = normalizeAccountCooldowns(accountCooldownsRef.current, now);
    const cooledEmails = [];
    let changed = false;

    Object.entries(nextCooldowns).forEach(([email, cooldown]) => {
      const reason = String(cooldown?.reason || "");
      const attemptCount = normalizedLedger[email]?.attempts?.length || 0;
      if (reason === LOCAL_ATTEMPT_LIMIT_REASON && attemptCount < ACCOUNT_ATTEMPT_LIMIT) {
        const { [email]: _removed, ...rest } = nextCooldowns;
        nextCooldowns = rest;
        changed = true;
      }
    });

	    // The third submission is allowed. The account enters cooldown only after
	    // the third attempt fails, or when the backend explicitly returns a 24h
	    // submission-limit error. The ledger alone only blocks a fourth submit.

    if (!changed) return [];

    accountCooldownsRef.current = nextCooldowns;
    setAccountCooldowns(nextCooldowns);
    let nextRowsForAutoCycle = [];
    setRows((prev) => {
      const nextRows = applyCooldownMarkersToRows(prev, nextCooldowns, now);
      rowsRef.current = nextRows;
      nextRowsForAutoCycle = nextRows;
      return nextRows;
    });
    if (cooledEmails.length) removeEmailsFromAutoCycle(new Set(cooledEmails));
    if (cooledEmails.length) {
      scheduleAutoCycleFailures(nextRowsForAutoCycle.length ? nextRowsForAutoCycle : rowsRef.current, {
        silent: false
      });
    }
    if (!options.silent) {
      setStatusMessage(`已封存 ${cooledEmails.length} 个账号 24 小时：账号 24 小时内最多尝试 3 次`);
    }
    return cooledEmails;
  }

  function recordAccountSubmissionAttempts(rowsToRecord) {
    const now = Date.now();
    let nextLedger = normalizeAccountAttemptLedger(accountAttemptLedgerRef.current, now);
    const attemptCountByEmail = new Map();

    (rowsToRecord || []).forEach((row) => {
      const email = String(row?.email || "").trim().toLowerCase();
      if (!email) return;
      const currentAttempts = nextLedger[email]?.attempts || [];
      const attempts = [...currentAttempts, now]
        .filter((timestamp) => timestamp > now - ACCOUNT_ATTEMPT_WINDOW_MS)
        .sort((left, right) => left - right);
      nextLedger = {
        ...nextLedger,
        [email]: {
          email,
          attempts,
          updatedAt: now
        }
      };
      attemptCountByEmail.set(email, Math.min(attempts.length, ACCOUNT_ATTEMPT_LIMIT));
    });

    if (attemptCountByEmail.size) {
      accountAttemptLedgerRef.current = nextLedger;
      setAccountAttemptLedger(nextLedger);
      syncAttemptCooldowns(nextLedger, { silent: true });
    }

    return attemptCountByEmail;
  }

  function registerCooldownsFromRows(rowList, options = {}) {
    const now = Date.now();
    let nextCooldowns = normalizeAccountCooldowns(accountCooldownsRef.current, now);
    const cooledEmails = [];
    let cooldownsChanged = false;
    const successEmails = new Set(
      (rowList || [])
        .filter((row) => String(row?.status || "") === "success")
        .map((row) => String(row?.email || "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (successEmails.size) {
      const cleanedCooldowns = { ...nextCooldowns };
      successEmails.forEach((email) => {
        if (!cleanedCooldowns[email]) return;
        delete cleanedCooldowns[email];
        cooldownsChanged = true;
      });
      nextCooldowns = cleanedCooldowns;
    }
    const markedRows = (rowList || []).map((row) => {
      const reason = getRowReasonText(row);
      const hasDailyLimitReason = isAccountDailyLimitReason(reason);
      if (!hasDailyLimitReason && !isLocalAttemptLimitFailureRow(row)) return row;
      if (!hasDailyLimitReason && isLocalAttemptLimitFailureRow(row)) {
        return {
          ...row,
          status: String(row?.status || "") || "failed",
          reason: row.reason || LOCAL_ATTEMPT_LIMIT_REASON,
          can_cancel: false,
          can_retry: false,
          accountAttemptNumber: ACCOUNT_ATTEMPT_LIMIT,
          accountCooldownReason: LOCAL_ATTEMPT_LIMIT_REASON
        };
      }
      return {
        ...row,
        status: String(row?.status || "") === "success" ? row.status : "failed",
        reason: getDailyLimitArchiveReason(row),
        can_cancel: false,
        can_retry: false,
        accountAttemptNumber: ACCOUNT_ATTEMPT_LIMIT,
        accountCooldownReason: DAILY_LIMIT_DISPLAY_REASON
      };
    });

    markedRows.forEach((row) => {
      const email = String(row?.email || "").trim().toLowerCase();
      if (!email) return;
      const reason = getRowReasonText(row);
      const isDailyLimit = isAccountDailyLimitReason(reason);
      const isLocalAttemptLimit = isLocalAttemptLimitFailureRow(row);
      if (!isDailyLimit && !isLocalAttemptLimit) return;
      const previousCooldownUntil = Number(row?.accountCooldownUntil || 0);
      if (previousCooldownUntil > 0 && previousCooldownUntil <= now) return;

      const current = nextCooldowns[email];
      const until = Math.max(Number(current?.until || 0), now + ACCOUNT_COOLDOWN_MS);
      const nextReason = isDailyLimit
        ? reason || DAILY_LIMIT_DISPLAY_REASON
        : LOCAL_ATTEMPT_LIMIT_REASON;
      nextCooldowns = {
        ...nextCooldowns,
        [email]: {
          email,
          until,
          reason: nextReason,
          startedAt: Number(current?.startedAt || now)
        }
      };
      cooldownsChanged = true;
      if (!current || current.until <= now) cooledEmails.push(email);
    });

    if (!cooldownsChanged) {
      return applyCooldownMarkersToRows(markedRows, nextCooldowns, now);
    }

    const uniqueEmails = [...new Set(cooledEmails)];
    accountCooldownsRef.current = nextCooldowns;
    setAccountCooldowns(nextCooldowns);
    const changedEmailSet = new Set(
      markedRows
        .map((row) => String(row?.email || "").trim().toLowerCase())
        .filter(Boolean)
        .filter((email) => nextCooldowns[email])
    );
    removeEmailsFromAutoCycle(changedEmailSet);
    if (uniqueEmails.length && !options.silent) {
      const message = `已封存 ${uniqueEmails.length} 个账号 24 小时：账号已达到 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次或今日提交次数已达上限`;
      setStatusMessage(message);
      showToast(message, "error");
    }

    const finalRows = applyCooldownMarkersToRows(markedRows, nextCooldowns, now);
    if (uniqueEmails.length && options.skipAutoCycle !== true) {
      scheduleAutoCycleFailures(finalRows, { silent: false });
    }
    return finalRows;
  }

  function mergeAccountsIntoAutoCycleState(state, accounts, addedRound = state.currentRound) {
    return mergeAccountsIntoAutoCycleQueue(state, accounts, {
      addedRound,
      isAccountCooling,
      isAccountAttemptBlocked
    });
  }

  function prepareAutoCycleForSubmit(submittingRows, resetCycle) {
    const baseState = resetCycle
      ? normalizeAutoCycleState({
          enabled: true,
          currentRound: 1,
	          cursorIndex: 0,
	          queue: [],
	          roundUsage: {},
	          handledRowIds: [],
	          failedEmails: [],
	          completedEmails: []
	        })
      : normalizeAutoCycleState({ ...autoCycleRef.current, enabled: true });
    let nextState = mergeAccountsIntoAutoCycleState(
      baseState,
      redeemAccountValidation.accounts,
      baseState.currentRound
    );
    nextState = markRowsUsedInAutoCycle(nextState, submittingRows);
    return commitAutoCycleState(nextState);
  }

  function decorateInitialAutoCycleRows(rowsToDecorate) {
    return rowsToDecorate.map((row) => {
      const nextAttemptNumber = Math.min(
        Math.max(
          getNextAccountAttemptNumber(row.email),
          Number(row.accountAttemptNumber || row.attemptNumber || 0),
          1
        ),
        ACCOUNT_ATTEMPT_LIMIT
      );
      return {
        ...row,
        originalCdkey: row.originalCdkey || row.cdkey,
        attemptRound: 1,
        attemptNumber: nextAttemptNumber,
        accountAttemptNumber: nextAttemptNumber,
        parentRowId: row.parentRowId || "",
        autoCycle: true,
        statusLocked: false,
        autoCycleHandled: false
      };
    });
  }

  function getNextAutoCycleAccount(state, reservedEmails = new Set()) {
    const nextState = normalizeAutoCycleState(state);
    const queueLength = nextState.queue.length;
    if (!queueLength) return { account: null, round: 1, state: nextState };

    const startIndex = Math.max(Number(nextState.cursorIndex || 0), 0) % queueLength;
    for (let offset = 0; offset < queueLength; offset += 1) {
      const index = (startIndex + offset) % queueLength;
      const account = nextState.queue[index];
      const email = String(account?.email || "").trim().toLowerCase();
      if (!account || !email) continue;
      if (reservedEmails.has(email)) continue;
      if (nextState.completedEmails.includes(email)) continue;
      if (isAccountCooling(email)) continue;
      if (isAccountAttemptBlocked(email)) continue;
      return {
        account,
        round: 1,
        state: {
          ...nextState,
          currentRound: 1,
          cursorIndex: (index + 1) % queueLength
        }
      };
    }

    return {
      account: null,
      round: 1,
      state: {
        ...nextState,
        currentRound: 1,
        cursorIndex: startIndex
      }
    };
  }

  function createAutoCycleRow(failedRow, account, index) {
    const originalCdkey = failedRow.originalCdkey || failedRow.cdkey;
    const attemptNumber = getNextAccountAttemptNumber(account.email);
    return {
      ...createRedeemRow({
        id: `auto-${Date.now()}-${index}-${account.email}`,
        index,
        account,
        cdkey: {
          lineNumber: failedRow.cdkeyLineNumber || index + 1,
          cdkey: originalCdkey,
          channel: failedRow.channel,
          channelLabel: failedRow.channelLabel,
          poolId: failedRow.channel,
          poolLabel: failedRow.channelLabel
        },
        status: "submitting"
      }),
      originalCdkey,
      submitPoolId: failedRow.submitPoolId || "",
      submitPoolLabel: failedRow.submitPoolLabel || "",
      attemptRound: 1,
      attemptNumber,
      accountAttemptNumber: attemptNumber,
      parentRowId: failedRow.id,
      autoCycle: true,
      autoCycleSourceEmail: failedRow.email || "",
      statusLocked: false,
      autoCycleHandled: false
    };
  }

  function isAutoCycleFailureCandidate(row) {
    return autoCycleHandlersRef.current.isAutoCycleFailureCandidate?.(row) || false;
  }

  function clearAutoCycleScheduleTimer() {
    autoCycleHandlersRef.current.clearAutoCycleScheduleTimer?.();
  }

  function scheduleAutoCycleFailures(rowList = rowsRef.current, options = {}) {
    return autoCycleHandlersRef.current.scheduleAutoCycleFailures?.(rowList, options) || 0;
  }

  async function queryFromInputOrRows() {
    selectWorkspaceTab("execute");
    const currentRows = rowsRef.current;
    const currentVisibleRows = currentRows.filter((row) => !isHistoricalAutoCycleRow(row));
    const shouldUseEffectivePools =
      accountLineCount > 0 || currentVisibleRows.some((row) => isAccountTaskRow(row));
    const prepared = buildQueryRows(
      accountText,
      shouldUseEffectivePools ? submitCdkeyPools : cdkeyPools
    );
    setErrors(prepared.errors);
    const queryBaseRows = mergeMissingQueryRows(currentRows, prepared.rows);
    const activeCdkeys = queryBaseRows
      .filter((row) => !isHistoricalAutoCycleRow(row))
      .map((row) => row.cdkey)
      .filter(Boolean);
    if (!activeCdkeys.length) {
      setStatusMessage("没有可查询的 CDK");
      return;
    }

    if (queryBaseRows.length !== currentRows.length) {
      rowsRef.current = queryBaseRows;
      setRows(queryBaseRows);
    }
    await queryStatuses(activeCdkeys, {
      silent: false,
      baseRows: queryBaseRows,
      forceRemote: true
    });
  }

  async function startPollingFromInputOrRows() {
    selectWorkspaceTab("execute");
    if (isPolling) {
      setStatusMessage("自动轮询已经开启");
      return;
    }

    try {
      validateConfig();
      const currentRows = rowsRef.current;
      const currentVisibleRows = currentRows.filter((row) => !isHistoricalAutoCycleRow(row));
      const shouldUseEffectivePools =
        accountLineCount > 0 || currentVisibleRows.some((row) => isAccountTaskRow(row));
      const prepared = buildQueryRows(
        accountText,
        shouldUseEffectivePools ? submitCdkeyPools : cdkeyPools
      );
      setErrors(prepared.errors);
      const baseRows = mergeMissingQueryRows(currentRows, prepared.rows);
      if (!baseRows.length) {
        setStatusMessage("没有可轮询的 CDK；请先粘贴 CDK 或提交兑换任务");
        return;
      }
      if (baseRows.length !== currentRows.length) {
        rowsRef.current = baseRows;
        setRows(baseRows);
      }

      const cdkeys = getRowCdkeys(baseRows);
      if (!cdkeys.length) {
        setStatusMessage("没有可轮询的 CDK；请先粘贴 CDK 或提交兑换任务");
        return;
      }

      setStatusMessage(`正在开启状态轮询：${cdkeys.length} 个 CDK`);
      const updatedRows = await queryStatuses(cdkeys, {
        silent: true,
        baseRows,
        throwOnError: true,
        forceRemote: true,
        keepPollingWhenTerminal: true
      });
      const nextCdkeys = getRowCdkeys(
        updatedRows.filter((row) => cdkeys.includes(row.cdkey))
      );
      if (!nextCdkeys.length) {
        setStatusMessage("查询完成，没有可继续同步的 CDK");
        return;
      }

      startPolling(nextCdkeys, {
        forceRemote: true,
        keepPollingWhenTerminal: true
      });
      setStatusMessage(`状态轮询已开启：每 5 秒同步 ${nextCdkeys.length} 个 CDK 和账号状态`);
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function cancelRows(targetRows) {
    const cancellable = targetRows.filter(canCancelRow);
    if (!cancellable.length) {
      setStatusMessage("没有可取消的选中任务");
      return;
    }

    await runJobAction({
      path: "/api/redeem/cancel",
      rowsToAct: cancellable,
      pendingMessage: "正在取消任务",
      doneMessage: "取消请求已发送，正在刷新状态",
      clearStaleStatusGuard: true,
      afterSuccess: () => releaseCancelledRowsToAutoCycle(cancellable)
    });
  }

  function clearAll() {
    stopPolling();
    setShowClearConfirm(false);
    setPendingAccountTextChange(null);
    setPendingDeleteRows([]);
    setAccountText("");
    setCdkeyPools(createEmptyCdkPools());
    setRows([]);
    setPlusExports({ upi: [], ideal: [] });
    setDownloadedExportCounts({ upi: 0, ideal: 0 });
	    setAutoCycleState(normalizeAutoCycleState({}));
	    autoCycleRef.current = normalizeAutoCycleState({});
	    setFailedAccounts([]);
	    failedAccountsRef.current = [];
	    setAccountCooldowns({});
	    accountCooldownsRef.current = {};
	    setAccountAttemptLedger({});
	    accountAttemptLedgerRef.current = {};
	    setErrors([]);
    setActivityLog([]);
    setAccountNotice("");
    setPreflightSummary(EMPTY_PREFLIGHT_SUMMARY);
    setShowApiKey(false);
    setActiveDetailRowId("");
    subscriptionCacheRef.current.clear();
    removeStored(STORAGE_KEYS.accountText);
    removeStored(STORAGE_KEYS.cdkeyPools);
    removeStored(STORAGE_KEYS.rows);
    removeStored(STORAGE_KEYS.plusExports);
    removeStored(STORAGE_KEYS.downloadedExportCounts);
	    removeStored(STORAGE_KEYS.autoCycleState);
	    removeStored(STORAGE_KEYS.failedAccounts);
	    removeStored(STORAGE_KEYS.accountCooldowns);
	    removeStored(STORAGE_KEYS.accountAttemptLedger);
	    removeStored(STORAGE_KEYS.errors);
    removeStored(STORAGE_KEYS.accountNotice);
    removeStored(STORAGE_KEYS.statusMessage);
    removeStored(STORAGE_KEYS.lastUpdatedAt);
    removeStored(STORAGE_KEYS.uiSettings);
    removeStored(STORAGE_KEYS.workflowSnapshot);
    removeStored(STORAGE_KEYS.sensitivePersistencePolicy);
    setStatusMessage("已清空输入和结果", { log: false });
    showToast("已清空输入和结果");
    setLastUpdatedAt("");
  }

  function deletePlusAccounts(targetRows = plusAccountRows, options = {}) {
    const deletableRows = targetRows.filter(isPlusAccountRow);
    if (!deletableRows.length) {
      if (options.auto) return;
      setStatusMessage("没有已进入 Plus 的账号可删除");
      showToast("没有已进入 Plus 的账号可删除", "error");
      return;
    }

    const rowIds = new Set(deletableRows.map((row) => row.id));
    const emails = new Set(deletableRows.map((row) => row.email.toLowerCase()).filter(Boolean));
    const cdkeys = new Set(deletableRows.map((row) => String(row.cdkey || "").trim()).filter(Boolean));
    const nextRows = options.keepRows
      ? rowsRef.current
      : rowsRef.current.filter((row) => !rowIds.has(row.id));
    if (!options.skipArchive) {
      setPlusExports((prev) => mergePlusExportRows(prev, deletableRows));
    }
    rowsRef.current = nextRows;
    setRows(nextRows);
    setAccountText((prev) => removeAccountLinesByEmail(prev, emails));
	    removeEmailsFromAccountTracking(emails, { completed: true });
    setCdkeyPools((prev) => removeCdkeyLinesByValue(prev, cdkeys));
    setPreflightSummary(EMPTY_PREFLIGHT_SUMMARY);
    setErrors((prev) =>
      prev.filter((error) => {
        const source = String(error?.source || "").trim();
        return !emails.has(getAccountEmailFromLine(source)) && !cdkeys.has(source);
      })
    );
    if (!options.keepRows && rowIds.has(activeDetailRowId)) {
      setActiveDetailRowId("");
    }

    if (isPolling) {
      const nextPollableCdkeys = getPollableCdkeys(nextRows);
      if (nextPollableCdkeys.length) {
        startPolling(nextPollableCdkeys);
      } else {
        stopPolling();
      }
    }

    const message = options.auto
      ? `已自动移动 ${deletableRows.length} 个已 Plus 账号到成功导出池`
      : `已删除 ${deletableRows.length} 个已 Plus 账号，并从导入账号和卡密池移除`;
    if (!options.silent) {
      setStatusMessage(message);
      showToast(message);
    }
  }

  function deleteRows(targetRows = selectedRows, options = {}) {
    const deletableRows = targetRows.filter((row) => row?.id);
    if (!deletableRows.length) {
      const message = options.emptyMessage || "没有可删除的选中请求";
      setStatusMessage(message);
      showToast(message, "error");
      return;
    }

    const activeBackendRows = deletableRows.filter(isActiveBackendTaskRow);
    if (activeBackendRows.length && !options.force) {
      setPendingDeleteRows(deletableRows);
      const message = `选中 ${deletableRows.length} 条，其中 ${activeBackendRows.length} 条仍在后端兑换；删除前请确认`;
      setStatusMessage(message);
      showToast(message, "error");
      return;
    }

    const rowIds = new Set(deletableRows.map((row) => row.id));
    const emails = new Set(
      deletableRows.map((row) => String(row.email || "").toLowerCase()).filter(Boolean)
    );
    const cdkeys = new Set(
      deletableRows.map((row) => String(row.cdkey || "").trim()).filter(Boolean)
    );
    const plusRows = deletableRows.filter(isPlusAccountRow);
    rowIds.forEach((id) => deletedRowIdsRef.current.add(id));
    const nextRows = rowsRef.current.filter((row) => !rowIds.has(row.id));

    if (plusRows.length && !options.skipArchive) {
      setPlusExports((prev) => mergePlusExportRows(prev, plusRows));
    }

    rowsRef.current = nextRows;
    setRows(nextRows);
    setAccountText((prev) => removeAccountLinesByEmail(prev, emails));
	    const completedEmails = new Set(
	      plusRows.map((row) => String(row.email || "").toLowerCase()).filter(Boolean)
	    );
	    if (completedEmails.size) {
	      removeEmailsFromAccountTracking(completedEmails, { completed: true });
	    }
	    const remainingEmails = new Set([...emails].filter((email) => !completedEmails.has(email)));
	    if (remainingEmails.size) {
	      removeEmailsFromAccountTracking(remainingEmails, { failed: options.failed === true });
	    }
    setCdkeyPools((prev) => removeCdkeyLinesByValue(prev, cdkeys));
    setPreflightSummary(EMPTY_PREFLIGHT_SUMMARY);
    setErrors((prev) =>
      prev.filter((error) => {
        const source = String(error?.source || "").trim();
        return !emails.has(getAccountEmailFromLine(source)) && !cdkeys.has(source);
      })
    );
    if (rowIds.has(activeDetailRowId)) {
      setActiveDetailRowId("");
    }

    if (isPolling) {
      const nextPollableCdkeys = getPollableCdkeys(nextRows);
      if (nextPollableCdkeys.length) {
        startPolling(nextPollableCdkeys);
      } else {
        stopPolling();
      }
    }

    const message = `已删除 ${deletableRows.length} 条请求，并同步移除对应账号/卡密`;
    setPendingDeleteRows([]);
    setStatusMessage(message);
    showToast(message);
  }

  async function copySuccessOutput(type) {
    const output = successExports[type] || "";
    const label = type === "upi" ? "UPI" : "IDEAL";
    if (!output) {
      setStatusMessage(`没有 ${label} 成功结果可复制`);
      return;
    }
    try {
      await copyTextToClipboard(output);
      const message = `${label} 成功结果已复制到剪贴板`;
      setStatusMessage(message);
      showToast(message);
    } catch (error) {
      const message = `${label} 复制失败，请手动选中导出内容复制`;
      setStatusMessage(message);
      showToast(message, "error");
    }
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall back to a selected textarea below.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("copy failed");
    }
  }

  function showToast(message, tone = "success") {
    setToastMessage(message);
    setToastTone(tone);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage("");
      toastTimerRef.current = null;
    }, 2200);
  }

  function restoreCooldownAccounts() {
    const restoreEmails = getRestorableCooldownEmails();

    if (!restoreEmails.size) {
      const message = "没有可恢复的冷却账号";
      setStatusMessage(message);
      showToast(message, "error");
      return;
    }

    const restored = clearAccountLifecycleBlocks({
      emails: [...restoreEmails],
      ledger: accountAttemptLedgerRef.current,
      cooldowns: accountCooldownsRef.current,
      rows: rowsRef.current
    });

    accountAttemptLedgerRef.current = restored.ledger;
    accountCooldownsRef.current = restored.cooldowns;
    rowsRef.current = restored.rows;
    setAccountAttemptLedger(restored.ledger);
    setAccountCooldowns(restored.cooldowns);
    setRows(restored.rows);

    const message = `已恢复 ${restored.restoredEmails.length} 个本地冷却账号，可重新进入兑换队列`;
    setStatusMessage(message);
    showToast(message, "success");
  }

  function getRestorableCooldownEmails({
    accounts = accountValidation.accounts,
    cooldowns = activeAccountCooldowns,
    ledger = accountAttemptLedgerRef.current,
    rows: rowList = rowsRef.current,
    now = Date.now()
  } = {}) {
    const activeImportedEmails = new Set(
      (Array.isArray(accounts) ? accounts : [])
        .map((account) => normalizeEmail(account?.email))
        .filter(Boolean)
    );
    const restoreEmails = new Set();

    Object.entries(cooldowns || {}).forEach(([email, item]) => {
      const normalizedEmail = normalizeEmail(item?.email || email);
      if (activeImportedEmails.has(normalizedEmail)) {
        restoreEmails.add(normalizedEmail);
      }
    });

    Object.entries(ledger || {}).forEach(([email, entry]) => {
      const normalizedEmail = normalizeEmail(entry?.email || email);
      const attemptCount = Number(entry?.attemptCount || 0);
      const attemptsLength = Array.isArray(entry?.attempts) ? entry.attempts.length : 0;
      if (
        activeImportedEmails.has(normalizedEmail) &&
        (attemptCount >= ACCOUNT_ATTEMPT_LIMIT || attemptsLength >= ACCOUNT_ATTEMPT_LIMIT)
      ) {
        restoreEmails.add(normalizedEmail);
      }
    });

    (Array.isArray(rowList) ? rowList : []).forEach((row) => {
      const normalizedEmail = normalizeEmail(row?.email);
      if (activeImportedEmails.has(normalizedEmail) && Number(row?.accountCooldownUntil || 0) > now) {
        restoreEmails.add(normalizedEmail);
      }
    });

    return restoreEmails;
  }

  function downloadSuccessOutput(type) {
    const output = successExports[type] || "";
    const label = type === "upi" ? "UPI" : "IDEAL";
    if (!output) {
      setStatusMessage(`没有 ${label} 成功结果可下载`);
      return;
    }
    const downloadedCount = countLines(output);

    setPlusExports((prev) => ({
      ...prev,
      [type]: []
    }));
    setDownloadedExportCounts((prev) => ({
      ...prev,
      [type]: Math.max(Number(prev[type] || 0), 0) + downloadedCount
    }));
    const downloadableRows = rowsRef.current.filter((row) => isPlusRowInExportBucket(row, type));
    if (downloadableRows.length) {
      deletePlusAccounts(downloadableRows, { auto: true, silent: true, skipArchive: true });
    }

    const message = `${label} 成功结果已下载，并已清空该导出池`;
    setStatusMessage(message);
    showToast(message);
  }

  function toggleSelected(rowId) {
    setRows((prev) =>
      prev.map((row) => (row.id === rowId ? { ...row, selected: !row.selected } : row))
    );
  }

  function setAllSelected(checked) {
    const visibleIds = new Set(visibleRequestRows.map((row) => row.id));
    const count = checked ? visibleIds.size : 0;
    setRows((prev) =>
      prev.map((row) => ({
        ...row,
        selected: visibleIds.has(row.id) ? checked : false
      }))
    );
    setStatusMessage(checked ? `已全选 ${count} 条请求` : "已清空选择");
  }

  function selectRowsByFilter(predicate, label) {
    const visibleIds = new Set(visibleRequestRows.map((row) => row.id));
    const count = visibleRequestRows.filter(predicate).length;
    setRows((prev) =>
      prev.map((row) => ({
        ...row,
        selected: visibleIds.has(row.id) ? predicate(row) : false
      }))
    );
    setStatusMessage(`已选择${label}：${count} 条`);
  }

  function invertSelectedRows() {
    const visibleIds = new Set(visibleRequestRows.map((row) => row.id));
    const nextCount = visibleRequestRows.filter((row) => !row.selected).length;
    setRows((prev) =>
      prev.map((row) => ({
        ...row,
        selected: visibleIds.has(row.id) ? !row.selected : false
      }))
    );
    setStatusMessage(`已反选，当前选中 ${nextCount} 条`);
  }

  const selectedTargetRows = selectedRows.length ? selectedRows : [];
  const pollableRowsCount = getRowCdkeys(visibleRequestRows).length;
  const inputPollableCdkCount =
    accountLineCount > 0 || visibleRequestRows.some((row) => isAccountTaskRow(row))
      ? availableCdkCount
      : validCdkCount;
  const canStartPolling = pollableRowsCount > 0 || inputPollableCdkCount > 0;
  const activeDetailRow =
    visibleRequestRows.find((row) => row.id === activeDetailRowId) ||
    selectedRows[0] ||
    visibleRequestRows[0] ||
    null;
  const exportLineCount = countLines(successExports.upi) + countLines(successExports.ideal);
  const redeemViewModel = buildRedeemViewModel({
    rows: currentTaskRows,
    accountFacts: {
      counts: {
        pool: accountLineCount,
        available: activeAccountLineCount,
        cooling: cooldownAccountCount,
        attemptLimited: attemptLimitedAccountCount,
        activeTask: activeTaskAccountCount,
        completed: completedAccountCount,
        completedPlus: processedPlusAccountCount,
        estimatedImported: estimatedImportedAccountCount
      }
    },
    cdkeyFacts: {
      total: cdkUsageStats.total,
      usedCount: cdkUsageStats.usedCount,
      unusedCount: cdkUsageStats.unusedCount,
      available: availableCdkCount
    },
    statusCounts,
    groupedStatusCounts,
    counts: {
      resubmittableCount,
      cooldownTaskCount,
      taskIssueCount,
      displayedAvailableCdkCount,
      displayedRedeemablePairCount,
      displayedWaitingAccounts,
      displayedWaitingCdkeys,
      hasPreflightSummary,
      preflightAttentionCount,
      autoCycleQueueRemaining,
      exportLineCount,
      accountAttemptLimit: ACCOUNT_ATTEMPT_LIMIT,
      rowsLength: rows.length
    },
    preflightSummary,
    isPolling
  });
  const prepWorkspaceProps = {
    api: {
      value: apiKey,
      show: showApiKey,
      onChange: handleApiKeyChange,
      onToggleVisible: toggleApiKeyVisible,
      onClear: clearSavedConfig
    },
    account: {
      value: accountText,
      total: accountLineCount,
      available: activeAccountLineCount,
      issueCount: accountInputIssueCount,
      notice: accountNotice,
      statusText: accountInputStatusText,
      onChange: handleAccountTextChange,
      onPaste: handleAccountTextPaste,
      onBlur: cleanupAccountText,
      onUpload: handleAccountFileUpload,
      onExport: exportAccountInput
    },
    summary: {
      ...redeemViewModel.prepSummary,
      apiKeyFilled: Boolean(apiKey.trim()),
    },
    cdk: {
      poolDefinitions: CDK_POOLS,
      pools: cdkeyPools,
      validCount: validCdkCount,
      availableCount: availableCdkCount,
      onChange: updateCdkPool,
      onPaste: handleCdkPoolPaste,
      onUpload: handlePoolFileUpload,
      onOpenImport: openCdkImportDialog
    }
  };
  const executeStatusCards = redeemViewModel.executeStatusCards;
  const requestPanelHelpers = {
    canCancelRow,
    canRecheckSubscriptionRow,
    canResubmitRedeemRow,
    canRetryVisibleRow,
    compactStatus,
    formatAttemptNumber,
    formatFailureReason: formatFailureReasonForApp,
    getRowRedeemProgress: getRowRedeemProgressForApp,
    getSubscriptionTone,
    isHistoricalAutoCycleRow,
    isPlusAccountRow
  };
  const requestPanelActions = {
    cancelRows,
    deletePlusAccounts,
    deleteRows,
    invertSelectedRows,
    recheckPlusRows,
    retryOrResubmitRows,
    selectRowsByFilter,
    setActiveDetailRowId,
    setAllSelected,
    toggleSelected
  };
  const workspaceTabs = redeemViewModel.workspaceTabs.map((tab) => ({
    ...tab,
    icon:
      tab.id === "prep" ? (
        <Upload size={18} />
      ) : tab.id === "execute" ? (
        isBusy ? <Loader2 size={18} className="spin" /> : <Play size={18} />
      ) : (
        <Download size={18} />
      )
  }));
  const activityLogProps = {
    entries: activityLog,
    errors,
    statusMessage,
    lastUpdatedAt
  };

  return (
    <div className="pipeline-shell">
      <div className={`copy-toast ${toastTone} ${toastMessage ? "show" : ""}`} role="status" aria-live="polite">
        {toastTone === "error" ? <XCircle size={16} /> : <CheckSquare size={16} />}
        <span>{toastMessage}</span>
      </div>
      <CdkPoolPickerDialog
        open={poolPickerState.open}
        title={poolPickerState.mode === "continue" ? "继续选择卡密池" : "选择卡密池"}
        message={
          poolPickerState.mode === "continue"
            ? "当前卡密池已完成且账号仍有剩余，请选择下一个卡密池继续兑换。"
            : "多个卡密池都有卡密，请选择本次从哪个池开始兑换。"
        }
        choices={poolPickerState.choices}
        onSelect={submitWithPool}
        onClose={closePoolPicker}
      />
      {showClearConfirm ? (
        <div className="confirm-backdrop" role="presentation" onClick={() => setShowClearConfirm(false)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirm-icon">
              <Trash2 size={18} />
            </div>
            <div>
              <h2 id="clear-confirm-title">确认一键清理？</h2>
              <p>将清空账号、三组卡密、请求记录、日志和当前状态，API Key 会保留。</p>
            </div>
            <div className="confirm-actions">
              <button type="button" className="ghost-button" onClick={() => setShowClearConfirm(false)}>
                取消
              </button>
              <button type="button" className="primary-button danger-confirm" onClick={clearAll}>
                确认清理
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingDeleteRows.length ? (
        <div className="confirm-backdrop" role="presentation" onClick={() => setPendingDeleteRows([])}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-active-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirm-icon">
              <Trash2 size={18} />
            </div>
            <div>
              <h2 id="delete-active-confirm-title">确认删除进行中的请求？</h2>
              <p>
                选中 {pendingDeleteRows.length} 条请求，其中 {pendingDeleteRows.filter(isActiveBackendTaskRow).length} 条仍在后端兑换。
                删除只会清除页面记录和本地账号/卡密，不会取消后端任务；重新导入可能重复消耗卡密。
              </p>
            </div>
            <div className="confirm-actions">
              <button type="button" className="ghost-button" onClick={() => setPendingDeleteRows([])}>
                先不删除
              </button>
              <button
                type="button"
                className="primary-button danger-confirm"
                onClick={() => deleteRows(pendingDeleteRows, { force: true })}
              >
                仍然删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingAccountTextChange ? (
        <div className="confirm-backdrop" role="presentation" onClick={() => setPendingAccountTextChange(null)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-input-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirm-icon">
              <Upload size={18} />
            </div>
            <div>
              <h2 id="account-input-confirm-title">确认从账号输入移除？</h2>
              <p>
                这次编辑会从账号输入框移除 {pendingAccountTextChange.missingActiveRows.length} 个仍在后端兑换的账号。
                这不会取消后端任务，请保留请求状态等待完成，或先去表格里批量取消。
              </p>
            </div>
            <div className="confirm-actions">
              <button type="button" className="ghost-button" onClick={() => setPendingAccountTextChange(null)}>
                保留账号
              </button>
              <button type="button" className="primary-button danger-confirm" onClick={applyPendingAccountTextChange}>
                确认移除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showCdkImportDialog ? (
        <div className="confirm-backdrop" role="presentation" onClick={() => setShowCdkImportDialog(false)}>
          <div
            className="cdk-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cdk-import-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading">
              <div className="confirm-icon import-icon">
                <ClipboardCopy size={18} />
              </div>
              <div>
                <h2 id="cdk-import-title">导入卡密</h2>
                <p>选择卡密池后粘贴卡密，确认后会追加到现有卡密末尾。</p>
              </div>
            </div>
            <div className="import-pool-tabs" role="tablist" aria-label="选择卡密池">
              {CDK_POOLS.map((pool) => (
                <button
                  key={pool.id}
                  type="button"
                  className={importPoolId === pool.id ? "active" : ""}
                  onClick={() => setImportPoolId(pool.id)}
                >
                  {pool.shortLabel}
                </button>
              ))}
            </div>
            <textarea
              value={importCdkText}
              onChange={(event) => setImportCdkText(event.target.value)}
              placeholder="每行一个 CDK"
              spellCheck="false"
              wrap="off"
              autoFocus
            />
            <div className="confirm-actions">
              <span className="dialog-count">{countLines(importCdkText)} 条待导入</span>
              <button type="button" className="ghost-button" onClick={() => setShowCdkImportDialog(false)}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={confirmCdkImport}>
                确认追加
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <header className="pipeline-topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Shield size={20} />
          </div>
          <div>
            <h1>CDK 后端兑换控制台</h1>
            <p>按流程提交、查询、取消、重试任务；成功后导出账号四段格式。</p>
          </div>
        </div>
        <div className="topbar-tools">
          <div className="header-state">
            <span className={isPolling ? "live-dot live" : "live-dot"} />
            {isPolling ? "自动轮询中" : "轮询已停止"}
          </div>
          <div className="poll-chip">轮询间隔 5 秒</div>
        </div>
      </header>

      <div className="pipeline-layout">
        <WorkspaceTabs
          tabs={workspaceTabs}
          activeTab={activeWorkspaceTab}
          onChange={selectWorkspaceTab}
        />

        <main className="pipeline-main">
          <WorkspacePanel id="prep" activeTab={activeWorkspaceTab}>
            <PrepWorkspace {...prepWorkspaceProps} />
            <ActivityLog {...activityLogProps} />
          </WorkspacePanel>

          <WorkspacePanel id="execute" activeTab={activeWorkspaceTab}>
            <section className="execute-workspace">
              <ExecutionControlPanel
                isBusy={isBusy}
                isPolling={isPolling}
                canStartPolling={canStartPolling}
                failedRetryRowCount={failedRetryRows.length}
                cooldownAccountCount={restorableCooldownAccountCount}
                plusAccountRowCount={plusAccountRows.length}
                stats={executeStatusCards}
                onSubmit={() => startRedeemWithPoolDecision()}
                onQuery={queryFromInputOrRows}
                onCancelSelected={() => cancelRows(selectedTargetRows)}
                onRetryFailed={retryFailedRows}
                onRestoreCooldowns={restoreCooldownAccounts}
                onDeletePlus={() => deletePlusAccounts(plusAccountRows)}
                onStartPolling={startPollingFromInputOrRows}
                onStopPolling={stopPolling}
                onClear={() => setShowClearConfirm(true)}
              />

              <RequestStatusPanel
                statusMessage={statusMessage}
                lastUpdatedAt={lastUpdatedAt}
                hiddenHistoryRowCount={hiddenHistoryRowCount}
                visibleRequestRows={visibleRequestRows}
                selectedRows={selectedRows}
                selectedRecheckPlusRows={selectedRecheckPlusRows}
                plusAccountRows={plusAccountRows}
                activeDetailRow={activeDetailRow}
                errors={errors}
                isBusy={isBusy}
                helpers={requestPanelHelpers}
                actions={requestPanelActions}
              />
              <ActivityLog {...activityLogProps} />
            </section>
          </WorkspacePanel>

          <WorkspacePanel id="exports" activeTab={activeWorkspaceTab}>
            <ResultWorkspace
              successExports={successExports}
              canCopyUpiSuccess={canCopyUpiSuccess}
              canCopyIdealSuccess={canCopyIdealSuccess}
              accountStatusText={accountStatusText}
              cdkUsageStats={cdkUsageStats}
              backendRedeemText={backendRedeemText}
              onCopySuccess={copySuccessOutput}
              onDownloadSuccess={downloadSuccessOutput}
            />
            <ActivityLog {...activityLogProps} />
          </WorkspacePanel>

          <footer className="pipeline-footer">
            <span>环境：本地环境</span>
            <span>时区：Asia/Shanghai (UTC+08:00)</span>
            <span>API Key 仅保存到本地浏览器；本地代理不写入日志。</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function getPollableCdkeys(rows) {
  return [
    ...new Set(
      rows
        .filter((row) => row.cdkey && !isTerminalStatus(row.status))
        .map((row) => row.cdkey)
    )
  ];
}
