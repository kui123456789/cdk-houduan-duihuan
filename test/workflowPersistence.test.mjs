import assert from "node:assert/strict";
import test from "node:test";
import { STORAGE_KEYS } from "../src/config/redeemConstants.js";
import {
  loadWorkflowSnapshot,
  migrateLegacyWorkflowSnapshot,
  saveWorkflowSnapshot,
  WORKFLOW_SNAPSHOT_VERSION
} from "../src/storage/workflowPersistence.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values
  };
}

test("saveWorkflowSnapshot can omit sensitive fields when policy disables them", () => {
  const storage = createMemoryStorage();
  const now = Date.now();
  saveWorkflowSnapshot(
    storage,
    {
      version: WORKFLOW_SNAPSHOT_VERSION,
      savedAt: now,
      apiKey: "sk-live",
      rows: [
        {
          email: "user@example.com",
          password: "password",
          twofa: "twofa",
          accessToken: "access-token",
          exportLine: "export-line",
          rawLine: "raw-line",
          cdkey: "CDK-1"
        }
      ],
      accountLedger: {
        "user@example.com": {
          redemptionAttempts: [
            {
              cdkey: "CDK-1",
              email: "user@example.com",
              accessToken: "historical-access-token",
              password: "historical-password",
              submittedAt: now
            }
          ]
        }
      }
    },
    { persistSensitive: false, now }
  );

  const saved = JSON.parse(storage.getItem(STORAGE_KEYS.workflowSnapshot));
  assert.equal(saved.apiKey, "");
  assert.equal(saved.rows[0].email, "user@example.com");
  assert.equal(saved.rows[0].cdkey, "CDK-1");
  assert.equal(saved.rows[0].password, "");
  assert.equal(saved.rows[0].twofa, "");
  assert.equal(saved.rows[0].accessToken, "");
  assert.equal(saved.rows[0].exportLine, "");
  assert.equal(saved.rows[0].rawLine, "");
  assert.equal(saved.accountLedger["user@example.com"], undefined);
});

test("migrateLegacyWorkflowSnapshot reads existing rows and ledger", () => {
  const now = 1_780_000_000_000;
  const snapshot = migrateLegacyWorkflowSnapshot(
    {
      rows: JSON.stringify([{ id: "row-1", email: "USER@example.com", cdkey: "CDK-1" }]),
      accountAttemptLedger: JSON.stringify({
        "USER@example.com": {
          attempts: [now - 1000],
          updatedAt: now - 500
        }
      }),
      accountCooldowns: JSON.stringify({
        "USER@example.com": {
          until: now + 1000,
          reason: "keep this shape"
        }
      }),
      uiSettings: JSON.stringify({ activeWorkspaceTab: "execute", showApiKey: true })
    },
    { now }
  );

  assert.equal(snapshot.version, WORKFLOW_SNAPSHOT_VERSION);
  assert.deepEqual(snapshot.rows, [{ id: "row-1", email: "USER@example.com", cdkey: "CDK-1" }]);
  assert.deepEqual(Object.keys(snapshot.accountLedger), ["user@example.com"]);
  assert.equal(snapshot.accountLedger["user@example.com"].attemptCount, 1);
  assert.deepEqual(snapshot.accountCooldowns, {
    "USER@example.com": {
      until: now + 1000,
      reason: "keep this shape"
    }
  });
  assert.equal(snapshot.ui.activeWorkspaceTab, "execute");
  assert.equal(snapshot.ui.showApiKey, true);
});

test("migrateLegacyWorkflowSnapshot preserves legacy failed accounts", () => {
  const snapshot = migrateLegacyWorkflowSnapshot({
    [STORAGE_KEYS.failedAccounts]: JSON.stringify([
      {
        email: "Failed@Example.com",
        password: "password",
        twofa: "twofa",
        accessToken: "access-token",
        timestamp: "2026-07-05 10:00:00",
        failedRound: 2,
        failedReason: "daily limit",
        failedCdkey: "CDK-FAILED",
        failedAt: "2026-07-05T02:00:00Z"
      }
    ])
  });

  assert.equal(snapshot.failedAccounts.length, 1);
  assert.equal(snapshot.failedAccounts[0].email, "failed@example.com");
  assert.equal(snapshot.failedAccounts[0].password, "password");
  assert.equal(snapshot.failedAccounts[0].twofa, "twofa");
  assert.equal(snapshot.failedAccounts[0].accessToken, "access-token");
  assert.equal(snapshot.failedAccounts[0].failedRound, 2);
  assert.equal(snapshot.failedAccounts[0].failedReason, "daily limit");
  assert.equal(snapshot.failedAccounts[0].failedCdkey, "CDK-FAILED");
});

