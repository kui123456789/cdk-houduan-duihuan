import assert from "node:assert/strict";
import test from "node:test";
import {
  getAccessTokenEmail,
  updateAccountSourceSessionToken,
  mergeAccountSources,
  normalizeSessionText,
  updateSessionSourceCredentials,
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
  const token = createJwt({ email: "url@example.com" });
  const input = `url@example.com---https://mail.example/inbox/code-123---${token}---2026-07-05T03:31:25Z`;

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
      accessToken: token,
      timestamp: "2026-07-05T03:31:25Z",
      password: "",
      twofa: "",
      inputFormat: "email_pickup_url_at_timestamp",
      exportLine: "url@example.com---https://mail.example/inbox/code-123---2026-07-05T03:31:25Z"
    }
  );
});

test("parseAccounts accepts password 2fa mailbox URL access token timestamp format", () => {
  const token = createJwt({ email: "full@example.com" });
  const input =
    `full@example.com---pw123---JBSWY3DPEHPK3PXP---https://mail.example/inbox/full---${token}---2026-07-05T03:31:25Z`;

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
      accessToken: token,
      timestamp: "2026-07-05T03:31:25Z",
      inputFormat: "email_password_2fa_pickup_url_at_timestamp",
      exportLine:
        "full@example.com---pw123---JBSWY3DPEHPK3PXP---https://mail.example/inbox/full---2026-07-05T03:31:25Z"
    }
  );
});

test("parseAccounts accepts password passkey mailbox URL access token timestamp format", () => {
  const token = createJwt({ email: "passkey@example.com" });
  const input =
    `passkey@example.com---pw456---PASSKEY:abc123---https://mail.example/inbox/passkey---${token}---2026-07-05T03:31:25Z`;

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "passkey@example.com");
  assert.equal(result.accounts[0].password, "pw456");
  assert.equal(result.accounts[0].twofa, "PASSKEY:abc123");
  assert.equal(result.accounts[0].pickupUrl, "https://mail.example/inbox/passkey");
  assert.equal(result.accounts[0].accessToken, token);
  assert.equal(result.accounts[0].timestamp, "2026-07-05T03:31:25Z");
  assert.equal(result.accounts[0].inputFormat, "email_password_2fa_pickup_url_at_timestamp");
  assert.equal(
    result.accounts[0].exportLine,
    "passkey@example.com---pw456---PASSKEY:abc123---https://mail.example/inbox/passkey---2026-07-05T03:31:25Z"
  );
});

test("parseAccounts accepts password 2fa mailbox URL access token without timestamp", () => {
  const token = createJwt({ email: "notime@example.com" });
  const input = `notime@example.com---pw789---2fa-value---https://mail.example/inbox/notime---${token}`;

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "notime@example.com");
  assert.equal(result.accounts[0].pickupUrl, "https://mail.example/inbox/notime");
  assert.equal(result.accounts[0].accessToken, token);
  assert.equal(result.accounts[0].timestamp, "");
  assert.equal(result.accounts[0].inputFormat, "email_password_2fa_pickup_url_at");
  assert.equal(
    result.accounts[0].exportLine,
    "notime@example.com---pw789---2fa-value---https://mail.example/inbox/notime"
  );
});

test("parseAccounts accepts email mailbox URL access token without timestamp", () => {
  const token = createJwt({ email: "url2@example.com" });
  const input = `url2@example.com---https://mail.example/inbox/code-456---${token}`;

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "url2@example.com");
  assert.equal(result.accounts[0].pickupUrl, "https://mail.example/inbox/code-456");
  assert.equal(result.accounts[0].accessToken, token);
  assert.equal(result.accounts[0].timestamp, "");
  assert.equal(result.accounts[0].inputFormat, "email_pickup_url_at");
  assert.equal(result.accounts[0].exportLine, "url2@example.com---https://mail.example/inbox/code-456");
});

