import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureDemoDb } from "./bootstrap";
import * as schema from "./schema";

/** The drizzle handle plus the underlying connection (needed by the migration runner). */
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Wrap an open better-sqlite3 connection (used by the app and by tests with ':memory:'). */
export function createDb(sqlite: Database.Database): Db {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

const globalForDb = globalThis as unknown as { __db?: Db };

/** Server-only singleton. Never import from client components. */
export function getDb(): Db {
  if (!globalForDb.__db) {
    const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = createDb(new Database(file));
    ensureDemoDb(db); // no-op unless NETLIFY_DEMO=1
    globalForDb.__db = db;
  }
  return globalForDb.__db;
}
