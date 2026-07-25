import express from "express";
import { readTextWithLimit } from "../src/domain/boundedResponse.js";
import {
  REDEEM_PROXY_DEFAULTS,
  chunkItems,
  executeRedeemProxy,
  getPayloadError,
  pickItems,
  resolveCredential,
  userError
} from "../src/backend/redeemProxyCore.js";

const DEFAULT_CONFIG = {
  externalApiBaseUrl: REDEEM_PROXY_DEFAULTS.baseUrl,
  externalClientId: REDEEM_PROXY_DEFAULTS.clientId,
  requestTimeoutMs: 45_000,
  maxRedeemResponseBytes: 5_000_000,
  maxBatch: REDEEM_PROXY_DEFAULTS.maxBatch,
  debugRawResponses: false,
  sessionDefaultApiKey: "",
  allowSessionCredentialMode: true
};

export { getPayloadError, pickItems, userError };
export const chunk = chunkItems;
export const resolveRedeemApiKey = resolveCredential;

export function requireApiKey(apiKey) {
  return resolveCredential({ apiKey });
}

export function summarizeBatchResponse(payload, meta) {
  return { ...meta, itemCount: pickItems(payload).length };
}

async function forwardBatch(request, fetchImpl, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      ...request.options,
      signal: controller.signal
    });
    const rawText = await readTextWithLimit(response, {
      maxBytes: config.maxRedeemResponseBytes,
      signal: controller.signal,
      abortController: controller
    });
    return { ok: response.ok, status: response.status, rawText };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("兑换后台请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeRedeemRequest({
  pathname,
  body,
  fetchImpl = fetch,
  config = {},
  onBatchStart,
  onBatchSuccess
}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  return executeRedeemProxy({
    pathname,
    body,
    config: {
      baseUrl: resolvedConfig.externalApiBaseUrl,
      clientId: resolvedConfig.externalClientId,
      maxBatch: resolvedConfig.maxBatch,
      debugRawResponses: resolvedConfig.debugRawResponses,
      sessionDefaultApiKey: resolvedConfig.sessionDefaultApiKey,
      allowSessionCredentialMode: resolvedConfig.allowSessionCredentialMode
    },
    forwardBatch: (request) => forwardBatch(request, fetchImpl, resolvedConfig),
    onBatchStart,
    onBatchSuccess
  });
}

export async function proxyBatches({
  req,
  res,
  requestPath,
  fetchImpl = fetch,
  config = {}
}) {
  const result = await executeRedeemRequest({
    pathname: requestPath,
    body: req.body,
    fetchImpl,
    config,
    onBatchStart: ({ route, index, batch, batchCount }) => {
      console.info(
        `[proxy] forwarding ${route.endpoint} batch ${index + 1}/${batchCount}: ${batch.length} ${route.fieldName}`
      );
    },
    onBatchSuccess: ({ route, index, batchCount, summary }) => {
      console.info(
        `[proxy] completed ${route.endpoint} batch ${index + 1}/${batchCount}: HTTP ${summary.httpStatus}, ${summary.responseBytes} bytes, ${summary.itemCount} items`
      );
    }
  });
  return res.status(result.status).json(result.body);
}

export function createRedeemRouter({ fetchImpl = fetch, config = {} } = {}) {
  const router = express.Router();
  for (const pathname of [
    "/api/redeem/submit",
    "/api/redeem/status",
    "/api/redeem/cancel",
    "/api/redeem/retry"
  ]) {
    router.post(pathname, (req, res) => {
      return proxyBatches({ req, res, requestPath: pathname, fetchImpl, config });
    });
  }
  return router;
}
