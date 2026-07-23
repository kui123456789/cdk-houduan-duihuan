# Session Header Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the Session availability badge from overlapping the “获取 Session” button at constrained desktop and narrow viewport widths.

**Architecture:** Keep the current JSX structure and solve the defect in the Session-specific CSS. The heading becomes a wrapping flex container whose title and action regions can shrink safely, while the nested action grid retains its two-button first row and full-width upload row.

**Tech Stack:** React 18, Vite 8, CSS Grid/Flexbox, Node.js built-in test runner

## Global Constraints

- Do not change Session button labels, order, or behavior.
- Do not expose or modify the Session default credential.
- Do not modify `docs/superpowers/plans/2026-07-12-hk-server-deployment.md`.
- Verify both desktop and narrow viewport layouts in a real browser.

---

### Task 1: Add the Session heading layout regression

**Files:**
- Modify: `test/prepLayout.test.mjs`
- Modify: `src/styles/prep.css`

**Interfaces:**
- Consumes: `.session-input-panel .section-heading`, `.session-input-panel .panel-header`, `.session-input-panel .panel-actions`, and `.session-action-grid` selectors.
- Produces: A responsive heading contract in which the title and action regions wrap instead of overlapping.

- [ ] **Step 1: Write the failing test**

Add a test that requires the Session heading to use `flex-wrap: wrap`, requires both title and action regions to have flexible bases and `min-width: 0`, and requires the action grid column to use `minmax(0, 1fr)`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/prepLayout.test.mjs`

Expected: FAIL because the current Session-specific CSS does not permit the heading regions to wrap and shrink safely.

- [ ] **Step 3: Implement the minimal CSS fix**

Update `src/styles/prep.css` so the Session heading wraps, the panel header and actions have flexible bases with zero minimum width, and the action grid's second column can shrink without overlapping the badge.

- [ ] **Step 4: Run the focused and full automated checks**

Run: `node --test test/prepLayout.test.mjs`

Expected: all tests in the file pass.

Run: `npm test`

Expected: all project tests pass with zero failures.

Run: `npm run build`

Expected: Vite production build exits successfully.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Verify the rendered layout**

Open the local app at the reported desktop size and a narrow viewport. Compare the bounding rectangles of `.count-badge` and `.session-link-action`; their intersection area must be zero at both sizes. Capture screenshots and confirm there are no browser console errors.
