import { and, asc, eq, gt, gte, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { batches, invoiceItems, invoices, payments, products } from "@/db/schema";
import { isExpired, localDateTime, rangeBounds, todayISO } from "@/lib/dates";
import { type Cell, num, toCsv } from "@/lib/csv";
import { splitGst } from "@/lib/gst";
import { divRound, paiseToDecimal } from "@/lib/money";
import { formatQty, MILLI } from "@/lib/qty";
import { estimateProfit } from "./dashboard";
import { getCustomer, getCustomerLedger, listCustomersWithBalance } from "./customers";
import { ServiceError } from "./types";

export interface SlabRow {
  rate: number;
  taxable: number;
  tax: number;
  cgst: number;
  sgst: number;
}

export interface SalesReport {
  from: string;
  to: string;
  invoiceCount: number;
  /** GST-inclusive, before discounts */
  subtotal: number;
  discountTotal: number;
  taxableTotal: number;
  taxTotal: number;
  /** Sum of per-slab CGST/SGST halves (so it reconciles with `gstSlabs`). */
  cgst: number;
  sgst: number;
  roundOff: number;
  /** Sum of invoice grand totals (what customers paid). */
  netSales: number;
  /** How this period's bills were settled; credit = put on customers' accounts (cash + upi + card + credit = net sales). */
  payments: { cash: number; upi: number; card: number; credit: number };
  /** Money received from customers against dues in this period (separate from sales, for the cash drawer). */
  duesCollected: { cash: number; upi: number; card: number; total: number };
  profitEstimate: number;
  gstSlabs: SlabRow[];
  daily: { date: string; invoices: number; total: number }[];
  topProducts: { productId: number; name: string; quantity: number; revenue: number }[];
}

/** Paid (non-void) invoices for local days `from`..`to` inclusive. */
function loadRange(db: Db, from: string, to: string) {
  const { start, end } = rangeBounds(from, to);
  const inRange = and(eq(invoices.status, "paid"), gte(invoices.createdAt, start), lt(invoices.createdAt, end));
  const inv = db.select().from(invoices).where(inRange).orderBy(asc(invoices.id)).all();
  const items = db
    .select({ item: invoiceItems, invoiceNumber: invoices.invoiceNumber, createdAt: invoices.createdAt, hsn: products.hsnCode })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .innerJoin(products, eq(products.id, invoiceItems.productId))
    .where(inRange)
    .orderBy(asc(invoiceItems.id))
    .all();
  return { inv, items };
}

export function getSalesReport(db: Db, from: string, to: string): SalesReport {
  const { inv, items } = loadRange(db, from, to);
  const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
  const { start: rangeStart, end: rangeEnd } = rangeBounds(from, to);
  const dues = db
    .select()
    .from(payments)
    .where(and(gte(payments.createdAt, rangeStart), lt(payments.createdAt, rangeEnd)))
    .all();
  const duesBy = (mode: "cash" | "upi" | "card") => sum(dues.filter((p) => p.mode === mode), (p) => p.amount);

  const slabMap = new Map<number, { taxable: number; tax: number }>();
  for (const { item } of items) {
    const cur = slabMap.get(item.gstRate) ?? { taxable: 0, tax: 0 };
    slabMap.set(item.gstRate, { taxable: cur.taxable + item.taxableAmount, tax: cur.tax + item.taxAmount });
  }
  const gstSlabs: SlabRow[] = [...slabMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, v]) => ({ rate, ...v, ...splitGst(v.tax) }));

  const dayMap = new Map<string, { invoices: number; total: number }>();
  for (const i of inv) {
    const d = todayISO(new Date(i.createdAt));
    const cur = dayMap.get(d) ?? { invoices: 0, total: 0 };
    dayMap.set(d, { invoices: cur.invoices + 1, total: cur.total + i.grandTotal });
  }

  const prodMap = new Map<number, { name: string; quantity: number; revenue: number }>();
  for (const { item } of items) {
    const cur = prodMap.get(item.productId) ?? { name: item.productName, quantity: 0, revenue: 0 };
    prodMap.set(item.productId, { name: cur.name, quantity: cur.quantity + item.quantity, revenue: cur.revenue + item.lineTotal });
  }

  return {
    from,
    to,
    invoiceCount: inv.length,
    subtotal: sum(inv, (i) => i.subtotal),
    discountTotal: sum(inv, (i) => i.discountTotal),
    taxableTotal: sum(gstSlabs, (s) => s.taxable),
    taxTotal: sum(gstSlabs, (s) => s.tax),
    cgst: sum(gstSlabs, (s) => s.cgst),
    sgst: sum(gstSlabs, (s) => s.sgst),
    roundOff: sum(inv, (i) => i.roundOff),
    netSales: sum(inv, (i) => i.grandTotal),
    payments: {
      cash: sum(inv, (i) => i.cashAmount),
      upi: sum(inv, (i) => i.upiAmount),
      card: sum(inv, (i) => i.cardAmount),
      credit: sum(inv, (i) => i.creditAmount),
    },
    duesCollected: { cash: duesBy("cash"), upi: duesBy("upi"), card: duesBy("card"), total: sum(dues, (p) => p.amount) },
    profitEstimate: estimateProfit(items.map(({ item }) => item)),
    gstSlabs,
    daily: [...dayMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, ...v })),
    topProducts: [...prodMap.entries()]
      .map(([productId, v]) => ({ productId, ...v }))
      .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name))
      .slice(0, 10),
  };
}

