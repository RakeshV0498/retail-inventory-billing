import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { batches, invoiceItems, invoices, pricingRules, stockMovements } from "@/db/schema";
import { createInvoice } from "@/services/billing";
import { getDashboardStats } from "@/services/dashboard";
import {
  addBatch,
  getExpiredBatches,
  getExpiringBatches,
  getLowStock,
  searchProducts,
  writeOffBatch,
} from "@/services/inventory";
import { batchQty, makeDb, newProduct, NOW, stock, stockExpired, TODAY } from "./helpers";

const sell = (db: ReturnType<typeof makeDb>, items: Parameters<typeof createInvoice>[1]["items"], extra = {}) =>
  createInvoice(db, { items, paymentMode: "cash", ...extra }, NOW);

const rowCount = (db: ReturnType<typeof makeDb>, table: typeof invoices | typeof invoiceItems | typeof stockMovements) =>
  db.select({ n: sql<number>`count(*)` }).from(table).get()!.n;

describe("stock deduction accuracy", () => {
  it("deducts whole units for strip/pcs products", () => {
    const db = makeDb();
    const strip = newProduct(db, { unitType: "strip" });
    const pcs = newProduct(db, { unitType: "pcs" });
    const sb = stock(db, strip.id, { batch: "S1", qtyMilli: 10_000 });
    const pb = stock(db, pcs.id, { batch: "P1", qtyMilli: 4_000 });

    sell(db, [
      { productId: strip.id, quantity: 3_000 },
      { productId: pcs.id, quantity: 1_000 },
    ]);

    expect(batchQty(db, sb.id)).toBe(7_000);
    expect(batchQty(db, pb.id)).toBe(3_000);
  });

  it("rejects fractional quantity for integer-only products and changes nothing", () => {
    const db = makeDb();
    const strip = newProduct(db, { unitType: "strip" });
    const b = stock(db, strip.id, { batch: "S1", qtyMilli: 10_000 });

    expect(() => sell(db, [{ productId: strip.id, quantity: 500 }])).toThrowError(/fractional/i);
    expect(batchQty(db, b.id)).toBe(10_000);
    expect(rowCount(db, invoices)).toBe(0);
  });

  it("deducts decimal weights exactly (0.25 kg then 1.5 kg)", () => {
    const db = makeDb();
    const rice = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    const b = stock(db, rice.id, { batch: "R1", qtyMilli: 5_000, sell: 6400 });

    const first = sell(db, [{ productId: rice.id, quantity: 250 }]);
    expect(batchQty(db, b.id)).toBe(4_750);
    expect(first.items[0]).toMatchObject({ quantity: 250, lineTotal: 1600 });

    const second = sell(db, [{ productId: rice.id, quantity: 1_500 }]);
    expect(batchQty(db, b.id)).toBe(3_250);
    expect(second.items[0]).toMatchObject({ quantity: 1_500, lineTotal: 9600 });
  });

  it("does not accumulate float error over many small sales", () => {
    const db = makeDb();
    const dal = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    const b = stock(db, dal.id, { batch: "D1", qtyMilli: 10_000 });
    for (let i = 0; i < 40; i++) sell(db, [{ productId: dal.id, quantity: 250 }]);
    expect(batchQty(db, b.id)).toBe(0);
    expect(() => sell(db, [{ productId: dal.id, quantity: 250 }])).toThrowError(/out of stock/i);
  });

  it("keeps batch quantity equal to the sum of ledger movements", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    const b = stock(db, p.id, { batch: "L1", qtyMilli: 8_000 });
    addBatch(
      db,
      { productId: p.id, batchNumber: "L1", expiryDate: "2027-12-31", purchasePrice: 5, mrp: 100, sellingPrice: 100, quantity: 2_500 },
      NOW,
    );
    sell(db, [{ productId: p.id, quantity: 1_250 }]);
    writeOffBatch(db, b.id, 500, "damaged", NOW);

    const moved = db
      .select({ s: sql<number>`sum(${stockMovements.quantityDelta})` })
      .from(stockMovements)
      .where(eq(stockMovements.batchId, b.id))
      .get()!.s;
    expect(batchQty(db, b.id)).toBe(moved);
    expect(moved).toBe(8_000 + 2_500 - 1_250 - 500);
  });
});

