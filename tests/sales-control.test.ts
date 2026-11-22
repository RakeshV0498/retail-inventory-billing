import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, batches, invoices, payments, pricingRules, stockMovements, type InvoiceItem } from "@/db/schema";
import type { Actor } from "@/services/audit";
import { listAudit } from "@/services/audit";
import { createInvoice, getInvoice, listInvoices, type InvoiceInput } from "@/services/billing";
import { balanceOf, createCustomer, getCustomerLedger, recordPayment, voidPayment } from "@/services/customers";
import { getDashboardStats } from "@/services/dashboard";
import { archiveProduct } from "@/services/inventory";
import { getSalesReport } from "@/services/reports";
import {
  amendInvoice,
  getInvoiceRelations,
  seedLinesFromItems,
  stockAsIfVoided,
  updateInvoiceDetails,
  voidInvoice,
} from "@/services/sales";
import { createFirstAdmin } from "@/services/users";
import { batchQty, makeDb, newProduct, NOW, stock, stockExpired } from "./helpers";

type Db = ReturnType<typeof makeDb>;
const ADMIN: Actor = { id: null, name: "Admin" };
const ledger = (db: Db, batchId: number) =>
  db.select({ s: sql<number>`coalesce(sum(${stockMovements.quantityDelta}),0)` }).from(stockMovements).where(eq(stockMovements.batchId, batchId)).get()!.s;
const allBatchesConsistent = (db: Db) => db.select().from(batches).all().every((b) => b.quantityAvailable === ledger(db, b.id));
const sell = (db: Db, input: Partial<InvoiceInput> & Pick<InvoiceInput, "items">, actor: Actor | null = null) =>
  createInvoice(db, { paymentMode: "cash", ...input }, NOW, actor);
const line = (productId: number, quantity: number, extra = {}) => ({ productId, quantity, ...extra });

/** ₹100/pc, no GST: totals are easy to read. */
function shop() {
  const db = makeDb();
  const p = newProduct(db, { name: "Widget", unitType: "pcs" });
  const b = stock(db, p.id, { batch: "A", qtyMilli: 100_000, sell: 10_000, cost: 6_000 });
  return { db, p, b };
}

