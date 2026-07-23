import { useCallback } from "react";
import {
  POLL_INTERVAL_MS,
  STATUS_NOT_FOUND_RETRY_DELAY_MS,
  STATUS_NOT_FOUND_RETRY_LIMIT
} from "../config/redeemConstants.js";
import { isTerminalStatus, normalizeStatusItem } from "../redeemLogic.js";
import { createSerializedPolling } from "../services/serializedPolling.js";
import { reviveRemoteBackendRows } from "../state/statusMerge.js";
import { createStatusReceivedEvent } from "../workflow/redeemEvents.js";
import {
  applyWorkflowEvent,
  createInitialWorkflowState,
  getVisibleRows
} from "../workflow/redeemTaskModel.js";
import { buildStatusQueryCommand } from "../workflow/workflowCommands.js";
import {
  mergeProxyPayloads,
  splitCdkeysByCredential
} from "../workflow/credentialRouting.js";

function normalizeCdkeyList(cdkeys) {
  return [
    ...new Set((cdkeys || []).map((item) => String(item || "").trim()).filter(Boolean))
  ];
}

function normalizeStatusItemCdkey(item) {
  return String(item?.cdkey ?? item?.cdKey ?? item?.cd_key ?? item?.cdk ?? item?.key ?? "").trim();
}

function waitForDelay(delayMs) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function getDelayedStatusCdkeys(cdkeys, items = []) {
  const cleanCdkeys = normalizeCdkeyList(cdkeys);
  const requestedCdkeys = new Set(cleanCdkeys);
  const itemsByCdkey = new Map(
    (Array.isArray(items) ? items : [])
      .map((item) => [normalizeStatusItemCdkey(item), item])
      .filter(([cdkey]) => cdkey && requestedCdkeys.has(cdkey))
  );

  return cleanCdkeys.filter((cdkey) => {
    const item = itemsByCdkey.get(cdkey);
    return !item || normalizeStatusItem(item).status === "not_found";
  });
}

export async function retryDelayedStatusItems({
  cdkeys,
  items = [],
  queryStatus,
  maxRetries = STATUS_NOT_FOUND_RETRY_LIMIT,
  delayMs = STATUS_NOT_FOUND_RETRY_DELAY_MS,
  wait = waitForDelay,
  onRetry = () => {}
} = {}) {
  const cleanCdkeys = normalizeCdkeyList(cdkeys);
  const requestedCdkeys = new Set(cleanCdkeys);
  const itemsByCdkey = new Map(
    (Array.isArray(items) ? items : [])
      .map((item) => [normalizeStatusItemCdkey(item), item])
      .filter(([cdkey]) => cdkey && requestedCdkeys.has(cdkey))
  );
  let unresolvedCdkeys = getDelayedStatusCdkeys(cleanCdkeys, items);
  let retryAttempts = 0;

  while (unresolvedCdkeys.length && retryAttempts < Math.max(Number(maxRetries) || 0, 0)) {
    retryAttempts += 1;
    onRetry({
      cdkeys: unresolvedCdkeys,
      attempt: retryAttempts,
      maxRetries
    });
    if (Number(delayMs) > 0) await wait(Number(delayMs));

    const payload = await queryStatus(unresolvedCdkeys);
    const retryItems = Array.isArray(payload?.items) ? payload.items : [];
    retryItems.forEach((item) => {
      const cdkey = normalizeStatusItemCdkey(item);
      if (cdkey && requestedCdkeys.has(cdkey)) itemsByCdkey.set(cdkey, item);
    });
    unresolvedCdkeys = getDelayedStatusCdkeys(unresolvedCdkeys, retryItems);
  }

  const unresolvedSet = new Set(unresolvedCdkeys);
  const resolvedItems = cleanCdkeys
    .map((cdkey) => itemsByCdkey.get(cdkey))
    .filter(Boolean)
    .map((item) => {
      const cdkey = normalizeStatusItemCdkey(item);
      if (!unresolvedSet.has(cdkey)) return item;
      return {
        ...item,
        status: "unused",
        found: false,
        reason: "后端未找到兑换记录，按未使用处理",
        message: "后端未找到兑换记录，按未使用处理",
        originalStatus: item?.status || item?.state || item?.result || "not_found"
      };
    });

  return {
    items: resolvedItems,
    retryAttempts,
    unresolvedCdkeys
  };
}

