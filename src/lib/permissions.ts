import type { ROLES } from "./constants";

/** Pure permission matrix (no server imports) so guards, pages and client components all agree. */
export type Role = (typeof ROLES)[number];

/** What a staff member may do. Everything else is admin only. */
const STAFF_PERMISSIONS = [
  "sale.create", // bill (cash/UPI/card/credit)
  "customer.create",
  "payment.record", // take money against dues
  "product.create",
  "stock.receive", // add stock batches
] as const;

const ADMIN_ONLY_PERMISSIONS = [
  "sale.void",
  "sale.amend",
  "sale.edit",
  "payment.void",
  "product.edit",
  "product.archive",
  "product.delete",
  "batch.edit",
  "stock.adjust",
  "stock.writeoff",
  "customer.edit",
  "reports.view", // reports, CSV, profit
  "settings.edit",
  "users.manage",
  "audit.view",
] as const;

export const PERMISSIONS = [...STAFF_PERMISSIONS, ...ADMIN_ONLY_PERMISSIONS] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STAFF_SET = new Set<string>(STAFF_PERMISSIONS);

/**
 * Can this role do this? `role === null` means accounts are not set up yet (open mode): everything is allowed,
 * exactly as the app behaved before accounts existed.
 */
export function can(role: Role | null, permission: Permission): boolean {
  if (role === null) return true;
  if (role === "admin") return true;
  return STAFF_SET.has(permission);
}
