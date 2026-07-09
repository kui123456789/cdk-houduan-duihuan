import { useCallback } from "react";
import { POLL_INTERVAL_MS } from "../config/redeemConstants.js";
import { isTerminalStatus } from "../redeemLogic.js";
import { createSerializedPolling } from "../services/serializedPolling.js";
import { reviveRemoteBackendRows } from "../state/statusMerge.js";
import { createStatusReceivedEvent } from "../workflow/redeemEvents.js";
import {
  applyWorkflowEvent,
  createInitialWorkflowState,
  getVisibleRows
} from "../workflow/redeemTaskModel.js";
import { buildStatusQueryCommand } from "../workflow/workflowCommands.js";

function normalizeCdkeyList(cdkeys) {
  return [
    ...new Set((cdkeys || []).map((item) => String(item || "").trim()).filter(Boolean))
  ];
}

function normalizeStatusItemCdkey(item) {
  return String(item?.cdkey ?? item?.cdKey ?? item?.cd_key ?? item?.cdk ?? item?.key ?? "").trim();
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
        const command = buildStatusQueryCommand(cleanCdkeys);
        const payload = await callProxy(command.path, command.body);
        const querySummary = summarizeStatusQueryResult(cleanCdkeys, payload.items || []);
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

        const workingRows = options.baseRows || rowsRef.current;
        const statusEvent = {
          ...createStatusReceivedEvent({
            cdkeys: cleanCdkeys,
            items: payload.items || [],
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
        updated = registerCooldownsFromRows(updated, { silent: options.silent === true });
        updated = filterDeletedRows(updated);
        setRows(updated);
        rowsRef.current = updated;
        setLastUpdatedAt(new Date().toLocaleString());
        if (!options.silent) {
          const returnedText = `后端返回 ${querySummary.returnedCount} 条明细`;
          const missingText = querySummary.missingCount
            ? `，${querySummary.missingCount} 张未返回，已按未使用处理`
            : "";
          setStatusMessage(
            withBackendNotice(
              `查询完成：${cleanCdkeys.length} 个 CDK，${payload.batchCount || 1} 批，${returnedText}${missingText}`,
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
