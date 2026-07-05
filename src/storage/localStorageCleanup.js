import { STORAGE_KEYS } from "../config/redeemConstants.js";

const REDEEM_STORAGE_PREFIX = "cdkRedeem.";

function isRedeemStorageKeyToClear(key) {
  return (
    typeof key === "string" &&
    key.startsWith(REDEEM_STORAGE_PREFIX) &&
    key !== STORAGE_KEYS.apiKey
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

export function clearRedeemStorageExceptApiKey(storage) {
  if (!storage) return { removed: 0, preservedApiKey: false };

  let preservedApiKey = null;
  try {
    preservedApiKey = storage.getItem(STORAGE_KEYS.apiKey);
  } catch {
    preservedApiKey = null;
  }

  let removed = 0;
  collectStorageKeys(storage).forEach((key) => {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      // Keep clearing the rest of the app state even if one key cannot be removed.
    }
  });

  if (preservedApiKey != null) {
    try {
      storage.setItem(STORAGE_KEYS.apiKey, preservedApiKey);
    } catch {
      // If storage is unavailable, preserving the API key is best-effort.
    }
  }

  return { removed, preservedApiKey: preservedApiKey != null };
}
