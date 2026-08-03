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
        { cdkey: "CDK-001", access_token: "token-1", accessToken: "token-1", channel: "official" },
        { cdkey: "CDK-002", access_token: "token-2", accessToken: "token-2", channel: "partner" }
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

test("buildSubmitCommand uses the AT extracted from Session without forwarding Session", () => {
  assert.deepEqual(
    buildSubmitCommand([
      {
        cdkey: "CDK-SESSION",
        accessToken: "session-token",
        channel: "ideal",
        sourceType: "session",
        session: {
          user: { email: "session@example.com" },
          accessToken: "session-token",
          expires: "2026-08-04T00:00:00.000Z"
        }
      }
    ]),
    {
      path: "/api/redeem/submit",
      body: {
        items: [
          {
            cdkey: "CDK-SESSION",
            access_token: "session-token",
            accessToken: "session-token",
            channel: "ideal"
          }
        ]
      }
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
          { cdkey: "CDK-001", access_token: "next-token", accessToken: "next-token", channel: "official" }
        ]
      }
    }
  );
});

test("buildAutoCycleCommand submits a Session replacement through its extracted AT", () => {
  assert.deepEqual(
    buildAutoCycleCommand({
      cdkey: "CDK-SESSION",
      channel: "official",
      account: { accessToken: "next-session-token", sourceType: "session" }
    }).body.items[0],
    {
      cdkey: "CDK-SESSION",
      access_token: "next-session-token",
      accessToken: "next-session-token",
      channel: "official"
    }
  );
});
