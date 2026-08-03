import express from "express";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import {
  analyzeEmailPlusContent,
  createEmailVerificationDiagnostic,
  isSafeMailboxUrl,
  readResponseTextWithLimit
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

function isPublicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  if ([0, 10, 127].includes(a) || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 168) || (b === 0 && [0, 2].includes(c)))) return false;
  if (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isPublicMailboxAddress(value) {
  const address = String(value || "").trim().toLowerCase().split("%")[0];
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);
  if (address === "::" || address === "::1") return false;
  if (/^(?:fc|fd|fe[89ab])/.test(address)) return false;
  if (address.startsWith("2001:db8:")) return false;
  return true;
}

async function validateResolvedMailboxTarget(url, lookupImpl, checkedAt) {
  let resolved;
  try {
    resolved = await lookupImpl(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw verificationError(
      "network_error",
      { message: `邮箱取件地址解析失败：${error.message || "DNS 错误"}`, checkedAt },
      502
    );
  }
  const addresses = (Array.isArray(resolved) ? resolved : [resolved])
    .map((item) => {
      const address = String(item?.address || item || "").trim();
      return { address, family: Number(item?.family || net.isIP(address)) };
    })
    .filter((item) => item.address);
  if (!addresses.length || addresses.some((item) => !isPublicMailboxAddress(item.address))) {
    throw verificationError("invalid_url", { message: "邮箱取件链接解析到了非公网地址", checkedAt }, 400);
  }
  return addresses;
}

function requestPinnedMailboxTarget(url, options, target) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) {
          callback(null, [target]);
          return;
        }
        callback(null, target.address, target.family);
      }
    }, (response) => {
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      }
      const status = response.statusCode || 502;
      const hasBody = ![204, 205, 304].includes(status);
      resolve(new Response(hasBody ? Readable.toWeb(response) : null, {
        status,
        statusText: response.statusMessage || "",
        headers
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

export async function forwardEmailVerification(
  pickupUrl,
  { redeemedAt = "", fetchImpl = fetch, config = {} } = {}
) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const lookupImpl = resolvedConfig.mailboxDnsLookup || dns.lookup;
  const requestImpl = resolvedConfig.mailboxRequestImpl ||
    (fetchImpl === fetch
      ? requestPinnedMailboxTarget
      : (url, options) => fetchImpl(url.toString(), options));
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
      const [resolvedTarget] = await validateResolvedMailboxTarget(currentUrl, lookupImpl, checkedAt);
      const requestOptions = {
        method: "GET",
        headers: {
          Accept: "text/html,application/json;q=0.9,text/plain;q=0.8",
          "User-Agent": "cdk-redeem-console/1.0"
        },
        redirect: "manual",
        signal: controller.signal
      };
      response = await requestImpl(currentUrl, requestOptions, resolvedTarget);
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

    const rawText = await readResponseTextWithLimit(response, resolvedConfig.maxMailboxResponseBytes);
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
    if (error?.code === "MAILBOX_RESPONSE_TOO_LARGE") {
      throw verificationError("bad_response", { message: error.message, checkedAt }, 502);
    }
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
