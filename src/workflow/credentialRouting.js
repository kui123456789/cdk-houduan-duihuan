import { isQueryOnlyRow } from "../domain/statusMeta.js";

function normalizeCdkey(value) {
  return String(value || "").trim();
}

const SERVER_CREDENTIAL_MODE = "server";
const USER_CREDENTIAL_MODE = "user";

function getCurrentCredentialMode(hasUserApiKey) {
  return hasUserApiKey ? USER_CREDENTIAL_MODE : SERVER_CREDENTIAL_MODE;
}

function getStoredCredentialMode(row) {
  const mode = String(row?.credentialMode || "").trim().toLowerCase();
  return mode === SERVER_CREDENTIAL_MODE || mode === USER_CREDENTIAL_MODE ? mode : "";
}

function resolveRowCredentialMode(row, hasUserApiKey) {
  if (isQueryOnlyRow(row)) return getCurrentCredentialMode(hasUserApiKey);
  return getStoredCredentialMode(row) || getCurrentCredentialMode(hasUserApiKey);
}

function getProxyCredentialMode(mode) {
  return mode === SERVER_CREDENTIAL_MODE ? SERVER_CREDENTIAL_MODE : "";
}

export function toTaskCredentialMode(credentialMode) {
  return String(credentialMode || "").trim().toLowerCase() === SERVER_CREDENTIAL_MODE
    ? SERVER_CREDENTIAL_MODE
    : USER_CREDENTIAL_MODE;
}

function appendGroupedValue(groupsByMode, mode, value) {
  if (!groupsByMode.has(mode)) groupsByMode.set(mode, []);
  groupsByMode.get(mode).push(value);
}

function getStatusOwnerRow(rows, cdkey) {
  const matches = (rows || []).filter((row) => normalizeCdkey(row?.cdkey) === cdkey);
  return (
    matches.find((row) => row?.statusOwner === true) ||
    matches.find((row) => row?.statusLocked !== true && row?.autoCycleHandled !== true) ||
    matches.at(-1)
  );
}

function getItemCdkey(item) {
  return normalizeCdkey(
    item?.cdkey || item?.cdKey || item?.cd_key || item?.cdk || item?.cdk_code
  );
}

const SUBMIT_ACCEPTED_STATUSES = new Set([
  "queued",
  "submitted",
  "pending_dispatch",
  "dispatched",
  "running",
  "processing",
  "success"
]);

const RETRY_REJECTED_STATUSES = new Set([
  "failed",
  "timeout",
  "cancelled",
  "rejected",
  "invalid",
  "approve_blocked",
  "pm_unavailable",
  "awaiting_payment_expiry",
  "not_found",
  "unused"
]);

function hasDurableTaskEvidence(item) {
  return Boolean(
    normalizeCdkey(
      item?.id ||
        item?.task_id ||
        item?.taskId ||
        item?.job_id ||
        item?.jobId ||
        item?.task?.id ||
        item?.job?.id
    ) ||
      item?.already_submitted === true ||
      item?.alreadySubmitted === true
  );
}

function hasExplicitSubmitAcceptance(item) {
  if (!item || typeof item !== "object") return false;
  if (item.ok === true || item.success === true || item.accepted === true) return true;
  if (hasDurableTaskEvidence(item)) return true;
  const status = String(
    item.status || item.state || item.action_status || item.actionStatus || item.result || ""
  ).trim().toLowerCase();
  return SUBMIT_ACCEPTED_STATUSES.has(status);
}

function hasExplicitActionOutcome(item) {
  if (!item || typeof item !== "object") return false;
  if (item.ok === true || item.success === true || item.accepted === true) return true;
  const status = String(
    item.status || item.state || item.action_status || item.actionStatus || item.result || ""
  ).trim().toLowerCase();
  return Boolean(status) && !["unknown", "unconfirmed", "not_found"].includes(status);
}

function hasExplicitRetryAcceptance(item) {
  if (!item || typeof item !== "object") return false;
  if (item.retried === false || item.ok === false || item.success === false || item.accepted === false) {
    return false;
  }
  if (item.retried === true || item.retry === true) return true;
  if (item.ok === true || item.success === true || item.accepted === true) return true;
  const status = String(
    item.status || item.state || item.action_status || item.actionStatus || item.result || ""
  ).trim().toLowerCase();
  return SUBMIT_ACCEPTED_STATUSES.has(status);
}

function hasExplicitRetryRejection(item) {
  if (!item || typeof item !== "object" || hasExplicitRetryAcceptance(item)) return false;
  if (
    item.retried === false ||
    item.retry === false ||
    item.ok === false ||
    item.success === false ||
    item.accepted === false ||
    item.found === false
  ) {
    return true;
  }
  const status = String(
    item.status || item.state || item.action_status || item.actionStatus || item.result || ""
  ).trim().toLowerCase();
  return RETRY_REJECTED_STATUSES.has(status);
}

