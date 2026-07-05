import assert from "node:assert/strict";
import test from "node:test";
import { buildActivityLogEntries } from "../src/components/common/activityLogEntries.js";

function createRealEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `log-${index}`,
    createdAt: 1_780_000_000_000 - index,
    level: "info",
    action: "status",
    message: `状态 ${index}`
  }));
}

function createErrors(count) {
  return Array.from({ length: count }, (_, index) => ({
    lineNumber: index + 1,
    reason: `校验问题 ${index + 1}`,
    source: `line-${index + 1}`
  }));
}

test("buildActivityLogEntries keeps real activity entries visible when many errors exist", () => {
  const visibleEntries = buildActivityLogEntries({
    entries: createRealEntries(5),
    errors: createErrors(25)
  });

  assert.equal(visibleEntries.length, 14);
  assert.equal(visibleEntries.filter((entry) => entry.id.startsWith("log-")).length, 5);
  assert.equal(visibleEntries.filter((entry) => entry.id.startsWith("synthetic-error-")).length, 9);
  assert.equal(visibleEntries.at(-1).message, "另 17 条校验/预检问题");
});

test("buildActivityLogEntries uses stable synthetic ids and timestamps", () => {
  const input = {
    entries: [],
    errors: createErrors(3),
    statusMessage: "等待输入账号和 CDK",
    lastUpdatedAt: "12:00:00"
  };

  const first = buildActivityLogEntries(input);
  const second = buildActivityLogEntries(input);

  assert.deepEqual(
    second.map((entry) => [entry.id, entry.createdAt]),
    first.map((entry) => [entry.id, entry.createdAt])
  );
});
