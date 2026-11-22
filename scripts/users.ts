import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createDb } from "../src/db/client";
import { normalizeUsername } from "../src/lib/auth";
import { createFirstAdmin, createUser, hasUsers, listUsers, setActive, setUserPin } from "../src/services/users";
import type { Actor } from "../src/services/audit";

/**
 * Account recovery from the command line (run on the machine that holds data/app.db). No login needed:
 * whoever can run commands here already controls the database.
 *
 *   npm run users -- list
 *   npm run users -- create-admin <username> <pin> [display name]
 *   npm run users -- reset-pin <username> <pin>
 *   npm run users -- activate <username>
 */
const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
if (!fs.existsSync(file)) {
  console.error(`No database at ${file}. Run \`npm run db:push\` first.`);
  process.exit(1);
}
const sqlite = new Database(file);
if (!sqlite.prepare("select 1 from sqlite_master where name = 'users'").get()) {
  console.error("This database has no accounts table yet. Run `npm run db:push` first.");
  process.exit(1);
}
const db = createDb(sqlite);
const cli: Actor = { id: null, name: "(command line)" };
const [cmd, a, b, ...rest] = process.argv.slice(2);

const find = (name: string | undefined) => {
  const u = listUsers(db).find((x) => x.username === normalizeUsername(name ?? ""));
  if (!u) {
    console.error(`No user called '${name}'. Known users: ${listUsers(db).map((x) => x.username).join(", ") || "(none)"}`);
    process.exit(1);
  }
  return u;
};

try {
  switch (cmd) {
    case "list":
      for (const u of listUsers(db)) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(6)} ${u.isActive ? "active" : "DEACTIVATED"}  ${u.displayName}`);
      if (!hasUsers(db)) console.log("(no accounts yet: the app is open to anyone until you create one)");
      break;
    case "create-admin": {
      if (!a || !b) throw new Error("Usage: npm run users -- create-admin <username> <pin> [display name]");
      const display = rest.length ? [rest.join(" ")][0]! : a;
      const first = !hasUsers(db);
      const u = first ? createFirstAdmin(db, { username: a, displayName: display, pin: b }) : createUser(db, { username: a, displayName: display, pin: b, role: "admin" }, cli);
      console.log(`Created admin '${u.username}'.`);
      break;
    }
    case "reset-pin": {
      if (!a || !b) throw new Error("Usage: npm run users -- reset-pin <username> <pin>");
      const u = find(a);
      setUserPin(db, u.id, b, cli);
      if (!u.isActive) console.log(`Note: '${u.username}' is deactivated. Run: npm run users -- activate ${u.username}`);
      console.log(`PIN reset for '${u.username}'. They are signed out everywhere.`);
      break;
    }
    case "activate": {
      const u = find(a);
      setActive(db, u.id, true, cli);
      console.log(`'${u.username}' is active.`);
      break;
    }
    default:
      console.log("Commands: list | create-admin <username> <pin> [display name] | reset-pin <username> <pin> | activate <username>");
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
