import express from "express";
import { readTextWithLimit } from "../src/domain/boundedResponse.js";
import { validateRedeemRequest } from "../src/domain/redeemRequestValidation.js";
import {
  sanitizePublicError,
  sanitizePublicMessage,
  sanitizeUpstreamPayload
} from "../src/domain/upstreamSanitization.js";

const DEFAULT_CONFIG = {
  externalApiBaseUrl: "https://chong.nerver.cc",
  externalClientId: "nerver-redeem-local",
  requestTimeoutMs: 45000,
  maxRedeemResponseBytes: 5_000_000,
  maxBatch: 100,
  debugRawResponses: false,
  sessionDefaultApiKey: "",
  allowSessionCredentialMode: true
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

export function resolveRedeemApiKey({
  apiKey,
  credentialMode,
  sessionDefaultApiKey,
  allowSessionCredentialMode = true
} = {}) {
  const userKey = String(apiKey || "").trim();
  if (userKey) return userKey;
  if (String(credentialMode || "").trim() !== "session") {
    throw userError("外部 API Key 不能为空");
  }
  if (!allowSessionCredentialMode) {
    const error = new Error("当前环境已禁用 Session 共享凭证模式");
    error.status = 403;
    error.code = "SESSION_CREDENTIAL_MODE_DISABLED";
    throw error;
  }

  const sessionKey = String(sessionDefaultApiKey || "").trim();
  if (!sessionKey) {
    const error = new Error("服务器未配置 Session 默认兑换凭证");
    error.status = 500;
    throw error;
  }
  return sessionKey;
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

    const rawText = await readTextWithLimit(response, {
      maxBytes: resolvedConfig.maxRedeemResponseBytes,
      signal: controller.signal,
      abortController: controller
    });
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
      const message = sanitizePublicMessage(
        payloadError ||
        payload?.message ||
        payload?.error ||
        `兑换后台请求失败，HTTP ${response.status}`
      );
      const error = new Error(message);
      error.status = response.status;
      error.payload = sanitizeUpstreamPayload(payload);
      error.code = payload?.code || "UPSTREAM_REQUEST_FAILED";
      error.requestId = payload?.requestId || payload?.request_id || "";
      throw error;
    }

    return {
      payload: sanitizeUpstreamPayload(payload),
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
  requestPath,
  fieldName,
  makeBody,
  fetchImpl = fetch,
  config = {}
}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  try {
    validateRedeemRequest(requestPath, req.body);
    const input = req.body?.[fieldName];
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ error: `${fieldName} 不能为空` });
    }

    const batches = chunk(input, resolvedConfig.maxBatch);
    const apiKey = resolveRedeemApiKey({
      apiKey: req.body?.apiKey,
      credentialMode: req.body?.credentialMode,
      sessionDefaultApiKey: resolvedConfig.sessionDefaultApiKey,
      allowSessionCredentialMode: resolvedConfig.allowSessionCredentialMode
    });
    const results = [];
    const backendBatches = [];
    let failedBatch = null;
    for (const [index, batch] of batches.entries()) {
      console.info(
        `[proxy] forwarding ${endpoint} batch ${index + 1}/${batches.length}: ${batch.length} ${fieldName}`
      );
      try {
        const { payload, meta } = await forwardJson({
          apiKey,
          endpoint,
          body: makeBody(batch),
          fetchImpl,
          config: resolvedConfig
        });
        const summary = {
          ...summarizeBatchResponse(payload, meta),
          index: index + 1,
          inputCount: batch.length,
          ok: true,
          status: "succeeded"
        };
        console.info(
          `[proxy] completed ${endpoint} batch ${index + 1}/${batches.length}: HTTP ${summary.httpStatus}, ${summary.responseBytes} bytes, ${summary.itemCount} items`
        );
        results.push(payload);
        backendBatches.push(summary);
      } catch (error) {
        if (!results.length) throw error;
        const publicError = sanitizePublicError(error);
        failedBatch = {
          index: index + 1,
          inputCount: batch.length,
          ok: false,
          status: "failed",
          httpStatus: error.status || 502,
          error: publicError
        };
        backendBatches.push(failedBatch);
        for (let remainingIndex = index + 1; remainingIndex < batches.length; remainingIndex += 1) {
          backendBatches.push({
            index: remainingIndex + 1,
            inputCount: batches[remainingIndex].length,
            ok: false,
            status: "not_sent"
          });
        }
        break;
      }
    }
    const items = results.flatMap(pickItems);
    const processedCount = backendBatches
      .filter((batch) => batch.ok === true)
      .reduce((total, batch) => total + batch.inputCount, 0);
    const partial = failedBatch !== null;

    const responseBody = {
      ok: !partial,
      partial,
      batchCount: batches.length,
      processedCount,
      remainingCount: input.length - processedCount,
      failed: failedBatch?.error,
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

    return res.status(partial ? 207 : 200).json(responseBody);
  } catch (error) {
    return res.status(error.status || 500).json(
      sanitizePublicError(error, { message: "请求失败" })
    );
  }
}

export function createRedeemRouter({ fetchImpl = fetch, config = {} } = {}) {
  const router = express.Router();
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };

  router.post("/api/redeem/submit", (req, res) => {
    proxyBatches({
      req,
      res,
      endpoint: "/api/external/cdkey-redeems",
      requestPath: "/api/redeem/submit",
      fieldName: "items",
      fetchImpl,
      config: resolvedConfig,
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

  router.post("/api/redeem/status", (req, res) => {
    proxyBatches({
      req,
      res,
      endpoint: "/api/external/cdkey-redeems/status",
      requestPath: "/api/redeem/status",
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
      requestPath: "/api/redeem/cancel",
      fieldName: "cdkeys",
      fetchImpl,
      config: resolvedConfig,
      makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
    });
  });

  router.post("/api/redeem/retry", (req, res) => {
    proxyBatches({
      req,
      res,
      endpoint: "/api/external/cdkey-jobs/retry",
      requestPath: "/api/redeem/retry",
      fieldName: "cdkeys",
      fetchImpl,
      config: resolvedConfig,
      makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
    });
  });

  return router;
}
