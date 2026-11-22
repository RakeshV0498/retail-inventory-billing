import { and, eq, gte, isNull, like, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  batches,
  customers,
  invoiceItems,
  invoices,
  PAYMENT_MODES,
  pricingRules,
  products,
  stockMovements,
  type Invoice,
  type InvoiceItem,
} from "@/db/schema";
import { rangeBounds, todayISO } from "@/lib/dates";
import { allocateFefo, StockError } from "@/lib/fefo";
import {
  calcInvoiceTotals,
  calcLine,
  splitFlatDiscount,
  type DiscountType,
  type GstRate,
  type LineResult,
} from "@/lib/gst";
import { assertValidQty, QtyError } from "@/lib/qty";
import type { Actor } from "./audit";
import { markdownFromRules } from "./inventory";
import { ServiceError, type Q } from "./types";

export const cartLineInput = z.object({
  productId: z.number().int().positive(),
  /** milli-units */
  quantity: z.number().int().positive().max(1_000_000_000),
  discountType: z.enum(["none", "percent", "flat"]).default("none"),
  /** percent: hundredths of a percent; flat: paise (applied to the whole cart line) */
  discountValue: z.number().int().min(0).max(1_000_000_000).default(0),
  /** Apply near-expiry markdown rules per batch (ignored when a manual discount is set). */
  applyMarkdown: z.boolean().default(false),
});

export const invoiceInput = z.object({
  items: z.array(cartLineInput).min(1, "Cart is empty").max(200, "Too many lines on one bill (200 max)"),
  customerName: z.string().trim().min(1).max(100).nullish(),
  customerPhone: z.string().trim().min(1).max(30).nullish(),
  notes: z.string().trim().max(200).nullish(),
  /** Required (existing, active customer) whenever any part of the bill is on credit. */
  customerId: z.number().int().positive().nullish(),
  paymentMode: z.enum(PAYMENT_MODES),
  /** Only used for split payments (paise); cash + upi + card + credit must equal the grand total. */
  split: z
    .object({
      cash: z.number().int().min(0).max(10_000_000_000).default(0),
      upi: z.number().int().min(0).max(10_000_000_000).default(0),
      card: z.number().int().min(0).max(10_000_000_000).default(0),
      credit: z.number().int().min(0).max(10_000_000_000).default(0),
    })
    .nullish(),
});
export type InvoiceInput = z.input<typeof invoiceInput>;

export interface InvoiceWithItems {
  invoice: Invoice;
  items: InvoiceItem[];
}

/** Who a bill is attributed to, how it is dated and numbered. Overridden only when amending an existing bill. */
export interface InvoiceExtras {
  invoiceNumber?: string;
  /** ISO timestamp for the bill (an amended bill keeps the original sale time; stock movements always use "now"). */
  createdAt?: string;
  createdBy?: { id: number | null; name: string | null } | null;
  replacesInvoiceId?: number;
  notes?: string | null;
}

export interface PaymentSplit {
  cash: number;
  upi: number;
  card: number;
  credit: number;
}

/** How a bill of `grandTotal` paise was settled. `split` amounts must add up to the total (credit included). */
export function resolvePayment(
  grandTotal: number,
  mode: (typeof PAYMENT_MODES)[number],
  split?: { cash?: number; upi?: number; card?: number; credit?: number } | null,
): PaymentSplit {
  if (mode === "split") {
    const p = { cash: split?.cash ?? 0, upi: split?.upi ?? 0, card: split?.card ?? 0, credit: split?.credit ?? 0 };
    if (p.cash + p.upi + p.card + p.credit !== grandTotal) {
      throw new ServiceError("SPLIT_MISMATCH", "Split payments must add up to the total");
    }
    return p;
  }
  const none = { cash: 0, upi: 0, card: 0, credit: 0 };
  if (mode === "cash") return { ...none, cash: grandTotal };
  if (mode === "upi") return { ...none, upi: grandTotal };
  if (mode === "card") return { ...none, card: grandTotal };
  return { ...none, credit: grandTotal }; // "credit": the whole bill goes on the customer's account
}

/** The customer for a bill. Credit needs a real, active customer. */
export function resolveCustomer(tx: Q, customerId: number | null | undefined, credit: number) {
  const customer = customerId ? tx.select().from(customers).where(eq(customers.id, customerId)).get() : undefined;
  if (customerId && !customer) throw new ServiceError("CUSTOMER_NOT_FOUND", "Customer not found");
  if (credit > 0 && (!customer || !customer.isActive)) throw new ServiceError("CUSTOMER_REQUIRED", "Pick a customer to sell on credit");
  return customer;
}

