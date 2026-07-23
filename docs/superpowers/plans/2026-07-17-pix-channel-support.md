# PIX Channel Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separate PIX and PIX VIP CDK pools, send backend channel values `pix` and `pix_vip`, and export both through a dedicated PIX result pool.

**Architecture:** Keep each CDK pool id equal to the backend `channel` value so the existing submit, retry, polling, and auto-cycle paths continue to carry the correct route without a second mapping layer. Preserve the existing `vip` id for IDEAL VIP compatibility, while adding `pix` and `pix_vip` as new ids and grouping both PIX routes into a new `pix` export bucket.

**Tech Stack:** React 18, Vite 8, Node.js test runner, browser localStorage workflow snapshots.

## Global Constraints

- Existing `vip` continues to be sent to the backend as `channel: "vip"` and is displayed as `IDEAL VIP`.
- PIX standard sends `channel: "pix"`.
- PIX VIP sends `channel: "pix_vip"`.
- Existing UPI and IDEAL stored data and export pools remain backward compatible.
- Do not deploy until the user explicitly requests deployment.

---

### Task 1: Add PIX CDK pools

**Files:**
- Modify: `src/domain/accountParsing.js`
- Modify: `src/components/prep/PrepWorkspace.jsx`
- Test: `test/cdkPoolSelection.test.mjs`

**Interfaces:**
- Consumes: `CDK_POOLS` and `parseCdkeyPools(input)`.
- Produces: pool ids `pix_vip` and `pix`, with parsed rows whose `channel` and `poolId` match those ids.

- [ ] **Step 1: Write the failing pool-definition test**

```javascript
test("PIX pools expose backend channel ids for standard and VIP", () => {
  const choices = buildCdkPoolChoices({ pix_vip: "PIX-VIP-1", pix: "PIX-1" });
  assert.deepEqual(
    choices.map(({ id, shortLabel }) => ({ id, shortLabel })),
    [
      { id: "pix_vip", shortLabel: "PIX VIP" },
      { id: "pix", shortLabel: "PIX" }
    ]
  );
});
```

- [ ] **Step 2: Run the pool test and verify RED**

Run: `node --test test/cdkPoolSelection.test.mjs`

Expected: the new test fails because `CDK_POOLS` does not contain `pix_vip` or `pix`.

- [ ] **Step 3: Add the two pool definitions and update visible pool copy**

```javascript
{
  id: "pix_vip",
  label: "PIX VIP 通道",
  shortLabel: "PIX VIP",
  description: "PIX VIP 优先通道卡密池",
  placeholder: "PIX-VIP-CDK-001\nPIX-VIP-CDK-002"
},
{
  id: "pix",
  label: "PIX 排队",
  shortLabel: "PIX",
  description: "PIX 队列卡密池",
  placeholder: "PIX-CDK-001\nPIX-CDK-002"
}
```

Update the prep heading to `五类卡密池` and list `IDEAL VIP、IDEAL、UPI、PIX VIP、PIX`.

- [ ] **Step 4: Run the pool test and verify GREEN**

Run: `node --test test/cdkPoolSelection.test.mjs`

Expected: all pool-selection tests pass.

### Task 2: Route PIX success exports

**Files:**
- Modify: `src/domain/exportFormatting.js`
- Test: `test/exportFormatting.test.mjs`

**Interfaces:**
- Consumes: successful Plus rows with `row.channel`.
- Produces: `{ upi: string[], ideal: string[], pix: string[] }` from `getSuccessExportsByPool(rows)`.

- [ ] **Step 1: Write the failing export grouping test**

```javascript
test("getSuccessExportsByPool groups PIX and PIX VIP into the PIX export", () => {
  const grouped = getSuccessExportsByPool([
    { status: "success", isPlus: true, channel: "pix", exportLine: "pix@example.com" },
    { status: "success", isPlus: true, channel: "pix_vip", exportLine: "pix-vip@example.com" }
  ]);
  assert.deepEqual(grouped.pix, ["pix@example.com", "pix-vip@example.com"]);
});
```

- [ ] **Step 2: Run the export test and verify RED**

Run: `node --test test/exportFormatting.test.mjs`

Expected: `grouped.pix` is missing.

- [ ] **Step 3: Add the PIX export bucket**

Return `{ upi: [], ideal: [], pix: [] }` and push both `pix` and `pix_vip` channels into `acc.pix`.

- [ ] **Step 4: Run the export test and verify GREEN**

Run: `node --test test/exportFormatting.test.mjs`

Expected: all export-formatting tests pass.

### Task 3: Persist and display the PIX export pool

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/storage/workflowPersistence.js`
- Modify: `src/components/export/ResultWorkspace.jsx`
- Test: `test/workflowPersistence.test.mjs`

**Interfaces:**
- Consumes: archived/live PIX export lines.
- Produces: normalized `plusExports.pix`, `downloadedExportCounts.pix`, a PIX export card, and generic copy/download behavior labeled `PIX`.

- [ ] **Step 1: Write the failing persistence test**

Update the workflow snapshot round-trip fixture to include:

```javascript
plusExports: { upi: ["line"], ideal: [], pix: ["pix-line"] },
downloadedExportCounts: { upi: 2, ideal: 0, pix: 1 }
```

Assert the loaded snapshot preserves both PIX values.

- [ ] **Step 2: Run the persistence test and verify RED**

Run: `node --test test/workflowPersistence.test.mjs`

Expected: the normalized snapshot drops `pix`.

- [ ] **Step 3: Add PIX normalization, counters, labels, and export card**

Add `pix` to both normalization functions in `App.jsx` and `workflowPersistence.js`; merge live and archived PIX exports; include PIX in archived/downloaded/export-line totals; and pass `canCopyPixSuccess` to `ResultWorkspace`.

Add this result card:

```jsx
<SuccessExportCard
  title="PIX 成功导出"
  subtitle="仅 success + Plus；PIX 和 PIX VIP 都进入此池"
  value={successExports.pix}
  downloadFileName="pix_success_accounts.txt"
  disabled={!canCopyPixSuccess}
  onCopy={() => onCopySuccess("pix")}
  onDownload={() => onDownloadSuccess("pix")}
/>
```

Use a shared label mapping `{ upi: "UPI", ideal: "IDEAL", pix: "PIX" }` in copy/download messages.

- [ ] **Step 4: Run persistence and focused UI-domain tests**

Run: `node --test test/workflowPersistence.test.mjs test/exportFormatting.test.mjs test/cdkPoolSelection.test.mjs test/prepLayout.test.mjs`

Expected: all focused tests pass.

### Task 4: Verify the complete feature

**Files:**
- Verify all files modified above.

**Interfaces:**
- Consumes: completed implementation.
- Produces: evidence that PIX and PIX VIP are compatible with the entire application.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: zero failed tests.

- [ ] **Step 2: Run the production build**

Run: `npm run build -- --configLoader runner`

Expected: Vite exits successfully and writes `dist/`.

- [ ] **Step 3: Check the diff**

Run: `git diff --check`

Expected: no whitespace errors.

## Self-Review

- Spec coverage: `vip`, `pix`, and `pix_vip` backend values are explicit; input, submission, export, storage, and UI are covered.
- Placeholder scan: no deferred implementation steps or unspecified tests remain.
- Type consistency: `pix` is consistently the export bucket, while `pix_vip` remains a CDK pool/backend channel id.
