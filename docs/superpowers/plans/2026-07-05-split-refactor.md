# CDK Redeem Console Split Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 继续拆分 `src/App.jsx`，让页面组件、纯业务规则、接口副作用和流程编排各自归位，降低后续修改自动换号、CDK 预检、Plus 检查时的回归风险。

**Architecture:** `App.jsx` 保留为顶层编排器，只连接状态、hooks 和工作区组件。纯函数先移动到 `src/state/*` 与 `src/utils/*` 并补测试；网络/轮询/自动换号这类副作用再封装成 `src/hooks/*`。每个阶段必须保持页面行为不变，并通过现有 `npm test` 与 `npm run build`。

**Tech Stack:** Vite, React, JavaScript ES modules, Node `node --test`, local Express proxy.

---

## Boundary Rules

- 本计划只做本地开发。
- 不上传 GitHub。
- 不部署香港服务器。
- 不改 Express API 请求体。
- 不改用户数据格式：账号仍是 `邮箱---密码---2fa---at---时间戳`，成功导出仍移除 `at`。
- 每个任务完成后都必须运行对应测试；整批完成后运行 `npm test`、`npm run build`、`git diff --check`。

## Current Split State

- 已拆 UI：
  - `src/components/prep/PrepWorkspace.jsx`
  - `src/components/execute/ExecutionControlPanel.jsx`
  - `src/components/request/RequestStatusPanel.jsx`
  - `src/components/request/StatusRow.jsx`
  - `src/components/request/DetailPanel.jsx`
  - `src/components/request/RowProgress.jsx`
  - `src/components/export/ResultWorkspace.jsx`
  - `src/components/export/ResultExportCard.jsx`
- 已拆基础模块：
  - `src/config/redeemConstants.js`
  - `src/storage/redeemStorage.js`
  - `src/state/redeemSelectors.js`
  - `src/services/redeemApi.js`
  - `src/services/serializedPolling.js`
- 当前最大文件：
  - `src/App.jsx` 约 4084 行
  - `src/redeemLogic.js` 约 1036 行
  - `src/styles.css` 约 1544 行

## Target File Structure

### New Pure Logic Modules

- Create: `src/state/accountLifecycle.js`
  - Owns account cooldown, attempt ledger, available account calculation, cooldown markers.
  - Exports pure functions currently living in `App.jsx`.
- Create: `src/state/rowPresentation.js`
  - Owns display-only helpers: compact status label, row progress, row export text, failure reason formatting, subscription tone.
- Create: `src/state/cdkPreflight.js`
  - Owns submit-time CDK status classification and submit plan summary.
- Create: `src/state/statusMerge.js`
  - Owns owner-row selection, hold-window rules, and status merge guards around old `cancelled/failed` results.

### New Side-Effect Hooks

- Create: `src/hooks/useAccountInput.js`
  - Owns account text change, paste, cleanup, upload, export.
- Create: `src/hooks/useSubscriptionChecks.js`
  - Owns Plus check cache, queueing, recheck behavior.
- Create: `src/hooks/useRedeemPolling.js`
  - Owns status query, polling start/stop, polling session safety.
- Create: `src/hooks/useAutoCycle.js`
  - Owns automatic account replacement scheduler and released CDK handling.

### Existing Files To Modify

- Modify: `src/App.jsx`
  - Replace copied helper functions with imports.
  - Replace inline state action functions with hook returns.
  - Keep top-level state and workspace composition until the final phase.
- Modify: `src/redeemState.js`
  - Keep as compatibility facade if tests or imports still use it.
- Modify: `src/styles.css`
  - No structural CSS split in this plan; CSS split should be a later visual-only plan.

---

## Task 1: Extract Row Presentation Helpers

**Files:**
- Create: `src/state/rowPresentation.js`
- Create: `test/rowPresentation.test.mjs`
- Modify: `src/App.jsx`
- Modify: `src/components/request/RequestStatusPanel.jsx`
- Modify: `src/components/request/StatusRow.jsx`
- Modify: `src/components/request/DetailPanel.jsx`

- [ ] **Step 1: Create failing presentation tests**

