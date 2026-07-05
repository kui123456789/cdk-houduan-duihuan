import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldApplySubscriptionResultToRow,
  shouldCheckSubscriptionRow,
  shouldAllowManualPlusRecheck,
  shouldQueueSubscriptionCheck,
  useSubscriptionChecks
} from "../src/hooks/useSubscriptionChecks.js";

test("only success rows with access token are subscription-check candidates", () => {
  const isHistoricalRow = (row) => row?.historical === true;

  assert.equal(shouldCheckSubscriptionRow({ status: "success", accessToken: "at" }), true);
  assert.equal(
    shouldCheckSubscriptionRow({
      status: "success",
      accessToken: "at",
      subscriptionStatus: "checking"
    }),
    true
  );
  assert.equal(shouldCheckSubscriptionRow({ status: "failed", accessToken: "at" }), false);
  assert.equal(shouldCheckSubscriptionRow({ status: "success", accessToken: "" }), false);
  assert.equal(
    shouldCheckSubscriptionRow(
      { status: "success", accessToken: "at", historical: true },
      { isHistoricalRow }
    ),
    false
  );
});

test("manual Plus recheck is allowed for successful rows with token", () => {
  const checkingRow = {
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  };

  assert.equal(shouldAllowManualPlusRecheck({ status: "success", accessToken: "at" }), true);
  assert.equal(shouldAllowManualPlusRecheck(checkingRow), true);
  assert.equal(shouldAllowManualPlusRecheck({ status: "success", accessToken: "" }), false);
});

test("checking subscription rows are not queued automatically unless forced", () => {
  const checkingRow = {
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  };

  assert.equal(shouldQueueSubscriptionCheck({ status: "success", accessToken: "at" }), true);
  assert.equal(shouldQueueSubscriptionCheck(checkingRow), false);
  assert.equal(shouldQueueSubscriptionCheck(checkingRow, { force: true }), true);
  assert.equal(
    shouldQueueSubscriptionCheck({ status: "failed", accessToken: "at" }, { force: true }),
    false
  );
});

test("subscription results apply only to successful rows with a matching token", () => {
  const checkedTokens = new Set(["shared"]);

  assert.equal(
    shouldApplySubscriptionResultToRow({ status: "success", accessToken: "shared" }, checkedTokens),
    true
  );
  assert.equal(
    shouldApplySubscriptionResultToRow({ status: "failed", accessToken: "shared" }, checkedTokens),
    false
  );
  assert.equal(
    shouldApplySubscriptionResultToRow({ status: "cancelled", accessToken: "shared" }, checkedTokens),
    false
  );
  assert.equal(
    shouldApplySubscriptionResultToRow({ status: "success", accessToken: "other" }, checkedTokens),
    false
  );
});

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSubscriptionChecker(checkSubscription, options = {}) {
  const rowsRef = { current: options.initialRows || [] };
  const committedRows = [];
  const checker = useSubscriptionChecks({
    redeemApiRef: {
      current: { checkSubscription }
    },
    subscriptionCacheRef: { current: new Map() },
    rowsRef,
    setRows: (nextRows) => committedRows.push(nextRows),
    setStatusMessage: () => {},
    isHistoricalRow: options.isHistoricalRow
  });

  return { ...checker, committedRows, rowsRef };
}

test("manual Plus recheck can force an in-flight success row", async () => {
  let callCount = 0;
  const checkingRow = {
    id: "checking",
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  };
  const { canRecheckSubscriptionRow, recheckPlusRows, rowsRef } = createSubscriptionChecker(
    async () => {
      callCount += 1;
      return { ok: true, plan_type: "free", has_active_subscription: false };
    },
    { initialRows: [checkingRow] }
  );

  assert.equal(canRecheckSubscriptionRow(checkingRow), true);

  await recheckPlusRows([checkingRow]);

  assert.equal(callCount, 1);
  assert.equal(rowsRef.current[0].subscriptionStatus, "not_plus");
});

