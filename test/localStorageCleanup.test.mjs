import assert from "node:assert/strict";
import test from "node:test";
import { STORAGE_KEYS } from "../src/config/redeemConstants.js";
import {
  clearRedeemStorage,
  clearSensitiveRedeemStorage
} from "../src/storage/localStorageCleanup.js";

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

test("clearRedeemStorage removes API keys and all app state", () => {
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

  const result = clearRedeemStorage(storage);

  assert.equal(result.preservedApiKey, false);
  assert.equal(storage.getItem(STORAGE_KEYS.apiKey), null);
  assert.equal(storage.getItem(STORAGE_KEYS.accountText), null);
  assert.equal(storage.getItem(STORAGE_KEYS.cdkeyPools), null);
  assert.equal(storage.getItem(STORAGE_KEYS.rows), null);
  assert.equal(storage.getItem(STORAGE_KEYS.workflowSnapshot), null);
  assert.equal(storage.getItem("cdkRedeem.baseUrl"), null);
  assert.equal(storage.getItem("cdkRedeem.futureKey"), null);
  assert.equal(storage.getItem("other.app.key"), "keep");
});

test("clearRedeemStorage clears app state when API key is absent", () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.accountNotice]: "notice",
    [STORAGE_KEYS.statusMessage]: "status"
  });

  const result = clearRedeemStorage(storage);

  assert.equal(result.preservedApiKey, false);
  assert.deepEqual(storage.dump(), {});
});

test("clearSensitiveRedeemStorage removes scalar credentials and sanitizes legacy task state", () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.apiKey]: "legacy-api-key",
    [STORAGE_KEYS.accountText]: "user@example.com---password---2fa---mail-url---access-token",
    [STORAGE_KEYS.sessionText]: "{\"accessToken\":\"session-token\"}",
    [STORAGE_KEYS.accountAuditText]: "audit-access-token",
    [STORAGE_KEYS.accountAuditRows]: "[{\"accessToken\":\"audit-row-token\"}]",
    [STORAGE_KEYS.rows]: JSON.stringify([{
      id: "row-1",
      cdkey: "CDK-KEEP",
      password: "row-password",
      accessToken: "row-token",
      rawStatus: { access_token: "nested-token", status: "queued" }
    }])
  });

  clearSensitiveRedeemStorage(storage);

  assert.equal(storage.getItem(STORAGE_KEYS.apiKey), null);
  assert.equal(storage.getItem(STORAGE_KEYS.accountText), null);
  assert.equal(storage.getItem(STORAGE_KEYS.sessionText), null);
  assert.equal(storage.getItem(STORAGE_KEYS.accountAuditText), null);
  assert.equal(storage.getItem(STORAGE_KEYS.accountAuditRows), null);
  const rows = JSON.parse(storage.getItem(STORAGE_KEYS.rows));
  assert.equal(rows[0].cdkey, "CDK-KEEP");
  assert.equal(rows[0].password, "");
  assert.equal(rows[0].accessToken, "");
  assert.equal(rows[0].rawStatus.access_token, "");
  assert.equal(rows[0].rawStatus.status, "queued");
});
