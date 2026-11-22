import Link from "next/link";
import { getDb } from "@/db/client";
import { addDaysISO, firstOfMonthISO, lastMonthRange, todayISO } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { requireAuth } from "@/lib/session";
import { getSalesReport } from "@/services/reports";
import { parseRange } from "./range";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports · Retail Billing" };

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold md:text-2xl">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requireAuth();
  const sp = await searchParams;
  const { from, to } = parseRange(sp.from, sp.to);
  const today = todayISO();
  const r = getSalesReport(getDb(), from, to);
  const last = lastMonthRange(today);
  const presets = [
    ["Today", today, today],
    ["Last 7 days", addDaysISO(today, -6), today],
    ["This month", firstOfMonthISO(today), today],
    ["Last month", last.from, last.to],
  ] as const;
  const q = `from=${from}&to=${to}`;
  const exports = [
    ["sales", "Invoices (sales)"],
    ["items", "Line items"],
    ["gst", "GST summary"],
    ["stock", "Current stock"],
  ] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-xl font-bold md:text-2xl">Reports</h1>

      <section className="card space-y-3 print:hidden">
        <div className="flex flex-wrap gap-2">
          {presets.map(([label, f, t]) => (
            <Link key={label} href={`/reports?from=${f}&to=${t}`}
              className={`btn ${f === from && t === to ? "bg-emerald-700 text-white" : "border border-slate-300 bg-white"}`}>{label}</Link>
          ))}
        </div>
        <form className="flex flex-wrap items-end gap-3">
          <label className="text-sm">From<input type="date" name="from" defaultValue={from} className="block" /></label>
          <label className="text-sm">To<input type="date" name="to" defaultValue={to} className="block" /></label>
          <button className="btn-primary">Show</button>
        </form>
      </section>

      <p className="text-sm text-slate-600">{from === to ? from : `${from} → ${to}`} · paid invoices only</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card label="Net sales" value={formatPaise(r.netSales)} sub={`${r.invoiceCount} invoice(s)`} />
        <Card label="Profit (estimate)" value={formatPaise(r.profitEstimate)} sub="Excl. GST, vs purchase price" />
        <Card label="Discounts given" value={formatPaise(r.discountTotal)} />
        <Card label="Taxable value" value={formatPaise(r.taxableTotal)} />
        <Card label="GST collected" value={formatPaise(r.taxTotal)} sub={`CGST ${formatPaise(r.cgst)} · SGST ${formatPaise(r.sgst)}`} />
        <Card label="Round-off" value={formatPaise(r.roundOff)} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 font-semibold">Payments</h2>
          <dl className="space-y-1 text-sm">
            {(["cash", "upi", "card"] as const).map((k) => (
              <div key={k} className="flex justify-between"><dt className="uppercase text-slate-600">{k}</dt><dd>{formatPaise(r.payments[k])}</dd></div>
            ))}
          </dl>
        </section>
        <section className="card overflow-x-auto">
          <h2 className="mb-2 font-semibold">GST by slab</h2>
          <table className="w-full text-sm">
            <thead><tr><th className="th px-0">Rate</th><th className="th text-right">Taxable</th><th className="th text-right">CGST</th><th className="th text-right">SGST</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {r.gstSlabs.map((s) => (
                <tr key={s.rate}><td className="py-1">{s.rate}%</td><td className="text-right">{formatPaise(s.taxable)}</td><td className="text-right">{formatPaise(s.cgst)}</td><td className="text-right">{formatPaise(s.sgst)}</td></tr>
              ))}
              {r.gstSlabs.length === 0 && <tr><td className="py-2 text-slate-500" colSpan={4}>No sales in this range.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="card overflow-x-auto">
          <h2 className="mb-2 font-semibold">Daily sales</h2>
          <table className="w-full text-sm">
            <thead><tr><th className="th px-0">Date</th><th className="th text-right">Invoices</th><th className="th text-right">Total</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {r.daily.map((d) => (
                <tr key={d.date}><td className="py-1">{d.date}</td><td className="text-right">{d.invoices}</td><td className="text-right">{formatPaise(d.total)}</td></tr>
              ))}
              {r.daily.length === 0 && <tr><td className="py-2 text-slate-500" colSpan={3}>No sales in this range.</td></tr>}
            </tbody>
          </table>
        </section>
        <section className="card overflow-x-auto">
          <h2 className="mb-2 font-semibold">Top products</h2>
          <table className="w-full text-sm">
            <thead><tr><th className="th px-0">Product</th><th className="th text-right">Qty</th><th className="th text-right">Revenue</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {r.topProducts.map((p) => (
                <tr key={p.productId}><td className="py-1">{p.name}</td><td className="text-right">{formatQty(p.quantity)}</td><td className="text-right">{formatPaise(p.revenue)}</td></tr>
              ))}
              {r.topProducts.length === 0 && <tr><td className="py-2 text-slate-500" colSpan={3}>No sales in this range.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card print:hidden">
        <h2 className="mb-2 font-semibold">Download CSV (opens in Excel / Google Sheets)</h2>
        <div className="flex flex-wrap gap-2">
          {exports.map(([k, label]) => (
            <a key={k} href={`/reports/export?type=${k}&${q}`} download className="btn-secondary">{label}</a>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">&ldquo;Current stock&rdquo; is a snapshot of today and ignores the date range.</p>
      </section>
    </div>
  );
}
