import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../worker/index.js";

const allowLimiter = { limit: async () => ({ success: true }) };
const env = {
  SESSION_REDEEM_API_KEY: "session-secret",
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  SECURITY_SESSION_SECRET: "security-session-secret",
  MAILBOX_ALLOWED_HOSTS: "mail.example.com",
  API_RATE_LIMITER: allowLimiter,
  MUTATION_RATE_LIMITER: allowLimiter,
  TURNSTILE_RATE_LIMITER: allowLimiter,
  MAILBOX_RATE_LIMITER: allowLimiter,
  ASSETS: { fetch: async () => new Response("asset") }
};

function post(path, body) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function getSecurityCookie() {
  const response = await handleRequest(
    post("/api/security/verify", { token: "valid-token" }),
    env,
    async () => Response.json({ success: true, hostname: "cdk.334401.xyz", action: "cdk-redeem" })
  );
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function createExpiredSecurityCookie() {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    issuedAt: 1,
    expiresAt: 2,
    nonce: "expired-test-session"
  })).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SECURITY_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `__Host-cdk_security=${payload}.${Buffer.from(signature).toString("base64url")}`;
}

test("serves non-API requests from the asset binding", async () => {
  const response = await handleRequest(new Request("https://example.test/app"), env, fetch);
  assert.equal(await response.text(), "asset");
});

test("exposes security configuration without returning secrets", async () => {
  const response = await handleRequest(new Request("https://example.test/api/security/config"), env, fetch);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { siteKey: "site-key" });
});

test("requires Turnstile before submit and accepts the signed security cookie", async () => {
  const blocked = await handleRequest(
    post("/api/redeem/submit", { items: [{ channel: "upi", cdkey: "A", access_token: "T" }], apiKey: "key" }),
    env,
    fetch
  );
  assert.equal(blocked.status, 403);

  const verified = await handleRequest(
    post("/api/security/verify", { token: "valid-token" }),
    env,
    async (url) => {
      assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
      return Response.json({ success: true, hostname: "cdk.334401.xyz", action: "cdk-redeem" });
    }
  );
  assert.equal(verified.status, 200);
  const cookie = verified.headers.get("set-cookie").split(";", 1)[0];

  const submitRequest = post("/api/redeem/submit", {
    items: [{ channel: "upi", cdkey: "A", access_token: "T" }],
    apiKey: "key"
  });
  submitRequest.headers.set("Cookie", cookie);
  const allowed = await handleRequest(submitRequest, env, async () => Response.json({ items: [{ cdkey: "A" }] }));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).items[0].cdkey, "A");
});

test("protects every operation that can use the server Session credential", async () => {
  const requiredRequests = [
    post("/api/redeem/submit", { items: [{ channel: "upi", cdkey: "A", access_token: "T" }], apiKey: "key" }),
    post("/api/redeem/cancel", { cdkeys: ["A"], apiKey: "key" }),
    post("/api/redeem/retry", { cdkeys: ["A"], apiKey: "key" }),
    post("/api/redeem/status", { cdkeys: ["A"], credentialMode: "session" })
  ];

  for (const request of requiredRequests) {
    let fetchCount = 0;
    const response = await handleRequest(request, env, async () => {
      fetchCount += 1;
      return Response.json({ items: [] });
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "SECURITY_SESSION_REQUIRED");
    assert.equal(fetchCount, 0);
  }
});

test("rejects expired and cross-site security sessions", async () => {
  const expiredRequest = post("/api/redeem/status", { cdkeys: ["A"], credentialMode: "session" });
  expiredRequest.headers.set("Cookie", await createExpiredSecurityCookie());
  const expired = await handleRequest(expiredRequest, env, fetch);
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, "SECURITY_SESSION_REQUIRED");

  const crossSiteRequest = post("/api/redeem/status", { cdkeys: ["A"], credentialMode: "session" });
  crossSiteRequest.headers.set("Cookie", await getSecurityCookie());
  crossSiteRequest.headers.set("Origin", "https://attacker.example");
  const crossSite = await handleRequest(crossSiteRequest, env, fetch);
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).code, "SECURITY_SESSION_REQUIRED");
});

test("allows a valid security session and keeps user-key status queries public", async () => {
  const cookie = await getSecurityCookie();
  const sessionRequest = post("/api/redeem/status", { cdkeys: ["A"], credentialMode: "session" });
  sessionRequest.headers.set("Cookie", cookie);
  sessionRequest.headers.set("Origin", "https://example.test");
  const sessionResponse = await handleRequest(
    sessionRequest,
    env,
    async () => Response.json({ items: [{ cdkey: "A" }] })
  );
  assert.equal(sessionResponse.status, 200);

  const userKeyResponse = await handleRequest(
    post("/api/redeem/status", { cdkeys: ["B"], apiKey: "user-key" }),
    env,
    async () => Response.json({ items: [{ cdkey: "B" }] })
  );
  assert.equal(userKeyResponse.status, 200);
});