describe("voidInvoice", () => {
  it("puts stock back into the exact batches (multi-batch FEFO split) and keeps the ledger consistent", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    const soon = stock(db, p.id, { batch: "SOON", expiry: "2026-12-01", qtyMilli: 3_000 });
    const late = stock(db, p.id, { batch: "LATE", expiry: "2027-06-01", qtyMilli: 9_000 });
    const { invoice } = sell(db, { items: [line(p.id, 5_000)] }); // 3 from SOON + 2 from LATE
    expect([batchQty(db, soon.id), batchQty(db, late.id)]).toEqual([0, 7_000]);

    const sum = voidInvoice(db, invoice.id, ADMIN, "wrong customer", NOW);
    expect([batchQty(db, soon.id), batchQty(db, late.id)]).toEqual([3_000, 9_000]);
    expect(sum.restored.map((r) => [r.batchNumber, r.quantity])).toEqual([["SOON", 3_000], ["LATE", 2_000]]);
    expect(allBatchesConsistent(db)).toBe(true);
    const returns = db.select().from(stockMovements).where(eq(stockMovements.type, "return")).orderBy(stockMovements.id).all();
    expect(returns.map((m) => [m.batchId, m.quantityDelta, m.referenceType, m.referenceId])).toEqual([
      [soon.id, 3_000, "invoice", invoice.id], [late.id, 2_000, "invoice", invoice.id],
    ]);
    expect(returns[0]!.note).toContain("wrong customer");
  });

  it("restores decimal weights exactly", () => {
    const db = makeDb();
    const rice = newProduct(db, { unitType: "kg", allowDecimalQty: true });
    const b = stock(db, rice.id, { batch: "R", qtyMilli: 5_000, sell: 6_400 });
    const { invoice } = sell(db, { items: [line(rice.id, 250), line(rice.id, 1_500)] });
    expect(batchQty(db, b.id)).toBe(3_250);
    voidInvoice(db, invoice.id, ADMIN, "mistake", NOW);
    expect(batchQty(db, b.id)).toBe(5_000);
    expect(allBatchesConsistent(db)).toBe(true);
  });

  it("stamps the bill VOID (reason, who, when), keeps it, and drops it from reports, dashboard and totals", () => {
    const { db, p } = shop();
    const keep = sell(db, { items: [line(p.id, 1_000)] });
    const gone = sell(db, { items: [line(p.id, 2_000)] });
    expect(getDashboardStats(db, NOW).todaySales).toBe(30_000);
    voidInvoice(db, gone.invoice.id, ADMIN, "test bill", NOW);

    const row = db.select().from(invoices).where(eq(invoices.id, gone.invoice.id)).get()!;
    expect(row).toMatchObject({ status: "void", voidReason: "test bill", voidedByName: "Admin" });
    expect(row.voidedAt).toBe(NOW.toISOString());
    expect(getInvoice(db, gone.invoice.id)).not.toBeNull(); // still there
    expect(getDashboardStats(db, NOW).todaySales).toBe(10_000);
    const r = getSalesReport(db, "2026-11-21", "2026-11-21");
    expect(r).toMatchObject({ invoiceCount: 1, netSales: 10_000 });
    expect(listInvoices(db, { status: "void" }).map((i) => i.id)).toEqual([gone.invoice.id]);
    expect(listInvoices(db, { status: "paid" }).map((i) => i.id)).toEqual([keep.invoice.id]);
  });

  it("reports show how many bills were voided, but never count them", () => {
    const { db, p } = shop();
    sell(db, { items: [line(p.id, 1_000)] });
    const a = sell(db, { items: [line(p.id, 2_000)] });
    const b = sell(db, { items: [line(p.id, 3_000)] });
    voidInvoice(db, a.invoice.id, ADMIN, "x", NOW);
    voidInvoice(db, b.invoice.id, ADMIN, "y", NOW);
    const r = getSalesReport(db, "2026-11-21", "2026-11-21");
    expect(r).toMatchObject({ invoiceCount: 1, netSales: 10_000, voided: { count: 2, total: 50_000 } });
    expect(r.byUser.reduce((s, u) => s + u.invoices, 0)).toBe(1);
    expect(r.payments.cash).toBe(10_000);
    expect(getSalesReport(db, "2026-11-20", "2026-11-20").voided).toEqual({ count: 0, total: 0 });
  });

  it("tells the admin how much to refund per payment type, and how much credit was reversed", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Cust" });
    const cash = sell(db, { items: [line(p.id, 1_000)], paymentMode: "cash" });
    const upi = sell(db, { items: [line(p.id, 1_000)], paymentMode: "upi" });
    const split = sell(db, { items: [line(p.id, 4_000)], paymentMode: "split", customerId: c.id, split: { cash: 10_000, upi: 10_000, card: 5_000, credit: 15_000 } });
    const credit = sell(db, { items: [line(p.id, 2_000)], paymentMode: "credit", customerId: c.id });
    expect(voidInvoice(db, cash.invoice.id, ADMIN, "x", NOW)).toMatchObject({ refund: { cash: 10_000, upi: 0, card: 0 }, creditReversed: 0 });
    expect(voidInvoice(db, upi.invoice.id, ADMIN, "x", NOW).refund).toEqual({ cash: 0, upi: 10_000, card: 0 });
    expect(voidInvoice(db, split.invoice.id, ADMIN, "x", NOW)).toMatchObject({ refund: { cash: 10_000, upi: 10_000, card: 5_000 }, creditReversed: 15_000, customerName: "Cust" });
    expect(voidInvoice(db, credit.invoice.id, ADMIN, "x", NOW)).toMatchObject({ refund: { cash: 0, upi: 0, card: 0 }, creditReversed: 20_000 });
  });

  it("reverses the customer's dues; if they already paid, they end up ahead (negative balance)", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Cust" });
    const a = sell(db, { items: [line(p.id, 3_000)], paymentMode: "credit", customerId: c.id });
    recordPayment(db, c.id, 10_000, "cash", null, NOW);
    expect(balanceOf(db, c.id)).toBe(20_000);
    voidInvoice(db, a.invoice.id, ADMIN, "wrong", NOW);
    expect(balanceOf(db, c.id)).toBe(-10_000); // paid ₹100 against a bill that no longer exists
    expect(getCustomerLedger(db, c.id).some((e) => e.kind === "credit")).toBe(false);
  });

  it("refuses double voids, unknown bills and a missing/oversized reason, without changing anything", () => {
    const { db, p, b } = shop();
    const { invoice } = sell(db, { items: [line(p.id, 1_000)] });
    expect(() => voidInvoice(db, invoice.id, ADMIN, "   ", NOW)).toThrowError(/reason/i);
    expect(() => voidInvoice(db, invoice.id, ADMIN, "x".repeat(201), NOW)).toThrowError(/too long/i);
    expect(batchQty(db, b.id)).toBe(99_000);
    voidInvoice(db, invoice.id, ADMIN, "ok", NOW);
    expect(() => voidInvoice(db, invoice.id, ADMIN, "again", NOW)).toThrowError(/already void/);
    expect(batchQty(db, b.id)).toBe(100_000); // not restored twice
    expect(() => voidInvoice(db, 9999, ADMIN, "x", NOW)).toThrowError(/not found/i);
  });

  it("warns when a sold product has been archived since (stock returns to a hidden product)", () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Retired", unitType: "pcs" });
    const b = stock(db, p.id, { batch: "A", qtyMilli: 2_000 });
    const { invoice } = sell(db, { items: [line(p.id, 2_000)] });
    archiveProduct(db, p.id, NOW);
    const sum = voidInvoice(db, invoice.id, ADMIN, "returned", NOW);
    expect(sum.archivedProducts).toEqual(["Retired"]);
    expect(batchQty(db, b.id)).toBe(2_000);
    expect(allBatchesConsistent(db)).toBe(true);
  });

  it("records the audit entry with who did it, and links a real user id", () => {
    const { db, p } = shop();
    const admin = createFirstAdmin(db, { username: "owner", displayName: "Owner", pin: "1234" });
    const { invoice } = sell(db, { items: [line(p.id, 1_000)] });
    voidInvoice(db, invoice.id, { id: admin.id, name: "Owner" }, "customer changed mind", NOW);
    const [e] = listAudit(db, { action: "sale.void" });
    expect(e).toMatchObject({ userId: admin.id, username: "Owner", entityType: "invoice", entityId: invoice.id });
    expect(e!.summary).toContain(invoice.invoiceNumber);
    expect(e!.summary).toContain("customer changed mind");
    expect(db.select().from(invoices).where(eq(invoices.id, invoice.id)).get()!.voidedBy).toBe(admin.id);
  });

  it("keeps invoice numbers unique after voids (a void never frees a number)", () => {
    const { db, p } = shop();
    const nums = [1, 2].map(() => sell(db, { items: [line(p.id, 1_000)] }).invoice);
    voidInvoice(db, nums[0]!.id, ADMIN, "x", NOW);
    const next = sell(db, { items: [line(p.id, 1_000)] }).invoice;
    expect([...nums.map((n) => n.invoiceNumber), next.invoiceNumber]).toEqual(["INV-20261121-0001", "INV-20261121-0002", "INV-20261121-0003"]);
  });
});

