import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../worker/index.js";

const env = {
  SESSION_REDEEM_API_KEY: "session-secret",
  SESSION_REFRESH_AUTH_TOKEN: "refresh-secret",
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  SECURITY_SESSION_SECRET: "security-session-secret",
  ASSETS: { fetch: async () => new Response("asset") }
};

async function getSecurityCookie() {
  const verified = await handleRequest(
    post("/api/security/verify", { token: "valid-token" }),
    env,
    async (url) => {
      assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
      return Response.json({ success: true, hostname: "cdk.334401.xyz", action: "cdk-redeem" });
    }
  );
  assert.equal(verified.status, 200);
  return verified.headers.get("set-cookie").split(";", 1)[0];
}

function post(path, body) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
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

test("GET queue summary proxies the public external response", async () => {
  const calls = [];
  const response = await handleRequest(
    new Request("https://example.test/api/redeem/tasks/queue-summary"),
    env,
    async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        code: 0,
        data: { vip_queue_count: 54, kakao_queue_count: 784 }
      });
    }
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://chong.nerver.cc/api/redeem/tasks/queue-summary");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(payload.ok, true);
  assert.equal(payload.data.vip_queue_count, 54);
});

test("GET task list rejects anonymous use of the server credential", async () => {
  const response = await handleRequest(
    new Request("https://example.test/api/redeem/tasks?page=1&page_size=50"),
    env,
    async () => {
      throw new Error("upstream must not be called");
    }
  );
  assert.equal(response.status, 403);
});

test("GET task list accepts a user API key and strips sensitive task fields", async () => {
  const calls = [];
  const request = new Request("https://example.test/api/redeem/tasks?page=2&page_size=50", {
    headers: { "X-External-Api-Key": "user-secret" }
  });
  const response = await handleRequest(
    request,
    env,
    async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        code: 0,
        data: {
          list: [{ cdkey: "CDK-1", queue_ahead_count: 8, token_tail: "must-not-leak" }],
          pagination: { page: 2, page_size: 50, total: 1 }
        }
      });
    }
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://chong.nerver.cc/api/redeem/tasks?page=2&page_size=50");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["X-External-Api-Key"], "user-secret");
  assert.equal(payload.data.list[0].cdkey, "CDK-1");
  assert.equal(payload.data.list[0].queue_ahead_count, 8);
  assert.equal("token_tail" in payload.data.list[0], false);
});

test("requires Turnstile before submit and accepts the signed security cookie", async () => {
  const blocked = await handleRequest(
    post("/api/redeem/submit", { items: [{ channel: "upi", cdkey: "A", access_token: "T" }], apiKey: "key" }),
    env,
    fetch
  );
  assert.equal(blocked.status, 403);

  const cookie = await getSecurityCookie();

  const submitRequest = post("/api/redeem/submit", {
    items: [{ channel: "upi", cdkey: "A", access_token: "T" }],
    apiKey: "key"
  });
  submitRequest.headers.set("Cookie", cookie);
  const allowed = await handleRequest(submitRequest, env, async () => Response.json({ items: [{ cdkey: "A" }] }));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).items[0].cdkey, "A");
});

test("requires a security session for mutations and server-backed status", async () => {
  const requests = [
    post("/api/redeem/cancel", { cdkeys: ["CDK-1"], apiKey: "user-key" }),
    post("/api/redeem/retry", { cdkeys: ["CDK-1"], apiKey: "user-key" }),
    post("/api/redeem/status", { cdkeys: ["CDK-1"], credentialMode: "session" }),
    post("/api/subscription/session-refresh", { sessionToken: "session-token" })
  ];

  for (const request of requests) {
    const response = await handleRequest(request, env, async () => {
      throw new Error("upstream must not be called");
    });
    assert.equal(response.status, 403);
  }
});

test("Worker session refresh forwards credentials only after security verification", async () => {
  const cookie = await getSecurityCookie();
  const request = post("/api/subscription/session-refresh", { sessionToken: "old-session" });
  request.headers.set("Cookie", cookie);
  const calls = [];
  const response = await handleRequest(request, env, async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({
      ok: true,
      email: "user@example.com",
      accessToken: "refreshed-access-token",
      sessionToken: "rotated-session"
    });
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls[0].url, "https://cha.nerver.cc/api/v1/session/refresh");
  assert.equal(calls[0].init.headers.Authorization, "Bearer refresh-secret");
  assert.deepEqual(calls[0].body, { sessionToken: "old-session" });
  assert.equal(payload.accessToken, "refreshed-access-token");
  assert.equal(payload.sessionToken, "rotated-session");
});

test("rejects invalid Turnstile outcomes", async () => {
  const response = await handleRequest(
    post("/api/security/verify", { token: "invalid-token" }),
    env,
    async () => Response.json({ success: false })
  );
  assert.equal(response.status, 403);
});

test("turns Turnstile network failures into a controlled verification error", async () => {
  const response = await handleRequest(
    post("/api/security/verify", { token: "valid-token" }),
    env,
    async () => { throw new Error("network unavailable"); }
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).verified, false);
});

