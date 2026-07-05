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

test("parseAccounts accepts email mailbox URL access token timestamp format", () => {
  const input = "url@example.com---https://mail.example/inbox/code-123---eyJ.header.payload---2026-07-05T03:31:25Z";

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(
    {
      email: result.accounts[0].email,
      pickupUrl: result.accounts[0].pickupUrl,
      accessToken: result.accounts[0].accessToken,
      timestamp: result.accounts[0].timestamp,
      password: result.accounts[0].password,
      twofa: result.accounts[0].twofa,
      inputFormat: result.accounts[0].inputFormat,
      exportLine: result.accounts[0].exportLine
    },
    {
      email: "url@example.com",
      pickupUrl: "https://mail.example/inbox/code-123",
      accessToken: "eyJ.header.payload",
      timestamp: "2026-07-05T03:31:25Z",
      password: "",
      twofa: "",
      inputFormat: "email_pickup_url_at_timestamp",
      exportLine: "url@example.com---https://mail.example/inbox/code-123---2026-07-05T03:31:25Z"
    }
  );
});

test("parseAccounts accepts email mailbox URL access token without timestamp", () => {
  const input = "url2@example.com---https://mail.example/inbox/code-456---eyJ.header.payload2";

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "url2@example.com");
  assert.equal(result.accounts[0].pickupUrl, "https://mail.example/inbox/code-456");
  assert.equal(result.accounts[0].accessToken, "eyJ.header.payload2");
  assert.equal(result.accounts[0].timestamp, "");
  assert.equal(result.accounts[0].inputFormat, "email_pickup_url_at");
  assert.equal(result.accounts[0].exportLine, "url2@example.com---https://mail.example/inbox/code-456");
});

test("parseAccounts accepts email access token timestamp format", () => {
  const input = "short@example.com---eyJ.short.token---2026-07-05T03:31:25Z";

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "short@example.com");
  assert.equal(result.accounts[0].accessToken, "eyJ.short.token");
  assert.equal(result.accounts[0].timestamp, "2026-07-05T03:31:25Z");
  assert.equal(result.accounts[0].inputFormat, "email_at_timestamp");
  assert.equal(result.accounts[0].exportLine, "short@example.com---2026-07-05T03:31:25Z");
});

test("parseAccounts accepts email access token without timestamp", () => {
  const input = "short2@example.com---eyJ.short.token2";

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "short2@example.com");
  assert.equal(result.accounts[0].accessToken, "eyJ.short.token2");
  assert.equal(result.accounts[0].timestamp, "");
  assert.equal(result.accounts[0].inputFormat, "email_at");
  assert.equal(result.accounts[0].exportLine, "short2@example.com");
});

test("normalizeAccountText keeps supported mixed account formats and removes duplicate AT", () => {
  const input = [
    "legacy@example.com---pw---2fa---same-token---2026-07-05T00:00:00Z",
    "duplicate@example.com---https://mail.example/inbox---same-token---2026-07-05T00:01:00Z",
    "url@example.com---https://mail.example/inbox-2---unique-token---2026-07-05T00:02:00Z",
    "short@example.com---short-token"
  ].join("\n");

  const result = normalizeAccountText(input);

  assert.equal(result.accountCount, 3);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.errors[0].type, "account_duplicate_token");
  assert.equal(
    result.text,
    [
      "legacy@example.com---pw---2fa---same-token---2026-07-05T00:00:00Z",
      "url@example.com---https://mail.example/inbox-2---unique-token---2026-07-05T00:02:00Z",
      "short@example.com---short-token"
    ].join("\n")
  );
});

test("parseAccounts rejects unsupported account segment counts with clear reason", () => {
  const result = parseAccounts("bad@example.com---a---b---c---d---e");

  assert.equal(result.accounts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0].reason,
    /支持格式：邮箱---密码---2fa---at---时间戳/
  );
});
