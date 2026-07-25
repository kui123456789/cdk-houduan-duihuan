import express from "express";
import { requireAuthentication } from "../auth/authorization.js";

function authError(res, error) {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    code: error?.code || "AUTH_FAILED",
    message: status < 500 ? "用户名或密码错误" : "认证服务不可用"
  });
}

export function createAuthRouter({ authService, originGuard, csrfProtection } = {}) {
  if (!authService) throw new TypeError("authService is required");
  const router = express.Router();
  router.use("/api/auth", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.post("/api/auth/login", originGuard, async (req, res) => {
    try {
      const session = await authService.login(req.body?.username, req.body?.password);
      authService.setSessionCookie(res, session.token, session.expiresAt);
      return res.json({
        user: session.user,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt
      });
    } catch (error) {
      return authError(res, error);
    }
  });

  router.get("/api/auth/me", requireAuthentication, async (req, res) => {
    try {
      const csrfToken = await authService.rotateCsrf(req.auth.tokenHash);
      req.auth.csrfHash = authService.hashCsrfToken(csrfToken);
      return res.json({ user: req.auth.user, csrfToken, expiresAt: req.auth.expiresAt });
    } catch (error) {
      return authError(res, error);
    }
  });

  router.post(
    "/api/auth/logout",
    originGuard,
    requireAuthentication,
    csrfProtection,
    async (req, res) => {
      await authService.revoke(req.auth.tokenHash);
      authService.clearSessionCookie(res);
      return res.status(204).end();
    }
  );

  return router;
}
