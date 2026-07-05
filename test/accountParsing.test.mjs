import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAccountText,
  parseAccounts
} from "../src/domain/accountParsing.js";

const DUPLICATE_TOKEN_INPUT = [
  "first@example.com---pw1---2fa1---same-at-token---2026-07-05T00:00:00Z",
  "second@example.com---pw2---2fa2---same-at-token---2026-07-05T00:01:00Z"
].join("\n");

test("parseAccounts rejects duplicate access tokens even when emails differ", () => {
  const result = parseAccounts(DUPLICATE_TOKEN_INPUT);

  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "first@example.com");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].type, "account_duplicate_token");
});

test("normalizeAccountText drops duplicate access token lines from the redeemable pool", () => {
  const result = normalizeAccountText(DUPLICATE_TOKEN_INPUT);

  assert.equal(result.accountCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.text, "first@example.com---pw1---2fa1---same-at-token---2026-07-05T00:00:00Z");
});
