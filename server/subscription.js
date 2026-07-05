import express from "express";

const DEFAULT_CONFIG = {
  subscriptionApiBaseUrl: "https://cha.nerver.cc",
  requestTimeoutMs: 45000
};

export const SUBSCRIPTION_DIAGNOSTIC_META = {
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

function userError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function createSubscriptionDiagnostic(category, overrides = {}) {
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

export function pickText(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text && text.trim()) return text.trim();
  }
  return "";
}

export function unwrapSubscriptionPayload(payload) {
  if (payload?.subscription && typeof payload.subscription === "object") return payload.subscription;
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === "object" ? payload : {};
}

export function getSubscriptionRemoteMessage(payload) {
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

export function classifySubscriptionIssue(message, httpStatus) {
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

export function normalizePlan(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    return ["true", "1", "yes", "y", "是"].includes(value.trim().toLowerCase());
  }
  return false;
}

export function isPlusPlan(planType, subscriptionPlan) {
  const normalizedType = normalizePlan(planType);
  const normalizedPlan = normalizePlan(subscriptionPlan);
  if (normalizedType === "plus") return true;
  if (["free", "pro", "team"].includes(normalizedType)) return false;
  return normalizedPlan === "plus" || normalizedPlan.includes("plus");
}

export function getSubscriptionPayloadDiagnostic(payload, options = {}) {
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

export async function forwardSubscriptionCheck(token, { fetchImpl = fetch, config = {} } = {}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const trimmedToken = String(token || "").trim();
  if (!trimmedToken) {
    const diagnostic = createSubscriptionDiagnostic("missing_token");
    const error = userError(diagnostic.message);
    error.diagnostic = diagnostic;
    throw error;
  }

  const url = `${resolvedConfig.subscriptionApiBaseUrl}/api/v1/subscription`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs);
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetchImpl(url, {
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

export function createSubscriptionRouter({ fetchImpl = fetch, config = {} } = {}) {
  const router = express.Router();
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };

  router.post("/api/subscription/check", async (req, res) => {
    try {
      const { payload, diagnostic } = await forwardSubscriptionCheck(req.body?.token, {
        fetchImpl,
        config: resolvedConfig
      });
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

  return router;
}
