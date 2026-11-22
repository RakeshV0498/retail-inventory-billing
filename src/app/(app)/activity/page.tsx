import Link from "next/link";
import { getDb } from "@/db/client";
import { localDateTime } from "@/lib/dates";
import { requirePermission } from "@/lib/session";
import { auditActions, listAudit } from "@/services/audit";
import { listUsers } from "@/services/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity · Retail Billing" };

const LABELS: Record<string, string> = {
  "user.create": "Account created",
  "user.reset_pin": "PIN reset",
  "user.change_pin": "PIN changed",
  "user.set_role": "Role changed",
  "user.activate": "Account reactivated",
  "user.deactivate": "Account deactivated",
};

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ user?: string; action?: string }> }) {
  await requirePermission("audit.view");
  const sp = await searchParams;
  const db = getDb();
  const userId = sp.user && Number.isInteger(Number(sp.user)) ? Number(sp.user) : undefined;
  const action = sp.action && auditActions(db).includes(sp.action) ? sp.action : undefined;
  const rows = listAudit(db, { userId, action, limit: 300 });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <Link href="/settings" className="text-sm text-emerald-800 hover:underline">← Settings</Link>
        <h1 className="text-xl font-bold md:text-2xl">Activity log</h1>
        <p className="text-sm text-slate-600">Who did what, newest first. This record can&apos;t be edited or deleted.</p>
      </div>

      <form className="card grid grid-cols-2 gap-3 md:grid-cols-4 md:items-end">
        <label className="text-sm">Person
          <select name="user" defaultValue={userId ?? ""} className="block w-full">
            <option value="">Everyone</option>
            {listUsers(db).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </label>
        <label className="text-sm">What
          <select name="action" defaultValue={action ?? ""} className="block w-full">
            <option value="">Everything</option>
            {auditActions(db).map((a) => <option key={a} value={a}>{LABELS[a] ?? a}</option>)}
          </select>
        </label>
        <div className="col-span-2 flex gap-2 md:col-span-2">
          <button className="btn-primary flex-1 md:flex-none">Filter</button>
          {(userId !== undefined || action) && <Link href="/activity" className="btn-secondary">Clear</Link>}
        </div>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Who</th><th className="th">What</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="td whitespace-nowrap text-xs text-slate-600">{localDateTime(e.at)}</td>
                <td className="td">{e.username}</td>
                <td className="td">
                  <span className="font-medium">{LABELS[e.action] ?? e.action}</span>
                  <div className="text-xs text-slate-600">{e.summary}</div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={3}>Nothing recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
