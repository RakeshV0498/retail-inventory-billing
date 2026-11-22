/** Numeric cell: written as-is (never treated as text, so negative amounts aren't "fixed"). */
export type NumCell = { num: string };
export type Cell = string | number | null | NumCell;

export const num = (s: string): NumCell => ({ num: s });

function cell(c: Cell): string {
  if (c === null) return "";
  if (typeof c === "number") return String(c);
  if (typeof c === "object") return c.num;
  // CSV-injection guard: spreadsheets execute text that starts with these characters as formulas.
  const safe = /^[=+\-@\t\r]/.test(c) ? `'${c}` : c;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC-4180 CSV with CRLF line ends and a UTF-8 BOM so Excel reads ₹/Indian names correctly. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}
