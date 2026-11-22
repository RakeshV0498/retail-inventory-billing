import Link from "next/link";
import { notFound } from "next/navigation";
import { recordPaymentAction, updateCustomerAction } from "@/app/actions";
import { getDb } from "@/db/client";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { Field, Notice } from "@/components/ui";
import { localDateTime } from "@/lib/dates";
import { formatPaise, paiseToDecimal } from "@/lib/money";
import { whatsappReminderUrl } from "@/lib/phone";
import { getViewer, requireAuth } from "@/lib/session";
import { balanceOf, getCustomer, getCustomerLedger } from "@/services/customers";
import { getSettings } from "@/services/settings";

export const dynamic = "force-dynamic";

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  await requireAuth();
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const customer = getCustomer(db, Number(id));
  if (!customer) notFound();
  const viewer = await getViewer();
  const balance = balanceOf(db, customer.id);
  const ledger = getCustomerLedger(db, customer.id).reverse(); // newest first
  const reminder = whatsappReminderUrl({ phone: customer.phone, name: customer.name, balance, storeName: getSettings(db).storeName });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <Link href="/customers" className="text-sm text-emerald-800 hover:underline">← Customers</Link>
        <h1 className="text-xl font-bold md:text-2xl">{customer.name}</h1>
        <p className="text-sm text-slate-600">{customer.phone ?? "No phone saved"}{customer.notes ? ` · ${customer.notes}` : ""}</p>
      </div>
      <Notice error={sp.error} ok={sp.ok ? "Saved." : undefined} />

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm text-slate-500">{balance < 0 ? "Paid in advance" : "Owes you"}</div>
            <div className={`text-3xl font-bold ${balance > 0 ? "text-red-700" : balance < 0 ? "text-emerald-700" : ""}`}>{formatPaise(Math.abs(balance))}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {reminder && <a href={reminder} target="_blank" rel="noopener noreferrer" className="btn-secondary">Remind on WhatsApp</a>}
            {balance > 0 && !customer.phone && <span className="self-center text-xs text-slate-500">Add a phone number to send reminders</span>}
          </div>
        </div>

        {balance > 0 && viewer.can("payment.record") && (
          <form action={recordPaymentAction} className="grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-4">
            <input type="hidden" name="customerId" value={customer.id} />
            <Field label="Amount received (₹)"><input name="amount" inputMode="decimal" required defaultValue={paiseToDecimal(balance)} className="w-full" /></Field>
            <Field label="Paid by">
              <select name="mode" defaultValue="cash" className="w-full"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select>
            </Field>
            <div className="md:col-span-2"><Field label="Note (optional)"><input name="note" maxLength={200} className="w-full" /></Field></div>
            <div className="md:col-span-4">
              <ConfirmSubmit className="btn-primary min-h-12 w-full md:w-auto" message={`Record this payment from ${customer.name}? It reduces what they owe.`}>Record payment</ConfirmSubmit>
              <p className="mt-1 text-xs text-slate-500">You can record part of the amount. It can&apos;t be more than they owe.</p>
            </div>
          </form>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <div className="flex items-center justify-between p-3">
          <h2 className="font-semibold">History</h2>
          {ledger.length > 0 && viewer.can("reports.view") && <a href={`/reports/export?type=ledger&customer=${customer.id}`} download className="text-sm text-emerald-800 hover:underline">Download (CSV)</a>}
        </div>
        <table className="w-full">
          <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Details</th><th className="th text-right">Amount</th><th className="th text-right">Balance</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {ledger.map((e, i) => (
              <tr key={i}>
                <td className="td whitespace-nowrap text-xs text-slate-600">{localDateTime(e.at)}</td>
                <td className="td">{e.invoiceId ? <Link href={`/invoices/${e.invoiceId}`} className="hover:underline">{e.label}</Link> : e.label}</td>
                <td className={`td text-right font-medium ${e.kind === "credit" ? "text-red-700" : "text-emerald-700"}`}>{e.kind === "credit" ? "+" : "−"} {formatPaise(e.amount)}</td>
                <td className="td text-right">{formatPaise(e.balanceAfter)}</td>
              </tr>
            ))}
            {ledger.length === 0 && <tr><td className="td text-slate-500" colSpan={4}>No credit bills or payments yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {viewer.can("customer.edit") && (
      <details className="card">
        <summary className="cursor-pointer font-medium">Edit details</summary>
        <form action={updateCustomerAction} className="mt-3 grid gap-3 md:grid-cols-2">
          <input type="hidden" name="customerId" value={customer.id} />
          <Field label="Name"><input name="name" required maxLength={100} defaultValue={customer.name} className="w-full" /></Field>
          <Field label="Phone"><input name="phone" inputMode="tel" maxLength={30} defaultValue={customer.phone ?? ""} className="w-full" /></Field>
          <div className="md:col-span-2"><Field label="Notes"><input name="notes" maxLength={200} defaultValue={customer.notes ?? ""} className="w-full" /></Field></div>
          <div className="md:col-span-2"><button className="btn-secondary min-h-12 w-full md:w-auto">Save details</button></div>
        </form>
      </details>
      )}
    </div>
  );
}
