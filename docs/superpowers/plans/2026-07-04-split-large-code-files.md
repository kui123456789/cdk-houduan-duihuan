# Split Large Code Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前过大的 `src/App.jsx`、`src/styles.css` 和部分 `src/redeemLogic.js` 职责拆分成清晰模块，让“准备输入 -> 提交兑换 -> 查询轮询 -> 自动换号 -> Plus 判断 -> 结果导出”的流程更完整、可测试、可维护。

**Architecture:** 采用低风险渐进式拆分：先抽常量和纯函数，再抽 API/轮询服务，再抽 hooks，最后抽 UI 组件和 CSS。每个任务完成后都必须通过 `npm test` 和 `npm run build`，不改变外部接口请求体，不上传 GitHub，不部署香港服务器。

**Tech Stack:** Vite, React 18, Express 5, Node ESM, Node built-in test runner, plain CSS.

---

## Current File Map

- `src/App.jsx`: 约 5000 行，混合了常量、localStorage、账号/CDK 输入、提交兑换、查询轮询、自动换号、Plus 检查、导出、表格和所有页面组件。
- `src/styles.css`: 约 1500 行，包含全局主题、布局、表格、按钮、弹窗、导出卡片、进度条等所有样式。
- `src/redeemLogic.js`: 约 1000 行，已有解析、状态规范化、Plus 判断、状态合并等纯逻辑，是可继续保留和拆分的基础。
- `src/redeemState.js`: 当前新增的状态规则模块，已经承载 CDK 预检、账号可用性、三次尝试和行进度的测试入口。
- `server/index.js`: 约 500 行，Express 本地代理；本次只规划拆分，不改后端行为。

## Target File Structure

Create:

- `src/config/redeemConstants.js`  
  Timers, storage keys, workspace tabs, status sets, default UI settings, preflight summary shape.
- `src/storage/redeemStorage.js`  
  Browser localStorage wrappers and typed load/save helpers.
- `src/state/redeemSelectors.js`  
  Dashboard stats, CDK usage stats, account input status text, selected row selectors.
- `src/services/redeemApi.js`  
  Frontend proxy client: submit, status, cancel, retry, subscription check.
- `src/services/serializedPolling.js`  
  Polling controller with session/generation guard.
- `src/hooks/useAccountInputController.js`  
  Account upload, paste, cleanup, delete reconciliation.
- `src/hooks/useCdkPoolsController.js`  
  CDK pool paste/upload/import and preflight summary reset.
- `src/hooks/useRedeemWorkflow.js`  
  Submit, query, cancel, retry, auto polling coordination. This is the final extraction after pure services exist.
- `src/components/common/PanelHeader.jsx`
- `src/components/common/StatusCard.jsx`
- `src/components/common/WorkspaceTabs.jsx`
- `src/components/forms/InputPanel.jsx`
- `src/components/forms/CdkPoolCard.jsx`
- `src/components/request/RequestTable.jsx`
- `src/components/request/RowProgress.jsx`
- `src/components/request/SelectedRowDetail.jsx`
- `src/components/export/ResultExportCard.jsx`
- `src/components/export/CdkUsageCard.jsx`
- `src/components/export/BackendRedeemCard.jsx`
- `src/styles/base.css`
- `src/styles/layout.css`
- `src/styles/forms.css`
- `src/styles/tables.css`
- `src/styles/export.css`
- `src/styles/dialogs.css`

Modify:

- `src/App.jsx`  
  Keep only top-level state wiring and three workspace panels. Target final size: under 900 lines.
- `src/redeemLogic.js`  
  Keep parsing and remote normalization. Move only stats/selectors that are clearly UI-derived into `src/state/redeemSelectors.js`.
- `src/redeemState.js`  
  Keep account/CDK state rules and add exported helpers needed by selectors.
- `src/styles.css`  
  Become an import hub for split CSS files.
- `package.json`  
  Keep `test: "node --test"`.

---

## Task 0: Freeze the Baseline Before Refactor

**Files:**
- Read-only check: `src/App.jsx`, `src/redeemLogic.js`, `src/redeemState.js`
- No code changes.

- [ ] **Step 1: Verify current local state**

Run:

```powershell
git status --short
npm test
npm run build
```

Expected:

```text
npm test: all tests pass
npm run build: vite build succeeds
```

- [ ] **Step 2: Record current large-file sizes**

Run:

```powershell
Get-ChildItem -Recurse -File -Include *.jsx,*.js,*.css,*.mjs |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\.codegraph\\' } |
  Select-Object FullName,@{Name='Lines';Expression={(Get-Content -LiteralPath $_.FullName | Measure-Object -Line).Lines}},Length |
  Sort-Object Lines -Descending
```

Expected top files:

