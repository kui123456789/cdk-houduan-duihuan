# Workflow State Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the redeem console around one workflow state core so account counts, CDK ownership, cooldowns, polling, auto-cycle, and logs stay consistent.

**Architecture:** Keep the current React UI and Express proxy working while introducing a single event-driven workflow layer. Existing rows remain the UI compatibility shape at first, but all submit/poll/auto-cycle/Plus updates must pass through one reducer and one account lifecycle ledger instead of multiple hooks mutating rows independently.

**Tech Stack:** React 18, Vite, Express 5, Node `node --test`, current localStorage helpers, current backend proxy endpoints.

---

## Non-Negotiables

- Local development only: do not push to GitHub and do not deploy to the Hong Kong server unless the user explicitly asks.
- Preserve current endpoints and request bodies:
  - `POST /api/redeem/submit`
  - `POST /api/redeem/status`
  - `POST /api/redeem/cancel`
  - `POST /api/redeem/retry`
  - `POST /api/subscription/check`
- Preserve current user-facing workflow:
  - three workspaces
  - CDK preflight
  - cancelled rows can resubmit
  - 24-hour cooldown after backend limit
  - one account has three allowed attempts, fourth is blocked locally
  - same CDK can move to the next account when the current account fails in a reusable way
- Run verification after every task:
  - `npm test`
  - `npm run build`
  - `git diff --check`

---

## File Structure Target

### New Workflow Core

- Create `src/workflow/redeemEvents.js`
  - Defines all workflow event names and event creator helpers.
  - No React imports.

- Create `src/workflow/accountLedger.js`
  - Single source of truth for account attempts, cooldown state, and availability facts.
  - Replaces scattered use of `accountCooldowns`, `accountAttemptLedger`, row cooldown flags, and failed account lists.

- Create `src/workflow/redeemTaskModel.js`
  - Owns the task/row reducer.
  - Converts backend submit/status/retry/cancel results into deterministic row updates.
  - Preserves the existing UI row shape while centralizing mutation.

- Create `src/workflow/workflowSelectors.js`
  - Derives counts for `账号池`, `可兑换`, `冷却账号`, `已达 3/3`, `待兑换`, `已派发`, `兑换中`, CDK used/unused.
  - Replaces duplicated count calculations in `App.jsx`.

- Create `src/workflow/activityLog.js`
  - Append-only log event model.
  - Stores log entries with time, level, action, email, CDK, and message.

### New React Boundary

- Create `src/hooks/useRedeemWorkflow.js`
  - React wrapper around workflow reducer, persistence, and side-effect commands.
  - Exposes actions to UI: `submitRedeems`, `queryStatuses`, `startPolling`, `stopPolling`, `retryRows`, `cancelRows`, `checkPlus`.

- Modify `src/hooks/useRedeemSubmit.js`
  - Either remove after migration or shrink to a compatibility wrapper around `useRedeemWorkflow`.

- Modify `src/hooks/useAutoCycle.js`
  - Either remove after migration or shrink to scheduling only; no direct row mutation.

- Modify `src/hooks/useRedeemPolling.js`
  - Keep serialized polling mechanics, but polling result dispatches a workflow event instead of mutating rows directly.

- Modify `src/App.jsx`
  - Keep layout and workspace composition.
  - Remove direct row mutation helpers once workflow hook owns them.

### Persistence and Security

- Create `src/storage/workflowPersistence.js`
  - Loads/saves workflow state in one versioned document.
  - Handles legacy migration from old storage keys.

- Modify `src/config/redeemConstants.js`
  - Add versioned workflow storage key.
  - Add sensitive persistence policy key.

### Server Split

- Create `server/app.js`
  - `createApp({ fetchImpl, config })` for testable Express app.

- Create `server/proxy.js`
  - `forwardJson`, `proxyBatches`, upstream response sanitization.

- Create `server/subscription.js`
  - Subscription diagnostic logic.

- Keep `server/index.js`
  - Only loads config, creates app, starts listening.

### Tests

- Create `test/workflowEvents.test.mjs`
- Create `test/accountLedger.test.mjs`
- Create `test/redeemTaskModel.test.mjs`
- Create `test/workflowSelectors.test.mjs`
- Create `test/activityLog.test.mjs`
- Create `test/workflowPersistence.test.mjs`
- Create `test/serverProxy.test.mjs`

---

## Task 1: Define Workflow Events

**Files:**
- Create: `src/workflow/redeemEvents.js`
- Test: `test/workflowEvents.test.mjs`

- [ ] **Step 1: Write failing tests for event creators**

