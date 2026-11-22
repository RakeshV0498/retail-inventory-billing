import { eq, inArray, like, sql } from "drizzle-orm";
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
import { formatPaise } from "@/lib/money";
import { todayISO } from "@/lib/dates";
import { writeAudit, type Actor } from "./audit";
import { createInvoiceTx, resolveCustomer, resolvePayment, type InvoiceInput, type InvoiceWithItems } from "./billing";
import { withStock, type ProductStock } from "./inventory";
import { ServiceError, type Q } from "./types";

/**
 * Admin control of sales. Nothing is ever deleted: a bill is VOIDED (stock goes back through the ledger,
 * credit drops out of the customer's balance, reports ignore it) or AMENDED (void + a linked corrected bill).
 * Every operation is one transaction and writes an audit row inside it.
 */

function cleanReason(reason: string): string {
  const why = reason.trim();
  if (!why) throw new ServiceError("REASON_REQUIRED", "Please give a reason");
  if (why.length > 200) throw new ServiceError("INVALID", "Reason is too long (200 characters max)");
  return why;
}

export interface VoidSummary {
  invoiceNumber: string;
  total: number;
  customerName: string | null;
  restored: { productName: string; batchNumber: string; quantity: number; unitType: string }[];
  /** Money to hand back to the customer (paid at the counter). */
  refund: { cash: number; upi: number; card: number };
  /** Removed from the customer's dues. */
  creditReversed: number;
  /** Sold products that are archived now: their stock is back but hidden until the product is restored. */
  archivedProducts: string[];
}

/** Put a bill's stock back and mark it void. Shared by void and amend. */
function voidInTx(tx: Q, inv: Invoice, actor: Actor | null, reason: string, now: Date): VoidSummary {
  const items = tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, inv.id)).all();
  const ts = now.toISOString();
  const archived = new Set<string>();
  for (const it of items) {
    tx.update(batches)
      .set({ quantityAvailable: sql`${batches.quantityAvailable} + ${it.quantity}` })
      .where(eq(batches.id, it.batchId))
      .run();
    tx.insert(stockMovements)
      .values({
        productId: it.productId,
        batchId: it.batchId,
        type: "return",
        quantityDelta: it.quantity,
        referenceType: "invoice",
        referenceId: inv.id,
        note: `Void ${inv.invoiceNumber}: ${reason}`,
        createdAt: ts,
      })
      .run();
    const prod = tx.select({ name: products.name, isActive: products.isActive }).from(products).where(eq(products.id, it.productId)).get();
    if (prod && !prod.isActive) archived.add(prod.name);
  }
  tx.update(invoices)
    .set({ status: "void", voidReason: reason, voidedAt: ts, voidedBy: actor?.id ?? null, voidedByName: actor?.name ?? null })
    .where(eq(invoices.id, inv.id))
    .run();
  return {
    invoiceNumber: inv.invoiceNumber,
    total: inv.grandTotal,
    customerName: inv.customerName,
    restored: items.map((it) => ({ productName: it.productName, batchNumber: it.batchNumber, quantity: it.quantity, unitType: it.unitType })),
    refund: { cash: inv.cashAmount, upi: inv.upiAmount, card: inv.cardAmount },
    creditReversed: inv.creditAmount,
    archivedProducts: [...archived],
  };
}

function loadInvoice(tx: Q, id: number): Invoice {
  const inv = tx.select().from(invoices).where(eq(invoices.id, id)).get();
  if (!inv) throw new ServiceError("NOT_FOUND", "Invoice not found");
  if (inv.status === "void") throw new ServiceError("ALREADY_VOID", `${inv.invoiceNumber} is already void`);
  return inv;
}

/** Void a bill: stock back to the original batches, dues reversed, record kept and stamped VOID. */
export function voidInvoice(db: Db, invoiceId: number, actor: Actor | null, reason: string, now: Date = new Date()): VoidSummary {
  const why = cleanReason(reason);
  return db.transaction((tx) => {
    const inv = loadInvoice(tx, invoiceId);
    const summary = voidInTx(tx, inv, actor, why, now);
    writeAudit(tx, actor, "sale.void", "invoice", inv.id, `Voided ${inv.invoiceNumber} (${formatPaise(inv.grandTotal)}): ${why}`, now);
    return summary;
  });
}

