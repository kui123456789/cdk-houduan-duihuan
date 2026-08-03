import { readStored, removeStoredValue, writeStored } from "./redeemStorage.js";

function readRawStored(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function readPersistentLocalValue(sessionStorage, localStorage, key) {
  const persisted = readRawStored(localStorage, key);
  if (persisted != null) {
    removeStoredValue(sessionStorage, key);
    return persisted;
  }

  const currentSession = readRawStored(sessionStorage, key);
  if (currentSession == null) return "";

  writeStored(localStorage, key, currentSession);
  if (readRawStored(localStorage, key) === currentSession) {
    removeStoredValue(sessionStorage, key);
  }
  return currentSession;
}

export function writePersistentLocalValue(sessionStorage, localStorage, key, value) {
  const normalized = String(value || "");
  writeStored(localStorage, key, normalized);
  if (readRawStored(localStorage, key) === normalized) {
    removeStoredValue(sessionStorage, key);
    return;
  }

  // Fall back to the current tab if persistent browser storage is unavailable.
  writeStored(sessionStorage, key, normalized);
}

export function readSensitiveSessionValue(sessionStorage, localStorage, key) {
  const current = readStored(sessionStorage, key);
  if (current) {
    removeStoredValue(localStorage, key);
    return current;
  }
  const legacy = readStored(localStorage, key);
  if (!legacy) return "";
  writeStored(sessionStorage, key, legacy);
  removeStoredValue(localStorage, key);
  return legacy;
}

export function writeSensitiveSessionValue(sessionStorage, localStorage, key, value) {
  writeStored(sessionStorage, key, String(value || ""));
  removeStoredValue(localStorage, key);
}

export function removeSensitiveSessionValue(sessionStorage, localStorage, key) {
  removeStoredValue(sessionStorage, key);
  removeStoredValue(localStorage, key);
}
