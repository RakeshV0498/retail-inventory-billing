import Link from "next/link";
import { getViewer, requireAuth } from "@/lib/session";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { isExpired, todayISO } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { ExpiryBadge, Field, Notice } from "@/components/ui";
import { getProduct, getProductBatches, productHasHistory } from "@/services/inventory";
import { addBatchAction, archiveProductAction, deleteProductAction, restoreProductAction, writeOffAction } from "@/app/actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";

export const dynamic = "force-dynamic";

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string; empty?: string }>;
}) {
  await requireAuth();
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const product = getProduct(db, Number(id));
  if (!product) notFound();
  const today = todayISO();
  const allBatches = getProductBatches(db, product.id, { includeEmpty: true });
  const showEmpty = sp.empty === "1";
  const batches = showEmpty ? allBatches : allBatches.filter((b) => b.quantityAvailable > 0);
  const emptyCount = allBatches.length - allBatches.filter((b) => b.quantityAvailable > 0).length;
  const viewer = await getViewer();
  const canDelete = viewer.can("product.delete") && !productHasHistory(db, product.id);
  const mayEditProduct = viewer.can("product.edit");
  const mayEditBatch = viewer.can("batch.edit");
  const mayWriteOff = viewer.can("stock.writeoff");
  const mayReceive = viewer.can("stock.receive");
  const mayArchive = viewer.can("product.archive");
  const archived = !product.isActive;
  const decimal = product.allowDecimalQty;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <Link href="/inventory" className="text-sm text-emerald-800 hover:underline">← Inventory</Link>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold md:text-2xl">{product.name}</h1>
          {mayEditProduct && <Link href={`/inventory/${product.id}/edit`} className="btn-secondary min-h-10 shrink-0 px-3 text-sm">Edit product</Link>}
        </div>
        <p className="text-sm text-slate-600">
          {product.sku} · {product.category} · per {product.unitType} · GST {product.gstRate}%
          {product.barcode && <> · barcode {product.barcode}</>}
        </p>
      </div>
      <Notice error={sp.error} ok={sp.ok ? "Saved." : undefined} />
      {archived && (
        <div className="card flex flex-wrap items-center justify-between gap-3 border-amber-300 bg-amber-50">
          <p className="text-sm text-amber-900">This product is archived: hidden from POS, search and lists. Old invoices are unaffected.</p>
          {mayArchive && (
            <form action={restoreProductAction}>
              <input type="hidden" name="productId" value={product.id} />
              <button className="btn-primary">Restore product</button>
            </form>
          )}
        </div>
      )}

      <section className="card overflow-x-auto p-0">
        <h2 className="p-3 font-semibold">Batches (earliest expiry first)</h2>
        <table className="w-full">
          <thead className="bg-slate-50"><tr>
            <th className="th">Batch</th><th className="th">Expiry</th><th className="th text-right">Qty</th>
            <th className="th text-right">Cost</th><th className="th text-right">MRP</th><th className="th text-right">Sell</th><th className="th hidden md:table-cell" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {batches.map((b) => (
              <tr key={b.id} className={isExpired(b.expiryDate, today) ? "bg-red-50" : ""}>
                <td className="td font-medium">
                  {b.batchNumber}
                  {mayEditBatch && <Link href={`/inventory/${product.id}/batches/${b.id}`} className="ml-2 text-xs font-normal text-emerald-800 hover:underline">Edit</Link>}
                  {mayWriteOff && isExpired(b.expiryDate, today) && b.quantityAvailable > 0 && (
                    <form action={writeOffAction} className="mt-1 md:hidden">
                      <input type="hidden" name="batchId" value={b.id} />
                      <input type="hidden" name="productId" value={product.id} />
                      <ConfirmSubmit className="btn-danger min-h-9 px-3 text-sm" message={`Write off ${formatQty(b.quantityAvailable)} ${product.unitType} of batch ${b.batchNumber}? This cannot be undone.`}>Write off</ConfirmSubmit>
                    </form>
                  )}
                </td>
                <td className="td"><ExpiryBadge expiryDate={b.expiryDate} today={today} /></td>
                <td className="td text-right">{formatQty(b.quantityAvailable)}</td>
                <td className="td text-right">{formatPaise(b.purchasePrice)}</td>
                <td className="td text-right">{formatPaise(b.mrp)}</td>
                <td className="td text-right">{formatPaise(b.sellingPrice)}</td>
                <td className="td hidden text-right md:table-cell">
                  {mayWriteOff && isExpired(b.expiryDate, today) && b.quantityAvailable > 0 && (
                    <form action={writeOffAction}>
                      <input type="hidden" name="batchId" value={b.id} />
                      <input type="hidden" name="productId" value={product.id} />
                      <ConfirmSubmit className="btn-danger min-h-9 px-3 text-sm" message={`Write off ${formatQty(b.quantityAvailable)} ${product.unitType} of batch ${b.batchNumber}? This cannot be undone.`}>Write off</ConfirmSubmit>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {batches.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>No stock{emptyCount > 0 ? " (written-off batches are hidden)" : " yet"}{archived ? "." : ". Add a batch below."}</td></tr>}
          </tbody>
        </table>
        {emptyCount > 0 && (
          <p className="border-t border-slate-100 p-3 text-sm">
            <Link href={showEmpty ? `/inventory/${product.id}` : `/inventory/${product.id}?empty=1`} className="text-emerald-800 hover:underline">
              {showEmpty ? "Hide" : "Show"} {emptyCount} empty / written-off batch{emptyCount === 1 ? "" : "es"}
            </Link>
          </p>
        )}
      </section>

      {!archived && mayReceive && (
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
      )}

      {(mayArchive || canDelete) && (
      <section className="card space-y-3">
        <h2 className="font-semibold">Manage product</h2>
        <div className="flex flex-wrap gap-2">
          {!archived && mayArchive && (
            <form action={archiveProductAction}>
              <input type="hidden" name="productId" value={product.id} />
              <ConfirmSubmit className="btn-secondary" message={`Archive ${product.name}? It will disappear from POS, search and lists (history is kept). Any expired stock is written off. You can restore it later.`}>
                Archive product
              </ConfirmSubmit>
            </form>
          )}
          {canDelete && (
            <form action={deleteProductAction}>
              <input type="hidden" name="productId" value={product.id} />
              <ConfirmSubmit className="btn-danger" message={`Permanently delete ${product.name}? This cannot be undone.`}>Delete product</ConfirmSubmit>
            </form>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {canDelete
            ? "This product has no stock or sales history, so it can be deleted permanently."
            : "Products with stock or sales history can only be archived, so old invoices and reports stay correct."}
        </p>
      </section>
      )}
    </div>
  );
}
