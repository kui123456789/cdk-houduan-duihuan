# CDK Redeem State Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修整 CDK 后端兑换控制台的账号队列、卡密预检、自动换号、轮询状态和统计面板，让页面数字与真实可兑换状态一致。

**Architecture:** 先把“账号是否可用 / CDK 是否可用 / 行是否当前负责人 / 是否冷却”提成可测试的纯函数，再让提交、轮询、自动换号、统计面板全部复用同一套事实源。保留当前 Vite React + 本地 Express 代理结构，不改后端接口，不上传 GitHub，不部署香港服务器，除非用户后续明确下令。

**Tech Stack:** Vite, React 18, Express 5, Node ESM, Node built-in test runner.

---

## File Structure

- Modify: `package.json`  
  Add a local `test` script using Node built-in test runner.
- Create: `src/redeemState.js`  
  Pure state helpers for account availability, CDK preflight classification, cooldown rules, attempt rules, row progress, and stats.
- Create: `test/redeemState.test.mjs`  
  Node tests for the helper behavior that caused recent UI defects.
- Modify: `src/App.jsx`  
  Replace duplicated local calculations with `src/redeemState.js`; fix submit, auto-cycle, polling, cooldown, and UI stats integration.
- Modify: `src/redeemLogic.js`  
  Keep status merge owner-safe; add or adjust exported pure helpers only if they are already status-normalization related.
- Modify: `src/styles.css`  
  Layout polish for compact stats, CDK usage card, and row progress.

---

## Task 1: Add Pure State Test Harness

**Files:**
- Modify: `package.json`
- Create: `src/redeemState.js`
- Create: `test/redeemState.test.mjs`

- [ ] **Step 1: Add the test command**

Change `package.json` scripts to include:

```json
"test": "node --test"
```

Expected scripts:

```json
{
  "dev": "concurrently \"npm:server\" \"npm:client\"",
  "client": "vite --host 127.0.0.1",
  "server": "node server/index.js",
  "build": "vite build",
  "preview": "vite preview --host 127.0.0.1",
  "start": "node server/index.js",
  "test": "node --test"
}
```

- [ ] **Step 2: Create `src/redeemState.js` with stable helper contracts**

Create these named exports:

