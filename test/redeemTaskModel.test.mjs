import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWorkflowEvent,
  createInitialWorkflowState,
  getVisibleRows
} from "../src/workflow/redeemTaskModel.js";
import { createStatusReceivedEvent } from "../src/workflow/redeemEvents.js";

const REUSED_CDK = "AAAA-BBBB-CCCC-DDDD";

function reduceRows(rows, items, cdkeys = [REUSED_CDK], options = {}) {
  return getVisibleRows(
    applyWorkflowEvent(
      createInitialWorkflowState({ rows }),
      createStatusReceivedEvent({ cdkeys, items, ...options })
    )
  );
}

function pendingOwner(overrides = {}) {
  return {
    id: "current-row",
    cdkey: REUSED_CDK,
    status: "pending_dispatch",
    reason: "等待后台调度",
    statusOwner: true,
    statusLocked: false,
    autoCycleHandled: false,
    retryHoldUntil: Date.now() + 60_000,
    staleStatusGuard: true,
    ...overrides
  };
}

test("status update applies only to current owner of reused CDK", () => {
  const rows = [
    {
      id: "old-row",
      cdkey: REUSED_CDK,
      status: "failed",
      reason: "旧账号失败",
      statusOwner: false,
      statusLocked: true,
      autoCycleHandled: true
    },
    {
      id: "new-row",
      cdkey: REUSED_CDK,
      status: "pending_dispatch",
      reason: "等待后台调度",
      statusOwner: true,
      statusLocked: false,
      autoCycleHandled: false
    }
  ];

  const nextRows = reduceRows(rows, [
    {
      cdkey: REUSED_CDK,
      status: "success",
      reason: "兑换成功"
    }
  ]);

  assert.equal(nextRows[0].status, "failed");
  assert.equal(nextRows[0].reason, "旧账号失败");
  assert.equal(nextRows[0].statusOwner, false);
  assert.equal(nextRows[1].status, "success");
  assert.equal(nextRows[1].reason, "兑换成功");
  assert.equal(nextRows[1].statusOwner, true);
});

test("explicit cancelled backend result bypasses retry hold", () => {
  const rows = [pendingOwner()];
  const reason = "用户取消，CDK 可重新提交";

  const nextRows = reduceRows(rows, [
    {
      cdkey: REUSED_CDK,
      status: "failed",
      reason
    }
  ]);

  assert.equal(nextRows[0].status, "cancelled");
  assert.equal(nextRows[0].reason, reason);
  assert.equal(nextRows[0].retryHoldUntil, 0);
});

test("stale failed/cancelled cannot overwrite pending_dispatch during retry hold", () => {
  for (const status of ["failed", "cancelled"]) {
    const rows = [pendingOwner({ id: `row-${status}` })];

    const nextRows = reduceRows(rows, [
      {
        cdkey: REUSED_CDK,
        status,
        reason: `remote ${status}`
      }
    ]);

    assert.equal(nextRows[0].status, "pending_dispatch");
    assert.equal(nextRows[0].reason, "等待后台调度");
    assert.equal(nextRows[0].retryHoldUntil, rows[0].retryHoldUntil);
  }
});

test("running/success can overwrite pending_dispatch during retry hold", () => {
  for (const status of ["running", "success"]) {
    const rows = [pendingOwner({ id: `row-${status}` })];

    const nextRows = reduceRows(rows, [
      {
        cdkey: REUSED_CDK,
        status,
        reason: `remote ${status}`
      }
    ]);

    assert.equal(nextRows[0].status, status);
    assert.equal(nextRows[0].reason, `remote ${status}`);
    assert.equal(nextRows[0].retryHoldUntil, 0);
  }
});

test("status query treats missing backend items as unused CDKs", () => {
  const rows = [
    {
      id: "returned",
      cdkey: "RETURNED-CDK",
      status: "success",
      reason: "旧成功",
      statusOwner: true
    },
    {
      id: "missing",
      cdkey: "MISSING-CDK",
      status: "success",
      reason: "旧成功",
      email: "old@example.com",
      statusOwner: true
    }
  ];

  const nextRows = reduceRows(
    rows,
    [{ cdkey: "RETURNED-CDK", status: "success", reason: "兑换成功" }],
    ["RETURNED-CDK", "MISSING-CDK"],
    { missingAsUnused: true }
  );

  assert.equal(nextRows[0].status, "success");
  assert.equal(nextRows[1].status, "unused");
  assert.equal(nextRows[1].reason, "后端未返回该卡密，按未使用处理");
});

test("missing backend items do not change rows unless status query opts in", () => {
  const rows = [
    {
      id: "missing",
      cdkey: "MISSING-CDK",
      status: "success",
      reason: "旧成功",
      statusOwner: true
    }
  ];

  const nextRows = reduceRows(rows, [], ["MISSING-CDK"]);

  assert.equal(nextRows[0].status, "success");
  assert.equal(nextRows[0].reason, "旧成功");
});

test("missing backend items respect pending submit stale guard", () => {
  const rows = [pendingOwner({ cdkey: "MISSING-CDK" })];

  const nextRows = reduceRows(rows, [], ["MISSING-CDK"], { missingAsUnused: true });

  assert.equal(nextRows[0].status, "pending_dispatch");
  assert.equal(nextRows[0].reason, "等待后台调度");
});
