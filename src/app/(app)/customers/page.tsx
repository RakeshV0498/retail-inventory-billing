import Link from "next/link";
import { createCustomerAction } from "@/app/actions";
import { getDb } from "@/db/client";
import { Field, Notice } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getViewer, requireAuth } from "@/lib/session";
import { listCustomersWithBalance, outstandingTotal } from "@/services/customers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers · Retail Billing" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; error?: string }> }) {
  await requireAuth();
  const sp = await searchParams;
  const db = getDb();
  const q = (sp.q ?? "").trim().toLowerCase();
  const all = listCustomersWithBalance(db);
  const rows = q ? all.filter((r) => r.customer.name.toLowerCase().includes(q) || (r.customer.phone ?? "").includes(q.replace(/\D/g, "") || "\u0000")) : all;
  const total = outstandingTotal(db);
  const viewer = await getViewer();
  const owing = all.filter((r) => r.balance > 0).length;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-bold md:text-2xl">Customers</h1>
      <Notice error={sp.error} />

      <div className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm text-slate-500">Total owed to you</div>
          <div className={`text-2xl font-bold ${total > 0 ? "text-red-700" : ""}`}>{formatPaise(total)}</div>
          <div className="text-xs text-slate-500">{owing} customer{owing === 1 ? "" : "s"} with dues</div>
        </div>
        {total > 0 && viewer.can("reports.view") && <a href="/reports/export?type=dues" download className="btn-secondary">Download dues list (CSV)</a>}
      </div>

      <form className="flex gap-2">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Search by name or phone" aria-label="Search customers" className="min-w-0 flex-1" />
        <button className="btn-secondary">Search</button>
      </form>

      <details className="card">
        <summary className="cursor-pointer font-medium">+ Add customer</summary>
        <form action={createCustomerAction} className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="Name"><input name="name" required maxLength={100} className="w-full" /></Field>
          <Field label="Phone (for WhatsApp reminders)"><input name="phone" inputMode="tel" maxLength={30} className="w-full" /></Field>
          <div className="md:col-span-2"><Field label="Notes (optional)"><input name="notes" maxLength={200} className="w-full" /></Field></div>
          <div className="md:col-span-2"><button className="btn-primary min-h-12 w-full md:w-auto">Save customer</button></div>
        </form>
      </details>

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-slate-50"><tr><th className="th">Customer</th><th className="th text-right">Owes</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ customer, balance }) => (
              <tr key={customer.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link href={`/customers/${customer.id}`} className="font-medium hover:underline">{customer.name}</Link>
                  {customer.phone && <div className="text-xs text-slate-500">{customer.phone}</div>}
                </td>
                <td className={`td text-right font-semibold ${balance > 0 ? "text-red-700" : "text-slate-500"}`}>{balance > 0 ? formatPaise(balance) : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={2}>{all.length === 0 ? "No customers yet. Add one above, or while billing on credit." : "No customers match."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