describe("amendInvoice", () => {
  it("replaces a bill: new quantities, linked and numbered -A1, original voided, stock correct", () => {
    const { db, p, b } = shop();
    const other = newProduct(db, { name: "Gadget", unitType: "pcs" });
    const ob = stock(db, other.id, { batch: "G", qtyMilli: 10_000, sell: 5_000 });
    const orig = sell(db, { items: [line(p.id, 5_000), line(other.id, 1_000)] }, { id: null, name: "Ravi" });
    expect([batchQty(db, b.id), batchQty(db, ob.id)]).toEqual([95_000, 9_000]);

    const res = amendInvoice(db, orig.invoice.id, { items: [line(p.id, 2_000), line(other.id, 3_000)], paymentMode: "cash" }, ADMIN, "wrong quantities", NOW);
    const nu = res.replacement.invoice;
    expect(nu).toMatchObject({ invoiceNumber: `${orig.invoice.invoiceNumber}-A1`, replacesInvoiceId: orig.invoice.id, status: "paid", grandTotal: 2 * 10_000 + 3 * 5_000 });
    expect(db.select().from(invoices).where(eq(invoices.id, orig.invoice.id)).get()!).toMatchObject({ status: "void" });
    expect(db.select().from(invoices).where(eq(invoices.id, orig.invoice.id)).get()!.voidReason).toContain("Amended to " + nu.invoiceNumber);
    expect([batchQty(db, b.id), batchQty(db, ob.id)]).toEqual([98_000, 7_000]); // only the NEW quantities are out
    expect(allBatchesConsistent(db)).toBe(true);
    const rel = getInvoiceRelations(db, orig.invoice.id);
    expect(rel.replacedBy?.id).toBe(nu.id);
    expect(getInvoiceRelations(db, nu.id).replaces?.id).toBe(orig.invoice.id);
  });

  it("keeps the original date and biller, so reports stay on the right day and person", () => {
    const { db, p } = shop();
    const orig = sell(db, { items: [line(p.id, 1_000)] }, { id: null, name: "Ravi" });
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    const { replacement } = amendInvoice(db, orig.invoice.id, { items: [line(p.id, 2_000)], paymentMode: "cash" }, ADMIN, "fix", later);
    expect(replacement.invoice.createdAt).toBe(orig.invoice.createdAt);
    expect(replacement.invoice.createdByName).toBe("Ravi");
    expect(getSalesReport(db, "2026-11-21", "2026-11-21")).toMatchObject({ invoiceCount: 1, netSales: 20_000 });
    expect(getSalesReport(db, "2026-11-24", "2026-11-24").invoiceCount).toBe(0);
    const moves = db.select().from(stockMovements).where(eq(stockMovements.referenceId, replacement.invoice.id)).all();
    expect(moves.every((m) => m.createdAt === later.toISOString())).toBe(true); // the ledger records when it really happened
  });

  it("numbers repeated amendments -A1, -A2 off the original number", () => {
    const { db, p } = shop();
    const a0 = sell(db, { items: [line(p.id, 1_000)] }).invoice;
    const a1 = amendInvoice(db, a0.id, { items: [line(p.id, 2_000)], paymentMode: "cash" }, ADMIN, "1", NOW).replacement.invoice;
    const a2 = amendInvoice(db, a1.id, { items: [line(p.id, 3_000)], paymentMode: "cash" }, ADMIN, "2", NOW).replacement.invoice;
    expect([a1.invoiceNumber, a2.invoiceNumber]).toEqual([`${a0.invoiceNumber}-A1`, `${a0.invoiceNumber}-A2`]);
    expect(a2.grandTotal).toBe(30_000);
  });

  it("can add and remove lines, change discounts and switch to credit with a customer", () => {
    const { db, p } = shop();
    const g = newProduct(db, { name: "Gadget", unitType: "pcs", gstRate: 12 });
    stock(db, g.id, { batch: "G", qtyMilli: 10_000, sell: 11_200 });
    const c = createCustomer(db, { name: "Credit Cust" });
    const orig = sell(db, { items: [line(p.id, 2_000)] });
    const { replacement } = amendInvoice(
      db, orig.invoice.id,
      { items: [line(g.id, 1_000, { discountType: "percent", discountValue: 1_000 })], paymentMode: "credit", customerId: c.id },
      ADMIN, "wrong item", NOW,
    );
    expect(replacement.items.map((i) => i.productName)).toEqual(["Gadget"]);
    expect(replacement.invoice).toMatchObject({ paymentMode: "credit", customerId: c.id, creditAmount: replacement.invoice.grandTotal });
    for (const i of replacement.items) expect(i.taxableAmount + i.taxAmount).toBe(i.lineTotal);
    expect(balanceOf(db, c.id)).toBe(replacement.invoice.grandTotal);
  });

  it("changes NOTHING when the corrected bill can't be made (not enough stock, expired batch, bad payment)", () => {
    const { db, p, b } = shop();
    const dead = newProduct(db, { name: "Dead", unitType: "pcs" });
    stockExpired(db, dead.id, "OLD", "2026-01-01", 5_000);
    const orig = sell(db, { items: [line(p.id, 5_000)] });
    const snapshot = () => JSON.stringify([db.select().from(batches).all(), db.select().from(invoices).all().length, db.select().from(stockMovements).all().length, db.select().from(auditLog).all().length]);
    const before = snapshot();

    expect(() => amendInvoice(db, orig.invoice.id, { items: [line(p.id, 999_000)], paymentMode: "cash" }, ADMIN, "x", NOW)).toThrowError(/available|stock/i);
    expect(() => amendInvoice(db, orig.invoice.id, { items: [line(dead.id, 1_000)], paymentMode: "cash" }, ADMIN, "x", NOW)).toThrowError(/expired/i);
    expect(() => amendInvoice(db, orig.invoice.id, { items: [line(p.id, 1_000)], paymentMode: "credit" }, ADMIN, "x", NOW)).toThrowError(/customer/i);
    expect(() => amendInvoice(db, orig.invoice.id, { items: [line(p.id, 1_000)], paymentMode: "cash" }, ADMIN, "  ", NOW)).toThrowError(/reason/i);
    expect(snapshot()).toBe(before);
    expect(db.select().from(invoices).where(eq(invoices.id, orig.invoice.id)).get()!.status).toBe("paid");
    expect(batchQty(db, b.id)).toBe(95_000);
  });

  it("refuses to amend a void bill (or one already amended) and records the amendment in the audit log", () => {
    const { db, p } = shop();
    const a = sell(db, { items: [line(p.id, 1_000)] }).invoice;
    const fixed = amendInvoice(db, a.id, { items: [line(p.id, 2_000)], paymentMode: "cash" }, ADMIN, "qty", NOW).replacement.invoice;
    expect(() => amendInvoice(db, a.id, { items: [line(p.id, 1_000)], paymentMode: "cash" }, ADMIN, "again", NOW)).toThrowError(/already void/);
    const gone = sell(db, { items: [line(p.id, 1_000)] }).invoice;
    voidInvoice(db, gone.id, ADMIN, "x", NOW);
    expect(() => amendInvoice(db, gone.id, { items: [line(p.id, 1_000)], paymentMode: "cash" }, ADMIN, "x", NOW)).toThrowError(/already void/);
    const [e] = listAudit(db, { action: "sale.amend" });
    expect(e).toMatchObject({ entityId: fixed.id, username: "Admin" });
    expect(e!.summary).toContain(`${a.invoiceNumber} (`);
    expect(e!.summary).toContain(fixed.invoiceNumber);
  });
});