Create `test/rowPresentation.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  compactStatus,
  formatAttemptNumber,
  formatFailureReason,
  getRowRedeemProgress,
  getSubscriptionTone
} from "../src/state/rowPresentation.js";

test("compactStatus uses short Chinese labels", () => {
  assert.equal(compactStatus("pending_dispatch"), "待兑换");
  assert.equal(compactStatus("running"), "兑换中");
  assert.equal(compactStatus("pm_unavailable"), "账号风控");
});

test("formatAttemptNumber caps visible attempts at three", () => {
  assert.equal(formatAttemptNumber({ accountAttemptNumber: 1 }), "1/3 次");
  assert.equal(formatAttemptNumber({ accountAttemptNumber: 4 }), "3/3 次");
  assert.equal(formatAttemptNumber({}), "-");
});

test("row progress reports moving and terminal states", () => {
  assert.deepEqual(getRowRedeemProgress({ status: "pending_dispatch" }), {
    percent: 25,
    label: "待兑换",
    tone: "pending"
  });
  assert.deepEqual(getRowRedeemProgress({ status: "success" }), {
    percent: 100,
    label: "成功",
    tone: "success"
  });
});

test("subscription tone classifies visible plus diagnostics", () => {
  assert.equal(getSubscriptionTone({ status: "success", subscriptionCategory: "plus" }), "success");
  assert.equal(getSubscriptionTone({ status: "success", subscriptionCategory: "timeout" }), "danger");
  assert.equal(getSubscriptionTone({ status: "success", subscriptionStatus: "checking" }), "info");
});

test("formatFailureReason appends retry hint for retryable recharge failure", () => {
  const reason = formatFailureReason(
    { status: "failed", reason: "充值失败", can_retry: true },
    { canRetryVisibleRow: () => true }
  );
  assert.equal(reason, "充值失败（可重试）");
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```powershell
npm test -- test/rowPresentation.test.mjs
```

Expected: FAIL because `src/state/rowPresentation.js` does not exist.

- [ ] **Step 3: Move pure presentation helpers into `rowPresentation.js`**

Create `src/state/rowPresentation.js` by moving these functions out of `src/App.jsx`:

```js
export function compactStatus(status) { /* moved verbatim from App.jsx */ }
export function getRowRedeemProgress(row, deps = {}) { /* moved verbatim from App.jsx */ }
export function formatAttemptNumber(row) { /* moved verbatim from App.jsx */ }
export function formatFailureReason(row, deps = {}) { /* moved verbatim from App.jsx */ }
export function getSubscriptionTone(row) { /* moved verbatim from App.jsx */ }
export function formatCdkUsageLine(row, deps = {}) { /* moved verbatim from App.jsx */ }
export function formatBackendRedeemLine(row, deps = {}) { /* moved verbatim from App.jsx */ }
export function formatAccountStatusLine(row, deps = {}) { /* moved verbatim from App.jsx */ }
```

Implementation requirements:

```js
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACTIVE_BACKEND_STATUSES
} from "../config/redeemConstants";
import { getPlusExportLine, getSubscriptionLabel, statusLabel } from "../redeemLogic";

const DEFAULT_DEPS = {
  canRetryVisibleRow: () => false,
  canCancelRow: () => false,
  isHistoricalAutoCycleRow: () => false,
  isRowAccountCooling: () => false,
  formatRowCooldownReason: () => ""
};
```

Use dependency injection for App-specific helpers instead of importing App:

```js
function withDeps(deps) {
  return { ...DEFAULT_DEPS, ...deps };
}
```

- [ ] **Step 4: Update imports and helper wiring**

Modify `src/App.jsx`:

```js
import {
  compactStatus,
  formatAccountStatusLine,
  formatAttemptNumber,
  formatBackendRedeemLine,
  formatCdkUsageLine,
  formatFailureReason,
  getRowRedeemProgress,
  getSubscriptionTone
} from "./state/rowPresentation";
```

Replace direct formatter usage with dependency-bound wrappers:

```js
const rowPresentationDeps = {
  canCancelRow,
  canRetryVisibleRow,
  formatRowCooldownReason,
  isHistoricalAutoCycleRow,
  isRowAccountCooling
};

