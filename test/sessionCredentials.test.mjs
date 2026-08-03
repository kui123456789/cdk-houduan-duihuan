import test from "node:test";
import assert from "node:assert/strict";
import {
  isReleaseVerifiedAccount,
  refreshSessionCredentialAccounts
} from "../src/domain/sessionCredentials.js";

function sessionAccount(email, sessionToken) {
  return {
    lineNumber: 1,
    email,
    credentialKind: "session_token",
    credentialValue: sessionToken,
    sessionToken,
    sourceType: "session",
    source: `${email}---pw---2fa---https://mail.example/${email}---${sessionToken}---2026-08-01 12:00:00`,
    inputFormat: "email_password_2fa_pickup_url_session_timestamp"
  };
}

test("pre-submit refresh keeps AT rows and refreshes Session rows", async () => {
  const calls = [];
  const result = await refreshSessionCredentialAccounts([
    {
      email: "at@example.com",
      credentialKind: "access_token",
      accessToken: "existing-at",
      credentialValue: "existing-at"
    },
    sessionAccount("session@example.com", "old-session")
  ], {
    refreshSession: async (sessionToken) => {
      calls.push(sessionToken);
      return {
        accessToken: "fresh-at",
        sessionToken: "rotated-session",
        session_rotated: true,
        email: "session@example.com"
      };
    }
  });

  assert.deepEqual(calls, ["old-session"]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].accessToken, "existing-at");
  assert.equal(result.accounts[1].accessToken, "fresh-at");
  assert.equal(result.accounts[1].sessionToken, "rotated-session");
  assert.deepEqual(result.accounts[1].session, {
    user: { email: "session@example.com" },
    accessToken: "fresh-at",
    access_token: "fresh-at",
    sessionToken: "rotated-session"
  });
  assert.equal(result.accounts[1].sessionRefreshStage, "pre_submit");
  assert.match(result.accounts[1].source, /---rotated-session---2026-08-01 12:00:00$/);
});

test("refresh can mark a Session credential as post-success evidence", async () => {
  const result = await refreshSessionCredentialAccounts([
    sessionAccount("finished@example.com", "session-before-success")
  ], {
    stage: "post_success",
    refreshSession: async () => ({
      accessToken: "at-after-success",
      email: "finished@example.com"
    })
  });

  assert.equal(result.accounts[0].refreshedAccessToken, "at-after-success");
  assert.equal(result.accounts[0].sessionRefreshStage, "post_success");
  assert.match(result.accounts[0].sessionRefreshReason, /兑换成功后/);
});

test("failed or mismatched Session refreshes are excluded before CDK pairing", async () => {
  const result = await refreshSessionCredentialAccounts([
    sessionAccount("good@example.com", "good-session"),
    sessionAccount("failed@example.com", "failed-session"),
    sessionAccount("mismatch@example.com", "mismatch-session")
  ], {
    refreshSession: async (sessionToken) => {
      if (sessionToken === "failed-session") throw new Error("refresh unavailable");
      return {
        accessToken: `${sessionToken}-at`,
        email: sessionToken === "mismatch-session" ? "other@example.com" : "good@example.com"
      };
    }
  });

  assert.deepEqual(result.accounts.map((account) => account.email), ["good@example.com"]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].reason, /refresh unavailable/);
  assert.match(result.errors[1].reason, /邮箱不一致/);
});

test("release eligibility follows AT email-only and Session double-verification rules", () => {
  const base = {
    status: "success",
    email: "verified@example.com",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    pickupUrl: "https://mail.example/verified",
    emailPlusVerified: true,
    emailBanned: false
  };
  assert.equal(isReleaseVerifiedAccount({ ...base, credentialKind: "access_token" }), true);
  assert.equal(
    isReleaseVerifiedAccount({
      ...base,
      credentialKind: "session_token",
      sessionToken: "session",
      sessionRefreshStatus: "success",
      isPlus: true
    }),
    true
  );
  assert.equal(
    isReleaseVerifiedAccount({
      ...base,
      credentialKind: "session_token",
      sessionToken: "session",
      sessionRefreshStatus: "success",
      isPlus: false
    }),
    true
  );
  assert.equal(isReleaseVerifiedAccount({ ...base, credentialKind: "access_token", emailBanned: true }), false);
});

test("release eligibility uses Plus subscription when pickup URL is absent", () => {
  const base = {
    status: "success",
    email: "no-mailbox@example.com",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    pickupUrl: "",
    subscriptionStatus: "plus",
    isPlus: true,
    emailPlusVerified: false,
    emailBanned: false
  };
  assert.equal(isReleaseVerifiedAccount({ ...base, credentialKind: "access_token" }), true);
  assert.equal(isReleaseVerifiedAccount({
    ...base,
    credentialKind: "session_token",
    sessionToken: "session",
    sessionRefreshStatus: "success"
  }), true);
  assert.equal(isReleaseVerifiedAccount({
    ...base,
    credentialKind: "session_token",
    sessionToken: "session",
    sessionRefreshStatus: "error"
  }), false);
  assert.equal(isReleaseVerifiedAccount({ ...base, subscriptionStatus: "not_plus", isPlus: false }), false);
});

test("release eligibility requires a backend redemption timestamp", () => {
  assert.equal(isReleaseVerifiedAccount({
    status: "success",
    email: "missing-time@example.com",
    pickupUrl: "https://mail.example/missing-time",
    credentialKind: "access_token",
    emailPlusVerified: true
  }), false);
});