test("parseAccounts accepts email access token timestamp format", () => {
  const token = createJwt({ email: "short@example.com" });
  const input = `short@example.com---${token}---2026-07-05T03:31:25Z`;

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "short@example.com");
  assert.equal(result.accounts[0].accessToken, token);
  assert.equal(result.accounts[0].timestamp, "2026-07-05T03:31:25Z");
  assert.equal(result.accounts[0].inputFormat, "email_at_timestamp");
  assert.equal(result.accounts[0].exportLine, "short@example.com---2026-07-05T03:31:25Z");
});

test("parseAccounts accepts email access token without timestamp", () => {
  const token = createJwt({ email: "short2@example.com" });
  const input = `short2@example.com---${token}`;

  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "short2@example.com");
  assert.equal(result.accounts[0].accessToken, token);
  assert.equal(result.accounts[0].timestamp, "");
  assert.equal(result.accounts[0].inputFormat, "email_at");
  assert.equal(result.accounts[0].exportLine, "short2@example.com");
});

test("six-part account format classifies a non-AT credential as Session", () => {
  const input =
    "session-main@example.com---pw---2fa---https://mail.example/session---opaque-session-token---2026-08-01 12:00:00";
  const result = parseAccounts(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts[0].credentialKind, "session_token");
  assert.equal(result.accounts[0].sessionToken, "opaque-session-token");
  assert.equal(result.accounts[0].accessToken, "");
  assert.equal(result.accounts[0].sourceType, "session");
});

test("six-part account format rejects an AT owned by another email", () => {
  const token = createJwt({ email: "other@example.com" });
  const result = parseAccounts(
    `owner@example.com---pw---2fa---https://mail.example/owner---${token}---2026-08-01 12:00:00`
  );

  assert.equal(result.accounts.length, 0);
  assert.match(result.errors[0].reason, /与第 1 段邮箱不一致/);
});

test("optional timestamp keeps delimiter text inside a Session credential", () => {
  const result = parseAccounts(
    "time@example.com---pw---2fa---https://mail.example/time---session-token---not-a-time"
  );

  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts[0].sessionToken, "session-token---not-a-time");
  assert.equal(result.accounts[0].timestamp, "");
});

test("rotated Session replaces only the fifth part of the unified account line", () => {
  const source =
    "rotate@example.com---pw---2fa---https://mail.example/rotate---old---session---2026-08-01 12:00:00";
  assert.equal(
    updateAccountSourceSessionToken(source, "new-session"),
    "rotate@example.com---pw---2fa---https://mail.example/rotate---new-session---2026-08-01 12:00:00"
  );
});

test("parseAccounts preserves delimiter sequences inside access tokens", () => {
  const token = `${createJwt({ email: "full-delimiter@example.com" })}---signature-fragment`;
  const inputs = [
    {
      line: `full-delimiter@example.com---pw---2fa---https://mail.example/inbox/full---${token}---2026-07-26 21:10:35`,
      pickupUrl: "https://mail.example/inbox/full"
    },
    {
      line: `pickup-delimiter@example.com---https://mail.example/inbox/short---eyJ.header.payload---signature-fragment---2026-07-26T21:10:35Z`,
      pickupUrl: "https://mail.example/inbox/short"
    },
    {
      line: `short-delimiter@example.com---eyJ.header.payload---signature-fragment---2026-07-26T21:10:35Z`,
      pickupUrl: ""
    }
  ];

  for (const input of inputs) {
    const result = parseAccounts(input.line);
    assert.equal(result.errors.length, 0);
    assert.equal(result.accounts.length, 1);
    assert.equal(
      result.accounts[0].accessToken || result.accounts[0].sessionToken,
      input.line.includes("full-delimiter") ? token : "eyJ.header.payload---signature-fragment"
    );
    assert.equal(result.accounts[0].pickupUrl, input.pickupUrl);
  }
});

