/** Parsing of Open Food Facts-style product responses (pure; no network). */

export type SuggestedCategory = "grocery" | "general";

export interface Suggestion {
  /** Which database it came from, shown to the user. */
  source: string;
  barcode: string;
  /** Ready-to-edit product name, e.g. "Parle-G Gold Biscuits 200 g". */
  name: string;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
  category: SuggestedCategory;
}

export interface SourceInfo {
  label: string;
  category: SuggestedCategory;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/**
 * Turn a v2 `/api/v2/product/<code>.json` body into a suggestion, or null when the product
 * isn't there or has nothing useful. Tolerates missing fields and wrong types.
 */
export function parseOpenFactsProduct(json: unknown, source: SourceInfo, barcode: string): Suggestion | null {
  if (typeof json !== "object" || json === null) return null;
  const root = json as Record<string, unknown>;
  if (root.status !== 1 && root.status !== "success") return null;
  const product = root.product;
  if (typeof product !== "object" || product === null) return null;
  const p = product as Record<string, unknown>;

  const base = str(p.product_name);
  const brand = str(p.brands)?.split(",")[0]?.trim() || null;
  const quantity = str(p.quantity);
  if (!base && !brand) return null;

  let name = base ?? brand ?? "";
  if (brand && base && !squash(base).includes(squash(brand))) name = `${brand} ${base}`;
  if (quantity && !squash(name).includes(squash(quantity))) name = `${name} ${quantity}`;
  name = name.replace(/\s+/g, " ").trim().slice(0, 120);

  const image = str(p.image_front_small_url);
  return {
    source: source.label,
    barcode,
    name,
    brand,
    quantity,
    imageUrl: image && image.startsWith("https://") ? image : null,
    category: source.category,
  };
}
