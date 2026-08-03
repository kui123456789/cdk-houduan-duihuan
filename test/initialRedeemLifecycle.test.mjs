import assert from "node:assert/strict";
import test from "node:test";
import { claimInitialStatusSync } from "../src/hooks/useInitialRedeemLifecycle.js";

test("claimInitialStatusSync allows only the first StrictMode effect setup", () => {
  const startedRef = { current: false };

  assert.equal(claimInitialStatusSync(startedRef), true);
  assert.equal(claimInitialStatusSync(startedRef), false);
  assert.equal(startedRef.current, true);
});