```text
src/App.jsx
src/styles.css
src/redeemLogic.js
server/index.js
```

- [ ] **Step 3: Keep the deployment boundary explicit**

Do not run:

```powershell
git push
scp
ssh root@47.243.122.212
npm run deploy
```

Expected: all work remains local.

---

## Task 1: Extract Constants and Shared Config

**Files:**
- Create: `src/config/redeemConstants.js`
- Modify: `src/App.jsx`
- Test: `npm test`, `npm run build`

- [ ] **Step 1: Create `src/config/redeemConstants.js`**

Add:

```js
export const STORAGE_KEYS = {
  apiKey: "cdkRedeem.apiKey",
  accountText: "cdkRedeem.accountText",
  cdkeyPools: "cdkRedeem.cdkeyPools",
  rows: "cdkRedeem.rows",
  errors: "cdkRedeem.errors",
  accountNotice: "cdkRedeem.accountNotice",
  statusMessage: "cdkRedeem.statusMessage",
  lastUpdatedAt: "cdkRedeem.lastUpdatedAt",
  plusExports: "cdkRedeem.plusExports",
  downloadedExportCounts: "cdkRedeem.downloadedExportCounts",
  autoCycleState: "cdkRedeem.autoCycleState",
  failedAccounts: "cdkRedeem.failedAccounts",
  accountCooldowns: "cdkRedeem.accountCooldowns",
  accountAttemptLedger: "cdkRedeem.accountAttemptLedger",
  uiSettings: "cdkRedeem.uiSettings"
};

export const SAMPLE_ACCOUNT = "mail@example.com---password---2fa---at---2026-07-03 15:43:17";
export const POLL_INTERVAL_MS = 5000;
export const AUTO_CYCLE_SCHEDULE_DELAY_MS = 1000;
export const RETRY_STATUS_HOLD_MS = 60 * 1000;
export const RETRY_STATUS_HOLD_REASON = "重试已发送，等待后台更新";
export const SUBMIT_STATUS_HOLD_REASON = "重新提交已发送，等待后台更新";
export const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_ATTEMPT_WINDOW_MS = ACCOUNT_COOLDOWN_MS;
export const ACCOUNT_ATTEMPT_LIMIT = 3;
export const DAILY_LIMIT_DISPLAY_REASON = "该账号今日提交次数已达上限，已封存 24 小时";
export const LOCAL_ATTEMPT_LIMIT_REASON = "该账号 24 小时内已提交 3 次，已封存 24 小时，避免触发后台限制";

export const DEFAULT_WORKSPACE_TAB = "prep";
export const WORKSPACE_TABS = [
  { id: "prep", title: "准备输入", subtitle: "API Key / 账号 / CDK" },
  { id: "execute", title: "执行监控", subtitle: "兑换任务 / 请求状态" },
  { id: "exports", title: "结果导出", subtitle: "成功池" }
];

export const DEFAULT_UI_SETTINGS = {
  activeDetailRowId: "",
  activeWorkspaceTab: DEFAULT_WORKSPACE_TAB,
  pollingEnabled: false,
  showApiKey: false
};

export const EMPTY_PREFLIGHT_SUMMARY = {
  checked: 0,
  available: 0,
  used: 0,
  busy: 0,
  unknown: 0,
  waitingAccounts: 0,
  waitingCdkeys: 0,
  submitted: 0,
  skipped: 0
};

export const ACTIVE_BACKEND_STATUSES = new Set([
  "queued",
  "submitted",
  "pending_dispatch",
  "dispatching",
  "dispatched",
  "running",
  "processing"
]);

export const RESUBMIT_REDEEM_STATUSES = new Set([
  "cancelled",
  "failed",
  "timeout",
  "rejected",
  "invalid",
  "approve_blocked",
  "awaiting_payment_expiry"
]);

export const ATTEMPT_FAILURE_STATUSES = new Set([
  "failed",
  "timeout",
  "rejected",
  "invalid",
  "approve_blocked",
  "awaiting_payment_expiry"
]);

export const DAILY_LIMIT_REDEEM_STATUSES = new Set(["failed", "rejected", "cancelled"]);
```

- [ ] **Step 2: Import constants from `src/App.jsx`**

At the top of `src/App.jsx`, add:

```js
import {
  ACTIVE_BACKEND_STATUSES,
  ATTEMPT_FAILURE_STATUSES,
  AUTO_CYCLE_SCHEDULE_DELAY_MS,
  DAILY_LIMIT_DISPLAY_REASON,
  DAILY_LIMIT_REDEEM_STATUSES,
  DEFAULT_UI_SETTINGS,
  EMPTY_PREFLIGHT_SUMMARY,
  LOCAL_ATTEMPT_LIMIT_REASON,
  POLL_INTERVAL_MS,
  RESUBMIT_REDEEM_STATUSES,
  RETRY_STATUS_HOLD_MS,
  RETRY_STATUS_HOLD_REASON,
  SAMPLE_ACCOUNT,
  STORAGE_KEYS,
  SUBMIT_STATUS_HOLD_REASON,
  WORKSPACE_TABS,
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_ATTEMPT_WINDOW_MS,
  ACCOUNT_COOLDOWN_MS
} from "./config/redeemConstants";
```

