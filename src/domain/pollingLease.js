export const POLLING_LEASE_STORAGE_KEY = "cdkRedeem.pollingLease.v1";

/**
 * @typedef {Object} PollingLeaseOptions
 * @property {Pick<Storage, "getItem" | "setItem" | "removeItem">} [storage]
 * @property {string} ownerId
 * @property {string} [key]
 * @property {number} [leaseMs]
 * @property {number} [heartbeatMs]
 * @property {() => number} [now]
 * @property {(callback: () => void, delay: number) => ReturnType<typeof setTimeout>} [setTimer]
 * @property {(timerId: ReturnType<typeof setTimeout>) => void} [clearTimer]
 * @property {() => void} [onLost]
 */

function parseLease(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    const ownerId = String(parsed?.ownerId || "").trim();
    const expiresAt = Number(parsed?.expiresAt || 0);
    if (!ownerId || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return { ownerId, expiresAt };
  } catch {
    return null;
  }
}

/**
 * @param {PollingLeaseOptions} options
 */
export function createPollingLease({
  storage,
  ownerId,
  key = POLLING_LEASE_STORAGE_KEY,
  leaseMs = 15_000,
  heartbeatMs = 5_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onLost = () => {}
} = /** @type {PollingLeaseOptions} */ ({})) {
  const normalizedOwnerId = String(ownerId || "").trim();
  if (!normalizedOwnerId) throw new Error("轮询租约 ownerId 不能为空");

  let owned = false;
  let degraded = false;
  let timerId = null;

  function clearHeartbeat() {
    if (timerId === null) return;
    clearTimer(timerId);
    timerId = null;
  }

  function readCurrent() {
    try {
      return parseLease(storage?.getItem?.(key));
    } catch {
      degraded = true;
      return null;
    }
  }

  function writeCurrent(expiresAt) {
    try {
      storage?.setItem?.(key, JSON.stringify({ ownerId: normalizedOwnerId, expiresAt }));
      return true;
    } catch {
      degraded = true;
      return false;
    }
  }

  function scheduleHeartbeat() {
    clearHeartbeat();
    if (!owned || degraded || Number(heartbeatMs) <= 0) return;
    timerId = setTimer(runHeartbeat, Number(heartbeatMs));
    timerId?.unref?.();
  }

  function loseOwnership() {
    if (!owned) return;
    owned = false;
    clearHeartbeat();
    onLost();
  }

  function runHeartbeat() {
    timerId = null;
    if (!owned) return;
    const current = readCurrent();
    if (degraded) {
      scheduleHeartbeat();
      return;
    }
    if (!current || current.ownerId !== normalizedOwnerId) {
      loseOwnership();
      return;
    }
    if (!writeCurrent(Number(now()) + Number(leaseMs))) {
      scheduleHeartbeat();
      return;
    }
    scheduleHeartbeat();
  }

  function acquire() {
    const currentTime = Number(now());
    const current = readCurrent();
    if (degraded) {
      owned = true;
      return true;
    }
    if (
      current &&
      current.ownerId !== normalizedOwnerId &&
      current.expiresAt > currentTime
    ) {
      owned = false;
      return false;
    }

    if (!writeCurrent(currentTime + Number(leaseMs))) {
      owned = true;
      return true;
    }
    const confirmed = readCurrent();
    owned = degraded || confirmed?.ownerId === normalizedOwnerId;
    if (owned) scheduleHeartbeat();
    return owned;
  }

  function release() {
    clearHeartbeat();
    const current = readCurrent();
    owned = false;
    if (degraded || current?.ownerId !== normalizedOwnerId) return;
    try {
      storage?.removeItem?.(key);
    } catch {
      degraded = true;
    }
  }

  return {
    acquire,
    release,
    dispose: release,
    isOwner: () => owned,
    isDegraded: () => degraded
  };
}
