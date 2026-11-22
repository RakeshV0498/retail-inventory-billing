import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { ROLES, users, type User } from "@/db/schema";
import { hashPin, normalizeUsername, signSessionToken, validatePinFormat, verifyPin, verifySessionToken } from "@/lib/auth";
import type { Role } from "@/lib/permissions";
import { writeAudit, type Actor } from "./audit";
import { getSetting, setSetting } from "./settings";
import { ServiceError, type Q } from "./types";

export const SESSION_DAYS = 30;
export const MAX_ATTEMPTS = 5;
export const LOCK_SECONDS = 60;

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

const toSessionUser = (u: User): SessionUser => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role });
export const actorOf = (u: SessionUser | null): Actor | null => (u ? { id: u.id, name: u.displayName } : null);

/* ---------- login attempts: lockout PER USERNAME (in memory; a restart clears it) ---------- */

const attempts = new Map<string, { fails: number; until: number }>();
const MAX_TRACKED = 500;
const keyOf = (typed: string) => typed.trim().toLowerCase().slice(0, 60);

export function _resetLockouts() {
  attempts.clear();
}

function lockedFor(key: string, now: number): number {
  const a = attempts.get(key);
  return a && now < a.until ? Math.ceil((a.until - now) / 1000) : 0;
}

function recordFailure(key: string, now: number): { locked: boolean; retryAfterSec: number } {
  const a = attempts.get(key) ?? { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_ATTEMPTS) {
    a.fails = 0;
    a.until = now + LOCK_SECONDS * 1000;
  }
  attempts.delete(key); // re-insert so the oldest entry is evicted first
  attempts.set(key, a);
  if (attempts.size > MAX_TRACKED) attempts.delete(attempts.keys().next().value as string);
  return a.until > now ? { locked: true, retryAfterSec: LOCK_SECONDS } : { locked: false, retryAfterSec: 0 };
}

let dummy: string | null = null;
/** Verified against when the username doesn't exist, so "no such user" costs the same time as "wrong PIN". */
const dummyHash = () => (dummy ??= hashPin("00000000"));

export type LoginResult = { ok: true; user: SessionUser } | { ok: false; locked: boolean; retryAfterSec: number };

export function authenticate(db: Db, username: string, pin: string, now: number = Date.now()): LoginResult {
  const key = keyOf(username);
  const wait = lockedFor(key, now);
  if (wait > 0) return { ok: false, locked: true, retryAfterSec: wait };

  const uname = normalizeUsername(username);
  const user = uname ? db.select().from(users).where(eq(users.username, uname)).get() : undefined;
  const pinOk = verifyPin(pin, user?.pinHash ?? dummyHash());
  if (user && user.isActive && pinOk) {
    attempts.delete(key);
    return { ok: true, user: toSessionUser(user) };
  }
  return { ok: false, ...recordFailure(key, now) };
}

/* ---------- reading ---------- */

export function hasUsers(db: Q): boolean {
  return !!db.select({ id: users.id }).from(users).limit(1).get();
}

export function getUser(db: Q, id: number): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** Admins first, then by name. */
export function listUsers(db: Q): User[] {
  return db
    .select()
    .from(users)
    .orderBy(sql`case ${users.role} when 'admin' then 0 else 1 end`, asc(users.username))
    .all();
}

const activeAdmins = (db: Q) =>
  db.select({ n: sql<number>`count(*)` }).from(users).where(sql`${users.role} = 'admin' and ${users.isActive} = 1`).get()?.n ?? 0;

/* ---------- sessions ---------- */

function sessionSecret(db: Db): string {
  let s = getSetting(db, "sessionSecret");
  if (!s) {
    s = randomBytes(32).toString("hex");
    setSetting(db, "sessionSecret", s);
  }
  return s;
}

export function createSessionToken(db: Db, userId: number, now: number = Date.now()): string {
  const u = getUser(db, userId);
  if (!u) throw new ServiceError("NOT_FOUND", "User not found");
  return signSessionToken(sessionSecret(db), { userId: u.id, version: u.sessionVersion, expiresAt: now + SESSION_DAYS * 86_400_000 });
}

/** The signed-in user for a cookie, or null (bad/expired token, user deactivated, or PIN/role changed since). */
export function resolveSession(db: Db, token: string, now: number = Date.now()): SessionUser | null {
  const claims = verifySessionToken(sessionSecret(db), token, now);
  if (!claims) return null;
  const u = getUser(db, claims.userId);
  return u && u.isActive && u.sessionVersion === claims.version ? toSessionUser(u) : null;
}

/* ---------- writing ---------- */

const userInput = z.object({
  username: z.string().max(60),
  displayName: z.string().trim().min(1, "Enter the person's name").max(60),
  pin: z.string().max(40),
  role: z.enum(ROLES),
});
export type NewUser = z.input<typeof userInput>;

function parseNewUser(raw: NewUser) {
  const input = userInput.parse(raw);
  const username = normalizeUsername(input.username);
  if (!username) throw new ServiceError("INVALID_USERNAME", "Username must be 3 to 30 letters, numbers, dots, dashes or underscores");
  try {
    validatePinFormat(input.pin);
  } catch (e) {
    throw new ServiceError("INVALID_PIN", e instanceof Error ? e.message : "Invalid PIN");
  }
  return { username, displayName: input.displayName, pinHash: hashPin(input.pin), role: input.role };
}

