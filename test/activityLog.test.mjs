import assert from "node:assert/strict";
import test from "node:test";
import {
  appendActivityLog,
  compactActivityLog,
  formatActivityLogMessage
} from "../src/workflow/activityLog.js";

test("appendActivityLog keeps newest entries first and caps length", () => {
  let log = [];
  for (let index = 0; index < 105; index += 1) {
    log = appendActivityLog(
      log,
      {
        createdAt: 1_780_000_000_000 + index,
        level: "info",
        action: "status",
        message: `状态 ${index}`
      },
      { now: 1_780_000_000_000 + index, random: () => index / 1000 }
    );
  }

  assert.equal(log.length, 100);
  assert.equal(log[0].message, "状态 104");
  assert.equal(log.at(-1).message, "状态 5");
});

test("formatActivityLogMessage includes email, masked CDK first/last, and message", () => {
  const message = formatActivityLogMessage({
    id: "log-1",
    createdAt: 1_780_000_000_000,
    level: "success",
    action: "submit",
    email: "a@example.com",
    cdkey: "XSKX-GTQT-PX62-BLRN",
    message: "自动换号提交 1 条"
  });

  assert.equal(message, "a@example.com · XSKX...BLRN · 自动换号提交 1 条");
});

test("compactActivityLog removes invalid entries", () => {
  const log = compactActivityLog([
    null,
    { id: "bad-message", createdAt: 1, level: "info", action: "status", message: "" },
    { id: "bad-level", createdAt: 2, level: "debug", action: "status", message: "no" },
    { id: "bad-action", createdAt: 3, level: "info", action: "unknown", message: "no" },
    { id: "good", createdAt: 4, level: "info", action: "status", message: "yes" }
  ]);

  assert.deepEqual(
    log.map((entry) => entry.id),
    ["good"]
  );
});

test("warnings and errors preserve level and empty messages are removed", () => {
  const log = compactActivityLog([
    { id: "warning", createdAt: 10, level: "warning", action: "validation", message: "检查输入" },
    { id: "empty", createdAt: 11, level: "error", action: "validation", message: "   " },
    { id: "error", createdAt: 12, level: "error", action: "submit", message: "提交失败" }
  ]);

  assert.deepEqual(
    log.map((entry) => [entry.id, entry.level]),
    [
      ["error", "error"],
      ["warning", "warning"]
    ]
  );
});
