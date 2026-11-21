import { daysBetween } from "@/lib/dates";

export function ExpiryBadge({ expiryDate, today }: { expiryDate: string | null; today: string }) {
  if (!expiryDate) return <span className="text-xs text-slate-400">No expiry</span>;
  const days = daysBetween(today, expiryDate);
  const [cls, text] =
    days < 0
      ? ["bg-red-100 text-red-800", `Expired ${-days}d ago`]
      : days <= 30
        ? ["bg-amber-100 text-amber-900", `${days}d left`]
        : days <= 60
          ? ["bg-yellow-100 text-yellow-900", `${days}d left`]
          : ["bg-slate-100 text-slate-700", expiryDate];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

export function Notice({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>;
  if (ok) return <p role="status" className="mb-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{ok}</p>;
  return null;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
