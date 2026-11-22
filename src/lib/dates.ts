/** Dates are ISO `YYYY-MM-DD` strings (local calendar day) so they compare lexicographically. */

export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  return Math.round((t - f) / 86_400_000);
}

/** A batch is expired once its expiry date is strictly before today. Null expiry never expires. */
export function isExpired(expiryDate: string | null, today: string): boolean {
  return expiryDate !== null && expiryDate < today;
}

/** [start, end) ISO timestamps covering local calendar days `from`..`to` inclusive. */
export function rangeBounds(from: string, to: string): { start: string; end: string } {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return {
    start: new Date(fy, fm - 1, fd).toISOString(),
    end: new Date(ty, tm - 1, td + 1).toISOString(),
  };
}

/** `YYYY-MM-DD HH:MM` in local time, for exports. */
export function localDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${todayISO(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function firstOfMonthISO(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

/** First and last day of the month before the one containing `today`. */
export function lastMonthRange(today: string): { from: string; to: string } {
  const first = firstOfMonthISO(today);
  const to = addDaysISO(first, -1);
  return { from: firstOfMonthISO(to), to };
}