```js
export const ACCOUNT_ATTEMPT_LIMIT = 3;
export const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function isCooldownReason(value) {
  const text = String(value || "");
  return /今日提交次数|提交次数已达上限|24\s*小时后|24小时后|超过\s*3\s*次限制|已尝试\s*3\s*次/.test(text);
}

export function isExplicitCancelReason(value) {
  const text = String(value || "");
  return /用户取消|已取消兑换|CDK\s*可重新提交|可重新提交/.test(text);
}

export function isCooling(email, cooldowns, now = Date.now()) {
  const key = normalizeEmail(email);
  const item = cooldowns?.[key];
  return Boolean(item?.until && Number(item.until) > now);
}

export function getAttemptCount(email, attemptLedger) {
  const key = normalizeEmail(email);
  return Math.max(0, Number(attemptLedger?.[key]?.count || 0));
}

export function getNextAttemptCount(email, attemptLedger) {
  return Math.min(ACCOUNT_ATTEMPT_LIMIT, getAttemptCount(email, attemptLedger) + 1);
}

export function isFourthAttemptBlocked(email, attemptLedger) {
  return getAttemptCount(email, attemptLedger) >= ACCOUNT_ATTEMPT_LIMIT;
}

export function classifyCdkeyPreflight(item, blockedReason = "") {
  if (!item) {
    return { usable: true, used: false, occupied: false, reason: "" };
  }

  const status = String(item.status || item.state || item.result || "").toLowerCase();
  const reason = String(item.reason || item.message || item.error_message || blockedReason || "");
  if (status === "success") {
    return { usable: false, used: true, occupied: false, reason: reason || "卡密已使用" };
  }
  if (["pending_dispatch", "dispatched", "running", "processing", "queued"].includes(status)) {
    return { usable: false, used: false, occupied: true, reason: reason || "卡密占用中" };
  }
  if (["not_found", "unused", ""].includes(status)) {
    return { usable: true, used: false, occupied: false, reason: "" };
  }
  if (status === "failed" && isExplicitCancelReason(reason)) {
    return { usable: true, used: false, occupied: false, reason };
  }
  return { usable: false, used: false, occupied: true, reason: reason || "卡密状态已返回，暂不重复提交" };
}

export function computeAccountFacts({ accounts, rows, cooldowns, attemptLedger, processedEmails = new Set(), now = Date.now() }) {
  const taskEmails = new Set(
    rows
      .filter((row) => row?.email && row?.statusOwner !== false && !row?.hidden)
      .filter((row) => ["local_ready", "submitting", "pending_dispatch", "dispatched", "running", "processing"].includes(row.status))
      .map((row) => normalizeEmail(row.email))
  );

  const facts = {
    pool: accounts.length,
    available: 0,
    cooling: 0,
    attemptBlocked: 0,
    taskOccupied: 0,
    processed: 0,
    availableAccounts: [],
    blockedEmails: new Set()
  };

  for (const account of accounts) {
    const email = normalizeEmail(account.email);
    if (!email) continue;
    if (processedEmails.has(email)) {
      facts.processed += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    if (isCooling(email, cooldowns, now)) {
      facts.cooling += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    if (isFourthAttemptBlocked(email, attemptLedger)) {
      facts.attemptBlocked += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    if (taskEmails.has(email)) {
      facts.taskOccupied += 1;
      facts.blockedEmails.add(email);
      continue;
    }
    facts.available += 1;
    facts.availableAccounts.push(account);
  }

  return facts;
}

export function computeRowProgress(row) {
  const status = String(row?.status || "unknown").toLowerCase();
  if (["success"].includes(status)) return { label: "成功", percent: 100, tone: "success" };
  if (["failed", "rejected", "timeout", "invalid", "approve_blocked", "pm_unavailable", "awaiting_payment_expiry"].includes(status)) {
    if (row?.cooldownUntil || isCooldownReason(row?.reason || row?.error_message)) {
      return { label: "冷却", percent: 100, tone: "warning" };
    }
    return { label: "失败", percent: 100, tone: "danger" };
  }
  if (["cancelled", "not_found", "unused", "unknown"].includes(status)) return { label: status === "cancelled" ? "已取消" : "未使用", percent: 100, tone: "muted" };
  if (["running", "processing"].includes(status)) return { label: "兑换中", percent: 75, tone: "active" };
  if (["dispatching", "dispatched"].includes(status)) return { label: "已派发", percent: 55, tone: "active" };
  if (["queued", "submitted", "pending_dispatch"].includes(status)) return { label: "待兑换", percent: 25, tone: "pending" };
  return { label: "准备中", percent: 15, tone: "pending" };
}
```

- [ ] **Step 3: Write failing helper tests**

