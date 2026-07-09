import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACTIVE_BACKEND_STATUSES,
  AUTO_CYCLE_SCHEDULE_DELAY_MS,
  RETRY_STATUS_HOLD_MS,
  SUBMIT_STATUS_HOLD_REASON
} from "../config/redeemConstants.js";
import { canRetryFailedRow } from "../redeemLogic.js";
import { isAccountDailyLimitReason } from "../state/accountLifecycle.js";
import { markStatusOwners } from "../state/statusMerge.js";
import { createStatusReceivedEvent } from "../workflow/redeemEvents.js";
import {
  applyWorkflowEvent,
  createInitialWorkflowState,
  getVisibleRows
} from "../workflow/redeemTaskModel.js";
import { buildSubmitCommand } from "../workflow/workflowCommands.js";

function getReasonText(row) {
  const rawStatus = row?.rawStatus || {};
  return String(
    row?.reason ||
      row?.failureReason ||
      row?.message ||
      row?.error_message ||
      row?.errorMessage ||
      row?.result ||
      row?.state ||
      rawStatus?.status ||
      rawStatus?.message ||
      rawStatus?.error ||
      rawStatus?.error_message ||
      rawStatus?.errorMessage ||
      rawStatus?.reason ||
      rawStatus?.result ||
      rawStatus?.state ||
      ""
  ).trim();
}

function hasPmUnavailableMarker(row) {
  const rawStatus = row?.rawStatus || {};
  return [
    row?.status,
    row?.reason,
    row?.failureReason,
    row?.message,
    rawStatus?.status,
    rawStatus?.state,
    rawStatus?.result,
    rawStatus?.reason,
    rawStatus?.message
  ].some((value) => String(value || "").toLowerCase().includes("pm_unavailable"));
}

function defaultDailyLimitFailure(row) {
  return ["failed", "rejected", "cancelled"].includes(String(row?.status || "")) &&
    isAccountDailyLimitReason(getReasonText(row));
}

function withAutoCycleRuleDeps(deps = {}) {
  return {
    isAutoCycleEnabled: () => true,
    canRetryVisibleFailedRow: canRetryFailedRow,
    isDailyLimitFailureRow: defaultDailyLimitFailure,
    isCooldownReleaseCandidate: () => false,
    isAttemptExhaustedReleaseCandidate: () => false,
    requiresRowId: false,
    requiresEmail: false,
    requiresCdkey: false,
    ...deps
  };
}

function applyStatusItemsToRows(rows, cdkeys, items, raw = null) {
  return getVisibleRows(
    applyWorkflowEvent(
      createInitialWorkflowState({ rows }),
      createStatusReceivedEvent({ cdkeys, items: items || [], raw })
    )
  );
}

