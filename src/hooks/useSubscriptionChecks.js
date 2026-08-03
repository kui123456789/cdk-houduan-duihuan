import {
  applyVerifiedEmailPlusEvidence,
  createEmptySubscriptionState,
  normalizeSubscriptionError,
  normalizeSubscriptionResult
} from "../redeemLogic.js";
import { enrichRowsWithPickupUrls } from "../domain/accountPickup.js";
import { normalizeEmailVerificationResult } from "../domain/emailVerification.js";
import {
  isSessionCredential,
  refreshSessionCredential
} from "../domain/sessionCredentials.js";

export function getSubscriptionAccessToken(row) {
  return String(row?.refreshedAccessToken || row?.accessToken || "").trim();
}

export function isSessionVerificationRow(row) {
  return isSessionCredential(row);
}

export function createEmailOnlySubscriptionState() {
  return {
    subscriptionStatus: "skipped",
    subscriptionCategory: "skipped",
    subscriptionTitle: "无需检查，仅验邮件",
    subscriptionReason: "AT 账号无需订阅检查，仅验证开通邮件",
    subscriptionRetryable: false,
    hasActiveSubscription: null,
    isPlus: false
  };
}

export function shouldCheckSubscriptionRow(row, { isHistoricalRow = () => false } = {}) {
  return (
    row?.status === "success" &&
    (isSessionVerificationRow(row) || !String(row?.pickupUrl || "").trim()) &&
    Boolean(getSubscriptionAccessToken(row)) &&
    !isHistoricalRow(row)
  );
}

