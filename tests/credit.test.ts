import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { whatsappNumber, whatsappReminderUrl, normalizePhone } from "@/lib/phone";
import { customers, invoices, payments } from "@/db/schema";
import { createInvoice, type InvoiceInput } from "@/services/billing";
import {
  balanceOf,
  createCustomer,
  getCustomerLedger,
  listCustomersWithBalance,
  outstandingTotal,
  recordPayment,
  searchCustomers,
  updateCustomer,
} from "@/services/customers";
import { getDashboardStats } from "@/services/dashboard";
import { buildCsv, getSalesReport } from "@/services/reports";
import { batchQty, makeDb, newProduct, NOW, stock } from "./helpers";

type Db = ReturnType<typeof makeDb>;
const day = (back: number, h = 12) => new Date(2026, 10, 21 - back, h, 0, 0);

/** A product priced ₹100 per piece, no GST: grand total = ₹100 × qty. */
function shop() {
  const db = makeDb();
  const p = newProduct(db, { unitType: "pcs" });
  const b = stock(db, p.id, { batch: "A", qtyMilli: 100_000, sell: 10_000 });
  return { db, p, b };
}
const bill = (db: Db, productId: number, input: Partial<InvoiceInput> & { paymentMode: InvoiceInput["paymentMode"] }, qty = 1_000, when = NOW) =>
  createInvoice(db, { items: [{ productId, quantity: qty }], ...input }, when);

describe("selling on credit", () => {
  it("puts the whole bill on the customer's account and snapshots their details", () => {
    const { db, p, b } = shop();
    const c = createCustomer(db, { name: "Lakshmi", phone: "98765 43210" });
    const { invoice } = bill(db, p.id, { paymentMode: "credit", customerId: c.id }, 3_000);
    expect(invoice).toMatchObject({ paymentMode: "credit", creditAmount: 30_000, cashAmount: 0, upiAmount: 0, cardAmount: 0, grandTotal: 30_000, customerId: c.id, customerName: "Lakshmi", customerPhone: "9876543210" });
    expect(balanceOf(db, c.id)).toBe(30_000);
    expect(batchQty(db, b.id)).toBe(97_000); // stock moves exactly as for a paid sale
  });

  it("supports part-paid bills: cash now, the rest on credit", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Ravi" });
    const { invoice } = bill(db, p.id, { paymentMode: "split", customerId: c.id, split: { cash: 3_000, credit: 7_000 } });
    expect(invoice).toMatchObject({ paymentMode: "split", cashAmount: 3_000, creditAmount: 7_000 });
    expect(balanceOf(db, c.id)).toBe(7_000);
    const three = bill(db, p.id, { paymentMode: "split", customerId: c.id, split: { cash: 2_000, upi: 3_000, card: 1_000, credit: 4_000 } });
    expect(three.invoice.creditAmount).toBe(4_000);
    expect(balanceOf(db, c.id)).toBe(11_000);
  });

  it("refuses credit without an existing customer, and writes nothing", () => {
    const { db, p, b } = shop();
    expect(() => bill(db, p.id, { paymentMode: "credit" })).toThrowError(/customer/i);
    expect(() => bill(db, p.id, { paymentMode: "split", split: { cash: 5_000, credit: 5_000 } })).toThrowError(/customer/i);
    expect(() => bill(db, p.id, { paymentMode: "credit", customerId: 999 })).toThrowError(/not found/i);
    expect(db.select().from(invoices).all()).toHaveLength(0);
    expect(batchQty(db, b.id)).toBe(100_000);
  });

  it("refuses an inactive customer for credit", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Closed" });
    db.update(customers).set({ isActive: false }).where(eq(customers.id, c.id)).run();
    expect(() => bill(db, p.id, { paymentMode: "credit", customerId: c.id })).toThrowError(/customer/i);
  });

  it("requires the split to add up including the credit part", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "X" });
    expect(() => bill(db, p.id, { paymentMode: "split", customerId: c.id, split: { cash: 3_000, credit: 6_000 } })).toThrowError(/add up/i);
    expect(db.select().from(invoices).all()).toHaveLength(0);
  });

  it("a paid sale to a known customer is tagged to them but adds no dues", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Regular" });
    const { invoice } = bill(db, p.id, { paymentMode: "cash", customerId: c.id });
    expect(invoice).toMatchObject({ customerId: c.id, customerName: "Regular", creditAmount: 0 });
    expect(balanceOf(db, c.id)).toBe(0);
  });
});

