import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { invoiceItems, invoices } from "@/db/schema";
import { rangeBounds, todayISO } from "@/lib/dates";
import { divRound } from "@/lib/money";
import { MILLI } from "@/lib/qty";
import { getExpiringBatches, getLowStock } from "./inventory";
import { getSettings } from "./settings";

export interface DashboardStats {
  todaySales: number;
  todayInvoices: number;
  /** Estimated profit in paise (see estimateProfit). */
  profitEstimate: number;
  lowStockCount: number;
  expiringSoonCount: number;
}

/** [start, end) of the local calendar day containing `now`, as ISO timestamps. */
export function dayRange(now: Date): { start: string; end: string } {
  const d = todayISO(now);
  return rangeBounds(d, d);
}

/**
 * Profit estimate = Σ (taxable revenue − tax-exclusive cost).
 * Purchase prices are entered GST-inclusive like selling prices, so cost is divided by (1 + gst rate).
 */
export function estimateProfit(items: { taxableAmount: number; purchasePrice: number; quantity: number; gstRate: number }[]): number {
  return items.reduce((sum, i) => {
    const cost = divRound(i.purchasePrice * i.quantity * 100, MILLI * (100 + i.gstRate));
    return sum + (i.taxableAmount - cost);
  }, 0);
}

export function getDashboardStats(db: Db, now: Date = new Date()): DashboardStats {
  const { start, end } = dayRange(now);
  const today = todayISO(now);
  const settings = getSettings(db);

  const sales = db
    .select({ total: sql<number>`coalesce(sum(${invoices.grandTotal}), 0)`, n: sql<number>`count(*)` })
    .from(invoices)
    .where(and(eq(invoices.status, "paid"), gte(invoices.createdAt, start), lt(invoices.createdAt, end)))
    .get();

  const items = db
    .select({
      taxableAmount: invoiceItems.taxableAmount,
      purchasePrice: invoiceItems.purchasePrice,
      quantity: invoiceItems.quantity,
      gstRate: invoiceItems.gstRate,
    })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .where(and(eq(invoices.status, "paid"), gte(invoices.createdAt, start), lt(invoices.createdAt, end)))
    .all();

  return {
    todaySales: sales?.total ?? 0,
    todayInvoices: sales?.n ?? 0,
    profitEstimate: estimateProfit(items),
    lowStockCount: getLowStock(db, today).length,
    expiringSoonCount: getExpiringBatches(db, today, settings.expiryWarnDays).length,
  };
}
