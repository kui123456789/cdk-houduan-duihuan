import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { newDb } from "pg-mem";
import { createApp } from "../server/app.js";
import { createSessionService } from "../server/auth/session.js";
import { runMigrations } from "../server/db/migrate.js";
import { createSecretService } from "../server/services/secretService.js";

async function createDatabase() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  return pool;
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("login creates a secure HttpOnly session that can be restored and revoked", async () => {
  const database = await createDatabase();
  const authService = createSessionService({ database, secureCookies: true });
  await authService.createUser({ username: "admin@example.com", password: "fake-password-123", role: "admin" });
  const app = createApp({ config: { nodeEnv: "test" }, authService });

  await withServer(app, async (baseUrl) => {
    const rejectedOrigin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
      body: JSON.stringify({ username: "admin@example.com", password: "fake-password-123" })
    });
    assert.equal(rejectedOrigin.status, 403);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ username: "admin@example.com", password: "fake-password-123" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /cdk_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Secure/i);
    const loginPayload = await login.json();
    assert.equal(loginPayload.user.role, "admin");
    assert.ok(loginPayload.csrfToken);

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    const mePayload = await me.json();
    assert.equal(mePayload.user.username, "admin@example.com");
    assert.ok(mePayload.csrfToken);

    const missingCsrf = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl }
    });
    assert.equal(missingCsrf.status, 403);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": mePayload.csrfToken }
    });
    assert.equal(logout.status, 204);
    const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(afterLogout.status, 401);
  });
  await database.end();
});

test("encrypted Secret Service survives service recreation without storing plaintext", async () => {
  const database = await createDatabase();
  const key = randomBytes(32);
  const first = createSecretService({ database, encryptionKey: key });
  const reference = await first.put({
    credential: "fake-api-key",
    accessToken: "fake-access-token"
  });
  const raw = await database.query("SELECT ciphertext, iv, auth_tag FROM job_secrets");
  assert.equal(raw.rowCount, 1);
  assert.doesNotMatch(JSON.stringify(raw.rows), /fake-api-key|fake-access-token/);

  const afterRestart = createSecretService({ database, encryptionKey: key });
  assert.deepEqual(await afterRestart.get(reference), {
    credential: "fake-api-key",
    accessToken: "fake-access-token"
  });
  assert.equal(await afterRestart.delete(reference), true);
  assert.equal(await afterRestart.get(reference), null);
  await database.end();
});

test("offline administrator recovery rotates credentials and revokes existing sessions", async () => {
  const database = await createDatabase();
  const authService = createSessionService({ database, secureCookies: false });
  await authService.createUser({
    username: "recovery@example.com",
    password: "old-password-123",
    role: "viewer"
  });
  const existing = await authService.login("recovery@example.com", "old-password-123");

  const recovered = await authService.recoverAdmin({
    username: "recovery@example.com",
    password: "new-password-456"
  });
  assert.equal(recovered.role, "admin");
  assert.equal(await authService.getSession(existing.token), null);
  await assert.rejects(
    authService.login("recovery@example.com", "old-password-123"),
    (error) => error.code === "INVALID_CREDENTIALS"
  );
  const next = await authService.login("recovery@example.com", "new-password-456");
  assert.equal(next.user.role, "admin");
  await database.end();
});
