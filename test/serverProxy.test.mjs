import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../server/app.js";

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

test("POST /api/redeem/submit forwards body and omits raw by default", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return jsonResponse({
      data: {
        items: [{ cdkey: "CDK-1", status: "queued" }]
      }
    });
  };
  const app = createApp({ fetchImpl });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "secret-key",
        items: [{ channel: " pool-a ", cdkey: " CDK-1 ", access_token: " token-1 " }]
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-redeems");
    assert.deepEqual(calls[0].body, {
      items: [
        {
          channel: "pool-a",
          pool: "pool-a",
          queue: "pool-a",
          redeem_channel: "pool-a",
          cdkey_pool: "pool-a",
          cdkey: "CDK-1",
          access_token: "token-1",
          accessToken: "token-1",
          session: {
            access_token: "token-1",
            accessToken: "token-1"
          }
        }
      ]
    });
    assert.equal(calls[0].options.headers["X-External-Api-Key"], "secret-key");
    assert.equal(payload.ok, true);
    assert.equal(payload.backend.itemCount, 1);
    assert.deepEqual(payload.items, [{ cdkey: "CDK-1", status: "queued" }]);
    assert.equal(Object.hasOwn(payload, "raw"), false);
  });
});

test("POST /api/redeem/submit includes raw when debugRawResponses is true", async () => {
  const backendPayload = {
    data: {
      items: [{ cdkey: "CDK-2", status: "queued" }]
    }
  };
  const app = createApp({
    config: { debugRawResponses: true },
    fetchImpl: async () => jsonResponse(backendPayload)
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "secret-key",
        items: [{ channel: "pool-b", cdkey: "CDK-2", access_token: "token-2" }]
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.raw, [backendPayload]);
  });
});

test("POST /api/redeem/status forwards cdkeys to external status endpoint", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ items: [{ cdkey: "A", status: "done" }] });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "secret-key",
        cdkeys: [" A ", "B"]
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-redeems/status");
    assert.deepEqual(calls[0].body, { cdkeys: ["A", "B"] });
    assert.deepEqual(payload.items, [{ cdkey: "A", status: "done" }]);
  });
});

test("POST /api/subscription/check returns Plus diagnostics", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({
        plan_type: "plus",
        subscription_plan: "plus",
        has_active_subscription: true
      });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: " at-token " })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://cha.nerver.cc/api/v1/subscription");
    assert.deepEqual(calls[0].body, { token: "at-token" });
    assert.equal(payload.ok, true);
    assert.equal(payload.category, "plus");
    assert.equal(payload.diagnostic.category, "plus");
    assert.equal(payload.retryable, false);
    assert.equal(payload.httpStatus, 200);
    assert.equal(payload.subscription.plan_type, "plus");
  });
});
