import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoCycleReservedAccessTokens,
  buildAutoCycleReservedEmails,
  isAutoCycleFailureCandidate,
  reserveAutoCycleReplacementAccessToken,
  reserveAutoCycleReplacementEmail,
  shouldReleaseCdkeyForNextAccount
} from "../src/hooks/useAutoCycle.js";

test("retryable failed row is an auto-cycle candidate", () => {
  assert.equal(
    isAutoCycleFailureCandidate({ status: "failed", can_retry: true, can_reuse_token: true }),
    true
  );
});

test("pm_unavailable is not a normal auto-cycle candidate", () => {
  assert.equal(
    isAutoCycleFailureCandidate({ status: "pm_unavailable", can_retry: true }),
    false
  );
});

test("daily limit failure releases CDK for next account", () => {
  assert.equal(
    shouldReleaseCdkeyForNextAccount({
      status: "failed",
      reason: "该邮箱今日提交次数已达上限（3 次），请 24 小时后再试"
    }),
    true
  );
});

test("auto-cycle reserves active and successful emails as replacement targets", () => {
  const reserved = buildAutoCycleReservedEmails(
    [
      { email: "Done@Example.com", status: "success", statusOwner: true },
      { email: "Running@Example.com", status: "running", statusOwner: true },
      { email: "History@Example.com", status: "success", statusOwner: false },
      { email: "Cancelled@Example.com", status: "cancelled", statusOwner: true }
    ],
    [{ email: "Failed@Example.com", status: "failed" }]
  );

  assert.equal(reserved.has("done@example.com"), true);
  assert.equal(reserved.has("running@example.com"), true);
  assert.equal(reserved.has("failed@example.com"), true);
  assert.equal(reserved.has("history@example.com"), false);
  assert.equal(reserved.has("cancelled@example.com"), false);
});

test("auto-cycle reserves a selected replacement immediately", () => {
  const reserved = buildAutoCycleReservedEmails([], [{ email: "failed@example.com" }]);
  const queue = [
    { email: "first@example.com" },
    { email: "second@example.com" }
  ];
  const pickNext = () =>
    queue.find((account) => !reserved.has(String(account.email || "").trim().toLowerCase()));

  const first = pickNext();
  reserveAutoCycleReplacementEmail(reserved, first);
  const second = pickNext();

  assert.equal(first.email, "first@example.com");
  assert.equal(second.email, "second@example.com");
});

test("auto-cycle reserves active and selected access tokens", () => {
  const reserved = buildAutoCycleReservedAccessTokens(
    [
      { email: "done@example.com", accessToken: "done-token", status: "success", statusOwner: true },
      { email: "history@example.com", accessToken: "history-token", status: "success", statusOwner: false }
    ],
    [{ email: "failed@example.com", accessToken: "failed-token", status: "failed" }]
  );

  reserveAutoCycleReplacementAccessToken(reserved, { accessToken: "selected-token" });

  assert.equal(reserved.has("done-token"), true);
  assert.equal(reserved.has("failed-token"), true);
  assert.equal(reserved.has("selected-token"), true);
  assert.equal(reserved.has("history-token"), false);
});
