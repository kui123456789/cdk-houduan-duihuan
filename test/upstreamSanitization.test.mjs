import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizePublicError,
  sanitizePublicMessage,
  sanitizeUpstreamPayload,
  sanitizeUpstreamStatus
} from "../src/domain/upstreamSanitization.js";
import { normalizeStatusItem } from "../src/redeemLogic.js";

const SECRET = "secret-token-123";

test("upstream payload sanitization keeps UI fields and removes credential material", () => {
  const sanitized = sanitizeUpstreamPayload({
    ok: true,
    request_id: "req-1",
    data: {
      items: [{
        cdkey: "CDK-A",
        status: "failed",
        reason: `access_token=${SECRET} request failed`,
        can_retry: true,
        has_access_token: true,
        access_token: SECRET,
        password: SECRET,
        two_factor_code: SECRET,
        session: { token: SECRET },
        headers: { Authorization: `Bearer ${SECRET}` },
        stack: `Error: ${SECRET}`
      }]
    }
  });
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.request_id, "req-1");
  assert.equal(sanitized.data.items[0].cdkey, "CDK-A");
  assert.equal(sanitized.data.items[0].can_retry, true);
  assert.equal(sanitized.data.items[0].has_access_token, true);
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, /"(?:access_token|password|two_factor|Authorization|stack)"\s*:/);
});

test("status and public error projections never expose stacks or nested secrets", () => {
  const status = sanitizeUpstreamStatus({
    cdkey: "CDK-A",
    status: "failed",
    message: `Authorization: Bearer ${SECRET}`,
    apiKey: SECRET,
    stack: SECRET
  });
  const publicError = sanitizePublicError({
    code: "REMOTE_FAILURE",
    message: `token=${SECRET} rejected`,
    requestId: "req-2",
    stack: SECRET,
    payload: { access_token: SECRET }
  });

  assert.doesNotMatch(JSON.stringify(status), new RegExp(SECRET));
  assert.deepEqual(Object.keys(publicError).sort(), ["code", "message", "requestId"]);
  assert.doesNotMatch(JSON.stringify(publicError), new RegExp(SECRET));
  assert.equal(sanitizePublicMessage(`password=${SECRET}`), "password=[REDACTED]");
});

test("normalizeStatusItem stores only a sanitized raw status", () => {
  const normalized = normalizeStatusItem({
    cdkey: "CDK-A",
    status: "failed",
    reason: `api_key=${SECRET} denied`,
    access_token: SECRET,
    headers: { Cookie: SECRET },
    stack: SECRET
  });
  const serialized = JSON.stringify(normalized);

  assert.equal(normalized.status, "failed");
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, /"(?:headers|stack|access_token)"\s*:/);
});
