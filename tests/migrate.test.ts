import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/db/migrate";

const FOLDER = path.join(__dirname, "..", "drizzle");
const sqlFiles = fs.readdirSync(FOLDER).filter((f) => f.endsWith(".sql")).sort();
const tables = (d: Database.Database) =>
  (d.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name);
const cols = (d: Database.Database, t: string) => (d.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

/** What `drizzle-kit push` (used by older versions of the app) leaves behind: schema 0000, no history table. */
function legacyDb() {
  const d = new Database(":memory:");
  for (const stmt of fs.readFileSync(path.join(FOLDER, sqlFiles[0]!), "utf8").split("--> statement-breakpoint")) d.exec(stmt);
  d.exec("insert into products (name, sku, category, unit_type, gst_rate) values ('Rice','R1','grocery','kg',0)");
  d.exec("insert into batches (product_id, batch_number, purchase_price, mrp, selling_price, quantity_available) values (1,'B1',100,200,150,5000)");
  d.exec("insert into invoices (invoice_number, subtotal, discount_total, tax_total, round_off, grand_total, payment_mode, cash_amount) values ('INV-OLD',10000,0,500,0,10000,'cash',10000)");
  return d;
}

describe("runMigrations", () => {
  it("builds a brand-new database from scratch and is a no-op the second time", () => {
    const d = new Database(":memory:");
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: sqlFiles.length, legacyPinConverted: false });
    expect(tables(d)).toEqual(expect.arrayContaining(["products", "batches", "invoices", "customers", "payments"]));
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: 0, legacyPinConverted: false });
  });

  it("upgrades a legacy (push-created) database that already holds data, without losing any of it", () => {
    const d = legacyDb();
    expect(tables(d)).not.toContain("customers");
    const res = runMigrations(d, FOLDER);
    expect(res).toEqual({ baselined: true, applied: sqlFiles.length - 1, legacyPinConverted: false });
    expect(tables(d)).toEqual(expect.arrayContaining(["customers", "payments", "__drizzle_migrations"]));
    expect(cols(d, "invoices")).toEqual(expect.arrayContaining(["credit_amount", "customer_id"]));
    expect(d.prepare("select count(*) n from products").get()).toEqual({ n: 1 });
    expect(d.prepare("select quantity_available q from batches").get()).toEqual({ q: 5000 });
    expect(d.prepare("select invoice_number, grand_total, credit_amount, customer_id from invoices").get()).toEqual({
      invoice_number: "INV-OLD", grand_total: 10000, credit_amount: 0, customer_id: null,
    });
    expect(d.prepare("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(d.prepare("pragma foreign_key_check").all()).toEqual([]);
  });

  it("running again after a legacy upgrade does nothing", () => {
    const d = legacyDb();
    runMigrations(d, FOLDER);
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: 0, legacyPinConverted: false });
  });

  it("leaves an already-tracked database alone", () => {
    const d = new Database(":memory:");
    runMigrations(d, FOLDER);
    d.exec("insert into products (name, sku, category, unit_type, gst_rate) values ('X','X1','grocery','pcs',0)");
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: 0, legacyPinConverted: false });
    expect(d.prepare("select count(*) n from products").get()).toEqual({ n: 1 });
  });
});

