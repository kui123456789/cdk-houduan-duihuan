import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../server/app.js";
import { createSessionService } from "../server/auth/session.js";
import { runMigrations } from "../server/db/migrate.js";

async function setup() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new adapter.Pool();
  await runMigrations(database);
  const authService = createSessionService({ database, secureCookies: false });
  const viewer = await authService.createUser({
    username: "viewer@example.com",
    password: "viewer-password-123",
    role: "viewer"
  });
  const operator = await authService.createUser({
    username: "operator@example.com",
    password: "operator-password-123",
    role: "operator"
  });
  const calls = [];
  const job = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "queued",
    items: [{ id: "item-1", cdkey: "CDK-1", status: "queued" }]
  };
  const jobService = {
    async getJob() { return job; },
    async listEvents() { return [{ type: "job_created", actorId: operator.id }]; },
    async createJob(_body, context) { calls.push(["create", context]); return job; },
    async cancelJob(_id, context) { calls.push(["cancel", context]); return { ...job, status: "cancelled" }; },
    async retryJob(_id, context) { calls.push(["retry", context]); return job; }
  };
  return { database, authService, viewer, operator, calls, jobService };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json();
  return { cookie: response.headers.get("set-cookie"), csrfToken: payload.csrfToken };
}

test("Jobs require login, viewer is read-only, and operator mutations carry actor ID", async () => {
  const state = await setup();
  const app = createApp({ config: { nodeEnv: "test" }, authService: state.authService, jobService: state.jobService });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const jobUrl = `${baseUrl}/api/jobs/${state.jobService ? "00000000-0000-4000-8000-000000000001" : ""}`;

    assert.equal((await fetch(jobUrl)).status, 401);
    const viewerSession = await login(baseUrl, "viewer@example.com", "viewer-password-123");
    assert.equal((await fetch(jobUrl, { headers: { Cookie: viewerSession.cookie } })).status, 200);
    const viewerCreate = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: {
        Cookie: viewerSession.cookie,
        Origin: baseUrl,
        "X-CSRF-Token": viewerSession.csrfToken,
        "Content-Type": "application/json",
        "Idempotency-Key": "viewer-attempt"
      },
      body: JSON.stringify({ items: [] })
    });
    assert.equal(viewerCreate.status, 403);

    const operatorSession = await login(baseUrl, "operator@example.com", "operator-password-123");
    const missingCsrf = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { Cookie: operatorSession.cookie, Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] })
    });
    assert.equal(missingCsrf.status, 403);
    const created = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: {
        Cookie: operatorSession.cookie,
        Origin: baseUrl,
        "X-CSRF-Token": operatorSession.csrfToken,
        "Content-Type": "application/json",
        "Idempotency-Key": "operator-create"
      },
      body: JSON.stringify({ items: [] })
    });
    assert.equal(created.status, 202);
    assert.equal(state.calls[0][1].actorId, state.operator.id);
    assert.doesNotMatch(JSON.stringify(await created.json()), /secretRef|apiKey|accessToken/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await state.database.end();
  }
});
