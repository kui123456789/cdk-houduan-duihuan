import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, withTransaction } from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultMigrationsDir = path.join(__dirname, "migrations");

async function ensureMigrationTable(database) {
  const existing = await database.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
  );
  if (existing.rowCount) return;
  try {
    await database.query(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (error) {
    if (error?.code !== "42P07") throw error;
  }
}

async function listUpMigrations(migrationsDir) {
  const names = await fs.readdir(migrationsDir);
  return names
    .filter((name) => /^\d+_.+\.sql$/.test(name) && !name.endsWith(".down.sql"))
    .sort();
}

async function migrateUp(database, migrationsDir) {
  const migrations = await listUpMigrations(migrationsDir);
  const appliedResult = await database.query("SELECT name FROM schema_migrations");
  const applied = new Set(appliedResult.rows.map((row) => row.name));
  const completed = [];

  for (const name of migrations) {
    if (applied.has(name)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, name), "utf8");
    await withTransaction(database, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
    completed.push(name);
  }
  return completed;
}

async function migrateDown(database, migrationsDir) {
  const result = await database.query(
    "SELECT name FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1"
  );
  const name = result.rows[0]?.name;
  if (!name) return [];
  const downName = name.replace(/\.sql$/, ".down.sql");
  const sql = await fs.readFile(path.join(migrationsDir, downName), "utf8");
  await withTransaction(database, async (client) => {
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE name = $1", [name]);
  });
  return [name];
}

export async function runMigrations(database, options = {}) {
  const migrationsDir = options.migrationsDir || defaultMigrationsDir;
  await ensureMigrationTable(database);
  return options.direction === "down"
    ? migrateDown(database, migrationsDir)
    : migrateUp(database, migrationsDir);
}

async function main() {
  const database = createDatabase({ allowExitOnIdle: true });
  try {
    const direction = process.argv[2] === "down" ? "down" : "up";
    const completed = await runMigrations(database, { direction });
    console.log(
      completed.length
        ? `${direction} migrations: ${completed.join(", ")}`
        : `No ${direction} migrations to run`
    );
  } finally {
    await database.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`Database migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
