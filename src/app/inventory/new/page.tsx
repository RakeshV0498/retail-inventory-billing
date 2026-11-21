import { CATEGORIES, UNIT_TYPES } from "@/db/schema";
import { GST_SLABS } from "@/lib/gst";
import { Field, Notice } from "@/components/ui";
import { createProductAction } from "../../actions";

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-xl font-bold md:text-2xl">Add product</h1>
      <Notice error={error} />
      <form action={createProductAction} className="card grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><Field label="Name"><input name="name" required className="w-full" autoFocus /></Field></div>
        <Field label="SKU"><input name="sku" required className="w-full" /></Field>
        <Field label="Barcode (optional)"><input name="barcode" inputMode="numeric" className="w-full" /></Field>
        <Field label="Category">
          <select name="category" className="w-full">{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </Field>
        <Field label="Unit">
          <select name="unitType" className="w-full">{UNIT_TYPES.map((u) => <option key={u} value={u}>{u}</option>)}</select>
        </Field>
        <Field label="GST slab">
          <select name="gstRate" defaultValue="0" className="w-full">{GST_SLABS.map((g) => <option key={g} value={g}>{g}%</option>)}</select>
        </Field>
        <Field label="HSN code (optional)"><input name="hsnCode" className="w-full" /></Field>
        <Field label="Low-stock threshold"><input name="lowStockThreshold" type="number" step="any" min="0" defaultValue="0" className="w-full" /></Field>
        <label className="flex min-h-11 items-center gap-2 self-end">
          <input type="checkbox" name="allowDecimalQty" className="size-5 min-h-0" />
          <span className="text-sm">Sold loose (allow decimal qty, e.g. 0.25 kg)</span>
        </label>
        <div className="md:col-span-2"><button className="btn-primary w-full md:w-auto">Save &amp; add stock</button></div>
      </form>
    </div>
  );
}
