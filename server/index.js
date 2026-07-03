import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "127.0.0.1";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const MAX_BATCH = 100;
const EXTERNAL_API_BASE_URL = "https://chong.nerver.cc";
const SUBSCRIPTION_API_BASE_URL = "https://cha.nerver.cc";
const EXTERNAL_CLIENT_ID = "nerver-redeem-local";
const REQUEST_TIMEOUT_MS = 45000;

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

function userError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function requireApiKey(apiKey) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) {
    throw userError("外部 API Key 不能为空");
  }
  return trimmed;
}

function chunk(items, size = MAX_BATCH) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function forwardJson({ apiKey, endpoint, body }) {
  const url = `${EXTERNAL_API_BASE_URL}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-Client-Id": EXTERNAL_CLIENT_ID,
        "X-External-Api-Key": requireApiKey(apiKey)
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { message: rawText };
      }
    }

    const payloadError = getPayloadError(payload);
    if (!response.ok || payloadError) {
      const message =
        payloadError ||
        payload?.message ||
        payload?.error ||
        `兑换后台请求失败，HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload ?? {};
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("兑换后台请求超时");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardSubscriptionCheck(token) {
  const trimmedToken = String(token || "").trim();
  if (!trimmedToken) {
    throw userError("token 不能为空");
  }

  const url = `${SUBSCRIPTION_API_BASE_URL}/api/v1/subscription`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token: trimmedToken }),
      signal: controller.signal
    });

    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { message: rawText };
      }
    }

    if (!response.ok) {
      const error = new Error(
        payload?.message ||
          payload?.reason ||
          payload?.error ||
          `订阅接口请求失败，HTTP ${response.status}`
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload ?? {};
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("订阅接口请求超时");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getPayloadError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }

  const status = String(payload.status || "").trim().toLowerCase();
  if (payload.ok === false || payload.success === false) {
    return String(payload.error || payload.message || "兑换接口返回失败").trim();
  }

  if (payload.error) {
    return typeof payload.error === "string" ? payload.error.trim() : JSON.stringify(payload.error);
  }

  if (Array.isArray(payload.errors) && payload.errors.length) {
    return JSON.stringify(payload.errors);
  }

  if (["error", "failed", "failure"].includes(status)) {
    return String(payload.message || payload.status || "兑换接口返回失败").trim();
  }

  return "";
}

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

function pickItems(payload) {
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function proxyBatches({ req, res, endpoint, fieldName, makeBody }) {
  try {
    const input = req.body?.[fieldName];
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ error: `${fieldName} 不能为空` });
    }

    const batches = chunk(input);
    const results = [];
    for (const [index, batch] of batches.entries()) {
      console.info(
        `[proxy] forwarding ${endpoint} batch ${index + 1}/${batches.length}: ${batch.length} ${fieldName}`
      );
      const payload = await forwardJson({
        apiKey: req.body.apiKey,
        endpoint,
        body: makeBody(batch)
      });
      results.push(payload);
    }

    return res.json({
      ok: true,
      batchCount: batches.length,
      raw: results,
      items: results.flatMap(pickItems)
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || "请求失败",
      details: error.payload || undefined
    });
  }
}

app.post("/api/redeem/submit", (req, res) => {
  proxyBatches({
    req,
    res,
    endpoint: "/api/external/cdkey-redeems",
    fieldName: "items",
    makeBody: (items) => ({
      items: items.map((item) => ({
        channel: String(item.channel || item.pool || item.queue || "").trim(),
        pool: String(item.channel || item.pool || item.queue || "").trim(),
        queue: String(item.channel || item.pool || item.queue || "").trim(),
        redeem_channel: String(item.channel || item.pool || item.queue || "").trim(),
        cdkey_pool: String(item.channel || item.pool || item.queue || "").trim(),
        cdkey: String(item.cdkey || "").trim(),
        access_token: String(item.access_token || "").trim(),
        accessToken: String(item.access_token || "").trim(),
        session: {
          access_token: String(item.access_token || "").trim(),
          accessToken: String(item.access_token || "").trim()
        }
      }))
    })
  });
});

app.post("/api/redeem/status", (req, res) => {
  proxyBatches({
    req,
    res,
    endpoint: "/api/external/cdkey-redeems/status",
    fieldName: "cdkeys",
    makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
  });
});

app.post("/api/redeem/cancel", (req, res) => {
  proxyBatches({
    req,
    res,
    endpoint: "/api/external/cdkey-jobs/cancel",
    fieldName: "cdkeys",
    makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
  });
});

app.post("/api/redeem/retry", (req, res) => {
  proxyBatches({
    req,
    res,
    endpoint: "/api/external/cdkey-jobs/retry",
    fieldName: "cdkeys",
    makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
  });
});

app.post("/api/subscription/check", async (req, res) => {
  try {
    const subscription = await forwardSubscriptionCheck(req.body?.token);
    return res.json({ ok: true, subscription });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || "订阅检查失败",
      details: error.payload || undefined
    });
  }
});

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

app.listen(PORT, HOST, () => {
  console.log(`CDK redeem proxy listening on http://${HOST}:${PORT}`);
});