test("loadWorkflowSnapshot returns null for missing, invalid, and version mismatch", () => {
  const storage = createMemoryStorage();
  assert.equal(loadWorkflowSnapshot(storage), null);

  storage.setItem(STORAGE_KEYS.workflowSnapshot, "{bad json");
  assert.equal(loadWorkflowSnapshot(storage), null);

  storage.setItem(
    STORAGE_KEYS.workflowSnapshot,
    JSON.stringify({ version: WORKFLOW_SNAPSHOT_VERSION + 1, rows: [] })
  );
  assert.equal(loadWorkflowSnapshot(storage), null);
});

test("save/load roundtrip preserves non-sensitive snapshot when persistSensitive true", () => {
  const storage = createMemoryStorage();
  const now = 1_780_000_000_000;
  const original = {
    version: WORKFLOW_SNAPSHOT_VERSION,
    savedAt: now,
    rows: [
      {
        id: "row-1",
        email: "user@example.com",
        password: "password",
        twofa: "twofa",
        accessToken: "access-token",
        exportLine: "export-line",
        rawLine: "raw-line"
      }
    ],
    accountLedger: {
      "user@example.com": {
        attempts: [now - 1000],
        updatedAt: now - 1000,
        redemptionAttempts: [
          {
            cdkey: "CDK-1",
            email: "user@example.com",
            accessToken: "historical-access-token",
            password: "historical-password",
            submittedAt: now - 500
          }
        ]
      }
    },
    accountCooldowns: {},
    autoCycleState: {},
    failedAccounts: [],
    plusExports: { upi: ["line"], ideal: [], pix: ["pix-line"] },
    downloadedExportCounts: { upi: 2, ideal: 0, pix: 1 },
    activityLog: [{ message: "kept" }],
    ui: {
      activeWorkspaceTab: "exports",
      activeDetailRowId: "row-1",
      showApiKey: true,
      pollingEnabled: false
    }
  };

  saveWorkflowSnapshot(storage, original, { persistSensitive: true, now });
  const loaded = loadWorkflowSnapshot(storage, { now });

  assert.equal(loaded.savedAt, now);
  assert.equal(loaded.rows[0].password, "password");
  assert.equal(loaded.rows[0].twofa, "twofa");
  assert.equal(loaded.rows[0].accessToken, "access-token");
  assert.equal(loaded.rows[0].exportLine, "export-line");
  assert.equal(loaded.rows[0].rawLine, "raw-line");
  assert.equal(loaded.accountLedger["user@example.com"].attemptCount, 1);
  assert.equal(
    loaded.accountLedger["user@example.com"].redemptionAttempts[0].accessToken,
    "historical-access-token"
  );
  assert.deepEqual(loaded.plusExports, {
    upi: ["line"],
    ideal: [],
    pix: ["pix-line"]
  });
  assert.deepEqual(loaded.downloadedExportCounts, { upi: 2, ideal: 0, pix: 1 });
  assert.deepEqual(loaded.activityLog, [{ message: "kept" }]);
  assert.deepEqual(loaded.ui, original.ui);
});

test("storage get/set errors do not escape callers", () => {
  const throwingStorage = {
    getItem() {
      throw new Error("get failed");
    },
    setItem() {
      throw new Error("set failed");
    }
  };

  assert.doesNotThrow(() => loadWorkflowSnapshot(throwingStorage));
  assert.equal(loadWorkflowSnapshot(throwingStorage), null);
  assert.doesNotThrow(() => saveWorkflowSnapshot(throwingStorage, { rows: [] }));
  assert.equal(saveWorkflowSnapshot(throwingStorage, { rows: [] }), null);
});
