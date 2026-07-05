import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_EVENTS,
  createWorkflowEvent,
  createSubmitAcceptedEvent,
  createStatusReceivedEvent,
  createAccountCooldownEvent
} from "../src/workflow/redeemEvents.js";

test("createWorkflowEvent adds stable id and timestamp", () => {
  const event = createWorkflowEvent(WORKFLOW_EVENTS.SUBMIT_REQUESTED, {
    source: "start-button"
  });

  assert.equal(event.type, WORKFLOW_EVENTS.SUBMIT_REQUESTED);
  assert.equal(event.source, "start-button");
  assert.equal(typeof event.id, "string");
  assert.equal(typeof event.createdAt, "number");
});

test("createWorkflowEvent keeps reserved fields from payload overrides", () => {
  const event = createWorkflowEvent(WORKFLOW_EVENTS.SUBMIT_REQUESTED, {
    type: "bad",
    id: "bad",
    createdAt: 1
  });

  assert.equal(event.type, WORKFLOW_EVENTS.SUBMIT_REQUESTED);
  assert.notEqual(event.id, "bad");
  assert.equal(typeof event.id, "string");
  assert.notEqual(event.createdAt, 1);
  assert.equal(typeof event.createdAt, "number");
});

test("createWorkflowEvent rejects unknown event types", () => {
  assert.throws(
    () => createWorkflowEvent("unknown"),
    /Unknown workflow event type: unknown/
  );
});

test("createSubmitAcceptedEvent preserves submitted row ids and backend items", () => {
  const event = createSubmitAcceptedEvent({
    rowIds: ["row-1"],
    items: [{ cdkey: "AAAA-BBBB-CCCC-DDDD", status: "pending_dispatch" }],
    message: "提交完成"
  });

  assert.equal(event.type, WORKFLOW_EVENTS.SUBMIT_ACCEPTED);
  assert.deepEqual(event.rowIds, ["row-1"]);
  assert.equal(event.items[0].cdkey, "AAAA-BBBB-CCCC-DDDD");
  assert.equal(event.message, "提交完成");
});

test("createStatusReceivedEvent normalizes missing items to empty array", () => {
  const event = createStatusReceivedEvent({ cdkeys: ["A"], items: undefined });

  assert.equal(event.type, WORKFLOW_EVENTS.STATUS_RECEIVED);
  assert.deepEqual(event.cdkeys, ["A"]);
  assert.deepEqual(event.items, []);
});

test("createAccountCooldownEvent stores normalized email and reason", () => {
  const event = createAccountCooldownEvent({
    email: " User@Example.COM ",
    until: 1780000000000,
    reason: "今日提交次数已达上限"
  });

  assert.equal(event.type, WORKFLOW_EVENTS.ACCOUNT_COOLDOWN_STARTED);
  assert.equal(event.email, "user@example.com");
  assert.equal(event.until, 1780000000000);
  assert.equal(event.reason, "今日提交次数已达上限");
});
