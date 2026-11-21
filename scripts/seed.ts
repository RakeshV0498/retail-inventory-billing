import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createDb } from "../src/db/client";
import { seedDatabase } from "../src/db/seed";

const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
fs.mkdirSync(path.dirname(file), { recursive: true });
const sqlite = new Database(file);

if (!sqlite.prepare("select 1 from sqlite_master where name = 'products'").get()) {
  console.error("Tables not found. Run `npm run db:push` first.");
  process.exit(1);
}

const reset = process.argv.includes("--reset");
const result = seedDatabase(createDb(sqlite), { reset });
if ("skipped" in result) {
  console.log("Database already has products; nothing seeded. Use `npm run db:seed -- --reset` to start over.");
} else {
  if (reset) console.log("Existing data wiped.");
  console.log(`Seeded ${result.seeded} products into ${file}`);
}
