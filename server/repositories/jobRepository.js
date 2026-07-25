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
    payload: row.payload || {},
    createdAt: row.created_at
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
      (job_id, item_id, attempt_id, sequence, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      input.jobId,
      input.itemId || null,
      input.attemptId || null,
      sequenceResult.rows[0].event_sequence,
      String(input.type || "event"),
      jsonValue(input.payload, "event.payload")
    ]
  );
  return mapEvent(result.rows[0]);
}

export function createJobRepository(database) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("A PostgreSQL Pool is required");
  }

  return {
    async createJob(input = {}) {
      const id = input.id || randomUUID();
      const items = Array.isArray(input.items) ? input.items : [];
      const metadata = jsonValue(input.metadata, "job.metadata");

      return withTransaction(database, async (client) => {
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
        }

        await appendEventWithClient(client, {
          jobId: id,
          type: "job_created",
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
