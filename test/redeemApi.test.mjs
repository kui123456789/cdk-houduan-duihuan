import assert from "node:assert/strict";
import test from "node:test";
import { createRedeemApi } from "../src/services/redeemApi.js";

test("callProxy sends API key and JSON body to local proxy", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "secret",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.queryStatuses(["A"]);
  assert.equal(request.path, "/api/redeem/status");
  assert.deepEqual(JSON.parse(request.options.body), { apiKey: "secret", cdkeys: ["A"] });
});

test("callProxy allows the server credential when the browser API key is missing", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.queryStatuses(["A"]);
  assert.deepEqual(JSON.parse(request.options.body), { cdkeys: ["A"] });
});

test("callProxy allows Session credential mode without a browser API key", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.callProxy(
    "/api/redeem/status",
    { cdkeys: ["A"] },
    { credentialMode: "session" }
  );

  assert.deepEqual(JSON.parse(request.options.body), {
    credentialMode: "session",
    cdkeys: ["A"]
  });
});

test("callProxy keeps a user API key when Session mode is requested", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "user-key",
    fetchImpl: async (_path, options) => {
      request = options;
      return {
        ok: true,
        json: async () => ({ ok: true, items: [] })
      };
    }
  });

  await api.callProxy(
    "/api/redeem/status",
    { cdkeys: ["A"] },
    { credentialMode: "session" }
  );

  assert.deepEqual(JSON.parse(request.body), {
    apiKey: "user-key",
    credentialMode: "session",
    cdkeys: ["A"]
  });
});

test("subscription check does not require external API key", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, category: "not_plus" })
      };
    }
  });

  await api.checkSubscription("token-1");
  assert.equal(request.path, "/api/subscription/check");
  assert.deepEqual(JSON.parse(request.options.body), { token: "token-1" });
});

test("Session refresh sends only the sessionToken to the local proxy", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          accessToken: "new-at",
          sessionToken: "rotated-session",
          session_rotated: true
        })
      };
    }
  });

  const result = await api.refreshSession("old-session");
  assert.equal(request.path, "/api/subscription/session-refresh");
  assert.deepEqual(JSON.parse(request.options.body), { sessionToken: "old-session" });
  assert.equal(result.accessToken, "new-at");
  assert.equal(result.sessionToken, "rotated-session");
});

test("email Plus check sends the pickup URL and redemption time without an API key", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, category: "verified" })
      };
    }
  });

  await api.checkPlusEmail("https://mail.example.com/inbox/code", "2026-07-23T10:00:00Z");
  assert.equal(request.path, "/api/subscription/email-check");
  assert.deepEqual(JSON.parse(request.options.body), {
    pickupUrl: "https://mail.example.com/inbox/code",
    redeemedAt: "2026-07-23T10:00:00Z"
  });
});

test("queue summary uses a same-origin GET without an API key", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ code: 0, data: { vip_queue_count: 2 } })
      };
    }
  });

  const payload = await api.getQueueSummary();
  assert.equal(request.path, "/api/redeem/tasks/queue-summary");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.deepEqual(payload.data, { vip_queue_count: 2 });
});

test("local Cookie controls use the local backend without returning the Cookie", async () => {
  const requests = [];
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      requests.push({ path, options });
      return { ok: true, json: async () => ({ ok: true, configured: true }) };
    }
  });

  await api.updateLocalSessionCookie("cookie-value");
  await api.getLocalSessionCookieStatus();
  await api.clearLocalSessionCookie();
  assert.equal(requests[0].path, "/api/local/session-cookie");
  assert.deepEqual(JSON.parse(requests[0].options.body), { cookie: "cookie-value" });
  assert.equal(requests[1].options.method, "GET");
  assert.equal(requests[2].options.method, "DELETE");
});

test("local backend credentials send session and device headers only to the local server", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return { ok: true, json: async () => ({ ok: true, configured: true }) };
    }
  });

  await api.updateLocalSessionCredential({
    cookie: "auth_token=cookie-value",
    sessionToken: "session-token",
    deviceId: "device-id"
  });
  assert.equal(request.path, "/api/local/session-cookie");
  assert.deepEqual(JSON.parse(request.options.body), {
    cookie: "auth_token=cookie-value",
    sessionToken: "session-token",
    deviceId: "device-id"
  });
});

test("redeem task list uses the paginated same-origin GET", async () => {
  let request;
  const api = createRedeemApi({
    getApiKey: () => "user-key",
    fetchImpl: async (path, options) => {
      request = { path, options };
      return {
        ok: true,
        json: async () => ({ ok: true, data: { list: [], pagination: { total: 0 } } })
      };
    }
  });

  const payload = await api.getRedeemTasks({ page: 2, pageSize: 50 });
  assert.equal(request.path, "/api/redeem/tasks?page=2&page_size=50");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.headers["X-External-Api-Key"], "user-key");
  assert.equal(payload.data.pagination.total, 0);
});