Create `test/redeemState.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  classifyCdkeyPreflight,
  computeAccountFacts,
  computeRowProgress,
  getNextAttemptCount,
  isCooldownReason,
  isFourthAttemptBlocked
} from "../src/redeemState.js";

test("missing CDK status item means unused and available", () => {
  assert.deepEqual(classifyCdkeyPreflight(undefined), {
    usable: true,
    used: false,
    occupied: false,
    reason: ""
  });
});

test("returned success CDK is used and not submitable", () => {
  const result = classifyCdkeyPreflight({ status: "success", reason: "兑换成功" });
  assert.equal(result.usable, false);
  assert.equal(result.used, true);
});

test("explicit cancelled failed CDK can be resubmitted", () => {
  const result = classifyCdkeyPreflight({ status: "failed", reason: "用户取消，CDK 可重新提交" });
  assert.equal(result.usable, true);
  assert.equal(result.reason, "用户取消，CDK 可重新提交");
});

test("cooldown reason is detected from backend text", () => {
  assert.equal(isCooldownReason("该邮箱今日提交次数已达上限（3 次），请 24 小时后再试"), true);
});

test("third attempt is allowed and fourth is blocked", () => {
  const email = "a@example.com";
  assert.equal(getNextAttemptCount(email, { [email]: { count: 2 } }), ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(isFourthAttemptBlocked(email, { [email]: { count: 2 } }), false);
  assert.equal(isFourthAttemptBlocked(email, { [email]: { count: 3 } }), true);
});

test("account facts separate pool, available, cooling, attempts, and active tasks", () => {
  const accounts = [
    { email: "free@example.com" },
    { email: "cool@example.com" },
    { email: "done@example.com" },
    { email: "busy@example.com" },
    { email: "max@example.com" }
  ];
  const facts = computeAccountFacts({
    accounts,
    rows: [{ email: "busy@example.com", status: "pending_dispatch", statusOwner: true }],
    cooldowns: { "cool@example.com": { until: 2000 } },
    attemptLedger: { "max@example.com": { count: 3 } },
    processedEmails: new Set(["done@example.com"]),
    now: 1000
  });
  assert.equal(facts.pool, 5);
  assert.equal(facts.available, 1);
  assert.equal(facts.cooling, 1);
  assert.equal(facts.processed, 1);
  assert.equal(facts.taskOccupied, 1);
  assert.equal(facts.attemptBlocked, 1);
  assert.equal(facts.availableAccounts[0].email, "free@example.com");
});

test("row progress shows cooldown as warning at 100 percent", () => {
  const progress = computeRowProgress({ status: "failed", reason: "今日提交次数已达上限，请 24 小时后再试" });
  assert.deepEqual(progress, { label: "冷却", percent: 100, tone: "warning" });
});
```

- [ ] **Step 4: Run test and verify expected failures before wiring**

Run:

```powershell
npm test
```

Expected before implementation is complete: missing module or failing assertions. After Step 2 is complete: all helper tests pass.

---

## Task 2: Make Account Availability the Single Source of Truth

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/redeemState.js`
- Test: `test/redeemState.test.mjs`

- [ ] **Step 1: Replace local account availability calculations**

In `src/App.jsx`, import:

```js
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ACCOUNT_COOLDOWN_MS,
  classifyCdkeyPreflight,
  computeAccountFacts,
  computeRowProgress,
  isCooldownReason,
  isExplicitCancelReason,
  isFourthAttemptBlocked,
  normalizeEmail
} from "./redeemState";
```

Then change `getSubmitAccountAvailability` to delegate to `computeAccountFacts`. It must pass:

```js
{
  accounts,
  rows: rowList,
  cooldowns,
  attemptLedger,
  processedEmails: new Set(getSuccessExportsByPool(rowList).allEmails || []),
  now: Date.now()
}
```

If `getSuccessExportsByPool` does not expose email sets, compute `processedEmails` from rows where `status === "success"` and `isPlus === true`.

- [ ] **Step 2: Rename misleading UI labels**

In the execution stats panel:

- `账号池`: imported valid account count.
- `可用账号`: accounts that can be submitted now.
- `冷却账号`: accounts still inside 24h cooldown.
- `已达 3/3`: accounts blocked by local attempt ledger.
- `正在兑换账号`: accounts attached to active owner rows.
- `已处理 Plus`: accounts already moved to success export.

Remove `剩余账号` if it is computed from raw input. If a remaining number is needed, name it `可分配账号` and make it equal to `facts.available`.

- [ ] **Step 3: Reconcile deleted account text with runtime queue**

When account text changes or the user deletes exported/success accounts, rebuild the available queue from current parsed account text. The submit path must not use accounts that are no longer present in the account input text.

Implementation rule:

```js
const currentAccountEmails = new Set(parsedAccounts.map((account) => normalizeEmail(account.email)));
const reconciledRows = rows.filter((row) => {
  if (!row.email) return true;
  if (row.statusOwner && ["pending_dispatch", "dispatched", "running", "processing"].includes(row.status)) return true;
  return currentAccountEmails.has(normalizeEmail(row.email)) || row.status === "success";
});
```

This keeps live tasks visible but prevents deleted idle accounts from being reused.

- [ ] **Step 4: Verify account stats**

Run:

```powershell
npm test
npm run build
```

Manual check: import 25 accounts and 10 CDKs. Before submit, stats should show `账号池 25`, `可用账号 25`, `卡密总数 10`. After 10 active tasks, it should show active task rows separately and not claim only 14 usable accounts unless 1 is cooling or 3/3 blocked.

---

## Task 3: Fix CDK Preflight and Usage Semantics

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/redeemState.js`
- Test: `test/redeemState.test.mjs`