describe("balances, payments and ledger", () => {
  it("tracks dues across bills and part-payments down to zero, and the ledger shows a running balance", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Meena", phone: "9000000001" });
    bill(db, p.id, { paymentMode: "credit", customerId: c.id }, 2_000, day(3)); // +20000
    recordPayment(db, c.id, 5_000, "cash", "part payment", day(2));
    bill(db, p.id, { paymentMode: "credit", customerId: c.id }, 1_000, day(1)); // +10000
    expect(balanceOf(db, c.id)).toBe(25_000);
    recordPayment(db, c.id, 25_000, "upi", null, day(0));
    expect(balanceOf(db, c.id)).toBe(0);

    const ledger = getCustomerLedger(db, c.id);
    expect(ledger.map((e) => [e.kind, e.amount, e.balanceAfter])).toEqual([
      ["credit", 20_000, 20_000], ["payment", 5_000, 15_000], ["credit", 10_000, 25_000], ["payment", 25_000, 0],
    ]);
    expect(ledger[1]!.label).toContain("part payment");
  });

  it("rejects overpayment, zero, negative, fractional and unknown modes/customers", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Owes 100" });
    bill(db, p.id, { paymentMode: "credit", customerId: c.id });
    expect(() => recordPayment(db, c.id, 10_001, "cash")).toThrowError(/only owes/);
    expect(() => recordPayment(db, c.id, 0, "cash")).toThrow();
    expect(() => recordPayment(db, c.id, -5, "cash")).toThrow();
    expect(() => recordPayment(db, c.id, 10.5, "cash")).toThrow();
    // @ts-expect-error credit is not a way to pay dues
    expect(() => recordPayment(db, c.id, 100, "credit")).toThrow();
    expect(() => recordPayment(db, 999, 100, "cash")).toThrowError(/not found/i);
    expect(db.select().from(payments).all()).toHaveLength(0);
    recordPayment(db, c.id, 10_000, "cash");
    expect(() => recordPayment(db, c.id, 100, "cash")).toThrowError(/nothing outstanding/);
  });

  it("a voided credit bill no longer counts as owed", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "V" });
    const { invoice } = bill(db, p.id, { paymentMode: "credit", customerId: c.id }, 2_000);
    expect(balanceOf(db, c.id)).toBe(20_000);
    db.update(invoices).set({ status: "void" }).where(eq(invoices.id, invoice.id)).run();
    expect(balanceOf(db, c.id)).toBe(0);
    expect(getCustomerLedger(db, c.id)).toHaveLength(0);
  });

  it("keeps customers separate and lists the biggest debtor first", () => {
    const { db, p } = shop();
    const a = createCustomer(db, { name: "Anand" });
    const b = createCustomer(db, { name: "Bala" });
    const z = createCustomer(db, { name: "Zero" });
    bill(db, p.id, { paymentMode: "credit", customerId: a.id }, 1_000);
    bill(db, p.id, { paymentMode: "credit", customerId: b.id }, 3_000);
    recordPayment(db, b.id, 1_000, "cash");
    expect([a, b, z].map((c) => balanceOf(db, c.id))).toEqual([10_000, 29_000, 0]); // Bala: 3 × ₹100 − ₹10 paid
    expect(listCustomersWithBalance(db).map((r) => [r.customer.name, r.balance])).toEqual([["Bala", 29_000], ["Anand", 10_000], ["Zero", 0]]);
    expect(outstandingTotal(db)).toBe(39_000);
  });
});

describe("customer records and search", () => {
  it("normalises phones, rejects bad and duplicate numbers, and supports edits", () => {
    const db = makeDb();
    const c = createCustomer(db, { name: "  Kumar  ", phone: "+91 (98765) 43210" });
    expect(c).toMatchObject({ name: "Kumar", phone: "919876543210" });
    expect(() => createCustomer(db, { name: "Dup", phone: "919876543210" })).toThrowError(/already exists/);
    expect(() => createCustomer(db, { name: "Bad", phone: "12ab" })).toThrowError(/7 to 15 digits/);
    expect(() => createCustomer(db, { name: "   " })).toThrow();
    expect(createCustomer(db, { name: "No phone" }).phone).toBeNull();
    expect(createCustomer(db, { name: "No phone 2" }).phone).toBeNull(); // several without a phone are fine
    expect(updateCustomer(db, c.id, { name: "Kumar S", phone: "9876543211", notes: "pays on Fridays" })).toMatchObject({ name: "Kumar S", phone: "9876543211", notes: "pays on Fridays" });
    expect(() => updateCustomer(db, 999, { name: "x" })).toThrowError(/not found/i);
  });

  it("finds customers by part of the name or phone, with their balance", () => {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Lakshmi Devi", phone: "9876543210" });
    createCustomer(db, { name: "Someone Else", phone: "9111111111" });
    bill(db, p.id, { paymentMode: "credit", customerId: c.id });
    expect(searchCustomers(db, "laksh").map((r) => [r.customer.name, r.balance])).toEqual([["Lakshmi Devi", 10_000]]);
    expect(searchCustomers(db, "43210").map((r) => r.customer.id)).toEqual([c.id]);
    expect(searchCustomers(db, "")).toEqual([]);
    expect(searchCustomers(db, "%")).toEqual([]);
    expect(searchCustomers(db, "zzz")).toEqual([]);
  });
});

