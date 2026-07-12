# Session Default API Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Session-sourced redemption tasks to use a server-side default API key when the user API Key field is empty, without allowing ordinary account tasks to use that credential.

**Architecture:** The server resolves either the user-provided key or a Session-only environment credential. The frontend preserves `sourceType`, groups work by credential mode, and sends `credentialMode: "session"` only for Session groups. Mixed empty-key input submits Session rows and leaves ordinary accounts unsubmitted with an explicit message.

**Tech Stack:** React 18, Vite 8, Node.js test runner, Express 5.

## Global Constraints

- Store the default credential only in `SESSION_REDEEM_API_KEY`; never include its value in frontend source, browser storage, responses, logs, tests, or build artifacts.
- A non-empty user API Key always overrides the Session default credential.
- Ordinary account tasks must still fail locally when the user API Key is empty.
- Apply the same credential routing to preflight, submit, status polling, cancel, retry, and auto-cycle submission.
- Preserve all unrelated working-tree changes and stage only task-scoped files.

---

### Task 1: Server-side Session credential resolver

**Files:**
- Modify: `server/app.js`
- Modify: `server/proxy.js`
- Test: `test/serverProxy.test.mjs`

**Interfaces:**
- Produces: `resolveRedeemApiKey({ apiKey, credentialMode, sessionDefaultApiKey }) -> string`
- Produces: proxy config property `sessionDefaultApiKey: string`

- [ ] **Step 1: Write failing resolver and route tests**

Add tests proving that a user key wins, Session mode can use an injected default, ordinary empty-key requests return 400, and missing Session server configuration returns a configuration error without exposing a key.

```javascript
assert.equal(
  resolveRedeemApiKey({ apiKey: "user-key", credentialMode: "session", sessionDefaultApiKey: "server-key" }),
  "user-key"
);
assert.equal(
  resolveRedeemApiKey({ apiKey: "", credentialMode: "session", sessionDefaultApiKey: "server-key" }),
  "server-key"
);
assert.throws(
  () => resolveRedeemApiKey({ apiKey: "", credentialMode: "", sessionDefaultApiKey: "server-key" }),
  /外部 API Key 不能为空/
);
assert.throws(
  () => resolveRedeemApiKey({ apiKey: "", credentialMode: "session", sessionDefaultApiKey: "" }),
  /服务器未配置 Session 默认兑换凭证/
);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/serverProxy.test.mjs`

Expected: FAIL because `resolveRedeemApiKey` does not exist and Session-mode requests are rejected.

- [ ] **Step 3: Implement the resolver and environment configuration**

Add a resolver in `server/proxy.js`:

```javascript
export function resolveRedeemApiKey({ apiKey, credentialMode, sessionDefaultApiKey }) {
  const userKey = String(apiKey || "").trim();
  if (userKey) return userKey;
  if (String(credentialMode || "").trim() !== "session") {
    throw userError("外部 API Key 不能为空");
  }
  const sessionKey = String(sessionDefaultApiKey || "").trim();
  if (!sessionKey) {
    const error = new Error("服务器未配置 Session 默认兑换凭证");
    error.status = 500;
    throw error;
  }
  return sessionKey;
}
```

Resolve the key once per proxy request, pass it into `forwardJson`, and add the environment value in `createApp`:

```javascript
const redeemConfig = {
  sessionDefaultApiKey: String(process.env.SESSION_REDEEM_API_KEY || "").trim(),
  ...config
};
```

Do not log the resolved key.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/serverProxy.test.mjs`

Expected: all server proxy tests PASS.

- [ ] **Step 5: Commit the server resolver**

```bash
git add server/app.js server/proxy.js test/serverProxy.test.mjs
git commit -m "feat: add session-only server credential"
```

---

### Task 2: Client API supports explicit Session credential mode

**Files:**
- Modify: `src/services/redeemApi.js`
- Test: `test/redeemApi.test.mjs`

**Interfaces:**
- Produces: `callProxy(path, body, { credentialMode } = {})`
- Session request body: `{ credentialMode: "session", ...body }` with no empty `apiKey` field

- [ ] **Step 1: Write failing client API tests**

```javascript
await api.callProxy("/api/redeem/status", { cdkeys: ["A"] }, { credentialMode: "session" });
assert.deepEqual(JSON.parse(request.options.body), {
  credentialMode: "session",
  cdkeys: ["A"]
});
```

Retain the existing test that ordinary empty-key calls reject with `请先填写外部 API Key`, and add a test that a user key remains present even when Session mode is supplied.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/redeemApi.test.mjs`

