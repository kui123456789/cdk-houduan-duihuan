import assert from "node:assert/strict";
import test from "node:test";
import * as redeemLogic from "../src/redeemLogic.js";

test("redeemLogic facade preserves legacy exports without leaking subscription internals", () => {
  [
    "CDK_POOLS",
    "DELIMITER",
    "EXTERNAL_STATUSES",
    "FAILED_RETRY_STATUSES",
    "MAX_BATCH_SIZE",
    "NON_RETRYABLE_STATUSES",
    "STATUS_META",
    "appendImportedText",
    "buildContinuationSubmitRows",
    "buildQueryRows",
    "buildSubmitRows",
    "canCancelRow",
    "canRetryFailedRow",
    "canRetryRow",
    "countStatuses",
    "createEmptySubscriptionState",
    "createRedeemRow",
    "getPlusExportLine",
    "getSubscriptionLabel",
    "getSuccessExportsByPool",
    "inspectAccountText",
    "isTerminalStatus",
    "mergeStatusRows",
    "normalizeAccountText",
    "normalizeRemoteStatus",
    "normalizeStatusItem",
    "normalizeSubscriptionError",
    "normalizeSubscriptionResult",
    "parseAccounts",
    "parseCdkeyPools",
    "parseCdkeys",
    "shouldHoldRetryStatus",
    "statusLabel"
  ].forEach((exportName) => {
    assert.ok(exportName in redeemLogic, `${exportName} should be exported`);
  });

  assert.equal("SUBSCRIPTION_DIAGNOSTIC_META" in redeemLogic, false);
});
