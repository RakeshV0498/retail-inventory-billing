import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isDemo } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { createSessionToken, isPinEnabled, isValidSession, SESSION_DAYS } from "@/services/auth";

export const SESSION_COOKIE = "rib_session";

/** True when no PIN is set (or demo mode), or the request carries a valid session cookie. */
export async function isAuthed(): Promise<boolean> {
  // Always read cookies first: this opts the page into dynamic rendering. Without it, a build made
  // while no PIN is set would prerender protected pages as static HTML that is served to everyone.
  const jar = await cookies();
  if (isDemo()) return true;
  const db = getDb();
  if (!isPinEnabled(db)) return true;
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && isValidSession(db, token);
}

/**
 * Call at the top of EVERY page, server action and route handler. Layouts are not re-rendered on
 * client navigation and actions can be invoked directly, so a layout-only check is not enough.
 */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) redirect("/login");
}

export async function startSession(): Promise<void> {
  const proto = (await headers()).get("x-forwarded-proto");
  (await cookies()).set(SESSION_COOKIE, createSessionToken(getDb()), {
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