export function markRowsAwaitingStatusRetry(rows, cdkeys, attempt, maxRetries) {
  const targetCdkeys = new Set(normalizeCdkeyList(cdkeys));
  if (!targetCdkeys.size) return rows || [];
  const reason = `后端暂未同步，正在重试查询（${attempt}/${maxRetries}）`;

  return (rows || []).map((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!targetCdkeys.has(cdkey) || row?.statusOwner === false || row?.statusLocked === true) return row;
    return {
      ...row,
      status: "querying",
      reason,
      can_retry: false,
      can_reuse_token: false,
      rawStatus: {
        ...(row?.rawStatus && typeof row.rawStatus === "object" ? row.rawStatus : {}),
        statusRetry: { attempt, maxRetries }
      }
    };
  });
}

export function summarizeStatusQueryResult(cdkeys, items = []) {
  const cleanCdkeys = normalizeCdkeyList(cdkeys);
  const requestedCdkeys = new Set(cleanCdkeys);
  const returnedCdkeys = new Set(
    (Array.isArray(items) ? items : [])
      .map(normalizeStatusItemCdkey)
      .filter((cdkey) => cdkey && requestedCdkeys.has(cdkey))
  );
  const missingCdkeys = cleanCdkeys.filter((cdkey) => !returnedCdkeys.has(cdkey));

  return {
    requestedCount: cleanCdkeys.length,
    returnedCount: returnedCdkeys.size,
    missingCount: missingCdkeys.length,
    missingCdkeys
  };
}

export function markQueryRowsFailed(rows, cdkeys, message) {
  const targetCdkeys = new Set(normalizeCdkeyList(cdkeys));
  if (!targetCdkeys.size) return rows || [];
  const reason = String(message || "状态查询失败").trim() || "状态查询失败";
  let changed = false;

  const nextRows = (rows || []).map((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (row?.status !== "querying" || !targetCdkeys.has(cdkey)) return row;
    changed = true;
    return {
      ...row,
      status: "query_failed",
      reason,
      can_cancel: false,
      can_retry: false,
      can_reuse_token: false,
      rawStatus: {
        ...(row.rawStatus && typeof row.rawStatus === "object" ? row.rawStatus : {}),
        localQueryError: true,
        message: reason
      }
    };
  });

  return changed ? nextRows : rows || [];
}

export function markCredentialBlockedRows(rows, cdkeys, message) {
  const targetCdkeys = new Set(normalizeCdkeyList(cdkeys));
  if (!targetCdkeys.size) return rows || [];
  const reason = String(message || "请先填写外部 API Key").trim();

  return (rows || []).map((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (
      !targetCdkeys.has(cdkey) ||
      row?.statusOwner === false ||
      row?.statusLocked === true
    ) {
      return row;
    }
    return {
      ...row,
      status: "query_failed",
      reason,
      can_cancel: false,
      can_retry: false,
      can_reuse_token: false,
      rawStatus: {
        ...(row?.rawStatus && typeof row.rawStatus === "object" ? row.rawStatus : {}),
        localCredentialError: true,
        message: reason
      }
    };
  });
}

export async function queryStatusCredentialGroups({
  rows,
  cdkeys,
  hasUserApiKey,
  callProxy
}) {
  const routing = splitCdkeysByCredential(rows, cdkeys, { hasUserApiKey });
  const payloads = [];
  for (const group of routing.groups) {
    const command = buildStatusQueryCommand(group.cdkeys);
    payloads.push(
      await callProxy(command.path, command.body, {
        credentialMode: group.credentialMode
      })
    );
  }
  return {
    payload: mergeProxyPayloads(payloads),
    blockedCdkeys: routing.blockedCdkeys
  };
}

