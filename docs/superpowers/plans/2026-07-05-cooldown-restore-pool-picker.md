# Cooldown Restore And CDK Pool Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click local cooldown restore button and a CDK pool picker that appears only when more than one CDK pool has CDKs available for the next redemption batch.

**Architecture:** Keep backend submit/status APIs unchanged. Add pure state helpers for cooldown restoration and CDK pool selection, then wire them into `App.jsx`, `useRedeemSubmit`, and execution UI. Submission remains account/CDK queue based; the selected pool simply narrows the CDK list used for this submit attempt.

**Tech Stack:** Vite, React 18, Node test runner, current local state modules in `src/workflow`, `src/state`, and `src/hooks`.

---

## File Structure

- Create `src/state/cdkPoolSelection.js`
  - Computes non-empty CDK pool choices.
  - Restricts `cdkeyPools` to a selected pool for one submit run.
  - Decides whether the UI should prompt, auto-start one pool, or report no pool.
- Create `test/cdkPoolSelection.test.mjs`
  - Covers multi-pool prompt, single-pool direct start, empty pools, and pool restriction.
- Modify `src/workflow/accountLedger.js`
  - Add a pure helper that clears local cooldown and attempt-limit records for selected emails.
- Modify `test/accountLedger.test.mjs`
  - Covers one-click restore of active cooldowns and 3/3 attempt-limit records.
- Modify `src/hooks/useRedeemSubmit.js`
  - Allow `submitRedeems({ poolId })`.
  - Use selected pool's CDKs for preflight and submit.
  - Report `waitingAccounts` and selected pool metadata back to App for follow-up pool selection.
- Modify `src/components/execute/ExecutionControlPanel.jsx`
  - Add `一键恢复冷却` button.
- Create `src/components/execute/CdkPoolPickerDialog.jsx`
  - Modal for selecting the next CDK pool.
- Modify `src/App.jsx`
  - Add cooldown restore handler.
  - Add pool picker state and submit orchestration.
  - Auto-open the pool picker when the previous selected pool finishes and accounts remain.
- Modify `src/styles/execution.css`
  - Add compact modal styles for the pool picker.

## Behavior Rules

- `一键恢复冷却` clears local cooldown state only:
  - Remove active entries from `accountCooldowns`.
  - Remove corresponding entries from `accountAttemptLedger` so accounts no longer show `3/3`.
  - Clear row-level `accountCooldownUntil/accountCooldownReason` markers.
  - Do not change `pm_unavailable`, Plus success rows, or backend task status.
- Start redemption pool choice:
  - If 0 pools have CDKs: no dialog; keep existing “没有 CDK” style message.
  - If 1 pool has CDKs: no dialog; submit directly with that pool.
  - If 2 or more pools have CDKs: show picker before submit.
- Account count greater than selected pool CDK count:
  - Submit only `min(可用账号, 选中池可用 CDK)` for that pool.
  - After that selected pool's active rows become terminal and accounts remain, run the same decision:
    - Multiple remaining pools: open picker.
    - One remaining pool: submit directly.
    - No remaining pool: show “账号等待补充卡密”.
- Existing selected-row resubmit behavior is unchanged; the pool picker only applies to normal “开始兑换” from account/CDK input.
- No GitHub push or Hong Kong deployment in this plan.

## Task 1: CDK Pool Selection Helper

**Files:**
- Create: `src/state/cdkPoolSelection.js`
- Create: `test/cdkPoolSelection.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `test/cdkPoolSelection.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCdkPoolChoices,
  chooseSubmitPoolDecision,
  restrictCdkeyPoolsToPool
} from "../src/state/cdkPoolSelection.js";

test("buildCdkPoolChoices returns only pools with valid CDKs", () => {
  const choices = buildCdkPoolChoices({
    vip: "VIP-1\nVIP-2",
    ideal: "",
    upi: "UPI-1"
  });

  assert.deepEqual(
    choices.map((choice) => ({
      id: choice.id,
      count: choice.count
    })),
    [
      { id: "vip", count: 2 },
      { id: "upi", count: 1 }
    ]
  );
});