describe("FEFO in billing", () => {
  it("sells the earliest-expiring batch first and splits across batches", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    const late = stock(db, p.id, { batch: "LATE", expiry: "2027-06-01", qtyMilli: 5_000 });
    const soon = stock(db, p.id, { batch: "SOON", expiry: "2026-12-01", qtyMilli: 3_000 });

    const { items } = sell(db, [{ productId: p.id, quantity: 4_000 }]);

    expect(items.map((i) => [i.batchId, i.quantity])).toEqual([
      [soon.id, 3_000],
      [late.id, 1_000],
    ]);
    expect(batchQty(db, soon.id)).toBe(0);
    expect(batchQty(db, late.id)).toBe(4_000);
    const movements = db.select().from(stockMovements).where(eq(stockMovements.type, "sale_out")).orderBy(stockMovements.id).all();
    expect(movements.map((m) => m.quantityDelta)).toEqual([-3_000, -1_000]);
  });

  it("never sells an expired batch, even when it expires first", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    const dead = stockExpired(db, p.id, "OLD", "2026-11-20", 9_000);
    const ok = stock(db, p.id, { batch: "NEW", expiry: "2027-03-01", qtyMilli: 2_000 });

    sell(db, [{ productId: p.id, quantity: 2_000 }]);
    expect(batchQty(db, dead.id)).toBe(9_000);
    expect(batchQty(db, ok.id)).toBe(0);

    // Expired stock does not count toward availability.
    expect(() => sell(db, [{ productId: p.id, quantity: 1_000 }])).toThrowError(/expired|out of stock/i);
    expect(batchQty(db, dead.id)).toBe(9_000);
  });

  it("blocks the sale entirely when only expired stock exists", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    const dead = stockExpired(db, p.id, "OLD", "2026-01-01", 5_000);

    expect(() => sell(db, [{ productId: p.id, quantity: 1_000 }])).toThrowError(/expired/i);
    expect(batchQty(db, dead.id)).toBe(5_000);
    expect(rowCount(db, invoices)).toBe(0);
    expect(rowCount(db, stockMovements)).toBe(1); // only the opening purchase_in
  });

  it("still sells a batch that expires today", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const b = stock(db, p.id, { batch: "TODAY", expiry: TODAY, qtyMilli: 2_000 });
    sell(db, [{ productId: p.id, quantity: 1_000 }]);
    expect(batchQty(db, b.id)).toBe(1_000);
  });

  it("sells non-expiring stock last", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const none = stock(db, p.id, { batch: "NOEXP", expiry: null, qtyMilli: 5_000 });
    const dated = stock(db, p.id, { batch: "DATED", expiry: "2027-01-01", qtyMilli: 1_000 });
    sell(db, [{ productId: p.id, quantity: 2_000 }]);
    expect(batchQty(db, dated.id)).toBe(0);
    expect(batchQty(db, none.id)).toBe(4_000);
  });

  it("refuses to receive already-expired stock via addBatch", () => {
    const db = makeDb();
    const p = newProduct(db);
    expect(() => stock(db, p.id, { batch: "X", expiry: "2026-11-20", qtyMilli: 1_000 })).toThrowError(/expired/i);
  });
});

