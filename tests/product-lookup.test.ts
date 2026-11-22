import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveProduct } from "@/services/inventory";
import { parseOpenFactsProduct } from "@/lib/productLookup";
import { _clearLookupCache, lookupBarcode, USER_AGENT, type LookupSource } from "@/services/productLookup";
import { makeDb, newProduct, NOW } from "./helpers";

const SRC = { label: "Open Food Facts", category: "grocery" as const };

describe("parseOpenFactsProduct", () => {
  const ok = (product: Record<string, unknown>) => ({ status: 1, product });
  it("builds a clean name from brand, product name and size", () => {
    expect(parseOpenFactsProduct(ok({ product_name: "Biscuits", brands: "Britannia", quantity: "100g" }), SRC, "1")?.name).toBe("Britannia Biscuits 100g");
  });
  it("does not repeat the brand or size already in the name", () => {
    expect(parseOpenFactsProduct(ok({ product_name: "Parle-G Gold", brands: "Parle", quantity: "200 g" }), SRC, "1")?.name).toBe("Parle-G Gold 200 g");
    expect(parseOpenFactsProduct(ok({ product_name: "Sunflower Oil 1 L", brands: "Fortune", quantity: "1 L" }), SRC, "1")?.name).toBe("Fortune Sunflower Oil 1 L");
  });
  it("uses the first brand, falls back to brand alone, and caps the length", () => {
    expect(parseOpenFactsProduct(ok({ product_name: "Tea", brands: "Tata, Tetley" }), SRC, "1")).toMatchObject({ brand: "Tata", name: "Tata Tea" });
    expect(parseOpenFactsProduct(ok({ brands: "Amul" }), SRC, "1")?.name).toBe("Amul");
    expect(parseOpenFactsProduct(ok({ product_name: "x".repeat(300) }), SRC, "1")?.name).toHaveLength(120);
  });
  it("returns null for missing products, status 0, empty data and junk", () => {
    expect(parseOpenFactsProduct({ status: 0 }, SRC, "1")).toBeNull();
    expect(parseOpenFactsProduct(ok({}), SRC, "1")).toBeNull();
    expect(parseOpenFactsProduct(ok({ product_name: 42, brands: ["x"] }), SRC, "1")).toBeNull();
    for (const junk of [null, undefined, "str", 5, []]) expect(parseOpenFactsProduct(junk, SRC, "1")).toBeNull();
  });
  it("keeps only https image URLs", () => {
    expect(parseOpenFactsProduct(ok({ product_name: "A", image_front_small_url: "https://img.test/a.jpg" }), SRC, "1")?.imageUrl).toBe("https://img.test/a.jpg");
    expect(parseOpenFactsProduct(ok({ product_name: "A", image_front_small_url: "javascript:alert(1)" }), SRC, "1")?.imageUrl).toBeNull();
    expect(parseOpenFactsProduct(ok({ product_name: "A", image_front_small_url: "http://img.test/a.jpg" }), SRC, "1")?.imageUrl).toBeNull();
  });
});

const sources: LookupSource[] = [
  { label: "Open Food Facts", base: "https://food.test", category: "grocery" },
  { label: "Open Beauty Facts", base: "https://beauty.test", category: "general" },
  { label: "Open Products Facts", base: "https://products.test", category: "general" },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hit = (name: string) => json({ status: 1, product: { product_name: name } });
const miss = () => json({ status: 0, status_verbose: "product not found" });

/** Build a fetch mock that routes by host. */
function fetchBy(handlers: Record<string, (url: string) => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const host = new URL(url).host;
    const h = handlers[host];
    if (!h) throw new Error("unexpected host " + host);
    return h(url);
  });
}
const lookup = (db: ReturnType<typeof makeDb>, code: string, f: ReturnType<typeof fetchBy>, extra = {}) =>
  lookupBarcode(db, code, { fetchImpl: f as unknown as typeof fetch, sources, ...extra });

beforeEach(() => {
  _clearLookupCache();
  delete process.env.PRODUCT_LOOKUP_BASE;
});