- [ ] **Step 1: Use `classifyCdkeyPreflight` everywhere**

In `preflightCdkeysForSubmit`, replace local bucket logic with `classifyCdkeyPreflight(item, blockedReason)`.

Rules:

- Backend returned no item for a CDK: `usable`.
- Backend returned `success`: `used`.
- Backend returned active status: `occupied`.
- Backend returned explicit user cancel / CDK can resubmit: `usable`.
- Status API request failed entirely: do not submit; show `卡密状态查询失败，请重试`.

- [ ] **Step 2: Stop fail-open on status request failure**

Current behavior treats request failure as available. Change it to:

```js
if (preflightError) {
  summary.blocked += 1;
  blockedCdkeys.push({ cdkey, reason: "卡密状态查询失败，请重试" });
  return;
}
```

Keep the user rule intact: missing item inside a successful response means unused. Only transport/API failure blocks submission.

- [ ] **Step 3: CDK usage card only shows used and unused**

In the CDK usage card stats:

```js
const used = cdkeys.filter((cdkey) => usedSet.has(cdkey)).length;
const unused = total - used;
```

Do not display `待确认`. If the backend has no returned record, show it as unused.

- [ ] **Step 4: Verify CDK preflight scenarios**

Run:

```powershell
npm test
npm run build
```

Manual checks:

- 9 CDKs, backend returns no item: can submit.
- 9 CDKs, request fails: does not submit and shows clear retry message.
- Cancelled CDK with `用户取消，CDK 可重新提交`: can submit.

---

## Task 4: Replace Round Logic with Per-Email Attempt Logic

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/redeemState.js`
- Test: `test/redeemState.test.mjs`

- [ ] **Step 1: Remove user-visible round fields**

Remove table column and stats for:

- `轮次`
- `自动轮次`
- `第 X/3 轮`

Keep only `尝试`, formatted as:

```js
`${Math.min(row.accountAttemptNumber || 1, ACCOUNT_ATTEMPT_LIMIT)}/3 次`
```

- [ ] **Step 2: Enforce third attempt allowed, fourth blocked**

Before submitting any account:

```js
if (isFourthAttemptBlocked(account.email, accountAttemptLedger)) {
  markAccountCooling(account.email, "账号 24 小时内已尝试 3 次，超过 3 次限制");
  skipSubmitForThisAccount();
}
```

When submitting:

```js
const accountAttemptNumber = getNextAttemptCount(account.email, accountAttemptLedger);
```

The third submission is allowed. Only the fourth attempt is blocked locally.

- [ ] **Step 3: Backend cooldown overrides local count**

When any backend `status/reason/error_message/message` contains cooldown text:

- set row `status = "failed"`
- set row progress to cooldown
- set `accountAttemptNumber = 3`
- write `accountCooldowns[email] = { until: Date.now() + ACCOUNT_COOLDOWN_MS, reason }`
- release the CDK if the response says it can retry/reuse or the reason is explicit cooldown

- [ ] **Step 4: New account after auto-cycle starts at its own attempt**

When `processAutoCycleFailures` chooses the next account, the attempt count must come from that next email only. It must not inherit the old row attempt number.

Expected replacement row fields:

```js
{
  accountAttemptNumber: getNextAttemptCount(nextAccount.email, accountAttemptLedger),
  status: "pending_dispatch",
  statusOwner: true,
  replacedFromRowId: failedRow.id
}
```

- [ ] **Step 5: Verify attempt behavior**

Run:

```powershell
npm test
npm run build
```

Manual checks:

- First submit: `1/3 次`.
- Auto-cycle to a different email: new row `1/3 次`.
- Same email third submit: `3/3 次` and still allowed.
- Fourth submit: not sent to backend, moves to cooldown.

---

## Task 5: Make Auto-Cycle Immediate and Owner-Safe

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/redeemLogic.js`

