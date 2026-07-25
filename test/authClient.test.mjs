import assert from "node:assert/strict";
import test from "node:test";
import { createAuthApi } from "../src/services/authApi.js";

test("auth client keeps CSRF state in memory and applies it to logout", async () => {
  const requests = [];
  const api = createAuthApi({
    fetchImpl: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === "/api/auth/login") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { id: "user-1", username: "operator", role: "operator" },
            csrfToken: "csrf-memory-only"
          })
        };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    }
  });

  await api.login("operator", "not-a-real-password");
  assert.equal(api.getCsrfToken(), "csrf-memory-only");
  await api.logout();
  assert.equal(requests[1].options.headers["X-CSRF-Token"], "csrf-memory-only");
  assert.equal(api.getCsrfToken(), "");
  assert.equal(globalThis.localStorage, undefined);
});

test("auth client exposes bounded HTTP failures without retaining a CSRF token", async () => {
  const api = createAuthApi({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: "AUTHENTICATION_REQUIRED", message: "需要登录" })
    })
  });

  await assert.rejects(api.restore(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "AUTHENTICATION_REQUIRED");
    return true;
  });
  assert.equal(api.getCsrfToken(), "");
});
