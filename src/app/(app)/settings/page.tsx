import Link from "next/link";
import {
  changeOwnPinAction,
  createUserAction,
  logoutAction,
  resetUserPinAction,
  saveSettingsAction,
  setUserActiveAction,
  setUserRoleAction,
  setupFirstAdminAction,
} from "@/app/actions";
import { isDemo } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { Field, Notice } from "@/components/ui";
import { getViewer, requireAuth } from "@/lib/session";
import { getSettings } from "@/services/settings";
import { listUsers } from "@/services/users";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; pinerror?: string; accounterror?: string }>;
}) {
  await requireAuth();
  const sp = await searchParams;
  const db = getDb();
  const viewer = await getViewer();
  const me = viewer.user;
  const s = getSettings(db);
  const demo = isDemo();
  const canEditStore = viewer.can("settings.edit");
  const manageUsers = viewer.can("users.manage") && viewer.accountsOn;
  const people = manageUsers ? listUsers(db) : [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-bold md:text-2xl">Settings</h1>
      <Notice ok={sp.ok ? "Saved." : undefined} />

      {/* ---- everyone: who am I, change my PIN, log out ---- */}
      {me && (
        <section className="card space-y-3" aria-labelledby="me-h">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="me-h" className="font-semibold">My account</h2>
              <p className="text-sm text-slate-600">
                {me.displayName} · <span className="capitalize">{me.role}</span> · username <code>{me.username}</code>
              </p>
            </div>
            <form action={logoutAction}><button className="btn-secondary min-h-10 px-3 text-sm">Log out</button></form>
          </div>
          <Notice error={sp.pinerror} />
          <form action={changeOwnPinAction} className="grid gap-3 md:grid-cols-3">
            <Field label="Current PIN"><input name="currentPin" type="password" inputMode="numeric" autoComplete="current-password" required className="w-full" /></Field>
            <Field label="New PIN"><input name="newPin" type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,12}" required className="w-full" /></Field>
            <Field label="Confirm new PIN"><input name="confirmPin" type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,12}" required className="w-full" /></Field>
            <div className="md:col-span-3"><button className="btn-secondary">Change my PIN</button></div>
          </form>
        </section>
      )}

      {/* ---- first-time setup (accounts are optional until the first admin exists) ---- */}
      {!demo && !viewer.accountsOn && (
        <section className="card space-y-3 border-amber-300 bg-amber-50" aria-labelledby="setup-h">
          <h2 id="setup-h" className="font-semibold">Set up accounts</h2>
          <p className="text-sm text-amber-900">
            Right now anyone who can open this app can use it, and bills don&apos;t record who made them. Create the first <strong>admin</strong> account to turn on sign-in.
            You can then add staff accounts. Admins can edit and void sales; staff can bill and receive stock.
          </p>
          <Notice error={sp.accounterror} />
          <form action={setupFirstAdminAction} className="grid gap-3 md:grid-cols-2">
            <Field label="Your name"><input name="displayName" required maxLength={60} autoComplete="name" className="w-full" /></Field>
            <Field label="Username (letters/numbers, e.g. owner)"><input name="username" required minLength={3} maxLength={30} autoCapitalize="none" autoCorrect="off" className="w-full" /></Field>
            <Field label="PIN (4 to 12 digits)"><input name="pin" type="password" inputMode="numeric" pattern="\d{4,12}" required autoComplete="new-password" className="w-full" /></Field>
            <Field label="Confirm PIN"><input name="confirmPin" type="password" inputMode="numeric" pattern="\d{4,12}" required autoComplete="new-password" className="w-full" /></Field>
            <div className="md:col-span-2"><button className="btn-primary min-h-12 w-full md:w-auto">Create admin &amp; turn on sign-in</button></div>
          </form>
        </section>
      )}

      {/* ---- admin: manage accounts ---- */}
      {manageUsers && (
        <section className="card space-y-4" aria-labelledby="users-h">
          <div className="flex items-center justify-between gap-3">
            <h2 id="users-h" className="font-semibold">Accounts</h2>
            <Link href="/activity" className="text-sm text-emerald-800 hover:underline">Activity log →</Link>
          </div>
          <Notice error={sp.accounterror} />
          <ul className="divide-y divide-slate-100">
            {people.map((u) => (
              <li key={u.id} className={`space-y-2 py-3 ${u.isActive ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{u.displayName}{me?.id === u.id && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}</div>
                    <div className="text-xs text-slate-500">{u.username} · <span className="capitalize">{u.role}</span>{u.isActive ? "" : " · deactivated"}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <form action={setUserRoleAction} className="flex gap-1">
                      <input type="hidden" name="userId" value={u.id} />
                      <select name="role" defaultValue={u.role} aria-label={`Role for ${u.username}`} className="min-h-10 w-28 text-sm">
                        <option value="staff">Staff</option><option value="admin">Admin</option>
                      </select>
                      <button className="btn-secondary min-h-10 px-3 text-sm">Set</button>
                    </form>
                    <form action={setUserActiveAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="active" value={u.isActive ? "0" : "1"} />
                      <ConfirmSubmit className="btn-secondary min-h-10 px-3 text-sm"
                        message={u.isActive ? `Deactivate ${u.displayName}? They are signed out and can't sign in until reactivated. Their past bills stay.` : `Reactivate ${u.displayName}?`}>
                        {u.isActive ? "Deactivate" : "Reactivate"}
                      </ConfirmSubmit>
                    </form>
                  </div>
                </div>
                <form action={resetUserPinAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="userId" value={u.id} />
                  <label className="text-xs text-slate-600">New PIN for {u.username}
                    <input name="pin" type="password" inputMode="numeric" pattern="\d{4,12}" required autoComplete="new-password" className="block min-h-10 w-40" />
                  </label>
                  <button className="btn-secondary min-h-10 px-3 text-sm">Reset PIN</button>
                </form>
              </li>
            ))}
          </ul>
          <details className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer font-medium">+ Add a user</summary>
            <form action={createUserAction} className="mt-3 grid gap-3 md:grid-cols-2">
              <Field label="Name"><input name="displayName" required maxLength={60} className="w-full" /></Field>
              <Field label="Username"><input name="username" required minLength={3} maxLength={30} autoCapitalize="none" autoCorrect="off" className="w-full" /></Field>
              <Field label="PIN (4 to 12 digits)"><input name="pin" type="password" inputMode="numeric" pattern="\d{4,12}" required autoComplete="new-password" className="w-full" /></Field>
              <Field label="Role">
                <select name="role" defaultValue="staff" className="w-full"><option value="staff">Staff (bills, receives stock)</option><option value="admin">Admin (everything)</option></select>
              </Field>
              <div className="md:col-span-2"><button className="btn-primary min-h-12 w-full md:w-auto">Add user</button></div>
            </form>
          </details>
        </section>
      )}

      {/* ---- admin: store settings ---- */}
      {canEditStore && (
        <form action={saveSettingsAction} className="card grid gap-4 md:grid-cols-2">
          <h2 className="font-semibold md:col-span-2">Store</h2>
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
      )}

      {canEditStore && <p className="text-sm text-slate-600">Backup: copy <code>data/app.db</code> while the app is idle.</p>}
    </div>
  );
}
