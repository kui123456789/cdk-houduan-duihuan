import assert from "node:assert/strict";
import test from "node:test";
import {
  createRestartablePollingController,
  createSerializedPollingRunner
} from "../src/domain/serializedPolling.js";
import {
  retryDelayedStatusItems,
  runAutomaticRetryBeforeAutoCycle,
  startPollingWithLease,
  shouldForceRemoteStatus
} from "../src/hooks/useRedeemPolling.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("serialized polling coalesces overlapping refreshes into one follow-up", async () => {
  const first = deferred();
  const events = [];
  let callCount = 0;
  const runner = createSerializedPollingRunner(async () => {
    callCount += 1;
    events.push(`start-${callCount}`);
    if (callCount === 1) await first.promise;
    events.push(`end-${callCount}`);
  });

  const initial = runner.refresh();
  runner.refresh();
  runner.refresh();
  assert.equal(callCount, 1);

  first.resolve();
  await initial;
  assert.equal(callCount, 2);
  assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2"]);
});

test("serialized polling stops queued work after disposal", async () => {
  const first = deferred();
  let callCount = 0;
  const runner = createSerializedPollingRunner(async () => {
    callCount += 1;
    await first.promise;
  });

  const initial = runner.refresh();
  runner.refresh();
  runner.dispose();
  first.resolve();
  await initial;
  assert.equal(callCount, 1);
});

test("restartable polling starts a fresh runner after an effect cleanup", async () => {
  let callCount = 0;
  const controller = createRestartablePollingController(async () => {
    callCount += 1;
  });

  await controller.start();
  controller.dispose();
  await controller.start();

  assert.equal(callCount, 2);
});

test("unresolved polling status stays unknown instead of becoming unused", async () => {
  const result = await retryDelayedStatusItems({
    cdkeys: ["CDK-PENDING"],
    items: [],
    queryStatus: async () => ({ items: [] }),
    maxRetries: 1,
    delayMs: 0
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].cdkey, "CDK-PENDING");
  assert.equal(result.items[0].status, "unknown");
  assert.equal(result.items[0].found, false);
  assert.match(result.items[0].reason, /状态无法确认/);
});

test("polling does not start when another tab owns the lease", () => {
  let startCount = 0;
  const result = startPollingWithLease({
    lease: { acquire: () => false, release: () => {} },
    controller: {
      start: () => {
        startCount += 1;
        return { started: true, session: 1 };
      }
    },
    cdkeys: ["CDK-A"]
  });

  assert.deepEqual(result, { started: false, reason: "lease_unavailable" });
  assert.equal(startCount, 0);
});

test("polling releases the lease when the controller cannot start", () => {
  let releaseCount = 0;
  const result = startPollingWithLease({
    lease: { acquire: () => true, release: () => { releaseCount += 1; } },
    controller: { start: () => ({ started: false, session: 2 }) },
    cdkeys: []
  });

  assert.equal(result.started, false);
  assert.equal(releaseCount, 1);
});

test("status polling retries the backend job before considering account switching", async () => {
  const failedRow = {
    id: "failed-1",
    cdkey: "CDK-RETRY",
    status: "failed",
    can_retry: true,
    can_reuse_token: true,
    has_access_token: true
  };
  const pendingRow = {
    ...failedRow,
    status: "pending_dispatch",
    can_retry: false
  };
  const rowsRef = { current: [failedRow] };
  const events = [];

  const result = await runAutomaticRetryBeforeAutoCycle({
    rows: [failedRow],
    rowsRef,
    automaticRetryRef: {
      current: async () => {
        events.push("retry");
        rowsRef.current = [pendingRow];
      }
    },
    scheduleAutoCycleFailures: (rows) => {
      events.push(`cycle:${rows[0].status}`);
    }
  });

  assert.deepEqual(events, ["retry", "cycle:pending_dispatch"]);
  assert.deepEqual(result, [pendingRow]);
});

test("a force query started before retry cannot overwrite the newer retry guard", () => {
  const queryStartedAt = 10_000;
  const rows = [
    {
      cdkey: "CDK-RETRY",
      status: "pending_dispatch",
      staleStatusGuard: true,
      staleStatusGuardStartedAt: queryStartedAt + 1
    }
  ];

  assert.equal(
    shouldForceRemoteStatus({
      forceRemote: true,
      rows,
      cdkeys: ["CDK-RETRY"],
      queryStartedAt
    }),
    false
  );
  assert.equal(
    shouldForceRemoteStatus({
      forceRemote: true,
      rows,
      cdkeys: ["OTHER-CDK"],
      queryStartedAt
    }),
    true
  );
});
