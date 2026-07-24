export function createEmptySubscriptionState() {
  return {
    subscriptionStatus: "idle",
    subscriptionCategory: "",
    subscriptionTitle: "",
    subscriptionPlanType: "",
    subscriptionPlan: "",
    subscriptionTimestamp: "",
    hasActiveSubscription: null,
    subscriptionReason: "",
    subscriptionRetryable: false,
    subscriptionHttpStatus: "",
    subscriptionRemoteMessage: "",
    subscriptionCheckedAt: "",
    isPlus: false
  };
}

export const SUBSCRIPTION_DIAGNOSTIC_META = {
  plus: { title: "Plus", message: "已确认活跃 Plus", retryable: false },
  not_plus: { title: "非 Plus", message: "不是活跃 Plus", retryable: false },
  missing_token: { title: "缺少 at", message: "缺少 at/access_token，无法判断 Plus", retryable: false },
  token_invalid: { title: "Token 失效", message: "token 失效或无权限", retryable: false },
  no_account: { title: "账号不存在", message: "订阅接口未找到该账号", retryable: false },
  http_error: { title: "接口错误", message: "订阅接口返回 HTTP 错误，可点击查验证重试", retryable: true },
  timeout: { title: "接口超时", message: "订阅接口请求超时，可点击查验证重试", retryable: true },
  network_error: { title: "网络错误", message: "服务器无法连接订阅接口，可点击查验证重试", retryable: true },
  remote_error: { title: "接口返回失败", message: "订阅接口返回失败，可点击查验证重试", retryable: true },
  bad_response: { title: "返回异常", message: "订阅接口返回内容无法识别，可点击查验证重试", retryable: true },
  unknown: { title: "未知", message: "订阅检查结果未知，可点击查验证重试", retryable: true }
};

function normalizeSubscriptionCategory(value) {
  const category = String(value || "").trim();
  return SUBSCRIPTION_DIAGNOSTIC_META[category] ? category : "unknown";
}

function pickSubscriptionText(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text && text.trim()) return text.trim();
  }
  return "";
}

function getDiagnosticPayload(payload) {
  if (payload?.diagnostic && typeof payload.diagnostic === "object") return payload.diagnostic;
  if (payload?.subscription?.diagnostic && typeof payload.subscription.diagnostic === "object") {
    return payload.subscription.diagnostic;
  }
  if (payload?.category || payload?.title || payload?.message || payload?.httpStatus) return payload;
  return {};
}

function classifySubscriptionIssue(message, httpStatus) {
  const text = String(message || "").trim().toLowerCase();
  if (/empty[-_\s]?token|token\s*不能为空|缺少\s*at|缺少.*token/.test(text)) {
    return "missing_token";
  }
  if (
    Number(httpStatus) === 401 ||
    /jwt[-_\s]?expired|token[-_\s]?401|unauthori[sz]ed|invalid.*token|token.*invalid|token.*expired|expired.*token|jwt.*过期|token.*过期/.test(
      text
    )
  ) {
    return "token_invalid";
  }
  if (/no[-_\s]?account|account.*not.*found|账号不存在|未找到.*账号|没有.*账号/.test(text)) {
    return "no_account";
  }
  if (/timeout|超时/.test(text)) return "timeout";
  if (/network|fetch failed|econn|enotfound|无法连接|网络/.test(text)) return "network_error";
  return "";
}

function createSubscriptionDiagnosticState(input = {}, fallbackCategory = "unknown") {
  const category = normalizeSubscriptionCategory(input.category || fallbackCategory);
  const meta = SUBSCRIPTION_DIAGNOSTIC_META[category];
  const message = pickSubscriptionText(input.message, input.reason, input.remoteMessage, meta.message);
  return {
    subscriptionCategory: category,
    subscriptionTitle: pickSubscriptionText(input.title, meta.title),
    subscriptionReason: message,
    subscriptionRetryable: input.retryable ?? meta.retryable,
    subscriptionHttpStatus: input.httpStatus == null || input.httpStatus === "" ? "" : String(input.httpStatus),
    subscriptionRemoteMessage: pickSubscriptionText(input.remoteMessage, input.error, input.code),
    subscriptionCheckedAt: pickSubscriptionText(input.checkedAt) || formatDateTime(new Date())
  };
}