/* ---------------- CSV exports ---------------- */

export const EXPORT_TYPES = ["sales", "items", "gst", "stock", "dues", "ledger"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

const money = (p: number) => num(paiseToDecimal(p));

export function buildCsv(
  db: Db,
  type: ExportType,
  from: string,
  to: string,
  now: Date = new Date(),
  customerId?: number,
): { filename: string; csv: string } {
  const range = from === to ? from : `${from}_to_${to}`;

  if (type === "sales") {
    const { inv } = loadRange(db, from, to);
    const header = ["Invoice", "Date", "Customer", "Phone", "Payment", "Subtotal", "Discount", "Taxable", "CGST", "SGST", "Round off", "Credit", "Total"];
    const rows: Cell[][] = inv.map((i) => {
      const { cgst, sgst } = splitGst(i.taxTotal);
      const taxable = i.subtotal - i.discountTotal - i.taxTotal;
      return [i.invoiceNumber, localDateTime(i.createdAt), i.customerName, i.customerPhone, i.paymentMode,
        money(i.subtotal), money(i.discountTotal), money(taxable), money(cgst), money(sgst), money(i.roundOff), money(i.creditAmount), money(i.grandTotal)];
    });
    return { filename: `sales-${range}.csv`, csv: toCsv(header, rows) };
  }

  if (type === "items") {
    const { items } = loadRange(db, from, to);
    const header = ["Invoice", "Date", "Product", "HSN", "Batch", "Qty", "Unit", "Rate", "Discount", "GST %", "Taxable", "Tax", "Line total"];
    const rows: Cell[][] = items.map(({ item, invoiceNumber, createdAt, hsn }) => [
      invoiceNumber, localDateTime(createdAt), item.productName, hsn, item.batchNumber, num(formatQty(item.quantity)), item.unitType,
      money(item.unitPrice), money(item.discountAmount), item.gstRate, money(item.taxableAmount), money(item.taxAmount), money(item.lineTotal),
    ]);
    return { filename: `items-${range}.csv`, csv: toCsv(header, rows) };
  }

  if (type === "gst") {
    const r = getSalesReport(db, from, to);
    const header = ["GST %", "Taxable value", "CGST", "SGST", "Total tax"];
    const rows: Cell[][] = r.gstSlabs.map((s) => [s.rate, money(s.taxable), money(s.cgst), money(s.sgst), money(s.tax)]);
    rows.push(["Total", money(r.taxableTotal), money(r.cgst), money(r.sgst), money(r.taxTotal)]);
    return { filename: `gst-${range}.csv`, csv: toCsv(header, rows) };
  }

  if (type === "dues") {
    const owing = listCustomersWithBalance(db).filter((r) => r.balance > 0);
    const rows: Cell[][] = owing.map((r) => [r.customer.name, r.customer.phone, money(r.balance)]);
    rows.push(["Total", null, money(owing.reduce((s, r) => s + r.balance, 0))]);
    return { filename: `dues-${todayISO(now)}.csv`, csv: toCsv(["Customer", "Phone", "Balance due"], rows) };
  }

  if (type === "ledger") {
    const customer = customerId === undefined ? undefined : getCustomer(db, customerId);
    if (!customer) throw new ServiceError("NOT_FOUND", "Customer not found");
    const rows: Cell[][] = getCustomerLedger(db, customer.id).map((e) => [
      localDateTime(e.at),
      e.kind === "credit" ? "Credit given" : "Payment received",
      e.label,
      e.kind === "credit" ? money(e.amount) : null,
      e.kind === "payment" ? money(e.amount) : null,
      money(e.balanceAfter),
    ]);
    const slug = customer.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "customer";
    return { filename: `ledger-${slug}.csv`, csv: toCsv(["Date", "Type", "Details", "Credit given", "Payment received", "Balance"], rows) };
  }

  // stock: current batches with stock (not date-ranged)
  const today = todayISO(now);
  const rows: Cell[][] = db
    .select({ batch: batches, product: products })
    .from(batches)
    .innerJoin(products, eq(products.id, batches.productId))
    .where(gt(batches.quantityAvailable, 0))
    .orderBy(asc(products.name), asc(batches.expiryDate))
    .all()
    .map(({ batch: b, product: p }) => [
      p.name, p.sku, b.batchNumber, b.expiryDate, num(formatQty(b.quantityAvailable)), p.unitType,
      money(divRound(b.purchasePrice * b.quantityAvailable, MILLI)),
      money(divRound(b.mrp * b.quantityAvailable, MILLI)),
      isExpired(b.expiryDate, today) ? "EXPIRED" : "ok",
    ]);
  return {
    filename: `stock-${today}.csv`,
    csv: toCsv(["Product", "SKU", "Batch", "Expiry", "Qty", "Unit", "Cost value", "MRP value", "Status"], rows),
  };
}
