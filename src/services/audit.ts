import { and, desc, eq } from "drizzle-orm";
import { auditLog, type AuditEntry } from "@/db/schema";
import type { Q } from "./types";

/** Who did something. `id` is null for the command line; the whole actor is null when accounts aren't set up. */
export interface Actor {
  id: number | null;
  name: string;
}

export const NO_ACCOUNTS_NAME = "(no accounts)";

/**
 * Append one line to the audit trail. Call it INSIDE the same transaction as the change it describes,
 * so a change and its record can never be separated. The table is append-only: nothing updates or deletes it.
 */
export function writeAudit(
  db: Q,
  actor: Actor | null,
  action: string,
  entityType: string,
  entityId: number | null,
  summary: string,
  now: Date = new Date(),
): void {
  db.insert(auditLog)
    .values({
      at: now.toISOString(),
      userId: actor?.id ?? null,
      username: actor?.name ?? NO_ACCOUNTS_NAME,
      action,
      entityType,
      entityId,
      summary: summary.slice(0, 500),
    })
    .run();
}

export function listAudit(db: Q, opts: { userId?: number; action?: string; limit?: number } = {}): AuditEntry[] {
  const filters = [
    opts.userId === undefined ? undefined : eq(auditLog.userId, opts.userId),
    opts.action ? eq(auditLog.action, opts.action) : undefined,
  ].filter((f) => f !== undefined);
  return db
    .select()
    .from(auditLog)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(Math.min(opts.limit ?? 200, 1000))
    .all();
}

export function auditActions(db: Q): string[] {
  const rows = db.select({ a: auditLog.action }).from(auditLog).groupBy(auditLog.action).all();
  return rows.map((r) => r.a).sort();
}
