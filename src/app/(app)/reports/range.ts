import { addDaysISO, daysBetween, firstOfMonthISO, todayISO } from "@/lib/dates";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const valid = (s: string | null | undefined): s is string =>
  !!s && ISO.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Validate a user-supplied range: default to this month, swap if reversed, cap at 2 years. */
export function parseRange(from: string | null | undefined, to: string | null | undefined, now: Date = new Date()) {
  const today = todayISO(now);
  let f = valid(from) ? from : firstOfMonthISO(today);
  let t = valid(to) ? to : today;
  if (f > t) [f, t] = [t, f];
  if (daysBetween(f, t) > 731) f = addDaysISO(t, -731);
  return { from: f, to: t };
}
