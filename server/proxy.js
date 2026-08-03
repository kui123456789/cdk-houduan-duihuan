import express from "express";
import { readLimitedResponseText } from "../src/domain/responseBody.js";
import { sanitizeTaskQueuePayload } from "../src/domain/taskQueuePayload.js";

const DEFAULT_CONFIG = {
  externalApiBaseUrl: "https://chong.nerver.cc",
  externalClientId: "nerver-redeem-local",
  requestTimeoutMs: 45000,
  maxBatch: 100,
  maxUpstreamResponseBytes: 5_000_000,
  debugRawResponses: false,
  sessionDefaultApiKey: "",
  sessionDefaultCookie: ""
};

export function userError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function requireApiKey(apiKey) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) {
    throw userError("外部 API Key 不能为空");
  }
  return trimmed;
}

export function resolveRedeemApiKey({ apiKey, sessionDefaultApiKey } = {}) {
  const userKey = String(apiKey || "").trim();
  if (userKey) return userKey;

  const sessionKey = String(sessionDefaultApiKey || "").trim();
  if (!sessionKey) {
    const error = new Error(
      "服务器未配置默认兑换凭证；请填写外部 API Key 或配置 SESSION_REDEEM_API_KEY"
    );
    error.status = 500;
    throw error;
  }
  return sessionKey;
}

function normalizeSessionCredential(credential = {}) {
  return {
    cookie: String(credential.cookie || "").trim(),
    sessionToken: String(credential.sessionToken || "").trim(),
    deviceId: String(credential.deviceId || "").trim()
  };
}

function resolveSessionCredential(config = {}) {
  const stored = config.sessionCredentialStore?.get?.();
  if (stored) return normalizeSessionCredential(stored);
  const storedCookie = config.sessionCookieStore?.get?.();
  return normalizeSessionCredential({
    cookie: storedCookie ?? config.sessionDefaultCookie,
    sessionToken: config.sessionDefaultSessionToken,
    deviceId: config.sessionDefaultDeviceId
  });
}

function sessionCredentialHeaders(credential = {}) {
  const normalized = normalizeSessionCredential(credential);
  return {
    ...(normalized.cookie ? { Cookie: normalized.cookie } : {}),
    ...(normalized.sessionToken ? { "X-Session-Token": normalized.sessionToken } : {}),
    ...(normalized.deviceId ? { "X-Device-Id": normalized.deviceId } : {})
  };
}

function storeRotatedSessionToken(config, response) {
  const sessionToken = String(response.headers.get("X-Session-Token") || "").trim();
  if (!sessionToken || !config.sessionCredentialStore?.set) return;
  config.sessionCredentialStore.set({
    ...resolveSessionCredential(config),
    sessionToken
  });
}