const taken = (e: unknown) =>
  e instanceof Error && /UNIQUE/i.test(e.message) ? new ServiceError("USERNAME_TAKEN", "That username is already taken") : e;

export function createUser(db: Db, raw: NewUser, actor: Actor | null, now: Date = new Date()): User {
  const v = parseNewUser(raw);
  try {
    return db.transaction((tx) => {
      const u = tx.insert(users).values(v).returning().get();
      writeAudit(tx, actor, "user.create", "user", u.id, `Created ${u.role} account '${u.username}' (${u.displayName})`, now);
      return u;
    });
  } catch (e) {
    throw taken(e);
  }
}

/** First-run setup: only works while no accounts exist. */
export function createFirstAdmin(db: Db, raw: Omit<NewUser, "role">, now: Date = new Date()): User {
  const v = parseNewUser({ ...raw, role: "admin" });
  try {
    return db.transaction((tx) => {
      if (hasUsers(tx)) throw new ServiceError("ACCOUNTS_EXIST", "Accounts are already set up");
      const u = tx.insert(users).values(v).returning().get();
      writeAudit(tx, { id: u.id, name: u.displayName }, "user.create", "user", u.id, `Accounts set up: first admin '${u.username}'`, now);
      return u;
    });
  } catch (e) {
    throw taken(e);
  }
}

function checkPinOrThrow(pin: string) {
  try {
    validatePinFormat(pin);
  } catch (e) {
    throw new ServiceError("INVALID_PIN", e instanceof Error ? e.message : "Invalid PIN");
  }
}

/** Admin resets someone's PIN. Signs that user out everywhere. */
export function setUserPin(db: Db, userId: number, newPin: string, actor: Actor | null, now: Date = new Date()): void {
  checkPinOrThrow(newPin);
  db.transaction((tx) => {
    const u = getUser(tx, userId);
    if (!u) throw new ServiceError("NOT_FOUND", "User not found");
    tx.update(users).set({ pinHash: hashPin(newPin), sessionVersion: u.sessionVersion + 1 }).where(eq(users.id, userId)).run();
    writeAudit(tx, actor, "user.reset_pin", "user", userId, `Reset PIN for '${u.username}'`, now);
  });
}

/** A user changes their own PIN (current PIN required, shares the username's lockout). */
export function changeOwnPin(db: Db, userId: number, currentPin: string, newPin: string, now: Date = new Date()): void {
  checkPinOrThrow(newPin);
  const u = getUser(db, userId);
  if (!u) throw new ServiceError("NOT_FOUND", "User not found");
  const key = keyOf(u.username);
  const wait = lockedFor(key, now.getTime());
  if (wait > 0) throw new ServiceError("LOCKED", `Too many attempts. Try again in ${wait}s`);
  if (!verifyPin(currentPin, u.pinHash)) {
    const r = recordFailure(key, now.getTime());
    throw new ServiceError(r.locked ? "LOCKED" : "WRONG_PIN", r.locked ? `Too many attempts. Try again in ${r.retryAfterSec}s` : "Current PIN is incorrect");
  }
  attempts.delete(key);
  db.transaction((tx) => {
    tx.update(users).set({ pinHash: hashPin(newPin), sessionVersion: u.sessionVersion + 1 }).where(eq(users.id, userId)).run();
    writeAudit(tx, { id: u.id, name: u.displayName }, "user.change_pin", "user", userId, `'${u.username}' changed their own PIN`, now);
  });
}

export function setRole(db: Db, userId: number, role: Role, actor: Actor | null, now: Date = new Date()): void {
  if (!ROLES.includes(role)) throw new ServiceError("INVALID", "Unknown role");
  db.transaction((tx) => {
    const u = getUser(tx, userId);
    if (!u) throw new ServiceError("NOT_FOUND", "User not found");
    if (u.role === role) return;
    if (u.role === "admin" && u.isActive && activeAdmins(tx) <= 1) {
      throw new ServiceError("LAST_ADMIN", "There must always be at least one active admin");
    }
    tx.update(users).set({ role, sessionVersion: u.sessionVersion + 1 }).where(eq(users.id, userId)).run();
    writeAudit(tx, actor, "user.set_role", "user", userId, `'${u.username}': ${u.role} -> ${role}`, now);
  });
}

export function setActive(db: Db, userId: number, active: boolean, actor: Actor | null, now: Date = new Date()): void {
  db.transaction((tx) => {
    const u = getUser(tx, userId);
    if (!u) throw new ServiceError("NOT_FOUND", "User not found");
    if (u.isActive === active) return;
    if (!active && u.role === "admin" && activeAdmins(tx) <= 1) {
      throw new ServiceError("LAST_ADMIN", "There must always be at least one active admin");
    }
    tx.update(users).set({ isActive: active, sessionVersion: u.sessionVersion + 1 }).where(eq(users.id, userId)).run();
    writeAudit(tx, actor, active ? "user.activate" : "user.deactivate", "user", userId, `${active ? "Reactivated" : "Deactivated"} '${u.username}'`, now);
  });
}
