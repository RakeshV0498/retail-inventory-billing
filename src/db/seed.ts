import type { Db } from "./client";
import { SEED_PRICING_RULES, SEED_PRODUCTS } from "./seed-data";
import { batches, invoiceItems, invoices, pricingRules, products, settings, stockMovements } from "./schema";
import { addDaysISO, todayISO } from "../lib/dates";
import { rupeesToPaise } from "../lib/money";
import { toMilli } from "../lib/qty";
import { saveSettings } from "../services/settings";

export type SeedResult = { seeded: number } | { skipped: true };

/**
 * Load the sample grocery + pharmacy data. Dates are relative to today so there are always
 * near-expiry and already-expired batches to play with. Skips when products exist unless `reset`.
 */
export function seedDatabase(db: Db, opts: { reset?: boolean } = {}): SeedResult {
  if (opts.reset) {
    db.transaction((tx) => {
      for (const t of [stockMovements, invoiceItems, invoices, batches, pricingRules, products, settings]) tx.delete(t).run();
    });
  } else if (db.select().from(products).limit(1).all().length > 0) {
    return { skipped: true };
  }

  const today = todayISO();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    for (const sp of SEED_PRODUCTS) {
      const { lowStock, ...p } = sp.product;
      const product = tx
        .insert(products)
        .values({
          ...p,
          barcode: p.barcode ?? null,
          hsnCode: p.hsnCode ?? null,
          allowDecimalQty: p.allowDecimalQty ?? false,
          lowStockThreshold: toMilli(lowStock),
        })
        .returning()
        .get();

      for (const b of sp.batches) {
        // Inserted directly (not via addBatch) so the sample data can include an already-expired batch.
        const batch = tx
          .insert(batches)
          .values({
            productId: product.id,
            batchNumber: b.batchNumber,
            mfgDate: b.mfgDaysAgo ? addDaysISO(today, -b.mfgDaysAgo) : null,
            expiryDate: b.expiryInDays === null ? null : addDaysISO(today, b.expiryInDays),
            purchasePrice: rupeesToPaise(b.purchase),
            mrp: rupeesToPaise(b.mrp),
            sellingPrice: rupeesToPaise(b.selling),
            quantityAvailable: toMilli(b.qty),
            createdAt: now,
          })
          .returning()
          .get();
        tx.insert(stockMovements)
          .values({
            productId: product.id,
            batchId: batch.id,
            type: "purchase_in",
            quantityDelta: batch.quantityAvailable,
            note: "Opening stock (seed)",
            createdAt: now,
          })
          .run();
      }
    }
    for (const r of SEED_PRICING_RULES) tx.insert(pricingRules).values(r).run();
  });

  saveSettings(db, { storeName: "Sri Murugan Stores & Medicals", storeAddress: "12, Main Bazaar, Coimbatore", gstin: "33ABCDE1234F1Z5" });
  return { seeded: SEED_PRODUCTS.length };
}
