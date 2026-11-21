import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  batches,
  CATEGORIES,
  pricingRules,
  products,
  stockMovements,
  UNIT_TYPES,
  type Batch,
  type Product,
} from "@/db/schema";
import { addDaysISO, daysBetween, isExpired, todayISO } from "@/lib/dates";
import { sortFefo } from "@/lib/fefo";
import { MILLI } from "@/lib/qty";
import { ServiceError, type Q } from "./types";

/* ---------- validation ---------- */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const productInput = z.object({
  name: z.string().trim().min(1),
  sku: z.string().trim().min(1),
  barcode: z.string().trim().min(1).nullish(),
  category: z.enum(CATEGORIES),
  unitType: z.enum(UNIT_TYPES),
  allowDecimalQty: z.boolean().default(false),
  /** milli-units */
  lowStockThreshold: z.number().int().min(0).default(0),
  gstRate: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18)]),
  hsnCode: z.string().trim().min(1).nullish(),
});
export type ProductInput = z.input<typeof productInput>;

export const batchInput = z
  .object({
    productId: z.number().int().positive(),
    batchNumber: z.string().trim().min(1),
    mfgDate: isoDate.nullish(),
    expiryDate: isoDate.nullish(),
    /** paise */
    purchasePrice: z.number().int().min(0),
    mrp: z.number().int().min(0),
    sellingPrice: z.number().int().min(0),
    /** milli-units */
    quantity: z.number().int().positive(),
  })
  .refine((b) => b.sellingPrice <= b.mrp, { message: "Selling price cannot exceed MRP", path: ["sellingPrice"] })
  .refine((b) => !b.mfgDate || !b.expiryDate || b.mfgDate <= b.expiryDate, {
    message: "Expiry must be after manufacturing date",
    path: ["expiryDate"],
  });
export type BatchInput = z.input<typeof batchInput>;

/* ---------- writes ---------- */

export function createProduct(db: Db, raw: ProductInput): Product {
  const input = productInput.parse(raw);
  if (!input.allowDecimalQty && input.lowStockThreshold % MILLI !== 0) {
    throw new ServiceError("INVALID", "Low-stock threshold must be a whole number for this product");
  }
  try {
    return db
      .insert(products)
      .values({ ...input, barcode: input.barcode ?? null, hsnCode: input.hsnCode ?? null })
      .returning()
      .get();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw new ServiceError("DUPLICATE", "A product with this SKU or barcode already exists");
    }
    throw e;
  }
}

/** Add a stock batch (or top up an existing batch number) and write a `purchase_in` movement. */
export function addBatch(db: Db, raw: BatchInput, now: Date = new Date()): Batch {
  const input = batchInput.parse(raw);
  return db.transaction((tx) => {
    const product = tx.select().from(products).where(eq(products.id, input.productId)).get();
    if (!product) throw new ServiceError("NOT_FOUND", "Product not found");
    if (!product.allowDecimalQty && input.quantity % MILLI !== 0) {
      throw new ServiceError("INVALID_QTY", "This product only supports whole quantities");
    }
    const today = todayISO(now);
    if (isExpired(input.expiryDate ?? null, today)) {
      throw new ServiceError("EXPIRED", "Cannot receive stock that is already expired");
    }

    const existing = tx
      .select()
      .from(batches)
      .where(and(eq(batches.productId, input.productId), eq(batches.batchNumber, input.batchNumber)))
      .get();

    let batch: Batch;
    if (existing) {
      if (existing.expiryDate !== (input.expiryDate ?? null)) {
        throw new ServiceError("BATCH_MISMATCH", "Batch number exists with a different expiry date");
      }
      batch = tx
        .update(batches)
        .set({
          quantityAvailable: existing.quantityAvailable + input.quantity,
          purchasePrice: input.purchasePrice,
          mrp: input.mrp,
          sellingPrice: input.sellingPrice,
        })
        .where(eq(batches.id, existing.id))
        .returning()
        .get();
    } else {
      batch = tx
        .insert(batches)
        .values({
          productId: input.productId,
          batchNumber: input.batchNumber,
          mfgDate: input.mfgDate ?? null,
          expiryDate: input.expiryDate ?? null,
          purchasePrice: input.purchasePrice,
          mrp: input.mrp,
          sellingPrice: input.sellingPrice,
          quantityAvailable: input.quantity,
          createdAt: now.toISOString(),
        })
        .returning()
        .get();
    }

    tx.insert(stockMovements)
      .values({
        productId: input.productId,
        batchId: batch.id,
        type: "purchase_in",
        quantityDelta: input.quantity,
        note: `Batch ${input.batchNumber}`,
        createdAt: now.toISOString(),
      })
      .run();
    return batch;
  });
}

/** Write off remaining (or a given) quantity of a batch as expired wastage. */
export function writeOffBatch(
  db: Db,
  batchId: number,
  quantity?: number,
  note = "Expired wastage",
  now: Date = new Date(),
): number {
  return db.transaction((tx) => {
    const batch = tx.select().from(batches).where(eq(batches.id, batchId)).get();
    if (!batch) throw new ServiceError("NOT_FOUND", "Batch not found");
    const qty = quantity ?? batch.quantityAvailable;
    if (!Number.isInteger(qty) || qty <= 0 || qty > batch.quantityAvailable) {
      throw new ServiceError("INVALID_QTY", "Invalid write-off quantity");
    }
    tx.update(batches)
      .set({ quantityAvailable: batch.quantityAvailable - qty })
      .where(eq(batches.id, batchId))
      .run();
    tx.insert(stockMovements)
      .values({
        productId: batch.productId,
        batchId,
        type: "expired_wastage",
        quantityDelta: -qty,
        note,
        createdAt: now.toISOString(),
      })
      .run();
    return qty;
  });
}

