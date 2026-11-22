import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate";

// Applies the committed SQL migrations (drizzle/*.sql). Safe on new and existing databases; asks nothing.
const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
fs.mkdirSync(path.dirname(file), { recursive: true });
const sqlite = new Database(file);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const res = runMigrations(sqlite, path.join(process.cwd(), "drizzle"));
if (res.baselined) console.log("Existing database detected: recorded the original schema as applied.");
console.log(res.applied === 0 ? `Database is up to date (${file})` : `Applied ${res.applied} migration(s) to ${file}`);
