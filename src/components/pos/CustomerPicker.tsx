"use client";

import { useEffect, useState } from "react";
import { createCustomerInlineAction, searchCustomersAction } from "@/app/actions";
import { formatPaise } from "@/lib/money";

export interface PickedCustomer {
  id: number;
  name: string;
  phone: string | null;
  /** what they owe before this bill, paise */
  balance: number;
}

/** Find a customer by name/phone or add a new one on the spot. Used when any part of a bill goes on credit. */
export function CustomerPicker({
  value,
  onChange,
  creditAmount,
}: {
  value: PickedCustomer | null;
  onChange: (c: PickedCustomer | null) => void;
  creditAmount: number;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickedCustomer[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setResults([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      searchCustomersAction(text).then((rows) => {
        if (live) setResults(rows.map((r) => ({ id: r.customer.id, name: r.customer.name, phone: r.customer.phone, balance: r.balance })));
      });
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  if (value) {
    return (
      <div className="space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold text-emerald-900">{value.name}</div>
            {value.phone && <div className="text-xs text-emerald-800">{value.phone}</div>}
          </div>
          <button type="button" onClick={() => onChange(null)} className="btn-secondary min-h-10 px-3 text-sm">Change</button>
        </div>
        <div className="flex justify-between text-slate-700"><span>Owes now</span><span>{formatPaise(value.balance)}</span></div>
        <div className="flex justify-between font-semibold text-slate-900"><span>After this bill</span><span>{formatPaise(value.balance + creditAmount)}</span></div>
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await createCustomerInlineAction(draft.name, draft.phone);
    setSaving(false);
    if (!res.ok) return setError(res.error);
    onChange({ id: res.customer.id, name: res.customer.name, phone: res.customer.phone, balance: 0 });
  };

  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">Who is this credit for? (required)</p>
      {!adding ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer by name or phone" aria-label="Search customers" className="w-full" />
          {results.length > 0 && (
            <ul className="max-h-56 overflow-auto rounded-lg border border-slate-200 bg-white">
              {results.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => onChange(r)} className="flex min-h-12 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-emerald-50">
                    <span><span className="block font-medium">{r.name}</span>{r.phone && <span className="block text-xs text-slate-500">{r.phone}</span>}</span>
                    <span className={`text-sm ${r.balance > 0 ? "text-red-700" : "text-slate-500"}`}>{r.balance > 0 ? `owes ${formatPaise(r.balance)}` : "no dues"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {q.trim() && results.length === 0 && <p className="text-xs text-slate-600">No match. Add them as a new customer.</p>}
          <button type="button" onClick={() => { setAdding(true); setDraft({ name: q.trim(), phone: "" }); }} className="btn-secondary min-h-10 w-full text-sm">+ New customer</button>
        </>
      ) : (
        <div className="space-y-2">
          <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Name" aria-label="New customer name" className="w-full" />
          <input value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} placeholder="Phone (for reminders, optional)" inputMode="tel" aria-label="New customer phone" className="w-full" />
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={saving || !draft.name.trim()} className="btn-primary min-h-10 flex-1">{saving ? "Saving…" : "Save customer"}</button>
            <button type="button" onClick={() => { setAdding(false); setError(null); }} className="btn-secondary min-h-10 px-3">Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
