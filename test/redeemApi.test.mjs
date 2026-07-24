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

test("callProxy throws when API key is missing", async () => {
  const api = createRedeemApi({ getApiKey: () => "" });
  await assert.rejects(() => api.queryStatuses(["A"]), /请先填写外部 API Key/);
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