export interface AmendResult {
  voided: VoidSummary;
  replacement: InvoiceWithItems;
}

/**
 * Correct a bill's items/quantities/prices/payment: the original is voided and a corrected bill is created in the SAME
 * transaction (so a failure, e.g. not enough stock, changes nothing). The new bill is numbered `<original>-A<n>`, keeps the
 * original date and biller, and links back to the original. Stock is validated against TODAY like any sale.
 */
export function amendInvoice(
  db: Db,
  invoiceId: number,
  raw: InvoiceInput,
  actor: Actor | null,
  reason: string,
  now: Date = new Date(),
): AmendResult {
  const why = cleanReason(reason);
  return db.transaction((tx) => {
    const orig = loadInvoice(tx, invoiceId);
    const base = orig.invoiceNumber.replace(/-A\d+$/, "");
    const made = tx.select({ n: sql<number>`count(*)` }).from(invoices).where(like(invoices.invoiceNumber, `${base}-A%`)).get()?.n ?? 0;
    const invoiceNumber = `${base}-A${made + 1}`;

    const voided = voidInTx(tx, orig, actor, `Amended to ${invoiceNumber}: ${why}`, now);
    const replacement = createInvoiceTx(tx, raw, now, actor, {
      invoiceNumber,
      createdAt: orig.createdAt,
      createdBy: { id: orig.createdBy, name: orig.createdByName },
      replacesInvoiceId: orig.id,
      notes: orig.notes,
    });
    writeAudit(
      tx,
      actor,
      "sale.amend",
      "invoice",
      replacement.invoice.id,
      `Amended ${orig.invoiceNumber} (${formatPaise(orig.grandTotal)}) -> ${invoiceNumber} (${formatPaise(replacement.invoice.grandTotal)}): ${why}`,
      now,
    );
    return { voided, replacement };
  });
}

const detailsInput = z.object({
  customerId: z.number().int().positive().nullish(),
  customerName: z.string().trim().max(100).nullish(),
  customerPhone: z.string().trim().max(30).nullish(),
  notes: z.string().trim().max(200).nullish(),
  paymentMode: z.enum(PAYMENT_MODES),
  split: z
    .object({
      cash: z.number().int().min(0).max(10_000_000_000).default(0),
      upi: z.number().int().min(0).max(10_000_000_000).default(0),
      card: z.number().int().min(0).max(10_000_000_000).default(0),
      credit: z.number().int().min(0).max(10_000_000_000).default(0),
    })
    .nullish(),
});
export type InvoiceDetailsInput = z.input<typeof detailsInput>;

/**
 * Edit what doesn't touch stock or totals: customer, walk-in name/phone, notes, and how the bill was paid.
 * Payment amounts must still add up to the (unchanged) total and credit needs a customer. Old -> new is audited.
 */
export function updateInvoiceDetails(
  db: Db,
  invoiceId: number,
  raw: InvoiceDetailsInput,
  actor: Actor | null,
  now: Date = new Date(),
): { invoice: Invoice; changed: boolean } {
  const input = detailsInput.parse(raw);
  return db.transaction((tx) => {
    const inv = loadInvoice(tx, invoiceId);
    const pay = resolvePayment(inv.grandTotal, input.paymentMode, input.split);
    const customer = resolveCustomer(tx, input.customerId ?? null, pay.credit);
    const next = {
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? (input.customerName || null),
      customerPhone: customer?.phone ?? (input.customerPhone || null),
      notes: input.notes || null,
      paymentMode: input.paymentMode,
      cashAmount: pay.cash,
      upiAmount: pay.upi,
      cardAmount: pay.card,
      creditAmount: pay.credit,
    };

    const changes: string[] = [];
    if (next.customerId !== inv.customerId || next.customerName !== inv.customerName) {
      changes.push(`customer ${inv.customerName ?? "none"} -> ${next.customerName ?? "none"}`);
    }
    if (next.customerPhone !== inv.customerPhone) changes.push("phone");
    if (next.notes !== inv.notes) changes.push("notes");
    if (
      next.paymentMode !== inv.paymentMode ||
      next.cashAmount !== inv.cashAmount ||
      next.upiAmount !== inv.upiAmount ||
      next.cardAmount !== inv.cardAmount ||
      next.creditAmount !== inv.creditAmount
    ) {
      const fmt = (m: string, c: number, u: number, d: number, k: number) =>
        `${m} (cash ${formatPaise(c)}, upi ${formatPaise(u)}, card ${formatPaise(d)}, credit ${formatPaise(k)})`;
      changes.push(
        `payment ${fmt(inv.paymentMode, inv.cashAmount, inv.upiAmount, inv.cardAmount, inv.creditAmount)} -> ${fmt(next.paymentMode, next.cashAmount, next.upiAmount, next.cardAmount, next.creditAmount)}`,
      );
    }
    if (changes.length === 0) return { invoice: inv, changed: false };

    const updated = tx.update(invoices).set(next).where(eq(invoices.id, inv.id)).returning().get();
    writeAudit(tx, actor, "sale.edit", "invoice", inv.id, `Edited ${inv.invoiceNumber}: ${changes.join("; ")}`, now);
    return { invoice: updated, changed: true };
  });
}

