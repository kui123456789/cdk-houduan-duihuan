import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/app.js";
import { handleRequest } from "../worker/index.js";
import {
  buildUpstreamRequest,
  chunkItems,
  normalizeBatchResponse,
  resolveCredential,
  validateRequest
} from "../src/backend/redeemProxyCore.js";

const allowLimiter = { limit: async () => ({ success: true }) };
const workerEnv = {
  API_RATE_LIMITER: allowLimiter,
  MUTATION_RATE_LIMITER: allowLimiter,
  TURNSTILE_RATE_LIMITER: allowLimiter,
  MAILBOX_RATE_LIMITER: allowLimiter,
  ASSETS: { fetch: async () => new Response("asset") }
};

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function callExpress(body, fetchImpl) {
  return withServer(createApp({ fetchImpl, config: { nodeEnv: "test" } }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/redeem/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, payload: await response.json() };
  });
}

async function callWorker(body, fetchImpl) {
  const response = await handleRequest(
    new Request("https://console.example/api/redeem/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    workerEnv,
    fetchImpl
  );
  return { status: response.status, payload: await response.json() };
}

function createUpstream({ failSecond = false } = {}) {
  let calls = 0;
  return async (_url, options) => {
    calls += 1;
    const { cdkeys } = JSON.parse(options.body);
    if (failSecond && calls === 2) {
      return Response.json({ error: "second batch failed", request_id: "req-2" }, { status: 502 });
    }
    return Response.json({ items: cdkeys.map((cdkey) => ({ cdkey, status: "queued" })) });
  };
}

test("shared proxy primitives own credentials, validation, batching and upstream mapping", () => {
  assert.equal(resolveCredential({ apiKey: " user-key " }), "user-key");
  assert.equal(
    resolveCredential({ credentialMode: "session", sessionDefaultApiKey: " session-key " }),
    "session-key"
  );
  assert.throws(() => resolveCredential({}), /外部 API Key 不能为空/);

  const validated = validateRequest("/api/redeem/status", {
    apiKey: "key",
    cdkeys: [" A ", "B"]
  });
  assert.equal(validated.route.fieldName, "cdkeys");
  assert.deepEqual(validated.input, [" A ", "B"]);
  assert.deepEqual(chunkItems([1, 2, 3], 2), [[1, 2], [3]]);

  const upstream = buildUpstreamRequest({
    route: validated.route,
    batch: validated.input,
    credential: "key",
    baseUrl: "https://api.example",
    clientId: "client"
  });
  assert.equal(upstream.url, "https://api.example/api/external/cdkey-redeems/status");
  assert.equal(upstream.options.headers["X-External-Api-Key"], "key");
  assert.deepEqual(JSON.parse(upstream.options.body), { cdkeys: ["A", "B"] });

  const normalized = normalizeBatchResponse({
    ok: true,
    status: 200,
    rawText: JSON.stringify({ items: [{ cdkey: "A", status: "queued", access_token: "secret" }] })
  });
  assert.deepEqual(normalized.payload.items, [{ cdkey: "A", status: "queued" }]);
  assert.equal(normalized.meta.itemCount, 1);
});

test("Express and Worker return the same successful batch contract", async () => {
  const body = {
    apiKey: "user-key",
    cdkeys: Array.from({ length: 101 }, (_, index) => `CDK-${index}`)
  };
  const expressResult = await callExpress(body, createUpstream());
  const workerResult = await callWorker(body, createUpstream());

  assert.deepEqual(workerResult, expressResult);
  assert.equal(expressResult.status, 200);
  assert.equal(expressResult.payload.backend.batches.length, 2);
});

test("Express and Worker return the same partial failure contract", async () => {
  const body = {
    apiKey: "user-key",
    cdkeys: Array.from({ length: 101 }, (_, index) => `CDK-${index}`)
  };
  const expressResult = await callExpress(body, createUpstream({ failSecond: true }));
  const workerResult = await callWorker(body, createUpstream({ failSecond: true }));

  assert.deepEqual(workerResult, expressResult);
  assert.equal(expressResult.status, 207);
  assert.equal(expressResult.payload.processedCount, 100);
  assert.equal(expressResult.payload.remainingCount, 1);
});
