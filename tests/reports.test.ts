import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRange } from "@/app/(app)/reports/range";
import { invoiceItems, invoices } from "@/db/schema";
import { createInvoice } from "@/services/billing";
import { estimateProfit } from "@/services/dashboard";
import { buildCsv, getSalesReport } from "@/services/reports";
import { makeDb, newProduct, stock, stockExpired } from "./helpers";

const db = makeDb();
let A = 0, B = 0, C = 0;
const FROM = "2026-11-20";
const TO = "2026-11-22";

const sellAt = (when: Date, items: Parameters<typeof createInvoice>[1]["items"], extra: Record<string, unknown> = {}) =>
  createInvoice(db, { items, paymentMode: "cash", ...extra }, when);

beforeAll(() => {
  const a = newProduct(db, { name: "Paracetamol", unitType: "strip", gstRate: 12, hsnCode: "3004" });
  const b = newProduct(db, { name: "Sugar, loose", unitType: "kg", allowDecimalQty: true, gstRate: 5 });
  const c = newProduct(db, { name: "=EVIL() Salt", unitType: "pcs", gstRate: 0 });
  A = a.id; B = b.id; C = c.id;
  stock(db, A, { batch: "A1", qtyMilli: 100_000, sell: 1_833, cost: 1_000 });
  stock(db, B, { batch: "B1", qtyMilli: 50_000, sell: 4_600, cost: 3_500 });
  stock(db, C, { batch: "C1", qtyMilli: 100_000, sell: 2_750, cost: 2_000 });
  stockExpired(db, C, "C-OLD", "2026-01-01", 3_000);

  sellAt(new Date(2026, 10, 19, 23, 55), [{ productId: A, quantity: 1_000 }]); // day before: excluded
  sellAt(new Date(2026, 10, 20, 0, 5), [{ productId: A, quantity: 2_000 }]); // first minute of range: included
  sellAt(
    new Date(2026, 10, 21, 12, 0),
    [{ productId: B, quantity: 1_500 }, { productId: C, quantity: 1_000, discountType: "flat", discountValue: 333 }],
    { paymentMode: "upi", customerName: 'Ravi, "K"' },
  );
  const voided = sellAt(new Date(2026, 10, 21, 13, 0), [{ productId: A, quantity: 5_000 }]);
  db.update(invoices).set({ status: "void" }).where(eq(invoices.id, voided.invoice.id)).run();
  sellAt(new Date(2026, 10, 22, 23, 55), [{ productId: A, quantity: 1_000 }, { productId: C, quantity: 2_000 }], { paymentMode: "card" }); // last minute: included
  sellAt(new Date(2026, 10, 23, 0, 5), [{ productId: C, quantity: 1_000 }]); // day after: excluded
});

describe("getSalesReport", () => {
  const r = () => getSalesReport(db, FROM, TO);
  const included = () => db.select().from(invoices).where(eq(invoices.status, "paid")).all().filter((i) => {
    const d = new Date(i.createdAt);
    return d >= new Date(2026, 10, 20) && d < new Date(2026, 10, 23);
  });

  it("includes both range edges, excludes outside days and void invoices", () => {
    expect(r().invoiceCount).toBe(3);
    expect(r().daily.map((d) => [d.date, d.invoices])).toEqual([["2026-11-20", 1], ["2026-11-21", 1], ["2026-11-22", 1]]);
  });

  it("net sales equals the sum of invoice grand totals", () => {
    expect(r().netSales).toBe(included().reduce((s, i) => s + i.grandTotal, 0));
    expect(r().daily.reduce((s, d) => s + d.total, 0)).toBe(r().netSales);
  });

  it("reconciles: subtotal − discount + round-off = net; taxable + tax = subtotal − discount", () => {
    const x = r();
    expect(x.subtotal - x.discountTotal + x.roundOff).toBe(x.netSales);
    expect(x.taxableTotal + x.taxTotal).toBe(x.subtotal - x.discountTotal);
    expect(x.discountTotal).toBe(333);
  });

  it("slab rows sum to the totals and CGST + SGST = tax", () => {
    const x = r();
    expect(x.gstSlabs.map((s) => s.rate)).toEqual([0, 5, 12]);
    expect(x.gstSlabs.reduce((s, v) => s + v.taxable, 0)).toBe(x.taxableTotal);
    expect(x.gstSlabs.reduce((s, v) => s + v.tax, 0)).toBe(x.taxTotal);
    expect(x.cgst + x.sgst).toBe(x.taxTotal);
    for (const s of x.gstSlabs) expect(s.cgst + s.sgst).toBe(s.tax);
  });

  it("payment modes add up to net sales", () => {
    const x = r();
    expect(x.payments.cash + x.payments.upi + x.payments.card).toBe(x.netSales);
    expect(x.payments.upi).toBeGreaterThan(0);
    expect(x.payments.card).toBeGreaterThan(0);
  });

  it("profit estimate matches estimateProfit over the included items", () => {
    const ids = included().map((i) => i.id);
    const items = db.select().from(invoiceItems).where(inArray(invoiceItems.invoiceId, ids)).all();
    expect(r().profitEstimate).toBe(estimateProfit(items));
  });

  it("ranks top products by revenue with quantities", () => {
    const x = r();
    const revenue = x.topProducts.map((p) => p.revenue);
    expect([...revenue].sort((a, b) => b - a)).toEqual(revenue);
    const sugar = x.topProducts.find((p) => p.productId === B)!;
    expect(sugar).toMatchObject({ quantity: 1_500, revenue: 6_900 });
    expect(x.topProducts.find((p) => p.productId === A)!.quantity).toBe(3_000);
  });

  it("returns zeros for an empty range", () => {
    const e = getSalesReport(db, "2026-01-01", "2026-01-02");
    expect(e).toMatchObject({ invoiceCount: 0, netSales: 0, taxTotal: 0, profitEstimate: 0, gstSlabs: [], daily: [], topProducts: [] });
  });
});