export async function validateSessionCredential({ credential, fetchImpl = fetch, config = {} }) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const normalized = normalizeSessionCredential(credential);
  if (!normalized.cookie && !normalized.sessionToken) {
    throw userError("请填写 Session Token 或 Cookie");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs);
  try {
    const response = await fetchImpl(`${resolvedConfig.externalApiBaseUrl}/api/user/profile`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-Client-Id": resolvedConfig.externalClientId,
        ...sessionCredentialHeaders(normalized)
      },
      signal: controller.signal
    });
    const rawText = await readLimitedResponseText(
      response,
      resolvedConfig.maxUpstreamResponseBytes
    );
    let payload = {};
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      payload = { message: rawText };
    }
    const upstreamError = payload?.code !== undefined && Number(payload.code) !== 0;
    if (!response.ok || upstreamError) {
      const error = new Error(
        payload?.message || payload?.error || `后台登录凭证验证失败，HTTP ${response.status}`
      );
      error.status = response.ok ? 401 : response.status;
      throw error;
    }
    return {
      ...normalized,
      sessionToken: String(response.headers.get("X-Session-Token") || normalized.sessionToken).trim()
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("后台登录凭证验证超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function chunk(items, size = DEFAULT_CONFIG.maxBatch) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function getPayloadError(payload) {
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

export function pickItems(payload) {
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

export function summarizeBatchResponse(payload, meta) {
  const itemCount = pickItems(payload).length;
  return {
    httpStatus: meta.httpStatus,
    emptyResponse: meta.emptyResponse,
    responseBytes: meta.responseBytes,
    itemCount
  };
}

export async function forwardJson({ apiKey, endpoint, body, fetchImpl = fetch, config = {} }) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const url = `${resolvedConfig.externalApiBaseUrl}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-Client-Id": resolvedConfig.externalClientId,
        "X-External-Api-Key": requireApiKey(apiKey)
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await readLimitedResponseText(
      response,
      resolvedConfig.maxUpstreamResponseBytes
    );
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

export async function proxyBatches({
  req,
  res,
  endpoint,
  fieldName,
  makeBody,
  fetchImpl = fetch,
  config = {}
}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  try {
    const input = req.body?.[fieldName];
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ error: `${fieldName} 不能为空` });
    }

    const batches = chunk(input, resolvedConfig.maxBatch);
    const apiKey = resolveRedeemApiKey({
      apiKey: req.body?.apiKey,
      credentialMode: req.body?.credentialMode,
      sessionDefaultApiKey: resolvedConfig.sessionDefaultApiKey
    });
    const results = [];
    const backendBatches = [];
    for (const [index, batch] of batches.entries()) {
      console.info(
        `[proxy] forwarding ${endpoint} batch ${index + 1}/${batches.length}: ${batch.length} ${fieldName}`
      );
      const { payload, meta } = await forwardJson({
        apiKey,
        endpoint,
        body: makeBody(batch, req.body),
        fetchImpl,
        config: resolvedConfig
      });
      const summary = summarizeBatchResponse(payload, meta);
      console.info(
        `[proxy] completed ${endpoint} batch ${index + 1}/${batches.length}: HTTP ${summary.httpStatus}, ${summary.responseBytes} bytes, ${summary.itemCount} items`
      );
      results.push(payload);
      backendBatches.push(summary);
    }
    const items = results.flatMap(pickItems);

    const responseBody = {
      ok: true,
      batchCount: batches.length,
      backend: {
        emptyResponse: backendBatches.length > 0 && backendBatches.every((batch) => batch.emptyResponse),
        emptyBatchCount: backendBatches.filter((batch) => batch.emptyResponse).length,
        itemCount: items.length,
        batches: backendBatches
      },
      items
    };

    if (resolvedConfig.debugRawResponses === true) {
      responseBody.raw = results;
    }

    return res.json(responseBody);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || "请求失败"
    });
  }
}

export function createRedeemRouter({ fetchImpl = fetch, config = {} } = {}) {
  const router = express.Router();
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };

  router.get("/api/redeem/tasks/queue-summary", async (_req, res) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs);
    try {
      const credential = resolveSessionCredential(resolvedConfig);
      const response = await fetchImpl(
        `${resolvedConfig.externalApiBaseUrl}/api/redeem/tasks/queue-summary`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-Client-Id": resolvedConfig.externalClientId,
            ...sessionCredentialHeaders(credential)
          },
          signal: controller.signal
        }
      );
      storeRotatedSessionToken(resolvedConfig, response);
      const rawText = await readLimitedResponseText(
        response,
        resolvedConfig.maxUpstreamResponseBytes
      );
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = { message: rawText };
      }
      const upstreamError = payload?.code !== undefined && Number(payload.code) !== 0;
      if (!response.ok || upstreamError) {
        const error = new Error(payload?.message || `队列概览请求失败，HTTP ${response.status}`);
        error.status = response.ok ? 502 : response.status;
        throw error;
      }
      return res.json({ ok: true, ...payload });
    } catch (error) {
      const message = error?.name === "AbortError" ? "队列概览请求超时" : error.message || "队列概览请求失败";
      return res.status(error?.status || 502).json({ ok: false, error: message, message });
    } finally {
      clearTimeout(timeout);
    }
  });

  router.get("/api/redeem/tasks", async (req, res) => {
    const page = Math.min(Math.max(Number.parseInt(req.query?.page, 10) || 1, 1), 10000);
    const pageSize = Math.min(Math.max(Number.parseInt(req.query?.page_size, 10) || 100, 1), 1000);
    const sessionCredential = resolveSessionCredential(resolvedConfig);
    const apiKey = String(
      req.get("X-External-Api-Key") || resolvedConfig.sessionDefaultApiKey || ""
    ).trim();
    const useSessionCredential = !apiKey;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs);
    try {
      const response = await fetchImpl(
        `${resolvedConfig.externalApiBaseUrl}/api/redeem/tasks?page=${page}&page_size=${pageSize}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-Client-Id": resolvedConfig.externalClientId,
            ...(apiKey ? { "X-External-Api-Key": apiKey } : {}),
            ...(useSessionCredential ? sessionCredentialHeaders(sessionCredential) : {})
          },
          signal: controller.signal
        }
      );
      storeRotatedSessionToken(resolvedConfig, response);
      const rawText = await readLimitedResponseText(
        response,
        resolvedConfig.maxUpstreamResponseBytes
      );
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = { message: rawText };
      }
      const upstreamError = payload?.code !== undefined && Number(payload.code) !== 0;
      if (!response.ok || upstreamError) {
        const error = new Error(payload?.message || `兑换任务列表请求失败，HTTP ${response.status}`);
        error.status = response.ok ? 502 : response.status;
        throw error;
      }
      return res.json(sanitizeTaskQueuePayload(payload));
    } catch (error) {
      const message = error?.name === "AbortError" ? "兑换任务列表请求超时" : error.message || "兑换任务列表请求失败";
      return res.status(error?.status || 502).json({ ok: false, error: message, message });
    } finally {
      clearTimeout(timeout);
    }
  });

  router.post("/api/redeem/submit", (req, res) => {
    proxyBatches({
      req,
      res,
      endpoint: "/api/external/cdkey-redeems",
      fieldName: "items",
      fetchImpl,
      config: resolvedConfig,
      makeBody: (items) => {
        const normalizedItems = items.map((item) => {
          const channel = String(item.channel || item.pool || item.queue || "").trim();
          const accessToken = String(
            item.access_token ||
              item.accessToken ||
              item?.session?.access_token ||
              item?.session?.accessToken ||
              ""
          ).trim();
          if (!accessToken) throw userError("兑换账号缺少 AT");
          return {
            channel,
            pool: channel,
            queue: channel,
            redeem_channel: channel,
            cdkey_pool: channel,
            cdkey: String(item.cdkey || "").trim(),
            access_token: accessToken,
            accessToken
          };
        });
        const channels = [...new Set(normalizedItems.map((item) => item.channel).filter(Boolean))];
        return {
          ...(channels.length === 1 ? { channel: channels[0] } : {}),
          items: normalizedItems
        };
      }
    });
  });

  router.post("/api/redeem/status", (req, res) => {
    proxyBatches({
      req,
      res,
      endpoint: "/api/external/cdkey-redeems/status",
      fieldName: "cdkeys",
      fetchImpl,
      config: resolvedConfig,
      makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
    });
  });

  router.post("/api/redeem/cancel", (req, res) => {
    proxyBatches({
      req,
      res,
      endpoint: "/api/external/cdkey-jobs/cancel",
      fieldName: "cdkeys",
      fetchImpl,
      config: resolvedConfig,
      makeBody: (cdkeys, requestBody) => {
        const channel = String(requestBody?.channel || "").trim();
        return {
          ...(channel ? { channel } : {}),
          cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim())
        };
      }
    });
  });

  router.post("/api/redeem/retry", (req, res) => {
    proxyBatches({
      req,
      res,
      endpoint: "/api/external/cdkey-jobs/retry",
      fieldName: "cdkeys",
      fetchImpl,
      config: resolvedConfig,
      makeBody: (cdkeys, requestBody) => {
        const channel = String(requestBody?.channel || "").trim();
        return {
          ...(channel ? { channel } : {}),
          cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim())
        };
      }
    });
  });

  return router;
}