describe("updateInvoiceDetails", () => {
  it("edits notes, customer and payment without touching stock or totals, and audits old -> new", () => {
    const { db, p, b } = shop();
    const c = createCustomer(db, { name: "Lakshmi" });
    const { invoice } = sell(db, { items: [line(p.id, 3_000)], paymentMode: "cash" });
    const r = updateInvoiceDetails(db, invoice.id, { paymentMode: "split", customerId: c.id, notes: "pays rest Friday", split: { cash: 10_000, credit: 20_000 } }, ADMIN, NOW);
    expect(r.changed).toBe(true);
    expect(r.invoice).toMatchObject({ grandTotal: 30_000, paymentMode: "split", cashAmount: 10_000, creditAmount: 20_000, customerId: c.id, customerName: "Lakshmi", notes: "pays rest Friday" });
    expect(batchQty(db, b.id)).toBe(97_000);
    expect(balanceOf(db, c.id)).toBe(20_000);
    const [e] = listAudit(db, { action: "sale.edit" });
    expect(e!.summary).toMatch(/customer none -> Lakshmi/);
    expect(e!.summary).toMatch(/payment cash .* -> split/);
    expect(e!.summary).toMatch(/notes/);
  });

  it("enforces the payment rules: amounts add up, credit needs a customer", () => {
    const { db, p } = shop();
    const { invoice } = sell(db, { items: [line(p.id, 2_000)] });
    expect(() => updateInvoiceDetails(db, invoice.id, { paymentMode: "split", split: { cash: 5_000, upi: 5_000 } }, ADMIN, NOW)).toThrowError(/add up/i);
    expect(() => updateInvoiceDetails(db, invoice.id, { paymentMode: "credit" }, ADMIN, NOW)).toThrowError(/customer/i);
    expect(() => updateInvoiceDetails(db, invoice.id, { paymentMode: "cash", customerId: 999 }, ADMIN, NOW)).toThrowError(/not found/i);
    expect(db.select().from(invoices).where(eq(invoices.id, invoice.id)).get()).toMatchObject({ paymentMode: "cash", cashAmount: 20_000 });
  });

  it("moves dues when the customer on a credit bill is changed", () => {
    const { db, p } = shop();
    const a = createCustomer(db, { name: "Wrong" });
    const b = createCustomer(db, { name: "Right" });
    const { invoice } = sell(db, { items: [line(p.id, 2_000)], paymentMode: "credit", customerId: a.id });
    expect([balanceOf(db, a.id), balanceOf(db, b.id)]).toEqual([20_000, 0]);
    updateInvoiceDetails(db, invoice.id, { paymentMode: "credit", customerId: b.id }, ADMIN, NOW);
    expect([balanceOf(db, a.id), balanceOf(db, b.id)]).toEqual([0, 20_000]);
  });

  it("is a no-op (no audit row) when nothing changed, and refuses void bills", () => {
    const { db, p } = shop();
    const { invoice } = sell(db, { items: [line(p.id, 1_000)] });
    expect(updateInvoiceDetails(db, invoice.id, { paymentMode: "cash" }, ADMIN, NOW).changed).toBe(false);
    expect(listAudit(db, { action: "sale.edit" })).toHaveLength(0);
    voidInvoice(db, invoice.id, ADMIN, "x", NOW);
    expect(() => updateInvoiceDetails(db, invoice.id, { paymentMode: "upi" }, ADMIN, NOW)).toThrowError(/already void/);
  });
});

