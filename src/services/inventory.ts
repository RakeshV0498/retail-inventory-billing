import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  batches,
  CATEGORIES,
  invoiceItems,
  pricingRules,
  products,
  stockMovements,
  UNIT_TYPES,
  type Batch,
  type PricingRule,
  type Product,
} from "@/db/schema";
import { addDaysISO, daysBetween, isExpired, todayISO } from "@/lib/dates";
import { sortFefo } from "@/lib/fefo";
import { divRound } from "@/lib/money";
import { formatQty, MILLI } from "@/lib/qty";
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
      throw new ServiceError("DUPLICATE", "A product with this SKU or barcode already exists (it may be archived)");
    }
    throw e;
  }
}

const COUNTABLE_UNITS = new Set<string>(["pcs", "strip", "bottle"]);

/**
 * Edit a product. Safety rules keep stored quantities meaningful:
 *  - unit can change freely among pcs/strip/bottle; any other change only while the product has no history;
 *  - "sold loose" can be turned off only if no batch holds a fractional quantity.
 * GST/price edits affect future sales only (invoice items snapshot their values).
 */
export function updateProduct(db: Db, id: number, raw: ProductInput): Product {
  const input = productInput.parse(raw);
  return db.transaction((tx) => {
    const cur = tx.select().from(products).where(eq(products.id, id)).get();
    if (!cur) throw new ServiceError("NOT_FOUND", "Product not found");
    if (!input.allowDecimalQty && input.lowStockThreshold % MILLI !== 0) {
      throw new ServiceError("INVALID", "Low-stock threshold must be a whole number for this product");
    }
    if (input.unitType !== cur.unitType) {
      const sameFamily = COUNTABLE_UNITS.has(input.unitType) && COUNTABLE_UNITS.has(cur.unitType);
      if (!sameFamily && productHasHistory(tx, id)) {
        throw new ServiceError("UNIT_LOCKED", `The unit can't change from ${cur.unitType} to ${input.unitType} because this product already has stock history. Archive it and add a new product instead`);
      }
    }
    if (cur.allowDecimalQty && !input.allowDecimalQty) {
      const fractional = tx
        .select({ id: batches.id })
        .from(batches)
        .where(and(eq(batches.productId, id), sql`${batches.quantityAvailable} % ${MILLI} != 0`))
        .get();
      if (fractional) throw new ServiceError("DECIMAL_LOCKED", "Some stock is held in fractions (e.g. 0.5), so \"sold loose\" can't be turned off");
    }
    try {
      return tx
        .update(products)
        .set({ ...input, barcode: input.barcode ?? null, hsnCode: input.hsnCode ?? null })
        .where(eq(products.id, id))
        .returning()
        .get();
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        throw new ServiceError("DUPLICATE", "Another product already has this SKU or barcode (it may be archived)");
      }
      throw e;
    }
  });
}

export const batchEditInput = z
  .object({
    batchNumber: z.string().trim().min(1).max(60),
    mfgDate: isoDate.nullish(),
    expiryDate: isoDate.nullish(),
    /** paise */
    purchasePrice: z.number().int().min(0),
    mrp: z.number().int().min(0),
    sellingPrice: z.number().int().min(0),
  })
  .refine((b) => b.sellingPrice <= b.mrp, { message: "Selling price cannot exceed MRP", path: ["sellingPrice"] })
  .refine((b) => !b.mfgDate || !b.expiryDate || b.mfgDate <= b.expiryDate, {
    message: "Expiry must be after manufacturing date",
    path: ["expiryDate"],
  });
export type BatchEditInput = z.input<typeof batchEditInput>;

/** Correct a batch's number, dates or prices (not its quantity: use adjustStock). Prices affect future sales only. */
export function updateBatch(db: Db, batchId: number, raw: BatchEditInput): Batch {
  const input = batchEditInput.parse(raw);
  try {
    const row = db
      .update(batches)
      .set({
        batchNumber: input.batchNumber,
        mfgDate: input.mfgDate ?? null,
        expiryDate: input.expiryDate ?? null,
        purchasePrice: input.purchasePrice,
        mrp: input.mrp,
        sellingPrice: input.sellingPrice,
      })
      .where(eq(batches.id, batchId))
      .returning()
      .get();
    if (!row) throw new ServiceError("NOT_FOUND", "Batch not found");
    return row;
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw new ServiceError("DUPLICATE", "Another batch of this product already has that batch number");
    }
    throw e;
  }
}

