import { allocateFefo, StockError, type Allocation, type BatchLike } from "./fefo";
import { calcLine, splitFlatDiscount, type DiscountType, type GstRate, type LineResult } from "./gst";

export interface PricedBatch extends BatchLike {
  batchNumber: string;
  /** GST-inclusive, paise */
  sellingPrice: number;
  /** Near-expiry markdown for this batch, hundredths of a percent (0 = none). */
  markdownPercent?: number;
}

export interface CartPreview {
  allocations: (Allocation & { batchNumber: string; unitPrice: number; calc: LineResult })[];
  /** Totals across allocations (zeros when error is set). */
  lineTotal: number;
  error: string | null;
}

/** Client/server-safe preview of what billing will do for one cart line (same pure functions). */
export function previewCartLine(args: {
  batches: PricedBatch[];
  quantity: number;
  gstRate: GstRate;
  discountType: DiscountType;
  discountValue: number;
  /** Apply each batch's own near-expiry markdown (only when no manual discount is set). */
  applyMarkdown?: boolean;
  today: string;
}): CartPreview {
  const { batches, quantity, gstRate, discountType, discountValue, today, applyMarkdown } = args;
  try {
    const allocs = allocateFefo(batches, quantity, today);
    const flat = discountType === "flat" ? splitFlatDiscount(discountValue, allocs.map((a) => a.quantity)) : [];
    const allocations = allocs.map((a, i) => {
      const batch = batches.find((b) => b.id === a.batchId)!;
      const md = applyMarkdown && discountType === "none" ? (batch.markdownPercent ?? 0) : 0;
      const calc = calcLine({
        unitPrice: batch.sellingPrice,
        quantity: a.quantity,
        gstRate,
        discountType: md > 0 ? "percent" : discountType,
        discountValue: md > 0 ? md : discountType === "flat" ? (flat[i] ?? 0) : discountValue,
      });
      return { ...a, batchNumber: batch.batchNumber, unitPrice: batch.sellingPrice, calc };
    });
    return { allocations, lineTotal: allocations.reduce((s, a) => s + a.calc.lineTotal, 0), error: null };
  } catch (e) {
    const msg = e instanceof StockError || e instanceof Error ? e.message : "Invalid line";
    return { allocations: [], lineTotal: 0, error: msg };
  }
}