export function useRedeemPolling({
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
  filterDeletedRows = (rowList) => rowList || [],
  hasUserApiKey = () => true,
  checkPlusSubscriptions,
  scheduleAutoCycleFailures
}) {
  const getPollingController = useCallback(() => {
    if (!pollingControllerRef.current) {
      pollingControllerRef.current = createSerializedPolling({
        intervalMs: POLL_INTERVAL_MS,
        query: (...args) => queryStatusesRef.current(...args),
        setTimer: (fn, delay) => window.setTimeout(fn, delay),
        clearTimer: (timerId) => window.clearTimeout(timerId)
      });
    }
    return pollingControllerRef.current;
  }, [pollingControllerRef, queryStatusesRef]);

  const stopPolling = useCallback(
    (options = {}) => {
      const { persist = true } = options;
      const controller = getPollingController();
      controller.stop();
      isPollingRef.current = false;
      pollingInFlightRef.current = false;
      pollingSessionRef.current = controller.getSession();
      setIsPolling(false);
      if (persist) {
        saveUiSettings({ pollingEnabled: false });
      }
    },
    [
      getPollingController,
      isPollingRef,
      pollingInFlightRef,
      pollingSessionRef,
      saveUiSettings,
      setIsPolling
    ]
  );

  const queryStatuses = useCallback(
    async (cdkeys, options = {}) => {
      const cleanCdkeys = normalizeCdkeyList(cdkeys);
      if (!cleanCdkeys.length) {
        setStatusMessage("没有可查询的 CDK");
        return [];
      }

      if (!options.silent) {
        setIsBusy(true);
        setStatusMessage(`正在查询 ${cleanCdkeys.length} 个 CDK 状态`);
      }

      try {
        let retryBaseRows = options.baseRows || rowsRef.current;
        const queryResult = await queryStatusCredentialGroups({
          rows: retryBaseRows,
          cdkeys: cleanCdkeys,
          hasUserApiKey: hasUserApiKey(),
          callProxy
        });
        const payload = queryResult.payload;
        if (queryResult.blockedCdkeys.length) {
          retryBaseRows = markCredentialBlockedRows(
            retryBaseRows,
            queryResult.blockedCdkeys,
            "请先填写外部 API Key"
          );
          setRows(retryBaseRows);
          rowsRef.current = retryBaseRows;
        }
        const blockedCdkeySet = new Set(queryResult.blockedCdkeys);
        const queryCdkeys = cleanCdkeys.filter((cdkey) => !blockedCdkeySet.has(cdkey));
        const retryResult = await retryDelayedStatusItems({
          cdkeys: queryCdkeys,
          items: payload.items || [],
          queryStatus: async (retryCdkeys) => {
            const retryQueryResult = await queryStatusCredentialGroups({
              rows: rowsRef.current,
              cdkeys: retryCdkeys,
              hasUserApiKey: hasUserApiKey(),
              callProxy
            });
            return retryQueryResult.payload;
          },
          onRetry: ({ cdkeys: retryCdkeys, attempt, maxRetries }) => {
            const retryingRows = markRowsAwaitingStatusRetry(
              retryBaseRows,
              retryCdkeys,
              attempt,
              maxRetries
            );
            setRows(retryingRows);
            rowsRef.current = retryingRows;
            if (!options.silent) {
              setStatusMessage(
                `后端暂未同步 ${retryCdkeys.length} 张 CDK，${STATUS_NOT_FOUND_RETRY_DELAY_MS / 1000} 秒后重试（${attempt}/${maxRetries}）`
              );
            }
          }
        });
        const statusItems = retryResult.items;
        const querySummary = summarizeStatusQueryResult(queryCdkeys, statusItems);
        if (options.pollingSession || options.pollingSeq) {
          if (
            (options.pollingSession && options.pollingSession !== pollingSessionRef.current) ||
            !isPollingRef.current ||
            (options.pollingSeq && options.pollingSeq < latestAcceptedPollingSeqRef.current)
          ) {
            return rowsRef.current;
          }
          if (options.pollingSeq) {
            latestAcceptedPollingSeqRef.current = options.pollingSeq;
          }
        }

        const workingRows = retryBaseRows;
        const statusEvent = {
          ...createStatusReceivedEvent({
            cdkeys: queryCdkeys,
            items: statusItems,
            missingAsUnused: true,
            raw: payload
          }),
          force: options.forceRemote === true
        };
        let updated = getVisibleRows(
          applyWorkflowEvent(
            createInitialWorkflowState({ rows: workingRows }),
            statusEvent
          )
        );
        if (options.forceRemote === true) {
          updated = reviveRemoteBackendRows(updated);
        }
        updated = registerCooldownsFromRows(updated, {
          silent: options.silent === true,
          skipAutoCycle: options.skipAutoCycle === true
        });
        updated = filterDeletedRows(updated);
        setRows(updated);
        rowsRef.current = updated;
        setLastUpdatedAt(new Date().toLocaleString());
        if (!options.silent) {
          const returnedText = `后端返回 ${querySummary.returnedCount} 条明细`;
          const retryText = retryResult.retryAttempts
            ? `，未找到/未返回已重查 ${retryResult.retryAttempts} 次`
            : "";
          const unresolvedText = retryResult.unresolvedCdkeys.length
            ? `，${retryResult.unresolvedCdkeys.length} 张仍无任务记录，已按未使用处理`
            : "";
          const missingText = querySummary.missingCount
            ? `，${querySummary.missingCount} 张未返回，已按未使用处理`
            : "";
          setStatusMessage(
            withBackendNotice(
              `查询完成：${cleanCdkeys.length} 个 CDK，${payload.batchCount || 1} 批，${returnedText}${retryText}${unresolvedText}${missingText}`,
              payload,
              "后台没有返回状态明细"
            )
          );
        }

        if (!options.skipAutoCycle) {
          scheduleAutoCycleFailures(updated, { ...options, silent: false });
        }

        updated = await checkPlusSubscriptions(updated, { silent: options.silent });
        const targetRows = updated.filter((row) => cleanCdkeys.includes(row.cdkey));
        if (
          !options.keepPollingWhenTerminal &&
          targetRows.length &&
          targetRows.every((row) => isTerminalStatus(row.status))
        ) {
          stopPolling();
        }
        return updated;
      } catch (error) {
        const message = error.message || "状态查询失败";
        const recoveredRows = markQueryRowsFailed(rowsRef.current, cleanCdkeys, message);
        if (recoveredRows !== rowsRef.current) {
          setRows(recoveredRows);
          rowsRef.current = recoveredRows;
          setLastUpdatedAt(new Date().toLocaleString());
        }
        setStatusMessage(message);
        if (options.throwOnError) throw error;
        return recoveredRows;
      } finally {
        if (!options.silent) setIsBusy(false);
      }
    },
    [
      callProxy,
      checkPlusSubscriptions,
      filterDeletedRows,
      hasUserApiKey,
      isPollingRef,
      latestAcceptedPollingSeqRef,
      pollingSessionRef,
      registerCooldownsFromRows,
      rowsRef,
      scheduleAutoCycleFailures,
      setIsBusy,
      setLastUpdatedAt,
      setRows,
      setStatusMessage,
      stopPolling,
      withBackendNotice
    ]
  );

  const startPolling = useCallback(
    (cdkeys, options = {}) => {
      const result = getPollingController().start(cdkeys, {
        silent: true,
        forceRemote: options.forceRemote === true,
        keepPollingWhenTerminal: options.keepPollingWhenTerminal === true,
        skipAutoCycle: options.skipAutoCycle === true
      });
      if (!result.started) return;
      setIsPolling(true);
      isPollingRef.current = true;
      pollingInFlightRef.current = false;
      pollingSessionRef.current = result.session;
      latestAcceptedPollingSeqRef.current = 0;
      saveUiSettings({ pollingEnabled: true });
    },
    [
      getPollingController,
      isPollingRef,
      latestAcceptedPollingSeqRef,
      pollingInFlightRef,
      pollingSessionRef,
      saveUiSettings,
      setIsPolling
    ]
  );

  return { queryStatuses, startPolling, stopPolling };
}
