import {
  ACCOUNT_ATTEMPT_LIMIT,
  RETRY_STATUS_HOLD_MS,
  RETRY_STATUS_HOLD_REASON,
  SUBMIT_STATUS_HOLD_REASON
} from "../config/redeemConstants.js";
import { createEmptySubscriptionState } from "../redeemLogic.js";
import { markStatusOwners } from "../state/statusMerge.js";
import { createStatusReceivedEvent } from "../workflow/redeemEvents.js";
import {
  applyWorkflowEvent,
  createInitialWorkflowState,
  getVisibleRows
} from "../workflow/redeemTaskModel.js";
import { buildSubmitCommand } from "../workflow/workflowCommands.js";

function formatBlockedResubmitRows(blockedRows, describeSelectedRow) {
  if (!blockedRows.length) return "";
  const examples = blockedRows
    .slice(0, 3)
    .map(({ row, reason }) => `${describeSelectedRow(row)}：${reason}`)
    .join("；");
  return blockedRows.length > 3 ? `${examples}；另 ${blockedRows.length - 3} 条` : examples;
}

function applyStatusItemsToRows(rows, cdkeys, items, raw = null) {
  return getVisibleRows(
    applyWorkflowEvent(
      createInitialWorkflowState({ rows }),
      createStatusReceivedEvent({ cdkeys, items: items || [], raw })
    )
  );
}

function formatPoolMessagePrefix(poolLabel = "") {
  const label = String(poolLabel || "").trim();
  return label ? `${label}：` : "";
}

function formatQueriedCdkeyMessage(cdkeys = [], poolLabel = "") {
  const cleanCdkeys = [
    ...new Set((Array.isArray(cdkeys) ? cdkeys : []).map((cdkey) => String(cdkey || "").trim()).filter(Boolean))
  ];
  if (!cleanCdkeys.length) return "";
  return `${formatPoolMessagePrefix(poolLabel)}本次实际查询 CDK ${cleanCdkeys.length} 张：${cleanCdkeys.join("、")}`;
}

