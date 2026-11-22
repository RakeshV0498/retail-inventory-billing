import { and, asc, eq, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { customers, DUES_PAYMENT_MODES, invoices, payments, type Customer } from "@/db/schema";
import { formatPaise } from "@/lib/money";
import { normalizePhone } from "@/lib/phone";
import { writeAudit, type Actor } from "./audit";
import { ServiceError, type Q } from "./types";

/**
 * Customer credit (udhaar). A customer's balance is ALWAYS computed, never stored:
 *   Σ credit_amount of PAID invoices − Σ payments received
 * so it cannot drift, and voiding an invoice automatically corrects it.
 */

export const customerInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  phone: z.string().trim().max(30).nullish(),
  notes: z.string().trim().max(200).nullish(),
});
export type CustomerInput = z.input<typeof customerInput>;

function cleanPhone(phone: string | null | undefined): string | null {
  const t = phone?.trim();
  if (!t) return null;
  const n = normalizePhone(t);
  if (!n) throw new ServiceError("INVALID_PHONE", "Phone number should have 7 to 15 digits");
  return n;
}

const dupPhone = (e: unknown) => {
  if (e instanceof Error && /UNIQUE/i.test(e.message)) return new ServiceError("DUPLICATE_PHONE", "A customer with this phone number already exists");
  return e;
};

export function createCustomer(db: Db, raw: CustomerInput): Customer {
  const input = customerInput.parse(raw);
  try {
    return db
      .insert(customers)
      .values({ name: input.name, phone: cleanPhone(input.phone), notes: input.notes || null })
      .returning()
      .get();
  } catch (e) {
    throw dupPhone(e);
  }
}

export function updateCustomer(db: Db, id: number, raw: CustomerInput): Customer {
  const input = customerInput.parse(raw);
  try {
    const row = db
      .update(customers)
      .set({ name: input.name, phone: cleanPhone(input.phone), notes: input.notes || null })
      .where(eq(customers.id, id))
      .returning()
      .get();
    if (!row) throw new ServiceError("NOT_FOUND", "Customer not found");
    return row;
  } catch (e) {
    throw dupPhone(e);
  }
}

export function getCustomer(db: Q, id: number): Customer | undefined {
  return db.select().from(customers).where(eq(customers.id, id)).get();
}

const sumOf = (v: number | null | undefined) => v ?? 0;

/** What the customer owes right now, in paise (negative would mean they are ahead, e.g. after a void). */
export function balanceOf(db: Q, customerId: number): number {
  const credit = db
    .select({ s: sql<number>`coalesce(sum(${invoices.creditAmount}), 0)` })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.status, "paid")))
    .get();
  const paid = db
    .select({ s: sql<number>`coalesce(sum(${payments.amount}), 0)` })
    .from(payments)
    .where(and(eq(payments.customerId, customerId), eq(payments.status, "active")))
    .get();
  return sumOf(credit?.s) - sumOf(paid?.s);
}

export interface CustomerWithBalance {
  customer: Customer;
  balance: number;
}

function balancesByCustomer(db: Q): Map<number, number> {
  const map = new Map<number, number>();
  const credits = db
    .select({ id: invoices.customerId, s: sql<number>`sum(${invoices.creditAmount})` })
    .from(invoices)
    .where(and(eq(invoices.status, "paid"), sql`${invoices.customerId} is not null`))
    .groupBy(invoices.customerId)
    .all();
  for (const c of credits) if (c.id !== null) map.set(c.id, sumOf(c.s));
  const paid = db
    .select({ id: payments.customerId, s: sql<number>`sum(${payments.amount})` })
    .from(payments)
    .where(eq(payments.status, "active"))
    .groupBy(payments.customerId)
    .all();
  for (const p of paid) map.set(p.id, (map.get(p.id) ?? 0) - sumOf(p.s));
  return map;
}

/** Everyone, owing most first (then by name). */
export function listCustomersWithBalance(db: Q): CustomerWithBalance[] {
  const bal = balancesByCustomer(db);
  return db
    .select()
    .from(customers)
    .where(eq(customers.isActive, true))
    .orderBy(asc(customers.name))
    .all()
    .map((customer) => ({ customer, balance: bal.get(customer.id) ?? 0 }))
    .sort((a, b) => b.balance - a.balance || a.customer.name.localeCompare(b.customer.name));
}

/** Type-ahead for POS: name or phone contains the text. */
export function searchCustomers(db: Q, query: string, limit = 8): CustomerWithBalance[] {
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const byName = sql`${customers.name} like ${pattern} escape '\\'`;
  const digits = q.replace(/\D/g, "");
  const rows = db
    .select()
    .from(customers)
    // Only match phones when the text actually contains digits (an empty digit pattern would match everyone).
    .where(and(eq(customers.isActive, true), digits ? or(byName, like(customers.phone, `%${digits}%`)) : byName))
    .orderBy(asc(customers.name))
    .limit(limit)
    .all();
  return rows.map((customer) => ({ customer, balance: balanceOf(db, customer.id) }));
}

