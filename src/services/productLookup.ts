import { and, inArray, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { products } from "@/db/schema";
import { isValidGtin, lookupVariants, normalizeBarcode } from "@/lib/barcode";
import { parseOpenFactsProduct, type SourceInfo, type Suggestion } from "@/lib/productLookup";

/**
 * Online barcode lookup against the Open Food Facts family (free, open, no API key).
 * Only the digits of the barcode are ever sent. Hosts come from a fixed list, never from user input.
 */

export interface LookupSource extends SourceInfo {
  base: string;
}

export const DEFAULT_SOURCES: LookupSource[] = [
  { label: "Open Food Facts", base: "https://world.openfoodfacts.org", category: "grocery" },
  { label: "Open Beauty Facts", base: "https://world.openbeautyfacts.org", category: "general" },
  { label: "Open Products Facts", base: "https://world.openproductsfacts.org", category: "general" },
];

export const USER_AGENT = "retail-inventory-billing/0.1 (open-source, self-hosted)";
const TIMEOUT_MS = 4000;
const CACHE_MS = 24 * 3600 * 1000;
const CACHE_MAX = 200;

export type LookupStatus = "found" | "not_found" | "offline" | "invalid";

export interface LocalMatch {
  id: number;
  name: string;
  isActive: boolean;
}

export interface LookupResult {
  barcode: string | null;
  /** GS1 check digit matches (false => the scan was probably misread). */
  valid: boolean;
  /** A product with this barcode already exists (active or archived). */
  local: LocalMatch | null;
  suggestions: Suggestion[];
  status: LookupStatus;
}

export interface LookupOptions {
  fetchImpl?: typeof fetch;
  sources?: LookupSource[];
  now?: number;
  /** When editing a product, its own barcode is not a duplicate. */
  excludeProductId?: number;
}

const cache = new Map<string, { at: number; suggestions: Suggestion[] }>();
export function _clearLookupCache() {
  cache.clear();
}

function activeSources(opts: LookupOptions): LookupSource[] {
  if (opts.sources) return opts.sources;
  const override = process.env.PRODUCT_LOOKUP_BASE;
  if (override) return [{ label: "Product database", base: override.replace(/\/+$/, ""), category: "grocery" }];
  return DEFAULT_SOURCES;
}

type SourceOutcome = { kind: "hit"; suggestion: Suggestion } | { kind: "miss" } | { kind: "error" };

async function querySource(src: LookupSource, variants: string[], doFetch: typeof fetch): Promise<SourceOutcome> {
  for (const code of variants) {
    const url = `${src.base}/api/v2/product/${encodeURIComponent(code)}.json?fields=code,product_name,brands,quantity,image_front_small_url`;
    try {
      const res = await doFetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (res.status === 404) continue; // not in this database
      if (!res.ok) return { kind: "error" };
      const suggestion = parseOpenFactsProduct(await res.json(), src, code);
      if (suggestion) return { kind: "hit", suggestion };
    } catch {
      return { kind: "error" }; // network down, timeout, or malformed JSON
    }
  }
  return { kind: "miss" };
}

export async function lookupBarcode(db: Db, raw: string, opts: LookupOptions = {}): Promise<LookupResult> {
  const barcode = normalizeBarcode(raw);
  if (!barcode) return { barcode: null, valid: false, local: null, suggestions: [], status: "invalid" };

  const variants = lookupVariants(barcode);
  const valid = isValidGtin(barcode);

  // 1. Already in the user's own inventory (including archived products)?
  const mine = db
    .select({ id: products.id, name: products.name, isActive: products.isActive })
    .from(products)
    .where(
      opts.excludeProductId === undefined
        ? inArray(products.barcode, variants)
        : and(inArray(products.barcode, variants), ne(products.id, opts.excludeProductId)),
    )
    .get();
  if (mine) return { barcode, valid, local: mine, suggestions: [], status: "found" };

  // 2. Online lookup, cached for a day so repeat scans don't hit the public servers.
  const sources = activeSources(opts);
  const now = opts.now ?? Date.now();
  const key = `${barcode}|${sources.map((s) => s.base).join(",")}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) {
    return { barcode, valid, local: null, suggestions: hit.suggestions, status: hit.suggestions.length ? "found" : "not_found" };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const outcomes = await Promise.all(sources.map((s) => querySource(s, variants, doFetch)));

  const suggestions: Suggestion[] = [];
  for (const o of outcomes) {
    if (o.kind !== "hit") continue;
    if (!suggestions.some((s) => s.name.toLowerCase() === o.suggestion.name.toLowerCase())) suggestions.push(o.suggestion);
  }
  const allFailed = outcomes.length > 0 && outcomes.every((o) => o.kind === "error");
  const anyError = outcomes.some((o) => o.kind === "error");

  if (!anyError) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, suggestions });
  }
  return {
    barcode,
    valid,
    local: null,
    suggestions,
    status: suggestions.length ? "found" : allFailed ? "offline" : "not_found",
  };
}