test("returns 429 when the API rate limiter rejects a client", async () => {
  const limitedEnv = { ...env, API_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const response = await handleRequest(post("/api/download/text", { content: "x" }), limitedEnv, fetch);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
});

test("fails closed when a configured API rate limiter is unavailable", async () => {
  const limitedEnv = {
    ...env,
    API_RATE_LIMITER: { limit: async () => { throw new Error("binding unavailable"); } }
  };
  const response = await handleRequest(
    post("/api/subscription/check", { token: "token" }),
    limitedEnv,
    async () => { throw new Error("upstream must not be called"); }
  );
  assert.equal(response.status, 503);
});

test("rejects JSON request bodies above the local 2 MB contract", async () => {
  const response = await handleRequest(
    post("/api/download/text", { content: "x".repeat(2_000_001) }),
    env,
    fetch
  );
  assert.equal(response.status, 413);
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
  const cookie = await getSecurityCookie();
  const request = post("/api/redeem/status", { cdkeys, credentialMode: "session" });
  request.headers.set("Cookie", cookie);
  const response = await handleRequest(request, env, fetchImpl);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.batchCount, 2);
  assert.equal(payload.items.length, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["X-External-Api-Key"], "session-secret");
  assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-redeems/status");
});

test("submit extracts and forwards AT without forwarding the ChatGPT session", async () => {
  const calls = [];
  const cookie = await getSecurityCookie();
  const request = post("/api/redeem/submit", {
    credentialMode: "session",
    items: [{
      cdkey: "CDK-SESSION",
      access_token: "fresh-at",
      channel: "ideal",
      session: {
        user: { email: "session@example.com" },
        accessToken: "stale-at",
        expires: "2026-08-04T00:00:00.000Z"
      }
    }]
  });
  request.headers.set("Cookie", cookie);

  const response = await handleRequest(request, env, async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ items: [{ cdkey: "CDK-SESSION", status: "queued" }] });
  });

  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-redeems");
  assert.equal(calls[0].body.channel, "ideal");
  assert.equal(calls[0].body.items[0].accessToken, "fresh-at");
  assert.equal(calls[0].body.items[0].access_token, "fresh-at");
  assert.equal(Object.hasOwn(calls[0].body.items[0], "session"), false);
});

test("retry forwards the selected channel with the CDKs", async () => {
  const calls = [];
  const cookie = await getSecurityCookie();
  const request = post("/api/redeem/retry", {
    credentialMode: "server",
    channel: " kakao ",
    cdkeys: [" CDK-RETRY "]
  });
  request.headers.set("Cookie", cookie);

  const response = await handleRequest(request, env, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({
      items: [{ cdkey: "CDK-RETRY", status: "queued", retried: true }]
    });
  });

  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-jobs/retry");
  assert.deepEqual(calls[0].body, {
    channel: "kakao",
    cdkeys: ["CDK-RETRY"]
  });
});

test("preserves upstream redeem failures", async () => {
  const response = await handleRequest(
    post("/api/redeem/status", { cdkeys: ["missing"], apiKey: "user-key" }),
    env,
    async () => Response.json({ success: false, message: "denied" }, { status: 403 })
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "denied");
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

test("rejects oversized upstream subscription responses", async () => {
  const response = await handleRequest(
    post("/api/subscription/check", { token: "token" }),
    env,
    async () => Response.json({
      plan_type: "plus",
      has_active_subscription: true,
      padding: "x".repeat(5_000_000)
    })
  );
  assert.equal(response.status, 502);
  assert.equal(JSON.stringify(await response.json()).includes("padding"), false);
});

test("returns token diagnostics from subscription failures", async () => {
  const response = await handleRequest(
    post("/api/subscription/check", { token: "expired" }),
    env,
    async () => Response.json({
      error: "token expired",
      token: "must-not-leak",
      debug: { authorization: "must-not-leak" }
    }, { status: 401 })
  );
  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.equal(payload.category, "token_invalid");
  assert.equal(Object.hasOwn(payload, "details"), false);
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
});

test("redacts raw upstream errors from redeem failures", async () => {
  const cookie = await getSecurityCookie();
  const request = post("/api/redeem/submit", {
    items: [{ channel: "upi", cdkey: "A", access_token: "T" }],
    apiKey: "key"
  });
  request.headers.set("Cookie", cookie);
  const response = await handleRequest(
    request,
    env,
    async () => Response.json({
      error: "redeem denied",
      token: "must-not-leak",
      debug: { authorization: "must-not-leak" }
    }, { status: 401 })
  );
  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.equal(payload.error, "redeem denied");
  assert.equal(Object.hasOwn(payload, "details"), false);
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
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

test("Worker email verification rejects streamed responses above 2 MB", async () => {
  const response = await handleRequest(
    post("/api/subscription/email-check", { pickupUrl: "https://mail.example.com/inbox/large" }),
    env,
    async () => new Response("x".repeat(2_000_001), {
      headers: { "Content-Type": "text/plain" }
    })
  );
  const payload = await response.json();
  assert.equal(response.status, 502);
  assert.equal(payload.category, "bad_response");
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
