import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../server/app.js";
import { runMigrations } from "../server/db/migrate.js";
import { createReadinessService } from "../server/routes/health.js";
import { createWorkerHeartbeatService } from "../server/services/workerHeartbeatService.js";

async function createDatabase() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new adapter.Pool();
  await runMigrations(database);
  return database;
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("readiness checks both PostgreSQL and a recent Worker heartbeat", async () => {
  const database = await createDatabase();
  const heartbeat = createWorkerHeartbeatService({ database, maxAgeMs: 60_000 });
  const readiness = createReadinessService({
    database,
    workerHeartbeatService: heartbeat,
    requireDatabase: true,
    requireWorker: true
  });
  const app = createApp({ config: { nodeEnv: "test" }, readinessService: readiness });

  await withServer(app, async (baseUrl) => {
    const live = await fetch(`${baseUrl}/health/live`);
    assert.equal(live.status, 200);

    const beforeWorker = await fetch(`${baseUrl}/health/ready`);
    assert.equal(beforeWorker.status, 503);
    assert.deepEqual((await beforeWorker.json()).checks, {
      database: "ok",
      worker: "unavailable"
    });

    await heartbeat.markRunning("worker-health-test");
    assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);

    await heartbeat.markStopped("worker-health-test");
    const afterStop = await fetch(`${baseUrl}/health/ready`);
    assert.equal(afterStop.status, 503);
    assert.equal((await afterStop.json()).checks.worker, "unavailable");
  });
  await database.end();
});

test("readiness fails closed when the database check fails", async () => {
  const readiness = createReadinessService({
    database: { query: async () => { throw new Error("offline"); } },
    requireDatabase: true,
    requireWorker: false
  });
  assert.deepEqual(await readiness.check(), {
    ready: false,
    checks: { database: "unavailable", worker: "ok" }
  });
});