/**
 * Set a batch's quantity to a counted value (typo in stock-in, damaged goods, sample...). Writes a signed
 * `adjustment` movement in the same transaction so quantity always equals the ledger sum. Returns the delta (milli).
 */
export function adjustStock(db: Db, batchId: number, newQuantity: number, reason: string, now: Date = new Date()): number {
  const why = reason.trim();
  if (!why) throw new ServiceError("REASON_REQUIRED", "Please give a reason for the correction");
  if (why.length > 200) throw new ServiceError("INVALID", "Reason is too long (200 characters max)");
  return db.transaction((tx) => {
    const batch = tx.select().from(batches).where(eq(batches.id, batchId)).get();
    if (!batch) throw new ServiceError("NOT_FOUND", "Batch not found");
    const product = tx.select().from(products).where(eq(products.id, batch.productId)).get();
    if (!Number.isInteger(newQuantity) || newQuantity < 0) throw new ServiceError("INVALID_QTY", "Quantity can't be negative");
    if (product && !product.allowDecimalQty && newQuantity % MILLI !== 0) {
      throw new ServiceError("INVALID_QTY", "This product only supports whole quantities");
    }
    const delta = newQuantity - batch.quantityAvailable;
    if (delta === 0) return 0;
    tx.update(batches).set({ quantityAvailable: newQuantity }).where(eq(batches.id, batchId)).run();
    tx.insert(stockMovements)
      .values({
        productId: batch.productId,
        batchId,
        type: "adjustment",
        quantityDelta: delta,
        note: why,
        createdAt: now.toISOString(),
      })
      .run();
    return delta;
  });
}

