export function createWorkerHeartbeatService({
  database,
  maxAgeMs = Number(process.env.WORKER_READY_MAX_AGE_MS || 30_000)
} = {}) {
  if (!database?.query) throw new TypeError("database is required");

  return {
    async markRunning(workerId) {
      await database.query(
        `INSERT INTO worker_heartbeats (worker_id, status, started_at, last_seen_at)
         VALUES ($1, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (worker_id) DO UPDATE SET
           status = 'running', last_seen_at = CURRENT_TIMESTAMP`,
        [workerId]
      );
    },

    async markStopped(workerId) {
      await database.query(
        `UPDATE worker_heartbeats
         SET status = 'stopped', last_seen_at = CURRENT_TIMESTAMP
         WHERE worker_id = $1`,
        [workerId]
      );
    },

    async check() {
      const result = await database.query(
        `SELECT last_seen_at FROM worker_heartbeats
         WHERE status = 'running'
         ORDER BY last_seen_at DESC LIMIT 1`
      );
      const lastSeenAt = result.rows[0]?.last_seen_at;
      const ageMs = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : Infinity;
      return { ready: Number.isFinite(ageMs) && ageMs <= maxAgeMs, lastSeenAt: lastSeenAt || null };
    }
  };
}
