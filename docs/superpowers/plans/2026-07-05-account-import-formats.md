# Account Import Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the website account input to import all supported AT account formats: legacy five-part accounts, email + mailbox pickup URL + AT, and email + AT, with timestamp optional where source data does not provide it.

**Architecture:** Keep the change centered in the existing account parsing boundary so upload, paste, cleanup, dedupe, queue planning, cooldown accounting, and auto-cycle all receive the same normalized account objects. UI changes only update the account input instructions and placeholder examples. No backend API shape changes are needed because submit still sends `cdkey`, `access_token`, and `channel`.

**Tech Stack:** Vite, React 18, Node test runner, current domain parser in `src/domain/accountParsing.js`.

---

## File Structure

- Modify `src/domain/accountParsing.js`
  - Extend `parseAccountLine` to accept:
    - `邮箱---密码---2fa---at---时间戳`
    - `邮箱---邮箱取件码地址---at---时间戳`
    - `邮箱---邮箱取件码地址---at`
    - `邮箱---at---时间戳`
    - `邮箱---at`
  - Preserve email and AT dedupe behavior.
  - Add `pickupUrl` and `inputFormat` fields to parsed account objects.
  - Keep `password` and `twofa` empty for formats that do not provide them.
  - Generate `exportLine` by preserving the original non-AT fields and removing only the AT segment.
- Modify `src/domain/exportFormatting.js`
  - Prefer `row.exportLine` for success exports so every supported import format exports as “原格式去掉 AT”.
- Modify `src/config/redeemConstants.js`
  - Update `SAMPLE_ACCOUNT` to show all accepted formats.
- Modify `src/components/prep/PrepWorkspace.jsx`
  - Update account input subtitle so users can see the new formats.
- Modify `test/accountParsing.test.mjs`
  - Add parser coverage for all new formats and invalid cases.
- Create `test/exportFormatting.test.mjs`
  - Add success export coverage for “only remove AT” behavior.

## Task 1: Add Parser Tests For New Account Formats

**Files:**
- Modify: `test/accountParsing.test.mjs`

- [ ] **Step 1: Add failing tests**

Append these tests to `test/accountParsing.test.mjs`:

```javascript
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
      inputFormat: result.accounts[0].inputFormat
    },
    {
      email: "url@example.com",
      pickupUrl: "https://mail.example/inbox/code-123",
      accessToken: "eyJ.header.payload",
      timestamp: "2026-07-05T03:31:25Z",
      password: "",
      twofa: "",
      inputFormat: "email_pickup_url_at_timestamp"
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
```

- [ ] **Step 2: Run parser tests and confirm failure**

Run:

```powershell
npm test -- test/accountParsing.test.mjs
```

Expected: new tests fail because `parseAccountLine` currently only accepts 5 segments.

## Task 2: Implement Multi-Format Account Parsing

**Files:**
- Modify: `src/domain/accountParsing.js`

- [ ] **Step 1: Replace `parseAccountLine` with deterministic format parsing**

In `src/domain/accountParsing.js`, replace the existing `parseAccountLine` function with this implementation and add the helper functions before it:

```javascript
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isLikelyPickupUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) || /^mailto:/i.test(text);
}

function createAccount({
  lineNumber,
  source,
  email,
  password = "",
  twofa = "",
  pickupUrl = "",
  accessToken,
  timestamp = "",
  inputFormat
}) {
  return {
    lineNumber,
    source,
    email,
    password,
    twofa,
    pickupUrl,
    accessToken,
    timestamp,
    inputFormat,
    exportLine: password && twofa && timestamp ? [email, password, twofa, timestamp].join(DELIMITER) : ""
  };
}

function buildFormatError(lineNumber, source, reason) {
  return {
    error: {
      lineNumber,
      source,
      reason
    }
  };
}

function validateRequiredParts(lineNumber, source, parts, labels) {
  const emptyIndex = parts.findIndex((part) => !part);
  if (emptyIndex === -1) return null;
  return buildFormatError(lineNumber, source, `${labels[emptyIndex] || `第 ${emptyIndex + 1} 段`}不能为空`);
}

function validateEmailPart(lineNumber, source, email) {
  if (isValidEmail(email)) return null;
  return buildFormatError(lineNumber, source, "第 1 段必须是邮箱");
}

function parseAccountLine(source, lineNumber) {
  const parts = source.split(DELIMITER).map((part) => part.trim());
  const email = parts[0] || "";
  const emailError = validateEmailPart(lineNumber, source, email);

  if (![2, 3, 4, 5].includes(parts.length)) {
    return buildFormatError(
      lineNumber,
      source,
      `支持格式：邮箱---密码---2fa---at---时间戳；邮箱---邮箱取件码地址---at---时间戳；邮箱---邮箱取件码地址---at；邮箱---at---时间戳；邮箱---at。当前 ${parts.length} 段`
    );
  }

  if (emailError) return emailError;

  if (parts.length === 5) {
    const emptyError = validateRequiredParts(lineNumber, source, parts, [
      "邮箱",
      "密码",
      "2fa",
      "at",
      "时间戳"
    ]);
    if (emptyError) return emptyError;

    const [emailValue, password, twofa, accessToken, timestamp] = parts;
    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        password,
        twofa,
        accessToken,
        timestamp,
        inputFormat: "legacy_5"
      })
    };
  }

  if (parts.length === 4) {
    const [emailValue, pickupUrl, accessToken, timestamp] = parts;
    const emptyError = validateRequiredParts(lineNumber, source, [emailValue, pickupUrl, accessToken], [
      "邮箱",
      "邮箱取件码地址",
      "at"
    ]);
    if (emptyError) return emptyError;
    if (!isLikelyPickupUrl(pickupUrl)) {
      return buildFormatError(lineNumber, source, "第 2 段必须是邮箱取件码地址");
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        pickupUrl,
        accessToken,
        timestamp,
        inputFormat: "email_pickup_url_at_timestamp"
      })
    };
  }

  if (parts.length === 3) {
    const [emailValue, second, third] = parts;
    const emptyError = validateRequiredParts(lineNumber, source, [emailValue, second, third], [
      "邮箱",
      "第 2 段",
      "第 3 段"
    ]);
    if (emptyError) return emptyError;

    if (isLikelyPickupUrl(second)) {
      return {
        account: createAccount({
          lineNumber,
          source,
          email: emailValue,
          pickupUrl: second,
          accessToken: third,
          inputFormat: "email_pickup_url_at"
        })
      };
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        accessToken: second,
        timestamp: third,
        inputFormat: "email_at_timestamp"
      })
    };
  }

  const [emailValue, accessToken] = parts;
  const emptyError = validateRequiredParts(lineNumber, source, [emailValue, accessToken], [
    "邮箱",
    "at"
  ]);
  if (emptyError) return emptyError;

  return {
    account: createAccount({
      lineNumber,
      source,
      email: emailValue,
      accessToken,
      inputFormat: "email_at"
    })
  };
}
```

