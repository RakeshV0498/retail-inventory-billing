import Link from "next/link";
import { notFound } from "next/navigation";
import { InvoiceDetailsForm, type DetailsSeed } from "@/components/invoices/InvoiceDetailsForm";
import { getDb } from "@/db/client";
import { paiseToDecimal } from "@/lib/money";
import { requirePermission } from "@/lib/session";
import { getInvoice } from "@/services/billing";
import { balanceOf, getCustomer } from "@/services/customers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit bill · Retail Billing" };

const rupees = (paise: number) => (paise > 0 ? paiseToDecimal(paise) : "");

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("sale.edit");
  const { id } = await params;
  const db = getDb();
  const data = getInvoice(db, Number(id));
  if (!data) notFound();
  const { invoice } = data;

  if (invoice.status === "void") {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="text-xl font-bold">Edit {invoice.invoiceNumber}</h1>
        <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">This bill is void, so it can&apos;t be edited.</p>
        <Link href={`/invoices/${invoice.id}`} className="btn-secondary">Back to the bill</Link>
      </div>
    );
  }

  const customer = invoice.customerId ? getCustomer(db, invoice.customerId) : undefined;
  const seed: DetailsSeed = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    total: invoice.grandTotal,
    paymentMode: invoice.paymentMode,
    split: { cash: rupees(invoice.cashAmount), upi: rupees(invoice.upiAmount), card: rupees(invoice.cardAmount), credit: rupees(invoice.creditAmount) },
    customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone, balance: balanceOf(db, customer.id) - invoice.creditAmount } : null,
    walkIn: { name: customer ? "" : (invoice.customerName ?? ""), phone: customer ? "" : (invoice.customerPhone ?? "") },
    notes: invoice.notes ?? "",
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link href={`/invoices/${invoice.id}`} className="text-sm text-emerald-800 hover:underline">← {invoice.invoiceNumber}</Link>
        <h1 className="text-xl font-bold md:text-2xl">Edit details of {invoice.invoiceNumber}</h1>
      </div>
      <InvoiceDetailsForm seed={seed} />
    </div>
  );
}
