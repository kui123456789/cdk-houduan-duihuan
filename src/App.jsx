import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ClipboardCopy,
  Download,
  Eye,
  EyeOff,
  FileSearch,
  ListChecks,
  ListX,
  Loader2,
  Play,
  RotateCcw,
  Shield,
  Shuffle,
  Square,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import {
  CDK_POOLS,
  STATUS_META,
  appendImportedText,
  buildContinuationSubmitRows,
  buildQueryRows,
  buildSubmitRows,
  canCancelRow,
  canRetryRow,
  countStatuses,
  createEmptySubscriptionState,
  getPlusExportLine,
  getSubscriptionLabel,
  getSuccessExportsByPool,
  inspectAccountText,
  isTerminalStatus,
  mergeStatusRows,
  normalizeAccountText,
  normalizeSubscriptionError,
  normalizeSubscriptionResult,
  parseCdkeyPools,
  statusLabel
} from "./redeemLogic";

const STORAGE_KEYS = {
  apiKey: "cdkRedeem.apiKey",
  accountText: "cdkRedeem.accountText",
  cdkeyPools: "cdkRedeem.cdkeyPools",
  rows: "cdkRedeem.rows",
  errors: "cdkRedeem.errors",
  accountNotice: "cdkRedeem.accountNotice",
  statusMessage: "cdkRedeem.statusMessage",
  lastUpdatedAt: "cdkRedeem.lastUpdatedAt",
  uiSettings: "cdkRedeem.uiSettings"
};

const SAMPLE_ACCOUNT = "mail@example.com---password---2fa---at---2026-07-03 15:43:17";
const POLL_INTERVAL_MS = 3000;
const DEFAULT_UI_SETTINGS = {
  activeDetailRowId: "",
  pollingEnabled: false,
  showApiKey: false
};

function createEmptyCdkPools() {
  return Object.fromEntries(CDK_POOLS.map((pool) => [pool.id, ""]));
}

function countLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

function loadStored(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function saveStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage can be unavailable in private or locked-down browser contexts.
  }
}

function removeStored(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures; the visible form remains editable.
  }
}

function loadStoredJson(key, fallback) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "null");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
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
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({ ...row, selected: false }));
}

function loadStoredErrors() {
  const errors = loadStoredJson(STORAGE_KEYS.errors, []);
  return Array.isArray(errors) ? errors : [];
}

function loadStoredUiSettings() {
  const settings = loadStoredJson(STORAGE_KEYS.uiSettings, {});
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return DEFAULT_UI_SETTINGS;
  }

  return {
    ...DEFAULT_UI_SETTINGS,
    activeDetailRowId: String(settings.activeDetailRowId || ""),
    pollingEnabled: settings.pollingEnabled === true,
    showApiKey: settings.showApiKey === true
  };
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

function batchCount(count) {
  return Math.ceil(count / 100) || 0;
}

function isAccountTaskRow(row) {
  return Boolean(row?.email || row?.accessToken || row?.exportLine);
}

function isFinalSubscriptionState(row) {
  if (row?.subscriptionStatus === "plus") {
    return Boolean(row.subscriptionTimestamp);
  }
  return ["not_plus", "error", "missing_token"].includes(
    String(row?.subscriptionStatus || "")
  );
}

async function readTextFile(file) {
  return await file.text();
}

