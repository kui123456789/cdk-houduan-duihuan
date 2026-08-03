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
    emailPlusVerified: true,
    channel: "upi",
    redemptionTimestamp: "2026-07-17T08:09:10Z",
    timestamp: "2026-07-05T03:31:25Z",
    inputFormat: "email_pickup_url_at_timestamp",
    accessToken: "secret-at",
    exportLine: "url@example.com---https://mail.example/inbox---2026-07-05T03:31:25Z"
  };

  assert.equal(
    getPlusExportLine(row),
    "url@example.com---https://mail.example/inbox---2026-07-17T08:09:10Z"
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

test("getPlusExportLine refuses legacy rows without a backend redemption timestamp", () => {
  const row = {
    email: "legacy@example.com",
    password: "pw",
    twofa: "2fa",
    subscriptionTimestamp: "2026-07-05T03:31:25Z",
    status: "success",
    isPlus: true,
    emailPlusVerified: true,
    channel: "ideal"
  };

  assert.equal(
    getPlusExportLine(row),
    ""
  );
});

test("getSuccessExportsByPool exports supported rows by channel without AT", () => {
  const grouped = getSuccessExportsByPool([
    {
      email: "short@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "upi",
      redemptionTimestamp: "2026-07-17T08:09:10Z",
      exportLine: "short@example.com"
    },
    {
      email: "url@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "ideal",
      redemptionTimestamp: "2026-07-17T08:09:11Z",
      exportLine: "url@example.com---https://mail.example/inbox"
    },
    {
      email: "free@example.com",
      status: "success",
      isPlus: false,
      channel: "upi",
      exportLine: "free@example.com"
    }
  ]);

  assert.deepEqual(grouped, {
    upi: ["short@example.com---2026-07-17T08:09:10Z"],
    ideal: ["url@example.com---https://mail.example/inbox---2026-07-17T08:09:11Z"],
    pix: [],
    kakao: []
  });
});

test("getSuccessExportsByPool groups PIX and PIX VIP into the PIX export", () => {
  const grouped = getSuccessExportsByPool([
    {
      email: "pix@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "pix",
      redemptionTimestamp: "2026-07-17T08:09:10Z",
      exportLine: "pix@example.com"
    },
    {
      email: "pix-vip@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "pix_vip",
      redemptionTimestamp: "2026-07-17T08:09:11Z",
      exportLine: "pix-vip@example.com"
    }
  ]);

  assert.deepEqual(grouped.pix, [
    "pix@example.com---2026-07-17T08:09:10Z",
    "pix-vip@example.com---2026-07-17T08:09:11Z"
  ]);
});

test("getSuccessExportsByPool groups UPI and UPI VIP into the UPI export", () => {
  const grouped = getSuccessExportsByPool([
    {
      email: "upi@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "upi",
      redemptionTimestamp: "2026-07-17T08:09:10Z",
      exportLine: "upi@example.com"
    },
    {
      email: "upi-vip@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "upi_vip",
      redemptionTimestamp: "2026-07-17T08:09:11Z",
      exportLine: "upi-vip@example.com"
    }
  ]);

  assert.deepEqual(grouped.upi, [
    "upi@example.com---2026-07-17T08:09:10Z",
    "upi-vip@example.com---2026-07-17T08:09:11Z"
  ]);
});

test("getSuccessExportsByPool groups KAKAO and KAKAO VIP into a dedicated export", () => {
  const grouped = getSuccessExportsByPool([
    {
      email: "kakao@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "kakao",
      redemptionTimestamp: "2026-07-17T08:09:10Z",
      exportLine: "kakao@example.com"
    },
    {
      email: "kakao-vip@example.com",
      status: "success",
      isPlus: true,
      subscriptionStatus: "plus",
      emailPlusVerified: true,
      channel: "kakao_vip",
      redemptionTimestamp: "2026-07-17T08:09:11Z",
      exportLine: "kakao-vip@example.com"
    }
  ]);

  assert.deepEqual(grouped.kakao, [
    "kakao@example.com---2026-07-17T08:09:10Z",
    "kakao-vip@example.com---2026-07-17T08:09:11Z"
  ]);
});

test("getSuccessExportsByPool excludes Plus rows without verified mailbox evidence", () => {
  const grouped = getSuccessExportsByPool([
    {
      status: "success",
      isPlus: true,
      emailPlusVerified: false,
      channel: "upi",
      exportLine: "pending@example.com"
    }
  ]);

  assert.deepEqual(grouped, { upi: [], ideal: [], pix: [], kakao: [] });
});
