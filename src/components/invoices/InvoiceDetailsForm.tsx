"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateInvoiceDetailsAction } from "@/app/actions";
import { CustomerPicker, type PickedCustomer } from "@/components/pos/CustomerPicker";
import { formatPaise, rupeesToPaise } from "@/lib/money";

type Mode = "cash" | "upi" | "card" | "split" | "credit";
const MODES: Mode[] = ["cash", "upi", "card", "split", "credit"];

export interface DetailsSeed {
  invoiceId: number;
  invoiceNumber: string;
  /** paise (the bill's total never changes here) */
  total: number;
  paymentMode: Mode;
  split: { cash: string; upi: string; card: string; credit: string };
  customer: PickedCustomer | null;
  walkIn: { name: string; phone: string };
  notes: string;
}

/** Edit who a bill is for, notes, and how it was paid. Items and totals are not editable here (use Amend). */
export function InvoiceDetailsForm({ seed }: { seed: DetailsSeed }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(seed.paymentMode);
  const [split, setSplit] = useState(seed.split);
  const [picked, setPicked] = useState<PickedCustomer | null>(seed.customer);
  const [linking, setLinking] = useState(false);
  const [walkIn, setWalkIn] = useState(seed.walkIn);
  const [notes, setNotes] = useState(seed.notes);
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();

  const paise = (k: keyof typeof split) => {
    try {
      return split[k].trim() ? rupeesToPaise(split[k]) : 0;
    } catch {
      return NaN;
    }
  };
  const sum = paise("cash") + paise("upi") + paise("card") + paise("credit");
  const splitOk = mode !== "split" || sum === seed.total;
  const credit = mode === "credit" ? seed.total : mode === "split" ? paise("credit") || 0 : 0;
  const needsCustomer = credit > 0;
  const showPicker = needsCustomer || !!picked || linking;
  const canSave = splitOk && (!needsCustomer || !!picked) && !saving;

  const save = () =>
    start(async () => {
      setError(null);
      const res = await updateInvoiceDetailsAction({
        invoiceId: seed.invoiceId,
        details: {
          paymentMode: mode,
          customerId: picked ? picked.id : null,
          customerName: picked ? null : walkIn.name || null,
          customerPhone: picked ? null : walkIn.phone || null,
          notes: notes || null,
          split: mode === "split" ? { cash: paise("cash"), upi: paise("upi"), card: paise("card"), credit: paise("credit") } : null,
        },
      });
      if (res.ok) router.push(`/invoices/${res.invoiceId}`);
      else setError(res.error);
    });

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      <section className="card space-y-3">
        <h2 className="font-semibold">How it was paid <span className="font-normal text-slate-500">(total {formatPaise(seed.total)})</span></h2>
        <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Payment mode">
          {MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
              className={`btn px-1 text-sm ${m === "upi" ? "uppercase" : "capitalize"} ${mode === m ? "bg-emerald-700 text-white" : "border border-slate-300 bg-white"}`}>{m}</button>
          ))}
        </div>
        {mode === "split" && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["cash", "upi", "card", "credit"] as const).map((k) => (
              <label key={k} className="text-xs capitalize">{k} ₹
                <input inputMode="decimal" value={split[k]} onChange={(e) => setSplit((s) => ({ ...s, [k]: e.target.value }))} className="w-full" />
              </label>
            ))}
            <p className={`col-span-2 text-xs sm:col-span-4 ${splitOk ? "text-emerald-700" : "text-red-700"}`}>
              {splitOk ? "Split matches the total" : `Split ${Number.isNaN(sum) ? "invalid" : formatPaise(sum)} ≠ ${formatPaise(seed.total)}`}
            </p>
          </div>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Customer</h2>
        {showPicker ? (
          <>
            <CustomerPicker value={picked} onChange={setPicked} creditAmount={credit} />
            {!needsCustomer && picked && (
              <button type="button" onClick={() => { setPicked(null); setLinking(false); }} className="btn-secondary min-h-10 text-sm">Remove customer from this bill</button>
            )}
          </>
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-2">
              <input placeholder="Name (walk-in)" aria-label="Walk-in name" value={walkIn.name} maxLength={100} onChange={(e) => setWalkIn((w) => ({ ...w, name: e.target.value }))} />
              <input placeholder="Phone" aria-label="Walk-in phone" inputMode="tel" value={walkIn.phone} maxLength={30} onChange={(e) => setWalkIn((w) => ({ ...w, phone: e.target.value }))} />
            </div>
            <button type="button" onClick={() => setLinking(true)} className="btn-secondary min-h-10 text-sm">Link a registered customer</button>
          </>
        )}
        {seed.paymentMode !== "cash" && seed.customer && picked?.id !== seed.customer.id && (
          <p className="text-xs text-amber-800">Changing the customer on a credit bill moves what they owe from {seed.customer.name} to the new customer.</p>
        )}
      </section>

      <section className="card space-y-1">
        <label className="label" htmlFor="inv-notes">Notes (optional)</label>
        <input id="inv-notes" value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} className="w-full" />
      </section>

      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={!canSave} className="btn-primary min-h-12 flex-1 md:flex-none">{saving ? "Saving…" : "Save changes"}</button>
        <Link href={`/invoices/${seed.invoiceId}`} className="btn-secondary min-h-12">Cancel</Link>
      </div>
      <p className="text-xs text-slate-500">Items, quantities and prices can&apos;t be changed here. Use <strong>Amend items</strong> for that. Every change is recorded in the activity log.</p>
    </div>
  );
}