Remove the same constant declarations from `src/App.jsx`.

- [ ] **Step 3: Verify no behavior change**

Run:

```powershell
npm test
npm run build
```

Expected:

```text
All tests pass
Vite build succeeds
```

---

## Task 2: Extract Local Storage Loaders

**Files:**
- Create: `src/storage/redeemStorage.js`
- Modify: `src/App.jsx`
- Test: `test/redeemStorage.test.mjs`

- [ ] **Step 1: Create storage helper file**

Create `src/storage/redeemStorage.js`:

```js
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
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 2: Add storage tests**

Create `test/redeemStorage.test.mjs`:

```js
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

test("removeStoredValue removes keys", () => {
  const storage = createMemoryStorage();
  writeStored(storage, "a", "1");
  removeStoredValue(storage, "a");
  assert.equal(readStored(storage, "a"), "");
});
```

- [ ] **Step 3: Wire `src/App.jsx` through storage helpers**

Replace local `loadStored`, `saveStored`, `removeStored`, and `loadStoredJson` implementations with wrappers:

```js
import {
  readStored,
  readStoredJson,
  removeStoredValue,
  writeStored
} from "./storage/redeemStorage";

function loadStored(key) {
  return readStored(window.localStorage, key);
}

function saveStored(key, value) {
  writeStored(window.localStorage, key, value);
}

function removeStored(key) {
  removeStoredValue(window.localStorage, key);
}

function loadStoredJson(key, fallback) {
  return readStoredJson(window.localStorage, key, fallback);
}
```

- [ ] **Step 4: Verify**

Run:

```powershell
npm test
npm run build
```

Expected:

```text
Storage tests pass
Existing redeemState tests pass
Build succeeds
```

---

## Task 3: Move Account/CDK Selectors Out of `App.jsx`

**Files:**
- Create: `src/state/redeemSelectors.js`
- Modify: `src/App.jsx`
- Test: `test/redeemSelectors.test.mjs`

- [ ] **Step 1: Create selector module**

Create `src/state/redeemSelectors.js`:

```js
export function getLatestRowsByCdkey(rowList) {
  const latestByCdkey = new Map();
  (rowList || []).forEach((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey) return;
    const current = latestByCdkey.get(cdkey);
    if (current?.statusOwner === true && row?.statusOwner !== true) return;
    latestByCdkey.set(cdkey, row);
  });
  return [...latestByCdkey.values()];
}

export function computeCdkUsageStats(cdkeys, rows, formatLine) {
  const uniqueRows = getLatestRowsByCdkey(rows);
  const cdkeyValues = new Set((cdkeys || []).map((item) => String(item.cdkey || "").trim()).filter(Boolean));
  const usedRows = uniqueRows.filter((row) => row.status === "success");
  const usedCdkeys = new Set(usedRows.map((row) => String(row.cdkey || "").trim()).filter(Boolean));
  const implicitUnused = [...cdkeyValues].filter((cdkey) => !usedCdkeys.has(cdkey));
  return {
    total: Math.max(cdkeyValues.size, uniqueRows.length),
    checked: uniqueRows.length,
    usedCount: usedRows.length,
    unusedCount: Math.max(Math.max(cdkeyValues.size, uniqueRows.length) - usedRows.length, 0),
    usedText: usedRows.map(formatLine).join("\n"),
    unusedText: implicitUnused.join("\n")
  };
}

export function computeRequestStatusCounts(statusCounts) {
  return {
    waiting:
      (statusCounts.local_ready || 0) +
      (statusCounts.submitting || 0) +
      (statusCounts.pending_dispatch || 0) +
      (statusCounts.queued || 0) +
      (statusCounts.submitted || 0),
    dispatched: (statusCounts.dispatched || 0) + (statusCounts.dispatching || 0),
    running: (statusCounts.running || 0) + (statusCounts.processing || 0),
    failed:
      (statusCounts.failed || 0) +
      (statusCounts.rejected || 0) +
      (statusCounts.invalid || 0) +
      (statusCounts.approve_blocked || 0) +
      (statusCounts.pm_unavailable || 0) +
      (statusCounts.awaiting_payment_expiry || 0)
  };
}
```

- [ ] **Step 2: Add selector tests**

Create `test/redeemSelectors.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCdkUsageStats,
  computeRequestStatusCounts,
  getLatestRowsByCdkey
} from "../src/state/redeemSelectors.js";

