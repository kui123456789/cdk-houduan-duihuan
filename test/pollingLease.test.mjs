import assert from "node:assert/strict";
import test from "node:test";
import { createPollingLease } from "../src/domain/pollingLease.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function createTimerHarness() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimer(callback) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    runNext() {
      const entry = timers.entries().next().value;
      if (!entry) return false;
      const [id, callback] = entry;
      timers.delete(id);
      callback();
      return true;
    },
    count: () => timers.size
  };
}

test("only one tab owns an active polling lease", () => {
  const storage = createMemoryStorage();
  const first = createPollingLease({ storage, ownerId: "tab-a", now: () => 1000 });
  const second = createPollingLease({ storage, ownerId: "tab-b", now: () => 1000 });

  assert.equal(first.acquire(), true);
  assert.equal(second.acquire(), false);
  assert.equal(first.isOwner(), true);
  assert.equal(second.isOwner(), false);
});

test("another tab can acquire after release or expiry", () => {
  const storage = createMemoryStorage();
  let now = 1000;
  const first = createPollingLease({ storage, ownerId: "tab-a", now: () => now, leaseMs: 100 });
  const second = createPollingLease({ storage, ownerId: "tab-b", now: () => now, leaseMs: 100 });

  assert.equal(first.acquire(), true);
  first.release();
  assert.equal(second.acquire(), true);
  second.release();

  assert.equal(first.acquire(), true);
  now = 1101;
  assert.equal(second.acquire(), true);
});

test("lease heartbeat extends ownership and detects takeover", () => {
  const storage = createMemoryStorage();
  const timers = createTimerHarness();
  let now = 1000;
  let lostCount = 0;
  const first = createPollingLease({
    storage,
    ownerId: "tab-a",
    now: () => now,
    leaseMs: 100,
    heartbeatMs: 20,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onLost: () => { lostCount += 1; }
  });
  const second = createPollingLease({ storage, ownerId: "tab-b", now: () => now, leaseMs: 100 });

  assert.equal(first.acquire(), true);
  now = 1050;
  assert.equal(timers.runNext(), true);
  now = 1120;
  assert.equal(second.acquire(), false);
  now = 1151;
  assert.equal(second.acquire(), true);
  assert.equal(timers.runNext(), true);
  assert.equal(first.isOwner(), false);
  assert.equal(lostCount, 1);
});

test("corrupt storage is replaced and unavailable storage degrades locally", () => {
  const storage = createMemoryStorage();
  storage.setItem("cdkRedeem.pollingLease.v1", "not-json");
  const repaired = createPollingLease({ storage, ownerId: "tab-a", now: () => 1000 });
  assert.equal(repaired.acquire(), true);

  const unavailable = createPollingLease({
    storage: {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); }
    },
    ownerId: "tab-b",
    now: () => 1000
  });
  assert.equal(unavailable.acquire(), true);
  assert.equal(unavailable.isOwner(), true);
  assert.equal(unavailable.isDegraded(), true);
});