test("automatic checks skip in-flight rows but forced checks can requeue them", async () => {
  let callCount = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(async () => {
    callCount += 1;
    return { ok: true, plan_type: "free", has_active_subscription: false };
  });
  const checkingRow = {
    id: "checking",
    status: "success",
    accessToken: "at",
    subscriptionStatus: "checking"
  };

  const automaticRows = await checkSubscriptionsForRows([checkingRow], { silent: true });
  assert.equal(callCount, 0);
  assert.equal(automaticRows[0].subscriptionStatus, "checking");

  const forcedRows = await checkSubscriptionsForRows([checkingRow], {
    silent: true,
    forceTokens: ["at"]
  });
  assert.equal(callCount, 1);
  assert.equal(forcedRows[0].subscriptionStatus, "not_plus");
});

test("checked subscription results do not update non-success rows with the same token", async () => {
  let callCount = 0;
  const { checkSubscriptionsForRows } = createSubscriptionChecker(async () => {
    callCount += 1;
    return { ok: true, plan_type: "plus", has_active_subscription: true };
  });
  const rows = [
    { id: "success", status: "success", accessToken: "shared" },
    {
      id: "failed",
      status: "failed",
      accessToken: "shared",
      subscriptionStatus: "failed_marker",
      subscriptionCategory: "kept",
      isPlus: false
    },
    { id: "cancelled", status: "cancelled", accessToken: "shared" }
  ];

  const checkedRows = await checkSubscriptionsForRows(rows, { silent: true });

  assert.equal(callCount, 1);
  assert.equal(checkedRows[0].subscriptionStatus, "plus");
  assert.equal(checkedRows[0].isPlus, true);
  assert.equal(checkedRows[1].subscriptionStatus, "failed_marker");
  assert.equal(checkedRows[1].subscriptionCategory, "kept");
  assert.equal(checkedRows[1].isPlus, false);
  assert.equal(checkedRows[2].subscriptionStatus, undefined);
});

test("historical successful rows are not marked checking or updated", async () => {
  let callCount = 0;
  const isHistoricalRow = (row) => row?.historical === true;
  const { checkSubscriptionsForRows, committedRows } = createSubscriptionChecker(
    async () => {
      callCount += 1;
      return { ok: true, plan_type: "plus", has_active_subscription: true };
    },
    { isHistoricalRow }
  );
  const rows = [
    { id: "history", status: "success", accessToken: "shared", historical: true },
    { id: "active", status: "success", accessToken: "shared" }
  ];

  const checkedRows = await checkSubscriptionsForRows(rows, { silent: true });

  assert.equal(callCount, 1);
  assert.equal(committedRows[0][0].subscriptionStatus, undefined);
  assert.equal(committedRows[0][1].subscriptionStatus, "checking");
  assert.equal(checkedRows[0].subscriptionStatus, undefined);
  assert.equal(checkedRows[0].isPlus, undefined);
  assert.equal(checkedRows[1].subscriptionStatus, "plus");
  assert.equal(checkedRows[1].isPlus, true);
});

test("async subscription results do not revive rows cleared during the request", async () => {
  const requestDone = createDeferred();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const { checkSubscriptionsForRows, rowsRef } = createSubscriptionChecker(async () => {
    requestStarted();
    await requestDone.promise;
    return { ok: true, plan_type: "plus", has_active_subscription: true };
  });

  const checkPromise = checkSubscriptionsForRows(
    [{ id: "success", status: "success", accessToken: "at" }],
    { silent: true }
  );
  await started;
  assert.equal(rowsRef.current[0].subscriptionStatus, "checking");

  rowsRef.current = [];
  requestDone.resolve();
  const checkedRows = await checkPromise;

  assert.deepEqual(checkedRows, []);
  assert.deepEqual(rowsRef.current, []);
});

test("async subscription results do not overwrite rows that became failed", async () => {
  const requestDone = createDeferred();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const { checkSubscriptionsForRows, rowsRef } = createSubscriptionChecker(async () => {
    requestStarted();
    await requestDone.promise;
    return { ok: true, plan_type: "plus", has_active_subscription: true };
  });

  const checkPromise = checkSubscriptionsForRows(
    [{ id: "success", status: "success", accessToken: "at" }],
    { silent: true }
  );
  await started;
  rowsRef.current = [
    {
      id: "success",
      status: "failed",
      accessToken: "at",
      reason: "用户已清理或状态已变化"
    }
  ];

  requestDone.resolve();
  const checkedRows = await checkPromise;

  assert.equal(checkedRows[0].status, "failed");
  assert.equal(checkedRows[0].subscriptionStatus, undefined);
  assert.equal(checkedRows[0].isPlus, undefined);
});
