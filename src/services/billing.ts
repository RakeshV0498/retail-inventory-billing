import { eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  batches,
  invoiceItems,
  invoices,
  PAYMENT_MODES,
  products,
  stockMovements,
  type Invoice,
  type InvoiceItem,
} from "@/db/schema";
import { todayISO } from "@/lib/dates";
import { allocateFefo, StockError } from "@/lib/fefo";
import { calcInvoiceTotals, calcLine, type GstRate, type LineResult } from "@/lib/gst";
import { assertValidQty, QtyError } from "@/lib/qty";
import { ServiceError } from "./types";

export const cartLineInput = z.object({
  productId: z.number().int().positive(),
  /** milli-units */
  quantity: z.number().int().positive(),
  discountType: z.enum(["none", "percent", "flat"]).default("none"),
  /** percent: hundredths of a percent; flat: paise (applied to the whole cart line) */
  discountValue: z.number().int().min(0).default(0),
});

export const invoiceInput = z.object({
  items: z.array(cartLineInput).min(1, "Cart is empty"),
  customerName: z.string().trim().min(1).nullish(),
  customerPhone: z.string().trim().min(1).nullish(),
  paymentMode: z.enum(PAYMENT_MODES),
  /** Only used for split payments (paise); must sum to the grand total. */
  split: z
    .object({
      cash: z.number().int().min(0).default(0),
      upi: z.number().int().min(0).default(0),
      card: z.number().int().min(0).default(0),
    })
    .nullish(),
});
export type InvoiceInput = z.input<typeof invoiceInput>;

export interface InvoiceWithItems {
  invoice: Invoice;
  items: InvoiceItem[];
}

/** Spread a flat discount across batch allocations proportionally to quantity; remainder to the last. */
export function splitFlatDiscount(total: number, quantities: number[]): number[] {
  const sum = quantities.reduce((a, b) => a + b, 0);
  let given = 0;
  return quantities.map((q, i) => {
    const part = i === quantities.length - 1 ? total - given : Math.floor((total * q) / sum);
    given += part;
    return part;
  });
}

/**
 * Create an invoice atomically: FEFO-allocate every cart line, decrement batches, write items and
 * `sale_out` ledger rows. Expired and insufficient stock abort the whole sale (nothing is written).
 */