describe("voidPayment", () => {
  it("reverses a wrong dues payment: balance goes back up; the record is kept and flagged", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Cust" });
    sell(db, { items: [line(p.id, 5_000)], paymentMode: "credit", customerId: c.id });
    const pay = recordPayment(db, c.id, 20_000, "cash", null, NOW);
    expect(balanceOf(db, c.id)).toBe(30_000);
    voidPayment(db, pay.id, ADMIN, "typed the wrong customer", NOW);
    expect(balanceOf(db, c.id)).toBe(50_000);
    const row = db.select().from(payments).where(eq(payments.id, pay.id)).get()!;
    expect(row).toMatchObject({ status: "void", voidReason: "typed the wrong customer", voidedByName: "Admin" });
    const led = getCustomerLedger(db, c.id);
    const entry = led.find((e) => e.paymentId === pay.id)!;
    expect(entry).toMatchObject({ voided: true, voidReason: "typed the wrong customer" });
    expect(led.at(-1)!.balanceAfter).toBe(50_000); // a void entry doesn't move the running balance
    expect(listAudit(db, { action: "payment.void" })).toHaveLength(1);
  });

  it("drops it from 'dues collected', and rejects double voids, missing reasons and unknown ids", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Cust" });
    sell(db, { items: [line(p.id, 5_000)] , paymentMode: "credit", customerId: c.id });
    const pay = recordPayment(db, c.id, 20_000, "upi", null, NOW);
    expect(getSalesReport(db, "2026-11-21", "2026-11-21").duesCollected.total).toBe(20_000);
    expect(() => voidPayment(db, pay.id, ADMIN, "", NOW)).toThrowError(/reason/i);
    voidPayment(db, pay.id, ADMIN, "oops", NOW);
    expect(getSalesReport(db, "2026-11-21", "2026-11-21").duesCollected.total).toBe(0);
    expect(() => voidPayment(db, pay.id, ADMIN, "again", NOW)).toThrowError(/already voided/);
    expect(() => voidPayment(db, 999, ADMIN, "x", NOW)).toThrowError(/not found/i);
    // the customer can now be recorded as paying again (an over-payment check still uses the live balance)
    expect(recordPayment(db, c.id, 50_000, "cash", null, NOW).amount).toBe(50_000);
  });
});

