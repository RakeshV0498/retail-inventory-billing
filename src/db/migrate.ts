import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

export interface MigrationResult {
  /** The database was created by `drizzle-kit push` (no history); migration 0000 was recorded as already applied. */
  baselined: boolean;
  /** Migrations applied by this run. */
  applied: number;
}

const countApplied = (sqlite: Database.Database) =>
  (sqlite.prepare('select count(*) n from "__drizzle_migrations"').get() as { n: number }).n;

/**
 * Bring a SQLite database up to date using the committed SQL migrations (non-interactive, additive, tracked).
 *
 * Why not `drizzle-kit push`: it can't be trusted on a live database. It treats `default 0` as "no default"
 * and demands an interactive data-loss confirmation. Databases created by older versions of this app (via
 * `push`) have the exact schema of migration 0000 but no history table, so that one is recorded as applied
 * first; only the newer migrations then run.
 */
export function runMigrations(sqlite: Database.Database, migrationsFolder: string): MigrationResult {
  const has = (name: string) => !!sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
  const files = readMigrationFiles({ migrationsFolder });
  let baselined = false;

  if (has("products") && !has("__drizzle_migrations")) {
    const first = files[0];
    if (!first) throw new Error("No migrations found to baseline against");
    sqlite.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    sqlite.prepare('insert into "__drizzle_migrations" (hash, created_at) values (?, ?)').run(first.hash, first.folderMillis);
    baselined = true;
  }

  const before = has("__drizzle_migrations") ? countApplied(sqlite) : 0;
  migrate(drizzle(sqlite), { migrationsFolder });
  return { baselined, applied: countApplied(sqlite) - before };
}
