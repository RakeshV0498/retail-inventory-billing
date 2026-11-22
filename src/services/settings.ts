import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { settings } from "@/db/schema";

export interface AppSettings {
  storeName: string;
  storeAddress: string;
  gstin: string;
  receiptFooter: string;
  /** Near-expiry window shown on the dashboard / alerts (days). */
  expiryWarnDays: number;
  /** Secondary, wider window (days). */
  expiryWatchDays: number;
  printFormat: "58" | "80" | "a4";
}

export const DEFAULT_SETTINGS: AppSettings = {
  storeName: "My Store",
  storeAddress: "",
  gstin: "",
  receiptFooter: "Thank you! Visit again.",
  expiryWarnDays: 30,
  expiryWatchDays: 60,
  printFormat: "80",
};

export function getSettings(db: Db): AppSettings {
  const rows = db.select().from(settings).all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: keyof AppSettings, d: number) => {
    const v = Number(map.get(k));
    return Number.isFinite(v) && map.has(k) ? v : d;
  };
  const fmt = map.get("printFormat");
  return {
    storeName: map.get("storeName") ?? DEFAULT_SETTINGS.storeName,
    storeAddress: map.get("storeAddress") ?? DEFAULT_SETTINGS.storeAddress,
    gstin: map.get("gstin") ?? DEFAULT_SETTINGS.gstin,
    receiptFooter: map.get("receiptFooter") ?? DEFAULT_SETTINGS.receiptFooter,
    expiryWarnDays: num("expiryWarnDays", DEFAULT_SETTINGS.expiryWarnDays),
    expiryWatchDays: num("expiryWatchDays", DEFAULT_SETTINGS.expiryWatchDays),
    printFormat: fmt === "58" || fmt === "80" || fmt === "a4" ? fmt : DEFAULT_SETTINGS.printFormat,
  };
}

export function saveSettings(db: Db, patch: Partial<AppSettings>): void {
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      tx.insert(settings)
        .values({ key, value: String(value) })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } })
        .run();
    }
  });
}

/* ---- raw key/value access (used for secrets such as the PIN hash; never returned by getSettings) ---- */

export function getSetting(db: Db, key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function deleteSetting(db: Db, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
