export function readStored(storage, key) {
  try {
    return storage.getItem(key) || "";
  } catch {
    return "";
  }
}

export function writeStored(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // localStorage can be unavailable in private or locked-down browser contexts.
  }
}

export function removeStoredValue(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // localStorage can be unavailable in private or locked-down browser contexts.
  }
}

export function readStoredJson(storage, key, fallback) {
  const raw = readStored(storage, key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}