export function shouldAllowManualPlusRecheck(row, options = {}) {
  if (row?.status !== "success" || options.isHistoricalRow?.(row)) return false;
  if (isSessionVerificationRow(row)) {
    return Boolean(row?.sessionToken || row?.credentialValue || getSubscriptionAccessToken(row));
  }
  return Boolean(row?.email && (row?.pickupUrl || getSubscriptionAccessToken(row)));
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
    Boolean(tokenLookup?.has?.(getSubscriptionAccessToken(row)))
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
  isHistoricalRow = () => false,
  verificationRetryDelays = [],
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  onSessionCredentialUpdated = () => {}
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

  async function callSessionRefresh(row) {
    const api = getSubscriptionApi();
    if (!api?.refreshSession) throw new Error("Session 刷新接口不可用");
    const refreshed = await refreshSessionCredential(row, {
      refreshSession: (sessionToken) => api.refreshSession(sessionToken),
      stage: "post_success"
    });
    return { ...refreshed.payload, account: refreshed.account };
  }

  async function refreshSuccessfulSessionRows(rowList, options = {}) {
    let workingRows = enrichRowsWithPickupUrls(filterDeletedRows(rowList || []), []).map((row) => {
      if (row?.status !== "success" || !isSessionVerificationRow(row) || isHistoricalRow(row)) {
        return row;
      }
      const needsRefresh =
        options.forceSessionRefresh === true ||
        row?.sessionRefreshStage !== "post_success" ||
        row?.sessionRefreshStatus !== "success" ||
        !getSubscriptionAccessToken(row);
      if (!needsRefresh) return row;
      if (!String(row?.sessionToken || row?.credentialValue || "").trim()) {
        return {
          ...row,
          sessionRefreshStatus: "error",
          sessionRefreshReason: "缺少 sessionToken，无法刷新 AT",
          sessionRefreshRetryable: false
        };
      }
      return {
        ...row,
        sessionRefreshStatus: "checking",
        sessionRefreshReason: "正在刷新 AT",
        sessionRefreshRetryable: false
      };
    });
    commitRows(workingRows);

    const candidates = workingRows.filter(
      (row) => row?.status === "success" && row?.sessionRefreshStatus === "checking"
    );
    if (!candidates.length) return workingRows;
    if (!options.silent) setStatusMessage(`正在刷新 ${candidates.length} 个成功账号的 Session`);

    const results = new Map();
    for (let offset = 0; offset < candidates.length; offset += 3) {
      const batch = candidates.slice(offset, offset + 3);
      const batchResults = await Promise.all(
        batch.map(async (row) => {
          try {
            return { id: row.id, row, result: await callSessionRefresh(row) };
          } catch (error) {
            return { id: row.id, row, error };
          }
        })
      );
      batchResults.forEach((item) => results.set(item.id, item));
    }

    const refreshedAt = new Date().toISOString();
    workingRows = filterDeletedRows(getRows()).map((row) => {
      const item = results.get(row?.id);
      if (!item || row?.status !== "success") return row;
      if (item.error) {
        return {
          ...row,
          sessionRefreshStatus: "error",
          sessionRefreshReason: item.error.message || "Session 刷新失败",
          sessionRefreshRetryable: item.error.sessionRefreshPermanent !== true
        };
      }
      const result = item.result;
      subscriptionCacheRef.current.delete(result.accessToken);
      onSessionCredentialUpdated(row, result);
      return {
        ...row,
        ...result.account,
        ...createEmptySubscriptionState(),
        sessionRefreshStage: "post_success",
        sessionRefreshReason: "兑换成功后已刷新 AT，等待订阅确认",
        sessionRefreshedAt: refreshedAt
      };
    });
    commitRows(workingRows);
    return workingRows;
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
      row?.emailBanned !== true &&
      (!isHistoricalRow(row) || row?.historicalAttribution === true)
    );
  }

  async function verifyPlusEmails(rowList, options = {}) {
    const forceKeys = new Set(options.forceEmailKeys || []);
    const cache = emailVerificationCacheRef.current;
    let workingRows = enrichRowsWithPickupUrls(filterDeletedRows(rowList || []), []).map((row) => {
      if (row?.status === "success" && !row?.pickupUrl && !isHistoricalRow(row)) {
        return { ...row, ...normalizeEmailVerificationResult({ category: "subscription_only" }) };
      }
      if (!shouldVerifyEmailRow(row)) return row;
      const key = emailVerificationKey(row);
      const cached = cache.get(key);
      if (cached && !forceKeys.has(key)) {
        return applyVerifiedEmailPlusEvidence({ ...row, ...cached });
      }
      return row;
    });

    const rowsToCheck = workingRows.filter(
      (row) =>
        shouldVerifyEmailRow(row) &&
        Boolean(row?.pickupUrl) &&
        row?.emailVerificationStatus !== "banned" &&
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
      if (!results.has(key) || !shouldVerifyEmailRow(row)) return row;
      return applyVerifiedEmailPlusEvidence({ ...row, ...results.get(key) });
    });
    commitRows(checkedRows);
    if (!options.silent) setStatusMessage(`邮箱 Plus 验证完成：${rowsToCheck.length} 个账号`);
    return checkedRows;
  }

  async function runVerificationPass(rowList, options = {}) {
    const forceTokens = new Set(options.forceTokens || []);
    const subscriptionCache = subscriptionCacheRef.current;
    let workingRows = enrichRowsWithPickupUrls(filterDeletedRows(rowList || []), []).map((row) => {
      if (isHistoricalRow(row)) return row;
      if (row.status !== "success") return row;
      if (!isSessionVerificationRow(row) && row?.pickupUrl) {
        return { ...row, ...createEmailOnlySubscriptionState() };
      }
      if (!isSessionVerificationRow(row) && row?.subscriptionStatus === "skipped") {
        return { ...row, ...createEmptySubscriptionState() };
      }
      return row;
    });
    commitRows(workingRows);
    workingRows = await refreshSuccessfulSessionRows(workingRows, options);
    workingRows = filterDeletedRows(workingRows).map((row) => {
      if (isHistoricalRow(row)) return row;
      if (
        row.status !== "success" ||
        (!isSessionVerificationRow(row) && String(row?.pickupUrl || "").trim())
      ) return row;
      const subscriptionToken = getSubscriptionAccessToken(row);
      if (!subscriptionToken) {
        return isFinalSubscriptionState(row)
          ? row
          : {
              ...row,
              ...normalizeSubscriptionError(row?.sessionRefreshReason || "Session 刷新失败，无法判断 Plus", {
                category: row?.sessionRefreshStatus === "error" ? "remote_error" : "missing_token",
                title: row?.sessionRefreshStatus === "error" ? "Session 刷新失败" : "缺少 at",
                retryable: row?.sessionRefreshRetryable === true
              })
            };
      }

      const cached = subscriptionCache.get(subscriptionToken);
      if (cached && !forceTokens.has(subscriptionToken)) return { ...row, ...cached };
      return row;
    });

    const tokensToCheck = [
      ...new Set(
        workingRows
          .filter((row) => {
            const subscriptionToken = getSubscriptionAccessToken(row);
            const force = forceTokens.has(subscriptionToken);
            return (
              shouldQueueSubscriptionCheck(row, { force, isHistoricalRow }) &&
              (force || (!subscriptionCache.has(subscriptionToken) && !isFinalSubscriptionState(row)))
            );
          })
          .map(getSubscriptionAccessToken)
      )
    ];

    if (!tokensToCheck.length) {
      workingRows = filterDeletedRows(workingRows);
      commitRows(workingRows);
      return verifyPlusEmails(workingRows, {
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
            subscriptionReason: row?.pickupUrl
              ? "正在判断 Plus"
              : "无取件地址，正在改用订阅接口判断 Plus"
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
          ? { ...row, ...results.get(getSubscriptionAccessToken(row)) }
          : row
      )
    );
    commitRows(checkedRows);
    const verifiedRows = await verifyPlusEmails(checkedRows, {
      silent: options.silent,
      forceEmailKeys: options.forceEmailKeys
    });
    if (!options.silent) {
      setStatusMessage(`Plus 检查完成：${tokensToCheck.length} 个账号`);
    }
    return verifiedRows;
  }

  function shouldRetryVerification(row) {
    if (row?.status !== "success" || row?.emailBanned === true) return false;
    const hasPickupUrl = Boolean(String(row?.pickupUrl || "").trim());
    const subscriptionRetryable =
      row?.subscriptionStatus === "not_plus" ||
      (row?.subscriptionStatus === "error" && row?.subscriptionRetryable === true);
    if (!hasPickupUrl) {
      return row?.isPlus !== true &&
        (subscriptionRetryable || (isSessionVerificationRow(row) && row?.sessionRefreshRetryable === true));
    }
    const emailRetryable =
      row?.emailVerificationRetryable === true ||
      ["not_found", "error"].includes(String(row?.emailVerificationStatus || ""));
    if (!isSessionVerificationRow(row)) {
      return row?.emailPlusVerified !== true && emailRetryable;
    }
    const sessionRetryable =
      row?.sessionRefreshRetryable === true ||
      row?.subscriptionStatus === "not_plus" ||
      (row?.subscriptionStatus === "error" && row?.subscriptionRetryable === true);
    return row?.emailPlusVerified !== true || row?.isPlus !== true
      ? emailRetryable || sessionRetryable
      : false;
  }

  async function checkSubscriptionsForRows(rowList, options = {}) {
    let checkedRows = await runVerificationPass(rowList, options);
    if (options.autoRetry === false || !verificationRetryDelays.length) return checkedRows;

    for (const delay of verificationRetryDelays) {
      const retryRows = checkedRows.filter(shouldRetryVerification);
      if (!retryRows.length) break;
      await sleep(delay);
      const forceTokens = retryRows
        .filter(
          (row) =>
            shouldCheckSubscriptionRow(row, { isHistoricalRow }) &&
            (row?.sessionRefreshRetryable === true ||
              row?.subscriptionStatus === "not_plus" ||
              (row?.subscriptionStatus === "error" && row?.subscriptionRetryable === true))
        )
        .map(getSubscriptionAccessToken)
        .filter(Boolean);
      const forceEmailKeys = retryRows.map(emailVerificationKey);
      checkedRows = await runVerificationPass(getRows(), {
        ...options,
        forceTokens,
        forceEmailKeys,
        forceSessionRefresh: retryRows.some(
          (row) =>
            isSessionVerificationRow(row) &&
            (row?.sessionRefreshRetryable === true ||
              row?.subscriptionStatus === "not_plus" ||
              (row?.subscriptionStatus === "error" && row?.subscriptionRetryable === true))
        ),
        silent: true
      });
    }
    return checkedRows;
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
      ...new Set(recheckable.map(getSubscriptionAccessToken).filter(Boolean))
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
      await checkSubscriptionsForRows(nextRows, {
        forceTokens,
        forceEmailKeys,
        forceSessionRefresh: true
      });
      const message = `Plus 验证已重新检查：${recheckable.length} 行`;
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
