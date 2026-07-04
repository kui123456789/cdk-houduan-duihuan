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
const SUBSCRIPTION_DIAGNOSTIC_META = {
  plus: { title: "Plus", message: "已确认活跃 Plus", retryable: false },
  not_plus: { title: "非 Plus", message: "不是活跃 Plus", retryable: false },
  missing_token: { title: "缺少 at", message: "缺少 at/access_token，无法判断 Plus", retryable: false },
  token_invalid: { title: "Token 失效", message: "token 失效或无权限", retryable: false },
  no_account: { title: "账号不存在", message: "订阅接口未找到该账号", retryable: false },
  http_error: { title: "接口错误", message: "订阅接口返回 HTTP 错误", retryable: true },
  timeout: { title: "接口超时", message: "订阅接口请求超时，可点击查Plus重试", retryable: true },
  network_error: { title: "网络错误", message: "服务器无法连接订阅接口，可点击查Plus重试", retryable: true },
  remote_error: { title: "接口返回失败", message: "订阅接口返回失败", retryable: true },
  bad_response: { title: "返回异常", message: "订阅接口返回内容无法识别，可点击查Plus重试", retryable: true },
  unknown: { title: "未知", message: "订阅检查结果未知，可点击查Plus重试", retryable: true }
};

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

function userError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function createSubscriptionDiagnostic(category, overrides = {}) {
  const normalizedCategory = SUBSCRIPTION_DIAGNOSTIC_META[category] ? category : "unknown";
  const meta = SUBSCRIPTION_DIAGNOSTIC_META[normalizedCategory];
  return {
    category: normalizedCategory,
    title: overrides.title || meta.title,
    message: overrides.message || meta.message,
    retryable: overrides.retryable ?? meta.retryable,
    httpStatus: overrides.httpStatus ?? null,
    remoteMessage: String(overrides.remoteMessage || "").trim(),
    checkedAt: overrides.checkedAt || new Date().toISOString()
  };
}

function pickText(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text && text.trim()) return text.trim();
  }
  return "";
}

function unwrapSubscriptionPayload(payload) {
  if (payload?.subscription && typeof payload.subscription === "object") return payload.subscription;
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function getSubscriptionRemoteMessage(payload) {
  const source = unwrapSubscriptionPayload(payload);
  return pickText(
    source.message,
    source.reason,
    source.error,
    source.error_message,
    source.errorMessage,
    source.code,
    payload?.message,
    payload?.reason,
    payload?.error,
    payload?.code
  );
}

function classifySubscriptionIssue(message, httpStatus) {
  const text = String(message || "").trim().toLowerCase();
  if (/empty[-_\s]?token|token\s*不能为空|缺少\s*at|缺少.*token/.test(text)) {
    return "missing_token";
  }
  if (
    httpStatus === 401 ||
    /jwt[-_\s]?expired|token[-_\s]?401|unauthori[sz]ed|invalid.*token|token.*invalid|token.*expired|expired.*token|jwt.*过期|token.*过期/.test(
      text
    )
  ) {
    return "token_invalid";
  }
  if (/no[-_\s]?account|account.*not.*found|账号不存在|未找到.*账号|没有.*账号/.test(text)) {
    return "no_account";
  }
  return "";
}

function normalizePlan(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    return ["true", "1", "yes", "y", "是"].includes(value.trim().toLowerCase());
  }
  return false;
}

function isPlusPlan(planType, subscriptionPlan) {
  const normalizedType = normalizePlan(planType);
  const normalizedPlan = normalizePlan(subscriptionPlan);
  if (normalizedType === "plus") return true;
  if (["free", "pro", "team"].includes(normalizedType)) return false;
  return normalizedPlan === "plus" || normalizedPlan.includes("plus");
}