test("parseAccounts preserves delimiter sequences inside tokens without timestamps", () => {
  const tokens = [
    `${createJwt({ email: "full-notime@example.com" })}---signature-full`,
    `${createJwt({ email: "pickup-notime@example.com" })}---signature-pickup`,
    `${createJwt({ email: "short-notime@example.com" })}---signature-short`
  ];
  const input = [
    `full-notime@example.com---pw---2fa---https://mail.example/inbox/full-notime---${tokens[0]}`,
    `pickup-notime@example.com---https://mail.example/inbox/short-notime---${tokens[1]}`,
    `short-notime@example.com---${tokens[2]}`
  ].join("\n");

  const result = parseAccounts(input);
  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 3);
  assert.deepEqual(result.accounts.map((account) => account.accessToken), tokens);
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

test("parseAccounts rejects unsupported account rows with clear reason", () => {
  const result = parseAccounts("bad@example.com");

  assert.equal(result.accounts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0].reason,
    /取件地址和时间戳均可省略/
  );
});

test("all supported account shapes accept optional pickup URL and timestamp", () => {
  const cases = [
    { suffix: "pw---2fa---https://mail.example/full---CREDENTIAL---2026-08-01 12:00:00", pickup: true, timestamp: true },
    { suffix: "pw---2fa---https://mail.example/full---CREDENTIAL", pickup: true, timestamp: false },
    { suffix: "pw---2fa---CREDENTIAL---2026-08-01 12:00:00", pickup: false, timestamp: true },
    { suffix: "pw---2fa---CREDENTIAL", pickup: false, timestamp: false },
    { suffix: "https://mail.example/short---CREDENTIAL---2026-08-01 12:00:00", pickup: true, timestamp: true },
    { suffix: "https://mail.example/short---CREDENTIAL", pickup: true, timestamp: false },
    { suffix: "CREDENTIAL---2026-08-01 12:00:00", pickup: false, timestamp: true },
    { suffix: "CREDENTIAL", pickup: false, timestamp: false }
  ];

  for (const [index, shape] of cases.entries()) {
    for (const kind of ["access_token", "session_token"]) {
      const email = `${kind}-${index}@example.com`;
      const credential = kind === "access_token" ? createJwt({ email }) : `session-${index}`;
      const result = parseAccounts(`${email}---${shape.suffix.replace("CREDENTIAL", credential)}`);
      assert.equal(result.errors.length, 0, `${kind} shape ${index}`);
      assert.equal(result.accounts[0].credentialKind, kind, `${kind} shape ${index}`);
      assert.equal(Boolean(result.accounts[0].pickupUrl), shape.pickup, `${kind} shape ${index}`);
      assert.equal(Boolean(result.accounts[0].timestamp), shape.timestamp, `${kind} shape ${index}`);
    }
  }
});

test("Session rotation preserves every optional-field account shape", () => {
  const cases = [
    ["rotate1@example.com---pw---2fa---https://mail.example/full---old---2026-08-01 12:00:00", "rotate1@example.com---pw---2fa---https://mail.example/full---new---2026-08-01 12:00:00"],
    ["rotate2@example.com---pw---2fa---https://mail.example/full---old", "rotate2@example.com---pw---2fa---https://mail.example/full---new"],
    ["rotate3@example.com---pw---2fa---old---2026-08-01 12:00:00", "rotate3@example.com---pw---2fa---new---2026-08-01 12:00:00"],
    ["rotate4@example.com---pw---2fa---old", "rotate4@example.com---pw---2fa---new"],
    ["rotate5@example.com---https://mail.example/short---old---2026-08-01 12:00:00", "rotate5@example.com---https://mail.example/short---new---2026-08-01 12:00:00"],
    ["rotate6@example.com---https://mail.example/short---old", "rotate6@example.com---https://mail.example/short---new"],
    ["rotate7@example.com---old---2026-08-01 12:00:00", "rotate7@example.com---new---2026-08-01 12:00:00"],
    ["rotate8@example.com---old", "rotate8@example.com---new"]
  ];
  cases.forEach(([source, expected]) => {
    assert.equal(updateAccountSourceSessionToken(source, "new"), expected);
  });
});

