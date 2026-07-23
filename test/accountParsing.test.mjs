import assert from "node:assert/strict";
import test from "node:test";
import {
  getAccessTokenEmail,
  mergeAccountSources,
  normalizeSessionText,
  normalizeAccountText,
  parseAccounts
} from "../src/domain/accountParsing.js";

function createJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

test("access token email comes only from a valid JWT email claim", () => {
  const token = createJwt({
    "https://api.openai.com/profile": { email: "Real.Owner@Example.com" }
  });

  assert.equal(getAccessTokenEmail(token), "real.owner@example.com");
  assert.equal(getAccessTokenEmail("opaque-token"), "");
});

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

test("parseAccounts accepts password 2fa mailbox URL access token timestamp format", () => {
  const input =
    "full@example.com---pw123---JBSWY3DPEHPK3PXP---https://mail.example/inbox/full---eyJ.full.token---2026-07-05T03:31:25Z";

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(
    {
      email: result.accounts[0].email,
      password: result.accounts[0].password,
      twofa: result.accounts[0].twofa,
      pickupUrl: result.accounts[0].pickupUrl,
      accessToken: result.accounts[0].accessToken,
      timestamp: result.accounts[0].timestamp,
      inputFormat: result.accounts[0].inputFormat,
      exportLine: result.accounts[0].exportLine
    },
    {
      email: "full@example.com",
      password: "pw123",
      twofa: "JBSWY3DPEHPK3PXP",
      pickupUrl: "https://mail.example/inbox/full",
      accessToken: "eyJ.full.token",
      timestamp: "2026-07-05T03:31:25Z",
      inputFormat: "email_password_2fa_pickup_url_at_timestamp",
      exportLine:
        "full@example.com---pw123---JBSWY3DPEHPK3PXP---https://mail.example/inbox/full---2026-07-05T03:31:25Z"
    }
  );
});

test("parseAccounts accepts password passkey mailbox URL access token timestamp format", () => {
  const input =
    "passkey@example.com---pw456---PASSKEY:abc123---https://mail.example/inbox/passkey---eyJ.passkey.token---2026-07-05T03:31:25Z";

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "passkey@example.com");
  assert.equal(result.accounts[0].password, "pw456");
  assert.equal(result.accounts[0].twofa, "PASSKEY:abc123");
  assert.equal(result.accounts[0].pickupUrl, "https://mail.example/inbox/passkey");
  assert.equal(result.accounts[0].accessToken, "eyJ.passkey.token");
  assert.equal(result.accounts[0].timestamp, "2026-07-05T03:31:25Z");
  assert.equal(result.accounts[0].inputFormat, "email_password_2fa_pickup_url_at_timestamp");
  assert.equal(
    result.accounts[0].exportLine,
    "passkey@example.com---pw456---PASSKEY:abc123---https://mail.example/inbox/passkey---2026-07-05T03:31:25Z"
  );
});

test("parseAccounts accepts password 2fa mailbox URL access token without timestamp", () => {
  const input = "notime@example.com---pw789---2fa-value---https://mail.example/inbox/notime---eyJ.notime.token";

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "notime@example.com");
  assert.equal(result.accounts[0].pickupUrl, "https://mail.example/inbox/notime");
  assert.equal(result.accounts[0].accessToken, "eyJ.notime.token");
  assert.equal(result.accounts[0].timestamp, "");
  assert.equal(result.accounts[0].inputFormat, "email_password_2fa_pickup_url_at");
  assert.equal(
    result.accounts[0].exportLine,
    "notime@example.com---pw789---2fa-value---https://mail.example/inbox/notime"
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
  const result = parseAccounts("bad@example.com---a---b---c---d---e---f");

  assert.equal(result.accounts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0].reason,
    /支持格式：邮箱---邮箱取件码地址---at---时间戳/
  );
});

test("normalizeSessionText accepts ChatGPT auth session JSON", () => {
  const input = JSON.stringify({
    user: { email: "session@example.com" },
    accessToken: "session-access-token",
    expires: "2026-07-09T00:00:00.000Z"
  });

  const result = normalizeSessionText(input);

  assert.equal(result.sessionCount, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sessions[0].email, "session@example.com");
  assert.equal(result.sessions[0].accessToken, "session-access-token");
  assert.equal(result.sessions[0].inputFormat, "chatgpt_session_json");
  assert.equal(result.sessions[0].exportLine, "session@example.com---2026-07-09T00:00:00.000Z");
});

test("normalizeSessionText keeps session input separate and dedupes tokens", () => {
  const sessionJson = JSON.stringify({
    user: { email: "first-session@example.com" },
    accessToken: "same-session-token"
  });
  const input = [
    sessionJson,
    `second-session@example.com---${sessionJson}`,
    "bad-session-line"
  ].join("\n");

  const result = normalizeSessionText(input);

  assert.equal(result.sessionCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.invalidCount, 1);
  assert.equal(result.errors[0].type, "session_duplicate_token");
  assert.equal(result.errors[1].type, "session_format");
  assert.equal(result.text, sessionJson);
});

test("mergeAccountSources keeps account and session pools separate but dedupes submit queue", () => {
  const accountResult = normalizeAccountText("shared@example.com---same-token");
  const sessionResult = normalizeSessionText(
    JSON.stringify({
      user: { email: "session@example.com" },
      accessToken: "same-token"
    })
  );

  const merged = mergeAccountSources(accountResult, sessionResult);

  assert.equal(merged.accountCount, 1);
  assert.equal(merged.accounts[0].email, "shared@example.com");
  assert.equal(merged.duplicateCount, 1);
  assert.equal(merged.errors.at(-1).type, "session_duplicate_token");
  assert.deepEqual(merged.sourceCounts, { account: 1, session: 0 });
});
