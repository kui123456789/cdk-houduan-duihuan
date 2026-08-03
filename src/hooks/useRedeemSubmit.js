import {
  ACCOUNT_ATTEMPT_LIMIT,
  RETRY_STATUS_HOLD_MS,
  RETRY_STATUS_HOLD_REASON,
  SUBMIT_STATUS_HOLD_REASON
} from "../config/redeemConstants.js";
import {
  canAutomaticallyRetryBackendJob,
  createEmptySubscriptionState
} from "../redeemLogic.js";
import { markStatusOwners } from "../state/statusMerge.js";
import { createStatusReceivedEvent } from "../workflow/redeemEvents.js";
import {
  applyWorkflowEvent,
  createInitialWorkflowState,
  getVisibleRows
} from "../workflow/redeemTaskModel.js";
import { buildSubmitCommand } from "../workflow/workflowCommands.js";
import { getReservedAccountAccessTokens } from "../workflow/accountLedger.js";
import {
  mergeProxyPayloads,
  partitionRowsByConfirmedPayload,
  splitRowsByCredential,
  toTaskCredentialMode
} from "../workflow/credentialRouting.js";
import { isQueryOnlyRow } from "../domain/statusMeta.js";

function formatBlockedResubmitRows(blockedRows, describeSelectedRow) {
  if (!blockedRows.length) return "";
  const examples = blockedRows
    .slice(0, 3)
    .map(({ row, reason }) => `${describeSelectedRow(row)}：${reason}`)
    .join("；");
  return blockedRows.length > 3 ? `${examples}；另 ${blockedRows.length - 3} 条` : examples;
}