export function useRedeemSubmit({
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
}) {
  function collectResubmitRows(targetRows) {
    const seenCdkeys = new Set();
    const seenAccessTokens = new Set();
    const resubmittable = [];
    const blocked = [];

    targetRows.forEach((row) => {
      const cooldown = getAccountCooldown(row?.email, accountCooldownsRef.current);
      if (cooldown) {
        blocked.push({
          row,
          reason: `账号已封存至 ${formatCooldownUntil(cooldown.until)}`
        });
        return;
      }

      const attemptInfo = getAccountAttemptInfo(row?.email, accountAttemptLedgerRef.current);
      if (attemptInfo.limitReached) {
        blocked.push({
          row,
          reason: `账号 24 小时内已尝试 ${attemptInfo.count} 次，达到 ${ACCOUNT_ATTEMPT_LIMIT} 次限制，封存至 ${formatCooldownUntil(attemptInfo.resetAt)}`
        });
        syncAttemptCooldowns(accountAttemptLedgerRef.current, { silent: true });
        return;
      }

      const reason = getResubmitBlockReason(row);
      if (reason) {
        blocked.push({ row, reason });
        return;
      }

      const cdkey = String(row.cdkey || "").trim();
      if (seenCdkeys.has(cdkey)) {
        blocked.push({ row, reason: "本次选择中 CDK 重复" });
        return;
      }
      const accessToken = String(row.accessToken || "").trim();
      if (accessToken && seenAccessTokens.has(accessToken)) {
        blocked.push({ row, reason: "本次选择中 AT 重复，避免同一账号同时消耗多张卡密" });
        return;
      }

      seenCdkeys.add(cdkey);
      if (accessToken) seenAccessTokens.add(accessToken);
      resubmittable.push(row);
    });

    return { resubmittable, blocked };
  }

  async function submitSelectedRedeemRows(targetRows, options = {}) {
    const sourceLabel = options.sourceLabel || "选中";
    const { resubmittable, blocked } = collectResubmitRows(targetRows);
    const blockedText = formatBlockedResubmitRows(blocked, describeSelectedRow);

    if (!resubmittable.length) {
      const message = blockedText
        ? `选中项没有可重新兑换的任务：${blockedText}`
        : "选中项没有可重新兑换的任务";
      setStatusMessage(message);
      showToast(message, "error");
      return false;
    }

    try {
      stopPolling();
      setIsBusy(true);
      const targetIds = new Set(resubmittable.map((row) => row.id));
      const cdkeys = getRowCdkeys(resubmittable);
      const submittingRows = markStatusOwners(rowsRef.current.map((row) =>
        targetIds.has(row.id)
          ? {
              ...row,
              ...createEmptySubscriptionState(),
              status: "submitting",
              reason: "正在重新提交选中任务",
              can_cancel: false,
              can_retry: false,
              retryRequestedAt: 0,
              retryHoldUntil: 0,
              staleStatusGuard: false,
              staleStatusGuardStartedAt: 0,
              accountCooldownUntil: 0,
              accountCooldownReason: "",
              selected: false,
              statusLocked: false,
              autoCycleHandled: false
            }
          : row
      ), resubmittable);
      forgetDeletedRows(resubmittable);
      setRows(submittingRows);
      rowsRef.current = submittingRows;
      setStatusMessage(`正在重新提交${sourceLabel} ${resubmittable.length} 条兑换任务`);

      const command = buildSubmitCommand(resubmittable);
      const payload = await callProxy(command.path, command.body);
      const backendNotice = getBackendResponseNotice(payload, "后台没有返回提交明细");
      markSubmittedRowsInAutoCycle(resubmittable);
      const attemptCountByEmail = recordAccountSubmissionAttempts(resubmittable);
      const actionAt = Date.now();
      const submittedRows = markStatusOwners(rowsRef.current.map((row) =>
        targetIds.has(row.id)
          ? {
              ...row,
              ...createEmptySubscriptionState(),
              status: "pending_dispatch",
              reason: SUBMIT_STATUS_HOLD_REASON,
              can_cancel: true,
              can_retry: false,
              retryRequestedAt: actionAt,
              retryHoldUntil: actionAt + RETRY_STATUS_HOLD_MS,
              staleStatusGuard: true,
              staleStatusGuardStartedAt: actionAt,
              accountCooldownUntil: 0,
              accountCooldownReason: "",
              accountAttemptNumber: getSubmittedAttemptNumber(row, attemptCountByEmail),
              attemptNumber: getSubmittedAttemptNumber(row, attemptCountByEmail),
              selected: false,
              statusLocked: false,
              autoCycleHandled: false,
              statusOwner: true
            }
          : row
      ), resubmittable);
      let mergedRows = applyStatusItemsToRows(submittedRows, cdkeys, payload.items, payload);
      mergedRows = registerCooldownsFromRows(mergedRows);
      const scheduledAutoCycleCount = scheduleAutoCycleFailures(mergedRows, { silent: false });
      setRows(mergedRows);
      rowsRef.current = mergedRows;
      setLastUpdatedAt(new Date().toLocaleString());

      const skippedText = blocked.length ? `；${blocked.length} 条未提交：${blockedText}` : "";
      const autoCycleText = scheduledAutoCycleCount
        ? `；检测到 ${scheduledAutoCycleCount} 条失败，1 秒内合并后自动换号`
        : "";
      const baseMessage = `已重新提交${sourceLabel} ${resubmittable.length} 条，等待后台更新${autoCycleText}${skippedText}`;
      const message = backendNotice ? `${baseMessage}；${backendNotice}` : baseMessage;
      setStatusMessage(message);
      showToast(message, backendNotice ? "error" : "success");

      const initialPollingCdkeys = getPollableCdkeys(
        mergedRows.filter((row) => cdkeys.includes(row.cdkey))
      );
      if (initialPollingCdkeys.length) {
        startPolling(initialPollingCdkeys);
        setStatusMessage(
          `${baseMessage}；自动轮询已开启：每 5 秒查询 ${initialPollingCdkeys.length} 个 CDK`
        );
      }
      const refreshedRows = await queryStatuses(cdkeys, {
        silent: true,
        baseRows: mergedRows
      });
      const pollingBaseRows = refreshedRows.length ? refreshedRows : mergedRows;
      const pollingCdkeys = getPollableCdkeys(
        pollingBaseRows.filter((row) => cdkeys.includes(row.cdkey))
      );
      if (pollingCdkeys.length) {
        if (pollingCdkeys.join("|") !== initialPollingCdkeys.join("|")) {
          startPolling(pollingCdkeys);
        }
        setStatusMessage(`${baseMessage}；自动轮询已开启`);
      } else {
        stopPolling();
        setStatusMessage(`${baseMessage}；当前任务都已是终态`);
      }
      return true;
    } catch (error) {
      setStatusMessage(error.message);
      showToast(error.message, "error");
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function submitRedeems(options = {}) {
    selectWorkspaceTab("execute");
    const selectedTaskRows = rowsRef.current.filter(
      (row) => row.selected && !isHistoricalAutoCycleRow(row)
    );
    if (selectedTaskRows.length) {
      await submitSelectedRedeemRows(selectedTaskRows);
      return;
    }

    try {
      stopPolling();
      setIsBusy(true);
      const existingRows = rowsRef.current;
      const retainedRows = existingRows.filter(
        (row) => isContinuationBlockingRow(row) || isHistoricalAutoCycleRow(row)
      );
      const hasExistingAccountTasks = retainedRows.some(isContinuationBlockingRow);
      const submitPoolId = String(options.poolId || "").trim();
      const cdkeyValidationForSubmit =
        (typeof getSubmitCdkeyValidation === "function"
          ? getSubmitCdkeyValidation(submitPoolId)
          : submitCdkeyValidation) || submitCdkeyValidation;
      const submitPoolLabel =
        submitPoolId
          ? String(
              options.poolLabel ||
                cdkeyValidationForSubmit.cdkeys.find((cdkey) => cdkey.poolId === submitPoolId)
                  ?.poolLabel ||
                ""
            )
          : "";
      const poolMessagePrefix = formatPoolMessagePrefix(submitPoolLabel);
      const baseErrors = [...accountValidation.errors, ...cdkeyValidationForSubmit.errors];
      setStatusMessage(`${poolMessagePrefix}正在预检 ${cdkeyValidationForSubmit.cdkeys.length} 张 CDK 状态`);
      const preflight = await preflightCdkeysForSubmit(cdkeyValidationForSubmit.cdkeys, existingRows);
      const queriedCdkeyMessage = formatQueriedCdkeyMessage(preflight.queriedCdkeys, submitPoolLabel);
      if (queriedCdkeyMessage) setStatusMessage(queriedCdkeyMessage);
      const submitAccountAvailability = getSubmitAccountAvailability({
        accounts: accountValidation.accounts,
        rowList: existingRows,
        cycleState: autoCycleRef.current,
        cooldowns: accountCooldownsRef.current,
        attemptLedger: accountAttemptLedgerRef.current,
        failedAccounts: failedAccountsRef.current
      });
      const prepared = buildPooledSubmitRows({
        accounts: accountValidation.accounts,
        cdkeys: preflight.availableCdkeys,
        existingRows: retainedRows,
        blockedEmails: submitAccountAvailability.blockedEmails,
        availableAccounts: submitAccountAvailability.availableAccounts,
        reservedAccessTokens: options.reservedAccessTokens,
        rowOffset: retainedRows.length
      });
      const nextPreflightSummary = {
        ...preflight.summary,
        waitingAccounts: prepared.waitingAccounts,
        waitingCdkeys: prepared.waitingCdkeys,
        submitted: prepared.rows.length
      };
      setPreflightSummary(nextPreflightSummary);
      const nextErrors = [...baseErrors, ...preflight.errors, ...prepared.errors];
      setErrors(nextErrors);

      if (!prepared.rows.length) {
        const noSubmitSummary = {
          submitted: 0,
          poolId: submitPoolId,
          waitingAccounts: prepared.waitingAccounts,
          pollableCdkeys: []
        };
        const cancelledResubmitRows = submitPoolId ? [] : existingRows.filter(isCancelledResubmitRow);
        if (cancelledResubmitRows.length) {
          await submitSelectedRedeemRows(cancelledResubmitRows, {
            sourceLabel: "已取消任务"
          });
          return;
        }

        if (!hasExistingAccountTasks) {
          if (retainedRows.length) {
            rowsRef.current = retainedRows;
            setRows(retainedRows);
          } else {
            rowsRef.current = [];
            setRows([]);
          }
          const message = buildNoSubmitMessage(
            preflight.summary,
            prepared,
            nextErrors,
            hasExistingAccountTasks,
            submitAccountAvailability
          );
          const displayMessage = `${poolMessagePrefix}${message}`;
          setStatusMessage(displayMessage);
          showToast(displayMessage, "error");
          return noSubmitSummary;
        }
        const message = buildNoSubmitMessage(
          preflight.summary,
          prepared,
          nextErrors,
          hasExistingAccountTasks,
          submitAccountAvailability
        );
        const displayMessage = `${poolMessagePrefix}${message}`;
        setStatusMessage(displayMessage);
        showToast(displayMessage, "error");
        return noSubmitSummary;
      }

      const preparedRows = submitPoolId
        ? prepared.rows.map((row) => ({
            ...row,
            submitPoolId,
            submitPoolLabel
          }))
        : prepared.rows;
      prepareAutoCycleForSubmit(preparedRows, !hasExistingAccountTasks);
      const submittingRows = decorateInitialAutoCycleRows(preparedRows).map((row) => ({
        ...row,
        status: "submitting"
      }));
      const baseRows = markStatusOwners(
        retainedRows.length ? [...retainedRows, ...submittingRows] : submittingRows,
        submittingRows
      );
      forgetDeletedRows(submittingRows);
      setRows(baseRows);
      setStatusMessage(
        `${poolMessagePrefix}预检完成：可用 ${preflight.summary.available} 张，跳过已使用 ${preflight.summary.used} 张，查询失败 ${preflight.summary.unknown} 张；${hasExistingAccountTasks ? "正在续接提交" : "正在提交"} ${submittingRows.length} 条兑换任务，预计 ${batchCount(submittingRows.length)} 批`
      );

      const command = buildSubmitCommand(submittingRows);
      const payload = await callProxy(command.path, command.body);
      const submitBackendNotice = getBackendResponseNotice(payload, "后台没有返回提交明细");
      const attemptCountByEmail = recordAccountSubmissionAttempts(submittingRows);

      const actionAt = Date.now();
      const submittedRows = submittingRows.map((row) => ({
        ...row,
        status: "pending_dispatch",
        reason: SUBMIT_STATUS_HOLD_REASON,
        can_cancel: true,
        can_retry: false,
        retryRequestedAt: actionAt,
        retryHoldUntil: actionAt + RETRY_STATUS_HOLD_MS,
        staleStatusGuard: true,
        staleStatusGuardStartedAt: actionAt,
        accountCooldownUntil: 0,
        accountCooldownReason: "",
        accountAttemptNumber: getSubmittedAttemptNumber(row, attemptCountByEmail),
        attemptNumber: getSubmittedAttemptNumber(row, attemptCountByEmail),
        statusOwner: true
      }));
      const submittedRowsById = new Map(submittedRows.map((row) => [row.id, row]));
      const rowsWithSubmittedStatus = markStatusOwners(
        baseRows.map((row) => submittedRowsById.get(row.id) || row),
        submittedRows
      );
      let mergedRows = applyStatusItemsToRows(
        rowsWithSubmittedStatus,
        submittedRows.map((row) => row.cdkey),
        payload.items,
        payload
      );
      mergedRows = registerCooldownsFromRows(mergedRows);
      const scheduledAutoCycleCount = scheduleAutoCycleFailures(mergedRows, { silent: false });
      const autoCycleNotice = scheduledAutoCycleCount
        ? `，检测到 ${scheduledAutoCycleCount} 条失败，1 秒内合并后自动换号`
        : "";
      setRows(mergedRows);
      rowsRef.current = mergedRows;
      setLastUpdatedAt(new Date().toLocaleString());
      setStatusMessage(
        submitBackendNotice
          ? `${poolMessagePrefix}提交完成${autoCycleNotice}，开始自动查询兑换状态；${submitBackendNotice}`
          : `${poolMessagePrefix}提交完成${autoCycleNotice}，开始自动查询兑换状态`
      );
      if (submitBackendNotice) {
        showToast(submitBackendNotice, "error");
      }
      const submittedCdkeys = submittedRows.map((row) => row.cdkey);
      const initialPollingCdkeys = getPollableCdkeys(
        mergedRows.filter((row) => submittedCdkeys.includes(row.cdkey))
      );
      if (initialPollingCdkeys.length) {
        startPolling(initialPollingCdkeys);
        setStatusMessage(
          `${poolMessagePrefix}提交完成${autoCycleNotice}，自动轮询已开启：每 5 秒查询 ${initialPollingCdkeys.length} 个 CDK，正在同步最新状态`
        );
      }
      const refreshedRows = await queryStatuses(submittedCdkeys, {
        silent: true,
        baseRows: mergedRows
      });
      const pollingBaseRows = refreshedRows.length ? refreshedRows : mergedRows;
      const pollingCdkeys = getPollableCdkeys(pollingBaseRows);
      if (pollingCdkeys.length) {
        if (pollingCdkeys.join("|") !== initialPollingCdkeys.join("|")) {
          startPolling(pollingCdkeys);
        }
        setStatusMessage(
          `${poolMessagePrefix}提交完成${autoCycleNotice}，自动轮询已开启：每 5 秒查询 ${pollingCdkeys.length} 个 CDK`
        );
      } else {
        stopPolling();
        setStatusMessage(`${poolMessagePrefix}提交完成${autoCycleNotice}，当前任务都已是终态，无需继续轮询`);
      }
      return {
        submitted: submittingRows.length,
        poolId: submitPoolId,
        waitingAccounts: prepared.waitingAccounts,
        pollableCdkeys: pollingCdkeys,
        submittedAccessTokens: submittingRows.map((row) => row.accessToken).filter(Boolean),
        submittedEmails: submittingRows.map((row) => row.email).filter(Boolean)
      };
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function retryRows(targetRows, options = {}) {
    const retryable = targetRows.filter(
      (row) => canRetryVisibleRow(row) && !isAccountAttemptBlocked(row.email)
    );
    const attemptBlocked = targetRows.filter(
      (row) => canRetryVisibleRow(row) && isAccountAttemptBlocked(row.email)
    );
    if (!retryable.length) {
      setStatusMessage(
        attemptBlocked.length
          ? `没有可重试的选中任务；${attemptBlocked.length} 个账号 24 小时内已超过 ${ACCOUNT_ATTEMPT_LIMIT} 次，等待冷却恢复`
          : options.emptyMessage ||
              "没有可重试的选中任务；失败/超时可重试，账号风控不可用不会重试"
      );
      if (attemptBlocked.length) syncAttemptCooldowns(accountAttemptLedgerRef.current, { silent: true });
      return;
    }

    await runJobAction({
      path: "/api/redeem/retry",
      rowsToAct: retryable,
      pendingMessage: options.pendingMessage || "正在重试任务",
      doneMessage: options.doneMessage || "重试请求已发送",
      afterActionStatus: "pending_dispatch",
      afterActionReason: RETRY_STATUS_HOLD_REASON,
      retryHoldMs: RETRY_STATUS_HOLD_MS,
      countAccountAttempt: true,
      refreshAfterAction: false,
      clearSelection: options.clearSelection
    });
  }

  async function retryOrResubmitRows(targetRows) {
    const retryable = targetRows.filter(canRetryVisibleRow);
    if (retryable.length) {
      await retryRows(retryable);
      return;
    }

    const resubmittable = targetRows.filter(canResubmitRedeemRow);
    if (resubmittable.length) {
      await submitSelectedRedeemRows(resubmittable);
      return;
    }

    await retryRows(targetRows);
  }

  async function retryFailedRows() {
    if (!failedRetryRows.length) {
      await retryRows(failedRetryRows, {
        emptyMessage:
          "没有可一键重试的失败任务；普通失败/超时可重试，账号风控不可用不会重试"
      });
      return;
    }

    const retryIds = new Set(failedRetryRows.map((row) => row.id));
    setRows((prev) => prev.map((row) => ({ ...row, selected: retryIds.has(row.id) })));

    await retryRows(failedRetryRows, {
      emptyMessage:
        "没有可一键重试的失败任务；普通失败/超时可重试，账号风控不可用不会重试",
      pendingMessage: "正在重试失败任务",
      doneMessage: "失败任务重试请求已发送",
      clearSelection: false
    });
  }

  async function runJobAction({
    path,
    rowsToAct,
    pendingMessage,
    doneMessage,
    afterActionStatus,
    afterActionReason,
    retryHoldMs = 0,
    refreshAfterAction = true,
    clearSelection = true,
    clearStaleStatusGuard = false,
    countAccountAttempt = false,
    afterSuccess
  }) {
    try {
      setIsBusy(true);
      const targetIds = new Set(rowsToAct.map((row) => row.id));
      const cdkeys = getRowCdkeys(rowsToAct);
      setStatusMessage(`${pendingMessage}：${cdkeys.length} 条`);
      const payload = await callProxy(path, { cdkeys });
      const backendNotice = getBackendResponseNotice(payload, "后台没有返回任务明细");
      const attemptCountByEmail = countAccountAttempt
        ? recordAccountSubmissionAttempts(rowsToAct)
        : new Map();
      if (clearStaleStatusGuard) {
        const nextRows = rowsRef.current.map((row) =>
          targetIds.has(row.id)
            ? {
                ...row,
                staleStatusGuard: false,
                staleStatusGuardStartedAt: 0,
                retryRequestedAt: 0,
                retryHoldUntil: 0
              }
            : row
        );
        setRows(nextRows);
        rowsRef.current = nextRows;
      }

      if (afterActionStatus) {
        const actionAt = Date.now();
        const retryHoldUntil = retryHoldMs > 0 ? actionAt + retryHoldMs : 0;
        const nextRows = markStatusOwners(rowsRef.current.map((row) =>
          targetIds.has(row.id)
            ? {
                ...row,
                ...createEmptySubscriptionState(),
                status: afterActionStatus,
                reason: afterActionReason || row.reason,
                can_cancel: afterActionStatus === "pending_dispatch" ? true : row.can_cancel,
                can_retry: false,
                retryRequestedAt: retryHoldMs > 0 ? actionAt : 0,
                retryHoldUntil,
                staleStatusGuard: true,
                staleStatusGuardStartedAt: actionAt,
                accountCooldownUntil: 0,
                accountCooldownReason: "",
                accountAttemptNumber: getSubmittedAttemptNumber(row, attemptCountByEmail),
                attemptNumber: getSubmittedAttemptNumber(row, attemptCountByEmail),
                statusOwner: true,
                selected: clearSelection ? false : row.selected
              }
            : row
        ), rowsToAct);
        setRows(nextRows);
        rowsRef.current = nextRows;
      }
      const successNotice =
        typeof afterSuccess === "function"
          ? String(afterSuccess({ rowsToAct, cdkeys, payload }) || "")
          : "";
      const noticeParts = [backendNotice, successNotice].filter(Boolean);
      setStatusMessage(
        `${doneMessage}：${cdkeys.length} 条${noticeParts.length ? `；${noticeParts.join("；")}` : ""}`
      );
      if (backendNotice) {
        showToast(backendNotice, "error");
      }
      if (!refreshAfterAction) {
        setLastUpdatedAt(new Date().toLocaleString());
        return;
      }

      const updatedRows = await queryStatuses(cdkeys, { silent: true });
      if (updatedRows.length) {
        setLastUpdatedAt(new Date().toLocaleString());
      }
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  return {
    retryFailedRows,
    retryOrResubmitRows,
    retryRows,
    runJobAction,
    submitRedeems,
    submitSelectedRedeemRows
  };
}