describe("dashboard and reports", () => {
  function scenario() {
    const { db, p } = shop();
    const c = createCustomer(db, { name: "Credit, \"Q\" Customer", phone: "9000000002" });
    bill(db, p.id, { paymentMode: "cash" }, 1_000, day(1)); // 10000 cash
    bill(db, p.id, { paymentMode: "credit", customerId: c.id }, 2_000, day(1, 15)); // 20000 credit
    bill(db, p.id, { paymentMode: "split", customerId: c.id, split: { upi: 4_000, credit: 6_000 } }, 1_000, day(0)); // 4000 upi + 6000 credit
    recordPayment(db, c.id, 8_000, "cash", null, day(0, 17));
    recordPayment(db, c.id, 3_000, "upi", null, day(0, 18));
    return { db, c };
  }

  it("shows outstanding dues on the dashboard", () => {
    const { db } = scenario();
    expect(getDashboardStats(db, day(0)).outstandingDues).toBe(26_000 - 11_000);
  });

  it("the report splits sales by how they were settled and reconciles to net sales", () => {
    const { db } = scenario();
    const r = getSalesReport(db, "2026-11-20", "2026-11-21");
    expect(r.payments).toEqual({ cash: 10_000, upi: 4_000, card: 0, credit: 26_000 });
    expect(r.payments.cash + r.payments.upi + r.payments.card + r.payments.credit).toBe(r.netSales);
    expect(r.netSales).toBe(40_000);
  });

  it("dues collected are reported separately and only for the range", () => {
    const { db } = scenario();
    expect(getSalesReport(db, "2026-11-21", "2026-11-21").duesCollected).toEqual({ cash: 8_000, upi: 3_000, card: 0, total: 11_000 });
    expect(getSalesReport(db, "2026-11-20", "2026-11-20").duesCollected.total).toBe(0);
  });

  it("exports sales (with a Credit column), dues and a customer ledger", () => {
    const { db, c } = scenario();
    const sales = buildCsv(db, "sales", "2026-11-20", "2026-11-21").csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(sales[0]).toContain("Credit,Total");
    expect(sales).toHaveLength(1 + 3);
    expect(sales.at(-1)!.endsWith(",6000.00,100.00") || sales.at(-1)!.endsWith(",60.00,100.00")).toBe(true);

    const dues = buildCsv(db, "dues", "2026-11-21", "2026-11-21", day(0));
    expect(dues.filename).toBe("dues-2026-11-21.csv");
    expect(dues.csv).toContain('"Credit, ""Q"" Customer",9000000002,150.00');
    expect(dues.csv).toContain("Total,,150.00");

    const ledger = buildCsv(db, "ledger", "2026-11-21", "2026-11-21", day(0), c.id);
    expect(ledger.filename).toBe("ledger-credit-q-customer.csv");
    const rows = ledger.csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(rows[0]).toBe("Date,Type,Details,Credit given,Payment received,Balance");
    expect(rows).toHaveLength(1 + 4);
    expect(rows.at(-1)).toMatch(/,150\.00$/);
    expect(() => buildCsv(db, "ledger", "2026-11-21", "2026-11-21", day(0), 999)).toThrowError(/not found/i);
  });
});

describe("WhatsApp reminder link", () => {
  it("normalises Indian numbers and builds an encoded message", () => {
    expect(normalizePhone("098765 43210")).toBe("09876543210");
    expect(whatsappNumber("9876543210")).toBe("919876543210");
    expect(whatsappNumber("09876543210")).toBe("919876543210");
    expect(whatsappNumber("919876543210")).toBe("919876543210");
    const url = whatsappReminderUrl({ phone: "9876543210", name: "Lakshmi", balance: 123_450, storeName: "Sri Murugan & Co" })!;
    expect(url.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    const text = decodeURIComponent(url.split("text=")[1]!);
    expect(text).toContain("Lakshmi");
    expect(text).toContain("₹1,234.50");
    expect(text).toContain("Sri Murugan & Co");
    expect(url).not.toContain(" ");
  });
  it("gives no link without a phone or with nothing owed", () => {
    expect(whatsappReminderUrl({ phone: null, name: "A", balance: 100, storeName: "S" })).toBeNull();
    expect(whatsappReminderUrl({ phone: "9876543210", name: "A", balance: 0, storeName: "S" })).toBeNull();
  });
});