- [ ] **Step 1: Keep a 1 second auto-cycle scheduler**

Use one timer:

```js
const autoCycleScheduleTimerRef = useRef(null);
```

When `queryStatuses`, `submitRedeems`, `submitSelectedRedeemRows`, or subscription/cooldown handling creates an auto-cycle candidate:

```js
scheduleAutoCycleFailures(rowsRef.current, { reason: "detected-failure" });
```

Scheduler behavior:

- If timer exists, do not create another.
- After 1000 ms, call `processAutoCycleFailures(rowsRef.current)`.
- Show `检测到 X 条失败，1 秒内合并后自动换号`.

- [ ] **Step 2: Release CDK from cooling accounts**

`isAutoCycleFailureCandidate(row)` must return true when:

- row has `cdkey`
- row is current `statusOwner`
- row status is failed/cancelled/timeout/rejected
- row is explicit cooldown OR `can_retry === true` OR `can_reuse_token === true`
- row is not `pm_unavailable`

When replacement row is created:

- old row: `statusOwner = false`, `hidden = true`, `autoCycleHandled = true`
- new row: `statusOwner = true`
- same CDK and channel, next available account AT

- [ ] **Step 3: Stop duplicate status ownership**

Before adding replacement rows:

```js
rows = rows.map((row) =>
  row.cdkey === failedRow.cdkey ? { ...row, statusOwner: false } : row
);
```

Then append the new owner row.

- [ ] **Step 4: Verify auto-cycle**

Manual checks:

- One cooling row releases its CDK to the next account within about 1 second.
- Eight cooling rows create up to eight replacement rows in one merged submit.
- If no available account exists, show `自动换号没有可用账号，请补充账号`.

---

## Task 6: Serialize Polling and Status Merge

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/redeemLogic.js`

- [ ] **Step 1: Replace overlapping `setInterval` polling**

Use refs:

```js
const pollingTimerRef = useRef(null);
const pollingInFlightRef = useRef(false);
const pollingSeqRef = useRef(0);
```

Polling loop:

```js
const runPollingTick = async () => {
  if (!isPollingRef.current || pollingInFlightRef.current) return;
  pollingInFlightRef.current = true;
  const seq = ++pollingSeqRef.current;
  try {
    await queryStatuses(getPollCdkeys(), { source: "polling", seq });
  } finally {
    pollingInFlightRef.current = false;
    if (isPollingRef.current) {
      pollingTimerRef.current = window.setTimeout(runPollingTick, 5000);
    }
  }
};
```

Stop polling clears the timeout.

- [ ] **Step 2: Drop stale responses**

In `queryStatuses`, if `options.seq` exists and is older than the latest accepted sequence, do not merge it.

- [ ] **Step 3: Explicit cancel beats retry hold**

In status merge:

- Explicit cancel reason updates immediately.
- Generic old `cancelled/failed/timeout` can still be held during retry-hold.

Use `isExplicitCancelReason(reason)` for this decision.

- [ ] **Step 4: Verify status merge**

Manual checks:

- Backend says `用户取消，CDK 可重新提交`: row becomes `已取消` immediately.
- Re-submit row: row shows `待兑换` and old generic failure does not overwrite it for the hold window.
- Polling stays at one request at a time in Network panel.

---

## Task 7: UI Cleanup and Local Verification

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Compact stats panel**

Use a dense grid with consistent labels:

- `总任务`
- `卡密总数`
- `账号池`
- `可用账号`
- `待兑换`
- `已派发`
- `兑换中`
- `已使用`
- `未使用`
- `失败`
- `超时`
- `已取消`
- `可重兑`
- `跳过`
- `冷却账号`

Do not show `失败组`.

- [ ] **Step 2: Keep row progress inline only**

No global progress bars. Each row has:

```jsx
<RowProgress row={row} />
```

Use `computeRowProgress(row)` and keep text compact. The percent text must fit inside the row without stretching.

- [ ] **Step 3: Result page layout**

Keep result page sections:

- UPI success export
- IDEAL success export
- account redeem status
- CDK usage detail with only used/unused
- backend redeem detail
- error rows

Make cards wrap naturally at desktop width and avoid large empty columns.

- [ ] **Step 4: Run verification**

Run:

```powershell
npm test
npm run build
```

Local manual verification at `http://127.0.0.1:5173/`:

