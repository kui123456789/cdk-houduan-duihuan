import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/index.js";

const SENSITIVE_JSON_KEYS = new Set([
  "password",
  "twofa",
  "accesstoken",
  "token",
  "apikey",
  "authorization",
  "session",
  "sessiontext"
]);

function normalizedKey(value) {
  return String(value || "").replace(/[_-]/g, "").toLowerCase();
}

function assertSafeJson(value, path = "metadata", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) {
    const error = new TypeError(`${path} must be JSON serializable`);
    error.code = "INVALID_JSON";
    throw error;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`, seen));
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_JSON_KEYS.has(normalizedKey(key))) {
      const error = new TypeError(`${path}.${key} cannot contain raw credentials`);
      error.code = "SENSITIVE_DATA_REJECTED";
      throw error;
    }
    assertSafeJson(item, `${path}.${key}`, seen);
  }
}

function jsonValue(value, label) {
  const normalized = value && typeof value === "object" ? value : {};
  assertSafeJson(normalized, label);
  return JSON.stringify(normalized);
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    credentialMode: row.credential_mode,
    requestHash: row.request_hash,
    metadata: row.metadata || {},
    eventSequence: Number(row.event_sequence || 0),
    workerAttempts: Number(row.worker_attempts || 0),
    nextRunAt: row.next_run_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    cancelRequestedAt: row.cancel_requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    ordinal: Number(row.ordinal),
    status: row.status,
    cdkey: row.cdkey,
    cdkeyHash: row.cdkey_hash,
    channel: row.channel,
    accountHash: row.account_hash,
    tokenHash: row.token_hash,
    secretRef: row.secret_ref,
    attemptSequence: Number(row.attempt_sequence || 0),
    result: row.result || {},
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    itemId: row.item_id,
    attemptNumber: Number(row.attempt_number),
    status: row.status,
    trigger: row.trigger,
    cdkeyHash: row.cdkey_hash,
    accountHash: row.account_hash,
    tokenHash: row.token_hash,
    upstreamReference: row.upstream_reference,
    metadata: row.metadata || {},
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    jobId: row.job_id,
    itemId: row.item_id,
    attemptId: row.attempt_id,
    sequence: Number(row.sequence),
    type: row.type,
    actorId: row.actor_id,
    payload: row.payload || {},
    createdAt: row.created_at
  };
}

function stateError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function buildUpdate(table, idColumn, id, fields, allowedFields) {
  const assignments = [];
  const values = [id];
  for (const [key, column] of Object.entries(allowedFields)) {
    if (!Object.hasOwn(fields, key)) continue;
    values.push(fields[key] ?? null);
    assignments.push(`${column} = $${values.length}`);
  }
  if (!assignments.length) return null;
  assignments.push("updated_at = CURRENT_TIMESTAMP");
  return {
    text: `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${idColumn} = $1 RETURNING *`,
    values
  };
}

async function appendEventWithClient(client, input) {
  const sequenceResult = await client.query(
    `UPDATE redeem_jobs
     SET event_sequence = event_sequence + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING event_sequence`,
    [input.jobId]
  );
  if (!sequenceResult.rowCount) {
    const error = new Error("Job not found");
    error.code = "JOB_NOT_FOUND";
    throw error;
  }

  const result = await client.query(
    `INSERT INTO redeem_events
      (job_id, item_id, attempt_id, sequence, type, payload, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING *`,
    [
      input.jobId,
      input.itemId || null,
      input.attemptId || null,
      sequenceResult.rows[0].event_sequence,
      String(input.type || "event"),
      jsonValue(input.payload, "event.payload"),
      String(input.actorId || "system")
    ]
  );
  return mapEvent(result.rows[0]);
}

async function getJobWithClient(client, jobId) {
  const jobResult = await client.query("SELECT * FROM redeem_jobs WHERE id = $1", [jobId]);
  if (!jobResult.rowCount) return null;
  const itemResult = await client.query(
    "SELECT * FROM redeem_job_items WHERE job_id = $1 ORDER BY ordinal, created_at",
    [jobId]
  );
  return { ...mapJob(jobResult.rows[0]), items: itemResult.rows.map(mapItem) };
}

export function createJobRepository(database) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("A PostgreSQL Pool is required");
  }

  return {
    async createJob(input = {}, options = {}) {
      const id = input.id || randomUUID();
      const items = Array.isArray(input.items) ? input.items : [];
      const metadata = jsonValue(input.metadata, "job.metadata");

      return withTransaction(database, async (client) => {
        if (options.idempotency?.keyHash) {
          const scope = options.idempotency.scope || "jobs:create";
          await client.query(
            `INSERT INTO idempotency_locks (scope, key_hash)
             VALUES ($1, $2)
             ON CONFLICT (scope, key_hash) DO NOTHING`,
            [scope, options.idempotency.keyHash]
          );
          await client.query(
            `SELECT scope FROM idempotency_locks
             WHERE scope = $1 AND key_hash = $2
             FOR UPDATE`,
            [scope, options.idempotency.keyHash]
          );
          const existing = await client.query(
            `SELECT * FROM idempotency_keys
             WHERE scope = $1 AND key_hash = $2
             FOR UPDATE`,
            [scope, options.idempotency.keyHash]
          );
          if (existing.rowCount) {
            if (existing.rows[0].request_hash !== input.requestHash) {
              throw stateError("Idempotency key was used for another request", "IDEMPOTENCY_CONFLICT");
            }
            return {
              ...(await getJobWithClient(client, existing.rows[0].job_id)),
              idempotentReplay: true
            };
          }
        }

        if (options.createInitialAttempts === true) {
          for (const item of items) {
            const active = await client.query(
              `SELECT id FROM redeem_attempts
               WHERE cdkey_hash = $1 AND status IN ('queued', 'running')
               LIMIT 1 FOR UPDATE`,
              [item.cdkeyHash]
            );
            if (active.rowCount) {
              throw stateError("CDK already has an active attempt", "ACTIVE_CDK_EXISTS");
            }
          }
        }

        for (const item of items) {
          await options.accountLimitService?.reserveAttempt(client, item.accountHash);
        }

        const jobResult = await client.query(
          `INSERT INTO redeem_jobs
            (id, status, source, credential_mode, request_hash, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING *`,
          [
            id,
            String(input.status || "queued"),
            String(input.source || "api"),
            String(input.credentialMode || "secret_ref"),
            input.requestHash || null,
            metadata
          ]
        );

        const createdItems = [];
        for (const [ordinal, item] of items.entries()) {
          const itemResult = await client.query(
            `INSERT INTO redeem_job_items
              (id, job_id, ordinal, status, cdkey, cdkey_hash, channel,
               account_hash, token_hash, secret_ref, result)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
             RETURNING *`,
            [
              item.id || randomUUID(),
              id,
              ordinal,
              String(item.status || "queued"),
              String(item.cdkey || ""),
              String(item.cdkeyHash || ""),
              String(item.channel || ""),
              item.accountHash || null,
              item.tokenHash || null,
              item.secretRef || null,
              jsonValue(item.result, `job.items[${ordinal}].result`)
            ]
          );
          createdItems.push(mapItem(itemResult.rows[0]));
          if (options.createInitialAttempts === true) {
            await client.query(
              "UPDATE redeem_job_items SET attempt_sequence = 1 WHERE id = $1",
              [itemResult.rows[0].id]
            );
            try {
              await client.query(
                `INSERT INTO redeem_attempts
                  (id, job_id, item_id, attempt_number, status, trigger,
                   cdkey_hash, account_hash, token_hash, metadata)
                 VALUES ($1, $2, $3, 1, 'queued', 'initial', $4, $5, $6, '{}'::jsonb)`,
                [
                  randomUUID(),
                  id,
                  itemResult.rows[0].id,
                  item.cdkeyHash,
                  item.accountHash || null,
                  item.tokenHash || null
                ]
              );
            } catch (error) {
              if (error?.code === "23505") {
                throw stateError("CDK already has an active attempt", "ACTIVE_CDK_EXISTS");
              }
              throw error;
            }
          }
        }

        if (options.idempotency?.keyHash) {
          try {
            await client.query(
              `INSERT INTO idempotency_keys
                (id, scope, key_hash, request_hash, job_id, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                randomUUID(),
                options.idempotency.scope || "jobs:create",
                options.idempotency.keyHash,
                input.requestHash,
                id,
                options.idempotency.expiresAt || null
              ]
            );
          } catch (error) {
            if (error?.code === "23505") {
              throw stateError("Concurrent idempotency replay", "IDEMPOTENCY_RACE");
            }
            throw error;
          }
        }

        await appendEventWithClient(client, {
          jobId: id,
          type: "job_created",
          actorId: options.actorId,
          payload: { itemCount: createdItems.length, source: input.source || "api" }
        });
        return { ...mapJob(jobResult.rows[0]), items: createdItems };
      });
    },

    async getJob(jobId) {
      const jobResult = await database.query("SELECT * FROM redeem_jobs WHERE id = $1", [jobId]);
      if (!jobResult.rowCount) return null;
      const itemResult = await database.query(
        "SELECT * FROM redeem_job_items WHERE job_id = $1 ORDER BY ordinal, created_at",
        [jobId]
      );
      return {
        ...mapJob(jobResult.rows[0]),
        items: itemResult.rows.map(mapItem)
      };
    },

    async getJobByIdempotencyKey({ scope = "jobs:create", keyHash }) {
      const result = await database.query(
        "SELECT * FROM idempotency_keys WHERE scope = $1 AND key_hash = $2",
        [scope, keyHash]
      );
      if (!result.rowCount) return null;
      const job = await this.getJob(result.rows[0].job_id);
      return { job, requestHash: result.rows[0].request_hash };
    },

    async claimNextJob({ workerId, leaseMs = 30_000 } = {}) {
      const owner = String(workerId || "").trim();
      if (!owner) throw new TypeError("workerId is required");
      const leaseSeconds = Math.max(Number(leaseMs) / 1000, 1);
      return withTransaction(database, async (client) => {
        const candidate = await client.query(
          `SELECT id FROM redeem_jobs
           WHERE status = 'queued' AND next_run_at <= NOW()
             AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
           ORDER BY next_run_at, created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED`
        );
        if (!candidate.rowCount) return null;
        const jobResult = await client.query(
          `UPDATE redeem_jobs
           SET status = 'running', lease_owner = $2,
               lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
               heartbeat_at = CURRENT_TIMESTAMP,
               started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
               worker_attempts = worker_attempts + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'queued'
           RETURNING *`,
          [candidate.rows[0].id, owner, leaseSeconds]
        );
        if (!jobResult.rowCount) return null;
        const itemResult = await client.query(
          "SELECT * FROM redeem_job_items WHERE job_id = $1 ORDER BY ordinal, created_at",
          [candidate.rows[0].id]
        );
        return { ...mapJob(jobResult.rows[0]), items: itemResult.rows.map(mapItem) };
      });
    },

    async heartbeatJob(jobId, workerId, { leaseMs = 30_000 } = {}) {
      const leaseSeconds = Math.max(Number(leaseMs) / 1000, 1);
      const result = await database.query(
        `UPDATE redeem_jobs
         SET heartbeat_at = CURRENT_TIMESTAMP,
             lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'running' AND lease_owner = $2
         RETURNING id`,
        [jobId, workerId, leaseSeconds]
      );
      return result.rowCount === 1;
    },

    async recoverExpiredLeases() {
      return withTransaction(database, async (client) => {
        const recovered = await client.query(
          `UPDATE redeem_jobs
           SET status = 'queued', next_run_at = CURRENT_TIMESTAMP,
               lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
               finished_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE status = 'running' AND lease_expires_at < NOW()
             AND cancel_requested_at IS NULL
           RETURNING id, status`
        );
        const cancelled = await client.query(
          `UPDATE redeem_jobs
           SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP,
               lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE status = 'running' AND lease_expires_at < NOW()
             AND cancel_requested_at IS NOT NULL
           RETURNING id, status`
        );
        for (const row of [...recovered.rows, ...cancelled.rows]) {
          await appendEventWithClient(client, {
            jobId: row.id,
            type: row.status === "queued" ? "job_lease_recovered" : "job_cancelled",
            payload: { reason: "lease_expired" }
          });
        }
        return recovered.rowCount + cancelled.rowCount;
      });
    },

    async updateJobStatus(jobId, input = {}, options = {}) {
      const update = buildUpdate("redeem_jobs", "id", jobId, input, {
        status: "status",
        nextRunAt: "next_run_at",
        leaseOwner: "lease_owner",
        leaseExpiresAt: "lease_expires_at",
        heartbeatAt: "heartbeat_at",
        cancelRequestedAt: "cancel_requested_at",
        startedAt: "started_at",
        finishedAt: "finished_at",
        errorCode: "error_code",
        errorMessage: "error_message"
      });
      if (!update) return this.getJob(jobId);
      if (options.expectedLeaseOwner) {
        update.values.push(options.expectedLeaseOwner);
        update.text = update.text.replace(
          "WHERE id = $1",
          `WHERE id = $1 AND lease_owner = $${update.values.length}`
        );
      }
      const result = await database.query(update.text, update.values);
      if (!result.rowCount && options.expectedLeaseOwner) {
        throw stateError("Job lease was lost", "JOB_LEASE_LOST");
      }
      return mapJob(result.rows[0]);
    },

    async updateItem(itemId, input = {}, options = {}) {
      if (Object.hasOwn(input, "result")) input = { ...input, result: jsonValue(input.result, "item.result") };
      const update = buildUpdate("redeem_job_items", "id", itemId, input, {
        status: "status",
        result: "result",
        errorCode: "error_code",
        errorMessage: "error_message"
      });
      if (!update) return null;
      if (Object.hasOwn(input, "result")) {
        update.text = update.text.replace(/result = \$(\d+)/, "result = $$$1::jsonb");
      }
      if (options.jobId && options.expectedLeaseOwner) {
        update.values.push(options.jobId, options.expectedLeaseOwner);
        update.text = update.text.replace(
          "WHERE id = $1",
          `WHERE id = $1 AND EXISTS (
             SELECT 1 FROM redeem_jobs
             WHERE id = $${update.values.length - 1} AND lease_owner = $${update.values.length}
               AND status = 'running'
           )`
        );
      }
      const result = await database.query(update.text, update.values);
      if (!result.rowCount && options.expectedLeaseOwner) {
        throw stateError("Job lease was lost", "JOB_LEASE_LOST");
      }
      return mapItem(result.rows[0]);
    },

    async requestCancel(jobId, options = {}) {
      return withTransaction(database, async (client) => {
        const current = await client.query(
          "SELECT * FROM redeem_jobs WHERE id = $1 FOR UPDATE",
          [jobId]
        );
        if (!current.rowCount) throw stateError("Job not found", "JOB_NOT_FOUND", 404);
        const status = current.rows[0].status;
        if (["completed", "failed", "cancelled"].includes(status)) {
          throw stateError("Job cannot be cancelled from its current state", "JOB_NOT_CANCELLABLE");
        }
        const nextStatus = status === "queued" ? "cancelled" : status;
        const result = nextStatus === "cancelled"
          ? await client.query(
              `UPDATE redeem_jobs
               SET status = 'cancelled', cancel_requested_at = CURRENT_TIMESTAMP,
                   finished_at = CURRENT_TIMESTAMP, lease_owner = NULL,
                   lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1 RETURNING *`,
              [jobId]
            )
          : await client.query(
              `UPDATE redeem_jobs
               SET cancel_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1 RETURNING *`,
              [jobId]
            );
        if (nextStatus === "cancelled") {
          await client.query(
            `UPDATE redeem_job_items SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
             WHERE job_id = $1 AND status = 'queued'`,
            [jobId]
          );
          await client.query(
            `UPDATE redeem_attempts
             SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE job_id = $1 AND status = 'queued'`,
            [jobId]
          );
        }
        await appendEventWithClient(client, {
          jobId,
          type: nextStatus === "cancelled" ? "job_cancelled" : "job_cancel_requested",
          actorId: options.actorId,
          payload: {}
        });
        return { ...mapJob(result.rows[0]), status: nextStatus === "running" ? "cancel_requested" : nextStatus };
      });
    },

    async retryJob(jobId, options = {}) {
      return withTransaction(database, async (client) => {
        const current = await client.query(
          "SELECT * FROM redeem_jobs WHERE id = $1 FOR UPDATE",
          [jobId]
        );
        if (!current.rowCount) throw stateError("Job not found", "JOB_NOT_FOUND", 404);
        if (!["failed", "cancelled"].includes(current.rows[0].status)) {
          throw stateError("Job cannot be retried from its current state", "JOB_NOT_RETRYABLE");
        }
        const retryItems = await client.query(
          `SELECT * FROM redeem_job_items
           WHERE job_id = $1 AND status IN ('failed', 'cancelled')
           ORDER BY ordinal FOR UPDATE`,
          [jobId]
        );
        for (const item of retryItems.rows) {
          await options.accountLimitService?.reserveAttempt(client, item.account_hash);
        }
        await client.query(
          `UPDATE redeem_job_items
           SET status = 'queued', result = '{}'::jsonb, error_code = NULL,
               error_message = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE job_id = $1 AND status IN ('failed', 'cancelled')`,
          [jobId]
        );
        for (const item of retryItems.rows) {
          const sequence = Number(item.attempt_sequence || 0) + 1;
          await client.query(
            "UPDATE redeem_job_items SET attempt_sequence = $2 WHERE id = $1",
            [item.id, sequence]
          );
          try {
            await client.query(
              `INSERT INTO redeem_attempts
                (id, job_id, item_id, attempt_number, status, trigger,
                 cdkey_hash, account_hash, token_hash, metadata)
               VALUES ($1, $2, $3, $4, 'queued', 'retry', $5, $6, $7, '{}'::jsonb)`,
              [
                randomUUID(), jobId, item.id, sequence, item.cdkey_hash,
                item.account_hash, item.token_hash
              ]
            );
          } catch (error) {
            if (error?.code === "23505") {
              throw stateError("CDK already has an active attempt", "ACTIVE_CDK_EXISTS");
            }
            throw error;
          }
        }
        const result = await client.query(
          `UPDATE redeem_jobs
           SET status = 'queued', next_run_at = CURRENT_TIMESTAMP,
               lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
               cancel_requested_at = NULL, finished_at = NULL,
               error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 RETURNING *`,
          [jobId]
        );
        await appendEventWithClient(client, {
          jobId,
          type: "job_retried",
          actorId: options.actorId,
          payload: {}
        });
        return mapJob(result.rows[0]);
      });
    },

    async cancelPendingAttempts(jobId) {
      const result = await database.query(
        `UPDATE redeem_attempts
         SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE job_id = $1 AND status = 'queued'
         RETURNING *`,
        [jobId]
      );
      return result.rows.map(mapAttempt);
    },

    async createAttempt(input) {
      const metadata = jsonValue(input.metadata, "attempt.metadata");
      return withTransaction(database, async (client) => {
        const sequenceResult = await client.query(
          `UPDATE redeem_job_items
           SET attempt_sequence = attempt_sequence + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND job_id = $2
           RETURNING attempt_sequence`,
          [input.itemId, input.jobId]
        );
        if (!sequenceResult.rowCount) {
          const error = new Error("Job item not found");
          error.code = "JOB_ITEM_NOT_FOUND";
          throw error;
        }

        const result = await client.query(
          `INSERT INTO redeem_attempts
            (id, job_id, item_id, attempt_number, status, trigger, cdkey_hash,
             account_hash, token_hash, upstream_reference, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           RETURNING *`,
          [
            input.id || randomUUID(),
            input.jobId,
            input.itemId,
            sequenceResult.rows[0].attempt_sequence,
            String(input.status || "running"),
            String(input.trigger || "initial"),
            String(input.cdkeyHash || ""),
            input.accountHash || null,
            input.tokenHash || null,
            input.upstreamReference || null,
            metadata
          ]
        );
        return mapAttempt(result.rows[0]);
      });
    },

    async startAttempt(input) {
      return withTransaction(database, async (client) => {
        const queued = await client.query(
          `SELECT * FROM redeem_attempts
           WHERE job_id = $1 AND item_id = $2 AND status = 'queued'
           ORDER BY attempt_number DESC
           LIMIT 1 FOR UPDATE`,
          [input.jobId, input.itemId]
        );
        if (queued.rowCount) {
          const result = await client.query(
            `UPDATE redeem_attempts
             SET status = 'running', started_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [queued.rows[0].id]
          );
          return mapAttempt(result.rows[0]);
        }

        const sequenceResult = await client.query(
          `UPDATE redeem_job_items
           SET attempt_sequence = attempt_sequence + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND job_id = $2
           RETURNING attempt_sequence`,
          [input.itemId, input.jobId]
        );
        if (!sequenceResult.rowCount) throw stateError("Job item not found", "JOB_ITEM_NOT_FOUND", 404);
        const result = await client.query(
          `INSERT INTO redeem_attempts
            (id, job_id, item_id, attempt_number, status, trigger,
             cdkey_hash, account_hash, token_hash, metadata)
           VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8, '{}'::jsonb)
           RETURNING *`,
          [
            randomUUID(), input.jobId, input.itemId,
            sequenceResult.rows[0].attempt_sequence, input.trigger || "initial",
            input.cdkeyHash, input.accountHash || null, input.tokenHash || null
          ]
        );
        return mapAttempt(result.rows[0]);
      });
    },

    async completeAttempt(attemptId, input = {}) {
      const result = await database.query(
        `UPDATE redeem_attempts
         SET status = $2, error_code = $3, error_message = $4,
             finished_at = COALESCE($5, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [
          attemptId,
          String(input.status || "completed"),
          input.errorCode || null,
          input.errorMessage || null,
          input.finishedAt || null
        ]
      );
      return mapAttempt(result.rows[0]);
    },

    async listAttempts(jobId) {
      const result = await database.query(
        `SELECT * FROM redeem_attempts
         WHERE job_id = $1
         ORDER BY created_at, item_id, attempt_number`,
        [jobId]
      );
      return result.rows.map(mapAttempt);
    },

    async appendEvent(input) {
      return withTransaction(database, (client) => appendEventWithClient(client, input));
    },

    async listEvents(jobId, options = {}) {
      const after = Math.max(Number(options.after || 0), 0);
      const limit = Math.min(Math.max(Number(options.limit || 500), 1), 1000);
      const result = await database.query(
        `SELECT * FROM redeem_events
         WHERE job_id = $1 AND sequence > $2
         ORDER BY sequence
         LIMIT $3`,
        [jobId, after, limit]
      );
      return result.rows.map(mapEvent);
    },

    async createIdempotencyKey(input) {
      const result = await database.query(
        `INSERT INTO idempotency_keys
          (id, scope, key_hash, request_hash, job_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          input.id || randomUUID(),
          String(input.scope || "jobs:create"),
          String(input.keyHash || ""),
          String(input.requestHash || ""),
          input.jobId,
          input.expiresAt || null
        ]
      );
      return result.rows[0];
    }
  };
}