function applyStatusItemsToRows(rows, cdkeys, items, raw = null, options = {}) {
  return getVisibleRows(
    applyWorkflowEvent(
      createInitialWorkflowState({ rows }),
      {
        ...createStatusReceivedEvent({ cdkeys, items: items || [], raw }),
        force: options.force === true
      }
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

function getRowActionChannel(row) {
  return String(
    row?.channel || row?.pool || row?.queue || row?.redeem_channel || row?.cdkey_pool || ""
  ).trim();
}

function groupRowsByActionChannel(rows) {
  const groups = new Map();
  (rows || []).forEach((row) => {
    const channel = getRowActionChannel(row);
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push(row);
  });
  return [...groups.entries()].map(([channel, groupedRows]) => ({ channel, rows: groupedRows }));
}

export function selectSubmitAccountsForCredential(
  accounts,
  { hasUserApiKey = false } = {}
) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (hasUserApiKey) {
    return { accounts: list, blockedAccounts: [], credentialMode: "" };
  }
  return {
    accounts: list,
    blockedAccounts: [],
    credentialMode: "server"
  };
}

export function selectAccountsForAvailableCdkeys(accounts, cdkeys) {
  const list = Array.isArray(accounts) ? accounts : [];
  const capacity = Array.isArray(cdkeys) ? cdkeys.length : 0;
  return capacity > 0 ? list.slice(0, capacity) : [];
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
  hasUserApiKey = () => true,
  prepareSubmitAccounts = async (accounts) => ({ accounts, errors: [] }),
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
  forgetDeletedTaskRows = () => {},
  forgetDeletedRows,
  markSubmittedRowsInAutoCycle,
  recordAccountSubmissionAttempts,
  getSubmittedAttemptNumber,
  registerCooldownsFromRows,
  scheduleAutoCycleFailures,
  automaticRetryInFlightRef = { current: new Set() }
}) {
  function collectResubmitRows(targetRows) {
    const targetIds = new Set((targetRows || []).map((row) => String(row?.id || "")));
    const reservedAccessTokens = getReservedAccountAccessTokens(
      rowsRef.current.filter((row) => !targetIds.has(String(row?.id || "")))
    );
    const seenCdkeys = new Set();
    const seenAccessTokens = new Set();
    const resubmittable = [];
    const blocked = [];

    targetRows.forEach((row) => {
      if (isQueryOnlyRow(row)) {
        blocked.push({ row, reason: "仅查询 CDK 不能提交兑换操作" });
        return;
      }

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
      if (accessToken && reservedAccessTokens.has(accessToken)) {
        blocked.push({ row, reason: "该 AT 已有其他未完成任务，不能同时使用第二张卡密" });
        return;
      }
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

  function recoverSubmittingRows(targetRows, error, options = {}) {
    const targetIds = new Set((targetRows || []).map((row) => row?.id).filter(Boolean));
    if (!targetIds.size) return rowsRef.current;

    const errorMessage = String(error?.message || "提交请求失败").trim();
    const reasonPrefix = String(options.reasonPrefix || "提交请求失败，状态未确认").trim();
    const reason = `${reasonPrefix}：${errorMessage}`;
    const recoveredRows = markStatusOwners(
      rowsRef.current.map((row) =>
        targetIds.has(row.id)
          ? {
              ...row,
              status: "unknown",
              reason,
              can_cancel: false,
              can_retry: false,
              retryRequestedAt: 0,
              retryHoldUntil: 0,
              staleStatusGuard: false,
              staleStatusGuardStartedAt: 0,
              selected: false,
              statusOwner: true
            }
          : row
      ),
      targetRows
    );
    const cdkeys = getRowCdkeys(targetRows);
    const pollingCdkeys = getPollableCdkeys(
      recoveredRows.filter((row) => targetIds.has(row.id))
    );

    setRows(recoveredRows);
    rowsRef.current = recoveredRows;
    setLastUpdatedAt(new Date().toLocaleString());
    setStatusMessage(`${reason}；已转为未知并自动查询后台状态`);
    showToast(errorMessage, "error");

    if (pollingCdkeys.length) startPolling(pollingCdkeys);
    if (cdkeys.length) {
      void Promise.resolve(
        queryStatuses(cdkeys, {
          silent: true,
          forceRemote: true,
          skipAutoCycle: true,
          baseRows: recoveredRows
        })
      ).catch(() => {});
    }

    return recoveredRows;
  }

  function getAutomaticRetryInFlightSet() {
    if (!(automaticRetryInFlightRef.current instanceof Set)) {
      automaticRetryInFlightRef.current = new Set();
    }
    return automaticRetryInFlightRef.current;
  }

  async function autoRetryRows(targetRows, options = {}) {
    const inFlightCdkeys = getAutomaticRetryInFlightSet();
    const seenCdkeys = new Set();
    const alreadyInFlight = [];
    const retryable = (targetRows || []).filter((row) => {
      const cdkey = String(row?.cdkey || "").trim();
      if (!cdkey || seenCdkeys.has(cdkey)) return false;
      if (!canAutomaticallyRetryBackendJob(row)) return false;
      if (!canRetryVisibleRow(row) || isAccountAttemptBlocked(row.email)) return false;
      seenCdkeys.add(cdkey);
      if (inFlightCdkeys.has(cdkey)) {
        alreadyInFlight.push(row);
        return false;
      }
      return true;
    });

    if (alreadyInFlight.length) {
      const protectedAt = Date.now();
      const protectedIds = new Set(alreadyInFlight.map((row) => String(row?.id || "")));
      const protectedRows = markStatusOwners(
        rowsRef.current.map((row) =>
          protectedIds.has(String(row?.id || ""))
            ? {
                ...row,
                ...createEmptySubscriptionState(),
                status: "pending_dispatch",
                reason: "自动重试正在进行，等待后台确认",
                can_cancel: false,
                can_retry: false,
                retryRequestedAt: Number(row?.retryRequestedAt || 0) || protectedAt,
                retryHoldUntil: Math.max(
                  Number(row?.retryHoldUntil || 0),
                  protectedAt + RETRY_STATUS_HOLD_MS
                ),
                staleStatusGuard: true,
                staleStatusGuardStartedAt:
                  Number(row?.staleStatusGuardStartedAt || 0) || protectedAt,
                statusOwner: true
              }
            : row
        ),
        alreadyInFlight
      );
      setRows(protectedRows);
      rowsRef.current = protectedRows;
    }

    if (!retryable.length) {
      return {
        attempted: 0,
        confirmedRows: [],
        unconfirmedRows: [],
        rows: rowsRef.current
      };
    }

    retryable.forEach((row) => inFlightCdkeys.add(String(row.cdkey || "").trim()));
    try {
      const result = await retryRows(retryable, {
        pendingMessage: options.pendingMessage || "检测到可重试失败，正在自动重试",
        doneMessage: options.doneMessage || "自动重试请求已发送",
        clearSelection: false,
        manageBusy: false,
        automatic: true
      });
      return {
        attempted: retryable.length,
        ...(result || {}),
        rows: rowsRef.current
      };
    } finally {
      retryable.forEach((row) => inFlightCdkeys.delete(String(row.cdkey || "").trim()));
    }
  }

  async function submitSelectedRedeemRows(targetRows, options = {}) {
    const sourceLabel = options.sourceLabel || "选中";
    const { resubmittable, blocked } = collectResubmitRows(targetRows);
    const prepared = await prepareSubmitAccounts(resubmittable);
    const preparedRows = Array.isArray(prepared.accounts) ? prepared.accounts : [];
    const candidateSubmitRows = preparedRows.filter((row) => !isQueryOnlyRow(row));
    const credentialRouting = splitRowsByCredential(candidateSubmitRows, {
      hasUserApiKey: hasUserApiKey()
    });
    const submitGroups = credentialRouting.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => ({
        ...row,
        credentialMode: toTaskCredentialMode(group.credentialMode)
      }))
    }));
    const submitRows = submitGroups.flatMap((group) => group.rows);
    const queryOnlyBlocked = preparedRows
      .filter(isQueryOnlyRow)
      .map((row) => ({ row, reason: "仅查询 CDK 不能提交兑换操作" }));
    const credentialBlocked = credentialRouting.blockedRows.map((row) => ({
      row,
      reason: "原任务使用用户 API Key，但当前用户 API Key 不可用"
    }));
    const refreshBlocked = (prepared.errors || []).map((error) => ({
      row: resubmittable.find(
        (candidate) => String(candidate?.email || "").trim().toLowerCase() ===
          String(error?.source || "").split("---")[0]?.trim().toLowerCase()
      ) || { email: String(error?.source || "") },
      reason: error.reason || "Session 刷新失败"
    }));
    const allBlocked = [...blocked, ...refreshBlocked, ...queryOnlyBlocked, ...credentialBlocked];
    const blockedText = formatBlockedResubmitRows(allBlocked, describeSelectedRow);

    if (!submitRows.length) {
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
      const targetIds = new Set(submitRows.map((row) => row.id));
      const submitRowsById = new Map(submitRows.map((row) => [row.id, row]));
      const cdkeys = getRowCdkeys(submitRows);
      const submittingRows = markStatusOwners(rowsRef.current.map((row) =>
        targetIds.has(row.id)
          ? {
              ...row,
              credentialMode: submitRowsById.get(row.id)?.credentialMode || row.credentialMode || "",
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
      ), submitRows);
      forgetDeletedRows(submitRows);
      setRows(submittingRows);
      rowsRef.current = submittingRows;
      setStatusMessage(`正在重新提交${sourceLabel} ${submitRows.length} 条兑换任务`);

      const payloads = [];
      for (const group of submitGroups) {
        const command = buildSubmitCommand(group.rows);
        payloads.push(
          await callProxy(command.path, command.body, {
            ...command.options,
            credentialMode: group.credentialMode
          })
        );
      }
      const payload = mergeProxyPayloads(payloads);
      const backendNotice = getBackendResponseNotice(payload, "后台没有返回提交明细");
      const { confirmedRows, unconfirmedRows, confirmedItems } = partitionRowsByConfirmedPayload(
        submitRows,
        payload,
        { mode: "submit" }
      );
      const confirmedIds = new Set(confirmedRows.map((row) => row.id));
      markSubmittedRowsInAutoCycle(confirmedRows);
      const attemptCountByEmail = recordAccountSubmissionAttempts(confirmedRows);
      const actionAt = Date.now();
      const submittedRows = markStatusOwners(rowsRef.current.map((row) =>
        confirmedIds.has(row.id)
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
          : targetIds.has(row.id)
            ? {
                ...row,
                status: "unknown",
                reason: "重新提交响应未确认，正在查询后台",
                can_cancel: false,
                can_retry: false,
                selected: false,
                staleStatusGuard: false,
                staleStatusGuardStartedAt: 0,
                statusOwner: true
              }
          : row
      ), [...confirmedRows, ...unconfirmedRows]);
      let mergedRows = applyStatusItemsToRows(
        submittedRows,
        cdkeys,
        confirmedItems,
        payload,
        { force: true }
      );
      mergedRows = registerCooldownsFromRows(mergedRows);
      setRows(mergedRows);
      rowsRef.current = mergedRows;
      const automaticRetryResult = await autoRetryRows(
        mergedRows.filter((row) => targetIds.has(row.id))
      );
      mergedRows = rowsRef.current;
      const scheduledAutoCycleCount = scheduleAutoCycleFailures(mergedRows, { silent: false });
      setLastUpdatedAt(new Date().toLocaleString());

      const skippedText = allBlocked.length ? `；${allBlocked.length} 条未提交：${blockedText}` : "";
      const automaticRetryText = automaticRetryResult.confirmedRows?.length
        ? `；已自动重试 ${automaticRetryResult.confirmedRows.length} 条`
        : automaticRetryResult.attempted
          ? `；${automaticRetryResult.attempted} 条自动重试未获后台确认`
          : "";
      const autoCycleText = scheduledAutoCycleCount
        ? `；检测到 ${scheduledAutoCycleCount} 条失败，1 秒内合并后自动换号`
        : "";
      const confirmationText = unconfirmedRows.length
        ? `，其中 ${unconfirmedRows.length} 条响应未确认`
        : "";
      const baseMessage = `已重新提交${sourceLabel} ${submitRows.length} 条${confirmationText}，等待后台更新${automaticRetryText}${autoCycleText}${skippedText}`;
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
      recoverSubmittingRows(submitRows, error, {
        reasonPrefix: "重新提交请求失败，状态未确认"
      });
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function submitRedeems(options = {}) {
    selectWorkspaceTab("execute");
    let activeSubmittingRows = [];

    try {
      stopPolling();
      setIsBusy(true);
      const existingRows = rowsRef.current;
      const retainedRows = existingRows.filter(
        (row) =>
          isContinuationBlockingRow(row) ||
          isHistoricalAutoCycleRow(row) ||
          Boolean(getAccountCooldown(row?.email, accountCooldownsRef.current))
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
      const credentialSelection = selectSubmitAccountsForCredential(accountValidation.accounts, {
        hasUserApiKey: hasUserApiKey()
      });
      const credentialErrors = credentialSelection.blockedAccounts.map((account) => ({
        lineNumber: account?.lineNumber,
        source: account?.source || account?.email || "",
        type: "account_api_key_required",
        reason: "账号缺少可用兑换凭证"
      }));
      setStatusMessage(`${poolMessagePrefix}正在预检 ${cdkeyValidationForSubmit.cdkeys.length} 张 CDK 状态`);
      const preflight = await preflightCdkeysForSubmit(
        cdkeyValidationForSubmit.cdkeys,
        existingRows,
        { credentialMode: credentialSelection.credentialMode }
      );
      const queriedCdkeyMessage = formatQueriedCdkeyMessage(preflight.queriedCdkeys, submitPoolLabel);
      if (queriedCdkeyMessage) setStatusMessage(queriedCdkeyMessage);
      const preliminaryAccountAvailability = getSubmitAccountAvailability({
        accounts: credentialSelection.accounts,
        rowList: existingRows,
        cycleState: autoCycleRef.current,
        cooldowns: accountCooldownsRef.current,
        attemptLedger: accountAttemptLedgerRef.current,
        failedAccounts: failedAccountsRef.current
      });
      const accountsToPrepare = selectAccountsForAvailableCdkeys(
        preliminaryAccountAvailability.availableAccounts,
        preflight.availableCdkeys
      );
      const preparedCredentials = await prepareSubmitAccounts(accountsToPrepare);
      const baseErrors = [
        ...accountValidation.errors,
        ...credentialErrors,
        ...(preparedCredentials.errors || []),
        ...cdkeyValidationForSubmit.errors
      ];
      const submitAccountAvailability = getSubmitAccountAvailability({
        accounts: preparedCredentials.accounts,
        rowList: existingRows,
        cycleState: autoCycleRef.current,
        cooldowns: accountCooldownsRef.current,
        attemptLedger: accountAttemptLedgerRef.current,
        failedAccounts: failedAccountsRef.current
      });
      const prepared = buildPooledSubmitRows({
        accounts: preparedCredentials.accounts,
        cdkeys: preflight.availableCdkeys,
        existingRows: retainedRows,
        blockedEmails: submitAccountAvailability.blockedEmails,
        availableAccounts: submitAccountAvailability.availableAccounts,
        reservedAccessTokens: options.reservedAccessTokens,
        rowOffset: retainedRows.length
      });
      const actionablePreparedRows = prepared.rows.filter((row) => !isQueryOnlyRow(row));
      const totalWaitingAccountCount = Math.max(
        preliminaryAccountAvailability.availableAccounts.length - actionablePreparedRows.length,
        0
      );
      const nextPreflightSummary = {
        ...preflight.summary,
        waitingAccounts: totalWaitingAccountCount,
        waitingCdkeys: prepared.waitingCdkeys,
        submitted: actionablePreparedRows.length
      };
      setPreflightSummary(nextPreflightSummary);
      const nextErrors = [...baseErrors, ...preflight.errors, ...prepared.errors];
      setErrors(nextErrors);

      if (!actionablePreparedRows.length) {
        const noSubmitSummary = {
          submitted: 0,
          poolId: submitPoolId,
          waitingAccounts: totalWaitingAccountCount,
          pollableCdkeys: []
        };
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

      const taskCredentialMode = toTaskCredentialMode(credentialSelection.credentialMode);
      const preparedRows = (submitPoolId
        ? actionablePreparedRows.map((row) => ({
            ...row,
            submitPoolId,
            submitPoolLabel
          }))
        : actionablePreparedRows
      ).map((row) => ({
        ...row,
        credentialMode: taskCredentialMode
      }));
      prepareAutoCycleForSubmit(preparedRows, !hasExistingAccountTasks);
      const submittingRows = decorateInitialAutoCycleRows(preparedRows).map((row) => ({
        ...row,
        status: "submitting"
      }));
      activeSubmittingRows = submittingRows;
      const baseRows = markStatusOwners(
        retainedRows.length ? [...retainedRows, ...submittingRows] : submittingRows,
        submittingRows
      );
      forgetDeletedTaskRows(submittingRows);
      forgetDeletedRows(submittingRows);
      setRows(baseRows);
      rowsRef.current = baseRows;
      setStatusMessage(
        `${poolMessagePrefix}预检完成：可用 ${preflight.summary.available} 张，跳过已使用 ${preflight.summary.used} 张，查询失败 ${preflight.summary.unknown} 张；${hasExistingAccountTasks ? "正在续接提交" : "正在提交"} ${submittingRows.length} 条兑换任务，预计 ${batchCount(submittingRows.length)} 批`
      );

      const command = buildSubmitCommand(submittingRows);
      const payload = await callProxy(command.path, command.body, {
        ...command.options,
        credentialMode: credentialSelection.credentialMode
      });
      const submitBackendNotice = getBackendResponseNotice(payload, "后台没有返回提交明细");
      const { confirmedRows, unconfirmedRows, confirmedItems } = partitionRowsByConfirmedPayload(
        submittingRows,
        payload,
        { mode: "submit" }
      );
      const confirmedIds = new Set(confirmedRows.map((row) => row.id));
      const attemptCountByEmail = recordAccountSubmissionAttempts(confirmedRows);

      const actionAt = Date.now();
      const submittedRows = submittingRows.map((row) => ({
        ...row,
        status: confirmedIds.has(row.id) ? "pending_dispatch" : "unknown",
        reason: confirmedIds.has(row.id)
          ? SUBMIT_STATUS_HOLD_REASON
          : "提交响应未确认，正在查询后台",
        can_cancel: confirmedIds.has(row.id),
        can_retry: false,
        retryRequestedAt: confirmedIds.has(row.id) ? actionAt : 0,
        retryHoldUntil: confirmedIds.has(row.id) ? actionAt + RETRY_STATUS_HOLD_MS : 0,
        staleStatusGuard: confirmedIds.has(row.id),
        staleStatusGuardStartedAt: confirmedIds.has(row.id) ? actionAt : 0,
        accountCooldownUntil: 0,
        accountCooldownReason: "",
        accountAttemptNumber: confirmedIds.has(row.id)
          ? getSubmittedAttemptNumber(row, attemptCountByEmail)
          : row.accountAttemptNumber,
        attemptNumber: confirmedIds.has(row.id)
          ? getSubmittedAttemptNumber(row, attemptCountByEmail)
          : row.attemptNumber,
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
        confirmedItems,
        payload,
        { force: true }
      );
      mergedRows = registerCooldownsFromRows(mergedRows);
      setRows(mergedRows);
      rowsRef.current = mergedRows;
      const automaticRetryResult = await autoRetryRows(
        mergedRows.filter((row) => confirmedIds.has(row.id))
      );
      mergedRows = rowsRef.current;
      const scheduledAutoCycleCount = scheduleAutoCycleFailures(mergedRows, { silent: false });
      const automaticRetryNotice = automaticRetryResult.confirmedRows?.length
        ? `，已自动重试 ${automaticRetryResult.confirmedRows.length} 条`
        : automaticRetryResult.attempted
          ? `，${automaticRetryResult.attempted} 条自动重试未获后台确认`
          : "";
      const autoCycleNotice = scheduledAutoCycleCount
        ? `，检测到 ${scheduledAutoCycleCount} 条失败，1 秒内合并后自动换号`
        : "";
      setLastUpdatedAt(new Date().toLocaleString());
      const submitConfirmationNotice = unconfirmedRows.length
        ? `；${unconfirmedRows.length} 条响应未确认，保持未知并查询后台`
        : "";
      setStatusMessage(
        submitBackendNotice
          ? `${poolMessagePrefix}提交完成${automaticRetryNotice}${autoCycleNotice}，开始自动查询兑换状态；${submitBackendNotice}${submitConfirmationNotice}`
          : `${poolMessagePrefix}提交完成${automaticRetryNotice}${autoCycleNotice}，开始自动查询兑换状态${submitConfirmationNotice}`
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
          `${poolMessagePrefix}提交完成${automaticRetryNotice}${autoCycleNotice}，自动轮询已开启：每 5 秒查询 ${initialPollingCdkeys.length} 个 CDK，正在同步最新状态`
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
          `${poolMessagePrefix}提交完成${automaticRetryNotice}${autoCycleNotice}，自动轮询已开启：每 5 秒查询 ${pollingCdkeys.length} 个 CDK`
        );
      } else {
        stopPolling();
        setStatusMessage(`${poolMessagePrefix}提交完成${automaticRetryNotice}${autoCycleNotice}，当前任务都已是终态，无需继续轮询`);
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
      if (activeSubmittingRows.length) {
        recoverSubmittingRows(activeSubmittingRows, error);
      } else {
        const message = error?.message || "提交请求失败";
        setStatusMessage(message);
        showToast(message, "error");
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function retryRows(targetRows, options = {}) {
    const retryable = targetRows.filter(
      (row) =>
        !isQueryOnlyRow(row) &&
        canRetryVisibleRow(row) &&
        !isAccountAttemptBlocked(row.email)
    );
    const attemptBlocked = targetRows.filter(
      (row) =>
        !isQueryOnlyRow(row) &&
        canRetryVisibleRow(row) &&
        isAccountAttemptBlocked(row.email)
    );
    if (!retryable.length) {
      const blockedAccountCount = new Set(
        attemptBlocked
          .map((row) => String(row?.email || "").trim().toLowerCase())
          .filter(Boolean)
      ).size;
      if (attemptBlocked.length) {
        syncAttemptCooldowns(accountAttemptLedgerRef.current, { silent: true });
      }
      setStatusMessage(
        attemptBlocked.length
          ? `没有可重试的选中任务；${blockedAccountCount} 个账号 24 小时内已达到 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次，已进入 24 小时冷却池`
          : options.emptyMessage ||
              "没有可重试的选中任务；失败/超时可重试，账号风控不可用不会重试"
      );
      return {
        requested: 0,
        confirmedRows: [],
        unconfirmedRows: [],
        rows: rowsRef.current
      };
    }

    return await runJobAction({
      path: "/api/redeem/retry",
      rowsToAct: retryable,
      pendingMessage: options.pendingMessage || "正在重试任务",
      doneMessage: options.doneMessage || "重试请求已发送",
      afterActionStatus: "pending_dispatch",
      afterActionReason: RETRY_STATUS_HOLD_REASON,
      retryHoldMs: RETRY_STATUS_HOLD_MS,
      countAccountAttempt: true,
      refreshAfterAction: false,
      clearSelection: options.clearSelection,
      manageBusy: options.manageBusy !== false
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
    afterSuccess,
    manageBusy = true
  }) {
    const isRetryAction = path === "/api/redeem/retry";
    const isChannelScopedAction = isRetryAction || path === "/api/redeem/cancel";
    let actionRows = [];
    let retryActionAt = 0;
    let originalRetryRowsById = new Map();
    try {
      if (manageBusy) setIsBusy(true);
      const credentialRouting = splitRowsByCredential(rowsToAct, {
        hasUserApiKey: hasUserApiKey()
      });
      actionRows = credentialRouting.groups.flatMap((group) => group.rows);
      if (!actionRows.length) {
        setStatusMessage("没有可处理的兑换任务");
        return {
          requested: 0,
          confirmedRows: [],
          unconfirmedRows: [],
          rows: rowsRef.current
        };
      }
      const cdkeys = getRowCdkeys(actionRows);
      if (isRetryAction) {
        retryActionAt = Date.now();
        originalRetryRowsById = new Map(
          actionRows.map((row) => [String(row?.id || ""), row])
        );
        const actionIds = new Set(originalRetryRowsById.keys());
        const retryHoldUntil = retryActionAt + Math.max(retryHoldMs, RETRY_STATUS_HOLD_MS);
        const protectedRows = markStatusOwners(
          rowsRef.current.map((row) =>
            actionIds.has(String(row?.id || ""))
              ? {
                  ...row,
                  ...createEmptySubscriptionState(),
                  status: "pending_dispatch",
                  reason: "重试请求已发送，正在等待后台确认",
                  can_cancel: false,
                  can_retry: false,
                  retryRequestedAt: retryActionAt,
                  retryHoldUntil,
                  staleStatusGuard: true,
                  staleStatusGuardStartedAt: retryActionAt,
                  statusOwner: true,
                  selected: clearSelection ? false : row.selected
                }
              : row
          ),
          actionRows
        );
        setRows(protectedRows);
        rowsRef.current = protectedRows;
      }
      setStatusMessage(`${pendingMessage}：${cdkeys.length} 条`);
      const payloads = [];
      for (const group of credentialRouting.groups) {
        const requestGroups = isChannelScopedAction
          ? groupRowsByActionChannel(group.rows)
          : [{ channel: "", rows: group.rows }];
        for (const requestGroup of requestGroups) {
          payloads.push(
            await callProxy(
              path,
              {
                cdkeys: getRowCdkeys(requestGroup.rows),
                ...(requestGroup.channel ? { channel: requestGroup.channel } : {})
              },
              { credentialMode: group.credentialMode }
            )
          );
        }
      }
      const payload = mergeProxyPayloads(payloads);
      const backendNotice = getBackendResponseNotice(payload, "后台没有返回任务明细");
      const { confirmedRows, unconfirmedRows, rejectedRows = [] } = partitionRowsByConfirmedPayload(
        actionRows,
        payload,
        { mode: isRetryAction ? "retry" : "action" }
      );
      const confirmedIds = new Set(confirmedRows.map((row) => row.id));
      const rejectedIds = new Set(rejectedRows.map((row) => row.id));
      const ambiguousRows = unconfirmedRows.filter((row) => !rejectedIds.has(row.id));
      const attemptCountByEmail = countAccountAttempt
        ? recordAccountSubmissionAttempts(confirmedRows)
        : new Map();
      if (isRetryAction && rejectedIds.size) {
        const restoredRows = rowsRef.current.map((row) => {
          const rowId = String(row?.id || "");
          const original = originalRetryRowsById.get(rowId);
          if (
            !rejectedIds.has(row.id) ||
            !original ||
            Number(row?.retryRequestedAt || 0) !== retryActionAt
          ) {
            return row;
          }
          return {
            ...row,
            ...original,
            retryRequestedAt: 0,
            retryHoldUntil: 0,
            staleStatusGuard: false,
            staleStatusGuardStartedAt: 0,
            selected: clearSelection ? false : original.selected,
            statusOwner: true
          };
        });
        setRows(restoredRows);
        rowsRef.current = restoredRows;
      }
      if (clearStaleStatusGuard) {
        const nextRows = rowsRef.current.map((row) =>
          confirmedIds.has(row.id)
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
          confirmedIds.has(row.id) &&
          (!isRetryAction || Number(row?.retryRequestedAt || 0) === retryActionAt)
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
        ), confirmedRows);
        setRows(nextRows);
        rowsRef.current = nextRows;
      }
      const successNotice =
        typeof afterSuccess === "function"
          ? String(afterSuccess({
              rowsToAct: confirmedRows,
              cdkeys: getRowCdkeys(confirmedRows),
              payload
            }) || "")
          : "";
      const blockedRowCount = credentialRouting.blockedRows.length;
      const blockedNotice = blockedRowCount
        ? `${blockedRowCount} 条任务不是可执行的兑换任务或缺少可用兑换凭证`
        : "";
      const rejectedNotice = rejectedRows.length
        ? `${rejectedRows.length} 条后端明确未重试，保持失败状态`
        : "";
      const unconfirmedNotice = ambiguousRows.length
        ? `${ambiguousRows.length} 条响应未确认，已保护任务并查询后台`
        : "";
      const noticeParts = [
        backendNotice,
        successNotice,
        rejectedNotice,
        unconfirmedNotice,
        blockedNotice
      ].filter(Boolean);
      setStatusMessage(
        `${doneMessage}：确认 ${confirmedRows.length}/${cdkeys.length} 条${noticeParts.length ? `；${noticeParts.join("；")}` : ""}`
      );
      if (backendNotice) {
        showToast(backendNotice, "error");
      }
      if (!refreshAfterAction) {
        if (unconfirmedRows.length) {
          await queryStatuses(getRowCdkeys(unconfirmedRows), {
            silent: true,
            skipAutoRetry: true,
            skipAutoCycle: true
          });
        }
        const pollingCdkeys = getPollableCdkeys(rowsRef.current);
        if (pollingCdkeys.length) {
          startPolling(pollingCdkeys);
        }
        setLastUpdatedAt(new Date().toLocaleString());
        return {
          requested: actionRows.length,
          confirmedRows,
          unconfirmedRows,
          rejectedRows,
          payload,
          rows: rowsRef.current
        };
      }

      const updatedRows = await queryStatuses(cdkeys, { silent: true });
      if (updatedRows.length) {
        setLastUpdatedAt(new Date().toLocaleString());
      }
      return {
        requested: actionRows.length,
        confirmedRows,
        unconfirmedRows,
        rejectedRows,
        payload,
        rows: rowsRef.current
      };
    } catch (error) {
      if (isRetryAction && actionRows.length) {
        const cdkeys = getRowCdkeys(actionRows);
        setStatusMessage(`${error.message || "重试请求失败"}；重试结果未确认，已保护任务并查询后台`);
        await Promise.resolve(
          queryStatuses(cdkeys, {
            silent: true,
            skipAutoRetry: true,
            skipAutoCycle: true
          })
        ).catch(() => {});
        const pollingCdkeys = getPollableCdkeys(rowsRef.current);
        if (pollingCdkeys.length) startPolling(pollingCdkeys);
        setLastUpdatedAt(new Date().toLocaleString());
        return {
          requested: actionRows.length,
          confirmedRows: [],
          unconfirmedRows: actionRows,
          error,
          rows: rowsRef.current
        };
      }
      setStatusMessage(error.message);
      return {
        requested: 0,
        confirmedRows: [],
        unconfirmedRows: rowsToAct || [],
        error,
        rows: rowsRef.current
      };
    } finally {
      if (manageBusy) setIsBusy(false);
    }
  }

  return {
    autoRetryRows,
    retryFailedRows,
    retryOrResubmitRows,
    retryRows,
    runJobAction,
    submitRedeems,
    submitSelectedRedeemRows
  };
}
