import assert from "node:assert/strict";
import test from "node:test";
import { buildPooledSubmitRows } from "../src/state/redeemWorkflow.js";

test("buildPooledSubmitRows never pairs the same access token with two CDKs", () => {
  const accounts = [
    {
      lineNumber: 1,
      email: "first@example.com",
      accessToken: "same-at-token",
      source: "first@example.com---pw---2fa---same-at-token---t1"
    },
    {
      lineNumber: 2,
      email: "second@example.com",
      accessToken: "same-at-token",
      source: "second@example.com---pw---2fa---same-at-token---t2"
    },
    {
      lineNumber: 3,
      email: "third@example.com",
      accessToken: "unique-at-token",
      source: "third@example.com---pw---2fa---unique-at-token---t3"
    }
  ];
  const cdkeys = [
    { lineNumber: 1, cdkey: "CDK-001", channel: "ideal", channelLabel: "IDEAL 排队" },
    { lineNumber: 2, cdkey: "CDK-002", channel: "ideal", channelLabel: "IDEAL 排队" }
  ];

  const result = buildPooledSubmitRows({
    accounts,
    cdkeys,
    existingRows: [],
    blockedEmails: new Set()
  });

  assert.deepEqual(
    result.rows.map((row) => [row.email, row.accessToken, row.cdkey]),
    [
      ["first@example.com", "same-at-token", "CDK-001"],
      ["third@example.com", "unique-at-token", "CDK-002"]
    ]
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].reason, "AT 重复，已跳过，避免同一账号同时消耗多张卡密");
});
