"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { todayISO } from "@/lib/dates";
import { rupeesToPaise } from "@/lib/money";
import { toMilli } from "@/lib/qty";
import { createInvoice, type InvoiceInput } from "@/services/billing";
import {
  addBatch,
  createProduct,
  findByBarcode,
  searchProducts,
  writeOffBatch,
  type ProductStock,
} from "@/services/inventory";
import { saveSettings } from "@/services/settings";

function errMsg(e: unknown): string {
  if (e instanceof ZodError) return e.issues[0]?.message ?? "Invalid input";
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const optStr = (f: FormData, k: string) => str(f, k) || null;

/* ---------- POS ---------- */

export async function searchProductsAction(q: string): Promise<ProductStock[]> {
  return searchProducts(getDb(), q, todayISO());
}

export async function barcodeLookupAction(code: string): Promise<ProductStock | null> {
  return findByBarcode(getDb(), code, todayISO());
}

export type CheckoutResult = { ok: true; invoiceId: number } | { ok: false; error: string };

export async function checkoutAction(input: InvoiceInput): Promise<CheckoutResult> {
  try {
    const { invoice } = createInvoice(getDb(), input);
    revalidatePath("/", "layout");
    return { ok: true, invoiceId: invoice.id };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/* ---------- Inventory ---------- */

export async function createProductAction(form: FormData) {
  let id: number;
  try {
    const allowDecimal = form.get("allowDecimalQty") === "on";
    const product = createProduct(getDb(), {
      name: str(form, "name"),
      sku: str(form, "sku"),
      barcode: optStr(form, "barcode"),
      category: str(form, "category") as "grocery",
      unitType: str(form, "unitType") as "pcs",
      allowDecimalQty: allowDecimal,
      lowStockThreshold: toMilli(str(form, "lowStockThreshold") || "0"),
      gstRate: Number(str(form, "gstRate")) as 0,
      hsnCode: optStr(form, "hsnCode"),
    });
    id = product.id;
  } catch (e) {
    redirect(`/inventory/new?error=${encodeURIComponent(errMsg(e))}`);
  }
  revalidatePath("/inventory");
  redirect(`/inventory/${id}`);
}

export async function addBatchAction(form: FormData) {
  const productId = Number(str(form, "productId"));
  try {
    addBatch(getDb(), {
      productId,
      batchNumber: str(form, "batchNumber"),
      mfgDate: optStr(form, "mfgDate"),
      expiryDate: optStr(form, "expiryDate"),
      purchasePrice: rupeesToPaise(str(form, "purchasePrice")),
      mrp: rupeesToPaise(str(form, "mrp")),
      sellingPrice: rupeesToPaise(str(form, "sellingPrice")),
      quantity: toMilli(str(form, "quantity")),
    });
  } catch (e) {
    redirect(`/inventory/${productId}?error=${encodeURIComponent(errMsg(e))}`);
  }
  revalidatePath("/", "layout");
  redirect(`/inventory/${productId}?ok=1`);
}

export async function writeOffAction(form: FormData) {
  const productId = Number(str(form, "productId"));
  try {
    writeOffBatch(getDb(), Number(str(form, "batchId")));
  } catch (e) {
    redirect(`/inventory/${productId}?error=${encodeURIComponent(errMsg(e))}`);
  }
  revalidatePath("/", "layout");
  redirect(`/inventory/${productId}?ok=1`);
}

/* ---------- Settings ---------- */

export async function saveSettingsAction(form: FormData) {
  const fmt = str(form, "printFormat");
  saveSettings(getDb(), {
    storeName: str(form, "storeName") || "My Store",
    storeAddress: str(form, "storeAddress"),
    gstin: str(form, "gstin"),
    receiptFooter: str(form, "receiptFooter"),
    expiryWarnDays: Math.max(1, Number(str(form, "expiryWarnDays")) || 30),
    expiryWatchDays: Math.max(1, Number(str(form, "expiryWatchDays")) || 60),
    printFormat: fmt === "58" || fmt === "a4" ? fmt : "80",
  });
  revalidatePath("/", "layout");
  redirect("/settings?ok=1");
}
