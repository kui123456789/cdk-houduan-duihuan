import { randomUUID } from "node:crypto";

function errorCode(error) {
  return String(error?.code || "ITEM_PROCESSING_FAILED").slice(0, 100);
}

export function createRedeemWorker({
  repository,
  processItem,
  workerId = randomUUID(),
  leaseMs = 30_000,
  heartbeatMs = 10_000,
  pollMs = 1_000,
  heartbeatService = null,
  logger = null,
  metrics = null
} = {}) {
  if (!repository) throw new TypeError("repository is required");
  if (typeof processItem !== "function") throw new TypeError("processItem is required");
  let stopped = true;
  let loopPromise = null;
  let serviceHeartbeatTimer = null;
  const log = logger?.child({ workerId });

  async function finishCancelled(job, remainingItems) {
    for (const item of remainingItems) {
      if (!["queued", "running"].includes(item.status)) continue;
      await repository.updateItem(
        item.id,
        { status: "cancelled" },
        { jobId: job.id, expectedLeaseOwner: workerId }
      );
    }
    await repository.cancelPendingAttempts?.(job.id);
    await repository.appendEvent({ jobId: job.id, type: "job_cancelled", payload: {} });
    log?.info("job_cancelled", { jobId: job.id });
    metrics?.recordWorker("cancelled");
    return repository.updateJobStatus(
      job.id,
      {
        status: "cancelled",
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null
      },
      { expectedLeaseOwner: workerId }
    );
  }

  async function runOnce() {
    await repository.recoverExpiredLeases();
    const job = await repository.claimNextJob({ workerId, leaseMs });
    if (!job) return null;
    await repository.appendEvent({
      jobId: job.id,
      type: "job_started",
      payload: { workerAttempt: job.workerAttempts || 1 }
    });
    log?.info("job_started", { jobId: job.id, eventType: "job_started" });
    const heartbeat = setInterval(() => {
      repository.heartbeatJob(job.id, workerId, { leaseMs }).catch(() => {});
    }, heartbeatMs);
    heartbeat.unref?.();

    let failedCount = 0;
    try {
      for (const [index, item] of job.items.entries()) {
        if (item.status === "succeeded") continue;
        const latest = await repository.getJob(job.id);
        if (latest?.cancelRequestedAt) {
          return await finishCancelled(job, job.items.slice(index));
        }
        const attempt = await (repository.startAttempt || repository.createAttempt)({
          jobId: job.id,
          itemId: item.id,
          status: "running",
          trigger: item.attemptSequence ? "retry" : "initial",
          cdkeyHash: item.cdkeyHash,
          accountHash: item.accountHash,
          tokenHash: item.tokenHash
        });
        await repository.updateItem(
          item.id,
          { status: "running", errorCode: null, errorMessage: null },
          { jobId: job.id, expectedLeaseOwner: workerId }
        );
        await repository.appendEvent({
          jobId: job.id,
          itemId: item.id,
          attemptId: attempt.id,
          type: "attempt_started",
          payload: { attemptNumber: attempt.attemptNumber }
        });
        log?.info("attempt_started", {
          jobId: job.id,
          itemId: item.id,
          attemptId: attempt.id,
          eventType: "attempt_started"
        });
        try {
          const outcome = await processItem({ job, item, attempt });
          await repository.updateItem(
            item.id,
            {
              status: outcome?.status || "succeeded",
              result: outcome?.result || {},
              errorCode: null,
              errorMessage: null
            },
            { jobId: job.id, expectedLeaseOwner: workerId }
          );
          await repository.completeAttempt(attempt.id, { status: "completed" });
          await repository.appendEvent({
            jobId: job.id,
            itemId: item.id,
            attemptId: attempt.id,
            type: "item_succeeded",
            payload: { attemptNumber: attempt.attemptNumber }
          });
          log?.info("item_succeeded", {
            jobId: job.id,
            itemId: item.id,
            attemptId: attempt.id,
            eventType: "item_succeeded"
          });
        } catch (error) {
          if (error?.code === "JOB_CANCEL_REQUESTED") {
            return await finishCancelled(job, job.items.slice(index));
          }
          failedCount += 1;
          const code = errorCode(error);
          await repository.updateItem(
            item.id,
            { status: "failed", errorCode: code, errorMessage: null },
            { jobId: job.id, expectedLeaseOwner: workerId }
          );
          await repository.completeAttempt(attempt.id, {
            status: "failed",
            errorCode: code,
            errorMessage: null
          });
          await repository.appendEvent({
            jobId: job.id,
            itemId: item.id,
            attemptId: attempt.id,
            type: "item_failed",
            payload: { attemptNumber: attempt.attemptNumber, errorCode: code }
          });
          log?.warn("item_failed", {
            jobId: job.id,
            itemId: item.id,
            attemptId: attempt.id,
            eventType: "item_failed",
            errorCode: code
          });
        }
      }

      const status = failedCount ? "failed" : "completed";
      await repository.appendEvent({
        jobId: job.id,
        type: status === "completed" ? "job_completed" : "job_failed",
        payload: { failedCount }
      });
      log?.info(status === "completed" ? "job_completed" : "job_failed", {
        jobId: job.id,
        eventType: status === "completed" ? "job_completed" : "job_failed",
        errorCode: failedCount ? "ITEMS_FAILED" : undefined
      });
      metrics?.recordWorker(status);
      return repository.updateJobStatus(
        job.id,
        {
          status,
          finishedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          errorCode: failedCount ? "ITEMS_FAILED" : null,
          errorMessage: null
        },
        { expectedLeaseOwner: workerId }
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function loop() {
    while (!stopped) {
      const result = await runOnce().catch((error) => {
        log?.error("worker_loop_failed", {
          eventType: "worker_loop_failed",
          errorCode: errorCode(error),
          error
        });
        metrics?.recordWorker("loop_error");
        return null;
      });
      if (!result && !stopped) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    workerId,
    runOnce,
    start() {
      if (!stopped) return loopPromise;
      stopped = false;
      if (heartbeatService) {
        void heartbeatService.markRunning(workerId).catch((error) => {
          log?.error("worker_heartbeat_failed", { errorCode: "WORKER_HEARTBEAT_FAILED", error });
        });
        serviceHeartbeatTimer = setInterval(() => {
          heartbeatService.markRunning(workerId).catch((error) => {
            log?.error("worker_heartbeat_failed", { errorCode: "WORKER_HEARTBEAT_FAILED", error });
          });
        }, heartbeatMs);
        serviceHeartbeatTimer.unref?.();
      }
      log?.info("worker_started", { eventType: "worker_started" });
      loopPromise = loop();
      return loopPromise;
    },
    async stop() {
      stopped = true;
      await loopPromise;
      if (serviceHeartbeatTimer) clearInterval(serviceHeartbeatTimer);
      serviceHeartbeatTimer = null;
      await heartbeatService?.markStopped(workerId);
      log?.info("worker_stopped", { eventType: "worker_stopped" });
    }
  };
}
