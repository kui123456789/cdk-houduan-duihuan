import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRedeemRouter } from "./proxy.js";
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

export function createApp({ fetchImpl = fetch, config = {} } = {}) {
  const app = express();
  const resolvedConfig = {
    sessionDefaultApiKey: String(process.env.SESSION_REDEEM_API_KEY || "").trim(),
    ...config
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "20mb" }));
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
