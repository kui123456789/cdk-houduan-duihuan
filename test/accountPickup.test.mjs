import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichAccountLedgerPickupUrls,
  enrichRowsWithPickupUrls,
  extractPickupUrl
} from "../src/domain/accountPickup.js";

test("extractPickupUrl finds a mailbox URL in legacy account text", () => {
  assert.equal(
    extractPickupUrl("user@example.com---password---2fa---https://mail.example/show/user---timestamp"),
    "https://mail.example/show/user"
  );
});

test("legacy rows recover pickup URLs from current account input", () => {
  const rows = [{
    id: "row",
    email: "USER@example.com",
    accessToken: "same-token",
    pickupUrl: "",
    emailVerificationStatus: "missing_url",
    emailVerificationCategory: "missing_url"
  }];
  const accounts = [{
    email: "user@example.com",
    accessToken: "same-token",
    pickupUrl: "https://mail.example/show/user"
  }];

  const enriched = enrichRowsWithPickupUrls(rows, accounts);
  assert.notEqual(enriched, rows);
  assert.equal(enriched[0].pickupUrl, "https://mail.example/show/user");
  assert.equal(enriched[0].emailVerificationStatus, "idle");
});

test("legacy rows recover embedded pickup URLs without changing existing values", () => {
  const rows = [
    { id: "embedded", exportLine: "embedded@example.com---https://mail.example/show/embedded---old-time" },
    { id: "existing", pickupUrl: "https://mail.example/show/existing" }
  ];
  const enriched = enrichRowsWithPickupUrls(rows, []);
  assert.equal(enriched[0].pickupUrl, "https://mail.example/show/embedded");
  assert.equal(enriched[1], rows[1]);
});

test("legacy account history recovers pickup URLs for Plus attribution", () => {
  const ledger = {
    "history@example.com": {
      attempts: [],
      redemptionAttempts: [{ email: "history@example.com", accessToken: "history-token", pickupUrl: "" }]
    }
  };
  const enriched = enrichAccountLedgerPickupUrls(ledger, [{
    email: "history@example.com",
    accessToken: "history-token",
    pickupUrl: "https://mail.example/show/history"
  }]);

  assert.equal(
    enriched["history@example.com"].redemptionAttempts[0].pickupUrl,
    "https://mail.example/show/history"
  );
});

test("pickup enrichment keeps references when nothing can be recovered", () => {
  const rows = [{ id: "missing", email: "missing@example.com", pickupUrl: "" }];
  const ledger = { "missing@example.com": { attempts: [] } };
  assert.equal(enrichRowsWithPickupUrls(rows, []), rows);
  assert.equal(enrichAccountLedgerPickupUrls(ledger, []), ledger);
});