/** The bill this one replaced (if it is a corrected `-A<n>` bill) and the corrected bill that replaced it (if it was amended). */
export function getInvoiceRelations(db: Q, invoiceId: number): { replaces: Invoice | null; replacedBy: Invoice | null } {
  const inv = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  const replaces = inv?.replacesInvoiceId ? (db.select().from(invoices).where(eq(invoices.id, inv.replacesInvoiceId)).get() ?? null) : null;
  const replacedBy = db.select().from(invoices).where(eq(invoices.replacesInvoiceId, invoiceId)).get() ?? null;
  return { replaces, replacedBy };
}

/* ---------- amend editor support ---------- */

class Rollback<T> extends Error {
  constructor(public value: T) {
    super("rollback");
  }
}

export interface AmendLineSeed {
  productId: number;
  /** milli-units */
  quantity: number;
  discountType: "none" | "percent" | "flat";
  /** percent: hundredths of a percent; flat: paise */
  discountValue: number;
  /** Per-batch near-expiry markdown was in play. */
  auto: boolean;
}

/** Rebuild editable cart lines from a saved bill (one line per product; discount rows are re-derived). */
export function seedLinesFromItems(items: InvoiceItem[]): AmendLineSeed[] {
  const byProduct = new Map<number, InvoiceItem[]>();
  for (const it of items) byProduct.set(it.productId, [...(byProduct.get(it.productId) ?? []), it]);
  return [...byProduct.entries()].map(([productId, rows]) => {
    const quantity = rows.reduce((s, r) => s + r.quantity, 0);
    if (rows.some((r) => r.discountType === "flat")) {
      return { productId, quantity, discountType: "flat" as const, discountValue: rows.reduce((s, r) => s + r.discountValue, 0), auto: false };
    }
    const pct = rows.filter((r) => r.discountType === "percent");
    if (pct.length === 0) return { productId, quantity, discountType: "none" as const, discountValue: 0, auto: false };
    const distinct = new Set(pct.map((r) => r.discountValue));
    // Same percent on every row = a manual percent; differing/mixed rows = per-batch near-expiry markdown.
    if (distinct.size === 1 && pct.length === rows.length) {
      return { productId, quantity, discountType: "percent" as const, discountValue: pct[0]!.discountValue, auto: false };
    }
    return { productId, quantity, discountType: "none" as const, discountValue: 0, auto: true };
  });
}

/**
 * Products as they would look with this bill's stock put back (so the editor's live preview and stock checks match what
 * amend will actually do). Computed inside a transaction that is always rolled back: nothing is written.
 */
export function stockAsIfVoided(db: Db, invoiceId: number, now: Date = new Date()): ProductStock[] {
  const items = db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).all();
  const ids = [...new Set(items.map((i) => i.productId))];
  if (ids.length === 0) return [];
  try {
    db.transaction((tx) => {
      for (const it of items) {
        tx.update(batches)
          .set({ quantityAvailable: sql`${batches.quantityAvailable} + ${it.quantity}` })
          .where(eq(batches.id, it.batchId))
          .run();
      }
      const rows = tx.select().from(products).where(inArray(products.id, ids)).all();
      throw new Rollback(withStock(tx, rows, todayISO(now)));
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value as ProductStock[];
    throw e;
  }
  return [];
}
