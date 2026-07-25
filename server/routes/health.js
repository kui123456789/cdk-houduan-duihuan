import express from "express";

export function createReadinessService({
  database = null,
  workerHeartbeatService = null,
  requireDatabase = Boolean(database),
  requireWorker = Boolean(workerHeartbeatService)
} = {}) {
  return {
    async check() {
      let databaseReady = !requireDatabase;
      let workerReady = !requireWorker;
      if (requireDatabase) {
        try {
          await database.query("SELECT 1");
          databaseReady = true;
        } catch {
          databaseReady = false;
        }
      }
      if (requireWorker) {
        try {
          workerReady = Boolean((await workerHeartbeatService.check()).ready);
        } catch {
          workerReady = false;
        }
      }
      return {
        ready: databaseReady && workerReady,
        checks: {
          database: databaseReady ? "ok" : "unavailable",
          worker: workerReady ? "ok" : "unavailable"
        }
      };
    }
  };
}

export function createHealthRouter({ readinessService } = {}) {
  const router = express.Router();
  router.get("/health/live", (_req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ status: "ok" });
  });
  router.get("/health/ready", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const result = await readinessService.check();
    return res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks
    });
  });
  return router;
}