describe("amend editor support", () => {
  const item = (o: Partial<InvoiceItem>): InvoiceItem => ({ id: 1, invoiceId: 1, productId: 1, batchId: 1, productName: "P", batchNumber: "B", unitType: "pcs", quantity: 1_000, unitPrice: 100, purchasePrice: 50, discountType: "none", discountValue: 0, discountAmount: 0, gstRate: 0, taxableAmount: 100, taxAmount: 0, lineTotal: 100, ...o });

  it("rebuilds one editable line per product and re-derives the discount mode", () => {
    expect(seedLinesFromItems([item({ quantity: 1_000 }), item({ id: 2, batchId: 2, quantity: 2_000 })])).toEqual([{ productId: 1, quantity: 3_000, discountType: "none", discountValue: 0, auto: false }]);
    expect(seedLinesFromItems([item({ discountType: "percent", discountValue: 1_000 }), item({ id: 2, batchId: 2, discountType: "percent", discountValue: 1_000 })])[0]).toMatchObject({ discountType: "percent", discountValue: 1_000, auto: false });
    expect(seedLinesFromItems([item({ discountType: "flat", discountValue: 300 }), item({ id: 2, batchId: 2, discountType: "flat", discountValue: 200 })])[0]).toMatchObject({ discountType: "flat", discountValue: 500, auto: false });
    expect(seedLinesFromItems([item({ discountType: "percent", discountValue: 1_000 }), item({ id: 2, batchId: 2, discountType: "none" })])[0]).toMatchObject({ discountType: "none", auto: true }); // per-batch markdown
    expect(seedLinesFromItems([item({ productId: 1 }), item({ id: 2, productId: 2 })]).map((l) => l.productId)).toEqual([1, 2]);
  });

  it("previews stock as if the bill were voided, without writing anything", () => {
    const { db, p, b } = shop();
    const { invoice } = sell(db, { items: [line(p.id, 100_000)] }); // sells everything
    expect(batchQty(db, b.id)).toBe(0);
    const [ps] = stockAsIfVoided(db, invoice.id, NOW);
    expect(ps!.sellableQty).toBe(100_000);
    expect(ps!.sellableBatches.map((x) => [x.batchNumber, x.quantityAvailable])).toEqual([["A", 100_000]]);
    expect(batchQty(db, b.id)).toBe(0); // untouched
    expect(db.select().from(stockMovements).all().filter((m) => m.type === "return")).toHaveLength(0);
  });
});

