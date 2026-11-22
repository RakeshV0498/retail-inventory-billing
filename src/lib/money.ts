/** Money is always integer paise. Floats are only used at the UI edge. */

/** Parse a rupee string/number (e.g. "12.5", 12.5) into integer paise. */
export function rupeesToPaise(rupees: number | string): number {
  const s = typeof rupees === "number" ? rupees.toFixed(2) : rupees.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid rupee amount: ${rupees}`);
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -paise : paise;
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}

/** Integer division with round-half-up (half away from zero), no float math. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error("Division by zero");
  const sign = numerator < 0 !== denominator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** Plain decimal rupees from paise using integer math only: 123456 -> "1234.56", -5 -> "-0.05". For CSV/export. */
export function paiseToDecimal(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg && abs !== 0 ? `-${s}` : s;
}