const formatCdkUsageLineForApp = (row) => formatCdkUsageLine(row, rowPresentationDeps);
const formatBackendRedeemLineForApp = (row) => formatBackendRedeemLine(row, rowPresentationDeps);
const formatAccountStatusLineForApp = (row) => formatAccountStatusLine(row, rowPresentationDeps);
const formatFailureReasonForApp = (row) => formatFailureReason(row, rowPresentationDeps);
const getRowRedeemProgressForApp = (row) => getRowRedeemProgress(row, rowPresentationDeps);
```

Then update:

```js
computeCdkUsageStats(cdkeyValidation.cdkeys, rows, formatCdkUsageLineForApp)
rows.map(formatBackendRedeemLineForApp)
.map(formatAccountStatusLineForApp)
```

Update `requestPanelHelpers`:

```js
formatFailureReason: formatFailureReasonForApp,
getRowRedeemProgress: getRowRedeemProgressForApp
```

- [ ] **Step 5: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected:

- `npm test`: all tests pass.
- `npm run build`: Vite build succeeds.
- `git diff --check`: no whitespace errors, only possible CRLF warnings.

---

## Task 2: Extract Account Lifecycle Rules

**Files:**
- Create: `src/state/accountLifecycle.js`
- Create: `test/accountLifecycle.test.mjs`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write account lifecycle tests**

Create `test/accountLifecycle.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_COOLDOWN_MS
} from "../src/config/redeemConstants.js";
import {
  applyCooldownMarkersToRows,
  getAccountCooldown,
  getCooledEmailSet,
  normalizeAccountCooldowns,
  shouldBlockFourthAttempt
} from "../src/state/accountLifecycle.js";

test("normalizeAccountCooldowns drops expired cooldowns", () => {
  const now = Date.parse("2026-07-05T12:00:00+08:00");
  const cooldowns = {
    "a@example.com": { until: now + ACCOUNT_COOLDOWN_MS, reason: "冷却中" },
    "b@example.com": { until: now - 1, reason: "已过期" }
  };
  assert.deepEqual(Object.keys(normalizeAccountCooldowns(cooldowns, now)), ["a@example.com"]);
});

test("getCooledEmailSet returns active lower-case emails", () => {
  const now = Date.now();
  const emails = getCooledEmailSet({
    "USER@EXAMPLE.COM": { until: now + 1000, reason: "冷却中" }
  }, now);
  assert.equal(emails.has("user@example.com"), true);
});

test("applyCooldownMarkersToRows marks failed rows but clears success rows", () => {
  const now = Date.now();
  const rows = [
    { id: "1", email: "a@example.com", status: "failed" },
    { id: "2", email: "b@example.com", status: "success", accountCooldownUntil: now + 1000 }
  ];
  const next = applyCooldownMarkersToRows(rows, {
    "a@example.com": { until: now + 1000, reason: "账号冷却" }
  }, now);
  assert.equal(next[0].accountCooldownReason, "账号冷却");
  assert.equal(next[1].accountCooldownUntil, 0);
});