/** Add a stock batch (or top up an existing batch number) and write a `purchase_in` movement. */
export function addBatch(db: Db, raw: BatchInput, now: Date = new Date()): Batch {
  const input = batchInput.parse(raw);
  return db.transaction((tx) => {
    const product = tx.select().from(products).where(eq(products.id, input.productId)).get();
    if (!product) throw new ServiceError("NOT_FOUND", "Product not found");
    if (!product.isActive) throw new ServiceError("ARCHIVED", "This product is archived. Restore it before adding stock");
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

/** Shared write-off body: always run inside a transaction so batch + ledger stay in step. */
function writeOffInTx(tx: Q, batchId: number, quantity: number | undefined, note: string, now: Date): number {
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
}

/** Write off remaining (or a given) quantity of a batch as expired wastage. */
export function writeOffBatch(
  db: Db,
  batchId: number,
  quantity?: number,
  note = "Expired wastage",
  now: Date = new Date(),
): number {
  return db.transaction((tx) => writeOffInTx(tx, batchId, quantity, note, now));
}

/** Purchase-price value (paise) of the stock in these batches, i.e. what is lost if written off. */
export function expiredCostLost(rows: { batch: Batch }[]): number {
  return rows.reduce((s, r) => s + divRound(r.batch.purchasePrice * r.batch.quantityAvailable, MILLI), 0);
}

export interface WriteOffSummary {
  batches: number;
  products: number;
  /** paise */
  costLost: number;
}

/** Write off EVERY expired batch that still holds stock, in one transaction. A second run is a no-op. */
export function writeOffExpired(db: Db, today: string, now: Date = new Date()): WriteOffSummary {
  return db.transaction((tx) => {
    const rows = getExpiredBatches(tx, today);
    for (const r of rows) writeOffInTx(tx, r.batch.id, undefined, "Expired wastage (bulk)", now);
    return { batches: rows.length, products: new Set(rows.map((r) => r.product.id)).size, costLost: expiredCostLost(rows) };
  });
}

/* ---------- archive / restore / delete ---------- */

/**
 * Archive a product (hides it from POS, search and lists; history and old invoices are untouched).
 * Refused while sellable stock remains. Leftover EXPIRED stock is written off in the same transaction.
 */
export function archiveProduct(db: Db, id: number, now: Date = new Date()): { writtenOff: number } {
  return db.transaction((tx) => {
    const p = tx.select().from(products).where(eq(products.id, id)).get();
    if (!p) throw new ServiceError("NOT_FOUND", "Product not found");
    if (!p.isActive) return { writtenOff: 0 };
    const today = todayISO(now);
    const stocked = tx
      .select()
      .from(batches)
      .where(and(eq(batches.productId, id), gt(batches.quantityAvailable, 0)))
      .all();
    const sellable = stocked.filter((b) => !isExpired(b.expiryDate, today));
    if (sellable.length > 0) {
      const qty = sellable.reduce((s, b) => s + b.quantityAvailable, 0);
      throw new ServiceError("HAS_STOCK", `${p.name} still has ${formatQty(qty)} ${p.unitType} in stock. Sell it first, then archive`);
    }
    let writtenOff = 0;
    for (const b of stocked) writtenOff += writeOffInTx(tx, b.id, undefined, "Written off on archive", now);
    tx.update(products).set({ isActive: false }).where(eq(products.id, id)).run();
    return { writtenOff };
  });
}

export function restoreProduct(db: Db, id: number): void {
  const res = db.update(products).set({ isActive: true }).where(eq(products.id, id)).run();
  if (res.changes !== 1) throw new ServiceError("NOT_FOUND", "Product not found");
}

/** True if the product ever had a batch, a stock movement or an invoice line. */
export function productHasHistory(db: Q, id: number): boolean {
  const count = (t: typeof batches | typeof stockMovements | typeof invoiceItems) =>
    db.select({ n: sql<number>`count(*)` }).from(t).where(eq(t.productId, id)).get()?.n ?? 0;
  return count(batches) + count(stockMovements) + count(invoiceItems) > 0;
}

/** Permanent delete: only for products with NO history (e.g. added by mistake). Otherwise archive. */
export function deleteProduct(db: Db, id: number): void {
  db.transaction((tx) => {
    if (!tx.select().from(products).where(eq(products.id, id)).get()) throw new ServiceError("NOT_FOUND", "Product not found");
    if (productHasHistory(tx, id)) {
      throw new ServiceError("HAS_HISTORY", "This product has stock or sales history, so it can't be deleted. Archive it instead");
    }
    tx.delete(products).where(eq(products.id, id)).run();
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
  /** Sellable batches in FEFO order (lets the POS preview allocation with the same pure functions). */
  sellableBatches: (Batch & { markdownPercent: number })[];
  /** Near-expiry markdown suggested for `nextBatch`, hundredths of a percent (0 = none). */
  suggestedDiscount: number;
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
  const rules = db.select().from(pricingRules).where(eq(pricingRules.isActive, true)).all();
  return rows.map((p) => {
    const bs = byProduct.get(p.id) ?? [];
    const sellable = sortFefo(bs.filter((b) => !isExpired(b.expiryDate, today)));
    const sellableQty = sellable.reduce((s, b) => s + b.quantityAvailable, 0);
    const totalQty = bs.reduce((s, b) => s + b.quantityAvailable, 0);
    const next = sellable[0] ?? null;
    return {
      ...p,
      sellableQty,
      totalQty,
      expiredQty: totalQty - sellableQty,
      nextBatch: next,
      sellableBatches: sellable.map((b) => ({
        ...b,
        markdownPercent: markdownFromRules(rules, p.category, b.expiryDate, today),
      })),
      suggestedDiscount: next ? markdownFromRules(rules, p.category, next.expiryDate, today) : 0,
    };
  });
}

export function listProducts(db: Q, today: string = todayISO()): ProductStock[] {
  const rows = db.select().from(products).where(eq(products.isActive, true)).orderBy(asc(products.name)).all();
  return withStock(db, rows, today);
}

export function getProduct(db: Q, id: number): Product | undefined {
  return db.select().from(products).where(eq(products.id, id)).get();
}

export function listArchivedProducts(db: Q): Product[] {
  return db.select().from(products).where(eq(products.isActive, false)).orderBy(asc(products.name)).all();
}

/** Batches in FEFO order. Emptied / written-off batches (qty 0) are hidden unless `includeEmpty`. */
export function getProductBatches(db: Q, productId: number, opts: { includeEmpty?: boolean } = {}): Batch[] {
  const rows = db.select().from(batches).where(eq(batches.productId, productId)).all();
  return sortFefo(opts.includeEmpty ? rows : rows.filter((b) => b.quantityAvailable > 0));
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
  const rules = db.select().from(pricingRules).where(eq(pricingRules.isActive, true)).all();
  return markdownFromRules(rules, category, expiryDate, today);
}

export function markdownFromRules(
  rules: PricingRule[],
  category: Product["category"],
  expiryDate: string | null,
  today: string,
): number {
  if (!expiryDate) return 0;
  const days = daysBetween(today, expiryDate);
  if (days < 0) return 0;
  let best = 0;
  for (const r of rules) {
    if (r.category && r.category !== category) continue;
    if (days >= r.minDaysToExpiry && days <= r.maxDaysToExpiry) best = Math.max(best, r.discountPercent);
  }
  return best;
}
