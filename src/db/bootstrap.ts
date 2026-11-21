import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import type { Db } from "./client";
import { seedDatabase } from "./seed";

/** True on the hosted demo (Netlify), where the DB lives in /tmp and is created on demand. */
export const isDemo = () => process.env.NETLIFY_DEMO === "1";

/**
 * Demo mode only: create the schema from the committed migrations and load sample data
 * the first time a (possibly brand-new, ephemeral) database is opened. Idempotent.
 */
export function ensureDemoDb(db: Db): void {
  if (!isDemo()) return;
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  seedDatabase(db);
}
