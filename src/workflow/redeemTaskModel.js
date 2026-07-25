import { mergeStatusRows, normalizeStatusItem } from "../redeemLogic.js";
import { STATUS_SYNC_PENDING_REVIEW_MS } from "../config/redeemConstants.js";
import {
  findStatusOwnerRowId,
  markStatusOwners
} from "../state/statusMerge.js";
import { normalizeAccountLedger, startAccountCooldown } from "./accountLedger.js";
import { WORKFLOW_EVENTS } from "./redeemEvents.js";

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function normalizeActivityLog(activityLog) {
  return Array.isArray(activityLog) ? activityLog : [];
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizeCdkey(value) {
  return String(value || "").trim();
}

function getEventCdkeys(event) {
  const cdkeys = new Set(
    (Array.isArray(event?.cdkeys) ? event.cdkeys : [])
      .map(normalizeCdkey)
      .filter(Boolean)
  );

  (Array.isArray(event?.items) ? event.items : []).forEach((item) => {
    const cdkey = normalizeStatusItem(item).cdkey;
    if (cdkey) cdkeys.add(cdkey);
  });

  return [...cdkeys];
}

function getCurrentOwnerRows(rows, cdkeys) {
  const rowsById = new Map(rows.map((row) => [String(row?.id || ""), row]));
  return cdkeys
    .map((cdkey) => findStatusOwnerRowId(rows, cdkey))
    .filter(Boolean)
    .map((rowId) => rowsById.get(rowId))
    .filter(Boolean);
}

function getCurrentOwnerRow(rows, cdkey) {
  const rowId = findStatusOwnerRowId(rows, cdkey);
  return rows.find((row) => String(row?.id || "") === String(rowId || ""));
}

function createUnresolvedStatusItem(rows, cdkey, item, now) {
  const ownerRow = getCurrentOwnerRow(rows, cdkey);
  const syncPendingSince = Number(ownerRow?.syncPendingSince || 0) || now;
  const needsManualReview = now - syncPendingSince >= STATUS_SYNC_PENDING_REVIEW_MS;
  const reason = needsManualReview
    ? "后台状态长时间未同步，需要人工复核"
    : "后端暂未同步兑换记录，继续观察";
  return {
    ...(item || {}),
    cdkey,
    status: needsManualReview ? "manual_review" : "sync_pending",
    found: false,
    reason,
    message: reason,
    can_cancel: false,
    can_retry: false,
    can_reuse_token: false,
    missingStatusItem: true,
    syncPendingSince
  };
}

function getStatusEventItems(state, event) {
  const items = Array.isArray(event?.items) ? event.items : [];
  if (event?.missingAsSyncPending !== true) return items;

  const rows = normalizeRows(state?.rows);
  const now = normalizeTimestamp(state?.now);
  const requestedCdkeys = getEventCdkeys(event);
  const requestedSet = new Set(requestedCdkeys);
  const returnedCdkeys = new Set();
  const resolvedItems = items.map((item) => {
    const normalized = normalizeStatusItem(item);
    const cdkey = normalized.cdkey;
    if (cdkey) returnedCdkeys.add(cdkey);
    if (
      requestedSet.has(cdkey) &&
      normalized.status !== "unused" &&
      (normalized.status === "not_found" || item?.found === false)
    ) {
      return createUnresolvedStatusItem(rows, cdkey, item, now);
    }
    return item;
  });

  requestedCdkeys.forEach((cdkey) => {
    if (!returnedCdkeys.has(cdkey)) {
      resolvedItems.push(createUnresolvedStatusItem(rows, cdkey, null, now));
    }
  });
  return resolvedItems;
}

function applyStatusReceived(state, event) {
  const rows = normalizeRows(state?.rows);
  const items = getStatusEventItems(state, event);
  if (!items.length) return state;

  const ownerRows = getCurrentOwnerRows(rows, getEventCdkeys(event));
  const ownedRows = ownerRows.length ? markStatusOwners(rows, ownerRows) : rows;
  const mergedRows = mergeStatusRows(ownedRows, items, {
    force: event?.force === true
  });

  return {
    ...state,
    rows: mergedRows
  };
}

function applySubmitAccepted(state, event) {
  const rowIds = new Set((Array.isArray(event?.rowIds) ? event.rowIds : []).map(String));
  if (!rowIds.size) return state;

  const rows = normalizeRows(state?.rows);
  const ownerRows = rows.filter((row) => rowIds.has(String(row?.id || "")));
  if (!ownerRows.length) return state;

  return {
    ...state,
    rows: markStatusOwners(rows, ownerRows)
  };
}

function applyAccountCooldownStarted(state, event) {
  const email = String(event?.email || "").trim().toLowerCase();
  if (!email) return state;

  return {
    ...state,
    accountLedger: startAccountCooldown(state?.accountLedger, email, {
      now: normalizeTimestamp(state?.now),
      until: event?.until,
      reason: event?.reason
    })
  };
}

export function createInitialWorkflowState({
  rows = [],
  accountLedger = {},
  activityLog = [],
  now = Date.now()
} = {}) {
  const normalizedNow = normalizeTimestamp(now);
  return {
    rows: normalizeRows(rows),
    accountLedger: normalizeAccountLedger(accountLedger, { now: normalizedNow }),
    activityLog: normalizeActivityLog(activityLog),
    now: normalizedNow
  };
}

export function applyWorkflowEvent(state, event) {
  if (!event?.type) return state;

  switch (event.type) {
    case WORKFLOW_EVENTS.STATUS_RECEIVED:
      return applyStatusReceived(state, event);
    case WORKFLOW_EVENTS.SUBMIT_ACCEPTED:
      return applySubmitAccepted(state, event);
    case WORKFLOW_EVENTS.ACCOUNT_COOLDOWN_STARTED:
      return applyAccountCooldownStarted(state, event);
    default:
      return state;
  }
}

export function getVisibleRows(state) {
  return normalizeRows(state?.rows);
}
