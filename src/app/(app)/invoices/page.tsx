import Link from "next/link";
import { getDb } from "@/db/client";
import { requireAuth } from "@/lib/session";
import { formatPaise } from "@/lib/money";
import { listInvoices, type InvoiceFilter } from "@/services/billing";
import { listUsers } from "@/services/users";
import { parseRange } from "../reports/range";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; user?: string; status?: string }>;
}) {
  await requireAuth();
  const sp = await searchParams;
  const db = getDb();
  const people = listUsers(db);
  const hasRange = (sp.from && ISO.test(sp.from)) || (sp.to && ISO.test(sp.to));
  const range = hasRange ? parseRange(sp.from, sp.to) : null;
  const user = sp.user === "none" ? "none" : Number.isInteger(Number(sp.user)) && sp.user ? Number(sp.user) : undefined;
  const status = sp.status === "paid" || sp.status === "void" ? sp.status : undefined;
  const filter: InvoiceFilter = { ...(range ?? {}), userId: user, status, limit: 200 };
  const rows = listInvoices(db, filter);
  const filtered = !!(range || user !== undefined || status);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-xl font-bold md:text-2xl">Invoices</h1>

      <form className="card grid grid-cols-2 gap-3 md:grid-cols-5 md:items-end">
        <label className="text-sm">From<input type="date" name="from" defaultValue={range?.from ?? ""} className="block w-full" /></label>
        <label className="text-sm">To<input type="date" name="to" defaultValue={range?.to ?? ""} className="block w-full" /></label>
        <label className="text-sm">Billed by
          <select name="user" defaultValue={user === undefined ? "" : String(user)} className="block w-full">
            <option value="">Everyone</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            <option value="none">Not recorded</option>
          </select>
        </label>
        <label className="text-sm">Status
          <select name="status" defaultValue={status ?? ""} className="block w-full">
            <option value="">All</option><option value="paid">Paid</option><option value="void">Void</option>
          </select>
        </label>
        <div className="col-span-2 flex gap-2 md:col-span-1">
          <button className="btn-primary flex-1">Filter</button>
          {filtered && <Link href="/invoices" className="btn-secondary">Clear</Link>}
        </div>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-slate-50"><tr>
            <th className="th">Invoice</th><th className="th hidden md:table-cell">Customer</th><th className="th hidden sm:table-cell">Billed by</th>
            <th className="th">Mode</th><th className="th text-right">Total</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">{i.invoiceNumber}</Link>
                  {i.status === "void" && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">VOID</span>}
                  <div className="text-xs text-slate-500">
                    {new Date(i.createdAt).toLocaleString("en-IN")}
                    <span className="sm:hidden">{i.createdByName ? ` · ${i.createdByName}` : ""}</span>
                  </div>
                </td>
                <td className="td hidden md:table-cell">{i.customerName ?? "—"}</td>
                <td className="td hidden sm:table-cell">{i.createdByName ?? "—"}</td>
                <td className="td uppercase">{i.paymentMode}</td>
                <td className={`td text-right font-semibold ${i.status === "void" ? "text-slate-400 line-through" : ""}`}>{formatPaise(i.grandTotal)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={5}>{filtered ? "No invoices match these filters." : "No invoices yet."}</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length === 200 && <p className="text-xs text-slate-500">Showing the latest 200. Narrow the dates to see more.</p>}
    </div>
  );
}