describe("atomicity", () => {
  it("rolls back everything when a later cart line fails", () => {
    const db = makeDb();
    const a = newProduct(db, { unitType: "pcs" });
    const c = newProduct(db, { unitType: "pcs" });
    const ba = stock(db, a.id, { batch: "A", qtyMilli: 5_000 });
    const bc = stock(db, c.id, { batch: "C", qtyMilli: 1_000 });
    const movementsBefore = rowCount(db, stockMovements);

    expect(() =>
      sell(db, [
        { productId: a.id, quantity: 2_000 },
        { productId: c.id, quantity: 3_000 },
      ]),
    ).toThrowError(/available|stock/i);

    expect(batchQty(db, ba.id)).toBe(5_000);
    expect(batchQty(db, bc.id)).toBe(1_000);
    expect(rowCount(db, invoices)).toBe(0);
    expect(rowCount(db, invoiceItems)).toBe(0);
    expect(rowCount(db, stockMovements)).toBe(movementsBefore);
  });

  it("accounts for the same product appearing on two cart lines", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 5_000 });
    expect(() =>
      sell(db, [
        { productId: p.id, quantity: 3_000 },
        { productId: p.id, quantity: 3_000 },
      ]),
    ).toThrowError(/available/i);
    expect(batchQty(db, b.id)).toBe(5_000);

    sell(db, [
      { productId: p.id, quantity: 3_000 },
      { productId: p.id, quantity: 2_000 },
    ]);
    expect(batchQty(db, b.id)).toBe(0);
  });

  it("the batch CHECK constraint prevents negative stock at the DB level", () => {
    const db = makeDb();
    const p = newProduct(db);
    const b = stock(db, p.id, { batch: "A", qtyMilli: 1_000 });
    expect(() =>
      db.update(batches).set({ quantityAvailable: -1 }).where(eq(batches.id, b.id)).run(),
    ).toThrow();
  });
});

describe("invoice totals, tax and payment", () => {
  it("totals reconcile across mixed GST slabs, discounts and round-off", () => {
    const db = makeDb();
    const med = newProduct(db, { unitType: "strip", gstRate: 12 });
    const oil = newProduct(db, { unitType: "pcs", gstRate: 5 });
    const rice = newProduct(db, { unitType: "kg", allowDecimalQty: true, gstRate: 0 });
    const cosm = newProduct(db, { unitType: "pcs", gstRate: 18 });
    stock(db, med.id, { batch: "M", qtyMilli: 50_000, sell: 1_833 });
    stock(db, oil.id, { batch: "O", qtyMilli: 10_000, sell: 15_849 });
    stock(db, rice.id, { batch: "R", qtyMilli: 50_000, sell: 6_450 });
    stock(db, cosm.id, { batch: "C", qtyMilli: 10_000, sell: 29_999 });

    const { invoice, items } = sell(db, [
      { productId: med.id, quantity: 7_000, discountType: "percent", discountValue: 500 },
      { productId: oil.id, quantity: 2_000 },
      { productId: rice.id, quantity: 1_750 },
      { productId: cosm.id, quantity: 1_000, discountType: "flat", discountValue: 333 },
    ]);

    const net = items.reduce((s, i) => s + i.lineTotal, 0);
    expect(invoice.subtotal - invoice.discountTotal).toBe(net);
    expect(items.reduce((s, i) => s + i.taxableAmount + i.taxAmount, 0)).toBe(net);
    expect(invoice.taxTotal).toBe(items.reduce((s, i) => s + i.taxAmount, 0));
    expect(net + invoice.roundOff).toBe(invoice.grandTotal);
    expect(invoice.grandTotal % 100).toBe(0);
    expect(invoice.cashAmount).toBe(invoice.grandTotal);
    for (const i of items) expect(i.taxableAmount + i.taxAmount).toBe(i.lineTotal);
  });

  it("snapshots prices/names so later edits do not alter old invoices", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Original", unitType: "pcs" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 5_000, sell: 5_000 });
    const { items } = sell(db, [{ productId: p.id, quantity: 1_000 }]);
    db.update(batches).set({ sellingPrice: 9_999 }).where(eq(batches.id, b.id)).run();
    const saved = db.select().from(invoiceItems).where(eq(invoiceItems.id, items[0]!.id)).get()!;
    expect(saved).toMatchObject({ productName: "Original", unitPrice: 5_000, batchNumber: "A" });
  });

  it("validates split payments against the grand total", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    stock(db, p.id, { batch: "A", qtyMilli: 5_000, sell: 10_000 });

    expect(() =>
      sell(db, [{ productId: p.id, quantity: 1_000 }], { paymentMode: "split", split: { cash: 5_000, upi: 4_000 } }),
    ).toThrowError(/add up/i);
    expect(rowCount(db, invoices)).toBe(0);

    const ok = sell(db, [{ productId: p.id, quantity: 1_000 }], {
      paymentMode: "split",
      split: { cash: 4_000, upi: 4_000, card: 2_000 },
    });
    expect(ok.invoice).toMatchObject({ cashAmount: 4_000, upiAmount: 4_000, cardAmount: 2_000, paymentMode: "split" });
  });

  it("numbers invoices sequentially per day", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    stock(db, p.id, { batch: "A", qtyMilli: 9_000 });
    const nums = [1, 2, 3].map(() => sell(db, [{ productId: p.id, quantity: 1_000 }]).invoice.invoiceNumber);
    expect(nums).toEqual(["INV-20261121-0001", "INV-20261121-0002", "INV-20261121-0003"]);
  });

  it("spreads a flat discount across the batches a line was split over", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    stock(db, p.id, { batch: "A", expiry: "2026-12-01", qtyMilli: 1_000, sell: 10_000 });
    stock(db, p.id, { batch: "B", expiry: "2027-06-01", qtyMilli: 3_000, sell: 10_000 });
    const { items, invoice } = sell(db, [{ productId: p.id, quantity: 4_000, discountType: "flat", discountValue: 1_001 }]);
    expect(items).toHaveLength(2);
    expect(items.reduce((s, i) => s + i.discountAmount, 0)).toBe(1_001);
    expect(invoice.discountTotal).toBe(1_001);
  });

  it("rejects a discount larger than the line and writes nothing", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 5_000, sell: 1_000 });
    expect(() => sell(db, [{ productId: p.id, quantity: 1_000, discountType: "flat", discountValue: 5_000 }])).toThrowError(
      /discount/i,
    );
    expect(batchQty(db, b.id)).toBe(5_000);
  });
});