test("getLatestRowsByCdkey prefers status owner", () => {
  const rows = [
    { id: "old", cdkey: "A", status: "failed", statusOwner: false },
    { id: "new", cdkey: "A", status: "pending_dispatch", statusOwner: true }
  ];
  assert.deepEqual(getLatestRowsByCdkey(rows).map((row) => row.id), ["new"]);
});

test("computeCdkUsageStats has only used and unused counts", () => {
  const stats = computeCdkUsageStats(
    [{ cdkey: "A" }, { cdkey: "B" }],
    [{ cdkey: "A", status: "success" }],
    (row) => row.cdkey
  );
  assert.equal(stats.usedCount, 1);
  assert.equal(stats.unusedCount, 1);
  assert.equal(stats.usedText, "A");
  assert.equal(stats.unusedText, "B");
});

test("computeRequestStatusCounts groups moving states", () => {
  const counts = computeRequestStatusCounts({
    pending_dispatch: 2,
    dispatched: 1,
    running: 3,
    failed: 4,
    timeout: 1
  });
  assert.equal(counts.waiting, 2);
  assert.equal(counts.dispatched, 1);
  assert.equal(counts.running, 3);
  assert.equal(counts.failed, 4);
});
```

- [ ] **Step 3: Replace local selectors in `App.jsx`**

Move these functions out of `src/App.jsx` and import them from `src/state/redeemSelectors.js`:

```js
import {
  computeCdkUsageStats,
  computeRequestStatusCounts,
  getLatestRowsByCdkey
} from "./state/redeemSelectors";
```

Update `cdkUsageStats` in `App.jsx`:

```js
const cdkUsageStats = useMemo(
  () => computeCdkUsageStats(cdkeyValidation.cdkeys, rows, formatCdkUsageLine),
  [cdkeyValidation.cdkeys, rows]
);
```

Update grouped status counts:

```js
const groupedStatusCounts = useMemo(
  () => computeRequestStatusCounts(statusCounts),
  [statusCounts]
);
const waitingCount = groupedStatusCounts.waiting;
const dispatchedCount = groupedStatusCounts.dispatched;
const runningCount = groupedStatusCounts.running;
const failedCount = groupedStatusCounts.failed;
```

- [ ] **Step 4: Verify**

Run:

```powershell
npm test
npm run build
```

Expected: tests and build pass.

---

## Task 4: Extract Serialized Polling Service

**Files:**
- Create: `src/services/serializedPolling.js`
- Modify: `src/App.jsx`
- Test: `test/serializedPolling.test.mjs`

- [ ] **Step 1: Create polling service**

Create `src/services/serializedPolling.js`:

```js
export function createSerializedPolling({
  intervalMs,
  query,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let timerId = null;
  let inFlight = false;
  let session = 0;
  let running = false;
  let sequence = 0;

  function stop() {
    running = false;
    session += 1;
    inFlight = false;
    if (timerId) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  function start(cdkeys, options = {}) {
    stop();
    const cleanCdkeys = [...new Set((cdkeys || []).map((item) => String(item || "").trim()).filter(Boolean))];
    if (!cleanCdkeys.length) return { started: false, session };
    running = true;
    session += 1;
    const activeSession = session;

    const tick = async () => {
      if (!running || inFlight || activeSession !== session) return;
      inFlight = true;
      const pollingSeq = ++sequence;
      try {
        await query(cleanCdkeys, {
          ...options,
          pollingSession: activeSession,
          pollingSeq
        });
      } finally {
        inFlight = false;
        if (running && activeSession === session) {
          timerId = setTimer(tick, intervalMs);
        }
      }
    };

    timerId = setTimer(tick, intervalMs);
    return { started: true, session: activeSession };
  }

  return {
    start,
    stop,
    isRunning: () => running,
    getSession: () => session
  };
}
```

- [ ] **Step 2: Add polling tests**

Create `test/serializedPolling.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedPolling } from "../src/services/serializedPolling.js";

test("old polling session does not schedule again after restart", async () => {
  const timers = [];
  const calls = [];
  let resolveFirst;
  const firstQuery = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const polling = createSerializedPolling({
    intervalMs: 5,
    query: async (cdkeys, options) => {
      calls.push({ cdkeys, options });
      if (calls.length === 1) await firstQuery;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => {}
  });

  polling.start(["OLD"]);
  await timers.shift()();
  polling.start(["NEW"]);
  resolveFirst();
  await Promise.resolve();

  assert.equal(calls[0].cdkeys[0], "OLD");
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(calls[1].cdkeys[0], "NEW");
});
```

- [ ] **Step 3: Wire `App.jsx` to use the service**

In `src/App.jsx`, import:

```js
import { createSerializedPolling } from "./services/serializedPolling";
```

Create controller ref after `queryStatuses` is declared by using a lazy ref:

```js
const pollingControllerRef = useRef(null);

function getPollingController() {
  if (!pollingControllerRef.current) {
    pollingControllerRef.current = createSerializedPolling({
      intervalMs: POLL_INTERVAL_MS,
      query: queryStatuses,
      setTimer: window.setTimeout,
      clearTimer: window.clearTimeout
    });
  }
  return pollingControllerRef.current;
}
```

Update `startPolling`:

```js
function startPolling(cdkeys, options = {}) {
  const result = getPollingController().start(cdkeys, {
    silent: true,
    forceRemote: options.forceRemote === true,
    keepPollingWhenTerminal: options.keepPollingWhenTerminal === true,
    skipAutoCycle: options.skipAutoCycle === true
  });
  if (!result.started) return;
  setIsPolling(true);
  isPollingRef.current = true;
  pollingSessionRef.current = result.session;
  latestAcceptedPollingSeqRef.current = 0;
  saveUiSettings({ pollingEnabled: true });
}
```

Update `stopPolling`:

```js
function stopPolling(options = {}) {
  const { persist = true } = options;
  getPollingController().stop();
  isPollingRef.current = false;
  pollingInFlightRef.current = false;
  pollingSessionRef.current = getPollingController().getSession();
  setIsPolling(false);
  if (persist) saveUiSettings({ pollingEnabled: false });
}
```

- [ ] **Step 4: Verify**

Run:

```powershell
npm test
npm run build
```

Expected: polling tests pass and build succeeds.

---

## Task 5: Extract Frontend API Client

**Files:**
- Create: `src/services/redeemApi.js`
- Modify: `src/App.jsx`
- Test: `test/redeemApi.test.mjs`

- [ ] **Step 1: Create API client**

Create `src/services/redeemApi.js`:

```js
export function createRedeemApi({ getApiKey, fetchImpl = fetch }) {
  async function callProxy(path, body) {
    const apiKey = String(getApiKey() || "").trim();
    if (!apiKey) {
      throw new Error("请先填写外部 API Key");
    }

    const response = await fetchImpl(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-External-Api-Key": apiKey
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || payload.error || `请求失败：${response.status}`);
    }
    return payload;
  }

  return {
    callProxy,
    submitRedeems: (items) => callProxy("/api/redeem/submit", { items }),
    queryStatuses: (cdkeys) => callProxy("/api/redeem/status", { cdkeys }),
    cancelJobs: (cdkeys) => callProxy("/api/redeem/cancel", { cdkeys }),
    retryJobs: (cdkeys) => callProxy("/api/redeem/retry", { cdkeys }),
    checkSubscription: (token) => callProxy("/api/subscription/check", { token })
  };
}
```

- [ ] **Step 2: Add API tests**

Create `test/redeemApi.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createRedeemApi } from "../src/services/redeemApi.js";

