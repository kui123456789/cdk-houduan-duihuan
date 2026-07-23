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

test("getPlusExportLine replaces the imported timestamp with the redemption timestamp", () => {
  const row = {
    email: "redeemed@example.com",
    password: "pw",
    twofa: "2fa",
    timestamp: "2026-07-05T03:31:25Z",
    redemptionTimestamp: "2026-07-17T08:09:10Z",
    inputFormat: "legacy_5",
    exportLine: "redeemed@example.com---pw---2fa---2026-07-05T03:31:25Z"
  };

  assert.equal(
    getPlusExportLine(row),
    "redeemed@example.com---pw---2fa---2026-07-17T08:09:10Z"
  );
});

test("getPlusExportLine appends the redemption timestamp when import had no timestamp", () => {
  const row = {
    email: "notime@example.com",
    pickupUrl: "https://mail.example/inbox/notime",
    redemptionTimestamp: "2026-07-17T08:09:10Z",
    inputFormat: "email_pickup_url_at",
    exportLine: "notime@example.com---https://mail.example/inbox/notime"
  };

  assert.equal(
    getPlusExportLine(row),
    "notime@example.com---https://mail.example/inbox/notime---2026-07-17T08:09:10Z"
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
    ideal: ["url@example.com---https://mail.example/inbox"],
    pix: []
  });
});

test("getSuccessExportsByPool groups PIX and PIX VIP into the PIX export", () => {
  const grouped = getSuccessExportsByPool([
    {
      status: "success",
      isPlus: true,
      channel: "pix",
      exportLine: "pix@example.com"
    },
    {
      status: "success",
      isPlus: true,
      channel: "pix_vip",
      exportLine: "pix-vip@example.com"
    }
  ]);

  assert.deepEqual(grouped.pix, ["pix@example.com", "pix-vip@example.com"]);
});

test("getSuccessExportsByPool groups UPI and UPI VIP into the UPI export", () => {
  const grouped = getSuccessExportsByPool([
    {
      status: "success",
      isPlus: true,
      channel: "upi",
      exportLine: "upi@example.com"
    },
    {
      status: "success",
      isPlus: true,
      channel: "upi_vip",
      exportLine: "upi-vip@example.com"
    }
  ]);

  assert.deepEqual(grouped.upi, ["upi@example.com", "upi-vip@example.com"]);
});
