import express from "express";
import {
  analyzeEmailPlusContent,
  createEmailVerificationDiagnostic,
  isSafeMailboxUrl
} from "../src/domain/emailVerification.js";

const DEFAULT_CONFIG = {
  requestTimeoutMs: 45_000,
  maxMailboxResponseBytes: 2_000_000
};

function verificationError(category, overrides = {}, status = 500) {
  const diagnostic = createEmailVerificationDiagnostic(category, overrides);
  const error = new Error(diagnostic.message);
  error.status = status;
  error.diagnostic = diagnostic;
  return error;
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

export async function forwardEmailVerification(
  pickupUrl,
  { redeemedAt = "", fetchImpl = fetch, config = {} } = {}
) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  if (!String(pickupUrl || "").trim()) {
    throw verificationError("missing_url", {}, 400);
  }
  let currentUrl = isSafeMailboxUrl(pickupUrl);
  if (!currentUrl) throw verificationError("invalid_url", {}, 400);

  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs);
  try {
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
      if (!location) break;
      const redirectUrl = isSafeMailboxUrl(new URL(location, currentUrl).toString());
      if (!redirectUrl) throw verificationError("invalid_url", { checkedAt }, 400);
      currentUrl = redirectUrl;
      if (redirectCount === 3) {
        throw verificationError("http_error", { message: "邮箱取件页面重定向次数过多", checkedAt }, 502);
      }
    }

    if (!response?.ok) {
      throw verificationError(
        "http_error",
        {
          message: `邮箱取件页面返回 HTTP ${response?.status || 502}`,
          httpStatus: response?.status || null,
          checkedAt
        },
        502
      );
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > resolvedConfig.maxMailboxResponseBytes) {
      throw verificationError("bad_response", { message: "邮箱取件页面内容过大", checkedAt }, 502);
    }
    const rawText = await response.text();
    if (!rawText.trim()) {
      throw verificationError("bad_response", { httpStatus: response.status, checkedAt }, 502);
    }
    const limitedText = rawText.slice(0, resolvedConfig.maxMailboxResponseBytes);
    const payload = parseMailboxPayload(limitedText, response.headers.get("content-type"));
    return analyzeEmailPlusContent(payload, {
      httpStatus: response.status,
      checkedAt,
      redeemedAt
    });
  } catch (error) {
    if (error.diagnostic) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw verificationError("timeout", { checkedAt }, 504);
    }
    throw verificationError(
      "network_error",
      { message: error.message || "无法连接邮箱取件页面，可重试", checkedAt },
      502
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function createMailboxRouter({ fetchImpl = fetch, config = {} } = {}) {
  const router = express.Router();
  router.post("/api/subscription/email-check", async (req, res) => {
    try {
      const diagnostic = await forwardEmailVerification(req.body?.pickupUrl, {
        redeemedAt: req.body?.redeemedAt,
        fetchImpl,
        config
      });
      return res.json({ ok: true, emailVerification: diagnostic, diagnostic, ...diagnostic });
    } catch (error) {
      const diagnostic = error.diagnostic || createEmailVerificationDiagnostic("unknown", {
        message: error.message || "邮箱 Plus 验证失败"
      });
      return res.status(error.status || 500).json({
        ok: false,
        error: diagnostic.message,
        emailVerification: diagnostic,
        diagnostic,
        ...diagnostic
      });
    }
  });
  return router;
}