describe("CSV exports", () => {
  const rowsOf = (csv: string) => csv.replace(/^﻿/, "").trimEnd().split("\r\n");

  it("sales CSV has one row per paid invoice and its totals reconcile with the report", () => {
    const { csv, filename } = buildCsv(db, "sales", FROM, TO);
    const rows = rowsOf(csv);
    expect(filename).toBe(`sales-${FROM}_to_${TO}.csv`);
    expect(rows).toHaveLength(1 + 3);
    const totalCents = rows.slice(1).reduce((s, line) => s + Math.round(Number(line.split(",").at(-1)) * 100), 0);
    expect(totalCents).toBe(getSalesReport(db, FROM, TO).netSales);
    expect(csv).toContain('"Ravi, ""K"""'); // quoted customer name
  });

  it("items CSV lists every line with HSN and guards formula-looking product names", () => {
    const csv = buildCsv(db, "items", FROM, TO).csv;
    expect(rowsOf(csv)).toHaveLength(1 + 5);
    expect(csv).toContain(",3004,"); // HSN for Paracetamol
    expect(csv).toContain("'=EVIL() Salt");
    expect(csv).not.toMatch(/,=EVIL/);
  });

  it("GST CSV ends with a total row matching the report", () => {
    const rows = rowsOf(buildCsv(db, "gst", FROM, TO).csv);
    const r = getSalesReport(db, FROM, TO);
    expect(rows.at(-1)).toBe(`Total,${(r.taxableTotal / 100).toFixed(2)},${(r.cgst / 100).toFixed(2)},${(r.sgst / 100).toFixed(2)},${(r.taxTotal / 100).toFixed(2)}`);
  });

  it("stock CSV flags expired batches and only lists batches with stock", () => {
    const csv = buildCsv(db, "stock", FROM, TO, new Date(2026, 10, 21, 12)).csv;
    expect(csv).toContain("C-OLD");
    expect(rowsOf(csv).filter((l) => l.endsWith(",EXPIRED"))).toHaveLength(1);
    expect(csv).toContain("A1");
  });
});

describe("parseRange", () => {
  const now = new Date(2026, 10, 21, 12);
  it("defaults to month-to-date", () => {
    expect(parseRange(null, null, now)).toEqual({ from: "2026-11-01", to: "2026-11-21" });
  });
  it("ignores invalid dates and swaps a reversed range", () => {
    expect(parseRange("nope", "2026-13-45", now)).toEqual({ from: "2026-11-01", to: "2026-11-21" });
    expect(parseRange("2026-11-10", "2026-11-02", now)).toEqual({ from: "2026-11-02", to: "2026-11-10" });
  });
  it("caps very long ranges at about two years", () => {
    const r = parseRange("2000-01-01", "2026-11-21", now);
    expect(r.to).toBe("2026-11-21");
    expect(r.from > "2024-01-01").toBe(true);
  });
});
