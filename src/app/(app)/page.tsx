import Link from "next/link";
import { getViewer, requireAuth } from "@/lib/session";
import { getDb } from "@/db/client";
import { todayISO } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { isDemo } from "@/db/bootstrap";
import { formatQty } from "@/lib/qty";
import { ExpiryBadge, Notice } from "@/components/ui";
import { getDashboardStats } from "@/services/dashboard";
import { getExpiredBatches, getExpiringBatches, getLowStock } from "@/services/inventory";
import { getSettings } from "@/services/settings";

export const dynamic = "force-dynamic";

function Stat({ label, value, sub, href, tone }: { label: string; value: string | number; sub?: string; href?: string; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-slate-900";
  const body = (
    <div className="card h-full">
      <div className="text-sm text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold md:text-3xl ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  await requireAuth();
  const sp = await searchParams;
  const viewer = await getViewer();
  const showProfit = viewer.can("reports.view");
  const db = getDb();
  const now = new Date();
  const today = todayISO(now);
  const settings = getSettings(db);
  const stats = getDashboardStats(db, now);
  const low = getLowStock(db, today).slice(0, 6);
  const expiring = getExpiringBatches(db, today, settings.expiryWatchDays).slice(0, 6);
  const expired = getExpiredBatches(db, today);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="text-xl font-bold md:text-2xl">{settings.storeName}</h1>
        <div className="flex gap-2">
          <Link href="/pos" className="btn-primary min-h-12 flex-1 text-base md:min-h-11 md:flex-none">New bill</Link>
          <Link href="/settings" aria-label="Settings" className="btn-secondary size-12 shrink-0 px-0 text-xl md:size-auto md:min-h-11 md:px-4 md:text-base">
            <span aria-hidden className="md:hidden">⚙</span>
            <span className="hidden md:inline">Settings</span>
          </Link>
        </div>
      </div>

      {sp.denied && <Notice error="That needs an admin account. Ask an admin to do it." />}
      {!viewer.accountsOn && !isDemo() && viewer.can("users.manage") && (
        <Link href="/settings" className="block rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">
          Anyone can open this app and bills don&apos;t record who made them. Set up accounts (admin + staff) →
        </Link>
      )}

      <div className={`grid grid-cols-2 gap-3 ${showProfit ? "md:grid-cols-5" : "md:grid-cols-4"}`}>
        <Stat label="Today's sales" value={formatPaise(stats.todaySales)} sub={`${stats.todayInvoices} invoice(s)`} />
        {showProfit && <Stat label="Profit (estimate)" value={formatPaise(stats.profitEstimate)} sub="Excl. GST, vs purchase price" />}
        <Stat label="Low stock" value={stats.lowStockCount} href="/inventory?tab=low" tone={stats.lowStockCount ? "warn" : undefined} />
        <Stat label={`Expiring ≤ ${settings.expiryWarnDays}d`} value={stats.expiringSoonCount} href="/inventory?tab=expiring" tone={stats.expiringSoonCount ? "warn" : undefined} />
        <div className="col-span-2 md:col-span-1">
          <Stat label="Customer dues" value={formatPaise(stats.outstandingDues)} sub="Owed to you (udhaar)" href="/customers" tone={stats.outstandingDues ? "bad" : undefined} />
        </div>
      </div>

      {expired.length > 0 && (
        <Link href="/inventory?tab=expired" className="block rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">
          {expired.length} expired batch(es) still in stock — blocked from sale. Tap to write them off →
        </Link>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 font-semibold">Low stock</h2>
          {low.length === 0 ? <p className="text-sm text-slate-500">All stocked up.</p> : (
            <ul className="divide-y divide-slate-100">
              {low.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                  <Link href={`/inventory/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                  <span className="text-red-700">{formatQty(p.sellableQty)} {p.unitType} left</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">Expiring within {settings.expiryWatchDays} days</h2>
          {expiring.length === 0 ? <p className="text-sm text-slate-500">Nothing expiring soon.</p> : (
            <ul className="divide-y divide-slate-100">
              {expiring.map((e) => (
                <li key={e.batch.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link href={`/inventory/${e.product.id}`} className="font-medium hover:underline">
                    {e.product.name} <span className="text-slate-500">· {e.batch.batchNumber}</span>
                  </Link>
                  <ExpiryBadge expiryDate={e.batch.expiryDate} today={today} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
