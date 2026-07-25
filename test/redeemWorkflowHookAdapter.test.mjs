import test from "node:test";
import assert from "node:assert/strict";
import { createRedeemWorkflowActions } from "../src/hooks/useRedeemWorkflow.js";
import { WORKFLOW_EVENTS } from "../src/workflow/redeemEvents.js";

const ACTION_NAMES = [
  "submitRedeems",
  "queryStatuses",
  "startPolling",
  "stopPolling",
  "retryRows",
  "cancelRows",
  "checkPlus"
];

function createActionHarness() {
  const events = [];
  const state = { rows: [{ id: "row-1" }] };
  const actions = createRedeemWorkflowActions({
    getState: () => state,
    dispatch: (event) => events.push(event),
    api: {},
    clock: () => 1780000000000
  });

  return { actions, events, state };
}

test("createRedeemWorkflowActions exposes the workflow action surface", () => {
  const { actions } = createActionHarness();

  for (const actionName of ACTION_NAMES) {
    assert.equal(typeof actions[actionName], "function");
  }
});

test("submitRedeems dispatches a submit requested intent with injected timestamp", async () => {
  const { actions, events } = createActionHarness();
  const input = { cdkeys: ["AAAA-BBBB-CCCC-DDDD"] };

  await actions.submitRedeems(input);

  assert.deepEqual(events, [
    { type: WORKFLOW_EVENTS.SUBMIT_REQUESTED, input, createdAt: 1780000000000 }
  ]);
});

test("createRedeemWorkflowActions defaults to Date.now when clock is omitted", async () => {
  const events = [];
  const originalNow = Date.now;
  Date.now = () => 1790000000000;
  try {
    const actions = createRedeemWorkflowActions({
      getState: () => ({ rows: [] }),
      dispatch: (event) => events.push(event),
      api: {}
    });

    await actions.submitRedeems({ cdkeys: ["AAAA-BBBB-CCCC-DDDD"] });
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(events, [
    {
      type: WORKFLOW_EVENTS.SUBMIT_REQUESTED,
      input: { cdkeys: ["AAAA-BBBB-CCCC-DDDD"] },
      createdAt: 1790000000000
    }
  ]);
});

test("queryStatuses dispatches a status query intent with options", async () => {
  const { actions, events } = createActionHarness();
  const cdkeys = ["AAAA-BBBB-CCCC-DDDD"];
  const options = { silent: true };

  await actions.queryStatuses(cdkeys, options);

  assert.deepEqual(events, [
    { type: WORKFLOW_EVENTS.STATUS_QUERY_REQUESTED, cdkeys, options, createdAt: 1780000000000 }
  ]);
});

test("startPolling dispatches a polling started intent with options", () => {
  const { actions, events } = createActionHarness();
  const cdkeys = ["AAAA-BBBB-CCCC-DDDD"];
  const options = { intervalMs: 5000 };

  actions.startPolling(cdkeys, options);

  assert.deepEqual(events, [
    { type: WORKFLOW_EVENTS.POLLING_STARTED, cdkeys, options, createdAt: 1780000000000 }
  ]);
});

test("stopPolling dispatches a polling stopped intent with options", () => {
  const { actions, events } = createActionHarness();
  const options = { reason: "manual" };

  actions.stopPolling(options);

  assert.deepEqual(events, [
    { type: WORKFLOW_EVENTS.POLLING_STOPPED, options, createdAt: 1780000000000 }
  ]);
});

test("retryRows dispatches a retry requested intent with options", async () => {
  const { actions, events } = createActionHarness();
  const rows = [{ id: "row-1", cdkey: "AAAA-BBBB-CCCC-DDDD" }];
  const options = { clearSelection: true };

  await actions.retryRows(rows, options);

  assert.deepEqual(events, [
    { type: WORKFLOW_EVENTS.RETRY_REQUESTED, rows, options, createdAt: 1780000000000 }
  ]);
});

test("cancelRows dispatches a cancel requested intent with options", async () => {
  const { actions, events } = createActionHarness();
  const rows = [{ id: "row-1", cdkey: "AAAA-BBBB-CCCC-DDDD" }];
  const options = { source: "toolbar" };

  await actions.cancelRows(rows, options);

  assert.deepEqual(events, [
    { type: WORKFLOW_EVENTS.CANCEL_REQUESTED, rows, options, createdAt: 1780000000000 }
  ]);
});

test("checkPlus dispatches a plus check requested intent with options", async () => {
  const { actions, events } = createActionHarness();
  const rows = [{ id: "row-1", accessToken: "token" }];
  const options = { refresh: true };

  await actions.checkPlus(rows, options);

  assert.deepEqual(events, [
    { type: WORKFLOW_EVENTS.PLUS_CHECK_STARTED, rows, options, createdAt: 1780000000000 }
  ]);
});
