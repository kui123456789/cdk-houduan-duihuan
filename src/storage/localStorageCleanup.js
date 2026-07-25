import { STORAGE_KEYS } from "../config/redeemConstants.js";
import {
  loadWorkflowSnapshot,
  sanitizeWorkflowSnapshot
} from "./workflowPersistence.js";

const REDEEM_STORAGE_PREFIX = "cdkRedeem.";

function isRedeemStorageKeyToClear(key) {
  return (
    typeof key === "string" &&
    key.startsWith(REDEEM_STORAGE_PREFIX)
  );
}

function collectStorageKeys(storage) {
  const keys = new Set();

  try {
    if (typeof storage?.length === "number" && typeof storage?.key === "function") {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (isRedeemStorageKeyToClear(key)) keys.add(key);
      }
    }
  } catch {
    // Storage can throw in locked-down contexts. The explicit key list below still runs.
  }

  try {
    Object.keys(storage || {}).forEach((key) => {
      if (isRedeemStorageKeyToClear(key)) keys.add(key);
    });
  } catch {
    // Ignore enumerable-key access failures.
  }

  Object.values(STORAGE_KEYS).forEach((key) => {
    if (isRedeemStorageKeyToClear(key)) keys.add(key);
  });

  return keys;
}

export function clearRedeemStorage(storage) {
  if (!storage) return { removed: 0, preservedApiKey: false };

  let removed = 0;
  collectStorageKeys(storage).forEach((key) => {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // Keep clearing the rest of the app state even if one key cannot be removed.
    }
  });

  return { removed, preservedApiKey: false };
}

function removeKey(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    // Continue clearing other credentials when storage is partially unavailable.
  }
}

function rewriteJson(storage, key, selectValue) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    storage.setItem(key, JSON.stringify(selectValue(parsed)));
  } catch {
    removeKey(storage, key);
  }
}

export function clearSensitiveRedeemStorage(storage) {
  if (!storage) return;
  [
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.accountText,
    STORAGE_KEYS.sessionText,
    STORAGE_KEYS.accountAuditText,
    STORAGE_KEYS.accountAuditRows
  ].forEach((key) => removeKey(storage, key));

  rewriteJson(storage, STORAGE_KEYS.rows, (rows) =>
    sanitizeWorkflowSnapshot({ rows }).rows
  );
  rewriteJson(storage, STORAGE_KEYS.autoCycleState, (autoCycleState) =>
    sanitizeWorkflowSnapshot({ autoCycleState }).autoCycleState
  );
  rewriteJson(storage, STORAGE_KEYS.failedAccounts, (failedAccounts) =>
    sanitizeWorkflowSnapshot({ failedAccounts }).failedAccounts
  );
  rewriteJson(storage, STORAGE_KEYS.accountAttemptLedger, (accountLedger) =>
    sanitizeWorkflowSnapshot({ accountLedger }).accountLedger
  );
  rewriteJson(storage, STORAGE_KEYS.plusExports, () => ({ upi: [], ideal: [], pix: [] }));
  loadWorkflowSnapshot(storage);
}

export const clearRedeemStorageExceptApiKey = clearRedeemStorage;
