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

test("resolveRedeemApiKey prefers the user key and otherwise uses the server key", () => {
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
  assert.equal(
    resolveRedeemApiKey({
      apiKey: "",
      credentialMode: "",
      sessionDefaultApiKey: "server-key"
    }),
    "server-key"
  );
  assert.throws(
    () =>
      resolveRedeemApiKey({
        apiKey: "",
        credentialMode: "session",
        sessionDefaultApiKey: ""
      }),
    /服务器未配置默认兑换凭证/
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
        items: [{
          channel: " pool-a ",
          cdkey: " CDK-1 ",
          access_token: " token-1 ",
          email: " Session@Example.com ",
          session: {
            user: { email: "session@example.com" },
            accessToken: "stale-token",
            expires: "2026-08-04T00:00:00.000Z"
          }
        }]
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-redeems");
    assert.deepEqual(calls[0].body, {
      channel: "pool-a",
      items: [
        {
          channel: "pool-a",
          pool: "pool-a",
          queue: "pool-a",
          redeem_channel: "pool-a",
          cdkey_pool: "pool-a",
          cdkey: "CDK-1",
          access_token: "token-1",
          accessToken: "token-1"
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

test("POST /api/redeem/retry forwards the selected channel with the CDKs", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ items: [{ cdkey: "CDK-RETRY", status: "queued", retried: true }] });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "secret-key",
        channel: " ideal ",
        cdkeys: [" CDK-RETRY "]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://chong.nerver.cc/api/external/cdkey-jobs/retry");
    assert.deepEqual(calls[0].body, {
      channel: "ideal",
      cdkeys: ["CDK-RETRY"]
    });
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
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("POST /api/subscription/check redacts raw upstream error payloads", async () => {
  const app = createApp({
    fetchImpl: async () => jsonResponse({
      error: "invalid token",
      token: "must-not-leak",
      debug: { authorization: "must-not-leak" }
    }, { status: 401 })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "expired-token" })
    });
    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(Object.hasOwn(payload, "details"), false);
    assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
  });
});

test("POST /api/subscription/session-refresh forwards Session and returns rotated credentials", async () => {
  const calls = [];
  const app = createApp({
    config: { sessionRefreshAuthToken: "refresh-service-token" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        ok: true,
        accessToken: "new-at",
        sessionToken: "new-session",
        session_rotated: true,
        email: "session@example.com"
      });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/session-refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: "old-session" })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://cha.nerver.cc/api/v1/session/refresh");
    assert.equal(calls[0].options.headers.Authorization, "Bearer refresh-service-token");
    assert.deepEqual(calls[0].body, { sessionToken: "old-session" });
    assert.equal(payload.accessToken, "new-at");
    assert.equal(payload.sessionToken, "new-session");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("GET /api/redeem/tasks/queue-summary forwards the public queue endpoint", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        code: 0,
        message: "Success",
        data: {
          vip_queue_count: 54,
          normal_queue_count: 730,
          upi_queue_count: 0,
          ideal_queue_count: 0,
          pix_queue_count: 0,
          kakao_queue_count: 784
        }
      });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/tasks/queue-summary`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://chong.nerver.cc/api/redeem/tasks/queue-summary");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.headers["X-External-Api-Key"], undefined);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.kakao_queue_count, 784);
  });
});

test("GET /api/redeem/tasks forwards the paginated public task endpoint", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        code: 0,
        data: { list: [{ cdkey: "CDK-1" }], pagination: { page: 2, page_size: 50, total: 1 } }
      });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/tasks?page=2&page_size=50`, {
      headers: { "X-External-Api-Key": "user-key" }
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://chong.nerver.cc/api/redeem/tasks?page=2&page_size=50");
    assert.equal(calls[0].options.headers["X-External-Api-Key"], "user-key");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(payload.data.list[0].cdkey, "CDK-1");
  });
});