/**
 * Create an invoice atomically: FEFO-allocate every cart line, decrement batches, write items and
 * `sale_out` ledger rows. Expired and insufficient stock abort the whole sale (nothing is written).
 */
export function createInvoice(db: Db, raw: InvoiceInput, now: Date = new Date(), actor: Actor | null = null): InvoiceWithItems {
  return db.transaction((tx) => createInvoiceTx(tx, raw, now, actor));
}

/** Same as createInvoice, but inside a transaction the caller already opened (used by amend). */
export function createInvoiceTx(tx: Q, raw: InvoiceInput, now: Date, actor: Actor | null, extras: InvoiceExtras = {}): InvoiceWithItems {
  const input = invoiceInput.parse(raw);
  const today = todayISO(now);
  const ts = now.toISOString();
  const biller = extras.createdBy !== undefined ? extras.createdBy : actor;

  type Pending = Omit<typeof invoiceItems.$inferInsert, "invoiceId">;
  const pending: Pending[] = [];
  const lineResults: LineResult[] = [];
  const rules = tx.select().from(pricingRules).where(eq(pricingRules.isActive, true)).all();

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
      // Per-batch discount: manual discount wins; otherwise optional near-expiry markdown for THIS batch.
      let dType: DiscountType = line.discountType;
      let dValue = line.discountType === "flat" ? (flatShares[i] ?? 0) : line.discountValue;
      if (line.applyMarkdown && line.discountType === "none") {
        const pct = markdownFromRules(rules, product.category, batch.expiryDate, today);
        if (pct > 0) {
          dType = "percent";
          dValue = pct;
        }
      }
      try {
        calc = calcLine({
          unitPrice: batch.sellingPrice,
          quantity: alloc.quantity,
          gstRate: product.gstRate as GstRate,
          discountType: dType,
          discountValue: dValue,
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
        discountType: dType,
        discountValue: dValue,
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

  const { cash, upi, card, credit } = resolvePayment(totals.grandTotal, input.paymentMode, input.split);
  const customer = resolveCustomer(tx, input.customerId, credit);

  const prefix = `INV-${today.replaceAll("-", "")}-`;
  const seq =
    extras.invoiceNumber !== undefined
      ? 0
      : (tx
          .select({ n: sql<number>`count(*)` })
          .from(invoices)
          .where(like(invoices.invoiceNumber, `${prefix}%`))
          .get()?.n ?? 0);

  const invoice = tx
    .insert(invoices)
    .values({
      invoiceNumber: extras.invoiceNumber ?? `${prefix}${String(seq + 1).padStart(4, "0")}`,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? input.customerName ?? null,
      customerPhone: customer?.phone ?? input.customerPhone ?? null,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      roundOff: totals.roundOff,
      grandTotal: totals.grandTotal,
      paymentMode: input.paymentMode,
      cashAmount: cash,
      upiAmount: upi,
      cardAmount: card,
      creditAmount: credit,
      createdBy: biller ? biller.id : null,
      createdByName: biller ? biller.name : null,
      notes: input.notes ?? extras.notes ?? null,
      replacesInvoiceId: extras.replacesInvoiceId ?? null,
      createdAt: extras.createdAt ?? ts,
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
}

export function getInvoice(db: Db, id: number): InvoiceWithItems | null {
  const invoice = db.select().from(invoices).where(eq(invoices.id, id)).get();
  if (!invoice) return null;
  const items = db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).all();
  return { invoice, items };
}

export interface InvoiceFilter {
  /** Local calendar days, inclusive (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** A user id, or "none" for bills with no recorded biller. */
  userId?: number | "none";
  status?: "paid" | "void";
  limit?: number;
}

/** Newest first. A plain number is accepted as the limit for older callers. */
export function listInvoices(db: Db, opts: number | InvoiceFilter = 100): Invoice[] {
  const f: InvoiceFilter = typeof opts === "number" ? { limit: opts } : opts;
  const where = [
    f.status ? eq(invoices.status, f.status) : undefined,
    f.userId === "none" ? isNull(invoices.createdBy) : f.userId !== undefined ? eq(invoices.createdBy, f.userId) : undefined,
    f.from ? gte(invoices.createdAt, rangeBounds(f.from, f.to ?? f.from).start) : undefined,
    f.to ? lt(invoices.createdAt, rangeBounds(f.from ?? f.to, f.to).end) : undefined,
  ].filter((w) => w !== undefined);
  return db
    .select()
    .from(invoices)
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${invoices.id} desc`)
    .limit(Math.min(f.limit ?? 100, 1000))
    .all();
}
