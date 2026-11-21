import Link from "next/link";
import { getDb } from "@/db/client";
import { formatPaise } from "@/lib/money";
import { listInvoices } from "@/services/billing";

export const dynamic = "force-dynamic";

export default function InvoicesPage() {
  const rows = listInvoices(getDb(), 200);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-xl font-bold md:text-2xl">Invoices</h1>
      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-slate-50"><tr>
            <th className="th">Invoice</th><th className="th hidden md:table-cell">Customer</th>
            <th className="th">Mode</th><th className="th text-right">Total</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">{i.invoiceNumber}</Link>
                  <div className="text-xs text-slate-500">{new Date(i.createdAt).toLocaleString("en-IN")}</div>
                </td>
                <td className="td hidden md:table-cell">{i.customerName ?? "—"}</td>
                <td className="td uppercase">{i.paymentMode}</td>
                <td className="td text-right font-semibold">{formatPaise(i.grandTotal)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={4}>No invoices yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
