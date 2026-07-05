import assert from "node:assert/strict";
import test from "node:test";
import {
  getAutoCycleQueueKey,
  mergeAccountsIntoAutoCycleQueue,
  normalizeAutoCycleState
} from "../src/state/redeemWorkflow.js";

test("auto-cycle queue refreshes same email when access token changes", () => {
  const state = normalizeAutoCycleState({
    enabled: true,
    currentRound: 1,
    queue: [
      {
        email: "user@example.com",
        password: "pw",
        twofa: "2fa",
        accessToken: "old-token",
        timestamp: "old-time",
        source: "user@example.com---pw---2fa---old-token---old-time"
      }
    ]
  });
  const beforeKey = getAutoCycleQueueKey(state.queue);

  const next = mergeAccountsIntoAutoCycleQueue(
    state,
    [
      {
        email: "USER@example.com",
        password: "pw",
        twofa: "2fa",
        accessToken: "new-token",
        timestamp: "new-time",
        source: "USER@example.com---pw---2fa---new-token---new-time"
      }
    ],
    { addedRound: 1 }
  );

  assert.equal(next.queue.length, 1);
  assert.equal(next.queue[0].email, "user@example.com");
  assert.equal(next.queue[0].accessToken, "new-token");
  assert.equal(next.queue[0].timestamp, "new-time");
  assert.notEqual(getAutoCycleQueueKey(next.queue), beforeKey);
});

test("auto-cycle queue keeps existing email order when refreshing details", () => {
  const state = normalizeAutoCycleState({
    enabled: true,
    currentRound: 1,
    queue: [
      { email: "first@example.com", accessToken: "first-token" },
      { email: "second@example.com", accessToken: "old-second-token" }
    ]
  });

  const next = mergeAccountsIntoAutoCycleQueue(
    state,
    [
      { email: "second@example.com", accessToken: "new-second-token" },
      { email: "third@example.com", accessToken: "third-token" }
    ],
    { addedRound: 1 }
  );

  assert.deepEqual(
    next.queue.map((account) => account.email),
    ["first@example.com", "second@example.com", "third@example.com"]
  );
  assert.equal(next.queue[1].accessToken, "new-second-token");
});
