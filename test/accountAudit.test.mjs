import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccountAuditRows,
  getAccountAuditCounts,
  getAccountAuditExportRows,
  getAccountAuditStatus,
  filterAccountAuditRows
} from "../src/domain/accountAudit.js";

const INPUT = [
  "plus@example.com---https://mail.example/plus---at-plus---2026-07-23",
  "banned@example.com---https://mail.example/banned---at-banned---2026-07-23",
  "invalid line"
].join("\n");

test("account audit reuses account parsing and reports invalid input", () => {
  const result = buildAccountAuditRows(INPUT);
  assert.equal(result.rows.length, 2);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.rows[0].source, "plus@example.com---https://mail.example/plus---at-plus---2026-07-23");
});

test("account audit classifies Plus only after subscription and mailbox checks", () => {
  const row = buildAccountAuditRows(INPUT).rows[0];
  assert.equal(getAccountAuditStatus(row), "pending");
  assert.equal(getAccountAuditStatus({ ...row, subscriptionStatus: "plus", subscriptionCategory: "plus" }), "plus_pending_email");
  assert.equal(getAccountAuditStatus({ ...row, subscriptionStatus: "plus", subscriptionCategory: "plus", emailVerificationStatus: "verified", emailPlusVerified: true }), "plus_verified");
});

test("account audit gives banned mail priority over Plus", () => {
  const row = buildAccountAuditRows(INPUT).rows[1];
  assert.equal(getAccountAuditStatus({ ...row, subscriptionStatus: "plus", subscriptionCategory: "plus", emailVerificationStatus: "banned", emailBanned: true }), "banned");
});

test("account audit separates token and remote account failures", () => {
  const row = buildAccountAuditRows(INPUT).rows[0];
  assert.equal(getAccountAuditStatus({ ...row, subscriptionStatus: "error", subscriptionCategory: "token_invalid" }), "token_invalid");
  assert.equal(getAccountAuditStatus({ ...row, subscriptionStatus: "error", subscriptionCategory: "no_account" }), "no_account");
  assert.equal(getAccountAuditStatus({ ...row, subscriptionStatus: "missing_token", subscriptionCategory: "missing_token" }), "check_failed");
});

test("account audit counts and exports preserve original lines", () => {
  const rows = buildAccountAuditRows(INPUT).rows.map((row, index) => index === 0
    ? { ...row, subscriptionStatus: "plus", subscriptionCategory: "plus", emailVerificationStatus: "verified", emailPlusVerified: true }
    : { ...row, emailVerificationStatus: "banned", emailBanned: true });
  const counts = getAccountAuditCounts(rows);
  assert.equal(counts.plus_verified, 1);
  assert.equal(counts.banned, 1);
  assert.deepEqual(filterAccountAuditRows(rows, "banned").map((row) => row.email), ["banned@example.com"]);
  assert.deepEqual(getAccountAuditExportRows(rows, "plus_verified"), [rows[0].source]);
});