test("GET /api/redeem/tasks strips upstream task credentials and private fields", async () => {
  const app = createApp({
    fetchImpl: async () => jsonResponse({
      code: 0,
      message: "Success",
      data: {
        list: [{
          cdkey: "CDK-SAFE",
          status: "queued",
          queue_ahead_count: 3,
          access_token: "must-not-leak",
          sessionToken: "must-not-leak",
          password: "must-not-leak",
          nested: { secret: "must-not-leak" }
        }],
        pagination: { page: 1, page_size: 100, total: 1 }
      }
    })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/tasks`, {
      headers: { "X-External-Api-Key": "user-key" }
    });
    const payload = await response.json();

    assert.deepEqual(payload.data.list, [{
      cdkey: "CDK-SAFE",
      status: "queued",
      display_status: "",
      updated_at: "",
      queue_ahead_count: 3,
      queue_position: null,
      is_vip: false,
      payment_method: ""
    }]);
    assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
  });
});

test("proxy errors do not return the raw upstream payload", async () => {
  const app = createApp({
    fetchImpl: async () => jsonResponse({
      ok: false,
      message: "上游拒绝请求",
      access_token: "must-not-leak",
      debug: { session: "must-not-leak" }
    }, { status: 502 })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "user-key", cdkeys: ["CDK-1"] })
    });
    const payload = await response.json();

    assert.equal(response.status, 502);
    assert.equal(payload.error, "上游拒绝请求");
    assert.equal(Object.hasOwn(payload, "details"), false);
    assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
  });
});

test("proxy rejects upstream responses above the configured byte limit", async () => {
  const app = createApp({
    config: { maxUpstreamResponseBytes: 64 },
    fetchImpl: async () => jsonResponse({
      items: [{ cdkey: "A", status: "queued" }],
      padding: "x".repeat(128)
    })
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key", cdkeys: ["A"] })
    });
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(payload).includes("padding"), false);
  });
});

test("GET /api/redeem/tasks prefers the supplied API key over a configured session cookie", async () => {
  const calls = [];
  const app = createApp({
    config: { sessionDefaultCookie: "cw_conversation=session-a; auth_token=session-b" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        code: 0,
        data: { list: [], pagination: { page: 1, page_size: 100, total: 1401 } }
      });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/tasks?page=1&page_size=100`, {
      headers: { "X-External-Api-Key": "current-browser-key" }
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls[0].options.headers.Cookie, undefined);
    assert.equal(calls[0].options.headers["X-External-Api-Key"], "current-browser-key");
    assert.equal(payload.data.pagination.total, 1401);
    assert.equal(response.headers.get("set-cookie"), null);
  });
});

test("GET /api/redeem/tasks falls back to the configured session cookie without an API key", async () => {
  const calls = [];
  const app = createApp({
    config: { sessionDefaultCookie: "cw_conversation=session-a; auth_token=session-b" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        code: 0,
        data: { list: [], pagination: { page: 1, page_size: 100, total: 1401 } }
      });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/tasks?page=1&page_size=100`);
    assert.equal(response.status, 200);
    assert.equal(calls[0].options.headers.Cookie, "cw_conversation=session-a; auth_token=session-b");
    assert.equal(calls[0].options.headers["X-External-Api-Key"], undefined);
  });
});

test("GET /api/redeem/tasks/queue-summary forwards the locally configured session cookie", async () => {
  const calls = [];
  const app = createApp({
    config: { sessionDefaultCookie: "cw_conversation=session-a; auth_token=session-b" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ code: 0, data: { vip_queue_count: 4 } });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/tasks/queue-summary`);
    assert.equal(response.status, 200);
    assert.equal(calls[0].options.headers.Cookie, "cw_conversation=session-a; auth_token=session-b");
  });
});

test("local backend credentials validate and forward the current upstream session headers", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/user/profile")) {
        return jsonResponse({ code: 0, data: { id: "user-1" } }, {
          headers: { "X-Session-Token": "rotated-session-token" }
        });
      }
      return jsonResponse({ code: 0, data: { list: [], pagination: { total: 0 } } });
    }
  });

  await withServer(app, async (baseUrl) => {
    const setResponse = await fetch(`${baseUrl}/api/local/session-cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cookie: "Cookie: auth_token=cookie-value",
        sessionToken: "X-Session-Token: initial-session-token",
        deviceId: "X-Device-Id: device-123"
      })
    });
    assert.equal(setResponse.status, 200);
    assert.equal(calls[0].url, "https://chong.nerver.cc/api/user/profile");
    assert.equal(calls[0].options.headers.Cookie, "auth_token=cookie-value");
    assert.equal(calls[0].options.headers["X-Session-Token"], "initial-session-token");
    assert.equal(calls[0].options.headers["X-Device-Id"], "device-123");

    await fetch(`${baseUrl}/api/redeem/tasks?page=1&page_size=100`);
    assert.equal(calls[1].options.headers.Cookie, "auth_token=cookie-value");
    assert.equal(calls[1].options.headers["X-Session-Token"], "rotated-session-token");
    assert.equal(calls[1].options.headers["X-Device-Id"], "device-123");
  });
});

test("local backend credentials reject an expired cookie instead of reporting configured", async () => {
  const app = createApp({
    fetchImpl: async () => jsonResponse({
      code: 10002,
      message: "未登录或会话已过期，请重新登录"
    }, { status: 401 })
  });

  await withServer(app, async (baseUrl) => {
    const setResponse = await fetch(`${baseUrl}/api/local/session-cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "auth_token=expired" })
    });
    const payload = await setResponse.json();
    assert.equal(setResponse.status, 401);
    assert.match(payload.error, /未登录|会话已过期/);

    const status = await fetch(`${baseUrl}/api/local/session-cookie`);
    assert.deepEqual(await status.json(), { ok: true, configured: false });
  });
});

