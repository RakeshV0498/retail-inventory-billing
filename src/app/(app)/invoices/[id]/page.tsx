import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/session";
import { getDb } from "@/db/client";
import { PrintControls } from "@/components/PrintControls";
import { splitGst } from "@/lib/gst";
import { formatPaise } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { getInvoice } from "@/services/billing";
import { getSettings } from "@/services/settings";

export const dynamic = "force-dynamic";

type Fmt = "58" | "80" | "a4";

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ format?: string; print?: string }>;
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
      <PrintControls invoiceId={invoice.id} format={format} autoPrint={sp.print === "1"} />
      {/* @page size follows the chosen paper */}
      <style>{`@media print { @page { size: ${thermal ? `${width} auto` : "A4"}; margin: ${thermal ? "2mm" : "12mm"}; } body { background: #fff; } }`}</style>

      <article
        className={`mx-auto bg-white text-black shadow-sm print:shadow-none ${thermal ? "p-2 font-mono text-[11px] leading-tight" : "p-8 text-sm"}`}
        style={{ width, maxWidth: "100%" }}
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
      </article>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2"><span>{label}</span><span className="whitespace-nowrap">{value}</span></div>
  );
}
