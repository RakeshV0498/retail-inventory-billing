import { beforeEach, describe, expect, it } from "vitest";
import { hashPin, signSession, validatePinFormat, verifyPin, verifySession } from "@/lib/auth";
import {
  _resetLockout,
  checkPin,
  createSessionToken,
  isPinEnabled,
  isValidSession,
  LOCK_SECONDS,
  MAX_ATTEMPTS,
  removePin,
  setPin,
} from "@/services/auth";
import { getSettings } from "@/services/settings";
import { makeDb } from "./helpers";

beforeEach(() => _resetLockout());

describe("PIN hashing", () => {
  it("round-trips and rejects the wrong PIN", () => {
    const h = hashPin("123456");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("123456");
    expect(verifyPin("123456", h)).toBe(true);
    expect(verifyPin("123457", h)).toBe(false);
    expect(verifyPin("123456", "garbage")).toBe(false);
  });
  it("salts: same PIN hashes differently each time", () => {
    expect(hashPin("1234")).not.toBe(hashPin("1234"));
  });
  it("accepts only 4-12 digits", () => {
    for (const ok of ["1234", "123456789012"]) expect(() => validatePinFormat(ok)).not.toThrow();
    for (const bad of ["123", "1234567890123", "12a4", "", "12 34"]) expect(() => validatePinFormat(bad)).toThrow();
  });
});

describe("session cookie", () => {
  const secret = "s3cret";
  it("verifies a fresh token and rejects expired, tampered and malformed ones", () => {
    const now = 1_000_000;
    const t = signSession(secret, now + 5_000);
    expect(verifySession(secret, t, now)).toBe(true);
    expect(verifySession(secret, t, now + 5_000)).toBe(false); // expired
    expect(verifySession("other", t, now)).toBe(false); // wrong secret
    const [exp, sig] = t.split(".");
    expect(verifySession(secret, `${Number(exp) + 99999}.${sig}`, now)).toBe(false); // extended expiry
    for (const bad of ["", "abc", "1.2.3", ".", "12.zz", `${exp}.`]) expect(verifySession(secret, bad, now)).toBe(false);
  });
});

describe("PIN service", () => {
  it("is off by default and PIN never leaks through getSettings", () => {
    const db = makeDb();
    expect(isPinEnabled(db)).toBe(false);
    setPin(db, "4321");
    expect(isPinEnabled(db)).toBe(true);
    expect(JSON.stringify(getSettings(db))).not.toMatch(/scrypt|pinHash|sessionSecret/);
  });

  it("changing requires the current PIN; removing requires it too", () => {
    const db = makeDb();
    setPin(db, "1111");
    expect(() => setPin(db, "2222")).toThrowError(/incorrect/i);
    expect(() => setPin(db, "2222", "9999")).toThrowError(/incorrect/i);
    setPin(db, "2222", "1111");
    expect(checkPin(db, "2222")).toEqual({ ok: true });
    expect(() => removePin(db, "0000")).toThrow();
    removePin(db, "2222");
    expect(isPinEnabled(db)).toBe(false);
  });

  it("rejects badly formatted new PINs", () => {
    expect(() => setPin(makeDb(), "12")).toThrowError(/4 to 12 digits/);
  });

  it("changing or removing the PIN signs out existing sessions", () => {
    const db = makeDb();
    setPin(db, "1111");
    const token = createSessionToken(db);
    expect(isValidSession(db, token)).toBe(true);
    setPin(db, "2222", "1111");
    expect(isValidSession(db, token)).toBe(false);
    const t2 = createSessionToken(db);
    removePin(db, "2222");
    expect(isValidSession(db, t2)).toBe(false);
  });

  it("session tokens expire after 30 days", () => {
    const db = makeDb();
    setPin(db, "1111");
    const t = createSessionToken(db, 0);
    expect(isValidSession(db, t, 29 * 86_400_000)).toBe(true);
    expect(isValidSession(db, t, 31 * 86_400_000)).toBe(false);
  });
});

describe("lockout", () => {
  it(`locks for ${LOCK_SECONDS}s after ${MAX_ATTEMPTS} wrong PINs, even for the right PIN, then recovers`, () => {
    const db = makeDb();
    setPin(db, "1234");
    const t0 = 10_000_000;
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(checkPin(db, "0000", t0)).toEqual({ ok: false, locked: false, retryAfterSec: 0 });
    expect(checkPin(db, "0000", t0)).toMatchObject({ ok: false, locked: true, retryAfterSec: LOCK_SECONDS });
    expect(checkPin(db, "1234", t0 + 30_000)).toMatchObject({ ok: false, locked: true, retryAfterSec: 30 });
    expect(checkPin(db, "1234", t0 + LOCK_SECONDS * 1000 + 1)).toEqual({ ok: true });
  });

  it("a successful login resets the failure counter", () => {
    const db = makeDb();
    setPin(db, "1234");
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) checkPin(db, "0000", 1);
    expect(checkPin(db, "1234", 2)).toEqual({ ok: true });
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(checkPin(db, "0000", 3).ok).toBe(false);
    expect(checkPin(db, "1234", 4)).toEqual({ ok: true }); // not locked: counter restarted
  });
});