describe("lookupBarcode", () => {
  it("returns the product found online, and sends only the digits with a generic User-Agent", async () => {
    const f = fetchBy({ "food.test": () => hit("Parle-G 200 g"), "beauty.test": miss, "products.test": miss });
    const r = await lookup(makeDb(), "4006381333931", f);
    expect(r).toMatchObject({ status: "found", valid: true, local: null, barcode: "4006381333931" });
    expect(r.suggestions.map((s) => [s.source, s.name, s.category])).toEqual([["Open Food Facts", "Parle-G 200 g", "grocery"]]);
    expect(f).toHaveBeenCalledTimes(3);
    for (const [url, init] of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toMatch(/\/api\/v2\/product\/4006381333931\.json\?fields=[a-z_,]+$/);
      const headers = init.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      expect(USER_AGENT).not.toMatch(/@|\.com|shop|store/i);
    }
  });

  it("offers each distinct hit so the user can choose, and collapses duplicates", async () => {
    const two = fetchBy({ "food.test": () => hit("Lifebuoy Soap"), "beauty.test": () => hit("Lifebuoy Soap Red 100 g"), "products.test": miss });
    const r = await lookup(makeDb(), "4006381333931", two);
    expect(r.suggestions.map((s) => s.name)).toEqual(["Lifebuoy Soap", "Lifebuoy Soap Red 100 g"]);
    _clearLookupCache();
    const same = fetchBy({ "food.test": () => hit("Lifebuoy soap"), "beauty.test": () => hit("LIFEBUOY SOAP"), "products.test": miss });
    expect((await lookup(makeDb(), "4006381333931", same)).suggestions).toHaveLength(1);
  });

  it("reports not_found for status 0 or 404 everywhere", async () => {
    const f = fetchBy({ "food.test": miss, "beauty.test": () => json({}, 404), "products.test": miss });
    expect(await lookup(makeDb(), "4006381333931", f)).toMatchObject({ status: "not_found", suggestions: [] });
  });

  it("reports offline only when every source failed; one working source is enough", async () => {
    const down = () => {
      throw new TypeError("fetch failed");
    };
    expect((await lookup(makeDb(), "4006381333931", fetchBy({ "food.test": down, "beauty.test": down, "products.test": () => json({}, 503) }))).status).toBe("offline");
    _clearLookupCache();
    expect((await lookup(makeDb(), "4006381333931", fetchBy({ "food.test": down, "beauty.test": miss, "products.test": miss }))).status).toBe("not_found");
    _clearLookupCache();
    const r = await lookup(makeDb(), "4006381333931", fetchBy({ "food.test": down, "beauty.test": () => hit("Found It"), "products.test": miss }));
    expect(r.status).toBe("found");
  });

  it("treats malformed JSON and timeouts as a failed source, not a crash", async () => {
    const bad = () => new Response("<html>oops</html>", { status: 200 });
    const timeout = () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    expect((await lookup(makeDb(), "4006381333931", fetchBy({ "food.test": bad, "beauty.test": timeout, "products.test": bad }))).status).toBe("offline");
  });

  it("tries the 13-digit form for a 12-digit UPC-A", async () => {
    const f = fetchBy({
      "food.test": (u) => (u.includes("/0036000291452.json") ? hit("Kleenex Tissues") : json({}, 404)),
      "beauty.test": () => json({}, 404),
      "products.test": () => json({}, 404),
    });
    const r = await lookup(makeDb(), "036000291452", f);
    expect(r.status).toBe("found");
    expect(r.suggestions[0]).toMatchObject({ name: "Kleenex Tissues", barcode: "0036000291452" });
  });

  it("flags a probable misread (bad check digit) but still looks it up", async () => {
    const f = fetchBy({ "food.test": miss, "beauty.test": miss, "products.test": miss });
    const r = await lookup(makeDb(), "4006381333932", f);
    expect(r.valid).toBe(false);
    expect(f).toHaveBeenCalled();
  });

  it("finds a product already in the inventory, active or archived, without going online", async () => {
    const db = makeDb();
    const p = newProduct(db, { name: "Mine", barcode: "4006381333931" });
    const f = fetchBy({});
    expect(await lookup(db, "4006381333931", f)).toMatchObject({ status: "found", local: { id: p.id, name: "Mine", isActive: true }, suggestions: [] });
    archiveProduct(db, p.id, NOW);
    expect((await lookup(db, "4006381333931", f)).local).toMatchObject({ id: p.id, isActive: false });
    // stored as EAN-13 with a leading zero, scanned as 12-digit UPC-A
    newProduct(db, { name: "Kleenex", barcode: "0036000291452" });
    expect((await lookup(db, "036000291452", f)).local?.name).toBe("Kleenex");
    expect(f).not.toHaveBeenCalled();
  });

  it("never makes a request for input that is not a plain barcode", async () => {
    const f = fetchBy({});
    for (const bad of ["abc", "../../etc/passwd", "http://evil.test/123456", "12", "123456789012345678", "1234567890123; rm -rf"]) {
      expect(await lookup(makeDb(), bad, f)).toMatchObject({ status: "invalid", barcode: null, suggestions: [] });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("normalises spaces and hyphens before using the code", async () => {
    const f = fetchBy({ "food.test": miss, "beauty.test": miss, "products.test": miss });
    expect((await lookup(makeDb(), " 400 638-1333931 ", f)).barcode).toBe("4006381333931");
  });

  it("caches answers for a day, but never caches a failure", async () => {
    const db = makeDb();
    const f = fetchBy({ "food.test": () => hit("Cached"), "beauty.test": miss, "products.test": miss });
    await lookup(db, "4006381333931", f, { now: 0 });
    await lookup(db, "4006381333931", f, { now: 3_600_000 });
    expect(f).toHaveBeenCalledTimes(3); // second call served from cache
    await lookup(db, "4006381333931", f, { now: 25 * 3_600_000 });
    expect(f).toHaveBeenCalledTimes(6); // expired, refetched

    const flaky = vi.fn()
      .mockRejectedValueOnce(new TypeError("down"))
      .mockImplementation(async () => miss());
    await lookupBarcode(db, "8901058852417", { fetchImpl: flaky as unknown as typeof fetch, sources: [sources[0]!] });
    await lookupBarcode(db, "8901058852417", { fetchImpl: flaky as unknown as typeof fetch, sources: [sources[0]!] });
    expect(flaky).toHaveBeenCalledTimes(2); // the failed first attempt wasn't cached
  });

  it("honours PRODUCT_LOOKUP_BASE as a single override source", async () => {
    process.env.PRODUCT_LOOKUP_BASE = "http://stub.local:9999/";
    const f = vi.fn(async (url: string) => (url ? hit("From Stub") : miss()));
    const r = await lookupBarcode(makeDb(), "4006381333931", { fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toMatch(/^http:\/\/stub\.local:9999\/api\/v2\/product\/4006381333931\.json/);
    expect(r.suggestions[0]!.name).toBe("From Stub");
  });
});
