import express from "express";
import { sanitizePublicError } from "../../src/domain/upstreamSanitization.js";

function sendError(res, error) {
  const status = Number(error?.status) || 500;
  const payload = sanitizePublicError(error, { message: "请求失败" });
  const messages = {
    JOB_NOT_FOUND: "任务不存在",
    JOB_NOT_CANCELLABLE: "当前任务状态不可取消",
    JOB_NOT_RETRYABLE: "当前任务状态不可重试",
    JOB_SECRET_UNAVAILABLE: "任务凭证不可用"
  };
  payload.message = messages[payload.code] || (status < 500 ? "任务请求无效" : "请求失败");
  return res.status(status).json(payload);
}

export function createJobsRouter({ jobService } = {}) {
  if (!jobService) throw new TypeError("jobService is required");
  const router = express.Router();

  router.post("/api/jobs", async (req, res) => {
    try {
      const job = await jobService.createJob(req.body, {
        idempotencyKey: String(req.get("Idempotency-Key") || "").trim()
      });
      return res.status(202).json({ job });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/api/jobs/:jobId", async (req, res) => {
    try {
      const job = await jobService.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ code: "JOB_NOT_FOUND", message: "任务不存在" });
      return res.json({ job });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/api/jobs/:jobId/events", async (req, res) => {
    try {
      const events = await jobService.listEvents(req.params.jobId, {
        after: req.query.after,
        limit: req.query.limit
      });
      if (!events) return res.status(404).json({ code: "JOB_NOT_FOUND", message: "任务不存在" });
      return res.json({ events });
    } catch (error) {
      return sendError(res, error);
    }
  });

  for (const [action, method] of [["cancel", "cancelJob"], ["retry", "retryJob"]]) {
    router.post(`/api/jobs/:jobId/${action}`, async (req, res) => {
      try {
        const job = await jobService[method](req.params.jobId, {});
        return res.status(202).json({ job });
      } catch (error) {
        return sendError(res, error);
      }
    });
  }

  return router;
}
