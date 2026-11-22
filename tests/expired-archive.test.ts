import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { batches, invoiceItems, products, stockMovements } from "@/db/schema";
import { createInvoice } from "@/services/billing";
import {
  addBatch,
  archiveProduct,
  deleteProduct,
  findByBarcode,
  getExpiredBatches,
  getLowStock,
  getProduct,
  getProductBatches,
  listArchivedProducts,
  listProducts,
  productHasHistory,
  restoreProduct,
  searchProducts,
  writeOffBatch,
  writeOffExpired,
} from "@/services/inventory";
import { batchQty, makeDb, newProduct, NOW, stock, stockExpired, TODAY } from "./helpers";

const ledgerSum = (db: ReturnType<typeof makeDb>, batchId: number) =>
  db.select({ s: sql<number>`coalesce(sum(${stockMovements.quantityDelta}),0)` }).from(stockMovements).where(eq(stockMovements.batchId, batchId)).get()!.s;

const sell = (db: ReturnType<typeof makeDb>, productId: number, quantity: number) =>
  createInvoice(db, { items: [{ productId, quantity }], paymentMode: "cash" }, NOW);

describe("writeOffExpired (bulk)", () => {
  it("writes off only expired batches, keeps the ledger in step, and is a no-op the second time", () => {
    const db = makeDb();
    const a = newProduct(db, { unitType: "strip" });
    const b = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    const aOld = stockExpired(db, a.id, "A-OLD", "2026-11-01", 3_000); // cost 5000/unit
    const bOld = stockExpired(db, b.id, "B-OLD", "2026-10-01", 1_500);
    const aOk = stock(db, a.id, { batch: "A-OK", qtyMilli: 5_000 });

    const res = writeOffExpired(db, TODAY, NOW);

    expect(res).toEqual({ batches: 2, products: 2, costLost: 15_000 + 7_500 }); // 3×50 + 1.5×50, exact integer maths
    expect(batchQty(db, aOld.id)).toBe(0);
    expect(batchQty(db, bOld.id)).toBe(0);
    expect(batchQty(db, aOk.id)).toBe(5_000); // sellable stock untouched
    for (const id of [aOld.id, bOld.id, aOk.id]) expect(batchQty(db, id)).toBe(ledgerSum(db, id));
    const wastage = db.select().from(stockMovements).where(eq(stockMovements.type, "expired_wastage")).all();
    expect(wastage.map((m) => m.quantityDelta).sort((x, y) => x - y)).toEqual([-3_000, -1_500]);

    expect(getExpiredBatches(db, TODAY)).toHaveLength(0);
    expect(writeOffExpired(db, TODAY, NOW)).toEqual({ batches: 0, products: 0, costLost: 0 });
    expect(db.select().from(stockMovements).where(eq(stockMovements.type, "expired_wastage")).all()).toHaveLength(2);
  });

  it("does not touch a batch that expires today", () => {
    const db = makeDb();
    const p = newProduct(db);
    const b = stock(db, p.id, { batch: "TODAY", expiry: TODAY, qtyMilli: 2_000 });
    expect(writeOffExpired(db, TODAY, NOW).batches).toBe(0);
    expect(batchQty(db, b.id)).toBe(2_000);
  });
});

describe("hiding emptied batches", () => {
  it("hides zero-stock batches by default and shows them with includeEmpty", () => {
    const db = makeDb();
    const p = newProduct(db);
    const dead = stockExpired(db, p.id, "DEAD", "2026-01-01", 1_000);
    stock(db, p.id, { batch: "OK", qtyMilli: 2_000 });
    writeOffBatch(db, dead.id, undefined, "x", NOW);
    expect(getProductBatches(db, p.id).map((b) => b.batchNumber)).toEqual(["OK"]);
    expect(getProductBatches(db, p.id, { includeEmpty: true }).map((b) => b.batchNumber).sort()).toEqual(["DEAD", "OK"]);
    // History is never deleted: the wastage movement is still there.
    expect(ledgerSum(db, dead.id)).toBe(0);
    expect(db.select().from(stockMovements).where(eq(stockMovements.batchId, dead.id)).all()).toHaveLength(2);
  });
});

