import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client.js";

const MIGRATION_LOCK = 727002;

/** Finds the SQL migrations whether running from source or from a bundle. */
export function resolveMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    fileURLToPath(new URL("../drizzle", import.meta.url)),
    fileURLToPath(new URL("./drizzle", import.meta.url)),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(`${candidate}/meta/_journal.json`));
  if (!found) throw new Error(`Database migrations not found (looked in ${candidates.join(", ")})`);
  return found;
}

/**
 * Applies pending migrations. A session advisory lock, held on a reserved
 * connection, serializes concurrent starts (API and worker booting together).
 */
export async function runMigrations(database: Database, migrationsFolder = resolveMigrationsFolder()): Promise<void> {
  const reserved = await database.sql.reserve();
  try {
    await reserved`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(database.db, { migrationsFolder });
    } finally {
      await reserved`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    reserved.release();
  }
}
