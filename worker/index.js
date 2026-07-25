import {
  analyzeEmailPlusContent,
  createEmailVerificationDiagnostic,
  isSafeMailboxUrl
} from "../src/domain/emailVerification.js";
import {
  ResponseBodyTooLargeError,
  readTextWithLimit
} from "../src/domain/boundedResponse.js";
import { validateRedeemRequest } from "../src/domain/redeemRequestValidation.js";
import {
  sanitizePublicError,
  sanitizePublicMessage,
  sanitizeUpstreamPayload
} from "../src/domain/upstreamSanitization.js";

const REDEEM_API_BASE_URL = "https://chong.nerver.cc";
const SUBSCRIPTION_API_BASE_URL = "https://cha.nerver.cc";
const EXTERNAL_CLIENT_ID = "nerver-redeem-local";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REDEEM_RESPONSE_BYTES = 5_000_000;
const MAX_SUBSCRIPTION_RESPONSE_BYTES = 1_000_000;
const MAX_MAILBOX_RESPONSE_BYTES = 2_000_000;
const MAX_BATCH = 100;
const SECURITY_COOKIE_NAME = "__Host-cdk_security";
const SECURITY_SESSION_TTL_SECONDS = 60 * 60;
const TURNSTILE_EXPECTED_HOSTNAME = "cdk.334401.xyz";
const TURNSTILE_EXPECTED_ACTION = "cdk-redeem";

export const SUBSCRIPTION_DIAGNOSTIC_META = {
  plus: { title: "Plus", message: "已确认活跃 Plus", retryable: false },
  not_plus: { title: "非 Plus", message: "不是活跃 Plus", retryable: false },
  missing_token: { title: "缺少 at", message: "缺少 at/access_token，无法判断 Plus", retryable: false },
  token_invalid: { title: "Token 失效", message: "token 失效或无权限", retryable: false },
  no_account: { title: "账号不存在", message: "订阅接口未找到该账号", retryable: false },
  http_error: { title: "接口错误", message: "订阅接口返回 HTTP 错误", retryable: true },
  timeout: { title: "接口超时", message: "订阅接口请求超时，可点击查验证重试", retryable: true },
  network_error: { title: "网络错误", message: "服务器无法连接订阅接口，可点击查验证重试", retryable: true },
  remote_error: { title: "接口返回失败", message: "订阅接口返回失败", retryable: true },
  bad_response: { title: "返回异常", message: "订阅接口返回内容无法识别，可点击查验证重试", retryable: true },
  unknown: { title: "未知", message: "订阅检查结果未知，可点击查验证重试", retryable: true }
};

function jsonResponse(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

function getClientIp(request) {
  return String(request.headers.get("CF-Connecting-IP") || "unknown").trim();
}

async function checkRateLimit(binding, key) {
  if (!binding?.limit) {
    console.error("[security] rate limiter binding missing");
    return "unavailable";
  }
  try {
    const result = await binding.limit({ key });
    return result.success === true ? "allowed" : "limited";
  } catch (error) {
    console.error("[security] rate limiter unavailable", {
      message: error instanceof Error ? error.message : String(error || "unknown")
    });
    return "unavailable";
  }
}

async function applyRateLimits(request, env, pathname) {
  const ip = getClientIp(request);
  const mutationPath = ["/api/redeem/submit", "/api/redeem/cancel", "/api/redeem/retry"].includes(pathname);
  const failClosed = mutationPath || pathname === "/api/security/verify";

  async function applyLimiter(binding, { limitedMessage, required }) {
    const result = await checkRateLimit(binding, ip);
    if (result === "limited") {
      return jsonResponse({ error: limitedMessage }, 429, { "Retry-After": "60" });
    }
    if (result === "unavailable" && required) {
      return jsonResponse(
        { error: "请求保护服务暂时不可用，请稍后重试", code: "RATE_LIMITER_UNAVAILABLE" },
        503,
        { "Retry-After": "60" }
      );
    }
    return null;
  }

  const apiResponse = await applyLimiter(env.API_RATE_LIMITER, {
    limitedMessage: "请求过于频繁，请稍后重试",
    required: failClosed
  });
  if (apiResponse) return apiResponse;

  if (pathname === "/api/security/verify") {
    return applyLimiter(env.TURNSTILE_RATE_LIMITER, {
      limitedMessage: "安全验证尝试过于频繁，请稍后重试",
      required: true
    });
  }

  if (pathname === "/api/subscription/email-check") {
    return applyLimiter(env.MAILBOX_RATE_LIMITER, {
      limitedMessage: "邮箱检查尝试过于频繁，请稍后重试",
      required: false
    });
  }

  if (mutationPath) {
    return applyLimiter(env.MUTATION_RATE_LIMITER, {
      limitedMessage: "兑换操作过于频繁，请稍后重试",
      required: true
    });
  }
  return null;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importSecurityKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

async function createSecuritySession(secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1,
    issuedAt: now,
    expiresAt: now + SECURITY_SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID()
  };
  const payloadSegment = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importSecurityKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadSegment));
  return {
    token: `${payloadSegment}.${bytesToBase64Url(new Uint8Array(signature))}`,
    expiresAt: payload.expiresAt
  };
}

