import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRedeemRouter, validateSessionCredential } from "./proxy.js";
import { createSubscriptionRouter } from "./subscription.js";
import { createMailboxRouter } from "./mailbox.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");

function safeDownloadFileName(fileName) {
  const fallback = "success_accounts.txt";
  const sanitized = String(fileName || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  const withExtension = sanitized || fallback;
  return withExtension.toLowerCase().endsWith(".txt")
    ? withExtension
    : `${withExtension}.txt`;
}

function isLoopbackHost(value) {
  const hostname = String(value || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\](:\d+)?$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function requireLoopbackRequest(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  if (!isLoopbackHost(req.get("host"))) {
    return res.status(403).json({ ok: false, error: "本地 API 仅允许回环地址访问" });
  }

  const origin = String(req.get("origin") || "").trim();
  if (origin) {
    try {
      if (!isLoopbackHost(new URL(origin).hostname)) {
        return res.status(403).json({ ok: false, error: "拒绝非本地页面访问 API" });
      }
    } catch {
      return res.status(403).json({ ok: false, error: "请求来源无效" });
    }
  }
  return next();
}

function requireJsonRequest(req, res, next) {
  if (!req.is("application/json")) {
    return res.status(415).json({ ok: false, error: "Cookie 接口仅接受 JSON" });
  }
  return next();
}

function stripHeaderPrefix(value, headerName) {
  return String(value || "")
    .trim()
    .replace(new RegExp(`^${headerName}\\s*:\\s*`, "i"), "")
    .trim();
}

function findHeaderValue(value, headerName) {
  const match = String(value || "").match(
    new RegExp(`(?:^|\\r?\\n)${headerName}\\s*:\\s*([^\\r\\n]+)`, "i")
  );
  return String(match?.[1] || "").trim();
}

function requireSafeHeaderValue(value, label) {
  const normalized = String(value || "").trim();
  if (/\r|\n/.test(normalized)) {
    const error = new Error(`${label} 格式无效`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function parseSessionCredential(body = {}) {
  const cookieInput = String(body.cookie || "").trim();
  const headerBlock = /\r|\n/.test(cookieInput) ? cookieInput : "";
  const cookie = headerBlock
    ? findHeaderValue(headerBlock, "Cookie")
    : stripHeaderPrefix(cookieInput, "Cookie");
  const sessionToken = stripHeaderPrefix(
    body.sessionToken || findHeaderValue(headerBlock, "X-Session-Token"),
    "X-Session-Token"
  );
  const deviceId = stripHeaderPrefix(
    body.deviceId || findHeaderValue(headerBlock, "X-Device-Id"),
    "X-Device-Id"
  );

  return {
    cookie: requireSafeHeaderValue(cookie, "Cookie"),
    sessionToken: requireSafeHeaderValue(sessionToken, "Session Token"),
    deviceId: requireSafeHeaderValue(deviceId, "Device ID")
  };
}

export function createApp({ fetchImpl = fetch, config = {} } = {}) {
  const app = express();
  const sessionCredentialState = {
    cookie: String(config.sessionDefaultCookie ?? process.env.SESSION_REDEEM_COOKIE ?? "").trim(),
    sessionToken: String(
      config.sessionDefaultSessionToken ?? process.env.SESSION_REDEEM_SESSION_TOKEN ?? ""
    ).trim(),
    deviceId: String(
      config.sessionDefaultDeviceId ?? process.env.SESSION_REDEEM_DEVICE_ID ?? ""
    ).trim()
  };
  const resolvedConfig = {
    sessionDefaultApiKey: String(process.env.SESSION_REDEEM_API_KEY || "").trim(),
    sessionRefreshAuthToken: String(process.env.SESSION_REFRESH_AUTH_TOKEN || "").trim(),
    ...config,
    sessionCredentialStore: {
      get: () => ({ ...sessionCredentialState }),
      set: (credential) => {
        sessionCredentialState.cookie = String(credential?.cookie || "").trim();
        sessionCredentialState.sessionToken = String(credential?.sessionToken || "").trim();
        sessionCredentialState.deviceId = String(credential?.deviceId || "").trim();
      }
    }
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "20mb" }));
  app.use("/api", requireLoopbackRequest);

  app.get("/api/local/session-cookie", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      configured: Boolean(sessionCredentialState.cookie || sessionCredentialState.sessionToken)
    });
  });

  app.post(
    "/api/local/session-cookie",
    requireJsonRequest,
    async (req, res) => {
      try {
        const credential = parseSessionCredential(req.body);
        if (credential.cookie.length > 16_384) {
          return res.status(400).json({ ok: false, error: "Cookie 内容过长" });
        }
        const verifiedCredential = await validateSessionCredential({
          credential,
          fetchImpl,
          config: resolvedConfig
        });
        resolvedConfig.sessionCredentialStore.set(verifiedCredential);
        return res.json({ ok: true, configured: true });
      } catch (error) {
        const message = error?.message || "后台登录凭证验证失败";
        return res.status(error?.status || 502).json({ ok: false, error: message, message });
      }
    }
  );

  app.delete("/api/local/session-cookie", (_req, res) => {
    resolvedConfig.sessionCredentialStore.set({});
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, configured: false });
  });

  app.use(createRedeemRouter({ fetchImpl, config: resolvedConfig }));
  app.use(createSubscriptionRouter({ fetchImpl, config: resolvedConfig }));
  app.use(createMailboxRouter({ fetchImpl, config: resolvedConfig }));

  app.post("/api/download/text", (req, res) => {
    const fileName = safeDownloadFileName(req.body?.fileName);
    const content = String(req.body?.content || "");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    return res.send(content);
  });

  if (process.env.NODE_ENV === "production" || fs.existsSync(path.join(distDir, "index.html"))) {
    app.use(express.static(distDir));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  return app;
}
