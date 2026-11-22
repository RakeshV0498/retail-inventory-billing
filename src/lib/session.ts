import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isDemo } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { can, type Permission } from "@/lib/permissions";
import type { Actor } from "@/services/audit";
import { actorOf, createSessionToken, hasUsers, resolveSession, SESSION_DAYS, type SessionUser } from "@/services/users";

export const SESSION_COOKIE = "rib_session";

/**
 * The signed-in user, or null when nobody is signed in OR accounts aren't set up (open mode) OR demo mode.
 * Always reads cookies first: that opts the page into dynamic rendering.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  if (isDemo()) return null;
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? resolveSession(getDb(), token) : null;
}

/** True when accounts aren't set up (or demo mode), or the request carries a valid session for an active user. */
export async function isAuthed(): Promise<boolean> {
  // Cookies first, before any early return: otherwise a build made while no accounts exist would
  // prerender protected pages as static HTML that is served to everyone.
  const jar = await cookies();
  if (isDemo()) return true;
  const db = getDb();
  if (!hasUsers(db)) return true;
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && resolveSession(db, token) !== null;
}

/**
 * Call at the top of EVERY page, server action and route handler. Layouts are not re-rendered on
 * client navigation and actions can be invoked directly, so a layout-only check is not enough.
 */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) redirect("/login");
}

/**
 * Like requireAuth, and also checks the role's permission (see src/lib/permissions.ts). Staff who lack it are
 * sent to the dashboard with a notice. Returns the user (null in open mode / demo).
 */
export async function requirePermission(permission: Permission): Promise<SessionUser | null> {
  await requireAuth();
  const user = await getCurrentUser();
  if (!can(user?.role ?? null, permission)) redirect("/?denied=1");
  return user;
}

/** Who to record on invoices/payments/audit rows (null when accounts aren't set up). */
export async function getActor(): Promise<Actor | null> {
  return actorOf(await getCurrentUser());
}

/** For server components: who is looking, and what they may do (used to hide buttons; the guards are the real protection). */
export async function getViewer() {
  const user = await getCurrentUser();
  return {
    user,
    accountsOn: !isDemo() && hasUsers(getDb()),
    can: (p: Permission) => can(user?.role ?? null, p),
  };
}

export async function startSession(userId: number): Promise<void> {
  const proto = (await headers()).get("x-forwarded-proto");
  (await cookies()).set(SESSION_COOKIE, createSessionToken(getDb(), userId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
    // Secure only over HTTPS (e.g. `tailscale serve`) so plain-HTTP LAN access keeps working.
    secure: proto === "https",
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