Expected: FAIL because `callProxy` rejects the Session-mode empty-key request.

- [ ] **Step 3: Implement the minimal client behavior**

```javascript
async function callProxy(path, body, options = {}) {
  const apiKey = String(getApiKey() || "").trim();
  const credentialMode = String(options.credentialMode || "").trim();
  if (!apiKey && credentialMode !== "session") {
    throw new Error("请先填写外部 API Key");
  }
  return callJson(path, {
    ...(apiKey ? { apiKey } : {}),
    ...(credentialMode ? { credentialMode } : {}),
    ...body
  });
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/redeemApi.test.mjs`

Expected: all redeem API tests PASS.

- [ ] **Step 5: Commit the client API change**

```bash
git add src/services/redeemApi.js test/redeemApi.test.mjs
git commit -m "feat: support session credential mode"
```

---

### Task 3: Central credential grouping helpers

**Files:**
- Create: `src/workflow/credentialRouting.js`
- Create: `test/credentialRouting.test.mjs`

**Interfaces:**
- Produces: `splitRowsByCredential(rows, { hasUserApiKey })`
- Produces: `splitCdkeysByCredential(rows, cdkeys, { hasUserApiKey })`
- Produces: `mergeProxyPayloads(payloads)`

- [ ] **Step 1: Write failing grouping tests**

Cover these exact cases:

```javascript
assert.deepEqual(splitRowsByCredential(mixedRows, { hasUserApiKey: false }), {
  groups: [{ credentialMode: "session", rows: [sessionRow] }],
  blockedRows: [accountRow]
});

assert.deepEqual(splitRowsByCredential(mixedRows, { hasUserApiKey: true }), {
  groups: [{ credentialMode: "", rows: mixedRows }],
  blockedRows: []
});
```

For CDKs, prefer the current `statusOwner` row when historical rows reuse the same CDK. Verify `mergeProxyPayloads` concatenates items and sums batch/backend counts.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/credentialRouting.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the helpers**

Use `sourceType === "session"` as the only Session marker. User-key mode returns one unsplit group. Empty-key mode returns one Session group plus blocked ordinary rows. CDK grouping must map each requested CDK to its current owner row and treat missing ownership as ordinary/blocked.

```javascript
export function splitRowsByCredential(rows, { hasUserApiKey } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (hasUserApiKey) return { groups: [{ credentialMode: "", rows: list }], blockedRows: [] };
  const sessionRows = list.filter((row) => row?.sourceType === "session");
  const blockedRows = list.filter((row) => row?.sourceType !== "session");
  return {
    groups: sessionRows.length ? [{ credentialMode: "session", rows: sessionRows }] : [],
    blockedRows
  };
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/credentialRouting.test.mjs`

Expected: all credential-routing tests PASS.

- [ ] **Step 5: Commit the routing helpers**

```bash
git add src/workflow/credentialRouting.js test/credentialRouting.test.mjs
git commit -m "feat: group redeem work by credential"
```

---

### Task 4: Apply routing to preflight and submission

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/hooks/useRedeemSubmit.js`
- Modify: `src/hooks/useAutoCycle.js`
- Modify: `src/workflow/workflowCommands.js`
- Test: `test/redeemWorkflowSubmit.test.mjs`
- Test: `test/autoCycleRules.test.mjs`
- Test: `test/workflowCommands.test.mjs`

**Interfaces:**
- `preflightCdkeysForSubmit(cdkeys, existingRows, { credentialMode } = {})`
- `buildSubmitCommand(rows, { credentialMode } = {})`
- Hooks receive `hasUserApiKey: () => boolean`

- [ ] **Step 1: Write failing submission tests**

Add tests proving:

- Empty user key filters the account pool to `sourceType: "session"`.
- Mixed empty-key input submits only Session rows and reports ordinary rows as skipped.
- Session preflight and submit calls use `{ credentialMode: "session" }`.
- A populated user key retains the current unified submission behavior.
- Auto-cycle uses the replacement account row's `sourceType`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/redeemWorkflowSubmit.test.mjs test/autoCycleRules.test.mjs test/workflowCommands.test.mjs`

