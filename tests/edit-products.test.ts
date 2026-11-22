import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { batches, invoiceItems, stockMovements } from "@/db/schema";
import { createInvoice } from "@/services/billing";
import { adjustStock, archiveProduct, getProduct, updateBatch, updateProduct, type ProductInput } from "@/services/inventory";
import { lookupBarcode } from "@/services/productLookup";
import { batchQty, makeDb, newProduct, NOW, stock } from "./helpers";

const edit = (db: ReturnType<typeof makeDb>, id: number, over: Partial<ProductInput> = {}) => {
  const p = getProduct(db, id)!;
  return updateProduct(db, id, {
    name: p.name, sku: p.sku, barcode: p.barcode, category: p.category, unitType: p.unitType,
    allowDecimalQty: p.allowDecimalQty, lowStockThreshold: p.lowStockThreshold, gstRate: p.gstRate as 0, hsnCode: p.hsnCode,
    ...over,
  });
};
const ledger = (db: ReturnType<typeof makeDb>, batchId: number) =>
  db.select({ s: sql<number>`coalesce(sum(${stockMovements.quantityDelta}),0)` }).from(stockMovements).where(eq(stockMovements.batchId, batchId)).get()!.s;
const sell = (db: ReturnType<typeof makeDb>, productId: number, quantity: number) =>
  createInvoice(db, { items: [{ productId, quantity }], paymentMode: "cash" }, NOW);

describe("updateProduct", () => {
  it("renames, re-categorises and changes GST/HSN/threshold", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Pickel" });
    const u = edit(db, p.id, { name: "Pickle", gstRate: 12, hsnCode: "2001", category: "general", lowStockThreshold: 5_000 });
    expect(u).toMatchObject({ name: "Pickle", gstRate: 12, hsnCode: "2001", category: "general", lowStockThreshold: 5_000 });
  });

  it("can add a barcode to an existing product, and rejects one already used (even by an archived product)", () => {
    const db = makeDb();
    const a = newProduct(db, { name: "A" });
    const b = newProduct(db, { name: "B", barcode: "4006381333931" });
    expect(edit(db, a.id, { barcode: "8901058852417" }).barcode).toBe("8901058852417");
    expect(() => edit(db, a.id, { barcode: "4006381333931" })).toThrowError(/already has this SKU or barcode/);
    archiveProduct(db, b.id, NOW);
    expect(() => edit(db, a.id, { barcode: "4006381333931" })).toThrowError(/archived/);
    expect(edit(db, a.id, { barcode: null }).barcode).toBeNull();
  });

  it("rejects a duplicate SKU", () => {
    const db = makeDb();
    newProduct(db, { sku: "TAKEN" });
    const p = newProduct(db, { sku: "MINE" });
    expect(() => edit(db, p.id, { sku: "TAKEN" })).toThrowError(/already has/);
    expect(getProduct(db, p.id)!.sku).toBe("MINE");
  });

  it("allows unit changes within pcs/strip/bottle even with stock, but locks kg<->g and crossing families once there is history", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    stock(db, p.id, { batch: "A", qtyMilli: 5_000 });
    expect(edit(db, p.id, { unitType: "bottle" }).unitType).toBe("bottle");
    expect(() => edit(db, p.id, { unitType: "kg" })).toThrowError(/stock history/);

    const loose = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    stock(db, loose.id, { batch: "L", qtyMilli: 2_500 });
    expect(() => edit(db, loose.id, { unitType: "g" })).toThrowError(/stock history/);

    const fresh = newProduct(db, { unitType: "pcs" }); // no history yet: anything goes
    expect(edit(db, fresh.id, { unitType: "kg", allowDecimalQty: true }).unitType).toBe("kg");
  });

  it("turning off 'sold loose' is refused while fractional stock exists, allowed otherwise", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 1_500 });
    expect(() => edit(db, p.id, { allowDecimalQty: false })).toThrowError(/fractions/);
    adjustStock(db, b.id, 2_000, "recount", NOW);
    expect(edit(db, p.id, { allowDecimalQty: false }).allowDecimalQty).toBe(false);
    expect(edit(db, p.id, { allowDecimalQty: true }).allowDecimalQty).toBe(true); // false -> true always fine
  });

  it("validates the threshold for whole-unit products and reports a missing product", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    expect(() => edit(db, p.id, { lowStockThreshold: 2_500 })).toThrowError(/whole number/);
    expect(() => updateProduct(db, 9999, { name: "x", sku: "x", category: "grocery", unitType: "pcs", gstRate: 0 })).toThrowError(/not found/i);
  });

  it("a GST change affects future sales only; old invoice lines keep their snapshot", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs", gstRate: 5 });
    stock(db, p.id, { batch: "A", qtyMilli: 9_000, sell: 10_500 });
    const before = sell(db, p.id, 1_000).items[0]!;
    edit(db, p.id, { gstRate: 18 });
    const after = sell(db, p.id, 1_000).items[0]!;
    const old = db.select().from(invoiceItems).where(eq(invoiceItems.id, before.id)).get()!;
    expect(old).toMatchObject({ gstRate: 5, taxAmount: 500, taxableAmount: 10_000 });
    expect(after.gstRate).toBe(18);
  });
});