test("local session cookie controls stay in memory and update proxy forwarding", async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ code: 0, data: { vip_queue_count: 1 } });
    }
  });

  await withServer(app, async (baseUrl) => {
    const initial = await fetch(`${baseUrl}/api/local/session-cookie`);
    assert.deepEqual(await initial.json(), { ok: true, configured: false });

    const setResponse = await fetch(`${baseUrl}/api/local/session-cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: " cw_conversation=session-a; auth_token=session-b " })
    });
    assert.deepEqual(await setResponse.json(), { ok: true, configured: true });

    const queueResponse = await fetch(`${baseUrl}/api/redeem/tasks/queue-summary`);
    assert.equal(queueResponse.status, 200);
    assert.equal(calls.at(-1).options.headers.Cookie, "cw_conversation=session-a; auth_token=session-b");

    const clearResponse = await fetch(`${baseUrl}/api/local/session-cookie`, { method: "DELETE" });
    assert.deepEqual(await clearResponse.json(), { ok: true, configured: false });
    const final = await fetch(`${baseUrl}/api/local/session-cookie`);
    assert.deepEqual(await final.json(), { ok: true, configured: false });
  });
});

test("local session cookie controls reject non-local origins and form posts", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const hostile = await fetch(`${baseUrl}/api/local/session-cookie`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example"
      },
      body: JSON.stringify({ cookie: "auth_token=attacker" })
    });
    assert.equal(hostile.status, 403);

    const formPost = await fetch(`${baseUrl}/api/local/session-cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "cookie=auth_token%3Dattacker"
    });
    assert.equal(formPost.status, 415);

    const status = await fetch(`${baseUrl}/api/local/session-cookie`);
    assert.deepEqual(await status.json(), { ok: true, configured: false });
  });
});

test("all local API routes reject a non-loopback Host before using server credentials", async () => {
  let upstreamCalls = 0;
  const app = createApp({
    config: { sessionDefaultCookie: "auth_token=server-secret" },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return jsonResponse({ code: 0, data: { list: [] } });
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/tasks`, {
      headers: { Origin: "https://attacker.example" }
    });
    assert.equal(response.status, 403);
    assert.equal(upstreamCalls, 0);
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
    },
    config: {
      mailboxDnsLookup: async () => [{ address: "93.184.216.34", family: 4 }]
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
    ),
    config: {
      mailboxDnsLookup: async () => [{ address: "93.184.216.34", family: 4 }]
    }
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

test("POST /api/subscription/email-check revalidates DNS after redirects", async () => {
  let fetchCount = 0;
  const app = createApp({
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://private.example/inbox" }
      });
    },
    config: {
      mailboxDnsLookup: async (hostname) => [{
        address: hostname === "private.example" ? "127.0.0.1" : "93.184.216.34",
        family: 4
      }]
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/email-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickupUrl: "https://mail.example.com/inbox/redirect" })
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.category, "invalid_url");
  });
  assert.equal(fetchCount, 1);
});

test("POST /api/subscription/email-check pins the validated DNS address for the request", async () => {
  const requestTargets = [];
  const app = createApp({
    config: {
      mailboxDnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      mailboxRequestImpl: async (_url, options, target) => {
        requestTargets.push({ options, target });
        return new Response("Your ChatGPT Plus subscription is active.", {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        });
      }
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/email-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickupUrl: "https://mail.example/inbox" })
    });
    assert.equal(response.status, 200);
    assert.equal(requestTargets.length, 1);
    assert.deepEqual(requestTargets[0].target, { address: "8.8.8.8", family: 4 });
  });
});

test("POST /api/subscription/email-check stops streamed responses above the byte limit", async () => {
  const app = createApp({
    fetchImpl: async () => new Response("x".repeat(64), {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    }),
    config: {
      mailboxDnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      maxMailboxResponseBytes: 16
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/subscription/email-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickupUrl: "https://mail.example.com/inbox/large" })
    });
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.category, "bad_response");
    assert.match(payload.error, /内容过大/);
  });
});
