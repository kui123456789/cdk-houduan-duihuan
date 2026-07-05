import { mergeStatusRows, normalizeStatusItem } from "../redeemLogic.js";
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

function buildMissingUnusedItems(cdkeys, items) {
  const returnedCdkeys = new Set(
    items
      .map(normalizeStatusItem)
      .map((item) => item.cdkey)
      .filter(Boolean)
  );

  return (cdkeys || [])
    .map(normalizeCdkey)
    .filter(Boolean)
    .filter((cdkey) => !returnedCdkeys.has(cdkey))
    .map((cdkey) => ({
      cdkey,
      status: "unused",
      reason: "后端未返回该卡密，按未使用处理",
      found: false,
      missingStatusItem: true
    }));
}

function getStatusEventItems(event) {
  const items = Array.isArray(event?.items) ? event.items : [];
  if (event?.missingAsUnused !== true) return items;
  return [...items, ...buildMissingUnusedItems(getEventCdkeys(event), items)];
}

function applyStatusReceived(state, event) {
  const rows = normalizeRows(state?.rows);
  const items = getStatusEventItems(event);
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
