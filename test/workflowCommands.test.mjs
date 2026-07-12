import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutoCycleCommand,
  buildStatusQueryCommand,
  buildSubmitCommand
} from "../src/workflow/workflowCommands.js";

test("buildSubmitCommand keeps the submit request body shape", () => {
  const command = buildSubmitCommand([
    { cdkey: "CDK-001", accessToken: "token-1", channel: "official" },
    { cdkey: "CDK-002", accessToken: "token-2", channel: "partner" }
  ]);

  assert.deepEqual(command, {
    path: "/api/redeem/submit",
    body: {
      items: [
        { cdkey: "CDK-001", access_token: "token-1", channel: "official" },
        { cdkey: "CDK-002", access_token: "token-2", channel: "partner" }
      ]
    }
  });
});

test("buildSubmitCommand rejects duplicate access tokens in one request", () => {
  assert.throws(
    () =>
      buildSubmitCommand([
        { cdkey: "CDK-001", accessToken: "same-token", channel: "ideal" },
        { cdkey: "CDK-002", accessToken: "same-token", channel: "ideal" }
      ]),
    /同一 AT 不能同时提交多张卡密/
  );
});

test("buildSubmitCommand marks Session-only rows for the server credential", () => {
  assert.deepEqual(
    buildSubmitCommand([
      {
        cdkey: "CDK-SESSION",
        accessToken: "session-token",
        channel: "ideal",
        sourceType: "session"
      }
    ]),
    {
      path: "/api/redeem/submit",
      body: {
        items: [
          { cdkey: "CDK-SESSION", access_token: "session-token", channel: "ideal" }
        ]
      },
      options: { credentialMode: "session" }
    }
  );
});

test("buildStatusQueryCommand keeps the CDK-only status query body", () => {
  const cdkeys = ["CDK-001", "CDK-002"];

  assert.deepEqual(buildStatusQueryCommand(cdkeys), {
    path: "/api/redeem/status",
    body: { cdkeys }
  });
});

test("buildAutoCycleCommand uses the same CDK/channel with the next account token", () => {
  assert.deepEqual(
    buildAutoCycleCommand({
      cdkey: "CDK-001",
      channel: "official",
      account: { accessToken: "next-token" }
    }),
    {
      path: "/api/redeem/submit",
      body: {
        items: [
          { cdkey: "CDK-001", access_token: "next-token", channel: "official" }
        ]
      }
    }
  );
});

test("buildAutoCycleCommand uses Session credential mode for a Session replacement", () => {
  assert.deepEqual(
    buildAutoCycleCommand({
      cdkey: "CDK-SESSION",
      channel: "official",
      account: { accessToken: "next-session-token", sourceType: "session" }
    }).options,
    { credentialMode: "session" }
  );
});