Expected: FAIL because submission does not filter/group by credential mode.

- [ ] **Step 3: Implement submission routing**

Before availability and pairing, derive the eligible accounts:

```javascript
const hasKey = hasUserApiKey();
const eligibleAccounts = hasKey
  ? accountValidation.accounts
  : accountValidation.accounts.filter((account) => account?.sourceType === "session");
const blockedOrdinaryAccounts = hasKey
  ? []
  : accountValidation.accounts.filter((account) => account?.sourceType !== "session");
const credentialMode = hasKey ? "" : "session";
```

Pass `credentialMode` through preflight, submit command, selected resubmit, and auto-cycle calls. When no eligible Session rows remain, show `普通账号兑换需要填写外部 API Key`. Include skipped ordinary counts in status messages without deleting their input.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/redeemWorkflowSubmit.test.mjs test/autoCycleRules.test.mjs test/workflowCommands.test.mjs`

Expected: all focused workflow tests PASS.

- [ ] **Step 5: Commit submission routing**

```bash
git add src/App.jsx src/hooks/useRedeemSubmit.js src/hooks/useAutoCycle.js src/workflow/workflowCommands.js test/redeemWorkflowSubmit.test.mjs test/autoCycleRules.test.mjs test/workflowCommands.test.mjs
git commit -m "feat: route session redemption through default credential"
```

---

### Task 5: Apply routing to status, cancel, retry, and UI feedback

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/hooks/useRedeemPolling.js`
- Modify: `src/hooks/useRedeemSubmit.js`
- Modify: `src/components/prep/PrepWorkspace.jsx`
- Test: `test/serializedPolling.test.mjs`
- Test: `test/redeemWorkflowSubmit.test.mjs`
- Test: `test/prepWorkspaceStructure.test.mjs`

**Interfaces:**
- Polling receives `hasUserApiKey: () => boolean`
- Group calls use `callProxy(path, body, { credentialMode })`
- Blocked ordinary rows receive `query_failed` with `请先填写外部 API Key`

- [ ] **Step 1: Write failing continuation tests**

Test that mixed status CDKs are split when the user key is empty, Session results still apply, ordinary rows get a local credential error, and cancel/retry only call the server for Session rows. Verify the prep summary reads `Session 可使用服务器默认凭证` when Session input exists and the API Key field is empty.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/serializedPolling.test.mjs test/redeemWorkflowSubmit.test.mjs test/prepWorkspaceStructure.test.mjs`

Expected: FAIL because continuation actions still make one user-key-only proxy call.

- [ ] **Step 3: Implement grouped continuation calls**

Use `splitCdkeysByCredential` for polling and `splitRowsByCredential` for cancel/retry. Call each allowed group with its credential mode, combine responses with `mergeProxyPayloads`, and mark blocked ordinary rows locally without preventing Session rows from updating.

Update the prep subtitle selection:

```jsx
subtitle={
  summary.apiKeyFilled
    ? "API Key 已填写"
    : summary.sessionLineCount > 0
      ? "Session 可使用服务器默认凭证"
      : "等待 API Key"
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/serializedPolling.test.mjs test/redeemWorkflowSubmit.test.mjs test/prepWorkspaceStructure.test.mjs`

Expected: all focused tests PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all tests pass, Vite production build succeeds, and no whitespace errors are reported.

- [ ] **Step 6: Verify the credential is absent from repository/build output**

Run a fixed-string search for the user-provided credential against `src`, `server`, `test`, `docs`, and `dist`. Expected: zero matches. Do not print the credential in logs or the final response.

- [ ] **Step 7: Configure and smoke-test runtime environment**

Set `SESSION_REDEEM_API_KEY` in the local process environment for a Session-only smoke test. If deployment is authorized, add the same environment variable to `cdk-redeem-console.service`, back up the current release, deploy the verified commit, restart only that service, and confirm `/api/redeem/status` accepts Session mode without a browser API Key.

- [ ] **Step 8: Commit continuation routing**

```bash
git add src/App.jsx src/hooks/useRedeemPolling.js src/hooks/useRedeemSubmit.js src/components/prep/PrepWorkspace.jsx test/serializedPolling.test.mjs test/redeemWorkflowSubmit.test.mjs test/prepWorkspaceStructure.test.mjs
git commit -m "feat: keep session credential mode across job actions"
```
