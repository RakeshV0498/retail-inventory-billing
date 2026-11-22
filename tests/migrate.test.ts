import Database from "better-sqlite3";
import fs from "node:fs";
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
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: sqlFiles.length });
    expect(tables(d)).toEqual(expect.arrayContaining(["products", "batches", "invoices", "customers", "payments"]));
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: 0 });
  });

  it("upgrades a legacy (push-created) database that already holds data, without losing any of it", () => {
    const d = legacyDb();
    expect(tables(d)).not.toContain("customers");
    const res = runMigrations(d, FOLDER);
    expect(res).toEqual({ baselined: true, applied: sqlFiles.length - 1 });
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
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: 0 });
  });

  it("leaves an already-tracked database alone", () => {
    const d = new Database(":memory:");
    runMigrations(d, FOLDER);
    d.exec("insert into products (name, sku, category, unit_type, gst_rate) values ('X','X1','grocery','pcs',0)");
    expect(runMigrations(d, FOLDER)).toEqual({ baselined: false, applied: 0 });
    expect(d.prepare("select count(*) n from products").get()).toEqual({ n: 1 });
  });
});
