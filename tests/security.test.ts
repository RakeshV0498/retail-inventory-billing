import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig, { SECURITY_HEADERS } from "../next.config";
import { createInvoice } from "@/services/billing";
import { addBatch, createProduct } from "@/services/inventory";
import { makeDb, newProduct, NOW, stock } from "./helpers";

const ROOT = path.join(__dirname, "..", "src");
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const files = walk(ROOT);
const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(ROOT, f);

describe("auth coverage (a new page/action/route must call requireAuth)", () => {
  it('only src/app/actions.ts may contain "use server"', () => {
    const offenders = files.filter((f) => /^["']use server["']/m.test(read(f))).map(rel);
    expect(offenders).toEqual(["app/actions.ts"]);
  });

  /** Every server action must be listed here with the permission it needs, so a NEW action forces a decision. */
  const ACTION_PERMISSIONS: Record<string, string> = {
    checkoutAction: "sale.create",
    createCustomerInlineAction: "customer.create",
    createCustomerAction: "customer.create",
    updateCustomerAction: "customer.edit",
    recordPaymentAction: "payment.record",
    createProductAction: "product.create",
    updateProductAction: "product.edit",
    updateBatchAction: "batch.edit",
    adjustStockAction: "stock.adjust",
    addBatchAction: "stock.receive",
    writeOffAction: "stock.writeoff",
    writeOffFromListAction: "stock.writeoff",
    writeOffAllExpiredAction: "stock.writeoff",
    archiveProductAction: "product.archive",
    restoreProductAction: "product.archive",
    deleteProductAction: "product.delete",
    saveSettingsAction: "settings.edit",
    voidInvoiceAction: "sale.void",
    amendInvoiceAction: "sale.amend",
    updateInvoiceDetailsAction: "sale.edit",
    voidPaymentAction: "payment.void",
    createUserAction: "users.manage",
    resetUserPinAction: "users.manage",
    setUserRoleAction: "users.manage",
    setUserActiveAction: "users.manage",
  };
  /** Any signed-in user (read-only lookups, own PIN, first-run setup that the service itself refuses once accounts exist). */
  const SIGNED_IN_ONLY = ["searchProductsAction", "barcodeLookupAction", "lookupBarcodeAction", "searchCustomersAction", "changeOwnPinAction", "setupFirstAdminAction"];
  /** Must work signed out. */
  const PUBLIC_ACTIONS = ["loginAction", "logoutAction"];

  it("every server action declares exactly the permission it needs", () => {
    const src = read(path.join(ROOT, "app", "actions.ts"));
    const parts = src.split(/\nexport async function /).slice(1);
    expect(parts.length).toBeGreaterThan(25);
    const known = new Set([...Object.keys(ACTION_PERMISSIONS), ...SIGNED_IN_ONLY, ...PUBLIC_ACTIONS]);
    const problems: string[] = [];
    for (const part of parts) {
      const name = part.slice(0, part.indexOf("("));
      const head = part.slice(0, 700);
      if (!known.has(name)) problems.push(`${name}: not classified in security.test.ts`);
      else if (PUBLIC_ACTIONS.includes(name)) continue;
      else if (name in ACTION_PERMISSIONS) {
        if (!head.includes(`requirePermission("${ACTION_PERMISSIONS[name]}")`)) problems.push(`${name}: must call requirePermission("${ACTION_PERMISSIONS[name]}")`);
      } else if (!head.includes("await requireAuth()")) problems.push(`${name}: must call requireAuth()`);
    }
    expect(problems).toEqual([]);
  });

  it("every page under (app) and every route handler is guarded (requireAuth or requirePermission)", () => {
    const targets = files.filter((f) => /[\\/]\(app\)[\\/].*page\.tsx$/.test(f) || /route\.ts$/.test(f));
    expect(targets.length).toBeGreaterThan(10);
    expect(targets.filter((f) => !/requireAuth\(\)|requirePermission\(/.test(read(f))).map(rel)).toEqual([]);
  });

  it("admin-only pages and downloads demand their permission", () => {
    const ADMIN_PAGES: Record<string, string> = {
      "app/(app)/reports/page.tsx": "reports.view",
      "app/(app)/reports/export/route.ts": "reports.view",
      "app/(app)/inventory/[id]/edit/page.tsx": "product.edit",
      "app/(app)/inventory/[id]/batches/[batchId]/page.tsx": "batch.edit",
      "app/(app)/inventory/new/page.tsx": "product.create",
      "app/(app)/activity/page.tsx": "audit.view",
      "app/(app)/invoices/[id]/edit/page.tsx": "sale.edit",
      "app/(app)/invoices/[id]/amend/page.tsx": "sale.amend",
    };
    const wrong = Object.entries(ADMIN_PAGES)
      .filter(([f, perm]) => !read(path.join(ROOT, f)).includes(`requirePermission("${perm}")`))
      .map(([f, perm]) => `${f} needs requirePermission("${perm}")`);
    expect(wrong).toEqual([]);
  });

  it("the (app) layout also checks auth, and isAuthed reads cookies before any early return", () => {
    expect(read(path.join(ROOT, "app", "(app)", "layout.tsx"))).toContain("requireAuth()");
    const session = read(path.join(ROOT, "lib", "session.ts"));
    expect(session.indexOf("await cookies()")).toBeGreaterThan(-1);
    expect(session.indexOf("await cookies()")).toBeLessThan(session.indexOf("return true"));
  });

  it("client components never import the database layer", () => {
    const clients = files.filter((f) => /\.tsx?$/.test(f) && /^["']use client["']/m.test(read(f)));
    expect(clients.length).toBeGreaterThan(3);
    const bad = clients.filter((f) => /from ["']@\/db\/(client|schema)["']|better-sqlite3/.test(read(f))).map(rel);
    expect(bad).toEqual([]);
  });
});

describe("security headers", () => {
  it("are applied to every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS }]);
    const h = Object.fromEntries(SECURITY_HEADERS.map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Permissions-Policy"]).toContain("camera=(self)");
    expect(h["Permissions-Policy"]).toContain("microphone=()");
  });
});

describe("input caps at the service boundary", () => {
  const base = { sku: "S", category: "grocery", unitType: "pcs", gstRate: 0 } as const;

  it("rejects oversized text and numbers", () => {
    const db = makeDb();
    expect(() => createProduct(db, { ...base, name: "x".repeat(201) })).toThrow();
    expect(() => createProduct(db, { ...base, name: "ok", sku: "s".repeat(61) })).toThrow();
    expect(() => createProduct(db, { ...base, name: "ok", barcode: "1".repeat(41) })).toThrow();
    expect(() => createProduct(db, { ...base, name: "ok", lowStockThreshold: 2_000_000_000 })).toThrow();
    expect(createProduct(db, { ...base, name: "x".repeat(200) }).name).toHaveLength(200);

    const p = newProduct(db);
    const b = { productId: p.id, batchNumber: "B", purchasePrice: 1, mrp: 2, sellingPrice: 2, quantity: 1_000 };
    expect(() => addBatch(db, { ...b, batchNumber: "b".repeat(61) }, NOW)).toThrow();
    expect(() => addBatch(db, { ...b, mrp: 2_000_000_000, sellingPrice: 2_000_000_000 }, NOW)).toThrow();
    expect(() => addBatch(db, { ...b, quantity: 2_000_000_000 }, NOW)).toThrow();
  });

  it("rejects an oversized cart and absurd quantities/amounts without touching stock", () => {
    const db = makeDb();
    const p = newProduct(db, { unitType: "pcs" });
    stock(db, p.id, { batch: "A", qtyMilli: 500_000 });
    const line = { productId: p.id, quantity: 1_000 };
    expect(() => createInvoice(db, { items: Array.from({ length: 201 }, () => line), paymentMode: "cash" }, NOW)).toThrowError(/Too many lines/);
    expect(() => createInvoice(db, { items: [{ ...line, quantity: 2_000_000_000 }], paymentMode: "cash" }, NOW)).toThrow();
    expect(() => createInvoice(db, { items: [line], paymentMode: "cash", customerName: "n".repeat(101) }, NOW)).toThrow();
    expect(() => createInvoice(db, { items: [line], paymentMode: "split", split: { cash: 99_999_999_999 } }, NOW)).toThrow();
    expect(createInvoice(db, { items: Array.from({ length: 200 }, () => line), paymentMode: "cash" }, NOW).items).toHaveLength(200); // exactly at the cap is fine: one invoice line per cart line
  });
});
