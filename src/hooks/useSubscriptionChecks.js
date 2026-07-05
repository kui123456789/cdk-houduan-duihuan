import {
  normalizeSubscriptionError,
  normalizeSubscriptionResult
} from "../redeemLogic.js";

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
  rowsRef,
  setRows,
  setStatusMessage,
  showToast = () => {},
  setIsBusy = () => {},
  getRedeemApi,
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
      return commitRows(workingRows);
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
    if (!options.silent) {
      setStatusMessage(`Plus 检查完成：${tokensToCheck.length} 个账号`);
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
      ...new Set(recheckable.map((row) => String(row.accessToken || "").trim()).filter(Boolean))
    ];
    forceTokens.forEach((token) => subscriptionCacheRef.current.delete(token));

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
      await checkSubscriptionsForRows(nextRows, { forceTokens });
      const message = `Plus 已重新检查：${recheckable.length} 行`;
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