- [ ] **Step 2: Run parser tests**

Run:

```powershell
npm test -- test/accountParsing.test.mjs
```

Expected: all account parsing tests pass.

- [ ] **Step 3: Run downstream parser-dependent tests**

Run:

```powershell
npm test -- test/redeemWorkflowSubmit.test.mjs test/autoCycleQueue.test.mjs test/workflowCommands.test.mjs
```

Expected: all selected tests pass, proving the queue planner still receives unique emails and unique AT values.

## Task 3: Update Account Input Instructions

**Files:**
- Modify: `src/config/redeemConstants.js`
- Modify: `src/components/prep/PrepWorkspace.jsx`

- [ ] **Step 1: Update account placeholder examples**

In `src/config/redeemConstants.js`, replace `SAMPLE_ACCOUNT` with:

```javascript
export const SAMPLE_ACCOUNT = [
  "mail@example.com---password---2fa---at---2026-07-03 15:43:17",
  "mail@example.com---https://mail.example/inbox/code---at---2026-07-03 15:43:17",
  "mail@example.com---https://mail.example/inbox/code---at",
  "mail@example.com---at---2026-07-03 15:43:17",
  "mail@example.com---at"
].join("\n");
```

- [ ] **Step 2: Update visible subtitle**

In `src/components/prep/PrepWorkspace.jsx`, change the account input `subtitle` from:

```jsx
subtitle="格式：邮箱---密码---2fa---at---时间戳"
```

to:

```jsx
subtitle="支持：邮箱---密码---2fa---at---时间戳；邮箱---邮箱取件码地址---at；邮箱---at，时间戳可省略"
```

- [ ] **Step 3: Run build-facing tests**

Run:

```powershell
npm run build
```

Expected: Vite build succeeds and the account input card renders with the new subtitle and placeholder.

## Task 4: Full Verification And Review

**Files:**
- Review: `src/domain/accountParsing.js`
- Review: `src/config/redeemConstants.js`
- Review: `src/components/prep/PrepWorkspace.jsx`
- Review: `test/accountParsing.test.mjs`

- [ ] **Step 1: Run the full test suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Check whitespace and accidental secret exposure**

Run:

```powershell
git diff --check
rg -n "eyJhbGci|ext_redeem_|sk-[A-Za-z0-9]" src test docs
```

Expected:
- `git diff --check` has no new whitespace errors.
- `rg` only finds test/example placeholders, not real user AT tokens or real API keys.

- [ ] **Step 4: Manual local browser validation**

Run the local app:

```powershell
npm run dev
```

Then verify in the local browser:
- Paste one line of `邮箱---邮箱取件码地址---at---时间戳`; account count increases and no format error appears.
- Paste one line of `邮箱---邮箱取件码地址---at`; account count increases and timestamp stays optional.
- Paste one line of `邮箱---at`; account count increases and no format error appears.
- Paste two different emails with the same AT; the second line is rejected as `AT 重复`.
- Start兑换 with a supported short-format account; request body still sends the AT as `access_token`.

## Self-Review

- Spec coverage: The plan covers both requested formats and makes timestamp optional for URL and email+AT inputs.
- Parser boundary: All import paths use `normalizeAccountText` / `parseAccounts`, so upload, paste, cleanup, and queue planning get the same behavior.
- Export safety: Success export uses `exportLine`, which keeps the imported non-AT fields and removes only the AT segment.
- No backend changes: Backend submit payload remains `{ cdkey, access_token, channel }`.
- Deployment boundary: This plan does not include GitHub push or Hong Kong deployment; those should only happen after explicit instruction.