describe("updateBatch", () => {
  it("corrects prices and dates; old invoices keep their prices", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 9_000, sell: 5_000 });
    const sold = sell(db, p.id, 1_000).items[0]!;
    const u = updateBatch(db, b.id, { batchNumber: "A2", mfgDate: "2026-01-01", expiryDate: "2028-01-01", purchasePrice: 3_000, mrp: 9_000, sellingPrice: 8_000 });
    expect(u).toMatchObject({ batchNumber: "A2", sellingPrice: 8_000, expiryDate: "2028-01-01" });
    expect(db.select().from(invoiceItems).where(eq(invoiceItems.id, sold.id)).get()).toMatchObject({ unitPrice: 5_000, batchNumber: "A" });
    expect(sell(db, p.id, 1_000).items[0]!.unitPrice).toBe(8_000);
    expect(batchQty(db, b.id)).toBe(7_000); // quantity untouched by an edit
  });

  it("rejects a duplicate batch number, selling above MRP, and bad dates", () => {
    const db = makeDb();
    const p = newProduct(db);
    stock(db, p.id, { batch: "A", qtyMilli: 1_000 });
    const b = stock(db, p.id, { batch: "B", qtyMilli: 1_000 });
    const base = { batchNumber: "B", purchasePrice: 1, mrp: 10, sellingPrice: 10 };
    expect(() => updateBatch(db, b.id, { ...base, batchNumber: "A" })).toThrowError(/already has that batch number/);
    expect(() => updateBatch(db, b.id, { ...base, sellingPrice: 11 })).toThrow();
    expect(() => updateBatch(db, b.id, { ...base, mfgDate: "2027-01-02", expiryDate: "2027-01-01" })).toThrow();
    expect(() => updateBatch(db, 9999, base)).toThrowError(/not found/i);
  });

  it("moving the expiry into the past makes the batch unsellable", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 3_000 });
    updateBatch(db, b.id, { batchNumber: "A", expiryDate: "2026-11-01", purchasePrice: 1, mrp: 10, sellingPrice: 10 });
    expect(() => sell(db, p.id, 1_000)).toThrowError(/expired/i);
  });
});

describe("adjustStock", () => {
  it("corrects a typo in either direction and keeps quantity == ledger sum", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 100_000 }); // keyed 100 instead of 10
    expect(adjustStock(db, b.id, 10_000, "keyed 100 instead of 10", NOW)).toBe(-90_000);
    expect(batchQty(db, b.id)).toBe(10_000);
    expect(adjustStock(db, b.id, 12_000, "found 2 more", NOW)).toBe(2_000);
    expect(batchQty(db, b.id)).toBe(ledger(db, b.id));
    const rows = db.select().from(stockMovements).where(eq(stockMovements.type, "adjustment")).orderBy(stockMovements.id).all();
    expect(rows.map((r) => [r.quantityDelta, r.note])).toEqual([[-90_000, "keyed 100 instead of 10"], [2_000, "found 2 more"]]);
  });

  it("needs a reason, refuses negatives and fractions on whole-unit products, and is a no-op when unchanged", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 5_000 });
    expect(() => adjustStock(db, b.id, 4_000, "   ", NOW)).toThrowError(/reason/i);
    expect(() => adjustStock(db, b.id, -1, "x", NOW)).toThrowError(/negative/i);
    expect(() => adjustStock(db, b.id, 4_500, "x", NOW)).toThrowError(/whole/i);
    expect(adjustStock(db, b.id, 5_000, "same", NOW)).toBe(0);
    expect(db.select().from(stockMovements).where(eq(stockMovements.type, "adjustment")).all()).toHaveLength(0);
    expect(batchQty(db, b.id)).toBe(5_000);
    expect(() => adjustStock(db, 9999, 1_000, "x", NOW)).toThrowError(/not found/i);
  });

  it("allows fractional counts for loose products and can zero a batch", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 5_000 });
    adjustStock(db, b.id, 4_750, "spillage", NOW);
    expect(batchQty(db, b.id)).toBe(4_750);
    adjustStock(db, b.id, 0, "damaged", NOW);
    expect(db.select().from(batches).where(eq(batches.id, b.id)).get()!.quantityAvailable).toBe(0);
    expect(ledger(db, b.id)).toBe(0);
  });
});

describe("lookup while editing", () => {
  it("does not flag the product's own barcode as a duplicate, but still flags another product's", async () => {
    const db = makeDb();
    const mine = newProduct(db, { name: "Mine", barcode: "4006381333931" });
    const other = newProduct(db, { name: "Other", barcode: "8901058852417" });
    const noNet = { sources: [], excludeProductId: mine.id };
    expect((await lookupBarcode(db, "4006381333931", noNet)).local).toBeNull();
    expect((await lookupBarcode(db, "8901058852417", noNet)).local?.id).toBe(other.id);
    expect((await lookupBarcode(db, "4006381333931", { sources: [] })).local?.id).toBe(mine.id);
  });
});
