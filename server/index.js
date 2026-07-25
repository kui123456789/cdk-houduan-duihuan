import { createApp } from "./app.js";
import { createDatabase } from "./db/index.js";
import { executeRedeemRequest } from "./proxy.js";
import { createJobRepository } from "./repositories/jobRepository.js";
import { createRedeemService } from "./services/redeemService.js";
import { createSecretService } from "./services/secretService.js";
import { createSessionService } from "./auth/session.js";
import { createAccountLimitService } from "./services/accountLimitService.js";
import { createWorkerHeartbeatService } from "./services/workerHeartbeatService.js";
import { createRedeemWorker } from "./workers/redeemWorker.js";
import { createLogger } from "./observability/logger.js";
import { createMetrics } from "./observability/metrics.js";
import { createReadinessService } from "./routes/health.js";

const TRUE_VALUES = new Set(["1", "true", "yes"]);

function enabled(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

function processRole() {
  const role = String(process.env.PROCESS_ROLE || "all").trim().toLowerCase();
  if (!["api", "worker", "all"].includes(role)) {
    throw new Error("PROCESS_ROLE must be api, worker, or all");
  }
  return role;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const logger = createLogger({ base: { service: "cdk-redeem-console" } });
  const role = processRole();
  const hasApi = role !== "worker";
  const hasWorker = role !== "api";
  const port = Number(process.env.PORT || 4174);
  const host = process.env.HOST || "127.0.0.1";
  const config = { nodeEnv: process.env.NODE_ENV };
  if (process.env.ALLOW_SESSION_CREDENTIAL_MODE !== undefined) {
    config.allowSessionCredentialMode = enabled(process.env.ALLOW_SESSION_CREDENTIAL_MODE);
  }

  const jobModeEnabled = enabled(process.env.JOB_MODE_ENABLED);
  if (role === "worker" && !jobModeEnabled) {
    throw new Error("Worker role requires JOB_MODE_ENABLED=true");
  }

  let database = null;
  let worker = null;
  let server = null;
  let jobService = null;
  let authService = null;
  let workerHeartbeatService = null;

  if (jobModeEnabled) {
    database = createDatabase();
    const repository = createJobRepository(database);
    const accountLimitService = createAccountLimitService(database);
    const secretStore = createSecretService({ database });
    workerHeartbeatService = createWorkerHeartbeatService({ database });
    if (hasApi) {
      authService = createSessionService({ database });
      await authService.ensureBootstrapUser({
        username: process.env.AUTH_BOOTSTRAP_USERNAME,
        password: process.env.AUTH_BOOTSTRAP_PASSWORD,
        role: process.env.AUTH_BOOTSTRAP_ROLE || "admin"
      });
    }
    jobService = createRedeemService({
      repository,
      accountLimitService,
      secretStore,
      executeRedeem: (request) => executeRedeemRequest({ ...request, config }),
      sessionDefaultApiKey: process.env.SESSION_REDEEM_API_KEY || "",
      allowSessionCredentialMode: config.allowSessionCredentialMode ?? config.nodeEnv !== "production"
    });

    const metrics = createMetrics({ database, workerHeartbeatService });
    if (hasWorker) {
      worker = createRedeemWorker({
        repository,
        processItem: (context) => jobService.processItem(context),
        heartbeatMs: Number(process.env.WORKER_HEARTBEAT_MS || 10_000),
        heartbeatService: workerHeartbeatService,
        logger,
        metrics
      });
      worker.start();
    }
    if (hasApi) {
      const readinessService = createReadinessService({
        database,
        workerHeartbeatService,
        requireDatabase: true,
        requireWorker: true
      });
      const app = createApp({
        config,
        jobService,
        authService,
        readinessService,
        logger,
        metrics
      });
      server = app.listen(port, host, () => {
        logger.info("api_started", { host, port, processRole: role });
      });
    }
  } else if (hasApi) {
    const metrics = createMetrics();
    const app = createApp({ config, logger, metrics });
    server = app.listen(port, host, () => {
      logger.info("api_started", { host, port, processRole: role });
    });
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("service_stopping", { signal, processRole: role });
    await closeServer(server);
    await worker?.stop();
    await database?.end();
    logger.info("service_stopped", { processRole: role });
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void shutdown(signal).then(
        () => process.exit(0),
        (error) => {
          logger.error("shutdown_failed", { errorCode: "SHUTDOWN_FAILED", error });
          process.exit(1);
        }
      );
    });
  }
}

main().catch((error) => {
  const logger = createLogger({ base: { service: "cdk-redeem-console" } });
  logger.error("startup_failed", { errorCode: error?.code || "STARTUP_FAILED", error });
  process.exitCode = 1;
});
