import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeProxyPayloads,
  splitCdkeysByCredential,
  splitRowsByCredential
} from "../src/workflow/credentialRouting.js";

test("splitRowsByCredential keeps mixed rows together when a user key exists", () => {
  const rows = [
    { id: "account", sourceType: "account" },
    { id: "session", sourceType: "session" }
  ];

  assert.deepEqual(splitRowsByCredential(rows, { hasUserApiKey: true }), {
    groups: [{ credentialMode: "", rows }],
    blockedRows: []
  });
});

test("splitRowsByCredential allows only Session rows when the user key is empty", () => {
  const accountRow = { id: "account", sourceType: "account" };
  const sessionRow = { id: "session", sourceType: "session" };

  assert.deepEqual(
    splitRowsByCredential([accountRow, sessionRow], { hasUserApiKey: false }),
    {
      groups: [{ credentialMode: "session", rows: [sessionRow] }],
      blockedRows: [accountRow]
    }
  );
});

test("splitCdkeysByCredential prefers the current status owner", () => {
  const rows = [
    { id: "old", cdkey: "A", sourceType: "account", statusOwner: false },
    { id: "current", cdkey: "A", sourceType: "session", statusOwner: true },
    { id: "ordinary", cdkey: "B", sourceType: "account", statusOwner: true }
  ];

  assert.deepEqual(
    splitCdkeysByCredential(rows, ["A", "B", "C"], { hasUserApiKey: false }),
    {
      groups: [{ credentialMode: "session", cdkeys: ["A"] }],
      blockedCdkeys: ["B", "C"]
    }
  );
});

test("mergeProxyPayloads combines item and backend summaries", () => {
  assert.deepEqual(
    mergeProxyPayloads([
      {
        ok: true,
        batchCount: 1,
        items: [{ cdkey: "A" }],
        backend: {
          emptyResponse: false,
          emptyBatchCount: 0,
          itemCount: 1,
          batches: [{ itemCount: 1 }]
        }
      },
      {
        ok: true,
        batchCount: 2,
        items: [{ cdkey: "B" }],
        backend: {
          emptyResponse: true,
          emptyBatchCount: 2,
          itemCount: 0,
          batches: [{ itemCount: 0 }, { itemCount: 0 }]
        }
      }
    ]),
    {
      ok: true,
      batchCount: 3,
      items: [{ cdkey: "A" }, { cdkey: "B" }],
      backend: {
        emptyResponse: false,
        emptyBatchCount: 2,
        itemCount: 1,
        batches: [{ itemCount: 1 }, { itemCount: 0 }, { itemCount: 0 }]
      }
    }
  );
});
