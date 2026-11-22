import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isAuthed } from "@/lib/session";
import { hasUsers } from "@/services/users";
import { Notice } from "@/components/ui";
import { loginAction } from "@/app/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Login · Retail Billing" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!hasUsers(getDb()) || (await isAuthed())) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-bold text-emerald-800">Retail Billing</h1>
      <p className="mb-4 text-sm text-slate-600">Sign in with your username and PIN.</p>
      <Notice error={error} />
      <form action={loginAction} className="card space-y-3">
        <input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus
          placeholder="Username" aria-label="Username" className="min-h-12 w-full text-lg" />
        <input name="pin" type="password" inputMode="numeric" autoComplete="current-password" pattern="\d{4,12}" required
          placeholder="PIN" aria-label="PIN" className="min-h-14 w-full text-center text-2xl tracking-widest" />
        <button className="btn-primary min-h-12 w-full">Sign in</button>
      </form>
    </main>
  );
}