/* ---------- reads ---------- */

export interface ProductStock extends Product {
  /** Sellable (non-expired) stock, milli-units */
  sellableQty: number;
  /** All stock including expired, milli-units */
  totalQty: number;
  expiredQty: number;
  /** Earliest-expiry sellable batch, i.e. what FEFO would sell next */
  nextBatch: Batch | null;
}

export function withStock(db: Q, rows: Product[], today: string): ProductStock[] {
  if (rows.length === 0) return [];
  const all = db.select().from(batches).where(gt(batches.quantityAvailable, 0)).all();
  const byProduct = new Map<number, Batch[]>();
  for (const b of all) {
    const list = byProduct.get(b.productId) ?? [];
    list.push(b);
    byProduct.set(b.productId, list);
  }
  return rows.map((p) => {
    const bs = byProduct.get(p.id) ?? [];
    const sellable = sortFefo(bs.filter((b) => !isExpired(b.expiryDate, today)));
    const sellableQty = sellable.reduce((s, b) => s + b.quantityAvailable, 0);
    const totalQty = bs.reduce((s, b) => s + b.quantityAvailable, 0);
    return { ...p, sellableQty, totalQty, expiredQty: totalQty - sellableQty, nextBatch: sellable[0] ?? null };
  });
}

export function listProducts(db: Q, today: string = todayISO()): ProductStock[] {
  const rows = db.select().from(products).where(eq(products.isActive, true)).orderBy(asc(products.name)).all();
  return withStock(db, rows, today);
}

export function getProduct(db: Q, id: number): Product | undefined {
  return db.select().from(products).where(eq(products.id, id)).get();
}

export function getProductBatches(db: Q, productId: number): Batch[] {
  return sortFefo(db.select().from(batches).where(eq(batches.productId, productId)).all());
}

/** Instant search by name / SKU / barcode (prefix-and-contains, case-insensitive). */
export function searchProducts(db: Q, query: string, today: string = todayISO(), limit = 20): ProductStock[] {
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .select()
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        or(
          sql`${products.name} like ${pattern} escape '\\'`,
          sql`${products.sku} like ${pattern} escape '\\'`,
          eq(products.barcode, q),
        ),
      ),
    )
    .orderBy(asc(products.name))
    .limit(limit)
    .all();
  return withStock(db, rows, today);
}

export function findByBarcode(db: Q, barcode: string, today: string = todayISO()): ProductStock | null {
  const row = db
    .select()
    .from(products)
    .where(and(eq(products.barcode, barcode.trim()), eq(products.isActive, true)))
    .get();
  return row ? (withStock(db, [row], today)[0] ?? null) : null;
}

export function getLowStock(db: Q, today: string = todayISO()): ProductStock[] {
  return listProducts(db, today).filter((p) => p.sellableQty <= p.lowStockThreshold);
}

export interface ExpiryAlert {
  batch: Batch;
  product: Product;
  daysLeft: number;
}

/** Batches with stock expiring within `withinDays` (and not yet expired), soonest first. */
export function getExpiringBatches(db: Q, today: string, withinDays: number): ExpiryAlert[] {
  const limit = addDaysISO(today, withinDays);
  const rows = db
    .select({ batch: batches, product: products })
    .from(batches)
    .innerJoin(products, eq(products.id, batches.productId))
    .where(
      and(
        gt(batches.quantityAvailable, 0),
        sql`${batches.expiryDate} is not null`,
        gt(batches.expiryDate, addDaysISO(today, -1)),
        sql`${batches.expiryDate} <= ${limit}`,
      ),
    )
    .orderBy(asc(batches.expiryDate))
    .all();
  return rows.map((r) => ({ ...r, daysLeft: daysBetween(today, r.batch.expiryDate as string) }));
}

/** Batches that already expired but still hold stock (candidates for write-off). */
export function getExpiredBatches(db: Q, today: string): ExpiryAlert[] {
  const rows = db
    .select({ batch: batches, product: products })
    .from(batches)
    .innerJoin(products, eq(products.id, batches.productId))
    .where(and(gt(batches.quantityAvailable, 0), lt(batches.expiryDate, today)))
    .orderBy(asc(batches.expiryDate))
    .all();
  return rows.map((r) => ({ ...r, daysLeft: daysBetween(today, r.batch.expiryDate as string) }));
}

/* ---------- dynamic pricing: near-expiry markdown ---------- */

/** Suggested discount (hundredths of a percent) for a batch based on active pricing rules. 0 if none. */
export function suggestedMarkdown(db: Q, category: Product["category"], expiryDate: string | null, today: string): number {
  if (!expiryDate) return 0;
  const days = daysBetween(today, expiryDate);
  if (days < 0) return 0;
  const rules = db.select().from(pricingRules).where(eq(pricingRules.isActive, true)).all();
  let best = 0;
  for (const r of rules) {
    if (r.category && r.category !== category) continue;
    if (days >= r.minDaysToExpiry && days <= r.maxDaysToExpiry) best = Math.max(best, r.discountPercent);
  }
  return best;
}
