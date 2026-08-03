import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldApplySubscriptionResultToRow,
  shouldCheckSubscriptionRow,
  shouldAllowManualPlusRecheck,
  shouldQueueSubscriptionCheck,
  getSubscriptionAccessToken,
  useSubscriptionChecks
} from "../src/hooks/useSubscriptionChecks.js";
import { isReleaseVerifiedAccount } from "../src/domain/sessionCredentials.js";

function createAccessToken(email) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ email })}.`;
}

function asSession(row) {
  return {
    credentialKind: "session_token",
    sessionToken: `session-${row?.id || "row"}`,
    sessionRefreshStatus: "success",
    sessionRefreshStage: "post_success",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    ...row
  };
}

test("only successful Session rows with refreshed AT are subscription-check candidates", () => {
  const isHistoricalRow = (row) => row?.historical === true;

  assert.equal(shouldCheckSubscriptionRow(asSession({ status: "success", accessToken: "at" })), true);
  assert.equal(
    shouldCheckSubscriptionRow(asSession({
      status: "success",
      accessToken: "at",
      subscriptionStatus: "checking"
    })),
    true
  );
  assert.equal(shouldCheckSubscriptionRow(asSession({ status: "failed", accessToken: "at" })), false);
  assert.equal(shouldCheckSubscriptionRow(asSession({ status: "success", accessToken: "" })), false);
  assert.equal(shouldCheckSubscriptionRow({ status: "success", accessToken: "at", credentialKind: "access_token", pickupUrl: "https://mail.example" }), false);
  assert.equal(shouldCheckSubscriptionRow({ status: "success", accessToken: "at", credentialKind: "access_token", pickupUrl: "" }), true);
  assert.equal(
    shouldCheckSubscriptionRow(
      asSession({ status: "success", accessToken: "at", historical: true }),
      { isHistoricalRow }
    ),
    false
  );
});

test("manual verification is allowed for successful Session and AT rows", () => {
  const checkingRow = asSession({
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  });

  assert.equal(shouldAllowManualPlusRecheck({ status: "success", email: "at@example.com", pickupUrl: "https://mail.example" }), true);
  assert.equal(shouldAllowManualPlusRecheck({ status: "success", email: "at@example.com", accessToken: "at" }), true);
  assert.equal(shouldAllowManualPlusRecheck(checkingRow), true);
  assert.equal(shouldAllowManualPlusRecheck({ status: "success", accessToken: "" }), false);
});

test("checking subscription rows are not queued automatically unless forced", () => {
  const checkingRow = asSession({
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  });

  assert.equal(shouldQueueSubscriptionCheck(asSession({ status: "success", accessToken: "at" })), true);
  assert.equal(shouldQueueSubscriptionCheck(checkingRow), false);
  assert.equal(shouldQueueSubscriptionCheck(checkingRow, { force: true }), true);
  assert.equal(
    shouldQueueSubscriptionCheck(asSession({ status: "failed", accessToken: "at" }), { force: true }),
    false
  );
});

test("subscription results apply only to successful rows with a matching token", () => {
  const checkedTokens = new Set(["shared"]);

  assert.equal(
    shouldApplySubscriptionResultToRow(asSession({ status: "success", accessToken: "shared" }), checkedTokens),
    true
  );
  assert.equal(
    shouldApplySubscriptionResultToRow(asSession({ status: "failed", accessToken: "shared" }), checkedTokens),
    false
  );
  assert.equal(
    shouldApplySubscriptionResultToRow(asSession({ status: "cancelled", accessToken: "shared" }), checkedTokens),
    false
  );
  assert.equal(
    shouldApplySubscriptionResultToRow(asSession({ status: "success", accessToken: "other" }), checkedTokens),
    false
  );
});

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSubscriptionChecker(checkSubscription, options = {}) {
  const rowsRef = { current: options.initialRows || [] };
  const committedRows = [];
  const checker = useSubscriptionChecks({
    redeemApiRef: {
      current: {
        checkSubscription,
        refreshSession: options.refreshSession || (async () => ({ accessToken: "at" })),
        checkPlusEmail: options.checkPlusEmail
      }
    },
    subscriptionCacheRef: { current: new Map() },
    emailVerificationCacheRef: { current: new Map() },
    rowsRef,
    setRows: (nextRows) => committedRows.push(nextRows),
    setStatusMessage: () => {},
    isHistoricalRow: options.isHistoricalRow,
    verificationRetryDelays: options.verificationRetryDelays,
    sleep: options.sleep,
    onSessionCredentialUpdated: options.onSessionCredentialUpdated
  });

  return { ...checker, committedRows, rowsRef };
}

test("a Plus row becomes exportable only after its mailbox contains the confirmation email", async () => {
  const mailboxCalls = [];
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async () => ({ ok: true, plan_type: "plus", has_active_subscription: true }),
    {
      checkPlusEmail: async (pickupUrl, redeemedAt) => {
        mailboxCalls.push({ pickupUrl, redeemedAt });
        return { diagnostic: { category: "verified", orderNumber: "sub_verified" } };
      }
    }
  );
  const checkedRows = await checkSubscriptionsForRows([
    asSession({
      id: "success",
      status: "success",
      accessToken: "at",
      pickupUrl: "https://mail.example.com/inbox/code",
      redemptionTimestamp: "2026-07-23T09:00:00Z"
    })
  ], { silent: true });

  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].emailVerificationStatus, "verified");
  assert.equal(checkedRows[0].emailPlusVerified, true);
  assert.deepEqual(mailboxCalls, [{
    pickupUrl: "https://mail.example.com/inbox/code",
    redeemedAt: "2026-07-23T09:00:00Z"
  }]);
});

test("refreshed AT is preferred for real-time subscription checks", async () => {
  const checkedTokens = [];
  const { checkSubscriptionsForRows } = createSubscriptionChecker(async (token) => {
    checkedTokens.push(token);
    return { ok: true, plan_type: "plus", has_active_subscription: true };
  });
  const row = asSession({
    id: "refreshed",
    status: "success",
    accessToken: "expired-at",
    refreshedAccessToken: "new-at"
  });

  assert.equal(getSubscriptionAccessToken(row), "new-at");
  const checkedRows = await checkSubscriptionsForRows([row], { silent: true });
  assert.deepEqual(checkedTokens, ["new-at"]);
  assert.equal(checkedRows[0].subscriptionStatus, "plus");
});

test("a Session Plus row without a pickup URL skips email and becomes exportable", async () => {
  const { checkSubscriptionsForRows } = createSubscriptionChecker(async () => ({
    ok: true,
    plan_type: "plus",
    has_active_subscription: true
  }));
  const checkedRows = await checkSubscriptionsForRows([
    asSession({
      id: "missing-mailbox",
      status: "success",
      email: "missing-mailbox@example.com",
      accessToken: "at"
    })
  ], { silent: true });

  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].emailVerificationStatus, "skipped");
  assert.equal(checkedRows[0].emailPlusVerified, false);
  assert.equal(isReleaseVerifiedAccount(checkedRows[0]), true);
});

test("an AT row without a pickup URL checks subscription and exports only when Plus", async () => {
  const checkedTokens = [];
  let emailCalls = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async (token) => {
      checkedTokens.push(token);
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    { checkPlusEmail: async () => { emailCalls += 1; return { diagnostic: { category: "verified" } }; } }
  );
  const checkedRows = await checkSubscriptionsForRows([{
    id: "at-no-mailbox",
    status: "success",
    email: "at-no-mailbox@example.com",
    accessToken: "at-no-mailbox",
    credentialKind: "access_token",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    pickupUrl: ""
  }], { silent: true });

  assert.deepEqual(checkedTokens, ["at-no-mailbox"]);
  assert.equal(emailCalls, 0);
  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].emailVerificationStatus, "skipped");
  assert.equal(isReleaseVerifiedAccount(checkedRows[0]), true);
});

test("an AT row without a pickup URL remains blocked when subscription is not Plus", async () => {
  const { checkSubscriptionsForRows } = createSubscriptionChecker(async () => ({
    ok: true,
    plan_type: "free",
    has_active_subscription: false
  }));
  const checkedRows = await checkSubscriptionsForRows([{
    id: "at-free-no-mailbox",
    status: "success",
    email: "at-free@example.com",
    accessToken: "at-free",
    credentialKind: "access_token",
    pickupUrl: ""
  }], { silent: true, autoRetry: false });

  assert.equal(checkedRows[0].subscriptionStatus, "not_plus");
  assert.equal(isReleaseVerifiedAccount(checkedRows[0]), false);
});

test("adding a pickup URL switches an AT row back to email-only verification", async () => {
  let subscriptionCalls = 0;
  let emailCalls = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async () => {
      subscriptionCalls += 1;
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    {
      checkPlusEmail: async () => {
        emailCalls += 1;
        return { diagnostic: { category: "verified" } };
      }
    }
  );
  const initial = await checkSubscriptionsForRows([{
    id: "at-route-switch",
    status: "success",
    email: "route-switch@example.com",
    accessToken: "route-switch-at",
    credentialKind: "access_token",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    pickupUrl: ""
  }], { silent: true });
  const switched = await checkSubscriptionsForRows([{
    ...initial[0],
    pickupUrl: "https://mail.example/route-switch"
  }], { silent: true });

  assert.equal(subscriptionCalls, 1);
  assert.equal(emailCalls, 1);
  assert.equal(switched[0].subscriptionStatus, "skipped");
  assert.equal(switched[0].emailVerificationStatus, "verified");
  assert.equal(isReleaseVerifiedAccount(switched[0]), true);
});

test("AT verification recovers a pickup URL and skips subscription checking", async () => {
  const mailboxCalls = [];
  let subscriptionCalls = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async () => {
      subscriptionCalls += 1;
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    {
      checkPlusEmail: async (pickupUrl) => {
        mailboxCalls.push(pickupUrl);
        return { diagnostic: { category: "verified", orderNumber: "sub_export_line" } };
      }
    }
  );

  const checkedRows = await checkSubscriptionsForRows([{
    id: "export-line-mailbox",
    status: "success",
    email: "bongo.yard4a@icloud.com",
    source: "bongo.yard4a@icloud.com",
    exportLine: "bongo.yard4a@icloud.com---password---2fa---https://mail.example/show/export-line---2026-07-27T16:31:25.813",
    accessToken: "at",
    credentialKind: "access_token",
    pickupUrl: ""
  }], { silent: true });

  assert.equal(checkedRows[0].pickupUrl, "https://mail.example/show/export-line");
  assert.equal(checkedRows[0].subscriptionStatus, "skipped");
  assert.equal(checkedRows[0].emailVerificationStatus, "verified");
  assert.equal(subscriptionCalls, 0);
  assert.deepEqual(mailboxCalls, ["https://mail.example/show/export-line"]);
});

test("AT rows never use historical AT subscription attribution", async () => {
  const checkedTokens = [];
  const rows = [{
    id: "current-row",
    cdkey: "CDK-NO-ATTRIBUTION",
    email: "current@example.com",
    accessToken: createAccessToken("current@example.com"),
    credentialKind: "access_token",
    pickupUrl: "https://mail.example/current",
    status: "success"
  }];
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async (token) => {
      checkedTokens.push(token);
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    { checkPlusEmail: async () => ({ diagnostic: { category: "verified" } }) }
  );

  const checkedRows = await checkSubscriptionsForRows(rows, { silent: true });
  assert.deepEqual(checkedTokens, []);
  assert.equal(checkedRows[0].subscriptionStatus, "skipped");
  assert.equal(checkedRows[0].historicalAttributionEmail, undefined);
});

test("successful Session rows refresh AT before subscription and require the Plus email", async () => {
  const checkedTokens = [];
  const rotated = [];
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async (token) => {
      checkedTokens.push(token);
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    {
      refreshSession: async () => ({
        accessToken: "fresh-at",
        sessionToken: "rotated-session",
        session_rotated: true,
        email: "session@example.com"
      }),
      checkPlusEmail: async () => ({ diagnostic: { category: "verified" } }),
      onSessionCredentialUpdated: (_row, result) => rotated.push(result.sessionToken)
    }
  );
  const checkedRows = await checkSubscriptionsForRows([{
    id: "session-success",
    status: "success",
    email: "session@example.com",
    pickupUrl: "https://mail.example/session",
    credentialKind: "session_token",
    sessionToken: "old-session",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    sessionRefreshStatus: "idle"
  }], { silent: true });

  assert.deepEqual(checkedTokens, ["fresh-at"]);
  assert.deepEqual(rotated, ["rotated-session"]);
  assert.equal(checkedRows[0].sessionRefreshStatus, "success");
  assert.equal(checkedRows[0].sessionRefreshStage, "post_success");
  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].emailVerificationStatus, "verified");
  assert.equal(isReleaseVerifiedAccount(checkedRows[0]), true);
});

test("verified Plus email overrides a stale free plan and rejected fresh AT", async () => {
  const checkedTokens = [];
  let emailChecks = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async (token) => {
      checkedTokens.push(token);
      return {
        ok: false,
        category: "token_invalid",
        title: "Token 失效",
        message: "Token 无效或已过期"
      };
    },
    {
      refreshSession: async () => ({
        accessToken: "fresh-but-unsupported-at",
        sessionToken: "rotated-session",
        session_rotated: true,
        email: "session-free@example.com",
        planType: "free"
      }),
      checkPlusEmail: async () => {
        emailChecks += 1;
        return {
          diagnostic: {
            category: "verified",
            title: "邮箱已验证",
            message: "已收到 ChatGPT Plus 开通成功邮件",
            orderDate: "Aug 02, 2026"
          }
        };
      }
    }
  );

  const checkedRows = await checkSubscriptionsForRows([{
    id: "session-free",
    status: "success",
    email: "session-free@example.com",
    pickupUrl: "https://mail.example/session-free",
    credentialKind: "session_token",
    sessionToken: "old-session",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    sessionRefreshStatus: "idle"
  }], { silent: true, autoRetry: false });

  assert.deepEqual(checkedTokens, ["fresh-but-unsupported-at"]);
  assert.equal(emailChecks, 1);
  assert.equal(checkedRows[0].sessionRefreshStatus, "success");
  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].subscriptionCategory, "plus");
  assert.equal(checkedRows[0].emailPlusVerified, true);
  assert.equal(checkedRows[0].isPlus, true);
  assert.match(checkedRows[0].subscriptionReason, /邮箱/);
  assert.equal(isReleaseVerifiedAccount(checkedRows[0]), true);
});

test("a pre-submit Session AT is refreshed again after redemption success", async () => {
  const refreshCalls = [];
  const checkedTokens = [];
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async (token) => {
      checkedTokens.push(token);
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    {
      refreshSession: async (sessionToken) => {
        refreshCalls.push(sessionToken);
        return {
          accessToken: "post-success-at",
          sessionToken: "post-success-session",
          email: "post-success@example.com"
        };
      },
      checkPlusEmail: async () => ({ diagnostic: { category: "verified" } })
    }
  );

  const checkedRows = await checkSubscriptionsForRows([{
    id: "post-success-refresh",
    status: "success",
    email: "post-success@example.com",
    pickupUrl: "https://mail.example/post-success",
    credentialKind: "session_token",
    sessionToken: "pre-submit-session",
    accessToken: "pre-submit-at",
    refreshedAccessToken: "pre-submit-at",
    sessionRefreshStatus: "success",
    sessionRefreshStage: "pre_submit"
  }], { silent: true });

  assert.deepEqual(refreshCalls, ["pre-submit-session"]);
  assert.deepEqual(checkedTokens, ["post-success-at"]);
  assert.equal(checkedRows[0].sessionRefreshStage, "post_success");
});

test("successful Session rows without pickup refresh AT and export from Plus subscription only", async () => {
  let emailCalls = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async () => ({ ok: true, plan_type: "plus", has_active_subscription: true }),
    {
      refreshSession: async () => ({
        accessToken: "fresh-no-mailbox-at",
        sessionToken: "rotated-no-mailbox-session",
        email: "session-no-mailbox@example.com"
      }),
      checkPlusEmail: async () => { emailCalls += 1; return { diagnostic: { category: "verified" } }; }
    }
  );
  const checkedRows = await checkSubscriptionsForRows([{
    id: "session-no-mailbox",
    status: "success",
    email: "session-no-mailbox@example.com",
    pickupUrl: "",
    credentialKind: "session_token",
    sessionToken: "old-no-mailbox-session",
    redemptionTimestamp: "2026-08-01T12:00:00Z",
    sessionRefreshStatus: "idle"
  }], { silent: true });

  assert.equal(emailCalls, 0);
  assert.equal(checkedRows[0].sessionRefreshStatus, "success");
  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].emailVerificationStatus, "skipped");
  assert.equal(isReleaseVerifiedAccount(checkedRows[0]), true);
});

test("Session verification stops retrying after delayed Plus email is verified", async () => {
  let subscriptionCalls = 0;
  let emailCalls = 0;
  const waits = [];
  const { checkSubscriptionsForRows } = createSubscriptionChecker(
    async () => {
      subscriptionCalls += 1;
      return subscriptionCalls === 1
        ? { ok: true, plan_type: "free", has_active_subscription: false }
        : { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    {
      checkPlusEmail: async () => {
        emailCalls += 1;
        return { diagnostic: { category: emailCalls === 1 ? "not_found" : "verified" } };
      },
      verificationRetryDelays: [15_000, 30_000],
      sleep: async (delay) => waits.push(delay)
    }
  );
  const checkedRows = await checkSubscriptionsForRows([
    asSession({
      id: "retry-session",
      status: "success",
      email: "retry@example.com",
      pickupUrl: "https://mail.example/retry",
      accessToken: "fresh-at"
    })
  ], { silent: true });

  assert.equal(subscriptionCalls, 2);
  assert.equal(emailCalls, 2);
  assert.deepEqual(waits, [15_000]);
  assert.equal(isReleaseVerifiedAccount(checkedRows[0]), true);
});

test("manual Plus recheck can force an in-flight success row", async () => {
  let callCount = 0;
  const checkingRow = asSession({
    id: "checking",
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  });
  const { canRecheckSubscriptionRow, recheckPlusRows, rowsRef } = createSubscriptionChecker(
    async () => {
      callCount += 1;
      return { ok: true, plan_type: "free", has_active_subscription: false };
    },
    { initialRows: [checkingRow] }
  );

  assert.equal(canRecheckSubscriptionRow(checkingRow), true);

  await recheckPlusRows([checkingRow]);

  assert.equal(callCount, 1);
  assert.equal(rowsRef.current[0].subscriptionStatus, "not_plus");
});

test("automatic checks skip in-flight rows but forced checks can requeue them", async () => {
  let callCount = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(async () => {
    callCount += 1;
    return { ok: true, plan_type: "free", has_active_subscription: false };
  });
  const checkingRow = asSession({
    id: "checking",
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  });

  const automaticRows = await checkSubscriptionsForRows([checkingRow], { silent: true });
  assert.equal(callCount, 0);
  assert.equal(automaticRows[0].subscriptionStatus, "checking");

  const forcedRows = await checkSubscriptionsForRows([checkingRow], {
    silent: true,
    forceTokens: ["at"]
  });
  assert.equal(callCount, 1);
  assert.equal(forcedRows[0].subscriptionStatus, "not_plus");
});

test("checked subscription results do not update non-success rows with the same token", async () => {
  let callCount = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(async () => {
    callCount += 1;
    return { ok: true, plan_type: "plus", has_active_subscription: true };
  });
  const rows = [
    asSession({ id: "success", status: "success", accessToken: "shared" }),
    {
      id: "failed",
      status: "failed",
      accessToken: "shared",
      subscriptionStatus: "failed_marker",
      subscriptionCategory: "kept",
      isPlus: false
    },
    { id: "cancelled", status: "cancelled", accessToken: "shared" }
  ];

  const checkedRows = await checkSubscriptionsForRows(rows, { silent: true });

  assert.equal(callCount, 1);
  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].isPlus, true);
  assert.equal(checkedRows[1].subscriptionStatus, "failed_marker");
  assert.equal(checkedRows[1].subscriptionCategory, "kept");
  assert.equal(checkedRows[1].isPlus, false);
  assert.equal(checkedRows[2].subscriptionStatus, undefined);
});

test("historical successful rows are not marked checking or updated", async () => {
  let callCount = 0;
  const isHistoricalRow = (row) => row?.historical === true;
  const { checkSubscriptionsForRows, committedRows } = createSubscriptionChecker(
    async () => {
      callCount += 1;
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    { isHistoricalRow }
  );
  const rows = [
    asSession({ id: "history", status: "success", accessToken: "shared", historical: true }),
    asSession({ id: "active", status: "success", accessToken: "shared" })
  ];

  const checkedRows = await checkSubscriptionsForRows(rows, { silent: true });

  assert.equal(callCount, 1);
  const checkingCommit = committedRows.find(
    (rowList) => rowList[1]?.subscriptionStatus === "checking"
  );
  assert.equal(checkingCommit[0].subscriptionStatus, undefined);
  assert.equal(checkingCommit[1].subscriptionStatus, "checking");
  assert.equal(checkedRows[0].subscriptionStatus, undefined);
  assert.equal(checkedRows[0].isPlus, undefined);
  assert.equal(checkedRows[1].subscriptionStatus, "plus");
  assert.equal(checkedRows[1].isPlus, true);
});

test("async subscription results do not revive rows cleared during the request", async () => {
  const requestDone = createDeferred();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const { checkSubscriptionsForRows, rowsRef } = createSubscriptionChecker(async () => {
    requestStarted();
    await requestDone.promise;
    return { ok: true, plan_type: "plus", has_active_subscription: true };
  });

  const checkPromise = checkSubscriptionsForRows(
    [asSession({ id: "success", status: "success", accessToken: "at" })],
    { silent: true }
  );
  await started;
  assert.equal(rowsRef.current[0].subscriptionStatus, "checking");

  rowsRef.current = [];
  requestDone.resolve();
  const checkedRows = await checkPromise;

  assert.deepEqual(checkedRows, []);
  assert.deepEqual(rowsRef.current, []);
});

test("async subscription results do not overwrite rows that became failed", async () => {
  const requestDone = createDeferred();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const { checkSubscriptionsForRows, rowsRef } = createSubscriptionChecker(async () => {
    requestStarted();
    await requestDone.promise;
    return { ok: true, plan_type: "plus", has_active_subscription: true };
  });

  const checkPromise = checkSubscriptionsForRows(
    [asSession({ id: "success", status: "success", accessToken: "at" })],
    { silent: true }
  );
  await started;
  rowsRef.current = [
    {
      id: "success",
      status: "failed",
      accessToken: "at",
      reason: "用户已清理或状态已变化"
    }
  ];

  requestDone.resolve();
  const checkedRows = await checkPromise;

  assert.equal(checkedRows[0].status, "failed");
  assert.equal(checkedRows[0].subscriptionStatus, undefined);
  assert.equal(checkedRows[0].isPlus, undefined);
});