test("callProxy sends API key and JSON body", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "secret",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.queryStatuses(["A"]);
  assert.equal(request.path, "/api/redeem/status");
  assert.equal(request.options.headers["X-External-Api-Key"], "secret");
  assert.deepEqual(JSON.parse(request.options.body), { cdkeys: ["A"] });
});

test("callProxy throws when API key is missing", async () => {
  const api = createRedeemApi({ getApiKey: () => "" });
  await assert.rejects(() => api.queryStatuses(["A"]), /请先填写外部 API Key/);
});
```

- [ ] **Step 3: Replace `callProxy` in `App.jsx`**

Import:

```js
import { createRedeemApi } from "./services/redeemApi";
```

Create:

```js
const redeemApiRef = useRef(null);

function getRedeemApi() {
  if (!redeemApiRef.current) {
    redeemApiRef.current = createRedeemApi({
      getApiKey: () => apiKeyRef.current
    });
  }
  return redeemApiRef.current;
}
```

Add an API key ref:

```js
const apiKeyRef = useRef(apiKey);
useEffect(() => {
  apiKeyRef.current = apiKey;
}, [apiKey]);
```

Replace `callProxy(path, body)` calls with:

```js
getRedeemApi().callProxy(path, body)
```

Then remove the old `callProxy` body from `App.jsx`.

- [ ] **Step 4: Verify**

Run:

```powershell
npm test
npm run build
```

Expected: tests and build pass.

---

## Task 6: Extract Account and CDK Input Controllers

**Files:**
- Create: `src/hooks/useAccountInputController.js`
- Create: `src/hooks/useCdkPoolsController.js`
- Modify: `src/App.jsx`
- Test: `npm test`, `npm run build`

- [ ] **Step 1: Create account input hook**

Create `src/hooks/useAccountInputController.js`:

```js
import { appendImportedText, inspectAccountText, normalizeAccountText } from "../redeemLogic";