export default function App() {
  const [initialUiSettings] = useState(() => loadStoredUiSettings());
  const [accountText, setAccountText] = useState(() => loadStored(STORAGE_KEYS.accountText));
  const [cdkeyPools, setCdkeyPools] = useState(() => loadStoredCdkeyPools());
  const [apiKey, setApiKey] = useState(() => loadStored(STORAGE_KEYS.apiKey));
  const [showApiKey, setShowApiKey] = useState(() => initialUiSettings.showApiKey);
  const [rows, setRows] = useState(() => loadStoredRows());
  const [errors, setErrors] = useState(() => loadStoredErrors());
  const [accountNotice, setAccountNotice] = useState(() => loadStored(STORAGE_KEYS.accountNotice));
  const [isBusy, setIsBusy] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    () => loadStored(STORAGE_KEYS.statusMessage) || "等待输入账号和 CDK"
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => loadStored(STORAGE_KEYS.lastUpdatedAt));
  const [activeDetailRowId, setActiveDetailRowId] = useState(
    () => initialUiSettings.activeDetailRowId
  );
  const pollingTimerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const subscriptionCacheRef = useRef(new Map());
  const rowsRef = useRef(rows);
  const [toastMessage, setToastMessage] = useState("");
  const [toastTone, setToastTone] = useState("success");
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    if (initialUiSettings.pollingEnabled) {
      if (!apiKey.trim()) {
        saveUiSettings({ pollingEnabled: false });
        return () => stopPolling({ persist: false });
      }

      const pollingCdkeys = getPollableCdkeys(rowsRef.current);
      if (pollingCdkeys.length) {
        startPolling(pollingCdkeys);
        setStatusMessage(`已恢复自动轮询：每 3 秒查询 ${pollingCdkeys.length} 个 CDK`);
      } else {
        saveUiSettings({ pollingEnabled: false });
      }
    }

    return () => {
      stopPolling({ persist: false });
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

  useEffect(() => {
    saveUiSettings({ activeDetailRowId });
  }, [activeDetailRowId]);

  useEffect(() => {
    saveUiSettings({ showApiKey });
  }, [showApiKey]);

  const statusCounts = useMemo(() => countStatuses(rows), [rows]);
  const waitingCount =
    (statusCounts.queued || 0) +
    (statusCounts.submitted || 0) +
    (statusCounts.pending_dispatch || 0) +
    (statusCounts.dispatching || 0) +
    (statusCounts.dispatched || 0);
  const runningCount = (statusCounts.running || 0) + (statusCounts.processing || 0);
  const failedCount =
    (statusCounts.failed || 0) +
    (statusCounts.rejected || 0) +
    (statusCounts.invalid || 0) +
    (statusCounts.approve_blocked || 0) +
    (statusCounts.pm_unavailable || 0) +
    (statusCounts.awaiting_payment_expiry || 0);
  const cancelledOrMissingCount =
    (statusCounts.cancelled || 0) + (statusCounts.not_found || 0) + (statusCounts.unused || 0);
  const successExports = useMemo(() => {
    const grouped = getSuccessExportsByPool(rows);
    return {
      upi: grouped.upi.join("\n"),
      ideal: grouped.ideal.join("\n")
    };
  }, [rows]);
  const selectedRows = useMemo(() => rows.filter((row) => row.selected), [rows]);
  const canCopyUpiSuccess = successExports.upi.length > 0;
  const canCopyIdealSuccess = successExports.ideal.length > 0;
  const poolCounts = useMemo(
    () =>
      Object.fromEntries(
        CDK_POOLS.map((pool) => [pool.id, countLines(cdkeyPools[pool.id])])
      ),
    [cdkeyPools]
  );
  const validCdkCount = useMemo(
    () => Object.values(poolCounts).reduce((sum, value) => sum + value, 0),
    [poolCounts]
  );
  const accountValidation = useMemo(() => normalizeAccountText(accountText), [accountText]);
  const cdkeyValidation = useMemo(() => parseCdkeyPools(cdkeyPools), [cdkeyPools]);
  const cdkUsageStats = useMemo(() => {
    const rowsByCdkey = new Map();
    rows.forEach((row) => {
      if (!row.cdkey || rowsByCdkey.has(row.cdkey)) return;
      rowsByCdkey.set(row.cdkey, row);
    });

    const uniqueRows = [...rowsByCdkey.values()];
    const usedRows = uniqueRows.filter((row) => row.status === "success");
    const unusedRows = uniqueRows.filter((row) => row.status === "unused");
    const total = Math.max(cdkeyValidation.cdkeys.length, rowsByCdkey.size);
    const unresolved = Math.max(total - usedRows.length - unusedRows.length, 0);

    return {
      total,
      checked: rowsByCdkey.size,
      usedCount: usedRows.length,
      unusedCount: unusedRows.length,
      unresolvedCount: unresolved,
      usedText: usedRows.map(formatCdkUsageLine).join("\n"),
      unusedText: unusedRows.map(formatCdkUsageLine).join("\n")
    };
  }, [cdkeyValidation.cdkeys.length, rows]);
  const backendRedeemText = useMemo(
    () => rows.map(formatBackendRedeemLine).join("\n"),
    [rows]
  );
  const rawAccountLineCount = useMemo(() => countLines(accountText), [accountText]);
  const accountLineCount = accountValidation.accountCount;
  const accountInputIssueCount = accountValidation.errors.length;
  const currentInputIssueCount = accountValidation.errors.length + cdkeyValidation.errors.length;
  const taskIssueCount = errors.filter(
    (error) => !["account_format", "account_duplicate"].includes(error.type)
  ).length;

  function handleApiKeyChange(value) {
    setApiKey(value);
    saveStored(STORAGE_KEYS.apiKey, value);
  }

  function clearSavedConfig() {
    setApiKey("");
    setShowApiKey(false);
    removeStored("cdkRedeem.baseUrl");
    removeStored(STORAGE_KEYS.apiKey);
    saveUiSettings({ showApiKey: false });
    setStatusMessage("已清除浏览器本地保存的 API Key");
  }

  async function handleAccountFileUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const text = await readTextFile(file);
    const beforeCount = normalizeAccountText(accountText).accountCount;
    const normalized = normalizeAccountText(appendImportedText(accountText, text));
    const addedCount = Math.max(normalized.accountCount - beforeCount, 0);

    setAccountText(normalized.text);
    setErrors(normalized.errors);
    setAccountNotice(
      normalized.invalidCount || normalized.duplicateCount
        ? `上传账号已处理：新增 ${addedCount} 行` +
            (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
            (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
        : ""
    );
    setStatusMessage(
      `已追加账号文件：${file.name}，新增 ${addedCount} 行` +
        (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
        (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
    );
  }

  function handleAccountTextChange(value) {
    const inspected = inspectAccountText(value);
    setAccountText(inspected.text);
    setErrors(inspected.errors);
    if (inspected.errors.length) {
      setAccountNotice(`发现 ${inspected.errors.length} 个账号问题，格式错误行不会进入`);
    } else {
      setAccountNotice("");
    }
    if (inspected.duplicateCount) {
      setStatusMessage(`已自动去重 ${inspected.duplicateCount} 个重复账号`);
    }
  }

  function handleAccountTextPaste(event) {
    const pastedText = event.clipboardData?.getData("text");
    if (!pastedText) return;

    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart ?? accountText.length;
    const end = target.selectionEnd ?? start;
    const nextText = `${accountText.slice(0, start)}${pastedText}${accountText.slice(end)}`;
    const normalized = normalizeAccountText(nextText);

    setAccountText(normalized.text);
    setErrors(normalized.errors);
    setAccountNotice(
      normalized.invalidCount || normalized.duplicateCount
        ? `粘贴账号已处理：保留 ${normalized.accountCount} 个有效账号` +
            (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
            (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
        : ""
    );
    setStatusMessage(
      `已粘贴账号，保留 ${normalized.accountCount} 个有效账号` +
        (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
        (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
    );
  }

  function cleanupAccountText() {
    const normalized = normalizeAccountText(accountText);
    if (normalized.text !== accountText) {
      setAccountText(normalized.text);
      setErrors(normalized.errors);
      setAccountNotice(
        normalized.invalidCount || normalized.duplicateCount
          ? `已清理账号输入：保留 ${normalized.accountCount} 个有效账号` +
              (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
              (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
          : ""
      );
      setStatusMessage(
        `已清理账号输入，保留 ${normalized.accountCount} 个有效账号` +
          (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
          (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
      );
    }
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
    setCdkeyPools((prev) => ({
      ...prev,
      [poolId]: value
    }));
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

  async function callProxy(path, body) {
    validateConfig();
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: apiKey.trim(),
        ...body
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "本地代理请求失败");
    }
    return payload;
  }

  async function callSubscriptionCheck(token) {
    const response = await fetch("/api/subscription/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "订阅检查失败");
    }
    return normalizeSubscriptionResult(payload);
  }

  async function checkPlusSubscriptions(rowList, options = {}) {
    let workingRows = rowList.map((row) => {
      if (row.status !== "success") return row;
      if (!row.accessToken) {
        return isFinalSubscriptionState(row)
          ? row
          : {
              ...row,
              ...createEmptySubscriptionState(),
              subscriptionStatus: "missing_token",
              subscriptionReason: "缺少 at/access_token，无法判断 Plus"
            };
      }

      const cached = subscriptionCacheRef.current.get(row.accessToken);
      if (cached) return { ...row, ...cached };
      return row;
    });

    const tokensToCheck = [
      ...new Set(
        workingRows
          .filter(
            (row) =>
              row.status === "success" &&
              row.accessToken &&
              !subscriptionCacheRef.current.has(row.accessToken) &&
              !isFinalSubscriptionState(row)
          )
          .map((row) => row.accessToken)
      )
    ];

    if (!tokensToCheck.length) {
      setRows(workingRows);
      rowsRef.current = workingRows;
      return workingRows;
    }

    const tokenSet = new Set(tokensToCheck);
    workingRows = workingRows.map((row) =>
      tokenSet.has(row.accessToken)
        ? {
            ...row,
            subscriptionStatus: "checking",
            subscriptionReason: "正在判断 Plus"
          }
        : row
    );
    setRows(workingRows);
    rowsRef.current = workingRows;
    if (!options.silent) {
      setStatusMessage(`正在检查 ${tokensToCheck.length} 个账号的 Plus 状态`);
    }

    const results = new Map();
    for (const token of tokensToCheck) {
      try {
        const result = await callSubscriptionCheck(token);
        results.set(token, result);
        subscriptionCacheRef.current.set(token, result);
      } catch (error) {
        const result = normalizeSubscriptionError(error.message);
        results.set(token, result);
        subscriptionCacheRef.current.set(token, result);
      }
    }

    const checkedRows = workingRows.map((row) =>
      results.has(row.accessToken) ? { ...row, ...results.get(row.accessToken) } : row
    );
    setRows(checkedRows);
    rowsRef.current = checkedRows;
    if (!options.silent) {
      setStatusMessage(`Plus 检查完成：${tokensToCheck.length} 个账号`);
    }
    return checkedRows;
  }

  async function submitRedeems() {
    try {
      stopPolling();
      setIsBusy(true);
      const existingRows = rowsRef.current;
      const hasExistingAccountTasks = existingRows.some(isAccountTaskRow);
      const prepared = hasExistingAccountTasks
        ? buildContinuationSubmitRows(accountText, cdkeyPools, existingRows)
        : buildSubmitRows(accountText, cdkeyPools);
      setErrors(prepared.errors);

      if (!prepared.rows.length) {
        if (!hasExistingAccountTasks) {
          setRows([]);
          setStatusMessage("没有可提交的账号/CDK 配对");
          return;
        }
        setStatusMessage(
          prepared.accountCount > prepared.skippedExistingAccountCount
            ? "没有新的 CDK 可续接提交；补充卡密后可继续兑换剩余账号"
            : "没有新的账号/CDK 可续接提交；已存在的任务不会重复提交"
        );
        return;
      }

      const submittingRows = prepared.rows.map((row) => ({ ...row, status: "submitting" }));
      const baseRows = hasExistingAccountTasks ? [...existingRows, ...submittingRows] : submittingRows;
      setRows(baseRows);
      setStatusMessage(
        `${hasExistingAccountTasks ? "正在续接提交" : "正在提交"} ${submittingRows.length} 条兑换任务，预计 ${batchCount(submittingRows.length)} 批`
      );

      const payload = await callProxy("/api/redeem/submit", {
        items: submittingRows.map((row) => ({
          cdkey: row.cdkey,
          access_token: row.accessToken,
          channel: row.channel
        }))
      });

      const submittedRows = submittingRows.map((row) => ({
        ...row,
        status: "pending_dispatch"
      }));
      const submittedRowsById = new Map(submittedRows.map((row) => [row.id, row]));
      const rowsWithSubmittedStatus = baseRows.map((row) => submittedRowsById.get(row.id) || row);
      const mergedRows = payload.items?.length
        ? mergeStatusRows(rowsWithSubmittedStatus, payload.items)
        : rowsWithSubmittedStatus;
      setRows(mergedRows);
      setLastUpdatedAt(new Date().toLocaleString());
      setStatusMessage("提交完成，开始自动查询兑换状态");
      const refreshedRows = await queryStatuses(submittedRows.map((row) => row.cdkey), {
        silent: true,
        baseRows: mergedRows
      });
      const pollingBaseRows = refreshedRows.length ? refreshedRows : mergedRows;
      const pollingCdkeys = getPollableCdkeys(pollingBaseRows);
      if (pollingCdkeys.length) {
        startPolling(pollingCdkeys);
        setStatusMessage(`提交完成，自动轮询已开启：每 3 秒查询 ${pollingCdkeys.length} 个 CDK`);
      } else {
        stopPolling();
        setStatusMessage("提交完成，当前任务都已是终态，无需继续轮询");
      }
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function queryFromInputOrRows() {
    const activeCdkeys = rows.map((row) => row.cdkey).filter(Boolean);
    if (activeCdkeys.length) {
      await queryStatuses(activeCdkeys, { silent: false });
      return;
    }

    const prepared = buildQueryRows(accountText, cdkeyPools);
    setErrors(prepared.errors);
    if (!prepared.rows.length) {
      setStatusMessage("没有可查询的 CDK");
      return;
    }
    setRows(prepared.rows);
    await queryStatuses(prepared.rows.map((row) => row.cdkey), {
      silent: false,
      baseRows: prepared.rows
    });
  }

  async function startPollingFromInputOrRows() {
    if (isPolling) {
      setStatusMessage("自动轮询已经开启");
      return;
    }

    try {
      validateConfig();
      let baseRows = rowsRef.current;

      if (!baseRows.length) {
        const prepared = buildQueryRows(accountText, cdkeyPools);
        setErrors(prepared.errors);
        if (!prepared.rows.length) {
          setStatusMessage("没有可轮询的 CDK；请先粘贴 CDK 或提交兑换任务");
          return;
        }
        baseRows = prepared.rows;
        setRows(prepared.rows);
      }

      const cdkeys = getPollableCdkeys(baseRows);
      if (!cdkeys.length) {
        setStatusMessage("没有需要继续轮询的任务；当前状态都已结束");
        return;
      }

      setStatusMessage(`正在开启自动轮询：${cdkeys.length} 个 CDK`);
      const updatedRows = await queryStatuses(cdkeys, {
        silent: true,
        baseRows,
        throwOnError: true
      });
      const nextCdkeys = getPollableCdkeys(updatedRows.filter((row) => cdkeys.includes(row.cdkey)));
      if (!nextCdkeys.length) {
        setStatusMessage("查询完成，当前任务都已是终态，无需继续轮询");
        return;
      }

      startPolling(nextCdkeys);
      setStatusMessage(`自动轮询已开启：每 3 秒查询 ${nextCdkeys.length} 个 CDK`);
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function queryStatuses(cdkeys, options = {}) {
    const cleanCdkeys = [...new Set(cdkeys.map((item) => String(item || "").trim()).filter(Boolean))];
    if (!cleanCdkeys.length) {
      setStatusMessage("没有可查询的 CDK");
      return [];
    }

    if (!options.silent) {
      setIsBusy(true);
      setStatusMessage(`正在查询 ${cleanCdkeys.length} 个 CDK 状态`);
    }

    try {
      const payload = await callProxy("/api/redeem/status", { cdkeys: cleanCdkeys });
      const baseRows = options.baseRows || rowsRef.current;
      let updated = mergeStatusRows(baseRows, payload.items || []);
      setRows(updated);
      setLastUpdatedAt(new Date().toLocaleString());
      if (!options.silent) {
        setStatusMessage(`查询完成：${cleanCdkeys.length} 个 CDK，${payload.batchCount || 1} 批`);
      }

      updated = await checkPlusSubscriptions(updated, { silent: options.silent });

      const targetRows = updated.filter((row) => cleanCdkeys.includes(row.cdkey));
      if (targetRows.length && targetRows.every((row) => isTerminalStatus(row.status))) {
        stopPolling();
      }
      return updated;
    } catch (error) {
      setStatusMessage(error.message);
      if (options.throwOnError) throw error;
      return rowsRef.current;
    } finally {
      if (!options.silent) setIsBusy(false);
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
      doneMessage: "取消请求已发送，正在刷新状态"
    });
  }

  async function retryRows(targetRows) {
    const retryable = targetRows.filter(canRetryRow);
    if (!retryable.length) {
      setStatusMessage("没有可重试的选中任务；需要 can_retry、can_reuse_token、has_access_token 都为 true");
      return;
    }

    await runJobAction({
      path: "/api/redeem/retry",
      rowsToAct: retryable,
      pendingMessage: "正在重试任务",
      doneMessage: "重试请求已发送，继续轮询状态",
      afterActionStatus: "pending_dispatch",
      shouldPoll: true
    });
  }

  async function runJobAction({
    path,
    rowsToAct,
    pendingMessage,
    doneMessage,
    afterActionStatus,
    shouldPoll = false
  }) {
    try {
      setIsBusy(true);
      const cdkeys = rowsToAct.map((row) => row.cdkey);
      setStatusMessage(`${pendingMessage}：${cdkeys.length} 条`);
      await callProxy(path, { cdkeys });
      if (afterActionStatus) {
        setRows((prev) =>
          prev.map((row) =>
            cdkeys.includes(row.cdkey)
              ? {
                  ...row,
                  ...createEmptySubscriptionState(),
                  status: afterActionStatus,
                  selected: false
                }
              : row
          )
        );
      }
      setStatusMessage(doneMessage);
      const updatedRows = await queryStatuses(cdkeys, { silent: true });
      if (shouldPoll) {
        startPolling(cdkeys);
      } else if (updatedRows.length) {
        setLastUpdatedAt(new Date().toLocaleString());
      }
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  function startPolling(cdkeys) {
    const cleanCdkeys = [...new Set(cdkeys.map((item) => String(item || "").trim()).filter(Boolean))];
    if (!cleanCdkeys.length) return;
    stopPolling({ persist: false });
    setIsPolling(true);
    saveUiSettings({ pollingEnabled: true });
    pollingTimerRef.current = window.setInterval(() => {
      queryStatuses(cleanCdkeys, { silent: true });
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(options = {}) {
    const { persist = true } = options;
    if (pollingTimerRef.current) {
      window.clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    setIsPolling(false);
    if (persist) {
      saveUiSettings({ pollingEnabled: false });
    }
  }

  function clearAll() {
    stopPolling();
    setShowClearConfirm(false);
    setAccountText("");
    setCdkeyPools(createEmptyCdkPools());
    setRows([]);
    setErrors([]);
    setAccountNotice("");
    setShowApiKey(false);
    setActiveDetailRowId("");
    subscriptionCacheRef.current.clear();
    removeStored(STORAGE_KEYS.accountText);
    removeStored(STORAGE_KEYS.cdkeyPools);
    removeStored(STORAGE_KEYS.rows);
    removeStored(STORAGE_KEYS.errors);
    removeStored(STORAGE_KEYS.accountNotice);
    removeStored(STORAGE_KEYS.statusMessage);
    removeStored(STORAGE_KEYS.lastUpdatedAt);
    removeStored(STORAGE_KEYS.uiSettings);
    setStatusMessage("已清空输入和结果");
    showToast("已清空输入和结果");
    setLastUpdatedAt("");
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

  function downloadSuccessOutput(type) {
    const output = successExports[type] || "";
    const label = type === "upi" ? "UPI" : "IDEAL";
    if (!output) {
      setStatusMessage(`没有 ${label} 成功结果可下载`);
      return;
    }
    const message = `${label} 成功结果已下载`;
    setStatusMessage(message);
    showToast(message);
  }

  function toggleSelected(rowId) {
    setRows((prev) =>
      prev.map((row) => (row.id === rowId ? { ...row, selected: !row.selected } : row))
    );
  }

  function setAllSelected(checked) {
    const count = checked ? rows.length : 0;
    setRows((prev) => prev.map((row) => ({ ...row, selected: checked })));
    setStatusMessage(checked ? `已全选 ${count} 条请求` : "已清空选择");
  }

  function selectRowsByFilter(predicate, label) {
    const count = rows.filter(predicate).length;
    setRows((prev) => prev.map((row) => ({ ...row, selected: predicate(row) })));
    setStatusMessage(`已选择${label}：${count} 条`);
  }

  function invertSelectedRows() {
    const nextCount = rows.filter((row) => !row.selected).length;
    setRows((prev) => prev.map((row) => ({ ...row, selected: !row.selected })));
    setStatusMessage(`已反选，当前选中 ${nextCount} 条`);
  }

  const selectedTargetRows = selectedRows.length ? selectedRows : [];
  const pollableRowsCount = getPollableCdkeys(rows).length;
  const canStartPolling = pollableRowsCount > 0 || (!rows.length && validCdkCount > 0);
  const activeDetailRow =
    rows.find((row) => row.id === activeDetailRowId) || selectedRows[0] || rows[0] || null;
  const currentStep = rows.length
    ? 3
    : accountLineCount || validCdkCount
      ? 2
      : apiKey.trim()
        ? 1
        : 0;
  const stepItems = [
    { number: 1, title: "API Key", subtitle: "配置", icon: <Shield size={16} /> },
    { number: 2, title: "输入", subtitle: "账号 & CDK", icon: <Upload size={16} /> },
    { number: 3, title: "执行", subtitle: "兑换任务", icon: <Play size={16} /> },
    { number: 4, title: "复核导出", subtitle: "结果处理", icon: <Download size={16} /> }
  ];

  return (
    <div className="pipeline-shell">
      <div className={`copy-toast ${toastTone} ${toastMessage ? "show" : ""}`} role="status" aria-live="polite">
        {toastTone === "error" ? <XCircle size={16} /> : <CheckSquare size={16} />}
        <span>{toastMessage}</span>
      </div>
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
              <p>将清空账号、三组卡密、请求记录、错误行和当前状态，API Key 会保留。</p>
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
          <div className="poll-chip">轮询间隔 3 秒</div>
        </div>
      </header>

      <div className="pipeline-layout">
        <aside className="step-rail" aria-label="流程步骤">
          {stepItems.map((step, index) => (
            <div
              className={`step-item ${currentStep + 1 >= step.number ? "active" : ""}`}
              key={step.number}
            >
              <div className="step-circle">
                <span>{step.number}</span>
                {step.icon}
              </div>
              <strong>{step.title}</strong>
              <small>{step.subtitle}</small>
              {index < stepItems.length - 1 ? <div className="step-line" /> : null}
            </div>
          ))}
        </aside>

        <main className="pipeline-main">
          <section className="prep-grid">
            <section className="api-card" aria-label="API Key 配置">
              <PanelHeader
                icon={<Shield size={17} />}
                title="外部 API Key"
                subtitle="仅保存在本地浏览器，用于本机代理转发"
              />
              <label className="field-stack">
                <span>API Key</span>
                <div className="secret-input">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => handleApiKeyChange(event.target.value)}
                    placeholder="ext_redeem_..."
                    spellCheck="false"
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() => setShowApiKey((value) => !value)}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
              <button type="button" className="wide-ghost-button" onClick={clearSavedConfig}>
                <Trash2 size={16} />
                清除本地保存
              </button>
            </section>

            <InputPanel
              title="账号输入"
              subtitle="格式：邮箱---密码---2fa---at---时间戳"
              count={`${accountLineCount} 行`}
              icon={<Upload size={17} />}
              upload={
                <UploadButton
                  label="上传账号 .txt"
                  onChange={handleAccountFileUpload}
                />
              }
            >
              <textarea
                value={accountText}
                onChange={(event) => handleAccountTextChange(event.target.value)}
                onPaste={handleAccountTextPaste}
                onBlur={cleanupAccountText}
                placeholder={SAMPLE_ACCOUNT}
                spellCheck="false"
                wrap="off"
              />
              <div className={accountInputIssueCount || accountNotice ? "input-validity warning" : "input-validity"}>
                {accountNotice
                  ? accountNotice
                  : accountInputIssueCount
                    ? `发现 ${accountInputIssueCount} 个账号问题，格式错误行不会进入`
                  : accountLineCount
                    ? `${accountLineCount} 个有效账号${rawAccountLineCount > accountLineCount ? `，${rawAccountLineCount - accountLineCount} 行需检查` : ""}`
                    : "等待账号输入"}
              </div>
            </InputPanel>

            <section className="prep-summary" aria-label="准备状态">
              <PanelHeader
                icon={<FileSearch size={17} />}
                title="准备状态"
                subtitle={apiKey.trim() ? "API Key 已填写" : "等待 API Key"}
              />
              <div className="prep-summary-grid">
                <div className="prep-summary-item">
                  <span>账号</span>
                  <strong>{accountLineCount}</strong>
                </div>
                <div className="prep-summary-item">
                  <span>CDK</span>
                  <strong>{validCdkCount}</strong>
                </div>
                <div className="prep-summary-item">
                  <span>当前错误</span>
                  <strong>{currentInputIssueCount}</strong>
                </div>
                <div className="prep-summary-item">
                  <span>批次</span>
                  <strong>{batchCount(Math.max(accountLineCount, validCdkCount))}</strong>
                </div>
              </div>
              <div className={isPolling ? "prep-summary-note active" : "prep-summary-note"}>
                {isPolling ? "自动轮询中" : rows.length ? "已有请求记录" : "等待开始兑换或查询"}
              </div>
            </section>

            <section className="cdk-pool-board">
              <div className="section-heading">
                <PanelHeader
                  icon={<ClipboardCopy size={17} />}
                  title="三渠道卡密池"
                  subtitle="VIP、IDEAL、UPI 分池录入；提交时按池子顺序配对账号"
                />
              </div>
              <div className="pool-grid">
                {CDK_POOLS.map((pool) => (
                  <CdkPoolCard
                    key={pool.id}
                    pool={pool}
                    value={cdkeyPools[pool.id] || ""}
                    onChange={(value) => updateCdkPool(pool.id, value)}
                    onPaste={(event) => handleCdkPoolPaste(event, pool.id)}
                    onUpload={(event) => handlePoolFileUpload(event, pool.id)}
                  />
                ))}
              </div>
              <div className="input-validity">
                {validCdkCount ? "已检测到 CDK 输入" : "等待 VIP / IDEAL / UPI 卡密输入"}
              </div>
            </section>
          </section>

          <section className="execute-band" aria-label="执行">
            <div className="command-cluster">
              <button className="primary-button" onClick={submitRedeems} disabled={isBusy}>
                {isBusy ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                开始兑换
              </button>
              <button className="secondary-button" onClick={queryFromInputOrRows} disabled={isBusy}>
                <FileSearch size={16} />
                查询状态
              </button>
              <button className="secondary-button" onClick={() => cancelRows(selectedTargetRows)} disabled={isBusy}>
                <XCircle size={16} />
                批量取消
              </button>
              <button className="secondary-button" onClick={() => retryRows(selectedTargetRows)} disabled={isBusy}>
                <RotateCcw size={16} />
                批量重试
              </button>
              <button
                className="secondary-button poll-action"
                onClick={startPollingFromInputOrRows}
                disabled={isBusy || isPolling || !canStartPolling}
              >
                <Loader2 size={15} />
                开启轮询
              </button>
              <button className="secondary-button danger-action" onClick={stopPolling} disabled={!isPolling}>
                <Square size={15} />
                停止轮询
              </button>
              <button
                className="secondary-button danger-action"
                onClick={() => setShowClearConfirm(true)}
                disabled={isBusy}
              >
                <Trash2 size={15} />
                一键清理
              </button>
            </div>
            <div className="status-strip" aria-live="polite">
              <StatusCard label="总任务" value={statusCounts.total} />
              <StatusCard label="卡密总数" value={cdkUsageStats.total} />
              <StatusCard label="等待" value={waitingCount} />
              <StatusCard label="兑换中" value={runningCount} tone="info" />
              <StatusCard label="已使用" value={cdkUsageStats.usedCount} tone="success" />
              <StatusCard label="未使用" value={cdkUsageStats.unusedCount} tone="warning" />
              <StatusCard label="失败" value={failedCount} tone="danger" />
              <StatusCard label="超时" value={statusCounts.timeout || 0} tone="warning" />
              <StatusCard label="跳过" value={taskIssueCount} tone={taskIssueCount ? "warning" : ""} />
            </div>
          </section>

          <section className="review-grid">
            <div className="request-panel">
              <div className="section-heading">
                <div>
                  <h2>请求状态</h2>
                  <p>{statusMessage}{lastUpdatedAt ? ` · 更新时间 ${lastUpdatedAt}` : ""}</p>
                </div>
                <span className="selection-count">已选 {selectedRows.length} / {rows.length}</span>
              </div>

              <div className="selection-toolbar" aria-label="批量选择">
                <button type="button" onClick={() => setAllSelected(true)} disabled={!rows.length}>
                  <CheckSquare size={14} />
                  全选
                </button>
                <button type="button" onClick={() => setAllSelected(false)} disabled={!selectedRows.length}>
                  <ListX size={14} />
                  清空
                </button>
                <button type="button" onClick={invertSelectedRows} disabled={!rows.length}>
                  <Shuffle size={14} />
                  反选
                </button>
                <button
                  type="button"
                  onClick={() => selectRowsByFilter(canCancelRow, "可取消")}
                  disabled={!rows.length}
                >
                  <XCircle size={14} />
                  可取消
                </button>
                <button
                  type="button"
                  onClick={() => selectRowsByFilter(canRetryRow, "可重试")}
                  disabled={!rows.length}
                >
                  <RotateCcw size={14} />
                  可重试
                </button>
                <button
                  type="button"
                  onClick={() => selectRowsByFilter((row) => row.status === "success", "已使用")}
                  disabled={!rows.length}
                >
                  <ListChecks size={14} />
                  已使用
                </button>
                <button
                  type="button"
                  onClick={() => selectRowsByFilter((row) => row.status === "unused", "未使用")}
                  disabled={!rows.length}
                >
                  <FileSearch size={14} />
                  未使用
                </button>
              </div>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label="全选请求"
                          checked={rows.length > 0 && rows.every((row) => row.selected)}
                          onChange={(event) => setAllSelected(event.target.checked)}
                          disabled={!rows.length}
                        />
                      </th>
                      <th>序号</th>
                      <th>邮箱</th>
                      <th>CDK</th>
                      <th>渠道</th>
                      <th>状态</th>
                      <th>中文状态</th>
                      <th>Plus 判断</th>
                      <th>订阅原因</th>
                      <th>失败原因</th>
                      <th>可取消</th>
                      <th>可重试</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length ? (
                      rows.map((row) => (
                        <StatusRow
                          key={row.id}
                          row={row}
                          onSelect={() => toggleSelected(row.id)}
                          onViewDetail={() => setActiveDetailRowId(row.id)}
                          onCancel={() => cancelRows([row])}
                          onRetry={() => retryRows([row])}
                          active={activeDetailRow?.id === row.id}
                          busy={isBusy}
                        />
                      ))
                    ) : (
                      <tr>
                        <td colSpan="13" className="empty-cell">
                          还没有请求记录。可先往任一卡密池粘贴 CDK 点击“查询状态”，或配对账号后点击“开始兑换”。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <DetailPanel row={activeDetailRow} />
            </div>

            <aside className="review-side">
              <SuccessExportCard
                title="UPI 成功导出"
                subtitle="仅 success + Plus + UPI 卡密池"
                value={successExports.upi}
                downloadFileName="upi_success_accounts.txt"
                disabled={!canCopyUpiSuccess}
                onCopy={() => copySuccessOutput("upi")}
                onDownload={() => downloadSuccessOutput("upi")}
              />

              <SuccessExportCard
                title="IDEAL 成功导出"
                subtitle="仅 success + Plus；IDEAL 和 VIP 都进入此池"
                value={successExports.ideal}
                downloadFileName="ideal_success_accounts.txt"
                disabled={!canCopyIdealSuccess}
                onCopy={() => copySuccessOutput("ideal")}
                onDownload={() => downloadSuccessOutput("ideal")}
              />

              <CdkUsageCard stats={cdkUsageStats} />

              <BackendRedeemCard value={backendRedeemText} />

              <div className="output-card">
                <div className="section-heading compact">
                  <div>
                    <h2>错误行</h2>
                    <p>格式错误、重复账号/CDK、未配对数据</p>
                  </div>
                  <span className="error-count">{errors.length}</span>
                </div>
                <div className="error-list">
                  {errors.length ? (
                    errors.map((error, index) => (
                      <div className="error-item" key={`${error.lineNumber}-${index}`}>
                        <strong>第 {error.lineNumber} 行</strong>
                        <span>{error.reason}</span>
                        <code>{error.source}</code>
                      </div>
                    ))
                  ) : (
                    <p className="muted">暂无错误行</p>
                  )}
                </div>
              </div>
            </aside>
          </section>

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

function PanelHeader({ icon, title, subtitle }) {
  return (
    <div className="panel-header">
      <div className="panel-icon">{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function InputPanel({ title, subtitle, count, icon, upload, children }) {
  return (
    <section className="input-panel">
      <div className="section-heading">
        <PanelHeader icon={icon} title={title} subtitle={subtitle} />
        <div className="panel-actions">
          <span className="count-badge">{count}</span>
          {upload}
        </div>
      </div>
      {children}
    </section>
  );
}

function CdkPoolCard({ pool, value, onChange, onPaste, onUpload }) {
  return (
    <section className={`pool-card ${pool.id}`}>
      <div className="pool-card-header">
        <div>
          <span className="pool-kicker">{pool.shortLabel}</span>
          <h3>{pool.label}</h3>
          <p>{pool.description}</p>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={onPaste}
        placeholder={pool.placeholder}
        spellCheck="false"
        wrap="off"
      />
      <UploadButton label={`上传 ${pool.shortLabel} .txt`} onChange={onUpload} />
    </section>
  );
}

function UploadButton({ label, onChange }) {
  return (
    <label className="upload-button">
      <Upload size={15} />
      {label}
      <input type="file" accept=".txt,text/plain" onChange={onChange} />
    </label>
  );
}

function SuccessExportCard({ title, subtitle, value, downloadFileName, disabled, onCopy, onDownload }) {
  const [downloadUrl, setDownloadUrl] = useState("");

  useEffect(() => {
    if (!value) {
      setDownloadUrl("");
      return undefined;
    }

    const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  return (
    <div className="output-card">
      <div className="section-heading compact">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="inline-actions">
          <button className="ghost-button" onClick={onCopy} disabled={disabled}>
            <ClipboardCopy size={16} />
            复制结果
          </button>
          <a
            className={`primary-button small download-link ${disabled ? "disabled" : ""}`}
            href={disabled ? undefined : downloadUrl}
            download={downloadFileName}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
            onClick={(event) => {
              if (disabled || !downloadUrl) {
                event.preventDefault();
                return;
              }
              window.setTimeout(onDownload, 0);
            }}
          >
            <Download size={16} />
            下载结果
          </a>
        </div>
      </div>
      <textarea
        value={value}
        readOnly
        placeholder="邮箱---密码---2fa---时间戳"
        wrap="off"
      />
    </div>
  );
}

function CdkUsageCard({ stats }) {
  return (
    <div className="output-card cdk-usage-card">
      <div className="section-heading compact">
        <div>
          <h2>卡密使用明细</h2>
          <p>
            总数 {stats.total} · 已查询 {stats.checked} · 待确认 {stats.unresolvedCount}
          </p>
        </div>
      </div>
      <div className="usage-stat-grid">
        <div className="usage-stat">
          <span>已使用</span>
          <strong>{stats.usedCount}</strong>
        </div>
        <div className="usage-stat">
          <span>未使用</span>
          <strong>{stats.unusedCount}</strong>
        </div>
        <div className="usage-stat">
          <span>待确认</span>
          <strong>{stats.unresolvedCount}</strong>
        </div>
      </div>
      <div className="usage-list-grid">
        <label>
          <span>已使用卡密</span>
          <textarea
            value={stats.usedText}
            readOnly
            placeholder="查询状态后显示已使用卡密"
            wrap="off"
          />
        </label>
        <label>
          <span>未使用卡密</span>
          <textarea
            value={stats.unusedText}
            readOnly
            placeholder="查询状态后显示未使用卡密"
            wrap="off"
          />
        </label>
      </div>
    </div>
  );
}

function BackendRedeemCard({ value }) {
  return (
    <div className="output-card backend-card">
      <div className="section-heading compact">
        <div>
          <h2>后台兑换情况</h2>
          <p>后台状态、原因、可取消、可重试、token 标记</p>
        </div>
      </div>
      <textarea
        value={value}
        readOnly
        placeholder="查询状态后显示后台兑换情况"
        wrap="off"
      />
    </div>
  );
}

function StatusCard({ label, value, tone = "" }) {
  return (
    <div className={`status-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function compactStatus(status) {
  const normalized = String(status || "").trim();
  const labels = {
    local_ready: "待提交",
    submitting: "提交中",
    querying: "查询中",
    queued: "排队",
    submitted: "已提交",
    pending_dispatch: "待兑换",
    dispatching: "派发中",
    dispatched: "已派发",
    running: "兑换中",
    processing: "兑换中",
    success: "已使用",
    failed: "失败",
    timeout: "超时",
    cancelled: "已取消",
    rejected: "拒绝",
    invalid: "无效",
    approve_blocked: "审批阻塞",
    pm_unavailable: "支付不可用",
    awaiting_payment_expiry: "等支付过期",
    unused: "未使用",
    not_found: "未找到",
    unknown: "未知"
  };
  return labels[normalized] || statusLabel(normalized);
}

function formatCdkUsageLine(row) {
  const channel = row.channelLabel || row.channel || "";
  const status = statusLabel(row.status);
  const normalizedReason = String(row.reason || "").trim();
  const reason =
    normalizedReason &&
    normalizedReason !== row.status &&
    normalizedReason !== status
      ? ` · ${normalizedReason}`
      : "";
  return `${row.cdkey}${channel ? ` · ${channel}` : ""} · ${status}${reason}`;
}

function formatBackendRedeemLine(row) {
  const channel = row.channelLabel || row.channel || "-";
  const reason = row.reason ? ` · 原因：${row.reason}` : "";
  const cancelFlag = canCancelRow(row) ? "可取消" : "不可取消";
  const retryFlag = row.can_retry ? "可重试" : "不可重试";
  const tokenFlag = row.has_access_token ? "有token" : "无token";
  return `${row.cdkey} · ${channel} · ${compactStatus(row.status)}${reason} · ${cancelFlag} · ${retryFlag} · ${tokenFlag}`;
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

function DetailPanel({ row }) {
  if (!row) {
    return (
      <div className="detail-panel empty-detail">
        <span>选中项详情</span>
        <p>选择一条请求后，这里会显示邮箱、CDK、状态和处理信息。</p>
      </div>
    );
  }

  return (
    <div className="detail-panel">
      <div className="section-heading compact">
        <div>
          <h3>选中项详情</h3>
          <p>{row.email || "仅查询 CDK"}</p>
        </div>
        <span
          className={`status-pill compact-status ${(STATUS_META[row.status] || STATUS_META.unknown).tone}`}
          title={row.status}
        >
          {compactStatus(row.status)}
        </span>
      </div>
      <div className="detail-grid">
        <DetailItem label="邮箱" value={row.email || "-"} />
        <DetailItem label="CDK" value={row.cdkey} />
        <DetailItem label="渠道" value={row.channelLabel || row.channel || "-"} />
        <DetailItem label="中文状态" value={statusLabel(row.status)} />
        <DetailItem label="Plus 判断" value={getSubscriptionLabel(row)} />
        <DetailItem label="套餐" value={row.subscriptionPlanType || row.subscriptionPlan || "-"} />
        <DetailItem label="活跃订阅" value={formatActiveSubscription(row.hasActiveSubscription)} />
        <DetailItem label="失败原因" value={row.reason || "-"} />
        <DetailItem label="订阅原因" value={row.subscriptionReason || "-"} wide />
        <DetailItem label="原时间戳" value={row.timestamp || "-"} />
        <DetailItem label="Plus 时间" value={row.subscriptionTimestamp || "-"} />
        <DetailItem label="导出内容" value={getPlusExportLine(row) || "-"} wide />
      </div>
      <div className="raw-status-block">
        <span>后台原始返回</span>
        <pre>{formatRawStatus(row.rawStatus)}</pre>
      </div>
    </div>
  );
}

function formatRawStatus(rawStatus) {
  if (!rawStatus) return "暂无后台原始返回；点击查询状态后更新。";

  try {
    return JSON.stringify(rawStatus, null, 2);
  } catch {
    return String(rawStatus);
  }
}

function DetailItem({ label, value, wide = false }) {
  return (
    <div className={wide ? "detail-item wide" : "detail-item"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatActiveSubscription(value) {
  if (value === true) return "是";
  if (value === false) return "否";
  return "-";
}

function getSubscriptionTone(row) {
  switch (row.subscriptionStatus) {
    case "checking":
      return "info";
    case "plus":
      return "success";
    case "plus_missing_time":
      return "warning";
    case "not_plus":
    case "missing_token":
      return "warning";
    case "error":
      return "danger";
    default:
      return row.status === "success" ? "pending" : "";
  }
}

function StatusRow({ row, onSelect, onViewDetail, onCancel, onRetry, active, busy }) {
  const meta = STATUS_META[row.status] || STATUS_META.unknown;
  const canCancel = canCancelRow(row);
  const canRetry = canRetryRow(row);

  return (
    <tr className={active ? "active-row" : ""}>
      <td>
        <input type="checkbox" checked={row.selected} onChange={onSelect} />
      </td>
      <td>{row.accountLineNumber || row.cdkeyLineNumber}</td>
      <td className="mono muted-cell">
        <button type="button" className="account-link" onClick={onViewDetail}>
          {row.email || "仅查询 CDK"}
        </button>
      </td>
      <td className="mono">{row.cdkey}</td>
      <td>
        <span className={`channel-pill ${row.channel || "default"}`}>
          {row.channelLabel || row.channel || "-"}
        </span>
      </td>
      <td>
        <span className={`status-pill compact-status ${meta.tone}`} title={row.status}>
          {compactStatus(row.status)}
        </span>
      </td>
      <td className="nowrap-cell">{statusLabel(row.status)}</td>
      <td>
        <span className={`status-pill ${getSubscriptionTone(row)}`}>
          {getSubscriptionLabel(row)}
        </span>
      </td>
      <td className="reason-cell subscription-reason-cell">{row.subscriptionReason || "-"}</td>
      <td className="reason-cell">{row.reason || "-"}</td>
      <td>{canCancel ? "是" : "否"}</td>
      <td>{canRetry ? "是" : "否"}</td>
      <td>
        <div className="row-actions">
          <button type="button" onClick={onCancel} disabled={busy || !canCancel} title="取消任务">
            取消
          </button>
          <button type="button" onClick={onRetry} disabled={busy || !canRetry} title="重试任务">
            重试
          </button>
        </div>
      </td>
    </tr>
  );
}
