/** Shared enums (no DB imports) so client components can use them without pulling in the database layer. */
export const CATEGORIES = ["grocery", "medical", "general"] as const;
export const UNIT_TYPES = ["pcs", "kg", "g", "strip", "bottle"] as const;
export const ROLES = ["admin", "staff"] as const;
