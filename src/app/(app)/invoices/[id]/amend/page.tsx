import Link from "next/link";
import { notFound } from "next/navigation";
import { PosClient, type AmendSeed } from "@/components/pos/PosClient";
import { getDb } from "@/db/client";
import { paiseToDecimal } from "@/lib/money";
import { requirePermission } from "@/lib/session";
import { getInvoice } from "@/services/billing";
import { balanceOf, getCustomer } from "@/services/customers";
import { seedLinesFromItems, stockAsIfVoided } from "@/services/sales";

export const dynamic = "force-dynamic";
export const metadata = { title: "Amend bill · Retail Billing" };

const rupees = (paise: number) => (paise > 0 ? paiseToDecimal(paise) : "");

export default async function AmendInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("sale.amend");
  const { id } = await params;
  const db = getDb();
  const data = getInvoice(db, Number(id));
  if (!data) notFound();
  const { invoice, items } = data;

  if (invoice.status === "void") {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="text-xl font-bold">Amend {invoice.invoiceNumber}</h1>
        <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">This bill is already void, so it can&apos;t be amended.</p>
        <Link href={`/invoices/${invoice.id}`} className="btn-secondary">Back to the bill</Link>
      </div>
    );
  }

  const customer = invoice.customerId ? getCustomer(db, invoice.customerId) : undefined;
  const seed: AmendSeed = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    originalTotal: invoice.grandTotal,
    lines: seedLinesFromItems(items),
    paymentMode: invoice.paymentMode,
    split: { cash: rupees(invoice.cashAmount), upi: rupees(invoice.upiAmount), card: rupees(invoice.cardAmount), credit: rupees(invoice.creditAmount) },
    customer: customer
      ? // what they'd owe if this bill didn't exist: the editor adds the corrected credit back on top
        { id: customer.id, name: customer.name, phone: customer.phone, balance: balanceOf(db, customer.id) - invoice.creditAmount }
      : null,
    walkIn: { name: customer ? "" : (invoice.customerName ?? ""), phone: customer ? "" : (invoice.customerPhone ?? "") },
  };

  return (
    <div className="pb-20 md:pb-0">
      <PosClient amend={seed} products={stockAsIfVoided(db, invoice.id)} />
    </div>
  );
}
