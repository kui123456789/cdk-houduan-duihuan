import {
  normalizeStatusItem,
  shouldHoldRetryStatus
} from "../redeemLogic.js";
import { ACTIVE_BACKEND_STATUSES } from "../config/redeemConstants.js";

function normalizeCdkey(value) {
  return String(value || "").trim();
}

function normalizeId(value) {
  return String(value || "");
}

function isCurrentStatusOwnerCandidate(row) {
  return row?.statusLocked !== true && row?.autoCycleHandled !== true;
}

function normalizeRemoteStatusItem(item) {
  if (item && typeof item === "object") return normalizeStatusItem(item);
  return normalizeStatusItem({ status: item });
}

export function findStatusOwnerRowId(rows, cdkey) {
  const targetCdkey = normalizeCdkey(cdkey);
  if (!targetCdkey) return "";

  const sameCdkeyRows = (rows || []).filter((row) => normalizeCdkey(row?.cdkey) === targetCdkey);
  const explicitOwner = sameCdkeyRows.find(
    (row) => row?.statusOwner === true && normalizeId(row?.id)
  );
  if (explicitOwner) return normalizeId(explicitOwner.id);

  for (let index = sameCdkeyRows.length - 1; index >= 0; index -= 1) {
    const row = sameCdkeyRows[index];
    if (isCurrentStatusOwnerCandidate(row) && normalizeId(row?.id)) {
      return normalizeId(row.id);
    }
  }

  return "";
}

export function isExplicitCancelledStatus(item) {
  if (!item) return false;
  if (item?.explicitCancellation === true) return true;
  return normalizeRemoteStatusItem(item).explicitCancellation === true;
}

export function shouldAcceptRemoteStatusDuringHold(localRow, remoteItem, now = Date.now()) {
  return !shouldHoldRetryStatus(localRow, normalizeRemoteStatusItem(remoteItem), now);
}

export function markCdkeyStatusOwner(rows, ownerRowId, cdkey) {
  const targetCdkey = normalizeCdkey(cdkey);
  const targetOwnerId = normalizeId(ownerRowId);
  if (!targetCdkey || !targetOwnerId) return rows;

  let changed = false;
  const nextRows = (rows || []).map((row) => {
    if (normalizeCdkey(row?.cdkey) !== targetCdkey) return row;
    const statusOwner = normalizeId(row?.id) === targetOwnerId;
    if (row?.statusOwner === statusOwner) return row;
    changed = true;
    return { ...row, statusOwner };
  });

  return changed ? nextRows : rows;
}

export function markStatusOwners(rowList, ownerRows) {
  return (ownerRows || []).reduce(
    (nextRows, ownerRow) => markCdkeyStatusOwner(nextRows, ownerRow?.id, ownerRow?.cdkey),
    rowList
  );
}

export function reviveRemoteBackendRows(rowList) {
  const currentOwnerCdkeys = new Set(
    (rowList || [])
      .filter((row) => row?.statusOwner === true && isCurrentStatusOwnerCandidate(row))
      .map((row) => normalizeCdkey(row?.cdkey))
      .filter(Boolean)
  );

  return (rowList || []).map((row) => {
    const cdkey = normalizeCdkey(row?.cdkey);
    const historical =
      row?.statusLocked === true && row?.autoCycleHandled === true && row?.statusOwner !== true;
    const status = String(row?.status || "");
    if (!historical || !cdkey || currentOwnerCdkeys.has(cdkey) || !ACTIVE_BACKEND_STATUSES.has(status)) {
      return row;
    }
    currentOwnerCdkeys.add(cdkey);
    return {
      ...row,
      statusLocked: false,
      autoCycleHandled: false,
      statusOwner: true
    };
  });
}
