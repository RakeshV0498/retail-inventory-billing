import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { createDb, type Db } from "@/db/client";
import { addBatch, createProduct, type ProductInput } from "@/services/inventory";
import { batches, stockMovements } from "@/db/schema";
import { sql } from "drizzle-orm";

/** Fixed "now": 21 Nov 2026, local noon. todayISO(NOW) === "2026-11-21". */
export const NOW = new Date(2026, 10, 21, 12, 0, 0);
export const TODAY = "2026-11-21";

export function makeDb(): Db {
  const db = createDb(new Database(":memory:"));
  migrate(db, { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  return db;
}

let n = 0;
export function newProduct(db: Db, over: Partial<ProductInput> = {}) {
  n += 1;
  return createProduct(db, {
    name: `Product ${n}`,
    sku: `SKU-${n}`,
    category: "grocery",
    unitType: "pcs",
    allowDecimalQty: false,
    gstRate: 0,
    lowStockThreshold: 0,
    ...over,
  });
}

/** Add a batch; qty in natural units (e.g. 1.5), prices in paise. */
export function stock(
  db: Db,
  productId: number,
  opts: { batch: string; expiry?: string | null; qtyMilli: number; sell?: number; cost?: number },
) {
  const sell = opts.sell ?? 10000;
  return addBatch(
    db,
    {
      productId,
      batchNumber: opts.batch,
      expiryDate: opts.expiry === undefined ? "2027-12-31" : opts.expiry,
      purchasePrice: opts.cost ?? Math.round(sell * 0.7),
      mrp: sell,
      sellingPrice: sell,
      quantity: opts.qtyMilli,
    },
    NOW,
  );
}

/** Insert an already-expired batch directly (addBatch refuses expired stock by design). */
export function stockExpired(db: Db, productId: number, batch: string, expiry: string, qtyMilli: number, sell = 10000) {
  const b = db
    .insert(batches)
    .values({
      productId,
      batchNumber: batch,
      expiryDate: expiry,
      purchasePrice: 5000,
      mrp: sell,
      sellingPrice: sell,
      quantityAvailable: qtyMilli,
    })
    .returning()
    .get();
  db.insert(stockMovements)
    .values({ productId, batchId: b.id, type: "purchase_in", quantityDelta: qtyMilli })
    .run();
  return b;
}

export function batchQty(db: Db, batchId: number): number {
  return db.select().from(batches).where(sql`${batches.id} = ${batchId}`).get()!.quantityAvailable;
}
