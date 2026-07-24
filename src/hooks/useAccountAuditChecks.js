import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildAccountAuditRows,
  createAccountAuditRow,
  filterAccountAuditRows,
  getAccountAuditCounts,
  getAccountAuditExportRows,
  getAccountAuditRowKey,
  getAccountAuditStatus
} from "../domain/accountAudit.js";
import { normalizeEmailVerificationResult, createEmptyEmailVerificationState } from "../domain/emailVerification.js";
import { normalizeSubscriptionError, normalizeSubscriptionResult, createEmptySubscriptionState } from "../domain/subscriptionDiagnostics.js";
import { readStored, readStoredJson, writeStored } from "../storage/redeemStorage.js";
import { STORAGE_KEYS } from "../config/redeemConstants.js";

export const ACCOUNT_AUDIT_STORAGE_KEYS = {
  input: STORAGE_KEYS.accountAuditText,
  rows: STORAGE_KEYS.accountAuditRows
};

// Keep a small bounded pool so large imports do not wait on accounts serially
// or overwhelm the subscription proxy.
const SUBSCRIPTION_CHECK_CONCURRENCY = 5;

function loadStoredValue(key) {
  if (typeof window === "undefined") return "";
  return readStored(window.localStorage, key);
}

function loadStoredRows(inputText) {
  if (typeof window !== "undefined") {
    const stored = readStoredJson(window.localStorage, ACCOUNT_AUDIT_STORAGE_KEYS.rows, null);
    if (Array.isArray(stored)) return stored;
  }
  return buildAccountAuditRows(inputText).rows;
}

function pickPreviousState(row) {
  return {
    subscriptionStatus: row.subscriptionStatus,
    subscriptionCategory: row.subscriptionCategory,
    subscriptionTitle: row.subscriptionTitle,
    subscriptionPlanType: row.subscriptionPlanType,
    subscriptionPlan: row.subscriptionPlan,
    subscriptionTimestamp: row.subscriptionTimestamp,
    hasActiveSubscription: row.hasActiveSubscription,
    subscriptionReason: row.subscriptionReason,
    subscriptionRetryable: row.subscriptionRetryable,
    subscriptionHttpStatus: row.subscriptionHttpStatus,
    subscriptionRemoteMessage: row.subscriptionRemoteMessage,
    subscriptionCheckedAt: row.subscriptionCheckedAt,
    isPlus: row.isPlus,
    emailVerificationStatus: row.emailVerificationStatus,
    emailVerificationCategory: row.emailVerificationCategory,
    emailVerificationTitle: row.emailVerificationTitle,
    emailVerificationReason: row.emailVerificationReason,
    emailVerificationRetryable: row.emailVerificationRetryable,
    emailVerificationHttpStatus: row.emailVerificationHttpStatus,
    emailVerificationCheckedAt: row.emailVerificationCheckedAt,
    emailVerificationOrderNumber: row.emailVerificationOrderNumber,
    emailVerificationOrderDate: row.emailVerificationOrderDate,
    emailVerificationMatchedPhrase: row.emailVerificationMatchedPhrase,
    emailPlusVerified: row.emailPlusVerified,
    emailBanned: row.emailBanned
  };
}

