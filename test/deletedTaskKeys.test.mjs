import assert from "node:assert/strict";
import test from "node:test";
import {
  addDeletedTaskRows,
  filterDeletedTaskRows,
  normalizeDeletedTaskKeys,
  removeDeletedTaskKeys
} from "../src/state/redeemWorkflow.js";

test("deleted task keys filter rows by id, email, or CDK", () => {
  const keys = addDeletedTaskRows({}, [
    { id: "row-1", email: "User@example.com", cdkey: "CDK-1" }
  ]);
  const rows = [
    { id: "row-1", email: "other@example.com", cdkey: "CDK-9" },
    { id: "row-2", email: "user@example.com", cdkey: "CDK-2" },
    { id: "row-3", email: "other@example.com", cdkey: "CDK-1" },
    { id: "row-4", email: "keep@example.com", cdkey: "CDK-4" }
  ];

  assert.deepEqual(filterDeletedTaskRows(rows, keys), [rows[3]]);
});

test("deleted task keys can be released when an account is imported again", () => {
  const keys = normalizeDeletedTaskKeys({
    rowIds: ["row-1"],
    emails: ["USER@example.com", "other@example.com"],
    cdkeys: ["CDK-1"]
  });
  assert.deepEqual(
    removeDeletedTaskKeys(keys, [{ email: "user@example.com" }]),
    { rowIds: ["row-1"], emails: ["other@example.com"], cdkeys: ["CDK-1"] }
  );
});