export function partitionRowsByConfirmedPayload(rows, payload, { mode = "action" } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const rowCdkeys = new Set(list.map((row) => normalizeCdkey(row?.cdkey)).filter(Boolean));
  const isConfirmedItem = mode === "submit"
    ? hasExplicitSubmitAcceptance
    : mode === "retry"
      ? hasExplicitRetryAcceptance
      : hasExplicitActionOutcome;
  const matchingItems = (Array.isArray(payload?.items) ? payload.items : []).filter((item) =>
    rowCdkeys.has(getItemCdkey(item))
  );
  const confirmedItems = matchingItems.filter(isConfirmedItem);
  const rejectedItems = mode === "retry"
    ? matchingItems.filter((item) => hasExplicitRetryRejection(item))
    : [];
  const confirmedSet = new Set(
    confirmedItems
      .map(getItemCdkey)
      .filter(Boolean)
  );
  const confirmedRows = list.filter((row) => confirmedSet.has(normalizeCdkey(row?.cdkey)));
  const rejectedSet = new Set(rejectedItems.map(getItemCdkey).filter(Boolean));
  const rejectedRows = list.filter((row) => rejectedSet.has(normalizeCdkey(row?.cdkey)));
  const confirmedIds = new Set(confirmedRows.map((row) => row?.id));
  return {
    confirmedRows,
    unconfirmedRows: list.filter((row) => !confirmedIds.has(row?.id)),
    confirmedCdkeys: confirmedRows.map((row) => normalizeCdkey(row?.cdkey)).filter(Boolean),
    confirmedItems,
    ...(mode === "retry" ? { rejectedRows, rejectedItems } : {})
  };
}

export function splitRowsByCredential(rows, { hasUserApiKey = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const blockedRows = [];
  const groupsByMode = new Map();

  list.forEach((row) => {
    if (isQueryOnlyRow(row)) {
      blockedRows.push(row);
      return;
    }
    const mode = resolveRowCredentialMode(row, hasUserApiKey);
    if (mode === USER_CREDENTIAL_MODE && !hasUserApiKey) {
      blockedRows.push(row);
      return;
    }
    appendGroupedValue(groupsByMode, mode, row);
  });

  return {
    groups: [...groupsByMode.entries()].map(([mode, groupedRows]) => ({
      credentialMode: getProxyCredentialMode(mode),
      rows: groupedRows
    })),
    blockedRows
  };
}

export function splitCdkeysByCredential(
  rows,
  cdkeys,
  { hasUserApiKey = false } = {}
) {
  const cleanCdkeys = [
    ...new Set((Array.isArray(cdkeys) ? cdkeys : []).map(normalizeCdkey).filter(Boolean))
  ];
  const rowList = Array.isArray(rows) ? rows : [];
  const blockedCdkeys = [];
  const groupsByMode = new Map();

  cleanCdkeys.forEach((cdkey) => {
    const ownerRow = getStatusOwnerRow(rowList, cdkey);
    const mode = resolveRowCredentialMode(ownerRow, hasUserApiKey);
    if (mode === USER_CREDENTIAL_MODE && !hasUserApiKey) {
      blockedCdkeys.push(cdkey);
      return;
    }
    appendGroupedValue(groupsByMode, mode, cdkey);
  });

  return {
    groups: [...groupsByMode.entries()].map(([mode, groupedCdkeys]) => ({
      credentialMode: getProxyCredentialMode(mode),
      cdkeys: groupedCdkeys
    })),
    blockedCdkeys
  };
}

export function mergeProxyPayloads(payloads) {
  const list = (Array.isArray(payloads) ? payloads : []).filter(Boolean);
  const backends = list.map((payload) => payload.backend).filter(Boolean);
  return {
    ok: list.every((payload) => payload.ok !== false),
    batchCount: list.reduce((total, payload) => total + Number(payload.batchCount || 0), 0),
    items: list.flatMap((payload) => (Array.isArray(payload.items) ? payload.items : [])),
    backend: {
      emptyResponse:
        backends.length > 0 && backends.every((backend) => backend.emptyResponse === true),
      emptyBatchCount: backends.reduce(
        (total, backend) => total + Number(backend.emptyBatchCount || 0),
        0
      ),
      itemCount: backends.reduce(
        (total, backend) => total + Number(backend.itemCount || 0),
        0
      ),
      batches: backends.flatMap((backend) =>
        Array.isArray(backend.batches) ? backend.batches : []
      )
    }
  };
}
