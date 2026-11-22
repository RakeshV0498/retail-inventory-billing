import { randomBytes } from "node:crypto";
import type { Db } from "@/db/client";
import { hashPin, signSession, validatePinFormat, verifyPin, verifySession } from "@/lib/auth";
import { deleteSetting, getSetting, setSetting } from "./settings";
import { ServiceError } from "./types";

const KEY_HASH = "pinHash";
const KEY_SECRET = "sessionSecret";

export const SESSION_DAYS = 30;
export const MAX_ATTEMPTS = 5;
export const LOCK_SECONDS = 60;

/** Failed-attempt lockout. In-memory on purpose: single-user app; a restart clears it. */
const lock = { fails: 0, until: 0 };
export function _resetLockout() {
  lock.fails = 0;
  lock.until = 0;
}

export function isPinEnabled(db: Db): boolean {
  return getSetting(db, KEY_HASH) !== undefined;
}

function sessionSecret(db: Db): string {
  let s = getSetting(db, KEY_SECRET);
  if (!s) {
    s = randomBytes(32).toString("hex");
    setSetting(db, KEY_SECRET, s);
  }
  return s;
}

/** Changing or removing the PIN rotates the secret, which signs every existing session out. */
function rotateSecret(db: Db) {
  setSetting(db, KEY_SECRET, randomBytes(32).toString("hex"));
}

export type PinCheck = { ok: true } | { ok: false; locked: boolean; retryAfterSec: number };

/** Verify a PIN with brute-force lockout. `now` is injectable for tests. */
export function checkPin(db: Db, pin: string, now: number = Date.now()): PinCheck {
  if (now < lock.until) return { ok: false, locked: true, retryAfterSec: Math.ceil((lock.until - now) / 1000) };
  const stored = getSetting(db, KEY_HASH);
  if (stored && verifyPin(pin, stored)) {
    _resetLockout();
    return { ok: true };
  }
  lock.fails += 1;
  if (lock.fails >= MAX_ATTEMPTS) {
    lock.fails = 0;
    lock.until = now + LOCK_SECONDS * 1000;
    return { ok: false, locked: true, retryAfterSec: LOCK_SECONDS };
  }
  return { ok: false, locked: false, retryAfterSec: 0 };
}

/** Set a PIN. If one already exists, the current PIN must be supplied and correct. */
export function setPin(db: Db, newPin: string, currentPin?: string, now: number = Date.now()): void {
  try {
    validatePinFormat(newPin);
  } catch (e) {
    throw new ServiceError("INVALID_PIN", e instanceof Error ? e.message : "Invalid PIN");
  }
  if (isPinEnabled(db)) {
    const res = checkPin(db, currentPin ?? "", now);
    if (!res.ok) {
      throw new ServiceError(res.locked ? "LOCKED" : "WRONG_PIN", res.locked ? `Too many attempts. Try again in ${res.retryAfterSec}s` : "Current PIN is incorrect");
    }
  }
  setSetting(db, KEY_HASH, hashPin(newPin));
  rotateSecret(db);
}

export function removePin(db: Db, currentPin: string, now: number = Date.now()): void {
  if (!isPinEnabled(db)) return;
  const res = checkPin(db, currentPin, now);
  if (!res.ok) {
    throw new ServiceError(res.locked ? "LOCKED" : "WRONG_PIN", res.locked ? `Too many attempts. Try again in ${res.retryAfterSec}s` : "Current PIN is incorrect");
  }
  deleteSetting(db, KEY_HASH);
  rotateSecret(db);
}

export function createSessionToken(db: Db, now: number = Date.now()): string {
  return signSession(sessionSecret(db), now + SESSION_DAYS * 86_400_000);
}

export function isValidSession(db: Db, token: string, now: number = Date.now()): boolean {
  return verifySession(sessionSecret(db), token, now);
}
