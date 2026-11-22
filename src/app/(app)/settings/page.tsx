import { getDb } from "@/db/client";
import { requireAuth } from "@/lib/session";
import { Field, Notice } from "@/components/ui";
import { getSettings } from "@/services/settings";
import { logoutAction, removePinAction, saveSettingsAction, setPinAction } from "@/app/actions";
import { isDemo } from "@/db/bootstrap";
import { isPinEnabled } from "@/services/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; pinerror?: string }> }) {
  await requireAuth();
  const sp = await searchParams;
  const s = getSettings(getDb());
  const pinOn = isPinEnabled(getDb());
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
      {!isDemo() && (
        <section className="card mt-4 space-y-3" aria-labelledby="pin-h">
          <h2 id="pin-h" className="font-semibold">PIN protection</h2>
          <Notice error={sp.pinerror} />
          {pinOn ? <p className="text-sm text-emerald-800">PIN is on. Everyone must enter it (30-day sessions).</p>
            : <p className="text-sm text-slate-600">Off — anyone who can reach this app can use it. Set a 4–12 digit PIN.</p>}
          <form action={setPinAction} className="grid gap-3 md:grid-cols-3">
            {pinOn && <Field label="Current PIN"><input name="currentPin" type="password" inputMode="numeric" required className="w-full" /></Field>}
            <Field label={pinOn ? "New PIN" : "PIN"}><input name="newPin" type="password" inputMode="numeric" pattern="\d{4,12}" required className="w-full" /></Field>
            <Field label="Confirm PIN"><input name="confirmPin" type="password" inputMode="numeric" pattern="\d{4,12}" required className="w-full" /></Field>
            <div className="md:col-span-3"><button className="btn-primary">{pinOn ? "Change PIN" : "Turn on PIN"}</button></div>
          </form>
          {pinOn && (
            <form action={removePinAction} className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
              <Field label="Current PIN"><input name="currentPin" type="password" inputMode="numeric" required /></Field>
              <button className="btn-secondary">Turn PIN off</button>
            </form>
          )}
        </section>
      )}
      <form action={logoutAction} className="mt-4"><button className="btn-secondary">Log out</button></form>
      <p className="mt-4 text-sm text-slate-600">Backup: copy <code>data/app.db</code> while the app is idle.</p>
    </div>
  );
}