async function verifySecuritySession(token, secret) {
  try {
    if (!secret) return null;
    const [payloadSegment, signatureSegment, extra] = String(token || "").split(".");
    if (!payloadSegment || !signatureSegment || extra) return null;
    const key = await importSecurityKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signatureSegment),
      new TextEncoder().encode(payloadSegment)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadSegment)));
    const now = Math.floor(Date.now() / 1000);
    if (payload.version !== 1 || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return valueParts.join("=");
  }
  return "";
}

function isSameOriginRequest(request) {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function getSecuritySession(request, env) {
  if (!isSameOriginRequest(request)) return null;
  return verifySecuritySession(readCookie(request, SECURITY_COOKIE_NAME), env.SECURITY_SESSION_SECRET);
}

export function requiresSecuritySession({ pathname, body } = {}) {
  if (["/api/redeem/submit", "/api/redeem/cancel", "/api/redeem/retry"].includes(pathname)) {
    return true;
  }
  return pathname === "/api/redeem/status" &&
    String(body?.credentialMode || "").trim() === "session" &&
    !String(body?.apiKey || "").trim();
}

async function verifyTurnstileToken(request, token, env, fetchImpl) {
  if (!env.TURNSTILE_SECRET_KEY || !token) return null;
  const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: getClientIp(request),
      idempotency_key: crypto.randomUUID()
    })
  });
  if (!response.ok) return null;
  const outcome = await response.json().catch(() => null);
  if (
    outcome?.success !== true ||
    outcome.hostname !== TURNSTILE_EXPECTED_HOSTNAME ||
    outcome.action !== TURNSTILE_EXPECTED_ACTION
  ) {
    return null;
  }
  return outcome;
}

async function handleSecurityStatus(request, env) {
  const session = await getSecuritySession(request, env);
  return jsonResponse({ verified: Boolean(session), expiresAt: session?.expiresAt || null });
}