export function useAccountInputController({
  accountText,
  setAccountText,
  setErrors,
  setAccountNotice,
  setStatusMessage,
  resetPreflightSummary,
  removeEmailsFromAccountText
}) {
  function applyInspectedAccountText(inspected, messagePrefix) {
    removeEmailsFromAccountText(accountText, inspected.text);
    setAccountText(inspected.text);
    resetPreflightSummary();
    setErrors(inspected.errors);
    setAccountNotice(
      inspected.invalidCount || inspected.duplicateCount
        ? `${messagePrefix}：保留 ${inspected.accountCount} 个有效账号` +
            (inspected.duplicateCount ? `，自动去重 ${inspected.duplicateCount} 行` : "") +
            (inspected.invalidCount ? `，拒绝格式错误 ${inspected.invalidCount} 行` : "")
        : ""
    );
  }

  function handleAccountTextChange(value) {
    const inspected = inspectAccountText(value);
    applyInspectedAccountText(inspected, "账号输入已更新");
  }

  function handleAccountTextPaste(text) {
    const normalized = normalizeAccountText(`${accountText}\n${text}`);
    applyInspectedAccountText(normalized, "粘贴账号已处理");
    setStatusMessage(`已粘贴账号，保留 ${normalized.accountCount} 个有效账号`);
  }

  async function handleAccountFileText(fileName, text) {
    const beforeCount = normalizeAccountText(accountText).accountCount;
    const normalized = normalizeAccountText(appendImportedText(accountText, text));
    const addedCount = Math.max(normalized.accountCount - beforeCount, 0);
    applyInspectedAccountText(normalized, "上传账号已处理");
    setStatusMessage(`已追加账号文件：${fileName}，新增 ${addedCount} 行`);
  }

  return {
    handleAccountTextChange,
    handleAccountTextPaste,
    handleAccountFileText
  };
}
```

- [ ] **Step 2: Create CDK pool hook**

Create `src/hooks/useCdkPoolsController.js`:

```js
import { CDK_POOLS } from "../redeemLogic";

export function useCdkPoolsController({
  cdkeyPools,
  setCdkeyPools,
  setStatusMessage,
  resetPreflightSummary
}) {
  function updateCdkPool(poolId, value) {
    resetPreflightSummary();
    setCdkeyPools((prev) => ({
      ...prev,
      [poolId]: value
    }));
  }

  function appendCdkPool(poolId, text) {
    const cleanText = String(text || "").replace(/^\ufeff/, "");
    updateCdkPool(poolId, [cdkeyPools[poolId], cleanText].filter(Boolean).join("\n"));
    const pool = CDK_POOLS.find((item) => item.id === poolId);
    setStatusMessage(`已导入 ${pool?.label || poolId} 卡密`);
  }

  return {
    updateCdkPool,
    appendCdkPool
  };
}
```

- [ ] **Step 3: Wire hooks into `App.jsx`**

Use these hooks to replace the bodies of:

- `handleAccountFileUpload`
- `handleAccountTextChange`
- `handleAccountTextPaste`
- `applyAccountTextEdit`
- `applyAccountTextPaste`
- `applyAccountTextCleanup`
- `handlePoolFileUpload`
- `updateCdkPool`
- `handleCdkPoolPaste`
- `confirmCdkImport`

Keep the confirmation modal logic in `App.jsx` for this task. Move it only after behavior is stable.

- [ ] **Step 4: Verify**

Run:

```powershell
npm test
npm run build
```

Manual check:

```text
Upload accounts: append, dedupe, invalid-line warning still work.
Paste CDK into each pool: pool text updates and preflight summary resets.
Deleting account text removes queue/cooldown/attempt residue.
```

---

## Task 7: Extract Request/Export Components

**Files:**
- Create component files under `src/components/`
- Modify: `src/App.jsx`
- Test: `npm run build`

- [ ] **Step 1: Move common components**

Create:

- `src/components/common/PanelHeader.jsx`
- `src/components/common/StatusCard.jsx`
- `src/components/common/WorkspaceTabs.jsx`

Each file exports one component. Example `StatusCard.jsx`:

```jsx
export function StatusCard({ label, value, tone = "", title = "" }) {
  return (
    <div className={`status-card ${tone}`} title={title || label}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
```

Update `App.jsx` imports:

```js
import { PanelHeader } from "./components/common/PanelHeader";
import { StatusCard } from "./components/common/StatusCard";
import { WorkspaceTabs } from "./components/common/WorkspaceTabs";
```

Remove the moved component definitions from the bottom of `App.jsx`.

- [ ] **Step 2: Move form components**

Create:

- `src/components/forms/InputPanel.jsx`
- `src/components/forms/CdkPoolCard.jsx`

`InputPanel.jsx`:

```jsx
export function InputPanel({ title, subtitle, count, icon, actions, children }) {
  return (
    <section className="input-panel">
      <div className="section-heading compact">
        <div className="panel-title-row">
          <span className="panel-icon">{icon}</span>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
        </div>
        <div className="panel-actions">
          {count ? <span className="count-pill">{count}</span> : null}
          {actions}
        </div>
      </div>
      {children}
    </section>
  );
}
```

Move `CdkPoolCard` without changing props or markup.

- [ ] **Step 3: Move request table components**

Create:

- `src/components/request/RowProgress.jsx`
- `src/components/request/RequestTable.jsx`
- `src/components/request/SelectedRowDetail.jsx`

`RowProgress.jsx` must take a precomputed progress object to avoid importing App helpers:

```jsx
export function RowProgress({ progress }) {
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(progress.percent || 0))));
  return (
    <div className={`row-progress ${progress.tone}`} title={`${progress.label} ${safePercent}%`}>
      <div className="row-progress-meta">
        <span>{progress.label}</span>
        <strong>{safePercent}%</strong>
      </div>
      <div className="row-progress-track" aria-hidden="true">
        <span style={{ width: `${safePercent}%` }} />
      </div>
    </div>
  );
}
```

In `App.jsx`, pass `getRowRedeemProgress(row)` or `computeRowProgress(row)` into the component:

```jsx
<RowProgress progress={getRowRedeemProgress(row)} />
```

- [ ] **Step 4: Move export cards**

Create:

- `src/components/export/ResultExportCard.jsx`
- `src/components/export/CdkUsageCard.jsx`
- `src/components/export/BackendRedeemCard.jsx`

Move the existing card markup with no behavior change. Actions stay passed as props:

```jsx
<ResultExportCard
  title="UPI 成功导出"
  subtitle="仅 success + Plus + UPI 卡密池"
  value={successExports.upi}
  canCopy={canCopyUpiSuccess}
  onCopy={() => copySuccessOutput("upi")}
  onDownload={() => downloadSuccessOutput("upi")}
