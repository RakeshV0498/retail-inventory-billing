import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createDb } from "../src/db/client";
import { SEED_PRICING_RULES, SEED_PRODUCTS } from "../src/db/seed-data";
import { batches, invoiceItems, invoices, pricingRules, products, settings, stockMovements } from "../src/db/schema";
import { addDaysISO, todayISO } from "../src/lib/dates";
import { rupeesToPaise } from "../src/lib/money";
import { toMilli } from "../src/lib/qty";
import { saveSettings } from "../src/services/settings";

const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
fs.mkdirSync(path.dirname(file), { recursive: true });
const sqlite = new Database(file);
const db = createDb(sqlite);

const hasTable = sqlite.prepare("select 1 from sqlite_master where name = 'products'").get();
if (!hasTable) {
  console.error("Tables not found. Run `npm run db:push` first.");
  process.exit(1);
}

if (process.argv.includes("--reset")) {
  db.transaction((tx) => {
    for (const t of [stockMovements, invoiceItems, invoices, batches, pricingRules, products, settings]) tx.delete(t).run();
  });
  console.log("Existing data wiped.");
} else if (db.select().from(products).limit(1).all().length > 0) {
  console.log("Database already has products; nothing seeded. Use `npm run db:seed -- --reset` to start over.");
  process.exit(0);
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

console.log(`Seeded ${SEED_PRODUCTS.length} products into ${file}`);
