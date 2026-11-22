import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { ProductForm } from "@/components/inventory/ProductForm";
import { Notice } from "@/components/ui";
import { formatQty } from "@/lib/qty";
import { requirePermission } from "@/lib/session";
import { getProduct } from "@/services/inventory";

export const dynamic = "force-dynamic";

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("product.edit");
  const { id } = await params;
  const { error } = await searchParams;
  const product = getProduct(getDb(), Number(id));
  if (!product) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/inventory/${product.id}`} className="text-sm text-emerald-800 hover:underline">← {product.name}</Link>
      <h1 className="mb-4 text-xl font-bold md:text-2xl">Edit product</h1>
      <Notice error={error} />
      <ProductForm
        product={{
          id: product.id,
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          category: product.category,
          unitType: product.unitType,
          gstRate: product.gstRate,
          hsnCode: product.hsnCode,
          threshold: formatQty(product.lowStockThreshold),
          allowDecimalQty: product.allowDecimalQty,
        }}
      />
    </div>
  );
}
