"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { barcodeLookupAction, checkoutAction, searchProductsAction } from "@/app/actions";
import { CustomerPicker, type PickedCustomer } from "@/components/pos/CustomerPicker";
import { BarcodeScannerModal } from "@/components/scanner/BarcodeScannerModal";
import { useBarcodeWedge } from "@/hooks/useBarcodeWedge";
import { previewCartLine } from "@/lib/cart";
import { todayISO } from "@/lib/dates";
import { calcInvoiceTotals, type DiscountType, type GstRate } from "@/lib/gst";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQty, MILLI, toMilli } from "@/lib/qty";
import type { ProductStock } from "@/services/inventory";

type PayMode = "cash" | "upi" | "card" | "split" | "credit";

interface CartLine {
  product: ProductStock;
  /** milli-units */
  qty: number;
  discountType: DiscountType;
  /** percent -> hundredths of a percent; flat -> paise */
  discountValue: number;
  /** Apply each batch's own near-expiry markdown rule (server recomputes it). */
  auto: boolean;
}

function QtyInput({ value, step, decimal, onChange }: { value: number; step: number; decimal: boolean; onChange: (milli: number) => void }) {
  const [text, setText] = useState(formatQty(value));
  useEffect(() => setText(formatQty(value)), [value]);
  const commit = () => {
    try {
      const m = toMilli(text);
      if (m > 0) return onChange(m);
    } catch {}
    setText(formatQty(value));
  };
  return (
    <div className="flex items-center">
      <button type="button" aria-label="Decrease quantity" className="btn-secondary size-11 rounded-r-none px-0 text-xl"
        onClick={() => value - step > 0 && onChange(value - step)}>−</button>
      <input aria-label="Quantity" value={text} inputMode={decimal ? "decimal" : "numeric"}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()}
        className="w-16 rounded-none border-x-0 text-center" />
      <button type="button" aria-label="Increase quantity" className="btn-secondary size-11 rounded-l-none px-0 text-xl"
        onClick={() => onChange(value + step)}>+</button>
    </div>
  );
}

