import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRedeemRouter } from "./proxy.js";
import { createSubscriptionRouter } from "./subscription.js";
import { createMailboxRouter } from "./mailbox.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createAuthRouter } from "./routes/auth.js";
import {
  authorize,
  createCsrfProtection,
  createOriginGuard,
  requireAuthentication
} from "./auth/authorization.js";
import { createHealthRouter } from "./routes/health.js";
import { createRequestContextMiddleware } from "./observability/logger.js";
import { createMetricsHandler } from "./observability/metrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");

function safeDownloadFileName(fileName) {
  const fallback = "success_accounts.txt";
  const sanitized = String(fileName || fallback)
    .trim()
    .replace(/[\x00-\x1f\x7f]+/g, "_")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  const withExtension = sanitized || fallback;
  return withExtension.toLowerCase().endsWith(".txt")
    ? withExtension
    : `${withExtension}.txt`;
}

export function createApp({
  fetchImpl = fetch,
  config = {},
  jobService = null,
  authService = null,
  readinessService = { check: async () => ({ ready: true, checks: { database: "ok", worker: "ok" } }) },
  logger = null,
  metrics = null
} = {}) {
  const app = express();
  const nodeEnv = String(config.nodeEnv ?? process.env.NODE_ENV ?? "development").trim().toLowerCase();
  const resolvedConfig = {
    sessionDefaultApiKey: String(process.env.SESSION_REDEEM_API_KEY || "").trim(),
    mailboxAllowedHosts: String(process.env.MAILBOX_ALLOWED_HOSTS || "").trim(),
    authAllowedOrigins: String(process.env.AUTH_ALLOWED_ORIGINS || "").trim(),
    nodeEnv,
    allowSessionCredentialMode: config.allowSessionCredentialMode ?? nodeEnv !== "production",
    ...config
  };

  app.disable("x-powered-by");
  app.use(createRequestContextMiddleware({ logger, metrics }));
  app.use(createHealthRouter({ readinessService }));
  if (metrics) app.get("/metrics", createMetricsHandler(metrics));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "20mb" }));
  const sessionMiddleware = authService?.sessionMiddleware || ((_req, _res, next) => next());
  app.use(["/api/auth", "/api/jobs"], sessionMiddleware);
  const originGuard = createOriginGuard({ allowedOrigins: resolvedConfig.authAllowedOrigins });
  const csrfProtection = createCsrfProtection({
    hashToken: authService?.hashCsrfToken || (() => "")
  });
  if (authService?.login) {
    app.use(createAuthRouter({ authService, originGuard, csrfProtection }));
  }
  app.use(createRedeemRouter({ fetchImpl, config: resolvedConfig }));
  app.use(createSubscriptionRouter({ fetchImpl, config: resolvedConfig }));
  app.use(createMailboxRouter({ fetchImpl, config: resolvedConfig }));
  if (jobService) {
    app.use(createJobsRouter({
      jobService,
      requireAuthentication,
      authorize,
      originGuard,
      csrfProtection
    }));
  }

  app.post("/api/download/text", (req, res) => {
    const fileName = safeDownloadFileName(req.body?.fileName);
    const asciiName = fileName
      .replace(/[^\x20-\x7e]+/g, "_")
      .replace(/["\\]/g, "_") || "download.txt";
    const content = String(req.body?.content || "");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    return res.send(content);
  });

  if (resolvedConfig.nodeEnv === "production" || fs.existsSync(path.join(distDir, "index.html"))) {
    app.use(express.static(distDir));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.use((error, req, res, next) => {
    req.log?.error("http_request_failed", {
      requestId: req.requestId,
      statusCode: Number(error?.status) || 500,
      errorCode: error?.code || "INTERNAL_ERROR",
      error
    });
    if (res.headersSent) return next(error);
    return res.status(Number(error?.status) || 500).json({
      code: error?.code || "INTERNAL_ERROR",
      message: "请求处理失败",
      requestId: req.requestId
    });
  });

  return app;
}
