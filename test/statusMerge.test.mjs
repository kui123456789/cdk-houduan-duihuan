import assert from "node:assert/strict";
import test from "node:test";
import {
  findStatusOwnerRowId,
  isExplicitCancelledStatus,
  markCdkeyStatusOwner,
  reviveRemoteBackendRows,
  shouldAcceptRemoteStatusDuringHold
} from "../src/state/statusMerge.js";

test("findStatusOwnerRowId prefers explicit statusOwner for a CDK", () => {
  const rows = [
    { id: "old-owner", cdkey: "CDK-1", statusOwner: false },
    { id: "explicit-owner", cdkey: "CDK-1", statusOwner: true },
    { id: "other-cdk", cdkey: "CDK-2", statusOwner: true }
  ];

  assert.equal(findStatusOwnerRowId(rows, "CDK-1"), "explicit-owner");
});

test("shouldAcceptRemoteStatusDuringHold blocks stale failed status during hold", () => {
  const now = 1000;
  const localRow = { staleStatusGuard: true, retryHoldUntil: now + 60000 };

  assert.equal(
    shouldAcceptRemoteStatusDuringHold(localRow, { cdkey: "CDK-1", status: "failed" }, now),
    false
  );
});

test("shouldAcceptRemoteStatusDuringHold accepts running success and moving statuses during hold", () => {
  const now = 1000;
  const localRow = { staleStatusGuard: true, retryHoldUntil: now + 60000 };

  ["queued", "dispatching", "running", "processing", "success"].forEach((status) => {
    assert.equal(
      shouldAcceptRemoteStatusDuringHold(localRow, { cdkey: "CDK-1", status }, now),
      true,
      status
    );
  });
});

test("explicit user cancelled status and reason bypass hold", () => {
  const now = 1000;
  const localRow = { staleStatusGuard: true, retryHoldUntil: now + 60000 };
  const remoteItem = {
    cdkey: "CDK-1",
    status: "failed",
    reason: "用户取消，CDK 可重新提交"
  };

  assert.equal(isExplicitCancelledStatus(remoteItem), true);
  assert.equal(shouldAcceptRemoteStatusDuringHold(localRow, remoteItem, now), true);
});

test("markCdkeyStatusOwner marks only the requested owner for the same CDK", () => {
  const rows = [
    { id: "older", cdkey: "CDK-1", statusOwner: true },
    { id: "next", cdkey: "CDK-1", statusOwner: false },
    { id: "other", cdkey: "CDK-2", statusOwner: true }
  ];

  assert.deepEqual(markCdkeyStatusOwner(rows, "next", "CDK-1"), [
    { id: "older", cdkey: "CDK-1", statusOwner: false },
    { id: "next", cdkey: "CDK-1", statusOwner: true },
    { id: "other", cdkey: "CDK-2", statusOwner: true }
  ]);
});

test("reviveRemoteBackendRows revives historical active backend rows as owners", () => {
  const rows = [
    {
      id: "active-history",
      cdkey: "CDK-1",
      status: "running",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    },
    {
      id: "failed-history",
      cdkey: "CDK-2",
      status: "failed",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    }
  ];

  assert.deepEqual(reviveRemoteBackendRows(rows), [
    {
      id: "active-history",
      cdkey: "CDK-1",
      status: "running",
      statusLocked: false,
      autoCycleHandled: false,
      statusOwner: true
    },
    {
      id: "failed-history",
      cdkey: "CDK-2",
      status: "failed",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    }
  ]);
});

test("reviveRemoteBackendRows does not revive historical success rows", () => {
  const rows = [
    {
      id: "success-history",
      cdkey: "CDK-1",
      status: "success",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    }
  ];

  assert.deepEqual(reviveRemoteBackendRows(rows), rows);
});

test("reviveRemoteBackendRows does not revive history when same CDK already has current owner", () => {
  const rows = [
    {
      id: "active-history",
      cdkey: "CDK-1",
      status: "running",
      statusLocked: true,
      autoCycleHandled: true,
      statusOwner: false
    },
    {
      id: "current-owner",
      cdkey: "CDK-1",
      status: "pending_dispatch",
      statusLocked: false,
      autoCycleHandled: false,
      statusOwner: true
    }
  ];

  assert.deepEqual(reviveRemoteBackendRows(rows), rows);
});