export function PosClient() {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductStock[]>([]);
  const [hi, setHi] = useState(0);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [scanning, setScanning] = useState(false);
  const [payMode, setPayMode] = useState<PayMode>("cash");
  const [split, setSplit] = useState({ cash: "", upi: "", card: "", credit: "" });
  const [picked, setPicked] = useState<PickedCustomer | null>(null);
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [missing, setMissing] = useState<string | null>(null); // scanned barcode we have no product for
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [paying, startPay] = useTransition();
  const today = todayISO();

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  /* ---- search (debounced) ---- */
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      searchProductsAction(q).then((r) => {
        if (live) {
          setResults(r);
          setHi(0);
        }
      });
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);

  /* ---- cart ops ---- */
  const addProduct = useCallback(
    (p: ProductStock) => {
      if (p.sellableQty <= 0) {
        flash("err", p.expiredQty > 0 ? `${p.name}: only expired stock — cannot sell` : `${p.name}: out of stock`);
        return;
      }
      setCart((c) => {
        const i = c.findIndex((l) => l.product.id === p.id);
        if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: l.qty + MILLI } : l));
        const auto = p.sellableBatches.some((b) => b.markdownPercent > 0);
        return [...c, { product: p, qty: MILLI, discountType: "none" as DiscountType, discountValue: 0, auto }];
      });
      setQuery("");
      setResults([]);
      searchRef.current?.focus();
    },
    [flash],
  );

  const onBarcode = useCallback(
    async (code: string) => {
      setScanning(false);
      setQuery("");
      const p = await barcodeLookupAction(code);
      if (!p) {
        setMissing(code);
        return flash("err", `No product with barcode ${code}`);
      }
      setMissing(null);
      addProduct(p);
      flash("ok", `Added ${p.name}`);
    },
    [addProduct, flash],
  );
  useBarcodeWedge(onBarcode);

  const update = (id: number, patch: Partial<CartLine>) =>
    setCart((c) => c.map((l) => (l.product.id === id ? { ...l, ...patch } : l)));
  const remove = (id: number) => setCart((c) => c.filter((l) => l.product.id !== id));

  /* ---- live totals (same pure functions as the server) ---- */
  const previews = useMemo(
    () =>
      cart.map((l) =>
        previewCartLine({
          batches: l.product.sellableBatches,
          quantity: l.qty,
          gstRate: l.product.gstRate as GstRate,
          discountType: l.discountType,
          discountValue: l.discountValue,
          applyMarkdown: l.auto,
          today,
        }),
      ),
    [cart, today],
  );
  const hasError = previews.some((p) => p.error);
  const totals = useMemo(
    () => calcInvoiceTotals(previews.flatMap((p) => p.allocations.map((a) => a.calc))),
    [previews],
  );

  const splitPaise = (k: "cash" | "upi" | "card" | "credit") => {
    try {
      return split[k].trim() ? rupeesToPaise(split[k]) : 0;
    } catch {
      return NaN;
    }
  };
  const splitSum = splitPaise("cash") + splitPaise("upi") + splitPaise("card") + splitPaise("credit");
  const splitOk = payMode !== "split" || splitSum === totals.grandTotal;
  // How much of this bill goes on the customer's account (a customer is then required).
  const creditPaise = payMode === "credit" ? totals.grandTotal : payMode === "split" ? splitPaise("credit") || 0 : 0;
  const needsCustomer = creditPaise > 0;
  const canPay = cart.length > 0 && !hasError && splitOk && (!needsCustomer || !!picked) && !paying;

  const pay = useCallback(() => {
    if (!canPay) return;
    startPay(async () => {
      const res = await checkoutAction({
        items: cart.map((l) => ({
          productId: l.product.id,
          quantity: l.qty,
          discountType: l.discountType,
          discountValue: l.discountValue,
          applyMarkdown: l.auto,
        })),
        paymentMode: payMode,
        customerId: needsCustomer && picked ? picked.id : null,
        customerName: needsCustomer ? null : customer.name || null,
        customerPhone: needsCustomer ? null : customer.phone || null,
        split:
          payMode === "split"
            ? { cash: splitPaise("cash"), upi: splitPaise("upi"), card: splitPaise("card"), credit: splitPaise("credit") }
            : null,
      });
      if (res.ok) router.push(`/invoices/${res.invoiceId}?print=1`);
      else flash("err", res.error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPay, cart, payMode, customer, split, picked, needsCustomer, router, flash]);

  /* ---- keyboard shortcuts: F2 search, F9 pay ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F9") {
        e.preventDefault();
        pay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pay]);

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const exact = /^\d{6,}$/.test(query.trim());
      if (results[hi]) addProduct(results[hi]);
      else if (exact) onBarcode(query.trim());
    } else if (e.key === "Escape") {
      setQuery("");
      setResults([]);
    }
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-4 md:grid-cols-[1fr_22rem]">
      {/* Left: search + cart */}
      <div className="space-y-3">
        <div className="relative">
          <div className="flex gap-2">
            <input ref={searchRef} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
              placeholder="Search name / SKU / barcode  (F2)" aria-label="Search products" aria-autocomplete="list"
              className="min-h-12 flex-1 text-lg" />
            <button type="button" onClick={() => setScanning(true)} className="btn-primary min-h-12 px-4" aria-label="Scan barcode with camera">
              <span aria-hidden>📷</span><span className="hidden sm:inline">Scan</span>
            </button>
          </div>
          {results.length > 0 && (
            <ul role="listbox" className="absolute z-10 mt-1 max-h-80 w-full overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg">
              {results.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === hi}>
                  <button type="button" onClick={() => addProduct(p)} onMouseEnter={() => setHi(i)}
                    className={`flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left ${i === hi ? "bg-emerald-50" : ""}`}>
                    <span>
                      <span className="block font-medium">{p.name}</span>
                      <span className="block text-xs text-slate-500">{p.sku}{p.nextBatch?.expiryDate ? ` · exp ${p.nextBatch.expiryDate}` : ""}</span>
                    </span>
                    <span className="text-right text-sm">
                      <span className="block font-semibold">{p.nextBatch ? formatPaise(p.nextBatch.sellingPrice) : "—"}</span>
                      <span className={p.sellableQty > 0 ? "text-slate-500" : "font-medium text-red-700"}>
                        {p.sellableQty > 0 ? `${formatQty(p.sellableQty)} ${p.unitType}` : p.expiredQty > 0 ? "Expired" : "Out of stock"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {missing && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <span className="text-amber-900">Barcode <strong>{missing}</strong> isn&apos;t in your inventory.</span>
            <span className="flex gap-2">
              <Link href={`/inventory/new?barcode=${encodeURIComponent(missing)}`} className="btn-primary min-h-10 px-3">Add it as a new product</Link>
              <button type="button" onClick={() => setMissing(null)} className="btn-secondary min-h-10 px-3" aria-label="Dismiss">✕</button>
            </span>
          </div>
        )}

        {toast && (
          <p role="status" className={`rounded-lg p-3 text-sm ${toast.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{toast.text}</p>
        )}

        {cart.length === 0 ? (
          <div className="card py-10 text-center text-slate-500">Scan or search to add items.<br />USB scanners work anywhere on this screen.</div>
        ) : (
          <ul className="space-y-2">
            {cart.map((l, i) => {
              const pv = previews[i]!;
              const decimal = l.product.allowDecimalQty;
              return (
                <li key={l.product.id} className={`card ${pv.error ? "border-red-300" : ""}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{l.product.name}</div>
                      <div className="text-xs text-slate-500">
                        {pv.allocations.map((a) => `${a.batchNumber}×${formatQty(a.quantity)}`).join(" + ") || "—"} · GST {l.product.gstRate}%
                      </div>
                    </div>
                    <button type="button" aria-label={`Remove ${l.product.name}`} onClick={() => remove(l.product.id)} className="btn-secondary size-11 px-0">✕</button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <QtyInput value={l.qty} step={decimal ? 250 : MILLI} decimal={decimal} onChange={(q) => update(l.product.id, { qty: q })} />
                    <span className="text-xs text-slate-500">{l.product.unitType}</span>
                    <div className="flex items-center gap-1">
                      <select aria-label="Discount type" value={l.auto ? "auto" : l.discountType} className="w-40"
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "auto") update(l.product.id, { auto: true, discountType: "none", discountValue: 0 });
                          else update(l.product.id, { auto: false, discountType: v as DiscountType, discountValue: 0 });
                        }}>
                        <option value="none">No disc</option>
                        {l.product.sellableBatches.some((b) => b.markdownPercent > 0) && <option value="auto">Auto markdown</option>}
                        <option value="percent">% off</option><option value="flat">₹ off</option>
                      </select>
                      {l.discountType !== "none" && (
                        <input aria-label="Discount value" inputMode="decimal" className="w-20" key={l.discountType}
                          defaultValue={l.discountValue / 100}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isFinite(n) || n < 0) return;
                            update(l.product.id, { discountValue: Math.round(n * 100) });
                          }} />
                      )}
                    </div>
                    <div className="ml-auto text-right text-lg font-semibold">{pv.error ? "—" : formatPaise(pv.lineTotal)}</div>
                  </div>
                  {l.auto && pv.allocations.some((a) => a.calc.discountAmount > 0) && (
                    <p className="mt-1 text-xs text-amber-700">
                      Near-expiry markdown on {pv.allocations.filter((a) => a.calc.discountAmount > 0).map((a) => a.batchNumber).join(", ")}
                    </p>
                  )}
                  {pv.error && <p role="alert" className="mt-1 text-sm text-red-700">{pv.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Right: totals + payment */}
      <aside className="space-y-3 md:sticky md:top-4 md:self-start">
        <div className="card space-y-1 text-sm">
          <Row label="Subtotal" value={formatPaise(totals.subtotal)} />
          {totals.discountTotal > 0 && <Row label="Discount" value={`− ${formatPaise(totals.discountTotal)}`} />}
          <Row label="Taxable value" value={formatPaise(totals.taxableTotal)} />
          <Row label="GST (incl.)" value={formatPaise(totals.taxTotal)} />
          {totals.roundOff !== 0 && <Row label="Round off" value={formatPaise(totals.roundOff)} />}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-xl font-bold">
            <span>Total</span><span>{formatPaise(totals.grandTotal)}</span>
          </div>
        </div>

        <div className="card space-y-3">
          <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Payment mode">
            {(["cash", "upi", "card", "split", "credit"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={payMode === m} onClick={() => setPayMode(m)}
                className={`btn px-1 text-sm ${m === "upi" ? "uppercase" : "capitalize"} ${payMode === m ? "bg-emerald-700 text-white" : "border border-slate-300 bg-white"}`}>{m}</button>
            ))}
          </div>
          {payMode === "split" && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["cash", "upi", "card", "credit"] as const).map((k) => (
                <label key={k} className="text-xs capitalize">{k} ₹
                  <input inputMode="decimal" value={split[k]} onChange={(e) => setSplit((s) => ({ ...s, [k]: e.target.value }))} className="w-full" />
                </label>
              ))}
              <button type="button" className="btn-secondary col-span-2 min-h-10 text-xs sm:col-span-4"
                onClick={() => {
                  const others = splitPaise("cash") + splitPaise("upi") + splitPaise("card");
                  if (Number.isNaN(others) || others > totals.grandTotal) return;
                  const rest = totals.grandTotal - others;
                  setSplit((s) => ({ ...s, credit: rest ? String(rest / 100) : "" }));
                }}>
                Put the rest on credit
              </button>
              <p className={`col-span-2 text-xs sm:col-span-4 ${splitOk ? "text-emerald-700" : "text-red-700"}`}>
                {splitOk ? "Split matches total" : `Split ${Number.isNaN(splitSum) ? "invalid" : formatPaise(splitSum)} ≠ ${formatPaise(totals.grandTotal)}`}
              </p>
            </div>
          )}
          {needsCustomer && <CustomerPicker value={picked} onChange={setPicked} creditAmount={creditPaise} />}
          {!needsCustomer && (
          <details>
            <summary className="cursor-pointer text-sm text-slate-600">Customer (optional)</summary>
            <div className="mt-2 grid gap-2">
              <input placeholder="Name" value={customer.name} onChange={(e) => setCustomer((c) => ({ ...c, name: e.target.value }))} />
              <input placeholder="Phone" inputMode="tel" value={customer.phone} onChange={(e) => setCustomer((c) => ({ ...c, phone: e.target.value }))} />
            </div>
          </details>
          )}
        </div>

        <div className="fixed inset-x-0 bottom-14 z-20 border-t border-slate-200 bg-white p-2 md:static md:border-0 md:bg-transparent md:p-0">
          <button type="button" disabled={!canPay} onClick={pay} className="btn-primary min-h-14 w-full text-lg">
            {paying ? "Saving…" : payMode === "credit" ? `Put ${formatPaise(totals.grandTotal)} on credit` : `Pay ${formatPaise(totals.grandTotal)}`} <span className="hidden text-xs opacity-80 md:inline">(F9)</span>
          </button>
        </div>
      </aside>

      {scanning && <BarcodeScannerModal onDetected={onBarcode} onClose={() => setScanning(false)} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-600"><span>{label}</span><span>{value}</span></div>
  );
}
