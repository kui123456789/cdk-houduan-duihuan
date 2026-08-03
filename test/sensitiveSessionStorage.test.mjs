import assert from "node:assert/strict";
import test from "node:test";
import {
  readPersistentLocalValue,
  readSensitiveSessionValue,
  removeSensitiveSessionValue,
  writePersistentLocalValue,
  writeSensitiveSessionValue
} from "../src/storage/sensitiveSessionStorage.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values
  };
}

test("sensitive storage migrates legacy localStorage values into sessionStorage", () => {
  const session = memoryStorage();
  const local = memoryStorage({ secret: "legacy-value" });
  assert.equal(readSensitiveSessionValue(session, local, "secret"), "legacy-value");
  assert.equal(session.getItem("secret"), "legacy-value");
  assert.equal(local.getItem("secret"), null);
});

test("sensitive storage writes only to sessionStorage and removes both copies", () => {
  const session = memoryStorage();
  const local = memoryStorage({ secret: "legacy-value" });
  writeSensitiveSessionValue(session, local, "secret", "current-value");
  assert.equal(session.getItem("secret"), "current-value");
  assert.equal(local.getItem("secret"), null);
  removeSensitiveSessionValue(session, local, "secret");
  assert.equal(session.getItem("secret"), null);
  assert.equal(local.getItem("secret"), null);
});

test("persistent storage migrates the current session value into localStorage", () => {
  const session = memoryStorage({ accounts: "account-one" });
  const local = memoryStorage();

  assert.equal(readPersistentLocalValue(session, local, "accounts"), "account-one");
  assert.equal(local.getItem("accounts"), "account-one");
  assert.equal(session.getItem("accounts"), null);
});

test("persistent storage keeps localStorage authoritative across browser sessions", () => {
  const session = memoryStorage({ accounts: "stale-session" });
  const local = memoryStorage({ accounts: "persisted-account" });

  assert.equal(readPersistentLocalValue(session, local, "accounts"), "persisted-account");
  assert.equal(session.getItem("accounts"), null);

  writePersistentLocalValue(session, local, "accounts", "updated-account");
  assert.equal(local.getItem("accounts"), "updated-account");
  assert.equal(session.getItem("accounts"), null);
});