export function createInvoice(db: Db, raw: InvoiceInput, now: Date = new Date()): InvoiceWithItems {
  const input = invoiceInput.parse(raw);
  const today = todayISO(now);
  const ts = now.toISOString();

  return db.transaction((tx) => {
    type Pending = Omit<typeof invoiceItems.$inferInsert, "invoiceId">;
    const pending: Pending[] = [];
    const lineResults: LineResult[] = [];

    for (const line of input.items) {
      const product = tx.select().from(products).where(eq(products.id, line.productId)).get();
      if (!product || !product.isActive) throw new ServiceError("NOT_FOUND", "Product not found");

      try {
        assertValidQty(line.quantity, product.allowDecimalQty);
      } catch (e) {
        if (e instanceof QtyError) throw new ServiceError("INVALID_QTY", `${product.name}: ${e.message}`);
        throw e;
      }

      // Fresh read inside the transaction so earlier cart lines for the same product are accounted for.
      const productBatches = tx.select().from(batches).where(eq(batches.productId, product.id)).all();
      let allocations;
      try {
        allocations = allocateFefo(productBatches, line.quantity, today);
      } catch (e) {
        if (e instanceof StockError) throw new ServiceError(e.code, `${product.name}: ${e.message}`);
        throw e;
      }

      const flatShares =
        line.discountType === "flat"
          ? splitFlatDiscount(
              line.discountValue,
              allocations.map((a) => a.quantity),
            )
          : allocations.map(() => 0);

      allocations.forEach((alloc, i) => {
        const batch = productBatches.find((b) => b.id === alloc.batchId)!;
        let calc: LineResult;
        try {
          calc = calcLine({
            unitPrice: batch.sellingPrice,
            quantity: alloc.quantity,
            gstRate: product.gstRate as GstRate,
            discountType: line.discountType,
            discountValue: line.discountType === "flat" ? (flatShares[i] ?? 0) : line.discountValue,
          });
        } catch (e) {
          throw new ServiceError("INVALID_DISCOUNT", `${product.name}: ${e instanceof Error ? e.message : "bad discount"}`);
        }
        lineResults.push(calc);
        pending.push({
          productId: product.id,
          batchId: batch.id,
          productName: product.name,
          batchNumber: batch.batchNumber,
          unitType: product.unitType,
          quantity: alloc.quantity,
          unitPrice: batch.sellingPrice,
          purchasePrice: batch.purchasePrice,
          discountType: line.discountType,
          discountValue: line.discountType === "flat" ? (flatShares[i] ?? 0) : line.discountValue,
          discountAmount: calc.discountAmount,
          gstRate: product.gstRate,
          taxableAmount: calc.taxableAmount,
          taxAmount: calc.taxAmount,
          lineTotal: calc.lineTotal,
        });

        // Guarded decrement: the WHERE clause re-checks stock and expiry in the DB itself.
        const res = tx
          .update(batches)
          .set({ quantityAvailable: sql`${batches.quantityAvailable} - ${alloc.quantity}` })
          .where(
            sql`${batches.id} = ${batch.id} and ${batches.quantityAvailable} >= ${alloc.quantity}
                and (${batches.expiryDate} is null or ${batches.expiryDate} >= ${today})`,
          )
          .run();
        if (res.changes !== 1) throw new ServiceError("STOCK_CONFLICT", `${product.name}: stock changed, please retry`);
      });
    }

    const totals = calcInvoiceTotals(lineResults);

    let cash = 0;
    let upi = 0;
    let card = 0;
    if (input.paymentMode === "split") {
      cash = input.split?.cash ?? 0;
      upi = input.split?.upi ?? 0;
      card = input.split?.card ?? 0;
      if (cash + upi + card !== totals.grandTotal) {
        throw new ServiceError("SPLIT_MISMATCH", "Split payments must add up to the total");
      }
    } else if (input.paymentMode === "cash") cash = totals.grandTotal;
    else if (input.paymentMode === "upi") upi = totals.grandTotal;
    else card = totals.grandTotal;

    const prefix = `INV-${today.replaceAll("-", "")}-`;
    const seq =
      tx
        .select({ n: sql<number>`count(*)` })
        .from(invoices)
        .where(like(invoices.invoiceNumber, `${prefix}%`))
        .get()?.n ?? 0;

    const invoice = tx
      .insert(invoices)
      .values({
        invoiceNumber: `${prefix}${String(seq + 1).padStart(4, "0")}`,
        customerName: input.customerName ?? null,
        customerPhone: input.customerPhone ?? null,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        roundOff: totals.roundOff,
        grandTotal: totals.grandTotal,
        paymentMode: input.paymentMode,
        cashAmount: cash,
        upiAmount: upi,
        cardAmount: card,
        createdAt: ts,
      })
      .returning()
      .get();

    const items = pending.map((p) =>
      tx
        .insert(invoiceItems)
        .values({ ...p, invoiceId: invoice.id })
        .returning()
        .get(),
    );

    for (const item of items) {
      tx.insert(stockMovements)
        .values({
          productId: item.productId,
          batchId: item.batchId,
          type: "sale_out",
          quantityDelta: -item.quantity,
          referenceType: "invoice",
          referenceId: invoice.id,
          createdAt: ts,
        })
        .run();
    }

    return { invoice, items };
  });
}

export function getInvoice(db: Db, id: number): InvoiceWithItems | null {
  const invoice = db.select().from(invoices).where(eq(invoices.id, id)).get();
  if (!invoice) return null;
  const items = db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).all();
  return { invoice, items };
}

export function listInvoices(db: Db, limit = 100): Invoice[] {
  return db.select().from(invoices).orderBy(sql`${invoices.id} desc`).limit(limit).all();
}
