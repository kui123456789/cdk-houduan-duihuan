import {
  normalizeSubscriptionError,
  normalizeSubscriptionResult
} from "../redeemLogic.js";
import { getAccessTokenEmail } from "../domain/accountParsing.js";
import { normalizeEmailVerificationResult } from "../domain/emailVerification.js";
import { getCdkAccountAttempts } from "../workflow/accountLedger.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function applyHistoricalPlusAttribution(rows, sourceRow, attempt, subscriptionResult) {
  const recoveredAt = Date.now();
  const sourceId = String(sourceRow?.id || "");
  const targetIndex = rows.findIndex((row) => {
    if (row?.id === sourceId) return false;
    if (attempt.rowId && String(row?.id || "") === attempt.rowId) return true;
    return (
      String(row?.cdkey || "").trim() === attempt.cdkey &&
      String(row?.accessToken || "").trim() === attempt.accessToken &&
      normalizeEmail(row?.email) === attempt.email
    );
  });
  const targetId =
    targetIndex >= 0
      ? String(rows[targetIndex]?.id || "")
      : `historical-attribution-${sourceId || "cdk"}-${attempt.submittedAt}`;
  const attributionReason = `当前账号非 Plus；历史 AT 已确认 Plus，成功归属 ${attempt.email}`;
  const targetBase =
    targetIndex >= 0
      ? rows[targetIndex]
      : {
          id: targetId,
          displayIndex: sourceRow?.displayIndex || rows.length + 1,
          accountLineNumber: null,
          cdkeyLineNumber: attempt.cdkeyLineNumber || sourceRow?.cdkeyLineNumber || null,
          selected: false,
          retryRequestedAt: 0,
          retryHoldUntil: 0,
          staleStatusGuard: false,
          staleStatusGuardStartedAt: 0,
          attemptRound: 1,
          attemptNumber: 1,
          accountAttemptNumber: 1,
          parentRowId: sourceId,
          autoCycle: true,
          rawStatus: sourceRow?.rawStatus || null
        };
  const attributedRow = {
    ...targetBase,
    email: attempt.email,
    password: attempt.password,
    twofa: attempt.twofa,
    pickupUrl: attempt.pickupUrl,
    accessToken: attempt.accessToken,
    timestamp: attempt.timestamp,
    inputFormat: attempt.inputFormat,
    sourceType: attempt.sourceType,
    exportLine: attempt.exportLine,
    cdkey: attempt.cdkey,
    originalCdkey: attempt.cdkey,
    channel: sourceRow?.channel || attempt.channel || targetBase?.channel || "",
    channelLabel: sourceRow?.channelLabel || attempt.channelLabel || targetBase?.channelLabel || "",
    submitPoolId: sourceRow?.submitPoolId || attempt.submitPoolId || targetBase?.submitPoolId || "",
    submitPoolLabel:
      sourceRow?.submitPoolLabel || attempt.submitPoolLabel || targetBase?.submitPoolLabel || "",
    status: "success",
    reason: attributionReason,
    can_cancel: false,
    can_retry: false,
    can_reuse_token: false,
    has_access_token: true,
    ...subscriptionResult,
    redemptionTimestamp: sourceRow?.redemptionTimestamp || targetBase?.redemptionTimestamp || "",
    statusLocked: true,
    autoCycleHandled: true,
    statusOwner: false,
    historicalAttribution: true,
    historicalAttributionSourceRowId: sourceId,
    historicalAttributionRecoveredAt: recoveredAt
  };

  const nextRows = rows.map((row, index) => {
    if (row?.id === sourceId) {
      return {
        ...row,
        historicalAttributionEmail: attempt.email,
        historicalAttributionRowId: targetId,
        historicalAttributionRecoveredAt: recoveredAt,
        subscriptionReason: attributionReason
      };
    }
    return index === targetIndex ? attributedRow : row;
  });
  if (targetIndex < 0) nextRows.push(attributedRow);
  return nextRows;
}

export function shouldCheckSubscriptionRow(row, { isHistoricalRow = () => false } = {}) {
  return row?.status === "success" && Boolean(row?.accessToken) && !isHistoricalRow(row);
}

export function shouldAllowManualPlusRecheck(row, options = {}) {
  return shouldCheckSubscriptionRow(row, options);
}

