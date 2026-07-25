import assert from "node:assert/strict";
import test from "node:test";
import {
  REDEEM_REQUEST_LIMITS,
  validateRedeemRequest
} from "../src/domain/redeemRequestValidation.js";

test("accepts valid submit and status request shapes", () => {
  assert.doesNotThrow(() => validateRedeemRequest("/api/redeem/submit", {
    apiKey: "user-key",
    items: [{ channel: "upi", cdkey: "CDK-1", access_token: "access-token" }]
  }));
  assert.doesNotThrow(() => validateRedeemRequest("/api/redeem/status", {
    credentialMode: "session",
    cdkeys: ["CDK-1"]
  }));
});

test("rejects non-plain objects, empty fields, and oversized batches", () => {
  assert.throws(
    () => validateRedeemRequest("/api/redeem/status", []),
    (error) => error.code === "INVALID_REQUEST"
  );
  assert.throws(
    () => validateRedeemRequest("/api/redeem/submit", { items: [new Date()] }),
    (error) => error.code === "INVALID_REQUEST"
  );
  assert.throws(
    () => validateRedeemRequest("/api/redeem/status", {
      apiKey: "key",
      cdkeys: Array.from({ length: REDEEM_REQUEST_LIMITS.maxItems + 1 }, (_, index) => `CDK-${index}`)
    }),
    (error) => error.code === "INVALID_REQUEST"
  );
  assert.throws(
    () => validateRedeemRequest("/api/redeem/submit", {
      apiKey: "key",
      items: [{ channel: "", cdkey: "CDK", access_token: "token" }]
    }),
    (error) => error.code === "INVALID_REQUEST"
  );
});

test("enforces field limits without including secret values in errors", () => {
  const oversizedToken = `secret-prefix-${"x".repeat(REDEEM_REQUEST_LIMITS.accessToken + 1)}`;
  assert.throws(
    () => validateRedeemRequest("/api/redeem/submit", {
      apiKey: "key",
      items: [{ channel: "upi", cdkey: "CDK", access_token: oversizedToken }]
    }),
    (error) => error.code === "INVALID_REQUEST" && !error.message.includes("secret-prefix")
  );
  assert.throws(
    () => validateRedeemRequest("/api/redeem/status", {
      apiKey: "k".repeat(REDEEM_REQUEST_LIMITS.apiKey + 1),
      cdkeys: ["CDK"]
    }),
    (error) => error.code === "INVALID_REQUEST"
  );
});
