"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createProductAction, lookupBarcodeAction, updateProductAction } from "@/app/actions";
import { BarcodeScannerModal } from "@/components/scanner/BarcodeScannerModal";
import { CATEGORIES, UNIT_TYPES } from "@/lib/constants";
import { GST_SLABS } from "@/lib/gst";
import type { Suggestion } from "@/lib/productLookup";
import type { LookupResult } from "@/services/productLookup";

type Phase = "idle" | "loading" | "done" | "failed";

/** Values shown when editing an existing product (threshold is in natural units, e.g. "2.5"). */
export interface EditableProduct {
  id: number;
  name: string;
  sku: string;
  barcode: string | null;
  category: string;
  unitType: string;
  gstRate: number;
  hsnCode: string | null;
  threshold: string;
  allowDecimalQty: boolean;
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="label">{label}</span>
    {children}
  </label>
);

/** Add-product form: scan or type a barcode first, look it up online, pick a match to prefill, then finish by hand. */
export function ProductForm({ initialBarcode = "", product }: { initialBarcode?: string; product?: EditableProduct }) {
  const editing = !!product;
  const [barcode, setBarcode] = useState(product?.barcode ?? initialBarcode);
  const [name, setName] = useState(product?.name ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [category, setCategory] = useState<string>(product?.category ?? "grocery");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const run = useRef(0); // ignore answers that arrive after a newer lookup started

  const lookup = useCallback(async (code: string) => {
    const mine = ++run.current;
    setPhase("loading");
    setResult(null);
    setFilledFrom(null);
    try {
      const res = await lookupBarcodeAction(code, product?.id);
      if (mine !== run.current) return;
      setResult(res);
      setPhase("done");
      if (res.barcode) {
        setBarcode(res.barcode);
        setSku((s) => s || (res.barcode as string)); // barcode makes a fine default SKU
      }
    } catch {
      if (mine === run.current) setPhase("failed");
    }
  }, [product?.id]);

  useEffect(() => {
    if (initialBarcode && !editing) void lookup(initialBarcode);
  }, [initialBarcode, editing, lookup]);

  const use = (s: Suggestion) => {
    setName(s.name);
    if (!editing) setCategory(s.category); // when editing, only the name is offered
    setFilledFrom(s.source);
    nameRef.current?.focus();
  };

  return (
    <form action={editing ? updateProductAction : createProductAction} className="card grid gap-4 md:grid-cols-2">
      {product && <input type="hidden" name="productId" value={product.id} />}
      {/* Barcode first: scan, type, or use a USB scanner (it types the digits and presses Enter). */}
      <div className="space-y-2 md:col-span-2">
        <Field label="Barcode (scan or type)">
          <div className="flex gap-2">
            <input
              name="barcode"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault(); // Enter looks up; it must never submit a half-filled form
                  if (barcode.trim()) void lookup(barcode);
                }
              }}
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              placeholder="e.g. 8901058852417"
              className="min-h-12 w-full flex-1 text-lg"
            />
            <button type="button" onClick={() => setScanning(true)} className="btn-primary min-h-12 px-4" aria-label="Scan barcode with camera">
              <span aria-hidden>📷</span> <span className="hidden sm:inline">Scan</span>
            </button>
            <button type="button" onClick={() => barcode.trim() && void lookup(barcode)} disabled={!barcode.trim() || phase === "loading"} className="btn-secondary min-h-12 px-4">
              Look up
            </button>
          </div>
        </Field>

        <div aria-live="polite" className="space-y-2 text-sm">
          {phase === "loading" && <p className="rounded-lg bg-slate-100 p-3 text-slate-700">Looking up…</p>}
          {phase === "failed" && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Lookup failed. Enter the details below.</p>}
          {phase === "done" && result && <Results result={result} onUse={use} filledFrom={filledFrom} />}
        </div>
      </div>

      <div className="md:col-span-2">
        <Field label="Name">
          <input ref={nameRef} name="name" required value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
        </Field>
      </div>
      <Field label="SKU">
        <input name="sku" required value={sku} onChange={(e) => setSku(e.target.value)} className="w-full" />
      </Field>
      <Field label="Category">
        <select name="category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-full">
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Unit">
        <select name="unitType" defaultValue={product?.unitType ?? "pcs"} className="w-full">{UNIT_TYPES.map((u) => <option key={u} value={u}>{u}</option>)}</select>
        {editing && <span className="mt-1 block text-xs text-slate-500">pcs / strip / bottle can be swapped any time. Other changes are blocked once there is stock history.</span>}
      </Field>
      <Field label="GST slab">
        <select name="gstRate" defaultValue={String(product?.gstRate ?? 0)} className="w-full">{GST_SLABS.map((g) => <option key={g} value={g}>{g}%</option>)}</select>
        {editing && <span className="mt-1 block text-xs text-slate-500">Applies to future bills only. Old invoices keep their GST.</span>}
      </Field>
      <Field label="HSN code (optional)"><input name="hsnCode" defaultValue={product?.hsnCode ?? ""} className="w-full" /></Field>
      <Field label="Low-stock threshold"><input name="lowStockThreshold" type="number" step="any" min="0" defaultValue={product?.threshold ?? "0"} className="w-full" /></Field>
      <label className="flex min-h-11 items-center gap-2 md:col-span-2">
        <input type="checkbox" name="allowDecimalQty" defaultChecked={product?.allowDecimalQty ?? false} className="size-5 min-h-0" />
        <span className="text-sm">Sold loose (allow decimal qty, e.g. 0.25 kg)</span>
      </label>
      <div className="md:col-span-2"><button className="btn-primary min-h-12 w-full md:w-auto">{editing ? "Save changes" : "Save & add stock"}</button></div>

      {scanning && (
        <BarcodeScannerModal
          onDetected={(code) => {
            setScanning(false);
            setBarcode(code);
            void lookup(code);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </form>
  );
}

function Results({ result, onUse, filledFrom }: { result: LookupResult; onUse: (s: Suggestion) => void; filledFrom: string | null }) {
  if (result.status === "invalid") {
    return <p className="rounded-lg bg-amber-50 p-3 text-amber-900">That doesn&apos;t look like a barcode (6 to 14 digits). Check it, or enter the details below.</p>;
  }
  return (
    <>
      {!result.valid && (
        <p className="rounded-lg bg-amber-50 p-3 text-amber-900">The check digit doesn&apos;t match, so the scan may be misread. Scan again to be sure.</p>
      )}
      {result.local && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-amber-900">
            {result.local.isActive ? "Already in your inventory: " : "Already in your inventory (archived): "}
            <strong>{result.local.name}</strong>
          </p>
          <Link href={`/inventory/${result.local.id}`} className="btn-secondary min-h-10 px-3">
            {result.local.isActive ? "Open it" : "Open & restore"}
          </Link>
        </div>
      )}
      {!result.local && result.suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="font-medium text-slate-700">Found online. Tap one to fill the form, then check it:</p>
          {result.suggestions.map((s) => (
            <div key={`${s.source}-${s.name}`} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2">
              {s.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.imageUrl} alt="" width={56} height={56} loading="lazy" referrerPolicy="no-referrer"
                  className="size-14 shrink-0 rounded object-contain" onError={(e) => (e.currentTarget.style.display = "none")} />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.name}</div>
                <div className="text-xs text-slate-500">{s.source}</div>
              </div>
              <button type="button" onClick={() => onUse(s)} className="btn-primary min-h-10 shrink-0 px-3">Use this</button>
            </div>
          ))}
          <p className="text-xs text-slate-500">Online data is crowd-sourced and can be wrong. Prices, GST and unit are yours to enter.</p>
        </div>
      )}
      {!result.local && result.status === "not_found" && (
        <p className="rounded-lg bg-slate-100 p-3 text-slate-700">No online match (common for medicines and local brands). Enter the details below. Next time this barcode will be remembered.</p>
      )}
      {!result.local && result.status === "offline" && (
        <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Couldn&apos;t reach the online product database. Check the internet connection, or enter the details below.</p>
      )}
      {filledFrom && <p className="rounded-lg bg-emerald-50 p-3 text-emerald-800">Filled from {filledFrom}. Check the name, then complete the rest.</p>}
    </>
  );
}
