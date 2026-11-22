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
import { amendInvoice, updateInvoiceDetails, voidInvoice, type InvoiceDetailsInput } from "@/services/sales";
import {
  createCustomer,
  recordPayment,
  searchCustomers,
  updateCustomer,
  voidPayment,
  type CustomerWithBalance,
} from "@/services/customers";
import { saveSettings } from "@/services/settings";
import { endSession, getActor, getCurrentUser, requireAuth, requirePermission, startSession } from "@/lib/session";
import {
  actorOf,
  authenticate,
  changeOwnPin,
  createFirstAdmin,
  createUser,
  hasUsers,
  setActive,
  setRole,
  setUserPin,
} from "@/services/users";
import { ROLES } from "@/db/schema";

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
  await requirePermission("sale.create");
  try {
    const { invoice } = createInvoice(getDb(), input, new Date(), await getActor());
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

/* ---------- Admin control of sales (void / amend / edit) ---------- */

/** Void a bill: stock back to its batches, dues reversed, record kept. Redirects back to the bill. */
export async function voidInvoiceAction(form: FormData) {
  await requirePermission("sale.void");
  const id = Number(str(form, "invoiceId"));
  let error: string | null = null;
  try {
    voidInvoice(getDb(), id, await getActor(), str(form, "reason"));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/invoices/${id}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect(`/invoices/${id}`);
}

/** Replace a bill with a corrected one (original voided in the same transaction). Called from the amend editor. */
export async function amendInvoiceAction(payload: { invoiceId: number; reason: string; input: InvoiceInput }): Promise<CheckoutResult> {
  await requirePermission("sale.amend");
  try {
    const { replacement } = amendInvoice(getDb(), Number(payload.invoiceId), payload.input, await getActor(), String(payload.reason ?? ""));
    revalidatePath("/", "layout");
    return { ok: true, invoiceId: replacement.invoice.id };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Edit customer / notes / payment split of a bill (no stock or total changes). */
export async function updateInvoiceDetailsAction(payload: { invoiceId: number; details: InvoiceDetailsInput }): Promise<CheckoutResult> {
  await requirePermission("sale.edit");
  try {
    const { invoice } = updateInvoiceDetails(getDb(), Number(payload.invoiceId), payload.details, await getActor());
    revalidatePath("/", "layout");
    return { ok: true, invoiceId: invoice.id };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function voidPaymentAction(form: FormData) {
  await requirePermission("payment.void");
  const customerId = Number(str(form, "customerId"));
  let error: string | null = null;
  try {
    voidPayment(getDb(), Number(str(form, "paymentId")), await getActor(), str(form, "reason"));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/customers/${customerId}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect(`/customers/${customerId}?ok=1`);
}

/* ---------- Customers & credit ---------- */

export async function searchCustomersAction(q: string): Promise<CustomerWithBalance[]> {
  await requireAuth();
  return searchCustomers(getDb(), String(q).slice(0, 60));
}

/** Add a customer from the POS without leaving the bill. */
export async function createCustomerInlineAction(
  name: string,
  phone: string,
): Promise<{ ok: true; customer: { id: number; name: string; phone: string | null } } | { ok: false; error: string }> {
  await requirePermission("customer.create");
  try {
    const c = createCustomer(getDb(), { name: String(name).slice(0, 100), phone: String(phone).slice(0, 30) });
    return { ok: true, customer: { id: c.id, name: c.name, phone: c.phone } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function createCustomerAction(form: FormData) {
  await requirePermission("customer.create");
  let id = 0;
  let error: string | null = null;
  try {
    id = createCustomer(getDb(), { name: str(form, "name"), phone: optStr(form, "phone"), notes: optStr(form, "notes") }).id;
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/customers?error=${encodeURIComponent(error)}`);
  revalidatePath("/customers");
  redirect(`/customers/${id}?ok=1`);
}

export async function updateCustomerAction(form: FormData) {
  await requirePermission("customer.edit");
  const id = Number(str(form, "customerId"));
  let error: string | null = null;
  try {
    updateCustomer(getDb(), id, { name: str(form, "name"), phone: optStr(form, "phone"), notes: optStr(form, "notes") });
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/customers/${id}?error=${encodeURIComponent(error)}`);
  revalidatePath("/customers");
  redirect(`/customers/${id}?ok=1`);
}

export async function recordPaymentAction(form: FormData) {
  await requirePermission("payment.record");
  const id = Number(str(form, "customerId"));
  let error: string | null = null;
  try {
    const mode = str(form, "mode");
    if (mode !== "cash" && mode !== "upi" && mode !== "card") throw new Error("Choose how it was paid");
    recordPayment(getDb(), id, rupeesToPaise(str(form, "amount")), mode, optStr(form, "note"), new Date(), await getActor());
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/customers/${id}?error=${encodeURIComponent(error)}`);
  revalidatePath("/", "layout");
  redirect(`/customers/${id}?ok=1`);
}

/* ---------- Inventory ---------- */

export async function createProductAction(form: FormData) {
  await requirePermission("product.create");
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
  await requirePermission("product.edit");
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
  await requirePermission("batch.edit");
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
  await requirePermission("stock.adjust");
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
  await requirePermission("stock.receive");
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
  await requirePermission("stock.writeoff");
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
  await requirePermission("stock.writeoff");
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
  await requirePermission("stock.writeoff");
  const res = writeOffExpired(getDb(), todayISO());
  revalidatePath("/", "layout");
  redirect(`/inventory?tab=expired&done=${res.batches}`);
}

export async function archiveProductAction(form: FormData) {
  await requirePermission("product.archive");
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
  await requirePermission("product.archive");
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
  await requirePermission("product.delete");
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
  await requirePermission("settings.edit");
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


/* ---------- Accounts & sessions ---------- */

export async function loginAction(form: FormData) {
  const db = getDb();
  if (!hasUsers(db)) redirect("/");
  const res = authenticate(db, str(form, "username"), str(form, "pin"));
  if (!res.ok) {
    const msg = res.locked ? `Too many attempts. Try again in ${res.retryAfterSec}s.` : "Wrong username or PIN";
    redirect(`/login?error=${encodeURIComponent(msg)}`);
  }
  await startSession(res.user.id);
  redirect("/");
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

/** First-run: create the first admin (only works while no accounts exist), then sign them in. */
export async function setupFirstAdminAction(form: FormData) {
  await requireAuth(); // open while no accounts exist; once they do you must be signed in (and the service refuses anyway)
  let id = 0;
  let error: string | null = null;
  const pin = str(form, "pin");
  if (pin !== str(form, "confirmPin")) error = "PINs do not match";
  else {
    try {
      id = createFirstAdmin(getDb(), { username: str(form, "username"), displayName: str(form, "displayName"), pin }).id;
    } catch (e) {
      error = errMsg(e);
    }
  }
  if (error) redirect(`/settings?accounterror=${encodeURIComponent(error)}`);
  await startSession(id);
  revalidatePath("/", "layout");
  redirect("/settings?ok=1");
}

/** Anyone signed in can change their OWN PIN (current PIN required). */
export async function changeOwnPinAction(form: FormData) {
  await requireAuth();
  const user = await getCurrentUser();
  let error: string | null = null;
  if (!user) error = "Set up accounts first";
  else if (str(form, "newPin") !== str(form, "confirmPin")) error = "PINs do not match";
  else {
    try {
      changeOwnPin(getDb(), user.id, str(form, "currentPin"), str(form, "newPin"));
    } catch (e) {
      error = errMsg(e);
    }
  }
  if (error || !user) redirect(`/settings?pinerror=${encodeURIComponent(error ?? "Not signed in")}`);
  await startSession(user.id); // the PIN change invalidated every session, including this one
  redirect("/settings?ok=1");
}

export async function createUserAction(form: FormData) {
  const me = await requirePermission("users.manage");
  let error: string | null = null;
  try {
    const role = str(form, "role");
    if (!ROLES.includes(role as "admin")) throw new Error("Choose a role");
    createUser(
      getDb(),
      { username: str(form, "username"), displayName: str(form, "displayName"), pin: str(form, "pin"), role: role as "admin" },
      actorOf(me),
    );
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/settings?accounterror=${encodeURIComponent(error)}`);
  revalidatePath("/settings");
  redirect("/settings?ok=1");
}

export async function resetUserPinAction(form: FormData) {
  const me = await requirePermission("users.manage");
  let error: string | null = null;
  try {
    setUserPin(getDb(), Number(str(form, "userId")), str(form, "pin"), actorOf(me));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/settings?accounterror=${encodeURIComponent(error)}`);
  revalidatePath("/settings");
  redirect("/settings?ok=1");
}

export async function setUserRoleAction(form: FormData) {
  const me = await requirePermission("users.manage");
  let error: string | null = null;
  try {
    const role = str(form, "role");
    if (!ROLES.includes(role as "admin")) throw new Error("Choose a role");
    setRole(getDb(), Number(str(form, "userId")), role as "admin", actorOf(me));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/settings?accounterror=${encodeURIComponent(error)}`);
  revalidatePath("/settings");
  redirect("/settings?ok=1");
}

export async function setUserActiveAction(form: FormData) {
  const me = await requirePermission("users.manage");
  let error: string | null = null;
  try {
    setActive(getDb(), Number(str(form, "userId")), str(form, "active") === "1", actorOf(me));
  } catch (e) {
    error = errMsg(e);
  }
  if (error) redirect(`/settings?accounterror=${encodeURIComponent(error)}`);
  revalidatePath("/settings");
  redirect("/settings?ok=1");
}
