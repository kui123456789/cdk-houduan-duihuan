import { validateRedeemRequest } from "../domain/redeemRequestValidation.js";
import {
  sanitizePublicError,
  sanitizePublicMessage,
  sanitizeUpstreamPayload
} from "../domain/upstreamSanitization.js";

export const REDEEM_PROXY_DEFAULTS = Object.freeze({
  baseUrl: "https://chong.nerver.cc",
  clientId: "nerver-redeem-local",
  maxBatch: 100,
  debugRawResponses: false,
  sessionDefaultApiKey: "",
  allowSessionCredentialMode: true
});

function mapSubmitItems(items) {
  return {
    items: items.map((item) => {
      const channel = String(item.channel || item.pool || item.queue || "").trim();
      const accessToken = String(item.access_token || "").trim();
      return {
        channel,
        pool: channel,
        queue: channel,
        redeem_channel: channel,
        cdkey_pool: channel,
        cdkey: String(item.cdkey || "").trim(),
        access_token: accessToken,
        accessToken,
        session: { access_token: accessToken, accessToken }
      };
    })
  };
}

function mapCdkeys(cdkeys) {
  return { cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) };
}

export const REDEEM_ROUTES = Object.freeze({
  "/api/redeem/submit": Object.freeze({
    endpoint: "/api/external/cdkey-redeems",
    fieldName: "items",
    mapBody: mapSubmitItems
  }),
  "/api/redeem/status": Object.freeze({
    endpoint: "/api/external/cdkey-redeems/status",
    fieldName: "cdkeys",
    mapBody: mapCdkeys
  }),
  "/api/redeem/cancel": Object.freeze({
    endpoint: "/api/external/cdkey-jobs/cancel",
    fieldName: "cdkeys",
    mapBody: mapCdkeys
  }),
  "/api/redeem/retry": Object.freeze({
    endpoint: "/api/external/cdkey-jobs/retry",
    fieldName: "cdkeys",
    mapBody: mapCdkeys
  })
});

export function userError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function resolveCredential({
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

export function validateRequest(pathname, body) {
  validateRedeemRequest(pathname, body);
  const route = REDEEM_ROUTES[pathname];
  if (!route) throw userError("兑换接口不存在");
  return { route, input: body[route.fieldName] };
}

export function chunkItems(items, size = REDEEM_PROXY_DEFAULTS.maxBatch) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError("batch size must be a positive safe integer");
  }
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function buildUpstreamRequest({
  route,
  batch,
  credential,
  baseUrl = REDEEM_PROXY_DEFAULTS.baseUrl,
  clientId = REDEEM_PROXY_DEFAULTS.clientId
}) {
  const apiKey = String(credential || "").trim();
  if (!apiKey) throw userError("外部 API Key 不能为空");
  if (!route?.endpoint || typeof route.mapBody !== "function") {
    throw new TypeError("redeem route is invalid");
  }

  return {
    url: `${String(baseUrl || "").replace(/\/$/, "")}${route.endpoint}`,
    options: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-Client-Id": clientId,
        "X-External-Api-Key": apiKey
      },
      body: JSON.stringify(route.mapBody(batch))
    }
  };
}

export function getPayloadError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const status = String(payload.status || "").trim().toLowerCase();
  if (payload.ok === false || payload.success === false) {
    return String(payload.error || payload.message || "兑换接口返回失败").trim();
  }
  if (payload.error) {
    return typeof payload.error === "string" ? payload.error.trim() : JSON.stringify(payload.error);
  }
  if (Array.isArray(payload.errors) && payload.errors.length) return JSON.stringify(payload.errors);
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

export function normalizeBatchResponse({ ok, status, rawText = "" }) {
  let payload = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = { message: rawText };
    }
  }

  const payloadError = getPayloadError(payload);
  if (!ok || payloadError) {
    const error = new Error(sanitizePublicMessage(
      payloadError || payload?.message || payload?.error || `兑换后台请求失败，HTTP ${status}`
    ));
    error.status = status;
    error.payload = sanitizeUpstreamPayload(payload);
    error.code = payload?.code || "UPSTREAM_REQUEST_FAILED";
    error.requestId = payload?.requestId || payload?.request_id || "";
    throw error;
  }

  const sanitizedPayload = sanitizeUpstreamPayload(payload);
  return {
    payload: sanitizedPayload,
    meta: {
      httpStatus: status,
      emptyResponse: rawText.trim().length === 0,
      responseBytes: new TextEncoder().encode(rawText).byteLength,
      itemCount: pickItems(sanitizedPayload).length
    }
  };
}

export async function executeRedeemProxy({
  pathname,
  body,
  forwardBatch,
  config = {},
  onBatchStart,
  onBatchSuccess
}) {
  const resolvedConfig = { ...REDEEM_PROXY_DEFAULTS, ...config };
  try {
    const { route, input } = validateRequest(pathname, body);
    const batches = chunkItems(input, resolvedConfig.maxBatch);
    const credential = resolveCredential({
      apiKey: body?.apiKey,
      credentialMode: body?.credentialMode,
      sessionDefaultApiKey: resolvedConfig.sessionDefaultApiKey,
      allowSessionCredentialMode: resolvedConfig.allowSessionCredentialMode
    });
    const results = [];
    const backendBatches = [];
    let failedBatch = null;

    for (const [index, batch] of batches.entries()) {
      onBatchStart?.({ route, index, batch, batchCount: batches.length });
      try {
        const request = buildUpstreamRequest({
          route,
          batch,
          credential,
          baseUrl: resolvedConfig.baseUrl,
          clientId: resolvedConfig.clientId
        });
        const forwarded = await forwardBatch(request);
        const { payload, meta } = normalizeBatchResponse(forwarded);
        const summary = {
          ...meta,
          index: index + 1,
          inputCount: batch.length,
          ok: true,
          status: "succeeded"
        };
        results.push(payload);
        backendBatches.push(summary);
        onBatchSuccess?.({ route, index, batchCount: batches.length, summary });
      } catch (error) {
        if (!results.length) throw error;
        failedBatch = {
          index: index + 1,
          inputCount: batch.length,
          ok: false,
          status: "failed",
          httpStatus: error.status || 502,
          error: sanitizePublicError(error)
        };
        backendBatches.push(failedBatch);
        for (let remaining = index + 1; remaining < batches.length; remaining += 1) {
          backendBatches.push({
            index: remaining + 1,
            inputCount: batches[remaining].length,
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
    if (resolvedConfig.debugRawResponses === true) responseBody.raw = results;
    return { status: partial ? 207 : 200, body: responseBody };
  } catch (error) {
    return {
      status: error.status || 500,
      body: sanitizePublicError(error, { message: "请求失败" })
    };
  }
}