```js
// test/workflowEvents.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_EVENTS,
  createWorkflowEvent,
  createSubmitAcceptedEvent,
  createStatusReceivedEvent,
  createAccountCooldownEvent
} from "../src/workflow/redeemEvents.js";

test("createWorkflowEvent adds stable id and timestamp", () => {
  const event = createWorkflowEvent(WORKFLOW_EVENTS.SUBMIT_REQUESTED, {
    source: "start-button"
  });

  assert.equal(event.type, WORKFLOW_EVENTS.SUBMIT_REQUESTED);
  assert.equal(event.source, "start-button");
  assert.equal(typeof event.id, "string");
  assert.equal(typeof event.createdAt, "number");
});

test("createSubmitAcceptedEvent preserves submitted row ids and backend items", () => {
  const event = createSubmitAcceptedEvent({
    rowIds: ["row-1"],
    items: [{ cdkey: "AAAA-BBBB-CCCC-DDDD", status: "pending_dispatch" }],
    message: "提交完成"
  });

  assert.equal(event.type, WORKFLOW_EVENTS.SUBMIT_ACCEPTED);
  assert.deepEqual(event.rowIds, ["row-1"]);
  assert.equal(event.items[0].cdkey, "AAAA-BBBB-CCCC-DDDD");
  assert.equal(event.message, "提交完成");
});

test("createStatusReceivedEvent normalizes missing items to empty array", () => {
  const event = createStatusReceivedEvent({ cdkeys: ["A"], items: undefined });

  assert.equal(event.type, WORKFLOW_EVENTS.STATUS_RECEIVED);
  assert.deepEqual(event.cdkeys, ["A"]);
  assert.deepEqual(event.items, []);
});

test("createAccountCooldownEvent stores normalized email and reason", () => {
  const event = createAccountCooldownEvent({
    email: " User@Example.COM ",
    until: 1780000000000,
    reason: "今日提交次数已达上限"
  });

  assert.equal(event.type, WORKFLOW_EVENTS.ACCOUNT_COOLDOWN_STARTED);
  assert.equal(event.email, "user@example.com");
  assert.equal(event.until, 1780000000000);
  assert.equal(event.reason, "今日提交次数已达上限");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- test/workflowEvents.test.mjs
```

Expected: FAIL because `src/workflow/redeemEvents.js` does not exist.

- [ ] **Step 3: Add workflow event module**

```js
// src/workflow/redeemEvents.js
export const WORKFLOW_EVENTS = Object.freeze({
  SUBMIT_REQUESTED: "submit_requested",
  SUBMIT_ACCEPTED: "submit_accepted",
  SUBMIT_FAILED: "submit_failed",
  STATUS_RECEIVED: "status_received",
  RETRY_REQUESTED: "retry_requested",
  CANCEL_REQUESTED: "cancel_requested",
  ACCOUNT_ATTEMPT_RECORDED: "account_attempt_recorded",
  ACCOUNT_COOLDOWN_STARTED: "account_cooldown_started",
  AUTO_CYCLE_REQUESTED: "auto_cycle_requested",
  AUTO_CYCLE_SUBMITTED: "auto_cycle_submitted",
  PLUS_CHECK_STARTED: "plus_check_started",
  PLUS_CHECK_RESULT: "plus_check_result",
  ACTIVITY_LOGGED: "activity_logged",
  ROWS_CLEARED: "rows_cleared"
});

function nextEventId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function createWorkflowEvent(type, payload = {}) {
  if (!Object.values(WORKFLOW_EVENTS).includes(type)) {
    throw new Error(`未知 workflow event: ${type}`);
  }
  return {
    id: nextEventId(),
    type,
    createdAt: Date.now(),
    ...payload
  };
}

export function createSubmitAcceptedEvent({ rowIds = [], items = [], message = "" } = {}) {
  return createWorkflowEvent(WORKFLOW_EVENTS.SUBMIT_ACCEPTED, {
    rowIds: Array.isArray(rowIds) ? rowIds : [],
    items: Array.isArray(items) ? items : [],
    message: String(message || "")
  });
}

export function createStatusReceivedEvent({ cdkeys = [], items = [], raw = null } = {}) {
  return createWorkflowEvent(WORKFLOW_EVENTS.STATUS_RECEIVED, {
    cdkeys: Array.isArray(cdkeys) ? cdkeys : [],
    items: Array.isArray(items) ? items : [],
    raw
  });
}

export function createAccountCooldownEvent({ email, until, reason }) {
  return createWorkflowEvent(WORKFLOW_EVENTS.ACCOUNT_COOLDOWN_STARTED, {
    email: normalizeEmail(email),
    until: Number(until || 0),
    reason: String(reason || "")
  });
}
```

- [ ] **Step 4: Verify**

Run:

```powershell
npm test -- test/workflowEvents.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass.

---

## Task 2: Build the Single Account Lifecycle Ledger

**Files:**
- Create: `src/workflow/accountLedger.js`
- Test: `test/accountLedger.test.mjs`
- Later migrate callers from: `src/state/accountLifecycle.js`, `src/state/redeemWorkflow.js`, `src/App.jsx`

- [ ] **Step 1: Write failing tests**

```js
// test/accountLedger.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  normalizeAccountLedger,
  recordAccountSubmitAttempt,
  startAccountCooldown,
  getAccountLifecycle,
  getAccountAvailabilityFacts
} from "../src/workflow/accountLedger.js";

