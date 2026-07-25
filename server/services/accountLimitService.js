import { withTransaction } from "../db/index.js";

export const ACCOUNT_ATTEMPT_LIMIT = 3;
export const ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_COOLDOWN_MS = ACCOUNT_WINDOW_MS;

function limitError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 429;
  Object.assign(error, details);
  return error;
}

function mapLimit(row) {
  if (!row) return null;
  return {
    accountHash: row.account_hash,
    attemptCount: Number(row.attempt_count || 0),
    windowStartedAt: row.window_started_at,
    cooldownUntil: row.cooldown_until,
    cooldownReason: row.cooldown_reason,
    version: Number(row.version || 0),
    updatedAt: row.updated_at
  };
}

export function createAccountLimitService(database, options = {}) {
  if (!database?.query) throw new TypeError("A PostgreSQL Pool is required");
  const attemptLimit = Number(options.attemptLimit || ACCOUNT_ATTEMPT_LIMIT);
  const windowMs = Number(options.windowMs || ACCOUNT_WINDOW_MS);
  const cooldownMs = Number(options.cooldownMs || ACCOUNT_COOLDOWN_MS);

  async function lockLimit(client, accountHash) {
    await client.query(
      `INSERT INTO account_limits (account_hash)
       VALUES ($1)
       ON CONFLICT (account_hash) DO NOTHING`,
      [accountHash]
    );
    const result = await client.query(
      `SELECT account_limits.*, CURRENT_TIMESTAMP AS server_now
       FROM account_limits
       WHERE account_hash = $1
       FOR UPDATE`,
      [accountHash]
    );
    return result.rows[0];
  }

  return {
    async reserveAttempt(client, accountHash) {
      const normalizedHash = String(accountHash || "").trim();
      if (!normalizedHash) return null;
      const current = await lockLimit(client, normalizedHash);
      const serverNow = new Date(current.server_now);
      const windowStartedAt = current.window_started_at
        ? new Date(current.window_started_at)
        : null;
      const cooldownUntil = current.cooldown_until
        ? new Date(current.cooldown_until)
        : null;
      const windowExpired = !windowStartedAt || serverNow - windowStartedAt >= windowMs;
      const activeCooldown = cooldownUntil && cooldownUntil > serverNow;
      if (activeCooldown) {
        throw limitError("Account is cooling down", "ACCOUNT_COOLDOWN", { cooldownUntil });
      }
      const attemptCount = windowExpired ? 0 : Number(current.attempt_count || 0);
      if (attemptCount >= attemptLimit) {
        throw limitError("Account attempt limit reached", "ACCOUNT_ATTEMPT_LIMIT", {
          cooldownUntil: new Date(serverNow.getTime() + cooldownMs)
        });
      }

      const result = await client.query(
        `UPDATE account_limits
         SET attempt_count = $2, window_started_at = $3,
             cooldown_until = $4, cooldown_reason = $5,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE account_hash = $1
         RETURNING *`,
        [
          normalizedHash,
          attemptCount + 1,
          windowExpired ? serverNow : windowStartedAt,
          windowExpired ? null : current.cooldown_until,
          windowExpired ? null : current.cooldown_reason
        ]
      );
      return mapLimit(result.rows[0]);
    },

    async recordFailure(accountHash, input = {}) {
      const normalizedHash = String(accountHash || "").trim();
      if (!normalizedHash) return null;
      return withTransaction(database, async (client) => {
        const current = await lockLimit(client, normalizedHash);
        const count = Number(current.attempt_count || 0);
        if (count < attemptLimit && input.dailyLimit !== true) return mapLimit(current);
        const serverNow = new Date(current.server_now);
        const result = await client.query(
          `UPDATE account_limits
           SET attempt_count = $2, cooldown_until = $3, cooldown_reason = $4,
               version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE account_hash = $1
           RETURNING *`,
          [
            normalizedHash,
            Math.max(count, input.dailyLimit === true ? attemptLimit : count),
            new Date(serverNow.getTime() + cooldownMs),
            String(input.reason || "attempt_limit")
          ]
        );
        return mapLimit(result.rows[0]);
      });
    },

    async getLimit(accountHash) {
      const result = await database.query(
        "SELECT * FROM account_limits WHERE account_hash = $1",
        [accountHash]
      );
      return mapLimit(result.rows[0]);
    }
  };
}
