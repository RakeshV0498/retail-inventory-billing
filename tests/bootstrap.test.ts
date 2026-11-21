import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/db/client";
import { ensureDemoDb } from "@/db/bootstrap";
import { seedDatabase } from "@/db/seed";
import { batches, products } from "@/db/schema";
import { makeDb } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

const count = (db: ReturnType<typeof makeDb>, t: typeof products | typeof batches) => db.select().from(t).all().length;

describe("demo bootstrap", () => {
  it("is a no-op unless NETLIFY_DEMO=1", () => {
    const sqlite = new Database(":memory:");
    ensureDemoDb(createDb(sqlite));
    expect(sqlite.prepare("select 1 from sqlite_master where name='products'").get()).toBeUndefined();
  });

  it("creates the schema and seeds a brand-new database, idempotently", () => {
    vi.stubEnv("NETLIFY_DEMO", "1");
    const db = createDb(new Database(":memory:"));
    ensureDemoDb(db);
    const p = count(db, products);
    const b = count(db, batches);
    expect(p).toBeGreaterThan(5);
    ensureDemoDb(db);
    expect(count(db, products)).toBe(p);
    expect(count(db, batches)).toBe(b);
  });

  it("seed includes an expired batch and a near-expiry batch, and --reset re-seeds", () => {
    const db = makeDb();
    expect(seedDatabase(db)).toEqual({ seeded: expect.any(Number) });
    expect(seedDatabase(db)).toEqual({ skipped: true });
    const rows = db.select().from(batches).all();
    const today = new Date().toISOString().slice(0, 10);
    expect(rows.some((r) => r.expiryDate !== null && r.expiryDate < today)).toBe(true);
    const n = rows.length;
    seedDatabase(db, { reset: true });
    expect(count(db, batches)).toBe(n);
  });
});