function getSubscriptionPayloadDiagnostic(payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const httpStatus = options.httpStatus ?? null;
  const remoteMessage = getSubscriptionRemoteMessage(payload);

  if (options.parsedJson === false) {
    return createSubscriptionDiagnostic("bad_response", {
      httpStatus,
      remoteMessage,
      checkedAt
    });
  }

  const issueCategory = classifySubscriptionIssue(remoteMessage, httpStatus);
  if (issueCategory) {
    return createSubscriptionDiagnostic(issueCategory, {
      message: remoteMessage || SUBSCRIPTION_DIAGNOSTIC_META[issueCategory].message,
      httpStatus,
      remoteMessage,
      checkedAt
    });
  }

  const source = unwrapSubscriptionPayload(payload);
  const okValue = source?.ok;
  const okText = String(okValue ?? "").trim().toLowerCase();
  const planType = String(source?.plan_type ?? "").trim();
  const subscriptionPlan = String(source?.subscription_plan ?? "").trim();
  const hasActiveSubscription = isTruthy(source?.has_active_subscription);
  const hasPlanInfo =
    Boolean(planType || subscriptionPlan) ||
    Object.prototype.hasOwnProperty.call(source, "has_active_subscription");
  const explicitError =
    okValue === false ||
    (typeof okValue === "string" && okText && !["ok", "true"].includes(okText)) ||
    Boolean(source?.error) ||
    (Boolean(remoteMessage) && !hasPlanInfo);

  if (explicitError) {
    return createSubscriptionDiagnostic("remote_error", {
      message: remoteMessage || "订阅接口返回失败",
      httpStatus,
      remoteMessage,
      checkedAt
    });
  }

  if (!hasPlanInfo) {
    return createSubscriptionDiagnostic("bad_response", {
      httpStatus,
      remoteMessage,
      checkedAt
    });
  }

  const planIsPlus = isPlusPlan(planType, subscriptionPlan);
  if (planIsPlus && hasActiveSubscription === true) {
    return createSubscriptionDiagnostic("plus", {
      message: "已确认活跃 Plus",
      httpStatus,
      remoteMessage,
      checkedAt
    });
  }

  return createSubscriptionDiagnostic("not_plus", {
    message: planIsPlus
      ? "Plus 套餐但没有活跃订阅"
      : `非 Plus 套餐：${planType || subscriptionPlan || "未知"}`,
    httpStatus,
    remoteMessage,
    checkedAt
  });
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

    return {
      payload: payload ?? {},
      meta: {
        httpStatus: response.status,
        emptyResponse: rawText.trim().length === 0,
        responseBytes: Buffer.byteLength(rawText, "utf8")
      }
    };
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
    const diagnostic = createSubscriptionDiagnostic("missing_token");
    const error = userError(diagnostic.message);
    error.diagnostic = diagnostic;
    throw error;
  }

  const url = `${SUBSCRIPTION_API_BASE_URL}/api/v1/subscription`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();

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
    let payload = {};
    let parsedJson = true;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        parsedJson = false;
        payload = { message: rawText };
      }
    }

    if (!response.ok) {
      const remoteMessage = getSubscriptionRemoteMessage(payload) || `HTTP ${response.status}`;
      const issueCategory = classifySubscriptionIssue(remoteMessage, response.status);
      const diagnostic = createSubscriptionDiagnostic(issueCategory || "http_error", {
        message: issueCategory
          ? remoteMessage
          : `订阅接口返回 HTTP ${response.status}${remoteMessage ? `：${remoteMessage}` : ""}`,
        httpStatus: response.status,
        remoteMessage,
        checkedAt
      });
      const error = new Error(diagnostic.message);
      error.status = response.status;
      error.payload = payload;
      error.diagnostic = diagnostic;
      throw error;
    }

    const diagnostic = getSubscriptionPayloadDiagnostic(payload, {
      httpStatus: response.status,
      checkedAt,
      parsedJson
    });

    return { payload, diagnostic };
  } catch (error) {
    if (error.diagnostic) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      const diagnostic = createSubscriptionDiagnostic("timeout", { checkedAt });
      const timeoutError = new Error(diagnostic.message);
      timeoutError.status = 504;
      timeoutError.diagnostic = diagnostic;
      throw timeoutError;
    }

    const diagnostic = createSubscriptionDiagnostic("network_error", {
      message: error.message || SUBSCRIPTION_DIAGNOSTIC_META.network_error.message,
      remoteMessage: error.message || "",
      checkedAt
    });
    const networkError = new Error(diagnostic.message);
    networkError.status = 502;
    networkError.diagnostic = diagnostic;
    throw networkError;
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

function summarizeBatchResponse(payload, meta) {
  const itemCount = pickItems(payload).length;
  return {
    httpStatus: meta.httpStatus,
    emptyResponse: meta.emptyResponse,
    responseBytes: meta.responseBytes,
    itemCount
  };
}

async function proxyBatches({ req, res, endpoint, fieldName, makeBody }) {
  try {
    const input = req.body?.[fieldName];
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ error: `${fieldName} 不能为空` });
    }

    const batches = chunk(input);
    const results = [];
    const backendBatches = [];
    for (const [index, batch] of batches.entries()) {
      console.info(
        `[proxy] forwarding ${endpoint} batch ${index + 1}/${batches.length}: ${batch.length} ${fieldName}`
      );
      const { payload, meta } = await forwardJson({
        apiKey: req.body.apiKey,
        endpoint,
        body: makeBody(batch)
      });
      const summary = summarizeBatchResponse(payload, meta);
      console.info(
        `[proxy] completed ${endpoint} batch ${index + 1}/${batches.length}: HTTP ${summary.httpStatus}, ${summary.responseBytes} bytes, ${summary.itemCount} items`
      );
      results.push(payload);
      backendBatches.push(summary);
    }
    const items = results.flatMap(pickItems);

    return res.json({
      ok: true,
      batchCount: batches.length,
      backend: {
        emptyResponse: backendBatches.length > 0 && backendBatches.every((batch) => batch.emptyResponse),
        emptyBatchCount: backendBatches.filter((batch) => batch.emptyResponse).length,
        itemCount: items.length,
        batches: backendBatches
      },
      raw: results,
      items
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
    const { payload, diagnostic } = await forwardSubscriptionCheck(req.body?.token);
    return res.json({
      ok: true,
      subscription: payload,
      diagnostic,
      ...diagnostic
    });
  } catch (error) {
    const diagnostic =
      error.diagnostic ||
      createSubscriptionDiagnostic("unknown", {
        message: error.message || "订阅检查失败"
      });
    return res.status(error.status || 500).json({
      ok: false,
      error: diagnostic.message,
      diagnostic,
      ...diagnostic,
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
