/** Barcode helpers (pure). Digits only ever reach a URL, so user input can never steer a request elsewhere. */

/** Strip spaces/hyphens; accept 6-14 digits, otherwise null. */
export function normalizeBarcode(raw: string): string | null {
  const d = raw.trim().replace(/[\s-]/g, "");
  return /^\d{6,14}$/.test(d) ? d : null;
}

/** GS1 check digit for EAN-8 / UPC-A / EAN-13 / GTIN-14. A mismatch usually means a misread scan. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += (digits[i] as number) * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** Forms of a code worth trying: a 12-digit UPC-A is stored as zero-padded EAN-13 by most databases. */
export function lookupVariants(code: string): string[] {
  return code.length === 12 ? [code, `0${code}`] : [code];
}