test("normalizeSessionText accepts ChatGPT auth session JSON", () => {
  const input = JSON.stringify({
    user: { email: "session@example.com" },
    accessToken: "session-access-token",
    sessionToken: "session-cookie-token",
    expires: "2026-07-09T00:00:00.000Z"
  });

  const result = normalizeSessionText(input);

  assert.equal(result.sessionCount, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sessions[0].email, "session@example.com");
  assert.equal(result.sessions[0].accessToken, "session-access-token");
  assert.equal(result.sessions[0].sessionToken, "session-cookie-token");
  assert.deepEqual(result.sessions[0].session, JSON.parse(input));
  assert.equal(result.sessions[0].inputFormat, "chatgpt_session_json");
  assert.equal(result.sessions[0].exportLine, "session@example.com---2026-07-09T00:00:00.000Z");
});

test("full account rows unwrap embedded ChatGPT Session JSON", () => {
  const email = "embedded-session@example.com";
  const accessToken = createJwt({ email });
  const sessionPayload = JSON.stringify({
    user: { email },
    accessToken,
    sessionToken: "real-session-token",
    expires: "2026-10-31T00:00:00.000Z"
  });
  const input = [
    email,
    "password",
    "2fa-secret",
    "https://mail.example/inbox/embedded-session",
    sessionPayload,
    "2026-08-02T00:00:00.000Z"
  ].join("---");

  const accountResult = parseAccounts(input);
  const sessionResult = normalizeSessionText(input);

  assert.equal(accountResult.errors.length, 0);
  assert.equal(accountResult.accounts[0].credentialKind, "session_token");
  assert.equal(accountResult.accounts[0].sessionToken, "real-session-token");
  assert.equal(accountResult.accounts[0].accessToken, accessToken);
  assert.deepEqual(accountResult.accounts[0].session, JSON.parse(sessionPayload));
  assert.equal(sessionResult.errors.length, 0);
  assert.equal(sessionResult.sessions[0].sessionToken, "real-session-token");
  assert.equal(sessionResult.sessions[0].accessToken, accessToken);
  assert.deepEqual(sessionResult.sessions[0].session, JSON.parse(sessionPayload));
  assert.equal(sessionResult.sessions[0].refreshOnly, false);
});

test("updateSessionSourceCredentials writes refreshed AT and rotated Session", () => {
  const source = `session@example.com---${JSON.stringify({
    user: { email: "session@example.com" },
    accessToken: "old-at",
    sessionToken: "old-session"
  })}`;
  const updated = updateSessionSourceCredentials(source, {
    accessToken: "new-at",
    sessionToken: "new-session",
    expires: "2026-08-03T00:00:00.000Z"
  });
  const payload = JSON.parse(updated.split("---").slice(1).join("---"));

  assert.equal(payload.accessToken, "new-at");
  assert.equal(payload.sessionToken, "new-session");
  assert.equal(payload.expires, "2026-08-03T00:00:00.000Z");
});

test("normalizeSessionText accepts email and sessionToken without an old AT", () => {
  const result = normalizeSessionText("refresh@example.com---session-cookie-token");

  assert.equal(result.sessionCount, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sessions[0].email, "refresh@example.com");
  assert.equal(result.sessions[0].accessToken, "");
  assert.equal(result.sessions[0].sessionToken, "session-cookie-token");
  assert.equal(result.sessions[0].refreshOnly, true);
});

test("sessionToken-only entries refresh but do not enter the redemption account queue", () => {
  const sessionResult = normalizeSessionText("refresh@example.com---session-cookie-token");
  const merged = mergeAccountSources(sessionResult);

  assert.equal(sessionResult.sessionCount, 1);
  assert.equal(merged.accountCount, 0);
  assert.deepEqual(merged.sourceCounts, { account: 0, session: 0 });
});

test("updateSessionSourceCredentials rotates an email-sessionToken line", () => {
  const updated = updateSessionSourceCredentials(
    "refresh@example.com---old-session",
    { accessToken: "new-at", sessionToken: "new-session" }
  );

  assert.equal(updated, "refresh@example.com---new-session");
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
  assert.deepEqual(merged.sourceCounts, { account: 0, session: 1 });
});
