import { timingSafeEqual } from "node:crypto";

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

function forbidden(res, code, message, status = 403) {
  return res.status(status).json({ code, message });
}

export function requireAuthentication(req, res, next) {
  if (!req.auth?.user) return forbidden(res, "AUTHENTICATION_REQUIRED", "需要登录", 401);
  return next();
}

export function authorize(minimumRole) {
  const minimum = ROLE_RANK[minimumRole] || Number.POSITIVE_INFINITY;
  return (req, res, next) => {
    if (!req.auth?.user) return forbidden(res, "AUTHENTICATION_REQUIRED", "需要登录", 401);
    if ((ROLE_RANK[req.auth.user.role] || 0) < minimum) {
      return forbidden(res, "FORBIDDEN", "权限不足");
    }
    return next();
  };
}

export function createOriginGuard({ allowedOrigins = [] } = {}) {
  const configured = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins || "").split(","))
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin)
  );
  return (req, res, next) => {
    const origin = String(req.get("Origin") || "").trim();
    if (!origin) return forbidden(res, "ORIGIN_REQUIRED", "缺少 Origin");
    const sameOrigin = `${req.protocol}://${req.get("host")}`;
    if (origin !== sameOrigin && !configured.has(origin)) {
      return forbidden(res, "ORIGIN_REJECTED", "Origin 不受信任");
    }
    return next();
  };
}

export function createCsrfProtection({ hashToken }) {
  return (req, res, next) => {
    if (!req.auth?.user) return forbidden(res, "AUTHENTICATION_REQUIRED", "需要登录", 401);
    const candidate = hashToken(req.get("X-CSRF-Token") || "");
    const expected = String(req.auth.csrfHash || "");
    const left = Buffer.from(candidate, "hex");
    const right = Buffer.from(expected, "hex");
    if (!candidate || left.length !== right.length || !timingSafeEqual(left, right)) {
      return forbidden(res, "CSRF_REJECTED", "CSRF 验证失败");
    }
    return next();
  };
}