1. Import 25 accounts + 10 CDKs. Start redeem. Exactly 10 rows should submit.
2. Cancel 10 rows. Rows should show cancelled; reusable CDKs can be submitted again.
3. Force cooldown text from backend. Account should show `3/3 次 + 冷却`; CDK should auto-cycle to another account.
4. Delete two accounts from input. They must not reappear in later submit pools.
5. Query status repeatedly. No stale polling response should revert newer row status.
6. CDK usage card shows only used and unused.
7. Build passes.

---

## Execution Order

1. Task 1: tests and helper module.
2. Task 6: polling and status merge protection.
3. Task 2: account facts, deleted-account reconciliation, and stats source.
4. Task 4: attempt/cooldown rule.
5. Task 5: auto-cycle speed and CDK release.
6. Task 3: CDK preflight source.
7. Task 7: UI layout and final verification.

The priority is intentional: stale polling responses and deleted-account residue can keep reintroducing wrong rows after any UI-only fix. Stabilize status ownership first, then make the visible numbers read from the stabilized state.

## Subagent Split

- Worker A: Task 1 and Task 6. Owns `src/redeemState.js`, `test/redeemState.test.mjs`, polling serialization, and status merge protection.
- Worker B: Task 2 and Task 4. Owns account availability, deleted-account reconciliation, attempts, cooldown, and localStorage cleanup in `src/App.jsx`.
- Worker C: Task 5, Task 3, and Task 7. Owns auto-cycle, CDK release/preflight, stats cards, CDK usage card, and CSS polish.
- Reviewer: TypeScript/JavaScript reviewer checks race conditions, localStorage migration, and status-owner invariants after implementation.

## Subagent Review Notes Included

- Fix stale polling before UI stats: `startPolling()` and `queryStatuses()` currently have the highest chance of reverting newer rows with old responses.
- Deleting an account must clear or reconcile all places that can reuse it: account input, rows, auto-cycle queue, cooldown ledger, and attempt ledger.
- Plus checking must not delay failed-row replacement; auto-cycle scheduling should happen before slow subscription checks.
- CDK usage and task status are separate: CDK usage card shows only used/unused, while pending/running/failed stays in backend task detail.
- Sensitive localStorage cleanup needs explicit handling when using one-key clear or deleting accounts.

## Non-Goals

- Do not upload to GitHub.
- Do not deploy to the Hong Kong server.
- Do not change backend external API request bodies.
- Do not remove API Key localStorage behavior unless the user asks.
- Do not add a database or server-side persistence layer.

## Self-Review

- Spec coverage: covers stats mismatch, cooldown count, attempt limit, CDK used/unused, deleted account reuse, slow auto-cycle, polling overlap, and explicit cancel status.
- Placeholder scan: no `TBD`, no unspecified test command, no deploy step.
- Type consistency: helper names are defined in Task 1 and reused by later tasks.
