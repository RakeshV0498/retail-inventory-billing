import Link from "next/link";
import { requireAuth } from "@/lib/session";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { isExpired, todayISO } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { ExpiryBadge, Field, Notice } from "@/components/ui";
import { getProduct, getProductBatches } from "@/services/inventory";
import { addBatchAction, writeOffAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function ProductPage({
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
  const product = getProduct(db, Number(id));
  if (!product) notFound();
  const today = todayISO();
  const batches = getProductBatches(db, product.id);
  const decimal = product.allowDecimalQty;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <Link href="/inventory" className="text-sm text-emerald-800 hover:underline">← Inventory</Link>
        <h1 className="text-xl font-bold md:text-2xl">{product.name}</h1>
        <p className="text-sm text-slate-600">
          {product.sku} · {product.category} · per {product.unitType} · GST {product.gstRate}%
          {product.barcode && <> · barcode {product.barcode}</>}
        </p>
      </div>
      <Notice error={sp.error} ok={sp.ok ? "Saved." : undefined} />

      <section className="card overflow-x-auto p-0">
        <h2 className="p-3 font-semibold">Batches (earliest expiry first)</h2>
        <table className="w-full">
          <thead className="bg-slate-50"><tr>
            <th className="th">Batch</th><th className="th">Expiry</th><th className="th text-right">Qty</th>
            <th className="th text-right">Cost</th><th className="th text-right">MRP</th><th className="th text-right">Sell</th><th className="th" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {batches.map((b) => (
              <tr key={b.id} className={isExpired(b.expiryDate, today) ? "bg-red-50" : ""}>
                <td className="td font-medium">{b.batchNumber}</td>
                <td className="td"><ExpiryBadge expiryDate={b.expiryDate} today={today} /></td>
                <td className="td text-right">{formatQty(b.quantityAvailable)}</td>
                <td className="td text-right">{formatPaise(b.purchasePrice)}</td>
                <td className="td text-right">{formatPaise(b.mrp)}</td>
                <td className="td text-right">{formatPaise(b.sellingPrice)}</td>
                <td className="td text-right">
                  {isExpired(b.expiryDate, today) && b.quantityAvailable > 0 && (
                    <form action={writeOffAction}>
                      <input type="hidden" name="batchId" value={b.id} />
                      <input type="hidden" name="productId" value={product.id} />
                      <button className="btn-danger min-h-9 px-3 text-sm">Write off</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {batches.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>No stock yet — add a batch below.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Add stock batch</h2>
        <form action={addBatchAction} className="grid gap-3 md:grid-cols-3">
          <input type="hidden" name="productId" value={product.id} />
          <Field label="Batch number"><input name="batchNumber" required className="w-full" /></Field>
          <Field label="Mfg date"><input name="mfgDate" type="date" className="w-full" /></Field>
          <Field label="Expiry date"><input name="expiryDate" type="date" className="w-full" /></Field>
          <Field label="Purchase price (₹)"><input name="purchasePrice" inputMode="decimal" required className="w-full" /></Field>
          <Field label="MRP (₹)"><input name="mrp" inputMode="decimal" required className="w-full" /></Field>
          <Field label="Selling price (₹, incl. GST)"><input name="sellingPrice" inputMode="decimal" required className="w-full" /></Field>
          <Field label={`Quantity (${product.unitType})`}>
            <input name="quantity" inputMode={decimal ? "decimal" : "numeric"} required className="w-full" />
          </Field>
          <div className="flex items-end"><button className="btn-primary w-full">Add stock</button></div>
        </form>
      </section>
    </div>
  );
}
