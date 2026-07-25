import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/app.js";
import { createLogger } from "../server/observability/logger.js";
import { createMetrics } from "../server/observability/metrics.js";

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("structured logger redacts credentials and digests account identifiers", () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  logger.error("example_failed", {
    email: "private@example.com",
    password: "password-value",
    apiKey: "api-key-value",
    accessToken: "access-token-value",
    message: "Bearer bearer-value belongs to private@example.com",
    error: Object.assign(new Error("must-not-appear"), { code: "EXAMPLE_FAILURE" })
  });

  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.doesNotMatch(line, /private@example\.com|password-value|api-key-value|access-token-value|bearer-value|must-not-appear/);
  const entry = JSON.parse(line);
  assert.match(entry.email, /^sha256:/);
  assert.equal(entry.password, "[REDACTED]");
  assert.equal(entry.error.code, "EXAMPLE_FAILURE");
});

test("request IDs are returned, logged, and exposed through bounded HTTP metrics", async () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)) });
  const metrics = createMetrics();
  const app = createApp({ config: { nodeEnv: "test" }, logger, metrics });

  await withServer(app, async (baseUrl) => {
    const live = await fetch(`${baseUrl}/health/live`, {
      headers: { "X-Request-Id": "request-test-1234" }
    });
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("x-request-id"), "request-test-1234");

    const metricResponse = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricResponse.status, 200);
    const body = await metricResponse.text();
    assert.match(body, /cdk_http_requests_total\{method="GET",route="\/health\/live",status_code="200"\} 1/);
  });

  const completed = lines.find((entry) => entry.requestId === "request-test-1234");
  assert.equal(completed.eventType, "http_request_completed");
  assert.equal(completed.statusCode, 200);
  assert.equal(typeof completed.durationMs, "number");
});
