import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlusExportLine,
  getSuccessExportsByPool
} from "../src/domain/exportFormatting.js";

test("getPlusExportLine prefers parser exportLine that already removes AT", () => {
  const row = {
    email: "url@example.com",
    status: "success",
    isPlus: true,
    channel: "upi",
    accessToken: "secret-at",
    exportLine: "url@example.com---https://mail.example/inbox---2026-07-05T03:31:25Z"
  };

  assert.equal(
    getPlusExportLine(row),
    "url@example.com---https://mail.example/inbox---2026-07-05T03:31:25Z"
  );
});

test("getPlusExportLine falls back to legacy fields for older rows", () => {
  const row = {
    email: "legacy@example.com",
    password: "pw",
    twofa: "2fa",
    subscriptionTimestamp: "2026-07-05T03:31:25Z",
    status: "success",
    isPlus: true,
    channel: "ideal"
  };

  assert.equal(
    getPlusExportLine(row),
    "legacy@example.com---pw---2fa---2026-07-05T03:31:25Z"
  );
});

test("getSuccessExportsByPool exports supported rows by channel without AT", () => {
  const grouped = getSuccessExportsByPool([
    {
      status: "success",
      isPlus: true,
      channel: "upi",
      exportLine: "short@example.com"
    },
    {
      status: "success",
      isPlus: true,
      channel: "ideal",
      exportLine: "url@example.com---https://mail.example/inbox"
    },
    {
      status: "success",
      isPlus: false,
      channel: "upi",
      exportLine: "free@example.com"
    }
  ]);

  assert.deepEqual(grouped, {
    upi: ["short@example.com"],
    ideal: ["url@example.com---https://mail.example/inbox"]
  });
});
