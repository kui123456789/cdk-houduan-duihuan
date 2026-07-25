import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getDialogFocusTarget } from "../src/components/common/dialogFocus.js";
import { paginateItems } from "../src/components/common/pagination.js";

test("pagination keeps a 1000-row result set to a bounded render page", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ id: `row-${index}` }));
  const page = paginateItems(rows, 20, 50);

  assert.equal(page.page, 20);
  assert.equal(page.totalPages, 20);
  assert.equal(page.items.length, 50);
  assert.equal(page.items[0].id, "row-950");
  assert.equal(page.items.at(-1).id, "row-999");
});

test("pagination clamps stale pages after filters reduce the result set", () => {
  const page = paginateItems([{ id: "only" }], 99, 50);

  assert.equal(page.page, 1);
  assert.equal(page.totalPages, 1);
  assert.deepEqual(page.items, [{ id: "only" }]);
});

test("dialog focus wraps from last to first and first to last", () => {
  const first = { id: "first" };
  const middle = { id: "middle" };
  const last = { id: "last" };
  const elements = [first, middle, last];

  assert.equal(getDialogFocusTarget(elements, last, false), first);
  assert.equal(getDialogFocusTarget(elements, first, true), last);
  assert.equal(getDialogFocusTarget(elements, middle, false), undefined);
  assert.equal(getDialogFocusTarget([], middle, false), null);
});

test("all application dialogs share the accessible dialog boundary", () => {
  const appSource = fs.readFileSync("src/App.jsx", "utf8");
  const pickerSource = fs.readFileSync("src/components/execute/CdkPoolPickerDialog.jsx", "utf8");
  const dialogSource = fs.readFileSync("src/components/common/AccessibleDialog.jsx", "utf8");

  assert.doesNotMatch(appSource, /role="dialog"/);
  assert.match(appSource, /<AccessibleDialog/g);
  assert.match(pickerSource, /<AccessibleDialog/);
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /restoreFocus\(focusOrigin\)/);
});

test("large tables page their rows and status rows are memoized", () => {
  const requestPanel = fs.readFileSync("src/components/request/RequestStatusPanel.jsx", "utf8");
  const auditWorkspace = fs.readFileSync("src/components/audit/AccountAuditWorkspace.jsx", "utf8");
  const statusRow = fs.readFileSync("src/components/request/StatusRow.jsx", "utf8");

  assert.match(requestPanel, /paginateItems\(visibleRequestRows/);
  assert.match(auditWorkspace, /paginateItems\(visibleRows/);
  assert.match(statusRow, /memo\(StatusRowComponent/);
});
