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
  adjustStock,
  archiveProduct,
  createProduct,
  deleteProduct,
  findByBarcode,
  restoreProduct,
  searchProducts,
  updateBatch,
  updateProduct,
  writeOffBatch,
  writeOffExpired,
  type ProductStock,
} from "@/services/inventory";
import { lookupBarcode, type LookupResult } from "@/services/productLookup";
import { saveSettings } from "@/services/settings";
import { checkPin, isPinEnabled, removePin, setPin } from "@/services/auth";
import { endSession, requireAuth, startSession } from "@/lib/session";

function errMsg(e: unknown): string {
  if (e instanceof ZodError) return e.issues[0]?.message ?? "Invalid input";
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const optStr = (f: FormData, k: string) => str(f, k) || null;

/* ---------- POS ---------- */

export async function searchProductsAction(q: string): Promise<ProductStock[]> {
  await requireAuth();
  return searchProducts(getDb(), String(q).slice(0, 100), todayISO());
}

export async function barcodeLookupAction(code: string): Promise<ProductStock | null> {
  await requireAuth();
  return findByBarcode(getDb(), String(code).slice(0, 40), todayISO());
}

export type CheckoutResult = { ok: true; invoiceId: number } | { ok: false; error: string };

export async function checkoutAction(input: InvoiceInput): Promise<CheckoutResult> {
  await requireAuth();
  try {
    const { invoice } = createInvoice(getDb(), input);
    revalidatePath("/", "layout");
    return { ok: true, invoiceId: invoice.id };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Look a scanned/typed barcode up in the shop's own inventory, then online (Open Food Facts family). */
export async function lookupBarcodeAction(code: string, excludeProductId?: number): Promise<LookupResult> {
  await requireAuth();
  const exclude = Number.isInteger(excludeProductId) ? excludeProductId : undefined;
  return lookupBarcode(getDb(), String(code).slice(0, 40), { excludeProductId: exclude });
}

/* ---------- Inventory ---------- */

export async function createProductAction(form: FormData) {
  await requireAuth();
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

export async function updateProductAction(form: FormData) {
  await requireAuth();
  const id = Number(str(form, "productId"));
  let error: string | null = null;
  try {
    updateProduct(getDb(), id, {
      name: str(form, "name"),
      sku: str(form, "sku"),
      barcode: optStr(form, "barcode"),
      category: str(form, "category") as "grocery",
      unitType: str(form, "unitType") as "pcs",
      allowDecimalQty: form.get("allowDecimalQty") === "on",
      lowStockThreshold: toMilli(str(form, "lowStockThreshold") || "0"),
      gstRate: Number(str(form, "gstRate")) as 0,
      hsnCode: optStr(form, "hsnCode"),
    });
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/inventory/${id}/edit?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect(`/inventory/${id}?ok=1`);
}

export async function updateBatchAction(form: FormData) {
  await requireAuth();
  const productId = Number(str(form, "productId"));
  const batchId = Number(str(form, "batchId"));
  let error: string | null = null;
  try {
    updateBatch(getDb(), batchId, {
      batchNumber: str(form, "batchNumber"),
      mfgDate: optStr(form, "mfgDate"),
      expiryDate: optStr(form, "expiryDate"),
      purchasePrice: rupeesToPaise(str(form, "purchasePrice")),
      mrp: rupeesToPaise(str(form, "mrp")),
      sellingPrice: rupeesToPaise(str(form, "sellingPrice")),
    });
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/inventory/${productId}/batches/${batchId}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect(`/inventory/${productId}?ok=1`);
}

export async function adjustStockAction(form: FormData) {
  await requireAuth();
  const productId = Number(str(form, "productId"));
  const batchId = Number(str(form, "batchId"));
  let error: string | null = null;
  try {
    adjustStock(getDb(), batchId, toMilli(str(form, "newQuantity")), str(form, "reason"));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/inventory/${productId}/batches/${batchId}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect(`/inventory/${productId}?ok=1`);
}

export async function addBatchAction(form: FormData) {
  await requireAuth();
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
  await requireAuth();
  const productId = Number(str(form, "productId"));
  try {
    writeOffBatch(getDb(), Number(str(form, "batchId")));
  } catch (e) {
    redirect(`/inventory/${productId}?error=${encodeURIComponent(errMsg(e))}`);
  }
  revalidatePath("/", "layout");
  redirect(`/inventory/${productId}?ok=1`);
}

/** Single batch write-off from the Expired tab. */
export async function writeOffFromListAction(form: FormData) {
  await requireAuth();
  let error: string | null = null;
  try {
    writeOffBatch(getDb(), Number(str(form, "batchId")));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/inventory?tab=expired&error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect("/inventory?tab=expired&done=1");
}

export async function writeOffAllExpiredAction() {
  await requireAuth();
  const res = writeOffExpired(getDb(), todayISO());
  revalidatePath("/", "layout");
  redirect(`/inventory?tab=expired&done=${res.batches}`);
}

export async function archiveProductAction(form: FormData) {
  await requireAuth();
  const id = Number(str(form, "productId"));
  let error: string | null = null;
  try {
    archiveProduct(getDb(), id);
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/inventory/${id}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect("/inventory?tab=archived&done=archived");
}

export async function restoreProductAction(form: FormData) {
  await requireAuth();
  const id = Number(str(form, "productId"));
  let error: string | null = null;
  try {
    restoreProduct(getDb(), id);
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/inventory/${id}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect(`/inventory/${id}?ok=1`);
}

export async function deleteProductAction(form: FormData) {
  await requireAuth();
  const id = Number(str(form, "productId"));
  let error: string | null = null;
  try {
    deleteProduct(getDb(), id);
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/inventory/${id}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect("/inventory?done=deleted");
}

/* ---------- Settings ---------- */

export async function saveSettingsAction(form: FormData) {
  await requireAuth();
  const fmt = str(form, "printFormat");
  saveSettings(getDb(), {
    storeName: str(form, "storeName").slice(0, 100) || "My Store",
    storeAddress: str(form, "storeAddress").slice(0, 200),
    gstin: str(form, "gstin").slice(0, 20),
    receiptFooter: str(form, "receiptFooter").slice(0, 200),
    expiryWarnDays: Math.max(1, Number(str(form, "expiryWarnDays")) || 30),
    expiryWatchDays: Math.max(1, Number(str(form, "expiryWatchDays")) || 60),
    printFormat: fmt === "58" || fmt === "a4" ? fmt : "80",
  });
  revalidatePath("/", "layout");
  redirect("/settings?ok=1");
}

/* ---------- PIN / session ---------- */

export async function loginAction(form: FormData) {
  const db = getDb();
  if (!isPinEnabled(db)) redirect("/");
  const res = checkPin(db, str(form, "pin"));
  if (!res.ok) {
    const msg = res.locked ? `Too many attempts. Try again in ${res.retryAfterSec}s.` : "Wrong PIN";
    redirect(`/login?error=${encodeURIComponent(msg)}`);
  }
  await startSession();
  redirect("/");
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

export async function setPinAction(form: FormData) {
  await requireAuth();
  const pin = str(form, "newPin");
  let error: string | null = null;
  if (pin !== str(form, "confirmPin")) error = "PINs do not match";
  else {
    try {
      setPin(getDb(), pin, str(form, "currentPin"));
    } catch (e) {
      error = errMsg(e);
    }
  }
  if (error) redirect(`/settings?pinerror=${encodeURIComponent(error)}`);
  // Rotating the secret signed everyone out, including this browser; sign it back in.
  await startSession();
  redirect("/settings?ok=1");
}

export async function removePinAction(form: FormData) {
  await requireAuth();
  let error: string | null = null;
  try {
    removePin(getDb(), str(form, "currentPin"));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/settings?pinerror=${encodeURIComponent(error)}`);
  await endSession();
  redirect("/settings?ok=1");
}