describe("legacy shared PIN -> admin account", () => {
  const legacyWithPin = () => {
    const d = legacyDb(); // schema 0000 with data, no history table
    d.exec("insert into settings (key, value) values ('pinHash', 'scrypt$aa$bb'), ('sessionSecret', 'keepme'), ('storeName', 'My Shop')");
    return d;
  };

  it("keeps the same PIN hash as the admin user and removes the old setting", () => {
    const d = legacyWithPin();
    expect(runMigrations(d, FOLDER).legacyPinConverted).toBe(true);
    expect(d.prepare("select username, display_name, pin_hash, role, is_active, session_version from users").all()).toEqual([
      { username: "admin", display_name: "Admin", pin_hash: "scrypt$aa$bb", role: "admin", is_active: 1, session_version: 0 },
    ]);
    expect(d.prepare("select key from settings order by key").all()).toEqual([{ key: "sessionSecret" }, { key: "storeName" }]);
    expect(d.prepare("select count(*) n from products").get()).toEqual({ n: 1 }); // data untouched
  });

  it("does nothing on the next run, and nothing at all when no PIN was set", () => {
    const d = legacyWithPin();
    runMigrations(d, FOLDER);
    expect(runMigrations(d, FOLDER).legacyPinConverted).toBe(false);
    expect(d.prepare("select count(*) n from users").get()).toEqual({ n: 1 });
    const none = legacyDb();
    expect(runMigrations(none, FOLDER).legacyPinConverted).toBe(false);
    expect(none.prepare("select count(*) n from users").get()).toEqual({ n: 0 });
  });

  it("never overwrites existing accounts", () => {
    const d = new Database(":memory:");
    runMigrations(d, FOLDER);
    d.exec("insert into users (username, display_name, pin_hash, role) values ('owner','Owner','h1','admin')");
    d.exec("insert into settings (key, value) values ('pinHash', 'stale')");
    expect(runMigrations(d, FOLDER).legacyPinConverted).toBe(false);
    expect(d.prepare("select username from users").all()).toEqual([{ username: "owner" }]);
  });
});

describe("upgrading from the previous release (migrations 0000-0001 applied, real rows present)", () => {
  /** A copy of the migrations folder trimmed to the first `n` migrations, to recreate an older release's database. */
  function folderUpTo(n: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(FOLDER, "meta", "_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, n);
    fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries as { tag: string }[]) fs.copyFileSync(path.join(FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    return dir;
  }

  function previousRelease() {
    const d = new Database(":memory:");
    runMigrations(d, folderUpTo(2)); // exactly what a Pi on the last release has
    d.exec("insert into products (name, sku, category, unit_type, gst_rate) values ('Rice','R1','grocery','kg',0)");
    d.exec("insert into batches (product_id, batch_number, purchase_price, mrp, selling_price, quantity_available) values (1,'B1',100,200,150,5000)");
    d.exec("insert into customers (name, phone) values ('Lakshmi','9876543210')");
    d.exec("insert into invoices (invoice_number, subtotal, discount_total, tax_total, round_off, grand_total, payment_mode, credit_amount, customer_id) values ('INV-1',5000,0,0,0,5000,'credit',5000,1)");
    d.exec("insert into payments (customer_id, amount, mode) values (1, 2000, 'cash')");
    d.exec("insert into settings (key, value) values ('pinHash','scrypt$aa$bb'), ('sessionSecret','keep')");
    return d;
  }

  it("applies the account and sales-control migrations on top, keeping every row and giving old rows safe defaults", () => {
    const d = previousRelease();
    expect(tables(d)).not.toContain("users");
    const res = runMigrations(d, FOLDER);
    expect(res).toEqual({ baselined: false, applied: sqlFiles.length - 2, legacyPinConverted: true });

    expect(tables(d)).toEqual(expect.arrayContaining(["users", "audit_log"]));
    expect(cols(d, "invoices")).toEqual(expect.arrayContaining(["created_by", "created_by_name", "notes", "void_reason", "voided_at", "voided_by", "voided_by_name", "replaces_invoice_id"]));
    expect(cols(d, "payments")).toEqual(expect.arrayContaining(["created_by", "status", "void_reason", "voided_at", "voided_by_name"]));

    expect(d.prepare("select invoice_number, status, credit_amount, customer_id, created_by, created_by_name, void_reason, replaces_invoice_id, notes from invoices").get()).toEqual({
      invoice_number: "INV-1", status: "paid", credit_amount: 5000, customer_id: 1, created_by: null, created_by_name: null, void_reason: null, replaces_invoice_id: null, notes: null,
    });
    expect(d.prepare("select amount, mode, status, void_reason from payments").get()).toEqual({ amount: 2000, mode: "cash", status: "active", void_reason: null });
    expect(d.prepare("select quantity_available q from batches").get()).toEqual({ q: 5000 });
    expect(d.prepare("select username, role from users").all()).toEqual([{ username: "admin", role: "admin" }]);
    expect(d.prepare("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(d.prepare("pragma foreign_key_check").all()).toEqual([]);
  });

  it("is a no-op when run again", () => {
    const d = previousRelease();
    runMigrations(d, FOLDER);
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: 0, legacyPinConverted: false });
  });
});
