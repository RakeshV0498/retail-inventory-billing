import Link from "next/link";
import { getViewer, requireAuth } from "@/lib/session";
import { getDb } from "@/db/client";
import { todayISO } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { formatQty } from "@/lib/qty";
import { restoreProductAction, writeOffAllExpiredAction, writeOffFromListAction } from "@/app/actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { ExpiryBadge, Notice } from "@/components/ui";
import {
  expiredCostLost,
  getExpiredBatches,
  getExpiringBatches,
  getLowStock,
  listArchivedProducts,
  listProducts,
} from "@/services/inventory";
import { getSettings } from "@/services/settings";

export const dynamic = "force-dynamic";

const TABS = [
  ["all", "All products"],
  ["low", "Low stock"],
  ["expiring", "Near expiry"],
  ["expired", "Expired"],
  ["archived", "Archived"],
] as const;

function doneMessage(done: string | undefined): string | undefined {
  if (!done) return undefined;
  if (done === "archived") return "Product archived. It no longer appears in POS or lists. You can restore it here.";
  if (done === "deleted") return "Product deleted.";
  if (/^\d+$/.test(done)) return done === "0" ? "Nothing to write off." : `Wrote off ${done} batch${done === "1" ? "" : "es"}. Recorded as expired wastage.`;
  return undefined;
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ tab?: string; days?: string; q?: string; error?: string; done?: string }> }) {
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
      <div className="flex items-center justify-between gap-3">
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

      <Notice error={sp.error} ok={doneMessage(sp.done)} />

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
      {tab === "expired" && <ExpiredPanel today={today} canWriteOff={(await getViewer()).can("stock.writeoff")} />}
      {tab === "archived" && <ArchivedList canRestore={(await getViewer()).can("product.archive")} />}
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

function ExpiredPanel({ today, canWriteOff }: { today: string; canWriteOff: boolean }) {
  const rows = getExpiredBatches(getDb(), today);
  const lost = expiredCostLost(rows);
  if (rows.length === 0) {
    return <div className="card text-slate-600">No expired stock. 🎉</div>;
  }
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-semibold">{rows.length} expired batch{rows.length === 1 ? "" : "es"} blocked from sale</div>
          <div className="text-sm text-slate-600">Stock value at cost: {formatPaise(lost)}</div>
        </div>
        {canWriteOff && (
        <form action={writeOffAllExpiredAction}>
          <ConfirmSubmit
            className="btn-danger"
            message={`Write off all ${rows.length} expired batch(es)? Stock worth ${formatPaise(lost)} (at cost) will be removed and recorded as wastage. This cannot be undone.`}
          >
            Write off all {rows.length}
          </ConfirmSubmit>
        </form>
        )}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-slate-50"><tr>
            <th className="th">Product / batch</th><th className="th text-right">Qty</th><th className="th">Expiry</th><th className="th" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.batch.id}>
                <td className="td"><Link href={`/inventory/${r.product.id}`} className="font-medium hover:underline">{r.product.name}</Link>
                  <div className="text-xs text-slate-500">Batch {r.batch.batchNumber}</div></td>
                <td className="td text-right">{formatQty(r.batch.quantityAvailable)} {r.product.unitType}</td>
                <td className="td"><ExpiryBadge expiryDate={r.batch.expiryDate} today={today} /></td>
                <td className="td text-right">
                  {canWriteOff && (
                  <form action={writeOffFromListAction}>
                    <input type="hidden" name="batchId" value={r.batch.id} />
                    <ConfirmSubmit
                      className="btn-danger min-h-10 whitespace-nowrap px-3 text-sm"
                      message={`Write off ${formatQty(r.batch.quantityAvailable)} ${r.product.unitType} of ${r.product.name} (batch ${r.batch.batchNumber})? This cannot be undone.`}
                    >
                      Write off
                    </ConfirmSubmit>
                  </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ArchivedList({ canRestore }: { canRestore: boolean }) {
  const rows = listArchivedProducts(getDb());
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full">
        <thead className="bg-slate-50"><tr><th className="th">Archived product</th><th className="th" /></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="td"><Link href={`/inventory/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                <div className="text-xs text-slate-500">{p.sku}</div></td>
              <td className="td text-right">
                {canRestore && (
                  <form action={restoreProductAction}>
                    <input type="hidden" name="productId" value={p.id} />
                    <button className="btn-secondary min-h-10 px-3 text-sm">Restore</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={2}>No archived products. Archive a product from its page to hide it from POS and lists.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
