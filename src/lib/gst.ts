import { divRound } from "./money";
import { MILLI } from "./qty";

export const GST_SLABS = [0, 5, 12, 18] as const;
export type GstRate = (typeof GST_SLABS)[number];

export type DiscountType = "none" | "percent" | "flat";

export interface LineInput {
  /** GST-inclusive unit price in paise (per 1 unit, e.g. per kg / per strip). */
  unitPrice: number;
  /** Quantity in milli-units. */
  quantity: number;
  gstRate: GstRate;
  discountType: DiscountType;
  /** See calcLine for units: hundredths of a percent, or paise for flat. */
  discountValue: number;
}

export interface LineResult {
  gross: number;
  discountAmount: number;
  /** Amount payable for the line (GST-inclusive). */
  lineTotal: number;
  taxableAmount: number;
  taxAmount: number;
}

/**
 * discountValue semantics:
 *  - "percent": hundredths of a percent (10% => 1000, 2.5% => 250). Range 0..10000.
 *  - "flat":    paise taken off the whole line.
 * Prices are GST-inclusive; tax is back-calculated from the discounted amount:
 *   taxable = round(net * 100 / (100 + rate)),  tax = net - taxable.
 */
export function calcLine(input: LineInput): LineResult {
  const { unitPrice, quantity, gstRate, discountType, discountValue } = input;
  if (!Number.isInteger(unitPrice) || unitPrice < 0) throw new Error("Invalid unit price");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Invalid quantity");

  const gross = divRound(unitPrice * quantity, MILLI);

  let discountAmount = 0;
  if (discountType === "percent") {
    if (discountValue < 0 || discountValue > 10_000) throw new Error("Percent discount must be 0-100%");
    discountAmount = divRound(gross * discountValue, 10_000);
  } else if (discountType === "flat") {
    if (discountValue < 0) throw new Error("Discount cannot be negative");
    discountAmount = discountValue;
  }
  if (discountAmount > gross) throw new Error("Discount cannot exceed line amount");

  const lineTotal = gross - discountAmount;
  const taxableAmount = divRound(lineTotal * 100, 100 + gstRate);
  const taxAmount = lineTotal - taxableAmount;
  return { gross, discountAmount, lineTotal, taxableAmount, taxAmount };
}

export interface InvoiceTotals {
  /** Sum of line gross (before discount, GST-inclusive). */
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  taxableTotal: number;
  /** Sum of line totals before rounding. */
  netTotal: number;
  /** Adjustment to round the payable to the nearest rupee (can be negative). */
  roundOff: number;
  grandTotal: number;
}

export function calcInvoiceTotals(lines: LineResult[]): InvoiceTotals {
  const subtotal = lines.reduce((s, l) => s + l.gross, 0);
  const discountTotal = lines.reduce((s, l) => s + l.discountAmount, 0);
  const taxTotal = lines.reduce((s, l) => s + l.taxAmount, 0);
  const taxableTotal = lines.reduce((s, l) => s + l.taxableAmount, 0);
  const netTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const grandTotal = divRound(netTotal, 100) * 100;
  return { subtotal, discountTotal, taxTotal, taxableTotal, netTotal, roundOff: grandTotal - netTotal, grandTotal };
}

/** Split a tax amount into CGST/SGST halves (any odd paisa goes to CGST). */
export function splitGst(taxAmount: number): { cgst: number; sgst: number } {
  const sgst = Math.floor(taxAmount / 2);
  return { cgst: taxAmount - sgst, sgst };
}
