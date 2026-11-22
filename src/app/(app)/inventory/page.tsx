import Link from "next/link";
import { requireAuth } from "@/lib/session";
import { getDb } from "@/db/client";
import { todayISO } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { ExpiryBadge } from "@/components/ui";
import { getExpiredBatches, getExpiringBatches, getLowStock, listProducts } from "@/services/inventory";
import { getSettings } from "@/services/settings";

export const dynamic = "force-dynamic";

const TABS = [
  ["all", "All products"],
  ["low", "Low stock"],
  ["expiring", "Near expiry"],
  ["expired", "Expired"],
] as const;

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ tab?: string; days?: string; q?: string }> }) {
  await requireAuth();
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? (sp.tab as string) : "all";
  const db = getDb();
  const today = todayISO();
  const settings = getSettings(db);
  const days = sp.days === String(settings.expiryWatchDays) ? settings.expiryWatchDays : settings.expiryWarnDays;
  const q = (sp.q ?? "").toLowerCase();

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold md:text-2xl">Inventory</h1>
        <Link href="/inventory/new" className="btn-primary">+ Add product</Link>
      </div>

      <div className="flex gap-1 overflow-x-auto" role="tablist">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/inventory?tab=${k}`} role="tab" aria-selected={tab === k}
            className={`btn whitespace-nowrap ${tab === k ? "bg-emerald-700 text-white" : "border border-slate-300 bg-white"}`}>
            {label}
          </Link>
        ))}
      </div>

      {tab === "all" && <AllProducts today={today} q={q} />}
      {tab === "low" && <LowStock today={today} />}
      {tab === "expiring" && (
        <>
          <div className="flex gap-2 text-sm">
            {[settings.expiryWarnDays, settings.expiryWatchDays].map((d) => (
              <Link key={d} href={`/inventory?tab=expiring&days=${d}`}
                className={`btn ${days === d ? "bg-amber-600 text-white" : "border border-slate-300 bg-white"}`}>
                Within {d} days
              </Link>
            ))}
          </div>
          <ExpiryTable today={today} rows={getExpiringBatches(db, today, days)} empty="No batches expiring in this window." />
        </>
      )}
      {tab === "expired" && (
        <ExpiryTable today={today} rows={getExpiredBatches(db, today)} empty="No expired stock. 🎉" />
      )}
    </div>
  );
}

function AllProducts({ today, q }: { today: string; q: string }) {
  const rows = listProducts(getDb(), today).filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode ?? "").includes(q));
  return (
    <div className="card overflow-x-auto p-0">
      <form className="border-b border-slate-100 p-3">
        <input name="q" defaultValue={q} placeholder="Filter by name, SKU or barcode" className="w-full md:w-80" />
      </form>
      <table className="w-full">
        <thead className="bg-slate-50"><tr>
          <th className="th">Product</th><th className="th hidden md:table-cell">Category</th>
          <th className="th text-right">Sellable</th><th className="th hidden text-right md:table-cell">Price</th><th className="th">Next expiry</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50">
              <td className="td"><Link href={`/inventory/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                <div className="text-xs text-slate-500">{p.sku}</div></td>
              <td className="td hidden capitalize md:table-cell">{p.category}</td>
              <td className={`td text-right ${p.sellableQty <= p.lowStockThreshold ? "font-semibold text-red-700" : ""}`}>
                {formatQty(p.sellableQty)} {p.unitType}
                {p.expiredQty > 0 && <div className="text-xs text-red-600">+{formatQty(p.expiredQty)} expired</div>}
              </td>
              <td className="td hidden text-right md:table-cell">{p.nextBatch ? formatPaise(p.nextBatch.sellingPrice) : "—"}</td>
              <td className="td">{p.nextBatch ? <ExpiryBadge expiryDate={p.nextBatch.expiryDate} today={today} /> : "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={5}>No products found.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function LowStock({ today }: { today: string }) {
  const rows = getLowStock(getDb(), today);
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full">
        <thead className="bg-slate-50"><tr><th className="th">Product</th><th className="th text-right">Sellable</th><th className="th text-right">Threshold</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="td"><Link href={`/inventory/${p.id}`} className="font-medium hover:underline">{p.name}</Link></td>
              <td className="td text-right font-semibold text-red-700">{formatQty(p.sellableQty)} {p.unitType}</td>
              <td className="td text-right">{formatQty(p.lowStockThreshold)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={3}>Nothing is below its threshold.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ExpiryTable({ rows, today, empty }: { rows: ReturnType<typeof getExpiringBatches>; today: string; empty: string }) {
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full">
        <thead className="bg-slate-50"><tr><th className="th">Product / batch</th><th className="th text-right">Qty</th><th className="th">Expiry</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.batch.id}>
              <td className="td"><Link href={`/inventory/${r.product.id}`} className="font-medium hover:underline">{r.product.name}</Link>
                <div className="text-xs text-slate-500">Batch {r.batch.batchNumber}</div></td>
              <td className="td text-right">{formatQty(r.batch.quantityAvailable)} {r.product.unitType}</td>
              <td className="td"><ExpiryBadge expiryDate={r.batch.expiryDate} today={today} /></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={3}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
