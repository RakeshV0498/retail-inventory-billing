"use client";

import Link from "next/link";
import { useEffect } from "react";

const FORMATS = [
  ["58", "58mm"],
  ["80", "80mm"],
  ["a4", "A4"],
] as const;

export function PrintControls({ invoiceId, format, autoPrint }: { invoiceId: number; format: string; autoPrint: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        window.print();
      }
    };
    window.addEventListener("keydown", onKey);
    const t = autoPrint ? window.setTimeout(() => window.print(), 400) : undefined;
    return () => {
      window.removeEventListener("keydown", onKey);
      if (t) window.clearTimeout(t);
    };
  }, [autoPrint]);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
      <Link href="/pos" className="btn-primary">New bill</Link>
      <button onClick={() => window.print()} className="btn-secondary">Print (Ctrl+P)</button>
      <div className="ml-auto flex gap-1" role="group" aria-label="Paper size">
        {FORMATS.map(([k, label]) => (
          <Link key={k} href={`/invoices/${invoiceId}?format=${k}`} replace
            className={`btn ${format === k ? "bg-slate-800 text-white" : "border border-slate-300 bg-white"}`}>{label}</Link>
        ))}
      </div>
    </div>
  );
}