async function handleSecurityVerify(request, body, env, fetchImpl) {
  const outcome = await verifyTurnstileToken(request, String(body?.token || "").trim(), env, fetchImpl);
  if (!outcome) return jsonResponse({ verified: false, error: "安全验证失败，请重试" }, 403);
  if (!env.SECURITY_SESSION_SECRET) return jsonResponse({ verified: false, error: "安全验证服务未配置" }, 500);

  const session = await createSecuritySession(env.SECURITY_SESSION_SECRET);
  const cookie = [
    `${SECURITY_COOKIE_NAME}=${session.token}`,
    "Path=/",
    `Max-Age=${SECURITY_SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict"
  ].join("; ");
  return jsonResponse(
    { verified: true, expiresAt: session.expiresAt },
    200,
    { "Set-Cookie": cookie }
  );
}

function userError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function requireApiKey(apiKey) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) throw userError("外部 API Key 不能为空");
  return trimmed;
}

function resolveRedeemApiKey({ apiKey, credentialMode, sessionDefaultApiKey } = {}) {
  const userKey = String(apiKey || "").trim();
  if (userKey) return userKey;
  if (String(credentialMode || "").trim() !== "session") {
    throw userError("外部 API Key 不能为空");
  }

  const sessionKey = String(sessionDefaultApiKey || "").trim();
  if (!sessionKey) {
    const error = new Error("服务器未配置 Session 默认兑换凭证");
    error.status = 500;
    throw error;
  }
  return sessionKey;
}

function chunk(items, size = MAX_BATCH) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function getPayloadError(payload) {
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

function pickItems(payload) {
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function withRequestTimeout(operation) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await operation(controller);
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardJson({ apiKey, endpoint, body, fetchImpl }) {
  try {
    return await withRequestTimeout(async (controller) => {
      const response = await fetchImpl(`${REDEEM_API_BASE_URL}${endpoint}`, {
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

      const rawText = await readTextWithLimit(response, {
        maxBytes: MAX_REDEEM_RESPONSE_BYTES,
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
          payloadError || payload?.message || payload?.error || `兑换后台请求失败，HTTP ${response.status}`
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
          responseBytes: new TextEncoder().encode(rawText).byteLength,
          itemCount: pickItems(payload).length
        }
      };
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("兑换后台请求超时");
    }
    throw error;
  }
}

const REDEEM_ROUTES = {
  "/api/redeem/submit": {
    endpoint: "/api/external/cdkey-redeems",
    fieldName: "items",
    makeBody: (items) => ({
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
    })
  },
  "/api/redeem/status": {
    endpoint: "/api/external/cdkey-redeems/status",
    fieldName: "cdkeys",
    makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
  },
  "/api/redeem/cancel": {
    endpoint: "/api/external/cdkey-jobs/cancel",
    fieldName: "cdkeys",
    makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
  },
  "/api/redeem/retry": {
    endpoint: "/api/external/cdkey-jobs/retry",
    fieldName: "cdkeys",
    makeBody: (cdkeys) => ({ cdkeys: cdkeys.map((cdkey) => String(cdkey || "").trim()) })
  }
};

async function handleRedeem(body, route, env, fetchImpl) {
  try {
    const input = body?.[route.fieldName];
    if (!Array.isArray(input) || input.length === 0) {
      return jsonResponse({ error: `${route.fieldName} 不能为空` }, 400);
    }

    const batches = chunk(input);
    const apiKey = resolveRedeemApiKey({
      apiKey: body?.apiKey,
      credentialMode: body?.credentialMode,
      sessionDefaultApiKey: env.SESSION_REDEEM_API_KEY
    });
    const results = [];
    const backendBatches = [];
    let failedBatch = null;

    for (const [index, batch] of batches.entries()) {
      try {
        const { payload, meta } = await forwardJson({
          apiKey,
          endpoint: route.endpoint,
          body: route.makeBody(batch),
          fetchImpl
        });
        results.push(payload);
        backendBatches.push({
          ...meta,
          index: index + 1,
          inputCount: batch.length,
          ok: true,
          status: "succeeded"
        });
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
    return jsonResponse({
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
    }, partial ? 207 : 200);
  } catch (error) {
    return jsonResponse(sanitizePublicError(error, { message: "请求失败" }), error.status || 500);
  }
}

function createSubscriptionDiagnostic(category, overrides = {}) {
  const normalizedCategory = SUBSCRIPTION_DIAGNOSTIC_META[category] ? category : "unknown";
  const meta = SUBSCRIPTION_DIAGNOSTIC_META[normalizedCategory];
  return {
    category: normalizedCategory,
    title: overrides.title || meta.title,
    message: sanitizePublicMessage(overrides.message || meta.message),
    retryable: overrides.retryable ?? meta.retryable,
    httpStatus: overrides.httpStatus ?? null,
    remoteMessage: sanitizePublicMessage(overrides.remoteMessage || ""),
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
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
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
  if (/empty[-_\s]?token|token\s*不能为空|缺少\s*at|缺少.*token/.test(text)) return "missing_token";
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

function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return ["true", "1", "yes", "y", "是"].includes(value.trim().toLowerCase());
  return false;
}

function isPlusPlan(planType, subscriptionPlan) {
  const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedType = normalize(planType);
  const normalizedPlan = normalize(subscriptionPlan);
  if (normalizedType === "plus") return true;
  if (["free", "pro", "team"].includes(normalizedType)) return false;
  return normalizedPlan === "plus" || normalizedPlan.includes("plus");
}

function getSubscriptionPayloadDiagnostic(payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const httpStatus = options.httpStatus ?? null;
  const remoteMessage = getSubscriptionRemoteMessage(payload);
  if (options.parsedJson === false) {
    return createSubscriptionDiagnostic("bad_response", { httpStatus, remoteMessage, checkedAt });
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
    Boolean(planType || subscriptionPlan) || Object.prototype.hasOwnProperty.call(source, "has_active_subscription");
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
  if (!hasPlanInfo) return createSubscriptionDiagnostic("bad_response", { httpStatus, remoteMessage, checkedAt });

  const planIsPlus = isPlusPlan(planType, subscriptionPlan);
  if (planIsPlus && hasActiveSubscription === true) {
    return createSubscriptionDiagnostic("plus", { message: "已确认活跃 Plus", httpStatus, remoteMessage, checkedAt });
  }
  return createSubscriptionDiagnostic("not_plus", {
    message: planIsPlus ? "Plus 套餐但没有活跃订阅" : `非 Plus 套餐：${planType || subscriptionPlan || "未知"}`,
    httpStatus,
    remoteMessage,
    checkedAt
  });
}

async function handleSubscription(body, fetchImpl) {
  const token = String(body?.token || "").trim();
  if (!token) {
    const diagnostic = createSubscriptionDiagnostic("missing_token");
    return jsonResponse({ ok: false, error: diagnostic.message, diagnostic, ...diagnostic }, 400);
  }

  const checkedAt = new Date().toISOString();
  try {
    return await withRequestTimeout(async (controller) => {
      const response = await fetchImpl(`${SUBSCRIPTION_API_BASE_URL}/api/v1/subscription`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal: controller.signal
      });
      const rawText = await readTextWithLimit(response, {
        maxBytes: MAX_SUBSCRIPTION_RESPONSE_BYTES,
        signal: controller.signal,
        abortController: controller
      });
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
      const publicError = sanitizePublicError({
        code: payload?.code || issueCategory || "SUBSCRIPTION_UPSTREAM_ERROR",
        message: diagnostic.message,
        requestId: payload?.requestId || payload?.request_id || "",
        payload
      });
      return jsonResponse(
        { ok: false, ...publicError, diagnostic, ...diagnostic },
        response.status
      );
      }

      const diagnostic = getSubscriptionPayloadDiagnostic(payload, {
        httpStatus: response.status,
        checkedAt,
        parsedJson
      });
      return jsonResponse({
        ok: true,
        subscription: sanitizeUpstreamPayload(payload),
        diagnostic,
        ...diagnostic
      });
    });
  } catch (error) {
    const category = error instanceof ResponseBodyTooLargeError
      ? "bad_response"
      : error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "network_error";
    const diagnostic = createSubscriptionDiagnostic(category, {
      message: category === "timeout" ? undefined : error.message,
      remoteMessage: category === "network_error" ? error.message : "",
      checkedAt
    });
    const publicError = sanitizePublicError(error, {
      code: `SUBSCRIPTION_${category.toUpperCase()}`,
      message: diagnostic.message
    });
    return jsonResponse(
      { ok: false, ...publicError, diagnostic, ...diagnostic },
      category === "timeout" ? 504 : 502
    );
  }
}

function parseMailboxPayload(rawText, contentType) {
  const text = String(rawText || "");
  if (/application\/json/i.test(String(contentType || "")) || /^[\s\r\n]*[{[]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

async function handleEmailVerification(body, env, fetchImpl) {
  const checkedAt = new Date().toISOString();
  const urlOptions = { allowedHosts: env.MAILBOX_ALLOWED_HOSTS, requireAllowedHost: true };
  let currentUrl = isSafeMailboxUrl(body?.pickupUrl, urlOptions);
  if (!String(body?.pickupUrl || "").trim()) {
    const diagnostic = createEmailVerificationDiagnostic("missing_url", { checkedAt });
    return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 400);
  }
  if (!currentUrl) {
    const diagnostic = createEmailVerificationDiagnostic("invalid_url", { checkedAt });
    return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 400);
  }

  try {
    return await withRequestTimeout(async (controller) => {
      let response;
      for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
        response = await fetchImpl(currentUrl.toString(), {
          method: "GET",
          headers: {
            Accept: "text/html,application/json;q=0.9,text/plain;q=0.8",
            "User-Agent": "cdk-redeem-console/1.0"
          },
          redirect: "manual",
          signal: controller.signal
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        const redirectUrl = location
          ? isSafeMailboxUrl(new URL(location, currentUrl).toString(), urlOptions)
          : false;
        if (!redirectUrl) {
          const diagnostic = createEmailVerificationDiagnostic("invalid_url", { checkedAt });
          return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 400);
        }
        currentUrl = redirectUrl;
        if (redirectCount === 3) {
          const diagnostic = createEmailVerificationDiagnostic("http_error", { message: "邮箱取件页面重定向次数过多", checkedAt });
          return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 502);
        }
      }

      if (!response?.ok) {
        const diagnostic = createEmailVerificationDiagnostic("http_error", {
          message: `邮箱取件页面返回 HTTP ${response?.status || 502}`,
          httpStatus: response?.status || null,
          checkedAt
        });
        return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 502);
      }
      const rawText = await readTextWithLimit(response, {
        maxBytes: MAX_MAILBOX_RESPONSE_BYTES,
        signal: controller.signal,
        abortController: controller
      });
      if (!rawText.trim()) {
        const diagnostic = createEmailVerificationDiagnostic("bad_response", { httpStatus: response.status, checkedAt });
        return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 502);
      }
      const payload = parseMailboxPayload(rawText, response.headers.get("content-type"));
      const diagnostic = analyzeEmailPlusContent(payload, {
        httpStatus: response.status,
        checkedAt,
        redeemedAt: body?.redeemedAt
      });
      return jsonResponse({ ok: true, emailVerification: diagnostic, diagnostic, ...diagnostic });
    });
  } catch (error) {
    const category = error instanceof ResponseBodyTooLargeError
      ? "bad_response"
      : error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "network_error";
    const diagnostic = createEmailVerificationDiagnostic(category, {
      message: category === "timeout" ? undefined : error.message,
      checkedAt
    });
    return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, category === "timeout" ? 504 : 502);
  }
}

function safeDownloadFileName(fileName) {
  const fallback = "success_accounts.txt";
  const sanitized = String(fileName || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  const withExtension = sanitized || fallback;
  return withExtension.toLowerCase().endsWith(".txt") ? withExtension : `${withExtension}.txt`;
}

function handleDownload(body) {
  const fileName = safeDownloadFileName(body?.fileName);
  const asciiName = fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "download.txt";
  return new Response(String(body?.content || ""), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    }
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw userError("请求 JSON 格式无效");
  }
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

  const rateLimitResponse = await applyRateLimits(request, env, url.pathname);
  if (rateLimitResponse) return rateLimitResponse;

  if (url.pathname === "/api/security/config" && request.method === "GET") {
    return jsonResponse({ siteKey: String(env.TURNSTILE_SITE_KEY || "") });
  }
  if (url.pathname === "/api/security/status" && request.method === "GET") {
    return handleSecurityStatus(request, env);
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return jsonResponse({ error: error.message }, error.status || 400);
  }

  if (requiresSecuritySession({ pathname: url.pathname, body }) && !(await getSecuritySession(request, env))) {
    return jsonResponse({ error: "请先完成人机验证", code: "SECURITY_SESSION_REQUIRED" }, 403);
  }

  if (url.pathname === "/api/security/verify") {
    return handleSecurityVerify(request, body, env, fetchImpl);
  }
  const redeemRoute = REDEEM_ROUTES[url.pathname];
  if (redeemRoute) {
    try {
      validateRedeemRequest(url.pathname, body);
    } catch (error) {
      return jsonResponse(
        { error: error.message || "请求格式无效", code: "INVALID_REQUEST" },
        400
      );
    }
    return handleRedeem(body, redeemRoute, env, fetchImpl);
  }
  if (url.pathname === "/api/subscription/check") return handleSubscription(body, fetchImpl);
  if (url.pathname === "/api/subscription/email-check") return handleEmailVerification(body, env, fetchImpl);
  if (url.pathname === "/api/download/text") return handleDownload(body);
  return jsonResponse({ error: "接口不存在" }, 404);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