export function normalizeSubscriptionResult(payload) {
  const source = unwrapSubscriptionPayload(payload);
  const diagnosticPayload = getDiagnosticPayload(payload);
  const okValue = source?.ok;
  const okText = String(okValue ?? "").trim().toLowerCase();
  const planType = String(source?.plan_type ?? "").trim();
  const subscriptionPlan = String(source?.subscription_plan ?? "").trim();
  const apiSubscriptionTimestamp = getSubscriptionTimestamp(source);
  const hasActiveSubscription = isTruthy(source?.has_active_subscription);
  const planIsPlus = isPlusPlan(planType, subscriptionPlan);
  const errorReason = getSubscriptionReason(source, okText);
  const diagnosticMessage = pickSubscriptionText(
    diagnosticPayload.message,
    diagnosticPayload.remoteMessage,
    errorReason
  );
  const diagnosticCategory =
    diagnosticPayload.category ||
    classifySubscriptionIssue(diagnosticMessage, diagnosticPayload.httpStatus);
  const hasPlanInfo =
    Boolean(planType || subscriptionPlan) ||
    Object.prototype.hasOwnProperty.call(source, "has_active_subscription");
  const explicitError =
    okValue === false ||
    (typeof okValue === "string" && okText && !["ok", "true"].includes(okText)) ||
    Boolean(source?.error) ||
    (Boolean(errorReason) && !hasPlanInfo);
  const diagnosticIsError =
    diagnosticCategory &&
    !["plus", "not_plus"].includes(diagnosticCategory);

  if (explicitError || diagnosticIsError || (!hasPlanInfo && !errorReason && !diagnosticCategory)) {
    const fallbackCategory =
      diagnosticCategory ||
      classifySubscriptionIssue(errorReason, diagnosticPayload.httpStatus) ||
      (hasPlanInfo ? "remote_error" : "bad_response");
    const diagnostic = createSubscriptionDiagnosticState(
      {
        ...diagnosticPayload,
        category: fallbackCategory,
        message: diagnosticMessage || errorReason || diagnosticPayload.message
      },
      fallbackCategory
    );
    return {
      ...createEmptySubscriptionState(),
      ...diagnostic,
      subscriptionStatus: diagnostic.subscriptionCategory === "missing_token" ? "missing_token" : "error",
      subscriptionPlanType: planType,
      subscriptionPlan,
      subscriptionTimestamp: apiSubscriptionTimestamp,
      hasActiveSubscription
    };
  }

  const isPlus = planIsPlus && hasActiveSubscription === true;
  const browserSubscriptionTimestamp = isPlus && !apiSubscriptionTimestamp
    ? formatDateTime(new Date())
    : "";
  const subscriptionTimestamp = apiSubscriptionTimestamp || browserSubscriptionTimestamp;
  const category = isPlus ? "plus" : "not_plus";
  const reason = isPlus
    ? browserSubscriptionTimestamp
      ? "订阅接口未返回 Plus 时间，已使用浏览器当前时间"
      : "已确认活跃 Plus"
    : planIsPlus
      ? "Plus 套餐但没有活跃订阅"
      : `非 Plus 套餐：${planType || subscriptionPlan || "未知"}`;
  const diagnostic = createSubscriptionDiagnosticState(
    {
      ...diagnosticPayload,
      category,
      message: reason,
      retryable: false
    },
    category
  );

  return {
    subscriptionStatus: isPlus ? "plus" : "not_plus",
    ...diagnostic,
    subscriptionPlanType: planType,
    subscriptionPlan,
    subscriptionTimestamp,
    hasActiveSubscription,
    isPlus
  };
}

export function normalizeSubscriptionError(message, details = {}) {
  const category =
    details.category ||
    classifySubscriptionIssue(message, details.httpStatus) ||
    "unknown";
  const diagnostic = createSubscriptionDiagnosticState(
    {
      ...details,
      category,
      message
    },
    category
  );
  return {
    ...createEmptySubscriptionState(),
    ...diagnostic,
    subscriptionStatus: diagnostic.subscriptionCategory === "missing_token" ? "missing_token" : "error"
  };
}

export function getSubscriptionLabel(row) {
  if (row.status !== "success") return "-";

  switch (row.subscriptionStatus) {
    case "checking":
      return "检查中";
    case "plus":
      return row.subscriptionTitle || "Plus";
    case "plus_missing_time":
      return "Plus 缺时间";
    case "not_plus":
      return row.subscriptionTitle || "非 Plus";
    case "missing_token":
      return row.subscriptionTitle || "缺少 at";
    case "error":
      return row.subscriptionTitle || "检查失败";
    default:
      return row.accessToken ? "待检查" : "缺少 at";
  }
}

function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    return ["true", "1", "yes", "y", "是"].includes(value.trim().toLowerCase());
  }
  return false;
}

function unwrapSubscriptionPayload(payload) {
  if (payload?.subscription && typeof payload.subscription === "object") return payload.subscription;
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function normalizePlan(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isPlusPlan(planType, subscriptionPlan) {
  const normalizedType = normalizePlan(planType);
  const normalizedPlan = normalizePlan(subscriptionPlan);
  if (normalizedType === "plus") return true;
  if (["free", "pro", "team"].includes(normalizedType)) return false;
  return normalizedPlan === "plus" || normalizedPlan.includes("plus");
}

function getSubscriptionReason(source, okText) {
  const explicitReason = String(
    source?.reason ?? source?.message ?? source?.error ?? source?.error_message ?? ""
  ).trim();
  if (explicitReason) return explicitReason;
  if (okText && !["ok", "true"].includes(okText)) return okText;
  return "";
}

function getSubscriptionTimestamp(source) {
  const timestampValue =
    source?.expires_at ??
    source?.renews_at ??
    source?.expire_at ??
    source?.renew_at ??
    source?.expired_at ??
    source?.renewed_at ??
    source?.current_period_end ??
    source?.period_end ??
    source?.paid_until ??
    source?.valid_until ??
    source?.subscription_expires_at ??
    source?.subscription_renews_at ??
    source?.plus_expires_at ??
    source?.plus_renews_at ??
    source?.expiresAt ??
    source?.renewsAt ??
    source?.currentPeriodEnd ??
    source?.paidUntil ??
    source?.validUntil ??
    source?.activated_at ??
    source?.started_at ??
    source?.start_at ??
    source?.created_at ??
    source?.purchased_at ??
    "";

  return normalizeSubscriptionTimestamp(timestampValue);
}

function normalizeSubscriptionTimestamp(value) {
  if (value == null || value === "") return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
    return formatDateTime(new Date(milliseconds));
  }

  const text = String(value).trim();
  if (!text) return "";

  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const milliseconds = text.length >= 13 ? numeric : numeric * 1000;
    return formatDateTime(new Date(milliseconds));
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return text.includes("T") ? text.replace("T", " ") : text;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateTime(parsed);
  }

  return "";
}

function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