test("chooseSubmitPoolDecision prompts only when multiple pools have CDKs", () => {
  assert.equal(
    chooseSubmitPoolDecision({ vip: "VIP-1", ideal: "", upi: "" }).kind,
    "direct"
  );
  assert.equal(
    chooseSubmitPoolDecision({ vip: "VIP-1", ideal: "IDEAL-1", upi: "" }).kind,
    "prompt"
  );
  assert.equal(
    chooseSubmitPoolDecision({ vip: "", ideal: "", upi: "" }).kind,
    "empty"
  );
});

test("restrictCdkeyPoolsToPool keeps only the selected pool text", () => {
  assert.deepEqual(
    restrictCdkeyPoolsToPool(
      {
        vip: "VIP-1",
        ideal: "IDEAL-1",
        upi: "UPI-1"
      },
      "ideal"
    ),
    {
      vip: "",
      ideal: "IDEAL-1",
      upi: ""
    }
  );
});

test("chooseSubmitPoolDecision can exclude the pool that just finished", () => {
  const decision = chooseSubmitPoolDecision(
    {
      vip: "VIP-1",
      ideal: "IDEAL-1",
      upi: "UPI-1"
    },
    { excludePoolIds: ["vip"] }
  );

  assert.equal(decision.kind, "prompt");
  assert.deepEqual(
    decision.choices.map((choice) => choice.id),
    ["ideal", "upi"]
  );
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- test/cdkPoolSelection.test.mjs
```

Expected: FAIL because `src/state/cdkPoolSelection.js` does not exist.

- [ ] **Step 3: Implement helper**

Create `src/state/cdkPoolSelection.js`:

```javascript
import { CDK_POOLS, parseCdkeyPools } from "../domain/accountParsing.js";

function normalizePoolId(value) {
  return String(value || "").trim();
}

function normalizeExcludedPoolIds(values = []) {
  return new Set((Array.isArray(values) ? values : []).map(normalizePoolId).filter(Boolean));
}

function emptyCdkPools() {
  return Object.fromEntries(CDK_POOLS.map((pool) => [pool.id, ""]));
}

export function buildCdkPoolChoices(cdkeyPools, options = {}) {
  const excluded = normalizeExcludedPoolIds(options.excludePoolIds);
  const parsed = parseCdkeyPools(cdkeyPools);
  const counts = new Map();

  parsed.cdkeys.forEach((cdkey) => {
    const poolId = normalizePoolId(cdkey.poolId || cdkey.channel);
    if (!poolId || excluded.has(poolId)) return;
    counts.set(poolId, (counts.get(poolId) || 0) + 1);
  });

  return CDK_POOLS
    .map((pool) => ({
      id: pool.id,
      label: pool.label,
      shortLabel: pool.shortLabel || pool.label,
      count: counts.get(pool.id) || 0
    }))
    .filter((choice) => choice.count > 0);
}

export function chooseSubmitPoolDecision(cdkeyPools, options = {}) {
  const choices = buildCdkPoolChoices(cdkeyPools, options);
  if (!choices.length) {
    return {
      kind: "empty",
      poolId: "",
      choices
    };
  }
  if (choices.length === 1) {
    return {
      kind: "direct",
      poolId: choices[0].id,
      choices
    };
  }
  return {
    kind: "prompt",
    poolId: "",
    choices
  };
}

export function restrictCdkeyPoolsToPool(cdkeyPools, poolId) {
  const selectedPoolId = normalizePoolId(poolId);
  const source = cdkeyPools && typeof cdkeyPools === "object" ? cdkeyPools : {};
  return {
    ...emptyCdkPools(),
    ...Object.fromEntries(
      CDK_POOLS.map((pool) => [pool.id, pool.id === selectedPoolId ? source[pool.id] || "" : ""])
    )
  };
}
```

- [ ] **Step 4: Verify helper tests pass**

Run:

```powershell
npm test -- test/cdkPoolSelection.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Do not commit during local feature development unless the user explicitly asks for a checkpoint. Keep this step unchecked until release.

## Task 2: One-Click Cooldown Restore State Helper

**Files:**
- Modify: `src/workflow/accountLedger.js`
- Modify: `test/accountLedger.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to `test/accountLedger.test.mjs`:

```javascript
import { clearAccountLifecycleBlocks } from "../src/workflow/accountLedger.js";

test("clearAccountLifecycleBlocks removes cooldown and attempt limit records", () => {
  const now = 1783260000000;
  const email = "cool@example.com";
  const result = clearAccountLifecycleBlocks({
    emails: [email],
    ledger: {
      [email]: {
        email,
        attempts: [now - 1000, now - 900, now - 800],
        attemptCount: 3,
        cooldownUntil: now + 86400000,
        cooldownReason: "该账号今日提交次数已达上限"
      }
    },
    cooldowns: {
      [email]: {
        email,
        until: now + 86400000,
        reason: "该账号今日提交次数已达上限"
      }
    },
    rows: [
      {
        id: "row-1",
        email,
        status: "failed",
        accountCooldownUntil: now + 86400000,
        accountCooldownReason: "该账号今日提交次数已达上限"
      }
    ]
  });

  assert.deepEqual(result.ledger, {});
  assert.deepEqual(result.cooldowns, {});
  assert.deepEqual(result.restoredEmails, [email]);
  assert.equal(result.rows[0].accountCooldownUntil, 0);
  assert.equal(result.rows[0].accountCooldownReason, "");
});

test("clearAccountLifecycleBlocks leaves unrelated accounts untouched", () => {
  const now = 1783260000000;
  const result = clearAccountLifecycleBlocks({
    emails: ["one@example.com"],
    ledger: {
      "one@example.com": { email: "one@example.com", attempts: [now], attemptCount: 1 },
      "two@example.com": { email: "two@example.com", attempts: [now], attemptCount: 1 }
    },
    cooldowns: {
      "two@example.com": { email: "two@example.com", until: now + 1000, reason: "keep" }
    },
    rows: [
      { id: "row-1", email: "one@example.com", accountCooldownUntil: now + 1000 },
      { id: "row-2", email: "two@example.com", accountCooldownUntil: now + 1000 }
    ]
  });

  assert.equal(result.ledger["one@example.com"], undefined);
  assert.ok(result.ledger["two@example.com"]);
  assert.ok(result.cooldowns["two@example.com"]);
  assert.equal(result.rows[0].accountCooldownUntil, 0);
  assert.equal(result.rows[1].accountCooldownUntil, now + 1000);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- test/accountLedger.test.mjs
```

Expected: FAIL because `clearAccountLifecycleBlocks` is not exported.

- [ ] **Step 3: Implement helper**

Add to `src/workflow/accountLedger.js` after `startAccountCooldown`:

```javascript
export function clearAccountLifecycleBlocks({
  emails = [],
  ledger = {},
  cooldowns = {},
  rows = []
} = {}) {
  const emailSet = new Set(
    (Array.isArray(emails) ? emails : [])
      .map(normalizeEmail)
      .filter(Boolean)
  );

  if (!emailSet.size) {
    return {
      ledger: normalizeAccountLedger(ledger),
      cooldowns: normalizeCooldowns(cooldowns, Date.now()),
      rows: Array.isArray(rows) ? rows : [],
      restoredEmails: []
    };
  }

  const nextLedger = { ...normalizeAccountLedger(ledger) };
  const nextCooldowns = { ...normalizeCooldowns(cooldowns, Date.now()) };

  emailSet.forEach((email) => {
    delete nextLedger[email];
    delete nextCooldowns[email];
  });

  const nextRows = (Array.isArray(rows) ? rows : []).map((row) => {
    const email = normalizeEmail(row?.email);
    if (!emailSet.has(email)) return row;
    return {
      ...row,
      accountCooldownUntil: 0,
      accountCooldownReason: ""
    };
  });

  return {
    ledger: nextLedger,
    cooldowns: nextCooldowns,
    rows: nextRows,
    restoredEmails: [...emailSet]
  };
}
```

- [ ] **Step 4: Verify account ledger tests pass**

Run:

```powershell
npm test -- test/accountLedger.test.mjs
```

Expected: PASS.

## Task 3: Add One-Click Restore Cooldown Button

**Files:**
- Modify: `src/components/execute/ExecutionControlPanel.jsx`
- Modify: `src/App.jsx`

- [ ] **Step 1: Update execution panel props and button**

Modify the import in `src/components/execute/ExecutionControlPanel.jsx`:

```javascript
import { FileSearch, Loader2, Play, RotateCcw, Square, Trash2, Unlock, XCircle } from "lucide-react";
```

Add props:

```javascript
  cooldownAccountCount,
  onRestoreCooldowns,
```

Insert this button after `一键重试失败`:

```jsx
<button
  className="secondary-button cooldown-restore-action"
  onClick={onRestoreCooldowns}
  disabled={isBusy || !cooldownAccountCount}
  title={
    cooldownAccountCount
      ? `恢复 ${cooldownAccountCount} 个本地冷却账号，清除 3/3 尝试限制`
      : "没有冷却账号需要恢复"
  }
>
  <Unlock size={16} />
  一键恢复冷却
</button>
```

- [ ] **Step 2: Wire App handler**

In `src/App.jsx`, import `clearAccountLifecycleBlocks` from `src/workflow/accountLedger.js` if it is not already imported.

Add this function near other action handlers:

```javascript
function restoreCooldownAccounts() {
  const activeEmails = new Set(accountValidation.accounts.map((account) => account.email.toLowerCase()));
  const coolingEmails = new Set();

  Object.keys(activeAccountCooldowns).forEach((email) => {
    if (activeEmails.has(email)) coolingEmails.add(email);
  });

  Object.entries(accountAttemptLedgerRef.current || {}).forEach(([email, entry]) => {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!activeEmails.has(normalizedEmail)) return;
    if (Number(entry?.attemptCount || entry?.attempts?.length || 0) >= ACCOUNT_ATTEMPT_LIMIT) {
      coolingEmails.add(normalizedEmail);
    }
  });

  rowsRef.current.forEach((row) => {
    const email = String(row?.email || "").trim().toLowerCase();
    if (email && activeEmails.has(email) && Number(row?.accountCooldownUntil || 0) > Date.now()) {
      coolingEmails.add(email);
    }
  });

  if (!coolingEmails.size) {
    const message = "没有可恢复的冷却账号";
    setStatusMessage(message);
    showToast(message, "error");
    return;
  }

  const restored = clearAccountLifecycleBlocks({
    emails: [...coolingEmails],
    ledger: accountAttemptLedgerRef.current,
    cooldowns: accountCooldownsRef.current,
    rows: rowsRef.current
  });

  accountAttemptLedgerRef.current = restored.ledger;
  accountCooldownsRef.current = restored.cooldowns;
  rowsRef.current = restored.rows;
  setAccountAttemptLedger(restored.ledger);
  setAccountCooldowns(restored.cooldowns);
  setRows(restored.rows);

  const message = `已恢复 ${restored.restoredEmails.length} 个本地冷却账号，可重新进入兑换队列`;
  setStatusMessage(message);
  showToast(message);
}
```

Pass the props into `ExecutionControlPanel`:

```jsx
cooldownAccountCount={cooldownAccountCount + attemptLimitedAccountCount}
onRestoreCooldowns={restoreCooldownAccounts}
```

- [ ] **Step 3: Run UI build**

Run:

```powershell
npm run build
```

Expected: build succeeds and the execution panel includes `一键恢复冷却`.

## Task 4: Add CDK Pool Picker Dialog UI

**Files:**
- Create: `src/components/execute/CdkPoolPickerDialog.jsx`
- Modify: `src/styles/execution.css`

- [ ] **Step 1: Create dialog component**

Create `src/components/execute/CdkPoolPickerDialog.jsx`:

```jsx
import { Layers, X } from "lucide-react";

export function CdkPoolPickerDialog({
  open,
  title = "选择卡密池",
  message = "多个卡密池都有卡密，请选择本次从哪个池开始兑换。",
  choices = [],
  onSelect,
  onClose
}) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="pool-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="pool-picker-title">
        <div className="pool-picker-head">
          <div>
            <h2 id="pool-picker-title">{title}</h2>
            <p>{message}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭卡密池选择">
            <X size={18} />
          </button>
        </div>
        <div className="pool-choice-grid">
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="pool-choice-button"
              onClick={() => onSelect(choice.id)}
            >
              <span className="pool-choice-icon">
                <Layers size={18} />
              </span>
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.count} 张卡密</small>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Add styles**

Append to `src/styles/execution.css`:

```css
.pool-picker-dialog {
  width: min(520px, calc(100vw - 28px));
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.42);
}

.pool-picker-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.pool-picker-head h2 {
  margin: 0;
  color: var(--text);
  font-size: 16px;
}

.pool-picker-head p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.pool-choice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.pool-choice-button {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 68px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(12, 19, 24, 0.74);
  color: var(--text);
  text-align: left;
}

.pool-choice-button:hover {
  border-color: var(--accent);
}

.pool-choice-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(67, 183, 255, 0.12);
  color: var(--info);
}

.pool-choice-button strong,
.pool-choice-button small {
  display: block;
}

.pool-choice-button small {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
```

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: build succeeds.

## Task 5: Submit Flow Uses Selected Pool

**Files:**
- Modify: `src/hooks/useRedeemSubmit.js`
- Modify: `src/App.jsx`
- Modify: `test/redeemWorkflowSubmit.test.mjs` or create `test/cdkPoolSubmitFlow.test.mjs`

- [ ] **Step 1: Make submit hook accept selected pool**

In `src/hooks/useRedeemSubmit.js`, add a new dependency:

```javascript
  getSubmitCdkeyValidation,
```

Change the first line inside `submitRedeems` from:

```javascript
async function submitRedeems() {
```

to:

```javascript
async function submitRedeems(options = {}) {
```

Replace:

```javascript
const cdkeyValidationForSubmit = submitCdkeyValidation;
```

with:

```javascript
const cdkeyValidationForSubmit = getSubmitCdkeyValidation
  ? getSubmitCdkeyValidation(options.poolId)
  : submitCdkeyValidation;
```

When creating `submittingRows`, add selected pool metadata:

```javascript
const submittingRows = decorateInitialAutoCycleRows(prepared.rows).map((row) => ({
  ...row,
  status: "submitting",
  submitPoolId: options.poolId || row.channel || "",
  submitPoolLabel:
    cdkeyValidationForSubmit.cdkeys.find((cdkey) => cdkey.poolId === (options.poolId || row.channel))?.poolLabel ||
    row.channelLabel ||
    ""
}));
```

At the end of successful submit, return a summary:

```javascript
return {
  submitted: submittingRows.length,
  poolId: options.poolId || "",
  waitingAccounts: prepared.waitingAccounts,
  pollableCdkeys: pollingCdkeys
};
```

- [ ] **Step 2: Wire App selected pool validation**

In `src/App.jsx`, import:

```javascript
import {
  buildCdkPoolChoices,
  chooseSubmitPoolDecision,
  restrictCdkeyPoolsToPool
} from "./state/cdkPoolSelection";
import { CdkPoolPickerDialog } from "./components/execute/CdkPoolPickerDialog";
```

Add state:

```javascript
const [poolPickerState, setPoolPickerState] = useState({
  open: false,
  reason: "start",
  choices: [],
  excludePoolIds: []
});
const lastSubmitPoolRef = useRef("");
const pendingPoolContinuationRef = useRef(false);
```

Pass into `useRedeemSubmit`:

```javascript
getSubmitCdkeyValidation: (poolId) =>
  parseCdkeyPools(poolId ? restrictCdkeyPoolsToPool(cdkeyPools, poolId) : cdkeyPools),
```

- [ ] **Step 3: Add submit orchestration functions**

Add in `src/App.jsx` near action handlers:

```javascript
async function submitWithPool(poolId) {
  setPoolPickerState((prev) => ({ ...prev, open: false }));
  lastSubmitPoolRef.current = poolId || "";
  const result = await submitRedeems({ poolId });
  pendingPoolContinuationRef.current = Boolean(result?.waitingAccounts > 0 && result?.poolId);
  return result;
}

async function startRedeemWithPoolDecision(options = {}) {
  const decision = chooseSubmitPoolDecision(cdkeyPools, {
    excludePoolIds: options.excludePoolIds || []
  });

  if (decision.kind === "prompt") {
    setPoolPickerState({
      open: true,
      reason: options.reason || "start",
      choices: decision.choices,
      excludePoolIds: options.excludePoolIds || []
    });
    return;
  }

  if (decision.kind === "direct") {
    await submitWithPool(decision.poolId);
    return;
  }

  await submitRedeems();
}

function closePoolPicker() {
  setPoolPickerState((prev) => ({ ...prev, open: false }));
}
```

Change the `ExecutionControlPanel` submit prop from:

```jsx
onSubmit={submitRedeems}
```

to:

```jsx
onSubmit={() => startRedeemWithPoolDecision()}
```

Render the dialog near existing modals:

```jsx
<CdkPoolPickerDialog
  open={poolPickerState.open}
  title={poolPickerState.reason === "continue" ? "继续选择卡密池" : "选择卡密池开始兑换"}
  message={
    poolPickerState.reason === "continue"
      ? "上一个卡密池已经兑换完，还有账号等待卡密，请选择下一个卡密池。"
      : "多个卡密池都有卡密，请选择本次从哪个池开始兑换。"
  }
  choices={poolPickerState.choices}
  onSelect={submitWithPool}
  onClose={closePoolPicker}
/>
```

- [ ] **Step 4: Add pool continuation effect**

Add in `src/App.jsx` after `currentTaskRows` is available:

```javascript
useEffect(() => {
  if (!pendingPoolContinuationRef.current || isBusy) return;
  const poolId = lastSubmitPoolRef.current;
  if (!poolId) return;

  const poolHasActiveRows = currentTaskRows.some(
    (row) =>
      String(row.submitPoolId || row.channel || "") === poolId &&
      !isTerminalStatus(row.status)
  );
  if (poolHasActiveRows) return;
  if (activeAccountLineCount <= 0) {
    pendingPoolContinuationRef.current = false;
    return;
  }

  pendingPoolContinuationRef.current = false;
  startRedeemWithPoolDecision({
    reason: "continue",
    excludePoolIds: [poolId]
  });
}, [activeAccountLineCount, currentTaskRows, isBusy, cdkeyPools]);
```

- [ ] **Step 5: Add focused tests**

Add tests in `test/cdkPoolSelection.test.mjs` if not already covered:

```javascript
test("pool decision after continuation ignores the pool that just finished", () => {
  const decision = chooseSubmitPoolDecision(
    {
      vip: "VIP-1",
      ideal: "IDEAL-1",
      upi: ""
    },
    { excludePoolIds: ["vip"] }
  );

  assert.equal(decision.kind, "direct");
  assert.equal(decision.poolId, "ideal");
});
```

Run:

```powershell
npm test -- test/cdkPoolSelection.test.mjs test/redeemWorkflowSubmit.test.mjs
```

Expected: PASS.

## Task 6: Full Verification

**Files:**
- Review all modified files.

- [ ] **Step 1: Run full test suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected: Vite build succeeds.

- [ ] **Step 3: Check diff hygiene**

Run:

```powershell
git diff --check
git status --short
```

Expected:
- `git diff --check` has no whitespace errors.
- `docs/` plan files remain untracked unless the user explicitly asks to include them.

- [ ] **Step 4: Local browser validation**

Use `http://127.0.0.1:5173/`:
- With one CDK pool filled, click `开始兑换`: no pool dialog appears, submit starts directly.
- With two CDK pools filled, click `开始兑换`: pool dialog appears with both pools and counts.
- Pick one pool: only that pool's CDKs are submitted.
- If accounts remain after selected pool rows finish, dialog appears again when multiple remaining pools exist.
- If only one remaining pool exists, the next batch starts directly without a dialog.
- Put accounts into local cooldown, click `一键恢复冷却`: `冷却账号` becomes 0 and accounts return to `可兑换`.

## Self-Review

- Spec coverage:
  - One-click restore cooldown button: Task 2 and Task 3.
  - Start redemption pool selection: Task 1, Task 4, Task 5.
  - Prompt only when multiple pools have CDKs: Task 1 helper tests and Task 5 orchestration.
  - Single pool direct start: Task 1 and Task 5.
  - Accounts greater than CDKs, choose next pool after previous pool finishes: Task 5 continuation effect.
- Backend safety: No backend API changes; submit body stays `{ cdkey, access_token, channel }`.
- State safety: Restore cooldown clears only local cooldown and attempt state; it does not rewrite backend status or Plus result.
- Deployment boundary: Plan excludes GitHub push and Hong Kong deployment until explicit instruction.