export function useAccountAuditChecks({ getRedeemApi, onNotice } = {}) {
  const [inputText, setInputText] = useState(() => loadStoredValue(ACCOUNT_AUDIT_STORAGE_KEYS.input));
  const [rows, setRows] = useState(() => loadStoredRows(loadStoredValue(ACCOUNT_AUDIT_STORAGE_KEYS.input)));
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const rowsRef = useRef(rows);
  const cancelledRef = useRef(false);

  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => () => { cancelledRef.current = true; }, []);
  useEffect(() => {
    if (typeof window !== "undefined") writeStored(window.localStorage, ACCOUNT_AUDIT_STORAGE_KEYS.input, inputText);
  }, [inputText]);
  useEffect(() => {
    if (typeof window !== "undefined") writeStored(window.localStorage, ACCOUNT_AUDIT_STORAGE_KEYS.rows, JSON.stringify(rows));
  }, [rows]);

  const parsed = useMemo(() => buildAccountAuditRows(inputText), [inputText]);
  const visibleRows = useMemo(() => filterAccountAuditRows(rows, filter), [rows, filter]);
  const counts = useMemo(() => getAccountAuditCounts(rows), [rows]);

  function commitRows(nextRows) {
    rowsRef.current = nextRows;
    setRows(nextRows);
  }

  function setMessage(message) {
    const text = String(message || "");
    setNotice(text);
    onNotice?.(text);
  }

  function importAccounts(nextText = inputText) {
    const validation = buildAccountAuditRows(nextText);
    const previous = new Map(rowsRef.current.map((row) => [getAccountAuditRowKey(row), row]));
    const nextRows = validation.rows.map((row) => {
      const previousRow = previous.get(getAccountAuditRowKey(row));
      return previousRow ? { ...row, ...pickPreviousState(previousRow) } : row;
    });
    setInputText(String(nextText || ""));
    commitRows(nextRows);
    setMessage(`已载入 ${nextRows.length} 个账号${validation.duplicateCount ? `，去重 ${validation.duplicateCount} 个` : ""}`);
    return validation;
  }

  function updateRow(id, updater) {
    const next = rowsRef.current.map((row) => row.id === id ? updater(row) : row);
    commitRows(next);
    return next.find((row) => row.id === id);
  }

  function targetRows(ids) {
    const selected = ids?.length ? new Set(ids) : new Set(visibleRows.map((row) => row.id));
    return rowsRef.current.filter((row) => selected.has(row.id));
  }

  async function checkSubscriptions(ids) {
    const targets = targetRows(ids);
    if (!targets.length) { setMessage("没有可检查的账号"); return; }
    const api = getRedeemApi?.();
    if (!api?.checkSubscription) { setMessage("订阅检查接口不可用"); return; }
    // React StrictMode can run an effect cleanup during development; a later
    // user-triggered check must start with a live cancellation flag.
    cancelledRef.current = false;
    setBusy("subscription");
    setMessage(`正在检查订阅状态：0/${targets.length}`);
    try {
      let nextIndex = 0;
      let completed = 0;
      const worker = async () => {
        while (!cancelledRef.current) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= targets.length) return;
          const row = targets[index];
          updateRow(row.id, (current) => ({ ...current, ...createEmptySubscriptionState(), subscriptionStatus: "checking", subscriptionTitle: "检查中" }));
          let result;
          if (!row.accessToken) {
            result = normalizeSubscriptionError("缺少 at/access_token，无法判断 Plus", { category: "missing_token", title: "缺少 at", retryable: false });
          } else {
            try { result = normalizeSubscriptionResult(await api.checkSubscription(row.accessToken)); }
            catch (error) { result = normalizeSubscriptionError(error?.message || "订阅检查失败", error?.subscriptionDiagnostic); }
          }
          updateRow(row.id, (current) => ({ ...current, ...result }));
          completed += 1;
          setMessage(`正在检查订阅状态：${completed}/${targets.length}`);
        }
      };
      const workerCount = Math.min(SUBSCRIPTION_CHECK_CONCURRENCY, targets.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (cancelledRef.current) return;
      setMessage(`订阅状态检查完成：${targets.length} 个账号`);
    } finally { setBusy(""); }
  }

  async function checkEmails(ids) {
    const targets = targetRows(ids);
    if (!targets.length) { setMessage("没有可检查的账号"); return; }
    const api = getRedeemApi?.();
    if (!api?.checkPlusEmail) { setMessage("邮箱检查接口不可用"); return; }
    cancelledRef.current = false;
    setBusy("email");
    setMessage(`正在检查邮箱通知：0/${targets.length}`);
    try {
      for (let index = 0; index < targets.length; index += 1) {
        if (cancelledRef.current) return;
        const row = targets[index];
        updateRow(row.id, (current) => ({ ...current, ...createEmptyEmailVerificationState(), emailVerificationStatus: "checking", emailVerificationTitle: "检查中" }));
        let result;
        if (!row.pickupUrl) {
          result = normalizeEmailVerificationResult({ diagnostic: { category: "missing_url" } });
        } else {
          try { result = normalizeEmailVerificationResult(await api.checkPlusEmail(row.pickupUrl, row.timestamp)); }
          catch (error) { result = normalizeEmailVerificationResult({ diagnostic: error?.emailVerificationDiagnostic || { category: "network_error", message: error?.message } }); }
        }
        updateRow(row.id, (current) => ({ ...current, ...result }));
        setMessage(`正在检查邮箱通知：${index + 1}/${targets.length}`);
      }
      setMessage(`邮箱通知检查完成：${targets.length} 个账号`);
    } finally { setBusy(""); }
  }

  function download(filterId) {
    const lines = getAccountAuditExportRows(rowsRef.current, filterId);
    if (!lines.length) { setMessage("当前分类没有可导出的原始账号"); return; }
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `account_${filterId}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage(`已导出 ${lines.length} 条原始账号`);
  }

  function clear() {
    setInputText("");
    commitRows([]);
    setFilter("all");
    setMessage("已清空账号检测数据");
  }

  return {
    inputText,
    setInputText,
    parsed,
    rows,
    visibleRows,
    counts,
    filter,
    setFilter,
    busy,
    notice,
    importAccounts,
    checkSubscriptions,
    checkEmails,
    download,
    clear,
    getStatus: getAccountAuditStatus
  };
}
