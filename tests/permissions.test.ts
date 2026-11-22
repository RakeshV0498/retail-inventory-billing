import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, type Permission } from "@/lib/permissions";

const STAFF_ALLOWED: Permission[] = ["sale.create", "customer.create", "payment.record", "product.create", "stock.receive"];
const ADMIN_ONLY: Permission[] = [
  "sale.void", "sale.amend", "sale.edit", "payment.void", "product.edit", "product.archive", "product.delete", "batch.edit",
  "stock.adjust", "stock.writeoff", "customer.edit", "reports.view", "settings.edit", "users.manage", "audit.view",
];

describe("permission matrix", () => {
  it("covers every permission exactly once", () => {
    expect([...PERMISSIONS].sort()).toEqual([...STAFF_ALLOWED, ...ADMIN_ONLY].sort());
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("admins can do everything", () => {
    for (const p of PERMISSIONS) expect(can("admin", p), p).toBe(true);
  });

  it("staff can bill, add customers, take dues payments, add products and receive stock, and nothing else", () => {
    for (const p of STAFF_ALLOWED) expect(can("staff", p), p).toBe(true);
    for (const p of ADMIN_ONLY) expect(can("staff", p), p).toBe(false);
  });

  it("with no accounts set up (open mode) everything is allowed, exactly as before accounts existed", () => {
    for (const p of PERMISSIONS) expect(can(null, p), p).toBe(true);
  });
});
