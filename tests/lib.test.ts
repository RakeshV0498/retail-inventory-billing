import { describe, expect, it } from "vitest";
import { addDaysISO, daysBetween, isExpired } from "@/lib/dates";
import { allocateFefo, sortFefo, StockError, type BatchLike } from "@/lib/fefo";
import { calcInvoiceTotals, calcLine, splitFlatDiscount, splitGst, type GstRate } from "@/lib/gst";
import { divRound, formatPaise, rupeesToPaise } from "@/lib/money";
import { assertValidQty, formatQty, QtyError, toMilli } from "@/lib/qty";

const b = (id: number, expiry: string | null, qty: number, created = "2026-01-01T00:00:00Z"): BatchLike => ({
  id,
  expiryDate: expiry,
  quantityAvailable: qty,
  createdAt: created,
});

describe("money & qty conversion", () => {
  it("parses rupees to paise without float error", () => {
    expect(rupeesToPaise("12.5")).toBe(1250);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30); // 0.30000000000000004 -> "0.30"
    expect(rupeesToPaise("199")).toBe(19900);
    expect(() => rupeesToPaise("1.234")).toThrow();
    expect(() => rupeesToPaise("abc")).toThrow();
  });
  it("formats INR", () => {
    expect(formatPaise(123456)).toBe("₹1,234.56");
  });
  it("divRound rounds half away from zero", () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 3)).toBe(1);
    expect(divRound(1, 3)).toBe(0);
  });
  it("converts quantities to integer milli-units", () => {
    expect(toMilli("0.25")).toBe(250);
    expect(toMilli(1.5)).toBe(1500);
    expect(toMilli("3")).toBe(3000);
    expect(toMilli("0.1") + toMilli("0.2")).toBe(toMilli("0.3"));
    expect(formatQty(1500)).toBe("1.5");
    expect(() => toMilli("1.2345")).toThrow();
    expect(() => toMilli("-1")).toThrow();
  });
  it("only allows fractions for decimal products", () => {
    expect(() => assertValidQty(500, false)).toThrow(QtyError);
    expect(() => assertValidQty(2000, false)).not.toThrow();
    expect(() => assertValidQty(250, true)).not.toThrow();
    expect(() => assertValidQty(0, true)).toThrow(QtyError);
  });
});

describe("dates", () => {
  it("expiry is strictly before today; expiring today is still sellable", () => {
    expect(isExpired("2026-11-20", "2026-11-21")).toBe(true);
    expect(isExpired("2026-11-21", "2026-11-21")).toBe(false);
    expect(isExpired(null, "2026-11-21")).toBe(false);
  });
  it("date math", () => {
    expect(addDaysISO("2026-11-21", 30)).toBe("2026-12-21");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-11-21", "2026-12-21")).toBe(30);
    expect(daysBetween("2026-11-21", "2026-11-20")).toBe(-1);
  });
});