/>
```

- [ ] **Step 5: Verify**

Run:

```powershell
npm run build
```

Expected: build succeeds and `App.jsx` is at least 1000 lines smaller.

---

## Task 8: Split CSS by Responsibility

**Files:**
- Create: `src/styles/base.css`
- Create: `src/styles/layout.css`
- Create: `src/styles/forms.css`
- Create: `src/styles/tables.css`
- Create: `src/styles/export.css`
- Create: `src/styles/dialogs.css`
- Modify: `src/styles.css`

- [ ] **Step 1: Turn `src/styles.css` into an import hub**

Replace the top of `src/styles.css` with:

```css
@import "./styles/base.css";
@import "./styles/layout.css";
@import "./styles/forms.css";
@import "./styles/tables.css";
@import "./styles/export.css";
@import "./styles/dialogs.css";
```

Then move existing rules into the matching file:

- `base.css`: `:root`, `*`, `body`, typography, buttons shared by all pages.
- `layout.css`: app shell, workspace tabs, prep/execute/export grid layouts.
- `forms.css`: API key panel, account input, CDK pools, upload buttons, validation notes.
- `tables.css`: request table, row progress, selection toolbar, detail panel.
- `export.css`: success export cards, CDK usage card, backend/account status textareas.
- `dialogs.css`: toast, clear confirm modal, import dialog, pending delete confirmation.

- [ ] **Step 2: Verify CSS import order**

Run:

```powershell
npm run build
```

Expected:

```text
Vite build succeeds
No CSS @import order warnings
```

- [ ] **Step 3: Browser layout check**

Open local page:

```text
http://127.0.0.1:5173/
```

Check:

- Three workspace tabs still switch.
- Request table scrolls horizontally.
- Row progress stays compact.
- Result export cards wrap without huge empty columns.
- CDK usage card only shows used/unused.

---

## Task 9: Thin `App.jsx` Into an Orchestrator

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/hooks/useRedeemWorkflow.js`
- Modify: `src/hooks/useAccountInputController.js`
- Modify: `src/hooks/useCdkPoolsController.js`

- [ ] **Step 1: Create workflow hook shell**

Create `src/hooks/useRedeemWorkflow.js`:

```js
export function useRedeemWorkflow(deps) {
  return {
    submitRedeems: deps.submitRedeems,
    queryFromInputOrRows: deps.queryFromInputOrRows,
    startPollingFromInputOrRows: deps.startPollingFromInputOrRows,
    cancelRows: deps.cancelRows,
    retryFailedRows: deps.retryFailedRows,
    retryOrResubmitRows: deps.retryOrResubmitRows,
    deleteRows: deps.deleteRows,
    deletePlusAccounts: deps.deletePlusAccounts
  };
}
```