describe("near-expiry markdown (dynamic pricing)", () => {
  const withRule = () => {
    const db = makeDb();
    db.insert(pricingRules).values({ name: "30d", minDaysToExpiry: 0, maxDaysToExpiry: 30, discountPercent: 1000 }).run();
    return db;
  };

  it("discounts only the batches inside the rule window", () => {
    const db = withRule();
    const p = newProduct(db, { unitType: "strip" });
    stock(db, p.id, { batch: "NEAR", expiry: "2026-12-11", qtyMilli: 2_000, sell: 10_000 }); // 20 days
    stock(db, p.id, { batch: "FAR", expiry: "2027-11-01", qtyMilli: 5_000, sell: 10_000 });

    const { items } = sell(db, [{ productId: p.id, quantity: 3_000, applyMarkdown: true }]);
    const near = items.find((i) => i.batchNumber === "NEAR")!;
    const far = items.find((i) => i.batchNumber === "FAR")!;
    expect(near).toMatchObject({ discountType: "percent", discountValue: 1_000, discountAmount: 2_000, lineTotal: 18_000 });
    expect(far).toMatchObject({ discountAmount: 0, lineTotal: 10_000 });
  });

  it("is off unless requested, and a manual discount takes precedence", () => {
    const db = withRule();
    const p = newProduct(db, { unitType: "strip" });
    stock(db, p.id, { batch: "NEAR", expiry: "2026-12-11", qtyMilli: 9_000, sell: 10_000 });
    expect(sell(db, [{ productId: p.id, quantity: 1_000 }]).items[0]!.discountAmount).toBe(0);
    const manual = sell(db, [
      { productId: p.id, quantity: 1_000, applyMarkdown: true, discountType: "flat", discountValue: 100 },
    ]);
    expect(manual.items[0]).toMatchObject({ discountType: "flat", discountAmount: 100 });
  });
});