test("recordAccountSubmitAttempt allows third attempt and blocks fourth", () => {
  const now = 1780000000000;
  let ledger = normalizeAccountLedger({});

  ledger = recordAccountSubmitAttempt(ledger, "a@example.com", { now });
  ledger = recordAccountSubmitAttempt(ledger, "a@example.com", { now: now + 1000 });
  ledger = recordAccountSubmitAttempt(ledger, "a@example.com", { now: now + 2000 });

  const third = getAccountLifecycle(ledger, "a@example.com", { now: now + 3000 });
  assert.equal(third.attemptCount, ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(third.canSubmit, true);

  ledger = recordAccountSubmitAttempt(ledger, "a@example.com", { now: now + 3000 });
  const fourth = getAccountLifecycle(ledger, "a@example.com", { now: now + 4000 });
  assert.equal(fourth.attemptCount, ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(fourth.canSubmit, false);
  assert.equal(fourth.cooling, true);
});

test("backend daily limit immediately sets 3/3 and cooldown", () => {
  const now = 1780000000000;
  let ledger = normalizeAccountLedger({});
  ledger = startAccountCooldown(ledger, "a@example.com", {
    now,
    reason: "今日提交次数已达上限，请 24 小时后再试",
    forceAttemptLimit: true
  });

  const fact = getAccountLifecycle(ledger, "A@Example.COM", { now: now + 1000 });
  assert.equal(fact.attemptCount, ACCOUNT_ATTEMPT_LIMIT);
  assert.equal(fact.cooling, true);
  assert.equal(fact.canSubmit, false);
  assert.match(fact.reason, /今日提交次数已达上限/);
});

test("getAccountAvailabilityFacts separates pool, available, cooling, active, completed", () => {
  const now = 1780000000000;
  let ledger = normalizeAccountLedger({});
  ledger = startAccountCooldown(ledger, "cool@example.com", {
    now,
    reason: "冷却",
    forceAttemptLimit: true
  });

  const facts = getAccountAvailabilityFacts({
    accounts: [
      { email: "ok@example.com" },
      { email: "cool@example.com" },
      { email: "plus@example.com" }
    ],
    rows: [
      { email: "busy@example.com", status: "pending_dispatch" },
      { email: "plus@example.com", status: "success", subscriptionStatus: "plus" }
    ],
    ledger,
    now
  });

  assert.equal(facts.counts.pool, 3);
  assert.equal(facts.counts.available, 1);
  assert.equal(facts.counts.cooling, 1);
  assert.equal(facts.counts.activeTask, 1);
  assert.equal(facts.counts.completedPlus, 1);
});
```

- [ ] **Step 2: Run failing tests**

```powershell
npm test -- test/accountLedger.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement account ledger**

Implement a pure module with these exported functions:

```js
export const ACCOUNT_ATTEMPT_LIMIT = 3;
export const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function normalizeAccountLedger(value) { /* normalize by lower-case email */ }
export function recordAccountSubmitAttempt(ledger, email, options = {}) { /* third allowed, fourth cools */ }
export function startAccountCooldown(ledger, email, options = {}) { /* force 3/3 when backend says daily limit */ }
export function getAccountLifecycle(ledger, email, options = {}) { /* returns attemptCount, cooling, canSubmit */ }
export function getAccountAvailabilityFacts({ accounts, rows, ledger, now }) { /* one selector for UI and submit */ }
```

Implementation rule:

```js
// The fourth local submit request is the first blocked one.
const nextCount = Math.min(previous.count + 1, ACCOUNT_ATTEMPT_LIMIT);
const shouldCool = previous.count >= ACCOUNT_ATTEMPT_LIMIT;
```

- [ ] **Step 4: Replace scattered attempt/cooldown facts**

Modify:

- `src/state/redeemWorkflow.js`
  - `getSubmitAccountAvailability` should delegate to `getAccountAvailabilityFacts`.
- `src/App.jsx`
  - `accountAvailabilityCounts` should come from the same selector used by submit.
  - Remove separate ad hoc count logic once equivalent.

- [ ] **Step 5: Verify**

```powershell
npm test -- test/accountLedger.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass; UI count labels use one source.

---

## Task 3: Centralize Row Mutation in a Task Reducer

**Files:**
- Create: `src/workflow/redeemTaskModel.js`
- Test: `test/redeemTaskModel.test.mjs`
- Modify: `src/hooks/useRedeemSubmit.js`
- Modify: `src/hooks/useRedeemPolling.js`
- Modify: `src/hooks/useAutoCycle.js`

- [ ] **Step 1: Write reducer tests for CDK ownership**

```js
// test/redeemTaskModel.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWorkflowEvent,
  createInitialWorkflowState,
  getVisibleRows
} from "../src/workflow/redeemTaskModel.js";
import {
  WORKFLOW_EVENTS,
  createStatusReceivedEvent
} from "../src/workflow/redeemEvents.js";

test("status update applies only to current owner of reused CDK", () => {
  let state = createInitialWorkflowState({
    rows: [
      {
        id: "old",
        email: "old@example.com",
        cdkey: "AAAA-BBBB-CCCC-DDDD",
        status: "failed",
        statusOwner: false,
        statusLocked: true,
        autoCycleHandled: true
      },
      {
        id: "new",
        email: "new@example.com",
        cdkey: "AAAA-BBBB-CCCC-DDDD",
        status: "pending_dispatch",
        statusOwner: true
      }
    ]
  });

  state = applyWorkflowEvent(
    state,
    createStatusReceivedEvent({
      cdkeys: ["AAAA-BBBB-CCCC-DDDD"],
      items: [{ cdkey: "AAAA-BBBB-CCCC-DDDD", status: "success", plan_name: "Plus" }]
    })
  );

  const rows = getVisibleRows(state);
  assert.equal(rows.find((row) => row.id === "old").status, "failed");
  assert.equal(rows.find((row) => row.id === "new").status, "success");
});

test("explicit cancelled backend result bypasses retry hold", () => {
  const now = 1780000000000;
  let state = createInitialWorkflowState({
    rows: [
      {
        id: "row-1",
        email: "a@example.com",
        cdkey: "A",
        status: "pending_dispatch",
        statusOwner: true,
        retryHoldUntil: now + 60000
      }
    ],
    now
  });

  state = applyWorkflowEvent(state, {
    id: "event-1",
    type: WORKFLOW_EVENTS.STATUS_RECEIVED,
    createdAt: now + 1000,
    cdkeys: ["A"],
    items: [{ cdkey: "A", status: "failed", reason: "用户取消，CDK 可重新提交" }]
  });

  assert.equal(getVisibleRows(state)[0].status, "cancelled");
  assert.match(getVisibleRows(state)[0].reason, /用户取消/);
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- test/redeemTaskModel.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement reducer compatibility layer**

Create `src/workflow/redeemTaskModel.js` with these exports:

```js
export function createInitialWorkflowState({ rows = [], accountLedger = {}, activityLog = [], now = Date.now() } = {}) {
  return { rows, accountLedger, activityLog, now };
}

export function applyWorkflowEvent(state, event) {
  switch (event.type) {
    case WORKFLOW_EVENTS.STATUS_RECEIVED:
      return applyStatusReceived(state, event);
    case WORKFLOW_EVENTS.ACCOUNT_COOLDOWN_STARTED:
      return applyAccountCooldownStarted(state, event);
    case WORKFLOW_EVENTS.SUBMIT_ACCEPTED:
      return applySubmitAccepted(state, event);
    default:
      return state;
  }
}

export function getVisibleRows(state) {
  return state.rows;
}
```

Use existing helpers where possible:

- `mergeStatusRows`
- `markStatusOwners`
- `shouldAcceptRemoteStatusDuringHold`
- `isExplicitCancellationStatusItem`
- `normalizeAccountCooldowns`

Do not change UI row shape in this task.

- [ ] **Step 4: Route polling status through reducer**

Modify `src/hooks/useRedeemPolling.js`:

- Keep the request to `/api/redeem/status`.
- Replace direct `mergeStatusRows` row updates with:

```js
const nextState = applyWorkflowEvent(createInitialWorkflowState({ rows: workingRows }), createStatusReceivedEvent({
  cdkeys: cleanCdkeys,
  items: payload.items || [],
  raw: payload
}));
const updated = filterDeletedRows(registerCooldownsFromRows(nextState.rows));
```

- [ ] **Step 5: Route submit result through reducer**

Modify `src/hooks/useRedeemSubmit.js`:

- After submit returns, build `SUBMIT_ACCEPTED` then `STATUS_RECEIVED` if backend sent items.
- Keep existing status messages for now.
- Do not let the hook directly decide old owner/new owner after this task.

- [ ] **Step 6: Route auto-cycle result through reducer**

Modify `src/hooks/useAutoCycle.js`:

- Auto-cycle may still schedule and call API.
- It must dispatch/apply reducer events for row state changes.
- It must not directly make old rows owner false and new rows owner true outside reducer.

- [ ] **Step 7: Verify**

```powershell
npm test -- test/redeemTaskModel.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass; no visual behavior change yet.

---

## Task 4: Add Versioned Workflow Persistence and Sensitive Storage Policy

**Files:**
- Create: `src/storage/workflowPersistence.js`
- Test: `test/workflowPersistence.test.mjs`
- Modify: `src/config/redeemConstants.js`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write persistence tests**

```js
// test/workflowPersistence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  loadWorkflowSnapshot,
  saveWorkflowSnapshot,
  migrateLegacyWorkflowSnapshot
} from "../src/storage/workflowPersistence.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

test("saveWorkflowSnapshot can omit sensitive fields when policy disables them", () => {
  const storage = memoryStorage();
  saveWorkflowSnapshot(storage, {
    rows: [{ email: "a@example.com", accessToken: "secret-token", password: "pw" }],
    accountLedger: {},
    activityLog: []
  }, {
    persistSensitive: false
  });

  const snapshot = loadWorkflowSnapshot(storage);
  assert.equal(snapshot.rows[0].email, "a@example.com");
  assert.equal(snapshot.rows[0].accessToken, "");
  assert.equal(snapshot.rows[0].password, "");
});

test("migrateLegacyWorkflowSnapshot reads existing rows and ledger", () => {
  const snapshot = migrateLegacyWorkflowSnapshot({
    rows: JSON.stringify([{ id: "r1", email: "a@example.com" }]),
    accountAttemptLedger: JSON.stringify({ "a@example.com": { count: 1 } }),
    accountCooldowns: JSON.stringify({})
  });

  assert.equal(snapshot.rows[0].id, "r1");
  assert.equal(snapshot.accountLedger["a@example.com"].attemptCount, 1);
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- test/workflowPersistence.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Add versioned persistence module**

The saved document shape must be:

```js
{
  version: 1,
  savedAt: 1780000000000,
  rows: [],
  accountLedger: {},
  activityLog: [],
  ui: {
    activeWorkspaceTab: "prep",
    showApiKey: false
  }
}
```

Rules:

- `persistSensitive: false` blanks `password`, `twofa`, `accessToken`, `exportLine`, and `apiKey`.
- Legacy keys remain readable during migration.
- Do not delete legacy keys in this task.

- [ ] **Step 4: Wire App to load snapshot first**

Modify `src/App.jsx`:

- Read `loadWorkflowSnapshot(window.localStorage)` before old individual loaders.
- If snapshot exists, initialize rows and ledger from it.
- If snapshot does not exist, fall back to existing loaders.

- [ ] **Step 5: Save snapshot in parallel with old keys**

For one release cycle, keep old storage writes and additionally save the new snapshot.

This reduces migration risk and allows rollback.

- [ ] **Step 6: Verify**

```powershell
npm test -- test/workflowPersistence.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass.

---

## Task 5: Create a Single Redeem Workflow Hook

**Files:**
- Create: `src/hooks/useRedeemWorkflow.js`
- Test: `test/redeemWorkflowHookAdapter.test.mjs`
- Modify: `src/App.jsx`
- Modify: `src/hooks/useRedeemSubmit.js`
- Modify: `src/hooks/useRedeemPolling.js`
- Modify: `src/hooks/useAutoCycle.js`

- [ ] **Step 1: Write adapter tests for action surface**

```js
// test/redeemWorkflowHookAdapter.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  createRedeemWorkflowActions
} from "../src/hooks/useRedeemWorkflow.js";

test("createRedeemWorkflowActions exposes stable UI action names", () => {
  const actions = createRedeemWorkflowActions({
    getState: () => ({ rows: [] }),
    dispatch: () => {},
    api: {},
    clock: () => 1780000000000
  });

  assert.equal(typeof actions.submitRedeems, "function");
  assert.equal(typeof actions.queryStatuses, "function");
  assert.equal(typeof actions.startPolling, "function");
  assert.equal(typeof actions.stopPolling, "function");
  assert.equal(typeof actions.retryRows, "function");
  assert.equal(typeof actions.cancelRows, "function");
  assert.equal(typeof actions.checkPlus, "function");
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- test/redeemWorkflowHookAdapter.test.mjs
```

Expected: FAIL because `useRedeemWorkflow.js` does not exist.

- [ ] **Step 3: Implement hook action adapter**

Create `src/hooks/useRedeemWorkflow.js`:

```js
import { useMemo, useReducer, useRef } from "react";
import { applyWorkflowEvent, createInitialWorkflowState } from "../workflow/redeemTaskModel.js";

export function createRedeemWorkflowActions({ getState, dispatch, api, clock }) {
  return {
    async submitRedeems(input) {
      dispatch({ type: "ui_submit_requested", input, createdAt: clock() });
    },
    async queryStatuses(cdkeys, options = {}) {
      dispatch({ type: "ui_status_query_requested", cdkeys, options, createdAt: clock() });
    },
    startPolling(cdkeys, options = {}) {
      dispatch({ type: "ui_polling_started", cdkeys, options, createdAt: clock() });
    },
    stopPolling(options = {}) {
      dispatch({ type: "ui_polling_stopped", options, createdAt: clock() });
    },
    async retryRows(rows, options = {}) {
      dispatch({ type: "ui_retry_requested", rows, options, createdAt: clock() });
    },
    async cancelRows(rows, options = {}) {
      dispatch({ type: "ui_cancel_requested", rows, options, createdAt: clock() });
    },
    async checkPlus(rows, options = {}) {
      dispatch({ type: "ui_plus_check_requested", rows, options, createdAt: clock() });
    }
  };
}

export function useRedeemWorkflow(initialState, dependencies) {
  const [state, dispatchBase] = useReducer(
    (current, event) => applyWorkflowEvent(current, event),
    createInitialWorkflowState(initialState)
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const actions = useMemo(
    () =>
      createRedeemWorkflowActions({
        getState: () => stateRef.current,
        dispatch: dispatchBase,
        api: dependencies.api,
        clock: dependencies.clock || Date.now
      }),
    [dependencies.api, dependencies.clock]
  );

  return { state, dispatch: dispatchBase, actions };
}
```

This task creates the action surface only. The existing hooks can still execute side effects until Task 6.

- [ ] **Step 4: Verify**

```powershell
npm test -- test/redeemWorkflowHookAdapter.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass.

---

## Task 6: Move Submit, Polling, and Auto-Cycle to Workflow Commands

**Files:**
- Create: `src/workflow/workflowCommands.js`
- Test: `test/workflowCommands.test.mjs`
- Modify: `src/hooks/useRedeemSubmit.js`
- Modify: `src/hooks/useRedeemPolling.js`
- Modify: `src/hooks/useAutoCycle.js`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write command tests**

```js
// test/workflowCommands.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSubmitCommand,
  buildAutoCycleCommand,
  buildStatusQueryCommand
} from "../src/workflow/workflowCommands.js";

test("buildSubmitCommand keeps current backend request body", () => {
  const command = buildSubmitCommand([
    { cdkey: "A", accessToken: "token-a", channel: "upi" }
  ]);

  assert.equal(command.path, "/api/redeem/submit");
  assert.deepEqual(command.body, {
    items: [{ cdkey: "A", access_token: "token-a", channel: "upi" }]
  });
});

test("buildStatusQueryCommand keeps CDK-only query body", () => {
  const command = buildStatusQueryCommand(["A", "B"]);

  assert.equal(command.path, "/api/redeem/status");
  assert.deepEqual(command.body, { cdkeys: ["A", "B"] });
});

test("buildAutoCycleCommand uses same CDK and next account token", () => {
  const command = buildAutoCycleCommand({
    cdkey: "A",
    channel: "ideal",
    account: { accessToken: "next-token" }
  });

  assert.deepEqual(command.body.items[0], {
    cdkey: "A",
    access_token: "next-token",
    channel: "ideal"
  });
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- test/workflowCommands.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement command builders**

Create `src/workflow/workflowCommands.js` with pure builders:

```js
export function buildSubmitCommand(rows) {
  return {
    path: "/api/redeem/submit",
    body: {
      items: rows.map((row) => ({
        cdkey: row.cdkey,
        access_token: row.accessToken,
        channel: row.channel
      }))
    }
  };
}

export function buildStatusQueryCommand(cdkeys) {
  return {
    path: "/api/redeem/status",
    body: { cdkeys }
  };
}

export function buildAutoCycleCommand({ cdkey, channel, account }) {
  return buildSubmitCommand([
    {
      cdkey,
      channel,
      accessToken: account.accessToken
    }
  ]);
}
```

- [ ] **Step 4: Replace duplicated backend body construction**

Modify:

- `src/hooks/useRedeemSubmit.js`
  - Replace inline `/api/redeem/submit` body creation with `buildSubmitCommand`.
- `src/hooks/useAutoCycle.js`
  - Replace inline auto-cycle submit body with `buildAutoCycleCommand`.
- `src/hooks/useRedeemPolling.js`
  - Replace inline status body with `buildStatusQueryCommand`.

- [ ] **Step 5: Verify**

```powershell
npm test -- test/workflowCommands.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass and backend payloads unchanged.

---

## Task 7: Replace Status Message with Real Activity Log

**Files:**
- Create: `src/workflow/activityLog.js`
- Test: `test/activityLog.test.mjs`
- Modify: `src/components/common/ActivityLog.jsx`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write activity log tests**

```js
// test/activityLog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendActivityLog,
  compactActivityLog,
  formatActivityLogMessage
} from "../src/workflow/activityLog.js";

test("appendActivityLog keeps newest entries first and caps length", () => {
  let log = [];
  for (let index = 0; index < 105; index += 1) {
    log = appendActivityLog(log, {
      level: "info",
      action: "query",
      message: `第 ${index} 条`
    }, { max: 100, now: 1780000000000 + index });
  }

  assert.equal(log.length, 100);
  assert.equal(log[0].message, "第 104 条");
  assert.equal(log[99].message, "第 5 条");
});

test("formatActivityLogMessage includes email and masked CDK", () => {
  const text = formatActivityLogMessage({
    action: "auto_cycle",
    email: "a@example.com",
    cdkey: "XSKX-GTQT-PX62-BLRN",
    message: "自动换号"
  });

  assert.match(text, /a@example.com/);
  assert.match(text, /XSKX/);
  assert.match(text, /BLRN/);
  assert.match(text, /自动换号/);
});

test("compactActivityLog removes invalid rows", () => {
  const compacted = compactActivityLog([
    null,
    { message: "" },
    { message: "提交完成", createdAt: 1780000000000 }
  ]);

  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].message, "提交完成");
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- test/activityLog.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement append-only activity log**

Create `src/workflow/activityLog.js` with:

```js
export function appendActivityLog(log, entry, options = {}) { /* newest first, cap 100 */ }
export function compactActivityLog(log) { /* remove invalid entries */ }
export function formatActivityLogMessage(entry) { /* mask CDK, include email/action */ }
```

Log entry shape:

```js
{
  id: "log-...",
  createdAt: 1780000000000,
  level: "info" | "success" | "warning" | "error",
  action: "submit" | "query" | "cancel" | "cooldown" | "auto_cycle" | "plus_check",
  email: "a@example.com",
  cdkey: "XSKX-GTQT-PX62-BLRN",
  message: "自动换号提交 1 条"
}
```

- [ ] **Step 4: Update `ActivityLog` component**

Modify `src/components/common/ActivityLog.jsx`:

- Accept `entries`.
- Render latest 20 entries.
- Keep current `statusMessage` as the first synthetic entry only until all callers are migrated.

- [ ] **Step 5: Add log entries in workflow actions**

At minimum log:

- submit started
- submit accepted
- CDK status query started
- backend explicit cancel
- backend daily limit cooldown
- auto-cycle scheduled
- auto-cycle submitted
- Plus check result

- [ ] **Step 6: Verify**

```powershell
npm test -- test/activityLog.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass; every workspace bottom shows real chronological logs.

---

## Task 8: Split and Sanitize the Express Proxy

**Files:**
- Create: `server/app.js`
- Create: `server/proxy.js`
- Create: `server/subscription.js`
- Test: `test/serverProxy.test.mjs`
- Modify: `server/index.js`

- [ ] **Step 1: Write proxy tests with fake fetch**

```js
// test/serverProxy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";

test("redeem submit forwards without exposing raw response by default", async () => {
  const app = createApp({
    fetchImpl: async () =>
      new Response(JSON.stringify({ items: [{ cdkey: "A", status: "pending_dispatch" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
    config: {
      externalApiBaseUrl: "https://example.test",
      subscriptionApiBaseUrl: "https://subscription.test",
      debugRawResponses: false
    }
  });

  const server = app.listen(0);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/redeem/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "key",
        items: [{ cdkey: "A", access_token: "token", channel: "upi" }]
      })
    });
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.items[0].cdkey, "A");
    assert.equal(Object.hasOwn(payload, "raw"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- test/serverProxy.test.mjs
```

Expected: FAIL because `server/app.js` does not exist.

- [ ] **Step 3: Move Express app creation**

Create `server/app.js`:

```js
import express from "express";
import { createRedeemRouter } from "./proxy.js";
import { createSubscriptionRouter } from "./subscription.js";

export function createApp({ fetchImpl = fetch, config = {} } = {}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(createRedeemRouter({ fetchImpl, config }));
  app.use(createSubscriptionRouter({ fetchImpl, config }));
  return app;
}
```

- [ ] **Step 4: Move proxy logic**

Move from `server/index.js` into `server/proxy.js`:

- `requireApiKey`
- `forwardJson`
- `chunk`
- `pickItems`
- `summarizeBatchResponse`
- `proxyBatches`
- `/api/redeem/*` routes

Sanitization rule:

```js
if (config.debugRawResponses === true) {
  responsePayload.raw = results;
}
```

Default must not include `raw`.

- [ ] **Step 5: Keep index small**

Modify `server/index.js` to:

```js
import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT || 5174);
app.listen(port, () => {
  console.log(`[server] listening on ${port}`);
});
```

Keep static `dist` serving either in `createApp` or a small `server/static.js`; do not remove production serving.

- [ ] **Step 6: Verify**

```powershell
npm test -- test/serverProxy.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass; proxy still runs with `npm run dev`.

---

## Task 9: Shrink `App.jsx` into Layout and View Model Wiring

**Files:**
- Create: `src/hooks/useRedeemViewModel.js`
- Create: `src/hooks/useRedeemUiSettings.js`
- Modify: `src/App.jsx`
- Test: `test/redeemViewModel.test.mjs`

- [ ] **Step 1: Write view model selector test**

```js
// test/redeemViewModel.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildRedeemViewModel } from "../src/hooks/useRedeemViewModel.js";

test("buildRedeemViewModel exposes consistent account and task counts", () => {
  const model = buildRedeemViewModel({
    rows: [
      { status: "pending_dispatch", email: "a@example.com", cdkey: "A" },
      { status: "running", email: "b@example.com", cdkey: "B" }
    ],
    accountFacts: {
      counts: {
        pool: 10,
        available: 8,
        cooling: 1,
        attemptLimited: 1,
        activeTask: 2,
        completedPlus: 0
      }
    },
    cdkeyFacts: {
      used: 0,
      unused: 5
    }
  });

  assert.equal(model.account.pool, 10);
  assert.equal(model.account.available, 8);
  assert.equal(model.tasks.waiting, 1);
  assert.equal(model.tasks.running, 1);
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- test/redeemViewModel.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Move derived UI counts out of App**

Create `src/hooks/useRedeemViewModel.js`:

```js
export function buildRedeemViewModel({ rows, accountFacts, cdkeyFacts }) {
  const waiting = rows.filter((row) => row.status === "pending_dispatch").length;
  const running = rows.filter((row) => ["running", "processing"].includes(row.status)).length;
  return {
    account: accountFacts.counts,
    cdkey: cdkeyFacts,
    tasks: {
      waiting,
      running,
      total: rows.length
    }
  };
}
```

Then expand it with current selectors until App no longer calculates counts inline.

- [ ] **Step 4: Move UI settings**

Create `src/hooks/useRedeemUiSettings.js`:

- `activeWorkspaceTab`
- `activeDetailRowId`
- `showApiKey`
- dialog open/close state

App should call one hook instead of owning many independent UI state atoms.

- [ ] **Step 5: Reduce App**

Target:

- `App.jsx` below 1200 lines after this task.
- App renders:
  - brand bar
  - workspace tabs
  - selected workspace
  - activity log
  - dialogs

- [ ] **Step 6: Verify**

```powershell
npm test -- test/redeemViewModel.test.mjs
npm test
npm run build
git diff --check
```

Expected: all pass.

---

## Task 10: Split `redeemLogic.js` by Domain

**Files:**
- Create: `src/domain/accountParsing.js`
- Create: `src/domain/statusMeta.js`
- Create: `src/domain/statusMergeCompat.js`
- Create: `src/domain/subscriptionDiagnostics.js`
- Create: `src/domain/exportFormatting.js`
- Modify: `src/redeemLogic.js`
- Modify tests importing from `src/redeemLogic.js` only if direct imports are now better from domain files.

- [ ] **Step 1: Move account parsing**

Move:

- `normalizeAccountText`
- account line parsing helpers
- account duplicate detection

From:

- `src/redeemLogic.js`

To:

- `src/domain/accountParsing.js`

Keep re-export in `src/redeemLogic.js`:

```js
export {
  normalizeAccountText
} from "./domain/accountParsing.js";
```

- [ ] **Step 2: Move status metadata**

Move:

- `STATUS_META`
- status grouping helpers
- terminal status helpers

To:

- `src/domain/statusMeta.js`

- [ ] **Step 3: Move subscription diagnostics**

Move:

- Plus diagnostic formatting
- subscription tone/status helpers

To:

- `src/domain/subscriptionDiagnostics.js`

- [ ] **Step 4: Move export formatting**

Move:

- backend redeem line formatting
- account status line formatting
- UPI/IDEAL export grouping

To:

- `src/domain/exportFormatting.js`

- [ ] **Step 5: Verify after each move**

After every move:

```powershell
npm test
npm run build
git diff --check
```

Expected: all pass.

Completion target:

- `src/redeemLogic.js` becomes a compatibility facade below 200 lines.

---

## Task 11: Split CSS by Surface

**Files:**
- Create: `src/styles/base.css`
- Create: `src/styles/layout.css`
- Create: `src/styles/prep.css`
- Create: `src/styles/execution.css`
- Create: `src/styles/results.css`
- Create: `src/styles/activity-log.css`
- Modify: `src/styles.css`
- Modify: `src/main.jsx` if direct imports are cleaner.

- [ ] **Step 1: Split without changing class names**

Move CSS blocks from `src/styles.css` into focused files while preserving selectors.

Keep `src/styles.css` as import aggregator:

```css
@import "./styles/base.css";
@import "./styles/layout.css";
@import "./styles/prep.css";
@import "./styles/execution.css";
@import "./styles/results.css";
@import "./styles/activity-log.css";
```

- [ ] **Step 2: Verify visual build**

```powershell
npm run build
git diff --check
```

Expected: build passes; no selector changes yet.

- [ ] **Step 3: Manual browser check**

Run:

```powershell
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

Check:

- three tabs still switch
- request table horizontal scroll still works
- row progress still appears after email
- activity log appears under every workspace
- no overlapping text on narrow viewport

---

## Task 12: Final Integration Review

**Files:**
- No planned code changes unless review finds issues.

- [ ] **Step 1: Run full verification**

```powershell
npm test
npm run build
git diff --check
```

Expected:

- `npm test`: all tests pass
- `npm run build`: Vite build succeeds
- `git diff --check`: no whitespace errors

- [ ] **Step 2: Run key manual scenarios locally**

Use local browser only:

```text
http://127.0.0.1:5173/
```

Manual checklist:

- Import 25 accounts and 10 CDKs.
- Start redeem.
- Confirm only 10 accounts submit.
- Cancel one backend task.
- Query status.
- Confirm explicit cancel shows `已取消` and can resubmit.
- Force a daily-limit response.
- Confirm account shows `3/3 次 + 冷却`.
- Confirm released CDK moves to next available account.
- Confirm `账号池 / 可兑换 / 冷却账号 / 已达 3/3 / 待兑换 / 已派发 / 兑换中` all add up clearly.
- Refresh browser.
- Confirm rows, cooldowns, attempts, and activity log restore correctly.

- [ ] **Step 3: Request code review**

Use Superpowers code review after implementation:

```text
Review scope:
- workflow event core
- account ledger
- row reducer
- submit/poll/auto-cycle migration
- persistence and sensitive storage policy
- Express proxy split
```

- [ ] **Step 4: Fix review findings**

Fix Critical and Important issues before considering upload/deploy.

- [ ] **Step 5: Stop for user instruction**

Do not upload GitHub.
Do not deploy to Hong Kong server.
Report local verification results and wait for explicit instruction.

---

## Execution Order Summary

1. Workflow event contract.
2. Account lifecycle ledger.
3. Row/task reducer.
4. Versioned persistence and sensitive storage policy.
5. Workflow hook action surface.
6. Command builders and hook migration.
7. Real activity log.
8. Express proxy split and sanitization.
9. App view model extraction.
10. `redeemLogic.js` domain split.
11. CSS split.
12. Final local review.

This order intentionally fixes correctness before cosmetic cleanup.

---

## Self-Review

### Spec Coverage

- Sensitive localStorage risk: covered by Task 4.
- App God Component: covered by Task 9.
- Multiple row writers: covered by Tasks 3, 5, and 6.
- CDK ownership ambiguity: covered by Task 3.
- Account cooldown/count inconsistency: covered by Task 2.
- Hook dependency bloat: covered by Tasks 5 and 6.
- Thin Express proxy: covered by Task 8.
- Weak integration coverage: covered by Tasks 3, 6, 8, and 12.
- Real page logs: covered by Task 7.

### Placeholder Scan

No `TBD`, `TODO`, or empty "write tests later" steps are intentionally left in this plan. Large implementation tasks define exact module interfaces and exact verification commands.

### Type Consistency

The plan uses one event naming source, `WORKFLOW_EVENTS`, one account count source, `getAccountAvailabilityFacts`, and one reducer entry point, `applyWorkflowEvent`.

