import { getDb } from "@/db/client";
import { Field, Notice } from "@/components/ui";
import { getSettings } from "@/services/settings";
import { saveSettingsAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const sp = await searchParams;
  const s = getSettings(getDb());
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-xl font-bold md:text-2xl">Settings</h1>
      <Notice ok={sp.ok ? "Settings saved." : undefined} />
      <form action={saveSettingsAction} className="card grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><Field label="Store name"><input name="storeName" defaultValue={s.storeName} className="w-full" /></Field></div>
        <div className="md:col-span-2"><Field label="Address"><input name="storeAddress" defaultValue={s.storeAddress} className="w-full" /></Field></div>
        <Field label="GSTIN"><input name="gstin" defaultValue={s.gstin} className="w-full" /></Field>
        <Field label="Default receipt size">
          <select name="printFormat" defaultValue={s.printFormat} className="w-full">
            <option value="58">58mm thermal</option><option value="80">80mm thermal</option><option value="a4">A4</option>
          </select>
        </Field>
        <Field label="Near-expiry window (days)"><input name="expiryWarnDays" type="number" min="1" defaultValue={s.expiryWarnDays} className="w-full" /></Field>
        <Field label="Wider expiry watch (days)"><input name="expiryWatchDays" type="number" min="1" defaultValue={s.expiryWatchDays} className="w-full" /></Field>
        <div className="md:col-span-2"><Field label="Receipt footer"><input name="receiptFooter" defaultValue={s.receiptFooter} className="w-full" /></Field></div>
        <div className="md:col-span-2"><button className="btn-primary w-full md:w-auto">Save settings</button></div>
      </form>
      <p className="mt-4 text-sm text-slate-600">Backup: copy <code>data/app.db</code> while the app is idle.</p>
    </div>
  );
}
