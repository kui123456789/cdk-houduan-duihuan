import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../worker/index.js";

const env = {
  SESSION_REDEEM_API_KEY: "session-secret",
  TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  SECURITY_SESSION_SECRET: "security-session-secret",
  ASSETS: { fetch: async () => new Response("asset") }
};

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
  const response = await handleRequest(
    post("/api/redeem/status", { cdkeys, credentialMode: "session" }),
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

test("returns downloadable text with a UTF-8 file name", async () => {
  const response = await handleRequest(
    post("/api/download/text", { fileName: "导出结果", content: "alpha\nbeta" }),
    env,
    fetch
  );
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.equal(await response.text(), "alpha\nbeta");
});