/** Total currently owed to the shop (customers who are ahead don't reduce it). */
export function outstandingTotal(db: Q): number {
  let total = 0;
  for (const b of balancesByCustomer(db).values()) if (b > 0) total += b;
  return total;
}

export interface LedgerEntry {
  kind: "credit" | "payment";
  at: string;
  /** paise, positive */
  amount: number;
  label: string;
  invoiceId: number | null;
  /** set on payment entries so an admin can void them */
  paymentId: number | null;
  /** A voided payment is listed for the record but does not change the balance. */
  voided: boolean;
  voidReason: string | null;
  /** balance after this entry */
  balanceAfter: number;
}

/** Credit bills and payments in time order with a running balance (oldest first). */
export function getCustomerLedger(db: Q, customerId: number): LedgerEntry[] {
  const bills = db
    .select({ id: invoices.id, no: invoices.invoiceNumber, at: invoices.createdAt, amount: invoices.creditAmount })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.status, "paid"), sql`${invoices.creditAmount} > 0`))
    .all();
  const pays = db.select().from(payments).where(eq(payments.customerId, customerId)).all();

  const raw = [
    ...bills.map((b) => ({
      kind: "credit" as const, at: b.at, order: 0, id: b.id, amount: b.amount, label: `Bill ${b.no}`,
      invoiceId: b.id, paymentId: null, voided: false, voidReason: null as string | null,
    })),
    ...pays.map((p) => ({
      kind: "payment" as const, at: p.createdAt, order: 1, id: p.id, amount: p.amount,
      label: `Payment (${p.mode})${p.note ? `: ${p.note}` : ""}${p.createdByName ? ` · by ${p.createdByName}` : ""}`,
      invoiceId: null, paymentId: p.id, voided: p.status === "void", voidReason: p.voidReason,
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id));

  let running = 0;
  return raw.map((e) => {
    if (!e.voided) running += e.kind === "credit" ? e.amount : -e.amount;
    return {
      kind: e.kind, at: e.at, amount: e.amount, label: e.label, invoiceId: e.invoiceId,
      paymentId: e.paymentId, voided: e.voided, voidReason: e.voidReason, balanceAfter: running,
    };
  });
}

const paymentInput = z.object({
  amount: z.number().int("Amount must be a whole number of paise").positive("Enter an amount above zero").max(10_000_000_000),
  mode: z.enum(DUES_PAYMENT_MODES),
  note: z.string().trim().max(200).nullish(),
});

/** Record money received against dues. Can't exceed what is owed (no accidental advances). */
export function recordPayment(
  db: Db,
  customerId: number,
  amount: number,
  mode: (typeof DUES_PAYMENT_MODES)[number],
  note: string | null = null,
  now: Date = new Date(),
  actor: Actor | null = null,
) {
  const input = paymentInput.parse({ amount, mode, note });
  return db.transaction((tx) => {
    const customer = getCustomer(tx, customerId);
    if (!customer) throw new ServiceError("NOT_FOUND", "Customer not found");
    const owed = balanceOf(tx, customerId);
    if (input.amount > owed) {
      throw new ServiceError("OVERPAY", owed > 0 ? `${customer.name} only owes ${formatPaise(owed)}` : `${customer.name} has nothing outstanding`);
    }
    return tx
      .insert(payments)
      .values({
        customerId,
        amount: input.amount,
        mode: input.mode,
        note: input.note || null,
        createdBy: actor?.id ?? null,
        createdByName: actor?.name ?? null,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
  });
}

/**
 * Admin: reverse a payment that was recorded by mistake. The payment is kept (marked void with who/why) and ignored in
 * balances, so the customer's dues go back up by that amount. Never deletes anything.
 */
export function voidPayment(db: Db, paymentId: number, actor: Actor | null, reason: string, now: Date = new Date()): void {
  const why = reason.trim();
  if (!why) throw new ServiceError("REASON_REQUIRED", "Please give a reason");
  if (why.length > 200) throw new ServiceError("INVALID", "Reason is too long (200 characters max)");
  db.transaction((tx) => {
    const p = tx.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!p) throw new ServiceError("NOT_FOUND", "Payment not found");
    if (p.status === "void") throw new ServiceError("ALREADY_VOID", "This payment is already voided");
    tx.update(payments)
      .set({ status: "void", voidReason: why, voidedAt: now.toISOString(), voidedByName: actor?.name ?? null })
      .where(eq(payments.id, paymentId))
      .run();
    const c = getCustomer(tx, p.customerId);
    writeAudit(tx, actor, "payment.void", "payment", paymentId, `Voided ${formatPaise(p.amount)} ${p.mode} payment from ${c?.name ?? "customer"}: ${why}`, now);
  });
}
