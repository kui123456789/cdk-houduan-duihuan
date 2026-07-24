import {
  analyzeEmailPlusContent,
  createEmailVerificationDiagnostic,
  isSafeMailboxUrl
} from "../src/domain/emailVerification.js";

const REDEEM_API_BASE_URL = "https://chong.nerver.cc";
const SUBSCRIPTION_API_BASE_URL = "https://cha.nerver.cc";
const EXTERNAL_CLIENT_ID = "nerver-redeem-local";
const REQUEST_TIMEOUT_MS = 45_000;
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
  if (!binding?.limit) return true;
  try {
    const result = await binding.limit({ key });
    return result.success === true;
  } catch (error) {
    console.error("[security] rate limiter unavailable", error);
    return true;
  }
}

async function applyRateLimits(request, env, pathname) {
  const ip = getClientIp(request);
  if (!(await checkRateLimit(env.API_RATE_LIMITER, ip))) {
    return jsonResponse({ error: "请求过于频繁，请稍后重试" }, 429, { "Retry-After": "60" });
  }

  if (pathname === "/api/security/verify" || pathname === "/api/subscription/email-check") {
    if (!(await checkRateLimit(env.VERIFICATION_RATE_LIMITER, ip))) {
      return jsonResponse({ error: "安全验证尝试过于频繁，请稍后重试" }, 429, { "Retry-After": "60" });
    }
  }

  if (["/api/redeem/submit", "/api/redeem/cancel", "/api/redeem/retry"].includes(pathname)) {
    if (!(await checkRateLimit(env.MUTATION_RATE_LIMITER, ip))) {
      return jsonResponse({ error: "兑换操作过于频繁，请稍后重试" }, 429, { "Retry-After": "60" });
    }
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

async function getSecuritySession(request, env) {
  return verifySecuritySession(readCookie(request, SECURITY_COOKIE_NAME), env.SECURITY_SESSION_SECRET);
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

async function fetchWithTimeout(url, init, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardJson({ apiKey, endpoint, body, fetchImpl }) {
  try {
    const response = await fetchWithTimeout(
      `${REDEEM_API_BASE_URL}${endpoint}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-Client-Id": EXTERNAL_CLIENT_ID,
          "X-External-Api-Key": requireApiKey(apiKey)
        },
        body: JSON.stringify(body)
      },
      fetchImpl
    );

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
        payloadError || payload?.message || payload?.error || `兑换后台请求失败，HTTP ${response.status}`;
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
        responseBytes: new TextEncoder().encode(rawText).byteLength,
        itemCount: pickItems(payload).length
      }
    };
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

    for (const batch of batches) {
      const { payload, meta } = await forwardJson({
        apiKey,
        endpoint: route.endpoint,
        body: route.makeBody(batch),
        fetchImpl
      });
      results.push(payload);
      backendBatches.push(meta);
    }

    const items = results.flatMap(pickItems);
    return jsonResponse({
      ok: true,
      batchCount: batches.length,
      backend: {
        emptyResponse: backendBatches.length > 0 && backendBatches.every((batch) => batch.emptyResponse),
        emptyBatchCount: backendBatches.filter((batch) => batch.emptyResponse).length,
        itemCount: items.length,
        batches: backendBatches
      },
      items
    });
  } catch (error) {
    return jsonResponse(
      { error: error.message || "请求失败", details: error.payload || undefined },
      error.status || 500
    );
  }
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
    const response = await fetchWithTimeout(
      `${SUBSCRIPTION_API_BASE_URL}/api/v1/subscription`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      },
      fetchImpl
    );
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
      return jsonResponse(
        { ok: false, error: diagnostic.message, diagnostic, ...diagnostic, details: payload || undefined },
        response.status
      );
    }

    const diagnostic = getSubscriptionPayloadDiagnostic(payload, {
      httpStatus: response.status,
      checkedAt,
      parsedJson
    });
    return jsonResponse({ ok: true, subscription: payload, diagnostic, ...diagnostic });
  } catch (error) {
    const category = error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error";
    const diagnostic = createSubscriptionDiagnostic(category, {
      message: category === "timeout" ? undefined : error.message,
      remoteMessage: category === "network_error" ? error.message : "",
      checkedAt
    });
    return jsonResponse({ ok: false, error: diagnostic.message, diagnostic, ...diagnostic }, category === "timeout" ? 504 : 502);
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

async function handleEmailVerification(body, fetchImpl) {
  const checkedAt = new Date().toISOString();
  let currentUrl = isSafeMailboxUrl(body?.pickupUrl);
  if (!String(body?.pickupUrl || "").trim()) {
    const diagnostic = createEmailVerificationDiagnostic("missing_url", { checkedAt });
    return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 400);
  }
  if (!currentUrl) {
    const diagnostic = createEmailVerificationDiagnostic("invalid_url", { checkedAt });
    return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 400);
  }

  try {
    let response;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetchWithTimeout(
        currentUrl.toString(),
        {
          method: "GET",
          headers: {
            Accept: "text/html,application/json;q=0.9,text/plain;q=0.8",
            "User-Agent": "cdk-redeem-console/1.0"
          },
          redirect: "manual"
        },
        fetchImpl
      );
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      const redirectUrl = location ? isSafeMailboxUrl(new URL(location, currentUrl).toString()) : false;
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
    const rawText = await response.text();
    if (!rawText.trim()) {
      const diagnostic = createEmailVerificationDiagnostic("bad_response", { httpStatus: response.status, checkedAt });
      return jsonResponse({ ok: false, error: diagnostic.message, emailVerification: diagnostic, diagnostic, ...diagnostic }, 502);
    }
    const payload = parseMailboxPayload(rawText.slice(0, 2_000_000), response.headers.get("content-type"));
    const diagnostic = analyzeEmailPlusContent(payload, {
      httpStatus: response.status,
      checkedAt,
      redeemedAt: body?.redeemedAt
    });
    return jsonResponse({ ok: true, emailVerification: diagnostic, diagnostic, ...diagnostic });
  } catch (error) {
    const category = error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error";
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

  if (url.pathname === "/api/redeem/submit" && !(await getSecuritySession(request, env))) {
    return jsonResponse({ error: "请先完成人机验证" }, 403);
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return jsonResponse({ error: error.message }, error.status || 400);
  }

  if (url.pathname === "/api/security/verify") {
    return handleSecurityVerify(request, body, env, fetchImpl);
  }
  const redeemRoute = REDEEM_ROUTES[url.pathname];
  if (redeemRoute) return handleRedeem(body, redeemRoute, env, fetchImpl);
  if (url.pathname === "/api/subscription/check") return handleSubscription(body, fetchImpl);
  if (url.pathname === "/api/subscription/email-check") return handleEmailVerification(body, fetchImpl);
  if (url.pathname === "/api/download/text") return handleDownload(body);
  return jsonResponse({ error: "接口不存在" }, 404);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
