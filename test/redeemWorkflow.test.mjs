import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_EVENTS,
  createPollingStartedEvent,
  createRowsEvent,
  createStatusReceivedEvent
} from "../src/workflow/redeemEvents.js";
import {
  applyWorkflowEvent,
  createInitialWorkflowState
} from "../src/workflow/redeemTaskModel.js";

function reduce(events) {
  return events.reduce(
    applyWorkflowEvent,
    createInitialWorkflowState({
      rows: [{ id: "row-1", cdkey: "CDK-1", status: "local_ready", statusOwner: true }],
      now: 2_000_000
    })
  );
}

test("the same workflow event sequence always produces the same task state", () => {
  const submittingRows = [
    { id: "row-1", cdkey: "CDK-1", status: "submitting", statusOwner: true }
  ];
  const acceptedRows = [
    { id: "row-1", cdkey: "CDK-1", status: "pending_dispatch", statusOwner: true }
  ];
  const events = [
    createRowsEvent(WORKFLOW_EVENTS.SUBMIT_REQUESTED, submittingRows),
    createRowsEvent(WORKFLOW_EVENTS.SUBMIT_ACCEPTED, acceptedRows),
    createRowsEvent(WORKFLOW_EVENTS.AUTO_CYCLE_REQUESTED, acceptedRows),
    createRowsEvent(WORKFLOW_EVENTS.AUTO_CYCLE_SUBMITTED, acceptedRows)
  ];

  assert.deepEqual(reduce(events), reduce(events));
  assert.equal(reduce(events).rows[0].status, "pending_dispatch");
});

test("the reducer handles submit failure, retry, cancel, auto-cycle and cooldown row events", () => {
  const eventTypes = [
    WORKFLOW_EVENTS.SUBMIT_FAILED,
    WORKFLOW_EVENTS.RETRY_REQUESTED,
    WORKFLOW_EVENTS.CANCEL_REQUESTED,
    WORKFLOW_EVENTS.AUTO_CYCLE_REQUESTED,
    WORKFLOW_EVENTS.AUTO_CYCLE_SUBMITTED,
    WORKFLOW_EVENTS.ACCOUNT_COOLDOWN_STARTED
  ];

  for (const type of eventTypes) {
    const rows = [{ id: type, cdkey: "CDK-1", status: type.toLowerCase() }];
    const state = applyWorkflowEvent(
      createInitialWorkflowState(),
      createRowsEvent(type, rows)
    );
    assert.deepEqual(state.rows, rows, `${type} must be handled by the reducer`);
  }
});

test("an old polling generation cannot overwrite a newer attempt", () => {
  const started = applyWorkflowEvent(
    createInitialWorkflowState({
      rows: [{ id: "new-attempt", cdkey: "CDK-1", status: "pending_dispatch", statusOwner: true }]
    }),
    createPollingStartedEvent({ generation: 2 })
  );
  const staleResult = applyWorkflowEvent(
    started,
    createStatusReceivedEvent({
      cdkeys: ["CDK-1"],
      items: [{ cdkey: "CDK-1", status: "failed", reason: "old attempt" }],
      pollingGeneration: 1
    })
  );

  assert.equal(staleResult.rows[0].status, "pending_dispatch");
  assert.equal(staleResult.pollingGeneration, 2);
});
