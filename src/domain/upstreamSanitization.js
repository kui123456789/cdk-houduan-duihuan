const MAX_PUBLIC_TEXT_LENGTH = 2_000;

const STATUS_TEXT_FIELDS = new Set([
  "cdkey", "cdKey", "cd_key", "cdk", "key",
  "channel", "pool", "queue", "redeem_channel",
  "status", "state", "result", "message", "error", "error_message", "errorMessage", "reason", "code",
  "request_id", "requestId",
  "finished_at", "finishedAt", "completed_at", "completedAt", "redeemed_at", "redeemedAt",
  "success_at", "successAt", "updated_at", "updatedAt",
  "plan_type", "subscription_plan", "checked_at", "checkedAt"
]);

const STATUS_BOOLEAN_FIELDS = new Set([
  "ok", "success", "found", "cancelled",
  "can_cancel", "can_retry", "can_reuse_token", "has_access_token",
  "has_active_subscription", "missingStatusItem", "partial"
]);

const STATUS_NUMBER_FIELDS = new Set([
  "syncPendingSince", "httpStatus", "processedCount", "remainingCount", "batchCount"
]);

export function sanitizePublicMessage(value, fallback = "") {
  let text = String(value ?? fallback ?? "");
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|passwd|passkey|2fa|otp|two[_-]?factor(?:[_-]?code)?|session|authorization|cookie|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(/\r?\n\s*at\s+[^\r\n]*/gi, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return text.slice(0, MAX_PUBLIC_TEXT_LENGTH);
}

function sanitizeScalar(key, value) {
  if (STATUS_BOOLEAN_FIELDS.has(key)) return value === true || value === 1 || value === "true";
  if (STATUS_NUMBER_FIELDS.has(key)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  return sanitizePublicMessage(value);
}

export function sanitizeUpstreamStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      !STATUS_TEXT_FIELDS.has(key) &&
      !STATUS_BOOLEAN_FIELDS.has(key) &&
      !STATUS_NUMBER_FIELDS.has(key)
    ) {
      continue;
    }
    if (fieldValue == null || typeof fieldValue === "object") continue;
    sanitized[key] = sanitizeScalar(key, fieldValue);
  }
  return sanitized;
}

export function sanitizeUpstreamPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeUpstreamStatus);
  if (!value || typeof value !== "object") return {};

  const sanitized = sanitizeUpstreamStatus(value);
  if (Array.isArray(value.items)) sanitized.items = value.items.map(sanitizeUpstreamStatus);
  if (Array.isArray(value.data)) sanitized.data = value.data.map(sanitizeUpstreamStatus);
  else if (value.data && typeof value.data === "object") {
    sanitized.data = sanitizeUpstreamPayload(value.data);
  }
  if (value.subscription && typeof value.subscription === "object") {
    sanitized.subscription = sanitizeUpstreamPayload(value.subscription);
  }
  return sanitized;
}

function firstText(...values) {
  return values.find((value) => String(value ?? "").trim()) ?? "";
}

export function sanitizePublicError(error, options = {}) {
  const payload = error?.payload && typeof error.payload === "object" ? error.payload : {};
  const code = sanitizePublicMessage(
    firstText(error?.code, payload?.code, options.code, "UPSTREAM_REQUEST_FAILED")
  ).slice(0, 128);
  const message = sanitizePublicMessage(
    firstText(error?.message, payload?.message, payload?.error, options.message, "上游请求失败")
  );
  const requestId = sanitizePublicMessage(
    firstText(error?.requestId, error?.request_id, payload?.requestId, payload?.request_id)
  ).slice(0, 256);
  return { code, message, requestId };
}
