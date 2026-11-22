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

/** Session token: `<expiresAtMs>.<hmac>`. */
export function signSession(secret: string, expiresAtMs: number): string {
  const payload = String(expiresAtMs);
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(secret: string, token: string, nowMs: number): boolean {
  const [payload, sig, ...rest] = token.split(".");
  if (!payload || !sig || rest.length > 0 || !/^\d+$/.test(payload)) return false;
  const expected = Buffer.from(sign(secret, payload), "hex");
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Number(payload) > nowMs;
}
