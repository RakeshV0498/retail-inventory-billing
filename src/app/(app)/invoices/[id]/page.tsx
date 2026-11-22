import { notFound } from "next/navigation";
import Link from "next/link";
import { voidInvoiceAction } from "@/app/actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { Notice } from "@/components/ui";
import { getViewer, requireAuth } from "@/lib/session";
import { getDb } from "@/db/client";
import { PrintControls } from "@/components/PrintControls";
import { splitGst } from "@/lib/gst";
import { formatPaise } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { getInvoice } from "@/services/billing";
import { getInvoiceRelations } from "@/services/sales";
import { getSettings } from "@/services/settings";

export const dynamic = "force-dynamic";

type Fmt = "58" | "80" | "a4";

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ format?: string; print?: string; error?: string }>;
}) {
  await requireAuth();
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const data = getInvoice(db, Number(id));
  if (!data) notFound();
  const s = getSettings(db);
  const format: Fmt = sp.format === "58" || sp.format === "80" || sp.format === "a4" ? sp.format : s.printFormat;
  const { invoice, items } = data;
  const viewer = await getViewer();
  const rel = getInvoiceRelations(db, invoice.id);
  const isVoid = invoice.status === "void";
  const thermal = format !== "a4";
  const width = format === "58" ? "58mm" : format === "80" ? "80mm" : "210mm";
  const { cgst, sgst } = splitGst(invoice.taxTotal);

  // Group GST by slab for the summary.
  const slabs = new Map<number, { taxable: number; tax: number }>();
  for (const i of items) {
    const cur = slabs.get(i.gstRate) ?? { taxable: 0, tax: 0 };
    slabs.set(i.gstRate, { taxable: cur.taxable + i.taxableAmount, tax: cur.tax + i.taxAmount });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PrintControls invoiceId={invoice.id} format={format} autoPrint={sp.print === "1" && !isVoid} />
      <Notice error={sp.error} />

      {isVoid && (
        <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 print:hidden">
          <p className="font-semibold">This bill is VOID, so it is not counted in sales, GST or customer dues.</p>
          <p>
            {invoice.voidReason ? `Reason: ${invoice.voidReason}. ` : ""}
            {invoice.voidedByName ? `By ${invoice.voidedByName}` : "Voided"}
            {invoice.voidedAt ? ` on ${new Date(invoice.voidedAt).toLocaleString("en-IN")}` : ""}.
          </p>
          {(invoice.cashAmount > 0 || invoice.upiAmount > 0 || invoice.cardAmount > 0) && (
            <p className="mt-1 font-medium">
              If the customer was already paid back, nothing more to do. Otherwise refund:{" "}
              {[invoice.cashAmount > 0 && `cash ${formatPaise(invoice.cashAmount)}`, invoice.upiAmount > 0 && `UPI ${formatPaise(invoice.upiAmount)}`, invoice.cardAmount > 0 && `card ${formatPaise(invoice.cardAmount)}`]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          )}
          {rel.replacedBy && (
            <p className="mt-1">
              Replaced by corrected bill <Link href={`/invoices/${rel.replacedBy.id}`} className="font-semibold underline">{rel.replacedBy.invoiceNumber}</Link>.
            </p>
          )}
        </div>
      )}
      {rel.replaces && !isVoid && (
        <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
          Corrected copy of <Link href={`/invoices/${rel.replaces.id}`} className="font-semibold underline">{rel.replaces.invoiceNumber}</Link> (now void).
        </p>
      )}

      {!isVoid && (viewer.can("sale.edit") || viewer.can("sale.amend") || viewer.can("sale.void")) && (
        <section className="card mb-4 space-y-3 print:hidden" aria-labelledby="admin-actions">
          <h2 id="admin-actions" className="font-semibold">Admin actions</h2>
          <div className="flex flex-wrap gap-2">
            {viewer.can("sale.edit") && <Link href={`/invoices/${invoice.id}/edit`} className="btn-secondary">Edit details</Link>}
            {viewer.can("sale.amend") && <Link href={`/invoices/${invoice.id}/amend`} className="btn-secondary">Amend items</Link>}
          </div>
          {viewer.can("sale.void") && (
            <form action={voidInvoiceAction} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <label className="min-w-0 flex-1 text-sm">Void this bill (reason required)
                <input name="reason" required maxLength={200} placeholder="e.g. customer returned everything" className="block w-full" />
              </label>
              <ConfirmSubmit className="btn-danger" message={`Void ${invoice.invoiceNumber} (${formatPaise(invoice.grandTotal)})? The stock goes back to its batches${invoice.creditAmount > 0 ? `, ${formatPaise(invoice.creditAmount)} is removed from the customer's dues` : ""}, and the bill stays in the list marked VOID. This can't be undone.`}>
                Void bill
              </ConfirmSubmit>
            </form>
          )}
          <p className="text-xs text-slate-500">Bills are never deleted: voiding keeps the record. Amend replaces the bill with a corrected copy (INV-…-A1).</p>
        </section>
      )}
      {/* @page size follows the chosen paper */}
      <style>{`@media print { @page { size: ${thermal ? `${width} auto` : "A4"}; margin: ${thermal ? "2mm" : "12mm"}; } body { background: #fff; } }`}</style>

      <article
        className={`mx-auto bg-white text-black shadow-sm print:shadow-none ${thermal ? "p-2 font-mono text-[11px] leading-tight" : "p-8 text-sm"}`}
        style={{ width, maxWidth: "100%", position: "relative" }}
      >
        <header className={thermal ? "text-center" : "mb-4 flex items-start justify-between"}>
          <div>
            <h1 className={thermal ? "text-sm font-bold" : "text-2xl font-bold"}>{s.storeName}</h1>
            {s.storeAddress && <p>{s.storeAddress}</p>}
            {s.gstin && <p>GSTIN: {s.gstin}</p>}
          </div>
          <div className={thermal ? "mt-1" : "text-right"}>
            <p className="font-semibold">TAX INVOICE</p>
            <p>{invoice.invoiceNumber}</p>
            {rel.replaces && <p>Corrected copy of {rel.replaces.invoiceNumber}</p>}
            {invoice.notes && <p>Note: {invoice.notes}</p>}
            {invoice.createdByName && <p>Billed by: {invoice.createdByName}</p>}
            <p>{new Date(invoice.createdAt).toLocaleString("en-IN")}</p>
          </div>
        </header>
        {(invoice.customerName || invoice.customerPhone) && (
          <p className="mt-1">Customer: {invoice.customerName} {invoice.customerPhone}</p>
        )}

        <table className="mt-2 w-full border-collapse">
          <thead>
            <tr className="border-y border-dashed border-black text-left">
              <th className="py-1">Item</th>
              <th className="py-1 text-right">Qty</th>
              {!thermal && <th className="py-1 text-right">Batch</th>}
              {!thermal && <th className="py-1 text-right">Rate</th>}
              {!thermal && <th className="py-1 text-right">GST%</th>}
              <th className="py-1 text-right">Amt</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="align-top">
                <td className="py-0.5 pr-1">
                  {i.productName}
                  {thermal && <span className="block text-[10px]">{i.batchNumber} @ {formatPaise(i.unitPrice)} · {i.gstRate}%</span>}
                  {i.discountAmount > 0 && <span className="block text-[10px]">Disc − {formatPaise(i.discountAmount)}</span>}
                </td>
                <td className="py-0.5 text-right">{formatQty(i.quantity)} {i.unitType}</td>
                {!thermal && <td className="py-0.5 text-right">{i.batchNumber}</td>}
                {!thermal && <td className="py-0.5 text-right">{formatPaise(i.unitPrice)}</td>}
                {!thermal && <td className="py-0.5 text-right">{i.gstRate}</td>}
                <td className="py-0.5 text-right">{formatPaise(i.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-2 space-y-0.5 border-t border-dashed border-black pt-1">
          <TotalRow label="Subtotal" value={formatPaise(invoice.subtotal)} />
          {invoice.discountTotal > 0 && <TotalRow label="Discount" value={`− ${formatPaise(invoice.discountTotal)}`} />}
          {[...slabs.entries()].filter(([, v]) => v.tax > 0).map(([rate, v]) => (
            <TotalRow key={rate} label={`Taxable @${rate}% (CGST ${rate / 2}% + SGST ${rate / 2}%)`} value={`${formatPaise(v.taxable)} / ${formatPaise(v.tax)}`} />
          ))}
          <TotalRow label="CGST" value={formatPaise(cgst)} />
          <TotalRow label="SGST" value={formatPaise(sgst)} />
          {invoice.roundOff !== 0 && <TotalRow label="Round off" value={formatPaise(invoice.roundOff)} />}
          <div className={`flex justify-between border-t border-black pt-1 font-bold ${thermal ? "text-sm" : "text-lg"}`}>
            <span>TOTAL</span><span>{formatPaise(invoice.grandTotal)}</span>
          </div>
          <p className="pt-1 uppercase">
            {invoice.paymentMode === "credit" ? "On credit" : `Paid: ${invoice.paymentMode}`}
            {invoice.paymentMode === "split" && ` (cash ${formatPaise(invoice.cashAmount)}, upi ${formatPaise(invoice.upiAmount)}, card ${formatPaise(invoice.cardAmount)}, credit ${formatPaise(invoice.creditAmount)})`}
          </p>
          {invoice.creditAmount > 0 && (
            <p className="font-semibold">
              Balance on credit: {formatPaise(invoice.creditAmount)}{invoice.customerName ? ` (${invoice.customerName})` : ""}
            </p>
          )}
        </div>
        {s.receiptFooter && <p className="mt-3 text-center">{s.receiptFooter}</p>}
        {isVoid && (
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
            <span className="-rotate-25 select-none border-4 border-red-600 px-3 py-1 text-5xl font-black tracking-widest text-red-600/70">VOID</span>
          </div>
        )}
      </article>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2"><span>{label}</span><span className="whitespace-nowrap">{value}</span></div>
  );
}
