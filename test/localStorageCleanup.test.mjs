import assert from "node:assert/strict";
import test from "node:test";
import { STORAGE_KEYS } from "../src/config/redeemConstants.js";
import { clearRedeemStorageExceptApiKey } from "../src/storage/localStorageCleanup.js";

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    dump() {
      return Object.fromEntries(values.entries());
    }
  };
}

test("clearRedeemStorageExceptApiKey preserves API key and removes all app state", () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.apiKey]: "ext_redeem_keep",
    [STORAGE_KEYS.accountText]: "account",
    [STORAGE_KEYS.cdkeyPools]: "{}",
    [STORAGE_KEYS.rows]: "[]",
    [STORAGE_KEYS.workflowSnapshot]: "{}",
    "cdkRedeem.baseUrl": "legacy",
    "cdkRedeem.futureKey": "future",
    "other.app.key": "keep"
  });

  const result = clearRedeemStorageExceptApiKey(storage);

  assert.equal(result.preservedApiKey, true);
  assert.equal(storage.getItem(STORAGE_KEYS.apiKey), "ext_redeem_keep");
  assert.equal(storage.getItem(STORAGE_KEYS.accountText), null);
  assert.equal(storage.getItem(STORAGE_KEYS.cdkeyPools), null);
  assert.equal(storage.getItem(STORAGE_KEYS.rows), null);
  assert.equal(storage.getItem(STORAGE_KEYS.workflowSnapshot), null);
  assert.equal(storage.getItem("cdkRedeem.baseUrl"), null);
  assert.equal(storage.getItem("cdkRedeem.futureKey"), null);
  assert.equal(storage.getItem("other.app.key"), "keep");
});

test("clearRedeemStorageExceptApiKey clears app state when API key is absent", () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.accountNotice]: "notice",
    [STORAGE_KEYS.statusMessage]: "status"
  });

  const result = clearRedeemStorageExceptApiKey(storage);

  assert.equal(result.preservedApiKey, false);
  assert.deepEqual(storage.dump(), {});
});
