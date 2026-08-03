import { useCallback, useEffect, useRef } from "react";
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
import { createPollingLease } from "../domain/pollingLease.js";

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
    .map((cdkey) => {
      const item = itemsByCdkey.get(cdkey);
      if (!unresolvedSet.has(cdkey)) return item;
      return {
        ...(item || { cdkey }),
        status: "unknown",
        found: false,
        reason: "后端多次未返回兑换记录，状态无法确认",
        message: "后端多次未返回兑换记录，状态无法确认",
        originalStatus: item?.status || item?.state || item?.result || "not_found"
      };
    })
    .filter(Boolean);

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
  const reason = String(message || "缺少可用兑换凭证").trim();

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

export async function runAutomaticRetryBeforeAutoCycle({
  rows,
  rowsRef,
  automaticRetryRef,
  scheduleAutoCycleFailures,
  options = {}
} = {}) {
  let updated = Array.isArray(rows) ? rows : [];
  if (!options.skipAutoRetry && typeof automaticRetryRef?.current === "function") {
    await automaticRetryRef.current(updated, {
      source: "status",
      silent: options.silent === true
    });
    updated = Array.isArray(rowsRef?.current) ? rowsRef.current : updated;
  }

  if (!options.skipAutoCycle) {
    scheduleAutoCycleFailures(updated, { ...options, silent: false });
  }
  return updated;
}

export function shouldForceRemoteStatus({
  forceRemote = false,
  rows = [],
  cdkeys = [],
  queryStartedAt = 0
} = {}) {
  if (forceRemote !== true) return false;
  const targetCdkeys = new Set(normalizeCdkeyList(cdkeys));
  return !(rows || []).some((row) => {
    const guardStartedAt = Number(row?.staleStatusGuardStartedAt || 0);
    return (
      targetCdkeys.has(String(row?.cdkey || "").trim()) &&
      row?.staleStatusGuard === true &&
      guardStartedAt >= Number(queryStartedAt || 0)
    );
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

export function startPollingWithLease({ lease, controller, cdkeys, options = {} }) {
  if (lease && lease.acquire() !== true) {
    return { started: false, reason: "lease_unavailable" };
  }
  const result = controller.start(cdkeys, options);
  if (!result.started) lease?.release?.();
  return result;
}

function createPollingOwnerId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId;
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useRedeemPolling({
  callProxy,
  rowsRef,
  isPollingRef,
  pollingControllerRef,
  pollingInFlightRef,
  latestAcceptedPollingSeqRef,
  pollingSessionRef,
  pollingLeaseRef,
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
  scheduleAutoCycleFailures,
  automaticRetryRef
}) {
  const statusQuerySequenceRef = useRef(0);
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

  const getPollingLease = useCallback(() => {
    if (!pollingLeaseRef) return null;
    if (!pollingLeaseRef.current) {
      pollingLeaseRef.current = createPollingLease({
        storage: window.localStorage,
        ownerId: createPollingOwnerId(),
        setTimer: (fn, delay) => window.setTimeout(fn, delay),
        clearTimer: (timerId) => window.clearTimeout(timerId),
        onLost: () => {
          pollingControllerRef.current?.stop?.();
          isPollingRef.current = false;
          pollingInFlightRef.current = false;
          setIsPolling(false);
          saveUiSettings({ pollingEnabled: false });
          setStatusMessage("已停止本标签页轮询：另一个标签页正在负责状态更新");
        }
      });
    }
    return pollingLeaseRef.current;
  }, [
    isPollingRef,
    pollingControllerRef,
    pollingInFlightRef,
    pollingLeaseRef,
    saveUiSettings,
    setIsPolling,
    setStatusMessage
  ]);

  useEffect(() => {
    const releaseLease = () => pollingLeaseRef?.current?.release?.();
    window.addEventListener("beforeunload", releaseLease);
    return () => {
      window.removeEventListener("beforeunload", releaseLease);
      releaseLease();
    };
  }, [pollingLeaseRef]);

  const stopPolling = useCallback(
    (options = {}) => {
      const { persist = true } = options;
      const controller = getPollingController();
      controller.stop();
      getPollingLease()?.release();
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
      getPollingLease,
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
      const statusQuerySequence = ++statusQuerySequenceRef.current;
      const statusQueryStartedAt = Date.now();

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
            rowsRef.current,
            queryResult.blockedCdkeys,
            "缺少可用兑换凭证"
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
              rowsRef.current,
              retryCdkeys,
              attempt,
              maxRetries
            );
            retryBaseRows = retryingRows;
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
        if (statusQuerySequence !== statusQuerySequenceRef.current) {
          return rowsRef.current;
        }
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

        const workingRows = Array.isArray(rowsRef.current) ? rowsRef.current : retryBaseRows;
        const forceRemote = shouldForceRemoteStatus({
          forceRemote: options.forceRemote,
          rows: workingRows,
          cdkeys: queryCdkeys,
          queryStartedAt: statusQueryStartedAt
        });
        const statusEvent = {
          ...createStatusReceivedEvent({
            cdkeys: queryCdkeys,
            items: statusItems,
            missingAsUnused: false,
            raw: payload
          }),
          force: forceRemote
        };
        let updated = getVisibleRows(
          applyWorkflowEvent(
            createInitialWorkflowState({ rows: workingRows }),
            statusEvent
          )
        );
        if (forceRemote) {
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
            ? `，${retryResult.unresolvedCdkeys.length} 张仍无任务记录，保持未知状态`
            : "";
          const missingText = querySummary.missingCount
            ? `，${querySummary.missingCount} 张未返回，状态未确认`
            : "";
          setStatusMessage(
            withBackendNotice(
              `查询完成：${cleanCdkeys.length} 个 CDK，${payload.batchCount || 1} 批，${returnedText}${retryText}${unresolvedText}${missingText}`,
              payload,
              "后台没有返回状态明细"
            )
          );
        }

        updated = await runAutomaticRetryBeforeAutoCycle({
          rows: updated,
          rowsRef,
          automaticRetryRef,
          scheduleAutoCycleFailures,
          options
        });

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
        if (statusQuerySequence !== statusQuerySequenceRef.current) {
          return rowsRef.current;
        }
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
        if (!options.silent && statusQuerySequence === statusQuerySequenceRef.current) {
          setIsBusy(false);
        }
      }
    },
    [
      callProxy,
      checkPlusSubscriptions,
      automaticRetryRef,
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
      const result = startPollingWithLease({
        lease: getPollingLease(),
        controller: getPollingController(),
        cdkeys,
        options: {
          silent: true,
          forceRemote: options.forceRemote === true,
          keepPollingWhenTerminal: options.keepPollingWhenTerminal === true,
          skipAutoCycle: options.skipAutoCycle === true
        }
      });
      if (!result.started) {
        if (result.reason === "lease_unavailable") {
          isPollingRef.current = false;
          setIsPolling(false);
          setStatusMessage("另一个标签页正在轮询，本标签页不会重复请求后台");
        }
        return result;
      }
      setIsPolling(true);
      isPollingRef.current = true;
      pollingInFlightRef.current = false;
      pollingSessionRef.current = result.session;
      latestAcceptedPollingSeqRef.current = 0;
      saveUiSettings({ pollingEnabled: true });
      return result;
    },
    [
      getPollingController,
      getPollingLease,
      isPollingRef,
      latestAcceptedPollingSeqRef,
      pollingInFlightRef,
      pollingSessionRef,
      saveUiSettings,
      setIsPolling,
      setStatusMessage
    ]
  );

  return { queryStatuses, startPolling, stopPolling };
}
