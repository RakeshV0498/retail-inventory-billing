import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Pure PIN/session helpers (no DB, no Next). Uses only node:crypto — no extra dependencies. */

export const PIN_PATTERN = /^\d{4,12}$/;

export function validatePinFormat(pin: string): void {
  if (!PIN_PATTERN.test(pin)) throw new Error("PIN must be 4 to 12 digits");
}

/** Returns `scrypt$<salt-hex>$<hash-hex>`. */
export function hashPin(pin: string): string {
  validatePinFormat(pin);
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("hex");

/** Lowercase `[a-z0-9._-]`, 3-30 chars; otherwise null. */
export function normalizeUsername(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  return /^[a-z0-9._-]{3,30}$/.test(u) ? u : null;
}

export interface SessionClaims {
  userId: number;
  /** users.session_version at the time of login; a mismatch later means "signed out". */
  version: number;
  expiresAt: number;
}

/** Token: `<userId>.<version>.<expiresAtMs>.<hmac>`. */
export function signSessionToken(secret: string, claims: SessionClaims): string {
  const payload = `${claims.userId}.${claims.version}.${claims.expiresAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns the claims if the signature is valid and the token has not expired, otherwise null. */
export function verifySessionToken(secret: string, token: string, nowMs: number): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [uid, ver, exp, sig] = parts as [string, string, string, string];
  if (![uid, ver, exp].every((p) => /^\d+$/.test(p)) || !/^[0-9a-f]+$/.test(sig)) return null;
  const expected = Buffer.from(sign(secret, `${uid}.${ver}.${exp}`), "hex");
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const expiresAt = Number(exp);
  if (expiresAt <= nowMs) return null;
  return { userId: Number(uid), version: Number(ver), expiresAt };
}
