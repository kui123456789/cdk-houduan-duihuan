const EMAIL_PLUS_SUCCESS_PATTERNS = [
  /you[\u2019']?ve\s+successfully\s+subscribed\s+to\s+chatgpt\s+plus/i,
  /successfully\s+subscribed\s+to\s+chatgpt\s+plus/i
];

const EMAIL_ACCOUNT_BANNED_PATTERNS = [
  /your\s+account\s+has\s+been\s+banned\s+because\s+recent\s+activity\s+violated\s+our\s+terms\s+and\s+usage\s+policies/i
];

export const EMAIL_VERIFICATION_DIAGNOSTIC_META = {
  banned: { title: "账号已封禁", message: "已收到 OpenAI 账号封禁通知", retryable: false },
  verified: { title: "邮箱已验证", message: "已收到 ChatGPT Plus 开通成功邮件", retryable: false },
  missing_url: { title: "缺少邮箱取件链接", message: "账号邮箱已识别，但原始账号行没有 HTTP(S) 邮箱取件链接", retryable: false },
  invalid_url: { title: "邮箱取件链接无效", message: "邮箱取件链接必须是公开的 HTTP(S) 地址", retryable: false },
  not_found: { title: "未收到开通邮件", message: "邮箱中没有找到 ChatGPT Plus 开通成功邮件", retryable: true },
  stale: { title: "开通邮件过期", message: "找到的 Plus 邮件早于本次兑换成功时间", retryable: true },
  bad_response: { title: "邮箱页面异常", message: "邮箱取件页面返回内容无法识别", retryable: true },
  http_error: { title: "邮箱接口错误", message: "邮箱取件页面返回 HTTP 错误", retryable: true },
  timeout: { title: "邮箱检查超时", message: "邮箱取件页面响应超时，可重试", retryable: true },
  network_error: { title: "邮箱网络错误", message: "无法连接邮箱取件页面，可重试", retryable: true },
  unknown: { title: "邮箱检查失败", message: "邮箱 Plus 验证失败，可重试", retryable: true }
};

export function createEmptyEmailVerificationState() {
  return {
    emailVerificationStatus: "idle",
    emailVerificationCategory: "",
    emailVerificationTitle: "",
    emailVerificationReason: "",
    emailVerificationRetryable: false,
    emailVerificationHttpStatus: "",
    emailVerificationCheckedAt: "",
    emailVerificationOrderNumber: "",
    emailVerificationOrderDate: "",
    emailVerificationMatchedPhrase: "",
    emailPlusVerified: false,
    emailBanned: false
  };
}

export function createEmailVerificationDiagnostic(category, overrides = {}) {
  const normalizedCategory = EMAIL_VERIFICATION_DIAGNOSTIC_META[category] ? category : "unknown";
  const meta = EMAIL_VERIFICATION_DIAGNOSTIC_META[normalizedCategory];
  return {
    category: normalizedCategory,
    title: String(overrides.title || meta.title),
    message: String(overrides.message || meta.message),
    retryable: overrides.retryable ?? meta.retryable,
    httpStatus: overrides.httpStatus ?? null,
    checkedAt: overrides.checkedAt || new Date().toISOString(),
    orderNumber: String(overrides.orderNumber || ""),
    orderDate: String(overrides.orderDate || ""),
    matchedPhrase: String(overrides.matchedPhrase || "")
  };
}

export function isSafeMailboxUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      return false;
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return false;
    if (/^(127|10|192\.168|169\.254)\./.test(hostname) || hostname === "0.0.0.0") return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return false;
    if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) {
      return false;
    }
    return url;
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)));
}

function collectText(value, seen = new Set()) {
  if (value == null || seen.has(value)) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [String(value)];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, seen));
  return Object.values(value).flatMap((item) => collectText(item, seen));
}

export function normalizeMailboxText(value) {
  return decodeHtmlEntities(collectText(value).join("\n"))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOrderNumber(text) {
  const match = text.match(/order\s*(?:number|#)\s*[:#]?\s*([a-z0-9][a-z0-9_-]*)/i);
  return match?.[1] || "";
}

function extractOrderDate(text) {
  const match = text.match(/order\s*date\s*[:\-]?\s*((?:[a-z]{3,9}\s+\d{1,2},\s+\d{4})|(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}))/i);
  return match?.[1] || "";
}

export function analyzeEmailPlusContent(payload, options = {}) {
  const text = normalizeMailboxText(payload);
  const bannedPhrase = EMAIL_ACCOUNT_BANNED_PATTERNS.find((pattern) => pattern.test(text))?.source || "";
  if (bannedPhrase) {
    return createEmailVerificationDiagnostic("banned", {
      httpStatus: options.httpStatus,
      checkedAt: options.checkedAt,
      matchedPhrase: bannedPhrase
    });
  }

  const matchedPhrase = EMAIL_PLUS_SUCCESS_PATTERNS.find((pattern) => pattern.test(text))?.source || "";
  const orderNumber = extractOrderNumber(text);
  const orderDate = extractOrderDate(text);
  if (!matchedPhrase) {
    return createEmailVerificationDiagnostic("not_found", {
      httpStatus: options.httpStatus,
      checkedAt: options.checkedAt
    });
  }

  // A mailbox URL exposes the current account mailbox, so an existing Plus
  // confirmation is valid even when its order date predates the local CDK
  // redemption record. Subscription activity is checked separately.
  return createEmailVerificationDiagnostic("verified", {
    httpStatus: options.httpStatus,
    checkedAt: options.checkedAt,
    orderNumber,
    orderDate,
    matchedPhrase
  });
}

export function normalizeEmailVerificationResult(payload) {
  const diagnostic = payload?.diagnostic || payload?.emailVerification || payload || {};
  const category = EMAIL_VERIFICATION_DIAGNOSTIC_META[diagnostic.category]
    ? diagnostic.category
    : "unknown";
  const meta = EMAIL_VERIFICATION_DIAGNOSTIC_META[category];
  return {
    ...createEmptyEmailVerificationState(),
    emailVerificationStatus: category === "banned" ? "banned" : category === "verified" ? "verified" : category === "missing_url" ? "missing_url" : category === "not_found" || category === "stale" ? "not_found" : "error",
    emailVerificationCategory: category,
    emailVerificationTitle: String(diagnostic.title || meta.title),
    emailVerificationReason: String(diagnostic.message || meta.message),
    emailVerificationRetryable: diagnostic.retryable ?? meta.retryable,
    emailVerificationHttpStatus: diagnostic.httpStatus == null || diagnostic.httpStatus === "" ? "" : String(diagnostic.httpStatus),
    emailVerificationCheckedAt: String(diagnostic.checkedAt || ""),
    emailVerificationOrderNumber: String(diagnostic.orderNumber || ""),
    emailVerificationOrderDate: String(diagnostic.orderDate || ""),
    emailVerificationMatchedPhrase: String(diagnostic.matchedPhrase || ""),
    emailPlusVerified: category === "verified",
    emailBanned: category === "banned"
  };
}

export function getEmailVerificationLabel(row) {
  if (row?.status !== "success") return "-";
  switch (row?.emailVerificationStatus) {
    case "checking":
      return "检查中";
    case "banned":
      return row.emailVerificationTitle || "账号已封禁";
    case "verified":
      return row.emailVerificationTitle || "已验证";
    case "missing_url":
      return row.emailVerificationTitle || "缺少邮箱取件链接";
    case "not_found":
      return row.emailVerificationTitle || "未收到邮件";
    case "error":
      return row.emailVerificationTitle || "检查失败";
    default:
      return row?.isPlus === true ? "待验证" : "-";
  }
}