describe("FEFO allocation", () => {
  it("sorts earliest expiry first, no-expiry last, ties by created then id", () => {
    const sorted = sortFefo([
      b(1, null, 5),
      b(2, "2027-01-01", 5),
      b(3, "2026-12-01", 5, "2026-02-01T00:00:00Z"),
      b(4, "2026-12-01", 5, "2026-01-01T00:00:00Z"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual([4, 3, 2, 1]);
  });

  it("takes from the earliest-expiring batch first and spills over", () => {
    const out = allocateFefo([b(1, "2027-06-01", 5000), b(2, "2026-12-01", 3000)], 4000, "2026-11-21");
    expect(out).toEqual([
      { batchId: 2, quantity: 3000 },
      { batchId: 1, quantity: 1000 },
    ]);
  });

  it("never allocates expired batches, even if they expire earliest", () => {
    const out = allocateFefo([b(1, "2026-11-01", 9000), b(2, "2027-01-01", 2000)], 2000, "2026-11-21");
    expect(out).toEqual([{ batchId: 2, quantity: 2000 }]);
  });

  it("fails when only expired stock remains", () => {
    expect(() => allocateFefo([b(1, "2026-11-01", 9000)], 1000, "2026-11-21")).toThrowError(
      expect.objectContaining({ code: "ONLY_EXPIRED_STOCK" }),
    );
  });

  it("fails when sellable stock is insufficient (expired stock not counted)", () => {
    const fn = () => allocateFefo([b(1, "2026-11-01", 9000), b(2, "2027-01-01", 1000)], 2000, "2026-11-21");
    expect(fn).toThrow(StockError);
    expect(fn).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_STOCK" }));
  });

  it("skips empty batches and handles decimal quantities exactly", () => {
    const out = allocateFefo([b(1, "2026-12-01", 0), b(2, "2027-01-01", 1500)], 250, "2026-11-21");
    expect(out).toEqual([{ batchId: 2, quantity: 250 }]);
  });
});

describe("GST, discount and rounding math", () => {
  const line = (unitPrice: number, quantity: number, gstRate: GstRate, d: "none" | "percent" | "flat" = "none", v = 0) =>
    calcLine({ unitPrice, quantity, gstRate, discountType: d, discountValue: v });

  it("back-calculates tax from inclusive price for every slab", () => {
    expect(line(10000, 1000, 0)).toMatchObject({ lineTotal: 10000, taxableAmount: 10000, taxAmount: 0 });
    expect(line(10500, 1000, 5)).toMatchObject({ taxableAmount: 10000, taxAmount: 500 });
    expect(line(11200, 1000, 12)).toMatchObject({ taxableAmount: 10000, taxAmount: 1200 });
    expect(line(11800, 1000, 18)).toMatchObject({ taxableAmount: 10000, taxAmount: 1800 });
  });

  it("taxable + tax always equals the line total (no drift)", () => {
    for (const rate of [0, 5, 12, 18] as const) {
      for (const price of [1, 33, 999, 12345, 99999]) {
        for (const qty of [250, 1000, 1500, 7000]) {
          const r = line(price, qty, rate);
          expect(r.taxableAmount + r.taxAmount).toBe(r.lineTotal);
        }
      }
    }
  });

  it("prices decimal weights: 0.25 kg and 1.5 kg", () => {
    expect(line(6400, 250, 0).lineTotal).toBe(1600); // 0.25kg @ ₹64
    const sugar = line(4600, 1500, 5); // 1.5kg @ ₹46, 5% GST
    expect(sugar.lineTotal).toBe(6900);
    expect(sugar.taxableAmount).toBe(6571);
    expect(sugar.taxAmount).toBe(329);
  });

  it("applies percent and flat discounts before tax extraction", () => {
    const p = line(11200, 2000, 12, "percent", 1000); // 10% off ₹224
    expect(p).toMatchObject({ gross: 22400, discountAmount: 2240, lineTotal: 20160 });
    expect(p.taxableAmount + p.taxAmount).toBe(20160);
    const f = line(11800, 1000, 18, "flat", 1800);
    expect(f).toMatchObject({ discountAmount: 1800, lineTotal: 10000, taxableAmount: 8475, taxAmount: 1525 });
  });

  it("supports fractional percent (2.5%) and rejects invalid discounts", () => {
    expect(line(10000, 1000, 0, "percent", 250).discountAmount).toBe(250);
    expect(() => line(10000, 1000, 0, "percent", 10001)).toThrow();
    expect(() => line(10000, 1000, 0, "flat", 10001)).toThrow();
    expect(() => line(10000, 0, 0)).toThrow();
  });

  it("rounds the invoice to the nearest rupee and records round-off", () => {
    const up = calcInvoiceTotals([line(4960, 1000, 0)]);
    expect(up).toMatchObject({ netTotal: 4960, grandTotal: 5000, roundOff: 40 });
    const down = calcInvoiceTotals([line(4949, 1000, 0)]);
    expect(down).toMatchObject({ grandTotal: 4900, roundOff: -49 });
    const half = calcInvoiceTotals([line(4950, 1000, 0)]);
    expect(half.grandTotal).toBe(5000);
  });

  it("invoice totals reconcile: subtotal − discount = net; net + roundOff = grand", () => {
    const lines = [line(11200, 3000, 12, "percent", 500), line(4600, 1500, 5), line(2799, 7000, 18, "flat", 1234)];
    const t = calcInvoiceTotals(lines);
    expect(t.subtotal - t.discountTotal).toBe(t.netTotal);
    expect(t.taxableTotal + t.taxTotal).toBe(t.netTotal);
    expect(t.netTotal + t.roundOff).toBe(t.grandTotal);
    expect(t.grandTotal % 100).toBe(0);
  });

  it("splits CGST/SGST without losing paise", () => {
    expect(splitGst(5303)).toEqual({ cgst: 2652, sgst: 2651 });
    expect(splitGst(100)).toEqual({ cgst: 50, sgst: 50 });
  });

  it("distributes a flat discount exactly across batches", () => {
    const parts = splitFlatDiscount(1001, [1000, 2000, 3000]);
    expect(parts.reduce((a, c) => a + c, 0)).toBe(1001);
    expect(splitFlatDiscount(500, [4000])).toEqual([500]);
  });
});
