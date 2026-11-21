/** Quantities are integer milli-units: 1.5 kg = 1500, 3 strips = 3000. */

export const MILLI = 1000;

/** Convert a user-entered quantity ("1.5", 3) into milli-units. Max 3 decimals. */
export function toMilli(qty: number | string): number {
  const s = typeof qty === "number" ? String(qty) : qty.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new Error(`Invalid quantity: ${qty}`);
  const [whole = "0", frac = ""] = s.split(".");
  return Number(whole) * MILLI + Number(frac.padEnd(3, "0"));
}

export function fromMilli(milli: number): number {
  return milli / MILLI;
}

/** Display without trailing zeros: 1500 -> "1.5", 3000 -> "3". */
export function formatQty(milli: number): string {
  return String(fromMilli(milli));
}

export class QtyError extends Error {}

/** Validates a milli quantity for a product. Throws QtyError when invalid. */
export function assertValidQty(milli: number, allowDecimal: boolean): void {
  if (!Number.isInteger(milli) || milli <= 0) throw new QtyError("Quantity must be greater than zero");
  if (!allowDecimal && milli % MILLI !== 0) {
    throw new QtyError("This product cannot be sold in fractional quantities");
  }
}
