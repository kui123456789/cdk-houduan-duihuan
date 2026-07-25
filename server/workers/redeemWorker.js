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
  pollMs = 1_000
} = {}) {
  if (!repository) throw new TypeError("repository is required");
  if (typeof processItem !== "function") throw new TypeError("processItem is required");
  let stopped = true;
  let loopPromise = null;

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
        }
      }

      const status = failedCount ? "failed" : "completed";
      await repository.appendEvent({
        jobId: job.id,
        type: status === "completed" ? "job_completed" : "job_failed",
        payload: { failedCount }
      });
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
      const result = await runOnce().catch(() => null);
      if (!result && !stopped) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    workerId,
    runOnce,
    start() {
      if (!stopped) return loopPromise;
      stopped = false;
      loopPromise = loop();
      return loopPromise;
    },
    async stop() {
      stopped = true;
      await loopPromise;
    }
  };
}