export function shouldQueueSubscriptionCheck(
  row,
  { force = false, isHistoricalRow = () => false } = {}
) {
  return (
    shouldCheckSubscriptionRow(row, { isHistoricalRow }) &&
    (force || row?.subscriptionStatus !== "checking")
  );
}

export function shouldApplySubscriptionResultToRow(
  row,
  tokenLookup,
  { isHistoricalRow = () => false } = {}
) {
  return (
    shouldCheckSubscriptionRow(row, { isHistoricalRow }) &&
    Boolean(tokenLookup?.has?.(row.accessToken))
  );
}

function isFinalSubscriptionState(row) {
  if (row?.subscriptionStatus === "plus") {
    return Boolean(row.subscriptionTimestamp);
  }
  return ["not_plus", "error", "missing_token"].includes(
    String(row?.subscriptionStatus || "")
  );
}

export function useSubscriptionChecks({
  redeemApiRef,
  subscriptionCacheRef,
  accountAttemptLedgerRef = { current: {} },
  rowsRef,
  setRows,
  setStatusMessage,
  showToast = () => {},
  setIsBusy = () => {},
  getRedeemApi,
  emailVerificationCacheRef = { current: new Map() },
  filterDeletedRows = (rowList) => rowList || [],
  getRows = () => rowsRef?.current || [],
  getSelectedRows = () => [],
  isHistoricalRow = () => false
}) {
  function commitRows(nextRows) {
    setRows(nextRows);
    if (rowsRef) {
      rowsRef.current = nextRows;
    }
    return nextRows;
  }

  function getSubscriptionApi() {
    if (typeof getRedeemApi === "function") {
      return getRedeemApi();
    }
    return redeemApiRef?.current;
  }

  async function callSubscriptionCheck(token) {
    const api = getSubscriptionApi();
    if (!api?.checkSubscription) {
      throw new Error("订阅检查接口不可用");
    }
    const result = await api.checkSubscription(token);
    return normalizeSubscriptionResult(result);
  }

  async function callEmailVerification(row) {
    const api = getSubscriptionApi();
    if (!api?.checkPlusEmail) {
      return normalizeEmailVerificationResult({
        diagnostic: { category: "network_error", message: "邮箱验证接口不可用" }
      });
    }
    try {
      const result = await api.checkPlusEmail(row?.pickupUrl, row?.redemptionTimestamp);
      return normalizeEmailVerificationResult(result);
    } catch (error) {
      return normalizeEmailVerificationResult({
        diagnostic: error.emailVerificationDiagnostic || {
          category: "network_error",
          message: error.message || "邮箱 Plus 验证失败"
        }
      });
    }
  }

  function emailVerificationKey(row) {
    return `${String(row?.pickupUrl || "").trim()}|${String(row?.redemptionTimestamp || "").trim()}`;
  }

  function shouldVerifyEmailRow(row) {
    return (
      row?.status === "success" &&
      row?.isPlus === true &&
      (!isHistoricalRow(row) || row?.historicalAttribution === true)
    );
  }

  async function verifyPlusEmails(rowList, options = {}) {
    const forceKeys = new Set(options.forceEmailKeys || []);
    const cache = emailVerificationCacheRef.current;
    let workingRows = filterDeletedRows(rowList || []).map((row) => {
      if (!shouldVerifyEmailRow(row)) return row;
      if (!row.pickupUrl) {
        return { ...row, ...normalizeEmailVerificationResult({ category: "missing_url" }) };
      }
      const key = emailVerificationKey(row);
      const cached = cache.get(key);
      if (cached && !forceKeys.has(key)) return { ...row, ...cached };
      return row;
    });

    const rowsToCheck = workingRows.filter(
      (row) =>
        shouldVerifyEmailRow(row) &&
        Boolean(row?.pickupUrl) &&
        (forceKeys.has(emailVerificationKey(row)) || row?.emailVerificationStatus !== "verified")
    );
    if (!rowsToCheck.length) {
      commitRows(workingRows);
      return workingRows;
    }

    const checkingKeys = new Set(rowsToCheck.map(emailVerificationKey));
    workingRows = workingRows.map((row) =>
      checkingKeys.has(emailVerificationKey(row))
        ? {
            ...row,
            emailVerificationStatus: "checking",
            emailVerificationCategory: "",
            emailVerificationTitle: "检查中",
            emailVerificationReason: "正在查找 ChatGPT Plus 开通邮件",
            emailVerificationRetryable: false,
            emailPlusVerified: false
          }
        : row
    );
    commitRows(workingRows);
    if (!options.silent) setStatusMessage(`正在检查 ${rowsToCheck.length} 个账号的 Plus 邮箱`);

    const results = new Map();
    for (const row of rowsToCheck) {
      const key = emailVerificationKey(row);
      const result = await callEmailVerification(row);
      results.set(key, result);
      if (result.emailVerificationStatus === "verified") cache.set(key, result);
      else cache.delete(key);
    }

    const latestRows = filterDeletedRows(getRows());
    const checkedRows = latestRows.map((row) => {
      const key = emailVerificationKey(row);
      if (!results.has(key) || row?.status !== "success" || row?.isPlus !== true) return row;
      return { ...row, ...results.get(key) };
    });
    commitRows(checkedRows);
    if (!options.silent) setStatusMessage(`邮箱 Plus 验证完成：${rowsToCheck.length} 个账号`);
    return checkedRows;
  }

  async function recoverHistoricalPlusAttributions(rowList, options = {}) {
    let recoveredRows = filterDeletedRows(rowList || []);
    const sourceIds = recoveredRows
      .filter(
        (row) =>
          !isHistoricalRow(row) &&
          row?.status === "success" &&
          row?.subscriptionStatus === "not_plus" &&
          Boolean(row?.cdkey)
      )
      .map((row) => String(row.id || ""))
      .filter(Boolean);

    for (const sourceId of sourceIds) {
      const sourceRow = recoveredRows.find((row) => String(row?.id || "") === sourceId);
      if (!sourceRow) continue;
      const alreadyAttributed = recoveredRows.some(
        (row) =>
          row?.historicalAttributionSourceRowId === sourceId &&
          row?.subscriptionStatus === "plus" &&
          row?.isPlus === true
      );
      if (alreadyAttributed) continue;

      const currentEmail = normalizeEmail(sourceRow.email);
      const forceHistorical = options.forceTokens?.has?.(sourceRow.accessToken) === true;
      const attempts = getCdkAccountAttempts(accountAttemptLedgerRef?.current, sourceRow.cdkey);
      for (const attempt of attempts) {
        if (attempt.accessToken === sourceRow.accessToken) continue;
        const tokenEmail = getAccessTokenEmail(attempt.accessToken);
        if (!tokenEmail || tokenEmail !== attempt.email || tokenEmail === currentEmail) continue;

        let result = subscriptionCacheRef.current.get(attempt.accessToken);
        if (!result || forceHistorical) {
          try {
            result = await callSubscriptionCheck(attempt.accessToken);
          } catch (error) {
            result = normalizeSubscriptionError(error.message, error.subscriptionDiagnostic);
          }
          subscriptionCacheRef.current.set(attempt.accessToken, result);
        }
        if (result?.subscriptionStatus !== "plus" || result?.isPlus !== true) continue;

        const latestRows = filterDeletedRows(getRows());
        const latestSource = latestRows.find((row) => String(row?.id || "") === sourceId);
        if (
          !latestSource ||
          latestSource.status !== "success" ||
          latestSource.accessToken !== sourceRow.accessToken ||
          latestSource.subscriptionStatus !== "not_plus"
        ) {
          recoveredRows = latestRows;
          break;
        }
        recoveredRows = applyHistoricalPlusAttribution(latestRows, latestSource, attempt, result);
        commitRows(recoveredRows);
        break;
      }
    }

    return recoveredRows;
  }

  async function checkSubscriptionsForRows(rowList, options = {}) {
    const forceTokens = new Set(options.forceTokens || []);
    const subscriptionCache = subscriptionCacheRef.current;
    let workingRows = filterDeletedRows(rowList || []).map((row) => {
      if (isHistoricalRow(row)) return row;
      if (row.status !== "success") return row;
      if (!row.accessToken) {
        return isFinalSubscriptionState(row)
          ? row
          : {
              ...row,
              ...normalizeSubscriptionError("缺少 at/access_token，无法判断 Plus", {
                category: "missing_token",
                title: "缺少 at",
                retryable: false
              })
            };
      }

      const cached = subscriptionCache.get(row.accessToken);
      if (cached && !forceTokens.has(row.accessToken)) return { ...row, ...cached };
      return row;
    });

    const tokensToCheck = [
      ...new Set(
        workingRows
          .filter((row) => {
            const force = forceTokens.has(row.accessToken);
            return (
              shouldQueueSubscriptionCheck(row, { force, isHistoricalRow }) &&
              (force || (!subscriptionCache.has(row.accessToken) && !isFinalSubscriptionState(row)))
            );
          })
          .map((row) => row.accessToken)
      )
    ];

    if (!tokensToCheck.length) {
      workingRows = filterDeletedRows(workingRows);
      commitRows(workingRows);
      const attributedRows = await recoverHistoricalPlusAttributions(workingRows, { forceTokens });
      return verifyPlusEmails(attributedRows, {
        silent: options.silent,
        forceEmailKeys: options.forceEmailKeys
      });
    }

    const tokenSet = new Set(tokensToCheck);
    workingRows = workingRows.map((row) =>
      shouldApplySubscriptionResultToRow(row, tokenSet, { isHistoricalRow })
        ? {
            ...row,
            subscriptionStatus: "checking",
            subscriptionCategory: "",
            subscriptionTitle: "检查中",
            subscriptionRetryable: false,
            subscriptionReason: "正在判断 Plus"
          }
        : row
    );
    workingRows = filterDeletedRows(workingRows);
    commitRows(workingRows);
    if (!options.silent) {
      setStatusMessage(`正在检查 ${tokensToCheck.length} 个账号的 Plus 状态`);
    }

    const results = new Map();
    for (const token of tokensToCheck) {
      try {
        const result = await callSubscriptionCheck(token);
        results.set(token, result);
        subscriptionCache.set(token, result);
      } catch (error) {
        const result = normalizeSubscriptionError(error.message, error.subscriptionDiagnostic);
        results.set(token, result);
        subscriptionCache.set(token, result);
      }
    }

    const latestRows = filterDeletedRows(getRows());
    const checkedRows = filterDeletedRows(
      latestRows.map((row) =>
        shouldApplySubscriptionResultToRow(row, results, { isHistoricalRow })
          ? { ...row, ...results.get(row.accessToken) }
          : row
      )
    );
    commitRows(checkedRows);
    const attributedRows = await recoverHistoricalPlusAttributions(checkedRows, { forceTokens });
    const verifiedRows = await verifyPlusEmails(attributedRows, {
      silent: options.silent,
      forceEmailKeys: options.forceEmailKeys
    });
    if (!options.silent) {
      setStatusMessage(`Plus 检查完成：${tokensToCheck.length} 个账号`);
    }
    return verifiedRows;
  }

  async function recheckPlusRows(targetRows = getSelectedRows()) {
    const recheckable = targetRows.filter(canRecheckSubscriptionRow);
    if (!recheckable.length) {
      const message = "没有可重新检查 Plus 的成功账号";
      setStatusMessage(message);
      showToast(message, "error");
      return;
    }

    const targetIds = new Set(recheckable.map((row) => row.id));
    const forceTokens = [
      ...new Set(recheckable.map((row) => String(row.accessToken || "").trim()).filter(Boolean))
    ];
    forceTokens.forEach((token) => subscriptionCacheRef.current.delete(token));
    const forceEmailKeys = recheckable.map(emailVerificationKey);
    forceEmailKeys.forEach((key) => emailVerificationCacheRef.current.delete(key));

    setIsBusy(true);
    try {
      const nextRows = getRows().map((row) =>
        targetIds.has(row.id)
          ? {
              ...row,
              subscriptionStatus: "checking",
              subscriptionCategory: "",
              subscriptionTitle: "",
              subscriptionReason: "正在重新检查 Plus"
            }
          : row
      );
      commitRows(nextRows);
      setStatusMessage(`正在重新检查 Plus：${recheckable.length} 行`);
      await checkSubscriptionsForRows(nextRows, { forceTokens, forceEmailKeys });
      const message = `Plus 和邮箱已重新检查：${recheckable.length} 行`;
      setStatusMessage(message);
      showToast(message);
    } finally {
      setIsBusy(false);
    }
  }

  function canRecheckSubscriptionRow(row) {
    return shouldAllowManualPlusRecheck(row, { isHistoricalRow });
  }

  return {
    checkSubscriptionsForRows,
    checkPlusSubscriptions: checkSubscriptionsForRows,
    recheckPlusRows,
    canRecheckSubscriptionRow
  };
}
