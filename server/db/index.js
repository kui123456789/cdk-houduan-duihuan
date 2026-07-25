import { Pool } from "pg";

export function createDatabase(options = {}) {
  const connectionString = String(
    options.connectionString ?? process.env.DATABASE_URL ?? ""
  ).trim();
  if (!connectionString) {
    const error = new Error("DATABASE_URL is required");
    error.code = "DATABASE_URL_REQUIRED";
    throw error;
  }

  return new Pool({
    connectionString,
    max: Number(options.maxConnections || process.env.DATABASE_MAX_CONNECTIONS || 10),
    connectionTimeoutMillis: Number(options.connectionTimeoutMs || 5000),
    idleTimeoutMillis: Number(options.idleTimeoutMs || 30000),
    allowExitOnIdle: options.allowExitOnIdle === true,
    ...(options.poolConfig || {})
  });
}

export async function withTransaction(database, callback) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    client.release();
  }
}