describe("archive / restore", () => {
  it("is refused while sellable stock remains and changes nothing", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Rice", unitType: "kg", allowDecimalQty: true });
    stock(db, p.id, { batch: "A", qtyMilli: 2_500 });
    expect(() => archiveProduct(db, p.id, NOW)).toThrowError(/still has 2\.5 kg/);
    expect(getProduct(db, p.id)!.isActive).toBe(true);
  });

  it("writes off leftover expired stock in the same step, then archives", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    const dead = stockExpired(db, p.id, "DEAD", "2026-01-01", 4_000);
    expect(archiveProduct(db, p.id, NOW)).toEqual({ writtenOff: 4_000 });
    expect(batchQty(db, dead.id)).toBe(0);
    expect(ledgerSum(db, dead.id)).toBe(0);
    expect(getProduct(db, p.id)!.isActive).toBe(false);
    expect(archiveProduct(db, p.id, NOW)).toEqual({ writtenOff: 0 }); // idempotent
  });

  it("an archived product leaves POS search, barcode lookup, lists and low-stock, and cannot be sold", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Old Soap", barcode: "8901234500001", lowStockThreshold: 5_000 });
    expect(getLowStock(db, TODAY).map((x) => x.id)).toContain(p.id); // zero stock + threshold => low
    archiveProduct(db, p.id, NOW);

    expect(listProducts(db, TODAY).map((x) => x.id)).not.toContain(p.id);
    expect(searchProducts(db, "soap", TODAY)).toHaveLength(0);
    expect(findByBarcode(db, "8901234500001", TODAY)).toBeNull();
    expect(getLowStock(db, TODAY).map((x) => x.id)).not.toContain(p.id);
    expect(listArchivedProducts(db).map((x) => x.id)).toEqual([p.id]);
    expect(() => sell(db, p.id, 1_000)).toThrowError(/not found/i);
    expect(() => stock(db, p.id, { batch: "N", qtyMilli: 1_000 })).toThrowError(/archived/i);
  });

  it("restore brings it back and it can be stocked and sold again", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Comeback", unitType: "pcs" });
    archiveProduct(db, p.id, NOW);
    restoreProduct(db, p.id);
    expect(searchProducts(db, "comeback", TODAY).map((x) => x.id)).toEqual([p.id]);
    stock(db, p.id, { batch: "A", qtyMilli: 3_000 });
    expect(sell(db, p.id, 1_000).items).toHaveLength(1);
    expect(() => restoreProduct(db, 9999)).toThrow();
  });

  it("keeps old invoices intact after the product is archived", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Sold Once", unitType: "pcs" });
    stock(db, p.id, { batch: "A", qtyMilli: 1_000 });
    const { invoice } = sell(db, p.id, 1_000); // sells out, so archive is allowed
    archiveProduct(db, p.id, NOW);
    const items = db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoice.id)).all();
    expect(items[0]!.productName).toBe("Sold Once");
  });
});

describe("permanent delete", () => {
  it("deletes a product that never had anything", () => {
    const db = makeDb();
    const p = newProduct(db);
    expect(productHasHistory(db, p.id)).toBe(false);
    deleteProduct(db, p.id);
    expect(getProduct(db, p.id)).toBeUndefined();
    expect(db.select().from(products).all()).toHaveLength(0);
  });

  it("refuses when the product has a batch or movement", () => {
    const db = makeDb();
    const p = newProduct(db);
    stock(db, p.id, { batch: "A", qtyMilli: 1_000 });
    expect(productHasHistory(db, p.id)).toBe(true);
    expect(() => deleteProduct(db, p.id)).toThrowError(/archive it instead/i);
    expect(getProduct(db, p.id)).toBeDefined();
    expect(db.select().from(batches).all()).toHaveLength(1);
  });

  it("refuses when it was ever sold, even after it is archived", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    stock(db, p.id, { batch: "A", qtyMilli: 1_000 });
    sell(db, p.id, 1_000);
    archiveProduct(db, p.id, NOW);
    expect(() => deleteProduct(db, p.id)).toThrowError(/archive it instead/i);
  });

  it("reports not-found for a missing product", () => {
    expect(() => deleteProduct(makeDb(), 4242)).toThrowError(/not found/i);
  });
});

describe("existing behaviour still holds", () => {
  it("addBatch on an active product still works and writes the ledger", () => {
    const db = makeDb();
    const p = newProduct(db);
    const b = addBatch(db, { productId: p.id, batchNumber: "X", expiryDate: "2027-12-31", purchasePrice: 1, mrp: 2, sellingPrice: 2, quantity: 1_000 }, NOW);
    expect(batchQty(db, b.id)).toBe(ledgerSum(db, b.id));
  });
});
