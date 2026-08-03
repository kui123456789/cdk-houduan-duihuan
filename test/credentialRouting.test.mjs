import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionRowsByConfirmedPayload,
  mergeProxyPayloads,
  splitCdkeysByCredential,
  splitRowsByCredential
} from "../src/workflow/credentialRouting.js";

test("partitionRowsByConfirmedPayload keeps empty and found-only responses unconfirmed", () => {
  const rows = [
    { id: "a", cdkey: "CDK-A" },
    { id: "b", cdkey: "CDK-B" }
  ];

  assert.deepEqual(
    partitionRowsByConfirmedPayload(rows, { items: [] }),
    { confirmedRows: [], unconfirmedRows: rows, confirmedCdkeys: [], confirmedItems: [] }
  );
  assert.deepEqual(
    partitionRowsByConfirmedPayload(rows, { items: [{ cdkey: "CDK-A", found: true }] }),
    { confirmedRows: [], unconfirmedRows: rows, confirmedCdkeys: [], confirmedItems: [] }
  );
});

test("partitionRowsByConfirmedPayload confirms only matching items with an explicit outcome", () => {
  const rows = [
    { id: "a", cdkey: "CDK-A" },
    { id: "b", cdkey: "CDK-B" }
  ];
  const result = partitionRowsByConfirmedPayload(rows, {
    items: [
      { cdkey: "CDK-A", status: "queued" },
      { cdkey: "OTHER", success: true }
    ]
  });

  assert.deepEqual(result.confirmedRows, [rows[0]]);
  assert.deepEqual(result.unconfirmedRows, [rows[1]]);
  assert.deepEqual(result.confirmedCdkeys, ["CDK-A"]);
  assert.deepEqual(result.confirmedItems, [{ cdkey: "CDK-A", status: "queued" }]);
});

test("submit confirmation rejects a bare failed result that never created a task", () => {
  const rows = [{ id: "a", cdkey: "CDK-A" }];
  const failedItem = { cdkey: "CDK-A", status: "failed", reason: "invalid access token" };
  const result = partitionRowsByConfirmedPayload(rows, { items: [failedItem] }, { mode: "submit" });

  assert.deepEqual(result.confirmedRows, []);
  assert.deepEqual(result.unconfirmedRows, rows);
  assert.deepEqual(result.confirmedItems, []);
});

test("submit confirmation accepts queued and task-backed failed results", () => {
  const rows = [
    { id: "a", cdkey: "CDK-A" },
    { id: "b", cdkey: "CDK-B" }
  ];
  const items = [
    { cdkey: "CDK-A", status: "queued" },
    { id: "task-b", cdkey: "CDK-B", status: "failed" }
  ];
  const result = partitionRowsByConfirmedPayload(rows, { items }, { mode: "submit" });

  assert.deepEqual(result.confirmedRows, rows);
  assert.deepEqual(result.unconfirmedRows, []);
  assert.deepEqual(result.confirmedItems, items);
});

test("generic action confirmation still accepts explicit failed and cancelled outcomes", () => {
  const rows = [
    { id: "a", cdkey: "CDK-A" },
    { id: "b", cdkey: "CDK-B" }
  ];
  const result = partitionRowsByConfirmedPayload(rows, {
    items: [
      { cdkey: "CDK-A", status: "failed" },
      { cdkey: "CDK-B", status: "cancelled" }
    ]
  });

  assert.deepEqual(result.confirmedRows, rows);
  assert.deepEqual(result.unconfirmedRows, []);
});

test("retry confirmation accepts re-queued jobs and rejects explicit retry refusal", () => {
  const rows = [
    { id: "a", cdkey: "CDK-A" },
    { id: "b", cdkey: "CDK-B" }
  ];
  const result = partitionRowsByConfirmedPayload(
    rows,
    {
      items: [
        { cdkey: "CDK-A", retried: true, status: "queued" },
        { cdkey: "CDK-B", retried: false, status: "failed", reason: "retry refused" }
      ]
    },
    { mode: "retry" }
  );

  assert.deepEqual(result.confirmedRows, [rows[0]]);
  assert.deepEqual(result.unconfirmedRows, [rows[1]]);
  assert.deepEqual(result.rejectedRows, [rows[1]]);
});

