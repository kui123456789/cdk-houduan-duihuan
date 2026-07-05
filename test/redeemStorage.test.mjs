import assert from "node:assert/strict";
import test from "node:test";
import {
  readStored,
  readStoredJson,
  removeStoredValue,
  writeStored
} from "../src/storage/redeemStorage.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

test("readStored and writeStored use provided storage", () => {
  const storage = createMemoryStorage();
  writeStored(storage, "a", "1");
  assert.equal(readStored(storage, "a"), "1");
});

test("readStoredJson returns fallback for invalid JSON", () => {
  const storage = createMemoryStorage();
  writeStored(storage, "bad", "{bad json");
  assert.deepEqual(readStoredJson(storage, "bad", { ok: false }), { ok: false });
});

test("readStoredJson returns fallback for stored null", () => {
  const storage = createMemoryStorage();
  writeStored(storage, "nil", "null");
  assert.deepEqual(readStoredJson(storage, "nil", { ok: false }), { ok: false });
});

test("removeStoredValue removes keys", () => {
  const storage = createMemoryStorage();
  writeStored(storage, "a", "1");
  removeStoredValue(storage, "a");
  assert.equal(readStored(storage, "a"), "");
});