test("rejects invalid Turnstile outcomes", async () => {
  const response = await handleRequest(
    post("/api/security/verify", { token: "invalid-token" }),
    env,
    async () => Response.json({ success: false })
  );
  assert.equal(response.status, 403);
});

test("returns 429 when the API rate limiter rejects a client", async () => {
  const limitedEnv = { ...env, API_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const response = await handleRequest(post("/api/download/text", { content: "x" }), limitedEnv, fetch);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
});

test("fails closed when a mutation rate limiter is missing or unavailable", async () => {
  for (const limitedEnv of [
    { ...env, API_RATE_LIMITER: undefined },
    { ...env, MUTATION_RATE_LIMITER: { limit: async () => { throw new Error("offline"); } } }
  ]) {
    let fetchCount = 0;
    const response = await handleRequest(
      post("/api/redeem/submit", {
        apiKey: "user-key",
        items: [{ channel: "upi", cdkey: "A", access_token: "T" }]
      }),
      limitedEnv,
      async () => {
        fetchCount += 1;
        return Response.json({ items: [] });
      }
    );
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.code, "RATE_LIMITER_UNAVAILABLE");
    assert.equal(fetchCount, 0);
  }
});

test("allows read-only status queries when the global limiter is unavailable", async () => {
  let fetchCount = 0;
  const response = await handleRequest(
    post("/api/redeem/status", { apiKey: "user-key", cdkeys: ["A"] }),
    { ...env, API_RATE_LIMITER: { limit: async () => { throw new Error("offline"); } } },
    async () => {
      fetchCount += 1;
      return Response.json({ items: [{ cdkey: "A" }] });
    }
  );

  assert.equal(response.status, 200);
  assert.equal(fetchCount, 1);
});

test("uses independent Turnstile and mailbox limiter quotas", async () => {
  let turnstileCalls = 0;
  let mailboxCalls = 0;
  const splitEnv = {
    ...env,
    TURNSTILE_RATE_LIMITER: {
      limit: async () => {
        turnstileCalls += 1;
        return { success: true };
      }
    },
    MAILBOX_RATE_LIMITER: {
      limit: async () => {
        mailboxCalls += 1;
        return { success: true };
      }
    }
  };

  const verifyResponse = await handleRequest(
    post("/api/security/verify", { token: "valid-token" }),
    splitEnv,
    async () => Response.json({ success: true, hostname: "cdk.334401.xyz", action: "cdk-redeem" })
  );
  const mailboxResponse = await handleRequest(
    post("/api/subscription/email-check", {
      pickupUrl: "https://mail.example.com/inbox/code",
      redeemedAt: "2026-07-23T09:00:00Z"
    }),
    splitEnv,
    async () => new Response(
      "<p>You've successfully subscribed to ChatGPT Plus.</p><p>Order number: sub_split</p><p>Order date: Jul 23, 2026</p>"
    )
  );

  assert.equal(verifyResponse.status, 200);
  assert.equal(mailboxResponse.status, 200);
  assert.equal(turnstileCalls, 1);
  assert.equal(mailboxCalls, 1);
});

test("requires JSON and rejects unknown API routes", async () => {
  const invalid = await handleRequest(
    new Request("https://example.test/api/redeem/status", { method: "POST", body: "{" }),
    env,
    fetch
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "请求 JSON 格式无效");

  const unknown = await handleRequest(post("/api/nope", {}), env, fetch);
  assert.equal(unknown.status, 404);
});

test("uses the session secret and splits redeem requests into batches of 100", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const input = JSON.parse(init.body).cdkeys;
    return Response.json({ items: input.map((cdkey) => ({ cdkey })) });
  };
  const cdkeys = Array.from({ length: 101 }, (_, index) => `CDK-${index}`);
  const request = post("/api/redeem/status", { cdkeys, credentialMode: "session" });
  request.headers.set("Cookie", await getSecurityCookie());
  const response = await handleRequest(
    request,
    env,
    fetchImpl
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.batchCount, 2);
  assert.equal(payload.items.length, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["X-External-Api-Key"], "session-secret");
  assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-redeems/status");
});

test("preserves upstream redeem failures", async () => {
  const secret = "worker-secret-token";
  const response = await handleRequest(
    post("/api/redeem/status", { cdkeys: ["missing"], apiKey: "user-key" }),
    env,
    async () => Response.json({
      success: false,
      message: `access_token=${secret} denied`,
      access_token: secret,
      stack: `Error: ${secret}`,
      request_id: "req-worker"
    }, { status: 403 })
  );
  const payload = await response.json();
  assert.equal(response.status, 403);
  assert.equal(payload.code, "UPSTREAM_REQUEST_FAILED");
  assert.equal(payload.requestId, "req-worker");
  assert.match(payload.message, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret));
  assert.equal(Object.hasOwn(payload, "details"), false);
});