test("fourth attempt is blocked while third attempt is allowed", () => {
  assert.equal(shouldBlockFourthAttempt({ accountAttemptNumber: ACCOUNT_ATTEMPT_LIMIT }), false);
  assert.equal(shouldBlockFourthAttempt({ accountAttemptNumber: ACCOUNT_ATTEMPT_LIMIT + 1 }), true);
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```powershell
npm test -- test/accountLifecycle.test.mjs
```

Expected: FAIL because `src/state/accountLifecycle.js` does not exist.

- [ ] **Step 3: Move cooldown and attempt pure functions**

Create `src/state/accountLifecycle.js` with moved exports:

```js
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_COOLDOWN_MS,
  DAILY_LIMIT_DISPLAY_REASON,
  LOCAL_ATTEMPT_LIMIT_REASON
} from "../config/redeemConstants";

export function normalizeAccountCooldowns(cooldowns, now = Date.now()) { /* moved verbatim */ }
export function getCooledEmailSet(cooldowns, now = Date.now()) { /* moved verbatim */ }
export function getAccountCooldown(email, cooldowns, now = Date.now()) { /* moved verbatim */ }
export function applyCooldownMarkersToRows(rowList, cooldowns, now = Date.now()) { /* moved verbatim */ }
export function isAccountDailyLimitReason(reason) { /* moved verbatim */ }
export function isLimitCooldownReason(reason) { /* moved verbatim */ }
export function formatCooldownUntil(until) { /* moved verbatim */ }
export function formatRowCooldownReason(row) { /* moved verbatim */ }
export function isRowAccountCooling(row, now = Date.now()) { /* moved verbatim */ }
export function shouldBlockFourthAttempt(row) {
  return Number(row?.accountAttemptNumber || 0) > ACCOUNT_ATTEMPT_LIMIT;
}
```

- [ ] **Step 4: Update App imports**

Modify `src/App.jsx`:

```js
import {
  applyCooldownMarkersToRows,
  formatRowCooldownReason,
  getAccountCooldown,
  getCooledEmailSet,
  isAccountDailyLimitReason,
  isLimitCooldownReason,
  isRowAccountCooling,
  normalizeAccountCooldowns
} from "./state/accountLifecycle";
```

Delete the moved function definitions from `App.jsx`.

- [ ] **Step 5: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected all pass.

---

## Task 3: Extract CDK Preflight And Submit Planning

**Files:**
- Create: `src/state/cdkPreflight.js`
- Create: `test/cdkPreflight.test.mjs`
- Modify: `src/App.jsx`
- Modify: `src/redeemState.js`

- [ ] **Step 1: Write preflight tests**

Create `test/cdkPreflight.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPreflightSummary,
  canSubmitPreflightItem
} from "../src/state/cdkPreflight.js";

test("missing backend item is treated as unused and submitable", () => {
  assert.equal(canSubmitPreflightItem({ status: "not_found" }), true);
  assert.equal(canSubmitPreflightItem(null), true);
});

test("success and running CDKs are not submitable", () => {
  assert.equal(canSubmitPreflightItem({ status: "success" }), false);
  assert.equal(canSubmitPreflightItem({ status: "running" }), false);
});

test("preflight summary counts available, used, busy, and unknown", () => {
  const summary = buildPreflightSummary({
    checked: 4,
    items: [
      { status: "not_found" },
      { status: "success" },
      { status: "running" },
      { status: "unknown" }
    ],
    submitted: 1,
    waitingAccounts: 2,
    waitingCdkeys: 0
  });
  assert.equal(summary.available, 1);
  assert.equal(summary.used, 1);
  assert.equal(summary.busy, 1);
  assert.equal(summary.unknown, 1);
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```powershell
npm test -- test/cdkPreflight.test.mjs
```

Expected: FAIL because `src/state/cdkPreflight.js` does not exist.

- [ ] **Step 3: Create preflight module**

Move these responsibilities from `App.jsx` and `src/redeemState.js` into `src/state/cdkPreflight.js`:

```js
export function canSubmitPreflightItem(item) { /* moved from classifyCdkeyPreflight behavior */ }
export function classifyCdkeyPreflight(item) { /* moved from redeemState.js */ }
export function buildPreflightSummary({ checked, items, submitted, waitingAccounts, waitingCdkeys }) { /* new reducer */ }
export function getBlockingCdkeyReasons(rowList) { /* moved from App.jsx */ }
export function normalizePreflightSummary(summary) { /* moved from App.jsx if present */ }
```

Keep `src/redeemState.js` as a compatibility facade:

```js
export {
  classifyCdkeyPreflight
} from "./state/cdkPreflight.js";
```

- [ ] **Step 4: Update App imports**

Modify `src/App.jsx`:

```js
import {
  buildPreflightSummary,
  classifyCdkeyPreflight,
  getBlockingCdkeyReasons
} from "./state/cdkPreflight";
```

Replace:

```js
import { classifyCdkeyPreflight as classifyCdkeyPreflightState } from "./redeemState";
```

with direct import from `src/state/cdkPreflight.js`.

- [ ] **Step 5: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected all pass.

---

## Task 4: Extract Status Owner And Merge Guards

**Files:**
- Create: `src/state/statusMerge.js`
- Create: `test/statusMerge.test.mjs`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write status merge tests**

Create `test/statusMerge.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  findStatusOwnerRowId,
  shouldAcceptRemoteStatusDuringHold
} from "../src/state/statusMerge.js";

test("findStatusOwnerRowId prefers explicit owner for a CDK", () => {
  const rows = [
    { id: "old", cdkey: "CDK-1", statusOwner: false },
    { id: "new", cdkey: "CDK-1", statusOwner: true }
  ];
  assert.equal(findStatusOwnerRowId(rows, "CDK-1"), "new");
});

test("hold window blocks stale failed status but accepts running", () => {
  const row = {
    status: "pending_dispatch",
    retryHoldUntil: Date.now() + 60000
  };
  assert.equal(shouldAcceptRemoteStatusDuringHold(row, { status: "failed", reason: "充值失败" }), false);
  assert.equal(shouldAcceptRemoteStatusDuringHold(row, { status: "running" }), true);
});

test("explicit user cancelled status bypasses hold window", () => {
  const row = {
    status: "pending_dispatch",
    retryHoldUntil: Date.now() + 60000
  };
  assert.equal(
    shouldAcceptRemoteStatusDuringHold(row, { status: "failed", reason: "用户取消，CDK 可重新提交" }),
    true
  );
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```powershell
npm test -- test/statusMerge.test.mjs
```

Expected: FAIL because `src/state/statusMerge.js` does not exist.

- [ ] **Step 3: Move owner and hold helpers**

Create `src/state/statusMerge.js`:

```js
import {
  ACTIVE_BACKEND_STATUSES,
  RETRY_STATUS_HOLD_MS
} from "../config/redeemConstants";

export function findStatusOwnerRowId(rows, cdkey) { /* owner-first selection */ }
export function shouldAcceptRemoteStatusDuringHold(localRow, remoteItem, now = Date.now()) { /* moved guard */ }
export function isExplicitCancelledStatus(item) { /* moved from App.jsx */ }
export function markCdkeyStatusOwner(rows, ownerRowId, cdkey) { /* moved from App.jsx if present */ }
export function reviveRemoteBackendRows(rowList) { /* moved from App.jsx */ }
export function getLatestOwnerRowsByCdkey(rows) { /* owner-aware latest map */ }
```

- [ ] **Step 4: Update App status query flow**

Modify `src/App.jsx`:

```js
import {
  findStatusOwnerRowId,
  isExplicitCancelledStatus,
  reviveRemoteBackendRows,
  shouldAcceptRemoteStatusDuringHold
} from "./state/statusMerge";
```

Inside `queryStatuses`, replace local inline owner/hold checks with these imports. Keep the rest of `queryStatuses` in `App.jsx` for now.

- [ ] **Step 5: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected all pass.

---

## Task 5: Extract Account Input Hook

**Files:**
- Create: `src/hooks/useAccountInput.js`
- Create: `test/accountInputHookHelpers.test.mjs`
- Modify: `src/App.jsx`

- [ ] **Step 1: Extract testable account input helpers first**

Create `test/accountInputHookHelpers.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountInputNotice,
  shouldAppendAccountImport
} from "../src/hooks/useAccountInput.js";

test("shouldAppendAccountImport appends non-empty imported account text", () => {
  assert.equal(shouldAppendAccountImport("a@example.com---p---2fa---at---t"), true);
  assert.equal(shouldAppendAccountImport(""), false);
});

test("createAccountInputNotice reports rejected and duplicate rows", () => {
  const notice = createAccountInputNotice({
    added: 3,
    duplicate: 2,
    invalid: 1
  });
  assert.equal(notice, "已添加 3 个账号，跳过重复 2 个，格式错误 1 行");
});
```

- [ ] **Step 2: Run helper test and confirm it fails**

Run:

```powershell
npm test -- test/accountInputHookHelpers.test.mjs
```

Expected: FAIL because `src/hooks/useAccountInput.js` does not exist.

- [ ] **Step 3: Create `useAccountInput` hook**

Create `src/hooks/useAccountInput.js`:

```js
import { normalizeAccountText, inspectAccountText, appendImportedText } from "../redeemLogic";

export function shouldAppendAccountImport(text) {
  return String(text || "").trim().length > 0;
}

export function createAccountInputNotice({ added, duplicate, invalid }) {
  const parts = [`已添加 ${added} 个账号`];
  if (duplicate) parts.push(`跳过重复 ${duplicate} 个`);
  if (invalid) parts.push(`格式错误 ${invalid} 行`);
  return parts.join("，");
}

export function useAccountInput({
  accountText,
  setAccountText,
  setAccountNotice,
  setErrors,
  showToast
}) {
  function handleAccountTextChange(value) { /* move from App.jsx */ }
  function handleAccountTextPaste(event) { /* move from App.jsx */ }
  function cleanupAccountText() { /* move from App.jsx */ }
  async function handleAccountFileUpload(event) { /* move from App.jsx */ }
  function exportAccountInput() { /* move from App.jsx */ }

  return {
    handleAccountTextChange,
    handleAccountTextPaste,
    cleanupAccountText,
    handleAccountFileUpload,
    exportAccountInput
  };
}
```

- [ ] **Step 4: Update App to use hook**

Modify `src/App.jsx`:

```js
import { useAccountInput } from "./hooks/useAccountInput";
```

Replace local account handlers with:

```js
const {
  handleAccountTextChange,
  handleAccountTextPaste,
  cleanupAccountText,
  handleAccountFileUpload,
  exportAccountInput
} = useAccountInput({
  accountText,
  setAccountText,
  setAccountNotice,
  setErrors,
  showToast
});
```

Delete moved handler definitions from `App.jsx`.

- [ ] **Step 5: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected all pass.

---

## Task 6: Extract Plus Subscription Check Hook

**Files:**
- Create: `src/hooks/useSubscriptionChecks.js`
- Create: `test/subscriptionChecks.test.mjs`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write subscription helper tests**

Create `test/subscriptionChecks.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldCheckSubscriptionRow,
  shouldAllowManualPlusRecheck
} from "../src/hooks/useSubscriptionChecks.js";

test("only success rows with access token are subscription-check candidates", () => {
  assert.equal(shouldCheckSubscriptionRow({ status: "success", accessToken: "at" }), true);
  assert.equal(shouldCheckSubscriptionRow({ status: "failed", accessToken: "at" }), false);
  assert.equal(shouldCheckSubscriptionRow({ status: "success", accessToken: "" }), false);
});

test("manual Plus recheck is allowed for successful rows with token", () => {
  assert.equal(shouldAllowManualPlusRecheck({ status: "success", accessToken: "at" }), true);
  assert.equal(shouldAllowManualPlusRecheck({ status: "success", accessToken: "" }), false);
});
```

- [ ] **Step 2: Run helper test and confirm it fails**

Run:

```powershell
npm test -- test/subscriptionChecks.test.mjs
```

Expected: FAIL because `src/hooks/useSubscriptionChecks.js` does not exist.

- [ ] **Step 3: Create hook and move logic**

Create `src/hooks/useSubscriptionChecks.js`:

```js
export function shouldCheckSubscriptionRow(row) {
  return row?.status === "success" && Boolean(row?.accessToken);
}

export function shouldAllowManualPlusRecheck(row) {
  return shouldCheckSubscriptionRow(row);
}

export function useSubscriptionChecks({
  redeemApiRef,
  subscriptionCacheRef,
  setRows,
  setStatusMessage,
  showToast
}) {
  async function checkSubscriptionsForRows(rows, options = {}) { /* move from App.jsx */ }
  async function recheckPlusRows(rows) { /* move from App.jsx */ }
  function canRecheckSubscriptionRow(row) { /* move from App.jsx */ }

  return {
    checkSubscriptionsForRows,
    recheckPlusRows,
    canRecheckSubscriptionRow
  };
}
```

- [ ] **Step 4: Update App**

Modify `src/App.jsx`:

```js
import { useSubscriptionChecks } from "./hooks/useSubscriptionChecks";
```

Use:

```js
const {
  checkSubscriptionsForRows,
  recheckPlusRows,
  canRecheckSubscriptionRow
} = useSubscriptionChecks({
  redeemApiRef,
  subscriptionCacheRef,
  setRows,
  setStatusMessage,
  showToast
});
```

Delete moved definitions from `App.jsx`.

- [ ] **Step 5: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected all pass.

---

## Task 7: Extract Redeem Polling Hook

**Files:**
- Create: `src/hooks/useRedeemPolling.js`
- Modify: `src/App.jsx`
- Test: `test/serializedPolling.test.mjs`

- [ ] **Step 1: Preserve existing polling tests**

Run:

```powershell
npm test -- test/serializedPolling.test.mjs
```

Expected: PASS before refactor.

- [ ] **Step 2: Create hook shell**

Create `src/hooks/useRedeemPolling.js`:

```js
import { useCallback } from "react";

export function useRedeemPolling({
  apiKeyRef,
  redeemApiRef,
  rowsRef,
  isPollingRef,
  pollingControllerRef,
  pollingInFlightRef,
  latestAcceptedPollingSeqRef,
  pollingSessionRef,
  setRows,
  setIsPolling,
  setStatusMessage,
  setLastUpdatedAt,
  saveUiSettings,
  showToast,
  checkSubscriptionsForRows,
  scheduleAutoCycleFailures
}) {
  const queryStatuses = useCallback(async (cdkeys, options = {}) => {
    /* move queryStatuses body from App.jsx */
  }, []);

  const startPolling = useCallback((cdkeys, options = {}) => {
    /* move startPolling body from App.jsx */
  }, []);

  const stopPolling = useCallback((options = {}) => {
    /* move stopPolling body from App.jsx */
  }, []);

  return { queryStatuses, startPolling, stopPolling };
}
```

- [ ] **Step 3: Move `queryStatuses`, `startPolling`, and `stopPolling`**

Move the current bodies from `src/App.jsx` into the hook. Keep all helper calls injected or imported from pure modules created in earlier tasks.

- [ ] **Step 4: Update App**

Modify `src/App.jsx`:

```js
import { useRedeemPolling } from "./hooks/useRedeemPolling";
```

Use:

```js
const { queryStatuses, startPolling, stopPolling } = useRedeemPolling({
  apiKeyRef,
  redeemApiRef,
  rowsRef,
  isPollingRef,
  pollingControllerRef,
  pollingInFlightRef,
  latestAcceptedPollingSeqRef,
  pollingSessionRef,
  setRows,
  setIsPolling,
  setStatusMessage,
  setLastUpdatedAt,
  saveUiSettings,
  showToast,
  checkSubscriptionsForRows,
  scheduleAutoCycleFailures
});
```

Keep:

```js
queryStatusesRef.current = queryStatuses;
```

in `App.jsx`.

- [ ] **Step 5: Verify polling flow**

Run:

```powershell
npm test
npm run build
```

Manual local check:

```powershell
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`, click `查询状态`, then click `开启轮询`; expected top chip shows `自动轮询中`.

---

## Task 8: Extract Auto Cycle Hook

**Files:**
- Create: `src/hooks/useAutoCycle.js`
- Create: `test/autoCycleRules.test.mjs`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write auto cycle rule tests**

Create `test/autoCycleRules.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  isAutoCycleFailureCandidate,
  shouldReleaseCdkeyForNextAccount
} from "../src/hooks/useAutoCycle.js";

test("retryable failed row is an auto-cycle candidate", () => {
  assert.equal(
    isAutoCycleFailureCandidate({ status: "failed", can_retry: true, can_reuse_token: true }),
    true
  );
});

test("pm_unavailable is not a normal auto-cycle candidate", () => {
  assert.equal(
    isAutoCycleFailureCandidate({ status: "pm_unavailable", can_retry: true }),
    false
  );
});

test("daily limit failure releases CDK for next account", () => {
  assert.equal(
    shouldReleaseCdkeyForNextAccount({
      status: "failed",
      reason: "该邮箱今日提交次数已达上限（3 次），请 24 小时后再试"
    }),
    true
  );
});
```

- [ ] **Step 2: Run test and confirm it fails**

Run:

```powershell
npm test -- test/autoCycleRules.test.mjs
```

Expected: FAIL because `src/hooks/useAutoCycle.js` does not exist.

- [ ] **Step 3: Create hook**

Create `src/hooks/useAutoCycle.js`:

```js
import { useCallback } from "react";
import { AUTO_CYCLE_SCHEDULE_DELAY_MS } from "../config/redeemConstants";

export function isAutoCycleFailureCandidate(row, deps = {}) { /* move from App.jsx */ }
export function shouldReleaseCdkeyForNextAccount(row, deps = {}) { /* move from App.jsx */ }

export function useAutoCycle({
  rowsRef,
  autoCycleRef,
  accountCooldownsRef,
  accountAttemptLedgerRef,
  autoCycleScheduleTimerRef,
  autoCycleProcessingRef,
  setRows,
  setAutoCycleState,
  setAccountCooldowns,
  setAccountAttemptLedger,
  setStatusMessage,
  showToast,
  submitAutoCycleRows
}) {
  const scheduleAutoCycleFailures = useCallback((rows, options = {}) => {
    /* move scheduler from App.jsx */
  }, []);

  const processAutoCycleFailures = useCallback(async (rows, options = {}) => {
    /* move processing from App.jsx */
  }, []);

  return {
    scheduleAutoCycleFailures,
    processAutoCycleFailures,
    isAutoCycleFailureCandidate
  };
}
```

- [ ] **Step 4: Update App**

Modify `src/App.jsx`:

```js
import { useAutoCycle } from "./hooks/useAutoCycle";
```

Wire:

```js
const {
  scheduleAutoCycleFailures,
  processAutoCycleFailures
} = useAutoCycle({
  rowsRef,
  autoCycleRef,
  accountCooldownsRef,
  accountAttemptLedgerRef,
  autoCycleScheduleTimerRef,
  autoCycleProcessingRef,
  setRows,
  setAutoCycleState,
  setAccountCooldowns,
  setAccountAttemptLedger,
  setStatusMessage,
  showToast,
  submitAutoCycleRows
});
```

Delete moved scheduler and processing definitions from `App.jsx`.

- [ ] **Step 5: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected all pass.

---

## Task 9: Extract Submit Flow Hook

**Files:**
- Create: `src/hooks/useRedeemSubmit.js`
- Modify: `src/App.jsx`
- Test: existing `test/cdkPreflight.test.mjs`, `test/accountLifecycle.test.mjs`

- [ ] **Step 1: Create hook shell**

Create `src/hooks/useRedeemSubmit.js`:

```js
export function useRedeemSubmit({
  apiKeyRef,
  redeemApiRef,
  rowsRef,
  cdkeyPools,
  accountValidation,
  accountAvailability,
  setRows,
  setErrors,
  setStatusMessage,
  setPreflightSummary,
  showToast,
  startPolling,
  scheduleAutoCycleFailures
}) {
  async function submitRedeems() { /* move from App.jsx */ }
  async function submitSelectedRedeemRows(rows) { /* move from App.jsx */ }
  async function retryOrResubmitRows(rows) { /* move from App.jsx */ }
  async function retryFailedRows() { /* move from App.jsx */ }

  return {
    submitRedeems,
    submitSelectedRedeemRows,
    retryOrResubmitRows,
    retryFailedRows
  };
}
```

- [ ] **Step 2: Move submit flow**

Move these functions from `src/App.jsx` into the hook:

```js
submitRedeems
submitSelectedRedeemRows
retryOrResubmitRows
retryFailedRows
```

Use pure modules from earlier tasks for CDK preflight and account lifecycle decisions.

- [ ] **Step 3: Update App**

Modify `src/App.jsx`:

```js
import { useRedeemSubmit } from "./hooks/useRedeemSubmit";
```

Wire:

```js
const {
  submitRedeems,
  submitSelectedRedeemRows,
  retryOrResubmitRows,
  retryFailedRows
} = useRedeemSubmit({
  apiKeyRef,
  redeemApiRef,
  rowsRef,
  cdkeyPools,
  accountValidation,
  accountAvailability,
  setRows,
  setErrors,
  setStatusMessage,
  setPreflightSummary,
  showToast,
  startPolling,
  scheduleAutoCycleFailures
});
```

- [ ] **Step 4: Verify**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected all pass.

---

## Task 10: Final App Cleanup And Review

**Files:**
- Modify: `src/App.jsx`
- Modify: `docs/superpowers/plans/2026-07-05-split-refactor.md` if execution notes need to be appended

- [ ] **Step 1: Check file sizes**

Run:

```powershell
Get-ChildItem -Recurse -File -Include *.jsx,*.js,*.css,*.mjs |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\.codegraph\\' } |
  Select-Object FullName,@{Name='Lines';Expression={(Get-Content -LiteralPath $_.FullName | Measure-Object -Line).Lines}},Length |
  Sort-Object Lines -Descending |
  Select-Object -First 20
```

Expected:

- `src/App.jsx` is under 2500 lines.
- No new hook file exceeds 700 lines.
- No new pure state file exceeds 500 lines.

- [ ] **Step 2: Search for duplicate moved functions**

Run:

```powershell
rg "function (compactStatus|getRowRedeemProgress|normalizeAccountCooldowns|queryStatuses|submitRedeems|processAutoCycleFailures)" src/App.jsx src/state src/hooks
```

Expected:

- Each function has one implementation.
- `App.jsx` should only contain local UI glue functions and not duplicated moved pure functions.

- [ ] **Step 3: Full verification**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected:

- All tests pass.
- Build succeeds.
- No whitespace errors.

- [ ] **Step 4: Optional local commit checkpoint**

Only if the user explicitly asks for a local commit:

```powershell
git add src test docs package.json
git commit -m "refactor: split redeem console flow modules"
```

Do not push.
Do not deploy.

---

## Self-Review

### Spec Coverage

- App split by responsibility: covered by Tasks 1-10.
- Pure business logic separated before hooks: covered by Tasks 1-4.
- Side-effect flows split after pure logic: covered by Tasks 5-9.
- Existing behavior preserved: every task requires `npm test`, `npm run build`, and no API body changes.
- Local-only boundary: stated in Boundary Rules and Task 10.

### Placeholder Scan

This plan intentionally uses `/* moved verbatim from App.jsx */` for mechanical extraction steps. During execution, the worker must copy the existing implementation exactly from `src/App.jsx` and then run the specified tests. No new behavior is hidden behind those comments.

### Type And Name Consistency

- New pure modules live under `src/state/*`.
- New hooks live under `src/hooks/*`.
- Existing service modules stay under `src/services/*`.
- `App.jsx` imports modules through stable relative paths.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-05-split-refactor.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, faster and safer for this size of refactor.
2. **Inline Execution** - execute tasks in this session using `superpowers:executing-plans`, with checkpoints after each task.