const AUTO_CYCLE_RESERVED_REPLACEMENT_STATUSES = new Set([
  "local_ready",
  "submitting",
  "querying",
  "success",
  "pm_unavailable",
  ...ACTIVE_BACKEND_STATUSES
]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccessToken(value) {
  return String(value || "").trim();
}

export function reserveAutoCycleReplacementEmail(reservedEmails, accountOrEmail) {
  const email = normalizeEmail(
    typeof accountOrEmail === "string" ? accountOrEmail : accountOrEmail?.email
  );
  if (email) reservedEmails.add(email);
  return email;
}

export function reserveAutoCycleReplacementAccessToken(reservedTokens, accountOrToken) {
  const token = normalizeAccessToken(
    typeof accountOrToken === "string" ? accountOrToken : accountOrToken?.accessToken
  );
  if (token) reservedTokens.add(token);
  return token;
}

export function buildAutoCycleReservedEmails(rowList = [], candidates = []) {
  const reservedEmails = new Set();

  candidates.forEach((row) => reserveAutoCycleReplacementEmail(reservedEmails, row));
  (rowList || []).forEach((row) => {
    if (row?.statusOwner === false) return;
    if (!AUTO_CYCLE_RESERVED_REPLACEMENT_STATUSES.has(String(row?.status || ""))) return;
    reserveAutoCycleReplacementEmail(reservedEmails, row);
  });

  return reservedEmails;
}

export function buildAutoCycleReservedAccessTokens(rowList = [], candidates = []) {
  const reservedTokens = new Set();

  candidates.forEach((row) => reserveAutoCycleReplacementAccessToken(reservedTokens, row));
  (rowList || []).forEach((row) => {
    if (row?.statusOwner === false) return;
    if (!AUTO_CYCLE_RESERVED_REPLACEMENT_STATUSES.has(String(row?.status || ""))) return;
    reserveAutoCycleReplacementAccessToken(reservedTokens, row);
  });

  return reservedTokens;
}

export function shouldReleaseCdkeyForNextAccount(row, deps = {}) {
  const helpers = withAutoCycleRuleDeps(deps);
  if ((helpers.requiresCdkey && !row?.cdkey) || hasPmUnavailableMarker(row)) return false;
  return (
    helpers.canRetryVisibleFailedRow(row) ||
    helpers.isDailyLimitFailureRow(row) ||
    helpers.isCooldownReleaseCandidate(row) ||
    helpers.isAttemptExhaustedReleaseCandidate(row)
  );
}

export function isAutoCycleFailureCandidate(row, deps = {}) {
  const helpers = withAutoCycleRuleDeps(deps);
  return (
    helpers.isAutoCycleEnabled() === true &&
    (!helpers.requiresRowId || row?.id) &&
    (!helpers.requiresCdkey || row?.cdkey) &&
    row?.statusOwner !== false &&
    row.autoCycleHandled !== true &&
    row.statusLocked !== true &&
    String(row?.status || "") !== "pm_unavailable" &&
    shouldReleaseCdkeyForNextAccount(row, helpers) &&
    (!helpers.requiresEmail || Boolean(row.email))
  );
}

export function useAutoCycle({
  rowsRef,
  autoCycleRef,
  autoCycleScheduleTimerRef,
  autoCycleProcessingRef,
  setRows,
  setStatusMessage,
  setLastUpdatedAt,
  callProxy,
  registerCooldownsFromRows,
  getRedeemAccounts,
  mergeAccountsIntoAutoCycleState,
  commitAutoCycleState,
  getNextAutoCycleAccount,
  createAutoCycleRow,
  forgetDeletedRows,
  recordAccountSubmissionAttempts,
  getResolvedAttemptNumber,
  canRetryVisibleFailedRow,
  isDailyLimitFailureRow,
  isCooldownReleaseCandidate,
  isAttemptExhaustedReleaseCandidate,
  isLocalAttemptLimitFailureRow,
  getDailyLimitDisplayReason,
  formatFailureReason,
  maskEmail,
  maskCdkey
}) {
  function isAutoCycleFailureCandidateForApp(row) {
    return isAutoCycleFailureCandidate(row, {
      isAutoCycleEnabled: () => autoCycleRef.current.enabled === true,
      canRetryVisibleFailedRow,
      isDailyLimitFailureRow,
      isCooldownReleaseCandidate,
      isAttemptExhaustedReleaseCandidate,
      requiresRowId: true,
      requiresEmail: true,
      requiresCdkey: true
    });
  }

  function clearAutoCycleScheduleTimer() {
    if (!autoCycleScheduleTimerRef.current) return;
    window.clearTimeout(autoCycleScheduleTimerRef.current);
    autoCycleScheduleTimerRef.current = null;
  }

  function scheduleAutoCycleFailures(rowList = rowsRef.current, options = {}) {
    if (!autoCycleRef.current.enabled) return 0;

    const candidates = (rowList || []).filter(isAutoCycleFailureCandidateForApp);
    if (!candidates.length) return 0;

    if (autoCycleScheduleTimerRef.current) {
      return candidates.length;
    }

    if (!options.silent) {
      setStatusMessage(`检测到 ${candidates.length} 条失败，1 秒内合并后自动换号`);
    }

    autoCycleScheduleTimerRef.current = window.setTimeout(async () => {
      autoCycleScheduleTimerRef.current = null;

      if (autoCycleProcessingRef.current || !autoCycleRef.current.enabled) {
        scheduleAutoCycleFailures(rowsRef.current, options);
        return;
      }

      await processAutoCycleFailures(rowsRef.current, options);
    }, AUTO_CYCLE_SCHEDULE_DELAY_MS);

    return candidates.length;
  }

  async function processAutoCycleFailures(rowList, options = {}) {
    if (autoCycleProcessingRef.current || !autoCycleRef.current.enabled) return rowList;
    const candidates = (rowList || []).filter(isAutoCycleFailureCandidateForApp);
    if (!candidates.length) return rowList;
    const dailyLimitCandidateCount = candidates.filter(isDailyLimitFailureRow).length;
    const cooldownReleaseCandidateCount = candidates.filter(isCooldownReleaseCandidate).length;
    const exhaustedCandidateCount = candidates.filter(isAttemptExhaustedReleaseCandidate).length;

    autoCycleProcessingRef.current = true;
    try {
      let nextState = mergeAccountsIntoAutoCycleState(
        autoCycleRef.current,
        getRedeemAccounts(),
        autoCycleRef.current.currentRound
      );
      const handledIds = new Set(nextState.handledRowIds);
      const rowsToSubmit = [];
      const replacementByParentId = new Map();
      const reservedReplacementEmails = buildAutoCycleReservedEmails(rowList, candidates);
      const reservedReplacementTokens = buildAutoCycleReservedAccessTokens(rowList, candidates);

      candidates.forEach((row) => {
        if (handledIds.has(row.id)) return;

        let selection = getNextAutoCycleAccount(nextState, reservedReplacementEmails);
        nextState = selection.state;
        while (
          selection.account &&
          reservedReplacementTokens.has(normalizeAccessToken(selection.account.accessToken))
        ) {
          reserveAutoCycleReplacementEmail(reservedReplacementEmails, selection.account);
          selection = getNextAutoCycleAccount(nextState, reservedReplacementEmails);
          nextState = selection.state;
        }
        if (!selection.account) {
          if (
            isDailyLimitFailureRow(row) ||
            isCooldownReleaseCandidate(row) ||
            isAttemptExhaustedReleaseCandidate(row)
          ) {
            handledIds.add(row.id);
          }
          return;
        }
        const autoRow = createAutoCycleRow(
          row,
          selection.account,
          rowList.length + rowsToSubmit.length
        );
        forgetDeletedRows([autoRow]);
        reserveAutoCycleReplacementEmail(reservedReplacementEmails, selection.account);
        reserveAutoCycleReplacementAccessToken(reservedReplacementTokens, selection.account);
        rowsToSubmit.push(autoRow);
        replacementByParentId.set(row.id, autoRow.id);
        handledIds.add(row.id);
      });

      nextState = {
        ...nextState,
        handledRowIds: [...handledIds]
      };

      const handledAt = Date.now();
      let workingRows = rowList.map((row) => {
        if (!handledIds.has(row.id)) return row;
        const nextRowId = replacementByParentId.get(row.id);
        const nextRow = rowsToSubmit.find((candidate) => candidate.id === nextRowId);
        const replacementText =
          nextRow && row.email
            ? `；正在换号：${maskEmail(row.email)} -> ${maskEmail(nextRow.email)}，继续使用 CDK ${maskCdkey(row.cdkey)}`
            : "";
        const handledReason = isDailyLimitFailureRow(row)
          ? getDailyLimitDisplayReason(row, nextRowId ? replacementText : "")
          : isLocalAttemptLimitFailureRow(row) || isAttemptExhaustedReleaseCandidate(row)
            ? `账号已达到 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次，已进入 24 小时冷却并释放 CDK${replacementText}`
            : nextRowId
              ? `${formatFailureReason(row) || row.reason || "兑换失败"}；已自动换下一个账号`
              : row.reason;
        return {
          ...row,
          autoCycleHandled: true,
          statusLocked: true,
          statusOwner: false,
          autoCycleNextRowId: nextRowId || row.autoCycleNextRowId || "",
          autoCycleHandledAt: handledAt,
          reason: handledReason
        };
      });

      commitAutoCycleState(nextState);

      if (!rowsToSubmit.length) {
        setRows(workingRows);
        rowsRef.current = workingRows;
        if (!options.silent) {
          setStatusMessage(
            dailyLimitCandidateCount
              ? `已封存 ${dailyLimitCandidateCount} 个账号 24 小时；自动换号没有可用账号，请补充账号`
              : cooldownReleaseCandidateCount
                ? `已释放 ${cooldownReleaseCandidateCount} 个冷却账号的 CDK；自动换号没有可用账号，请补充账号`
                : exhaustedCandidateCount
                  ? `${exhaustedCandidateCount} 个账号已达到 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次并进入 24 小时冷却；自动换号没有可用账号，请补充账号`
                  : "自动换号没有可用账号；请补充账号"
          );
        }
        return workingRows;
      }

      const submittingRows = markStatusOwners([...workingRows, ...rowsToSubmit], rowsToSubmit);
      forgetDeletedRows(rowsToSubmit);
      setRows(submittingRows);
      rowsRef.current = submittingRows;
      const firstSwitch = rowsToSubmit[0];
      const switchText = firstSwitch?.autoCycleSourceEmail
        ? `：${maskEmail(firstSwitch.autoCycleSourceEmail)} -> ${maskEmail(firstSwitch.email)}，CDK ${maskCdkey(firstSwitch.cdkey)}`
        : "";
      setStatusMessage(
        `自动换号提交 ${rowsToSubmit.length} 条${dailyLimitCandidateCount ? `，已封存 ${dailyLimitCandidateCount} 个账号 24 小时` : cooldownReleaseCandidateCount ? `，已释放 ${cooldownReleaseCandidateCount} 个冷却账号的 CDK` : exhaustedCandidateCount ? `，${exhaustedCandidateCount} 个账号达到 ${ACCOUNT_ATTEMPT_LIMIT}/${ACCOUNT_ATTEMPT_LIMIT} 次进入 24 小时冷却` : ""}${switchText}`
      );

      const command = buildSubmitCommand(rowsToSubmit);
      const payload = await callProxy(command.path, command.body);
      const attemptCountByEmail = recordAccountSubmissionAttempts(rowsToSubmit);
      const actionAt = Date.now();
      const submittedRows = rowsToSubmit.map((row) => {
        const submittedCount = attemptCountByEmail.get(String(row.email || "").trim().toLowerCase());
        const attemptNumber = getResolvedAttemptNumber(row, submittedCount);
        return {
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
          accountAttemptNumber: attemptNumber,
          attemptNumber,
          statusOwner: true
        };
      });
      const submittedById = new Map(submittedRows.map((row) => [row.id, row]));
      workingRows = markStatusOwners(
        submittingRows.map((row) => submittedById.get(row.id) || row),
        submittedRows
      );
      let mergedRows = applyStatusItemsToRows(
        workingRows,
        rowsToSubmit.map((row) => row.cdkey),
        payload.items,
        payload
      );
      mergedRows = registerCooldownsFromRows(mergedRows);
      const submittedRowIds = new Set(rowsToSubmit.map((row) => row.id));
      const shouldContinueAutoCycle = mergedRows.some(
        (row) =>
          submittedRowIds.has(row.id) &&
          row.autoCycleHandled !== true &&
          isDailyLimitFailureRow(row)
      );
      if (shouldContinueAutoCycle) {
        autoCycleProcessingRef.current = false;
        scheduleAutoCycleFailures(mergedRows, { ...options, silent: false });
      }
      setRows(mergedRows);
      rowsRef.current = mergedRows;
      setLastUpdatedAt(new Date().toLocaleString());
      return mergedRows;
    } catch (error) {
      setStatusMessage(error.message);
      return rowsRef.current;
    } finally {
      autoCycleProcessingRef.current = false;
    }
  }

  return {
    clearAutoCycleScheduleTimer,
    isAutoCycleFailureCandidate: isAutoCycleFailureCandidateForApp,
    processAutoCycleFailures,
    scheduleAutoCycleFailures
  };
}