describe("inventory alerts, search and wastage", () => {
  it("finds batches expiring within 30 / 60 days and expired stock", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    stock(db, p.id, { batch: "D20", expiry: "2026-12-11", qtyMilli: 1_000 });
    stock(db, p.id, { batch: "D45", expiry: "2027-01-05", qtyMilli: 1_000 });
    stock(db, p.id, { batch: "D200", expiry: "2027-06-09", qtyMilli: 1_000 });
    stockExpired(db, p.id, "DEAD", "2026-11-01", 1_000);

    expect(getExpiringBatches(db, TODAY, 30).map((a) => a.batch.batchNumber)).toEqual(["D20"]);
    expect(getExpiringBatches(db, TODAY, 60).map((a) => a.batch.batchNumber)).toEqual(["D20", "D45"]);
    expect(getExpiredBatches(db, TODAY).map((a) => a.batch.batchNumber)).toEqual(["DEAD"]);
  });

  it("low stock counts only sellable (non-expired) quantity", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs", lowStockThreshold: 5_000 });
    stock(db, p.id, { batch: "OK", qtyMilli: 6_000 });
    stockExpired(db, p.id, "DEAD", "2026-01-01", 50_000);
    expect(getLowStock(db, TODAY)).toHaveLength(0);
    sell(db, [{ productId: p.id, quantity: 2_000 }]);
    expect(getLowStock(db, TODAY).map((x) => x.id)).toEqual([p.id]);
  });

  it("searches by name, SKU and exact barcode", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Toor Dal", sku: "DAL-1", barcode: "8901234567890" });
    stock(db, p.id, { batch: "A", qtyMilli: 1_000 });
    expect(searchProducts(db, "toor", TODAY).map((x) => x.id)).toEqual([p.id]);
    expect(searchProducts(db, "dal-1", TODAY)).toHaveLength(1);
    expect(searchProducts(db, "8901234567890", TODAY)).toHaveLength(1);
    expect(searchProducts(db, "%", TODAY)).toHaveLength(0);
  });

  it("writes off an expired batch and records the movement", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "strip" });
    const dead = stockExpired(db, p.id, "DEAD", "2026-01-01", 4_000);
    expect(writeOffBatch(db, dead.id, undefined, "expired", NOW)).toBe(4_000);
    expect(batchQty(db, dead.id)).toBe(0);
    const m = db.select().from(stockMovements).where(eq(stockMovements.type, "expired_wastage")).get()!;
    expect(m.quantityDelta).toBe(-4_000);
    expect(() => writeOffBatch(db, dead.id, undefined, "again", NOW)).toThrow();
  });

  it("rejects duplicate SKU", () => {
    const db = makeDb();
    newProduct(db, { sku: "SAME" });
    expect(() => newProduct(db, { sku: "SAME" })).toThrowError(/already exists/i);
  });
});

describe("dashboard", () => {
  it("reports today's sales and an estimated profit excluding GST", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs", gstRate: 0 });
    const q = newProduct(db, { unitType: "pcs", gstRate: 12 });
    stock(db, p.id, { batch: "A", qtyMilli: 9_000, sell: 10_000, cost: 7_000 });
    stock(db, q.id, { batch: "B", qtyMilli: 9_000, sell: 11_200, cost: 8_960 });

    sell(db, [{ productId: p.id, quantity: 2_000 }]); // revenue 20000, cost 14000 => 6000
    sell(db, [{ productId: q.id, quantity: 1_000 }]); // taxable 10000, cost 8960/1.12 = 8000 => 2000

    const s = getDashboardStats(db, NOW);
    expect(s.todayInvoices).toBe(2);
    expect(s.todaySales).toBe(20_000 + 11_200 + 0); // grand totals (11200 is already whole rupees)
    expect(s.profitEstimate).toBe(8_000);
  });

  it("counts low-stock and expiring-soon items", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs", lowStockThreshold: 10_000 });
    stock(db, p.id, { batch: "NEAR", expiry: "2026-12-11", qtyMilli: 3_000 });
    const s = getDashboardStats(db, NOW);
    expect(s).toMatchObject({ lowStockCount: 1, expiringSoonCount: 1, todaySales: 0, profitEstimate: 0 });
  });
});
