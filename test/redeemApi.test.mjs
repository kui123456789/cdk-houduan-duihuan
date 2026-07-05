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
