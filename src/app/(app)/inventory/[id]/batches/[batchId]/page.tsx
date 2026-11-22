import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { batches } from "@/db/schema";
import { eq } from "drizzle-orm";
import { adjustStockAction, updateBatchAction } from "@/app/actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { Field, Notice } from "@/components/ui";
import { paiseToDecimal } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { requirePermission } from "@/lib/session";
import { getProduct } from "@/services/inventory";

export const dynamic = "force-dynamic";

export default async function EditBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; batchId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("batch.edit");
  const { id, batchId } = await params;
  const { error } = await searchParams;
  const db = getDb();
  const product = getProduct(db, Number(id));
  const batch = db.select().from(batches).where(eq(batches.id, Number(batchId))).get();
  if (!product || !batch || batch.productId !== product.id) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link href={`/inventory/${product.id}`} className="text-sm text-emerald-800 hover:underline">← {product.name}</Link>
        <h1 className="text-xl font-bold md:text-2xl">Edit batch {batch.batchNumber}</h1>
      </div>
      <Notice error={error} />

      <form action={updateBatchAction} className="card grid gap-3 md:grid-cols-2">
        <input type="hidden" name="productId" value={product.id} />
        <input type="hidden" name="batchId" value={batch.id} />
        <Field label="Batch number"><input name="batchNumber" required defaultValue={batch.batchNumber} className="w-full" /></Field>
        <div className="hidden md:block" />
        <Field label="Mfg date"><input name="mfgDate" type="date" defaultValue={batch.mfgDate ?? ""} className="w-full" /></Field>
        <Field label="Expiry date"><input name="expiryDate" type="date" defaultValue={batch.expiryDate ?? ""} className="w-full" /></Field>
        <Field label="Purchase price (₹)"><input name="purchasePrice" inputMode="decimal" required defaultValue={paiseToDecimal(batch.purchasePrice)} className="w-full" /></Field>
        <Field label="MRP (₹)"><input name="mrp" inputMode="decimal" required defaultValue={paiseToDecimal(batch.mrp)} className="w-full" /></Field>
        <Field label="Selling price (₹, incl. GST)"><input name="sellingPrice" inputMode="decimal" required defaultValue={paiseToDecimal(batch.sellingPrice)} className="w-full" /></Field>
        <div className="md:col-span-2">
          <button className="btn-primary min-h-12 w-full md:w-auto">Save batch</button>
          <p className="mt-2 text-xs text-slate-500">Price changes apply to future bills only. Old invoices keep the price they were sold at.</p>
        </div>
      </form>

      <form action={adjustStockAction} className="card grid gap-3 md:grid-cols-2">
        <h2 className="font-semibold md:col-span-2">Correct quantity</h2>
        <p className="text-sm text-slate-600 md:col-span-2">
          Currently <strong>{formatQty(batch.quantityAvailable)} {product.unitType}</strong>. Enter the real counted quantity. The change is recorded in the stock history with your reason.
        </p>
        <input type="hidden" name="productId" value={product.id} />
        <input type="hidden" name="batchId" value={batch.id} />
        <Field label={`Counted quantity (${product.unitType})`}>
          <input name="newQuantity" inputMode={product.allowDecimalQty ? "decimal" : "numeric"} required defaultValue={formatQty(batch.quantityAvailable)} className="w-full" />
        </Field>
        <Field label="Reason (required)"><input name="reason" required maxLength={200} placeholder="e.g. keyed 100 instead of 10" className="w-full" /></Field>
        <div className="md:col-span-2">
          <ConfirmSubmit className="btn-secondary min-h-12 w-full md:w-auto" message="Change this batch's stock to the counted quantity? This is recorded in the stock history.">
            Correct quantity
          </ConfirmSubmit>
        </div>
      </form>
    </div>
  );
}
