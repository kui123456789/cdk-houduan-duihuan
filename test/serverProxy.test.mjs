import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../server/app.js";
import { resolveRedeemApiKey } from "../server/proxy.js";

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

test("resolveRedeemApiKey prefers the user key and limits fallback to Session mode", () => {
  assert.equal(
    resolveRedeemApiKey({
      apiKey: " user-key ",
      credentialMode: "session",
      sessionDefaultApiKey: "server-key"
    }),
    "user-key"
  );
  assert.equal(
    resolveRedeemApiKey({
      apiKey: "",
      credentialMode: "session",
      sessionDefaultApiKey: " server-key "
    }),
    "server-key"
  );
  assert.throws(
    () =>
      resolveRedeemApiKey({
        apiKey: "",
        credentialMode: "",
        sessionDefaultApiKey: "server-key"
      }),
    /外部 API Key 不能为空/
  );
  assert.throws(
    () =>
      resolveRedeemApiKey({
        apiKey: "",
        credentialMode: "session",
        sessionDefaultApiKey: ""
      }),
    /服务器未配置 Session 默认兑换凭证/
  );
});

test("POST /api/redeem/status uses the configured Session default credential", async () => {
  const calls = [];
  const app = createApp({
    config: { sessionDefaultApiKey: "server-session-key" },
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return jsonResponse({ items: [{ cdkey: "A", status: "done" }] });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialMode: "session", cdkeys: ["A"] })
    });

    assert.equal(response.status, 200);
    assert.equal(calls[0].headers["X-External-Api-Key"], "server-session-key");
  });
});

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

test("POST /api/subscription/email-check verifies the ChatGPT Plus confirmation email", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        "<h1>OpenAI</h1><p>You've successfully subscribed to ChatGPT Plus.</p><b>Order number:</b> sub_test <b>Order date:</b> Jul 23, 2026",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/email-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pickupUrl: "https://mail.example.com/inbox/code",
        redeemedAt: "2026-07-23T09:00:00Z"
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://mail.example.com/inbox/code");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(payload.category, "verified");
    assert.equal(payload.emailVerification.orderNumber, "sub_test");
  });
});

test("POST /api/subscription/email-check returns banned for the OpenAI ban notice", async () => {
  const app = createApp({
    fetchImpl: async () => new Response(
      "<p>Your account has been banned because recent activity violated our Terms and Usage Policies.</p><p>This means your account can no longer be used.</p>",
      { status: 200, headers: { "Content-Type": "text/html" } }
    )
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/email-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickupUrl: "https://mail.example.com/inbox/banned" })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.category, "banned");
    assert.equal(payload.emailVerification.category, "banned");
  });
});

test("POST /api/subscription/email-check blocks missing and private pickup URLs", async () => {
  let fetchCount = 0;
  const app = createApp({ fetchImpl: async () => {
    fetchCount += 1;
    return new Response("unexpected");
  } });

  await withServer(app, async (baseUrl) => {
    for (const body of [{}, { pickupUrl: "http://127.0.0.1/private" }]) {
      const response = await fetch(`${baseUrl}/api/subscription/email-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).ok, false);
    }
  });
  assert.equal(fetchCount, 0);
});