test("retry confirmation rejects an unchanged failed task even when it still has a task id", () => {
  const row = { id: "failed-task", cdkey: "CDK-FAILED-TASK" };
  const result = partitionRowsByConfirmedPayload(
    [row],
    {
      items: [
        {
          task_id: "existing-task-id",
          cdkey: row.cdkey,
          status: "failed",
          can_retry: true
        }
      ]
    },
    { mode: "retry" }
  );

  assert.deepEqual(result.confirmedRows, []);
  assert.deepEqual(result.rejectedRows, [row]);
});

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

test("splitRowsByCredential uses the server credential for direct AT and Session rows", () => {
  const accountRow = { id: "account", sourceType: "account" };
  const sessionRow = { id: "session", sourceType: "session" };

  assert.deepEqual(
    splitRowsByCredential([accountRow, sessionRow], { hasUserApiKey: false }),
    {
      groups: [{ credentialMode: "server", rows: [accountRow, sessionRow] }],
      blockedRows: []
    }
  );
});

test("splitRowsByCredential preserves the credential used when each task was submitted", () => {
  const serverRow = { id: "server", credentialMode: "server" };
  const userRow = { id: "user", credentialMode: "user" };

  assert.deepEqual(
    splitRowsByCredential([serverRow, userRow], { hasUserApiKey: true }),
    {
      groups: [
        { credentialMode: "server", rows: [serverRow] },
        { credentialMode: "", rows: [userRow] }
      ],
      blockedRows: []
    }
  );
});

test("splitRowsByCredential blocks user-key tasks when their original key is unavailable", () => {
  const serverRow = { id: "server", credentialMode: "server" };
  const userRow = { id: "user", credentialMode: "user" };

  assert.deepEqual(
    splitRowsByCredential([serverRow, userRow], { hasUserApiKey: false }),
    {
      groups: [{ credentialMode: "server", rows: [serverRow] }],
      blockedRows: [userRow]
    }
  );
});

test("splitRowsByCredential blocks query-only rows from backend actions", () => {
  const queryOnlyRow = {
    id: "query-only",
    queryOnly: true,
    rowKind: "query",
    cdkey: "CDK-QUERY-ONLY",
    status: "failed"
  };
  const redeemRow = {
    id: "redeem",
    queryOnly: false,
    rowKind: "redeem",
    accessToken: "access-token",
    cdkey: "CDK-REDEEM",
    status: "failed"
  };

  assert.deepEqual(
    splitRowsByCredential([queryOnlyRow, redeemRow], { hasUserApiKey: false }),
    {
      groups: [{ credentialMode: "server", rows: [redeemRow] }],
      blockedRows: [queryOnlyRow]
    }
  );
});

test("splitCdkeysByCredential queries all CDKs with the server credential", () => {
  const rows = [
    { id: "old", cdkey: "A", sourceType: "account", statusOwner: false },
    { id: "current", cdkey: "A", sourceType: "session", statusOwner: true },
    { id: "ordinary", cdkey: "B", sourceType: "account", statusOwner: true }
  ];

  assert.deepEqual(
    splitCdkeysByCredential(rows, ["A", "B", "C"], { hasUserApiKey: false }),
    {
      groups: [{ credentialMode: "server", cdkeys: ["A", "B", "C"] }],
      blockedCdkeys: []
    }
  );
});

test("splitCdkeysByCredential follows the status-owner row credential instead of the current page credential", () => {
  const rows = [
    { id: "old", cdkey: "A", credentialMode: "user", statusOwner: false },
    { id: "current", cdkey: "A", credentialMode: "server", statusOwner: true },
    { id: "ordinary", cdkey: "B", credentialMode: "user", statusOwner: true }
  ];

  assert.deepEqual(
    splitCdkeysByCredential(rows, ["A", "B", "C"], { hasUserApiKey: true }),
    {
      groups: [
        { credentialMode: "server", cdkeys: ["A"] },
        { credentialMode: "", cdkeys: ["B", "C"] }
      ],
      blockedCdkeys: []
    }
  );
});

test("splitCdkeysByCredential does not silently reroute a user-key task through the server key", () => {
  const rows = [
    { id: "server", cdkey: "A", credentialMode: "server", statusOwner: true },
    { id: "user", cdkey: "B", credentialMode: "user", statusOwner: true }
  ];

  assert.deepEqual(
    splitCdkeysByCredential(rows, ["A", "B", "C"], { hasUserApiKey: false }),
    {
      groups: [{ credentialMode: "server", cdkeys: ["A", "C"] }],
      blockedCdkeys: ["B"]
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
