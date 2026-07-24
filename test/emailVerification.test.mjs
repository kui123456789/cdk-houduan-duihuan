import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeEmailPlusContent,
  getEmailVerificationLabel,
  isSafeMailboxUrl,
  normalizeEmailVerificationResult
} from "../src/domain/emailVerification.js";

const plusEmailHtml = `
  <main>
    <h1>OpenAI</h1>
    <p>You've successfully subscribed to ChatGPT Plus.</p>
    <strong>Order number:</strong> sub_1TwIIYC6h1nxGoI3s3ER6z2T
    <strong>Order date:</strong> Jul 23, 2026
    <div>ChatGPT Plus Subscription</div>
  </main>
`;

const bannedEmailHtml = `
  <main>
    <h1>OpenAI</h1>
    <p>We're writing with an important update about your ChatGPT account.</p>
    <p>Your account has been banned because recent activity violated our Terms and Usage Policies.</p>
    <p>This means your account can no longer be used.</p>
  </main>
`;

test("analyzeEmailPlusContent recognizes the OpenAI Plus confirmation shown in the mailbox", () => {
  const diagnostic = analyzeEmailPlusContent(plusEmailHtml, {
    httpStatus: 200,
    redeemedAt: "2026-07-23T10:00:00Z",
    checkedAt: "2026-07-23T10:01:00Z"
  });

  assert.equal(diagnostic.category, "verified");
  assert.equal(diagnostic.orderNumber, "sub_1TwIIYC6h1nxGoI3s3ER6z2T");
  assert.equal(diagnostic.orderDate, "Jul 23, 2026");
});

test("analyzeEmailPlusContent reads nested JSON mailbox responses", () => {
  const diagnostic = analyzeEmailPlusContent({
    messages: [{ subject: "OpenAI", html: plusEmailHtml }]
  });
  assert.equal(diagnostic.category, "verified");
});

test("analyzeEmailPlusContent recognizes the fixed OpenAI account ban notice", () => {
  const diagnostic = analyzeEmailPlusContent(bannedEmailHtml, {
    httpStatus: 200,
    checkedAt: "2026-07-23T10:01:00Z"
  });

  assert.equal(diagnostic.category, "banned");
  assert.match(diagnostic.matchedPhrase, /account/);
});

test("account ban notices take priority over Plus confirmation text", () => {
  const diagnostic = analyzeEmailPlusContent(`${plusEmailHtml}${bannedEmailHtml}`);
  assert.equal(diagnostic.category, "banned");
});

test("analyzeEmailPlusContent rejects unrelated mail but accepts an existing Plus confirmation", () => {
  assert.equal(analyzeEmailPlusContent("Your verification code is 123456").category, "not_found");
  assert.equal(
    analyzeEmailPlusContent(plusEmailHtml, { redeemedAt: "2026-07-24T01:00:00Z" }).category,
    "verified"
  );
});

test("mailbox URLs reject local and private network targets", () => {
  assert.ok(isSafeMailboxUrl("https://mail.example.com/inbox/code"));
  assert.equal(isSafeMailboxUrl("http://127.0.0.1:8080/private"), false);
  assert.equal(isSafeMailboxUrl("http://192.168.1.5/inbox"), false);
  assert.equal(isSafeMailboxUrl("http://[::1]/private"), false);
  assert.equal(isSafeMailboxUrl("https://1.1.1.1/inbox"), false);
  assert.equal(isSafeMailboxUrl("file:///etc/passwd"), false);
});

test("normalizeEmailVerificationResult exposes verified export evidence", () => {
  const state = normalizeEmailVerificationResult({ diagnostic: { category: "verified" } });
  assert.equal(state.emailVerificationStatus, "verified");
  assert.equal(state.emailPlusVerified, true);
  assert.equal(getEmailVerificationLabel({ status: "success", ...state }), "邮箱已验证");
});

test("normalizeEmailVerificationResult exposes banned account evidence", () => {
  const state = normalizeEmailVerificationResult({ diagnostic: { category: "banned" } });
  assert.equal(state.emailVerificationStatus, "banned");
  assert.equal(state.emailPlusVerified, false);
  assert.equal(state.emailBanned, true);
  assert.equal(getEmailVerificationLabel({ status: "success", ...state }), "账号已封禁");
});