This first step is intentionally a pass-through so imports and call sites are stable before moving logic.

- [ ] **Step 2: Move one action group at a time**

Move action groups in this order:

1. Query/polling: `queryFromInputOrRows`, `startPollingFromInputOrRows`, `queryStatuses`, `startPolling`, `stopPolling`.
2. Job actions: `cancelRows`, `retryRows`, `retryFailedRows`, `runJobAction`.
3. Submit actions: `preflightCdkeysForSubmit`, `submitSelectedRedeemRows`, `submitRedeems`.
4. Plus/delete/export actions: `checkPlusSubscriptions`, `recheckPlusRows`, `deletePlusAccounts`, `downloadSuccessOutput`.

After each group, run:

```powershell
npm test
npm run build
```

Expected after each group:

```text
Tests pass
Build succeeds
No prop/function missing runtime error in browser console
```

- [ ] **Step 3: Final `App.jsx` shape**

Target structure:

```jsx
export default function App() {
  const state = useRedeemState();
  const accountInput = useAccountInputController(...);
  const cdkPools = useCdkPoolsController(...);
  const workflow = useRedeemWorkflow(...);

  return (
    <div className="pipeline-shell">
      <Header ... />
      <WorkspaceTabs ... />
      <WorkspacePanel id="prep">...</WorkspacePanel>
      <WorkspacePanel id="execute">...</WorkspacePanel>
      <WorkspacePanel id="exports">...</WorkspacePanel>
      <Dialogs ... />
      <Toast ... />
    </div>
  );
}
```

`App.jsx` should not contain:

- localStorage parser implementations
- fetch/proxy implementation
- polling timer loop implementation
- table row component markup
- export card component markup
- CSS-like layout decisions embedded in logic

- [ ] **Step 4: Verify final size**

Run:

```powershell
(Get-Content -LiteralPath src/App.jsx | Measure-Object -Line).Lines
npm test
npm run build
```

Expected:

```text
src/App.jsx line count under 900
All tests pass
Build succeeds
```

---

## Task 10: Final Local QA Checklist

**Files:**
- No new files.
- Verify local browser only.

- [ ] **Step 1: Run automated checks**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected:

```text
npm test: pass
npm run build: pass
git diff --check: no whitespace errors
```

- [ ] **Step 2: Manual flow check**

Open:

```text
http://127.0.0.1:5173/
```

Check these flows:

1. Import accounts, paste CDKs, start redeem.
2. Preflight blocks unknown CDK item but treats missing returned item as unused.
3. Cancelled CDK can be resubmitted.
4. Third attempt can submit; fourth attempt is blocked.
5. Backend 24h cooldown text marks account `3/3 次 + 冷却` and auto-cycles the CDK.
6. Deleted account does not return in auto-cycle.
7. Polling does not resurrect old CDK lists after restart.
8. Result export still downloads `.txt` and copy/download toasts still show.

- [ ] **Step 3: Confirm no deployment actions happened**

Run:

```powershell
git status --short
```

Expected:

```text
Only local file changes are shown.
No GitHub push and no Hong Kong server deployment was performed.
```

---

## Execution Order

1. Task 0: baseline freeze.
2. Task 1: constants.
3. Task 2: storage.
4. Task 3: selectors.
5. Task 4: polling service.
6. Task 5: API client.
7. Task 6: account/CDK input hooks.
8. Task 7: UI components.
9. Task 8: CSS split.
10. Task 9: workflow hook and App orchestrator cleanup.
11. Task 10: final local QA.

## Subagent Split for Execution

- Worker A: constants, storage, selectors, and their Node tests. Owns `src/config/`, `src/storage/`, `src/state/`, and related tests.
- Worker B: polling service, API client, and workflow hook. Owns `src/services/`, `src/hooks/useRedeemWorkflow.js`, and related tests.
- Worker C: UI component extraction and CSS split. Owns `src/components/` and `src/styles/`.
- Reviewer: TypeScript/JavaScript reviewer checks import cycles, stale closure risks, and behavior parity after each worker lands changes.

## Non-Goals

- Do not upload GitHub.
- Do not deploy to the Hong Kong server.
- Do not change backend external API request bodies.
- Do not add Redux, Zustand, React Query, Tailwind, or a new UI framework.
- Do not rewrite the app as a new project.
- Do not change the user-facing redemption rules while splitting files.

## Self-Review

- Spec coverage: plan splits large files, preserves the full redemption flow, and makes process boundaries clearer.
- Placeholder scan: no unresolved placeholders; each task has concrete files, commands, and expected outcomes.
- Type consistency: planned module names and imports match the file structure listed at the top.