test("normalizes a successful Plus subscription response", async () => {
  const response = await handleRequest(
    post("/api/subscription/check", { token: "token" }),
    env,
    async () => Response.json({ plan_type: "plus", has_active_subscription: true })
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.category, "plus");
  assert.equal(payload.retryable, false);
});

test("returns token diagnostics from subscription failures", async () => {
  const response = await handleRequest(
    post("/api/subscription/check", { token: "expired" }),
    env,
    async () => Response.json({ error: "token expired" }, { status: 401 })
  );
  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.equal(payload.category, "token_invalid");
});

test("verifies Plus confirmation email through the Worker route", async () => {
  const response = await handleRequest(
    post("/api/subscription/email-check", {
      pickupUrl: "https://mail.example.com/inbox/code",
      redeemedAt: "2026-07-23T09:00:00Z"
    }),
    env,
    async () => new Response(
      "<p>You've successfully subscribed to ChatGPT Plus.</p><p>Order number: sub_worker</p><p>Order date: Jul 23, 2026</p>",
      { headers: { "Content-Type": "text/html" } }
    )
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.category, "verified");
  assert.equal(payload.orderNumber, "sub_worker");
});

test("Worker email verification returns banned for the OpenAI ban notice", async () => {
  const response = await handleRequest(
    post("/api/subscription/email-check", { pickupUrl: "https://mail.example.com/inbox/banned" }),
    env,
    async () => new Response(
      "<p>Your account has been banned because recent activity violated our Terms and Usage Policies.</p>",
      { headers: { "Content-Type": "text/html" } }
    )
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.category, "banned");
});

test("Worker email verification rejects private pickup URLs before fetching", async () => {
  let fetchCount = 0;
  const response = await handleRequest(
    post("/api/subscription/email-check", { pickupUrl: "http://127.0.0.1/private" }),
    env,
    async () => {
      fetchCount += 1;
      return new Response("unexpected");
    }
  );
  assert.equal(response.status, 400);
  assert.equal(fetchCount, 0);
});

test("Worker returns successful batch results when a later batch fails", async () => {
  let callCount = 0;
  const response = await handleRequest(
    post("/api/redeem/status", {
      apiKey: "user-key",
      cdkeys: Array.from({ length: 101 }, (_, index) => `CDK-${index}`)
    }),
    env,
    async (_url, options) => {
      callCount += 1;
      const cdkeys = JSON.parse(options.body).cdkeys;
      if (callCount === 2) {
        return Response.json({ error: "second batch failed" }, { status: 502 });
      }
      return Response.json({ items: cdkeys.map((cdkey) => ({ cdkey, status: "queued" })) });
    }
  );
  const payload = await response.json();

  assert.equal(response.status, 207);
  assert.equal(payload.ok, false);
  assert.equal(payload.partial, true);
  assert.equal(payload.processedCount, 100);
  assert.equal(payload.remainingCount, 1);
  assert.equal(payload.items.length, 100);
  assert.equal(payload.backend.batches[0].ok, true);
  assert.equal(payload.backend.batches[1].ok, false);
  assert.equal(callCount, 2);
});

test("Worker rejects an upstream redeem body above the byte limit", async () => {
  const response = await handleRequest(
    post("/api/redeem/status", { cdkeys: ["A"], apiKey: "user-key" }),
    env,
    async () => new Response("{}", {
      headers: { "Content-Length": "5000001", "Content-Type": "application/json" }
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.match(payload.message, /响应体超过/);
});

test("Worker rejects oversized batches before calling upstream", async () => {
  let fetchCount = 0;
  const response = await handleRequest(
    post("/api/redeem/status", {
      apiKey: "user-key",
      cdkeys: Array.from({ length: 501 }, (_, index) => `CDK-${index}`)
    }),
    env,
    async () => {
      fetchCount += 1;
      return Response.json({ items: [] });
    }
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_REQUEST");
  assert.equal(fetchCount, 0);
});

test("Worker email verification requires an allowlist and validates redirects", async () => {
  const missingAllowlist = await handleRequest(
    post("/api/subscription/email-check", { pickupUrl: "https://mail.example.com/inbox/code" }),
    { ...env, MAILBOX_ALLOWED_HOSTS: "" },
    async () => new Response("unexpected")
  );
  assert.equal(missingAllowlist.status, 400);
  assert.equal((await missingAllowlist.json()).category, "invalid_url");

  const redirected = await handleRequest(
    post("/api/subscription/email-check", { pickupUrl: "https://mail.example.com/inbox/code" }),
    env,
    async () => new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example.com/private" }
    })
  );
  assert.equal(redirected.status, 400);
  assert.equal((await redirected.json()).category, "invalid_url");
});

test("returns downloadable text with a UTF-8 file name", async () => {
  const response = await handleRequest(
    post("/api/download/text", { fileName: "导出结果", content: "alpha\nbeta" }),
    env,
    fetch
  );
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.equal(await response.text(), "alpha\nbeta");
});
