import { ProductForm } from "@/components/inventory/ProductForm";
import { Notice } from "@/components/ui";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ error?: string; barcode?: string }> }) {
  await requirePermission("product.create");
  const { error, barcode } = await searchParams;
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-xl font-bold md:text-2xl">Add product</h1>
      <Notice error={error} />
      {/* ?barcode= comes from the POS "not found" link and is looked up automatically */}
      <ProductForm initialBarcode={(barcode ?? "").slice(0, 40)} />
    </div>
  );
}