describe("audit trail covers every operation", () => {
  it("leaves one entry per void / amend / edit / payment void, in order", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "C" });
    const a = sell(db, { items: [line(p.id, 1_000)] }).invoice;
    const b = sell(db, { items: [line(p.id, 1_000)], paymentMode: "credit", customerId: c.id }).invoice;
    const d = sell(db, { items: [line(p.id, 1_000)] }).invoice;
    const pay = recordPayment(db, c.id, 5_000, "cash", null, NOW);
    updateInvoiceDetails(db, a.id, { paymentMode: "upi" }, ADMIN, NOW);
    amendInvoice(db, b.id, { items: [line(p.id, 2_000)], paymentMode: "credit", customerId: c.id }, ADMIN, "qty", NOW);
    voidInvoice(db, d.id, ADMIN, "dup", NOW);
    voidPayment(db, pay.id, ADMIN, "oops", NOW);
    expect(listAudit(db).map((e) => e.action).reverse()).toEqual(["sale.edit", "sale.amend", "sale.void", "payment.void"]);
    expect(listAudit(db).every((e) => e.username === "Admin")).toBe(true);
  });

  it("with accounts off (no actor), actions are still recorded and attributed to '(no accounts)'", () => {
    const { db, p } = shop();
    const { invoice } = sell(db, { items: [line(p.id, 1_000)] });
    voidInvoice(db, invoice.id, null, "x", NOW);
    expect(listAudit(db)[0]).toMatchObject({ username: "(no accounts)", userId: null });
  });
});

describe("pricing rules untouched by void/amend", () => {
  it("amending a bill keeps near-expiry markdown working per batch", () => {
    const db = makeDb();
    db.insert(pricingRules).values({ name: "30d", minDaysToExpiry: 0, maxDaysToExpiry: 30, discountPercent: 1_000 }).run();
    const p = newProduct(db, { unitType: "pcs" });
    stock(db, p.id, { batch: "NEAR", expiry: "2026-12-11", qtyMilli: 2_000, sell: 10_000 });
    stock(db, p.id, { batch: "FAR", expiry: "2027-11-01", qtyMilli: 9_000, sell: 10_000 });
    const orig = sell(db, { items: [line(p.id, 1_000)] });
    const { replacement } = amendInvoice(db, orig.invoice.id, { items: [line(p.id, 3_000, { applyMarkdown: true })], paymentMode: "cash" }, ADMIN, "mk", NOW);
    expect(replacement.items.find((i) => i.batchNumber === "NEAR")).toMatchObject({ discountType: "percent", discountAmount: 2_000 });
    expect(replacement.items.find((i) => i.batchNumber === "FAR")!.discountAmount).toBe(0);
    expect(allBatchesConsistent(db)).toBe(true);
  });
});
