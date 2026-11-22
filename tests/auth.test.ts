import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPin, normalizeUsername, signSessionToken, validatePinFormat, verifyPin, verifySessionToken } from "@/lib/auth";
import { auditLog, users } from "@/db/schema";
import { createInvoice } from "@/services/billing";
import { listAudit } from "@/services/audit";
import { recordPayment, createCustomer } from "@/services/customers";
import {
  _resetLockouts,
  actorOf,
  authenticate,
  changeOwnPin,
  createFirstAdmin,
  createSessionToken,
  createUser,
  getUser,
  hasUsers,
  listUsers,
  LOCK_SECONDS,
  MAX_ATTEMPTS,
  resolveSession,
  setActive,
  setRole,
  setUserPin,
} from "@/services/users";
import { getSettings } from "@/services/settings";
import { makeDb, newProduct, NOW, stock } from "./helpers";

beforeEach(() => _resetLockouts());

const ADMIN = { username: "owner", displayName: "Owner", pin: "1234", role: "admin" } as const;
const STAFF = { username: "ravi", displayName: "Ravi", pin: "5678", role: "staff" } as const;
function twoUsers() {
  const db = makeDb();
  const a = createFirstAdmin(db, { username: ADMIN.username, displayName: ADMIN.displayName, pin: ADMIN.pin });
  const s = createUser(db, STAFF, { id: a.id, name: a.displayName });
  return { db, a, s };
}

describe("PIN hashing and usernames", () => {
  it("round-trips, salts, and rejects the wrong PIN", () => {
    const h = hashPin("123456");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("123456");
    expect(verifyPin("123456", h)).toBe(true);
    expect(verifyPin("123457", h)).toBe(false);
    expect(verifyPin("123456", "garbage")).toBe(false);
    expect(hashPin("1234")).not.toBe(hashPin("1234"));
  });
  it("PIN is 4-12 digits", () => {
    for (const ok of ["1234", "123456789012"]) expect(() => validatePinFormat(ok)).not.toThrow();
    for (const bad of ["123", "1234567890123", "12a4", "", "12 34"]) expect(() => validatePinFormat(bad)).toThrow();
  });
  it("usernames are lowercase 3-30 of letters, digits, dot, dash, underscore", () => {
    expect(normalizeUsername("  Ravi.K_2  ")).toBe("ravi.k_2");
    for (const bad of ["ab", "x".repeat(31), "has space", "semi;colon", "ünï", "", "a/b"]) expect(normalizeUsername(bad)).toBeNull();
  });
});

describe("session tokens", () => {
  const secret = "s3cret";
  const claims = { userId: 7, version: 2, expiresAt: 1_005_000 };
  it("verify, then reject expired, wrong-secret, tampered and malformed tokens", () => {
    const t = signSessionToken(secret, claims);
    expect(verifySessionToken(secret, t, 1_000_000)).toEqual(claims);
    expect(verifySessionToken(secret, t, 1_005_000)).toBeNull(); // expired
    expect(verifySessionToken("other", t, 1_000_000)).toBeNull();
    const [uid, ver, exp, sig] = t.split(".");
    expect(verifySessionToken(secret, `8.${ver}.${exp}.${sig}`, 1_000_000)).toBeNull(); // another user id
    expect(verifySessionToken(secret, `${uid}.9.${exp}.${sig}`, 1_000_000)).toBeNull(); // another version
    expect(verifySessionToken(secret, `${uid}.${ver}.${Number(exp) + 99999}.${sig}`, 1_000_000)).toBeNull();
    for (const bad of ["", "abc", "1.2.3", "1.2.3.4.5", "a.b.c.d", `${uid}.${ver}.${exp}.`, `${uid}.${ver}.${exp}.zz`]) expect(verifySessionToken(secret, bad, 1_000_000)).toBeNull();
  });
});

describe("accounts", () => {
  it("starts with no accounts; the first admin can only be created once", () => {
    const db = makeDb();
    expect(hasUsers(db)).toBe(false);
    const a = createFirstAdmin(db, { username: "Owner", displayName: "Owner", pin: "1234" });
    expect(a).toMatchObject({ username: "owner", role: "admin", isActive: true });
    expect(hasUsers(db)).toBe(true);
    expect(() => createFirstAdmin(db, { username: "second", displayName: "S", pin: "1234" })).toThrowError(/already set up/);
    expect(listUsers(db)).toHaveLength(1);
  });

  it("stores only a hash of the PIN and never leaks it through settings", () => {
    const { db, a } = twoUsers();
    expect(a.pinHash).toMatch(/^scrypt\$/);
    expect(a.pinHash).not.toContain("1234");
    expect(JSON.stringify(getSettings(db))).not.toMatch(/scrypt|pin/i);
  });

  it("validates new users: username rules, PIN, name, role, and duplicates", () => {
    const { db } = twoUsers();
    expect(() => createUser(db, { ...STAFF, username: "x" }, null)).toThrowError(/Username must be/);
    expect(() => createUser(db, { ...STAFF, username: "bad name" }, null)).toThrowError(/Username must be/);
    expect(() => createUser(db, { ...STAFF, username: "new1", pin: "12" }, null)).toThrowError(/4 to 12 digits/);
    expect(() => createUser(db, { ...STAFF, username: "new2", displayName: "  " }, null)).toThrow();
    // @ts-expect-error not a role
    expect(() => createUser(db, { ...STAFF, username: "new3", role: "boss" }, null)).toThrow();
    expect(() => createUser(db, { ...STAFF, username: "RAVI" }, null)).toThrowError(/already taken/); // case-insensitive
  });

  it("records who created, reset, changed and deactivated accounts in the audit log", () => {
    const { db, a, s } = twoUsers();
    const me = actorOf({ id: a.id, username: a.username, displayName: a.displayName, role: "admin" });
    setUserPin(db, s.id, "9999", me);
    setRole(db, s.id, "admin", me);
    setActive(db, s.id, false, me);
    const actions = listAudit(db).map((e) => e.action).reverse();
    expect(actions).toEqual(["user.create", "user.create", "user.reset_pin", "user.set_role", "user.deactivate"]);
    expect(listAudit(db, { action: "user.deactivate" })[0]).toMatchObject({ userId: a.id, username: "Owner", entityType: "user", entityId: s.id });
    expect(db.select().from(auditLog).all().every((r) => !/pin_hash|scrypt|9999/.test(r.summary))).toBe(true);
  });
});

describe("sign-in", () => {
  it("accepts the right username and PIN (username case-insensitive) and rejects everything else the same way", () => {
    const { db, s } = twoUsers();
    expect(authenticate(db, "Ravi", "5678")).toMatchObject({ ok: true, user: { id: s.id, role: "staff", displayName: "Ravi" } });
    for (const [u, p] of [["ravi", "0000"], ["nobody", "5678"], ["", ""], ["ravi", ""]] as const) {
      expect(authenticate(db, u, p)).toEqual({ ok: false, locked: false, retryAfterSec: 0 });
    }
  });

  it("refuses a deactivated user even with the right PIN", () => {
    const { db, s } = twoUsers();
    setActive(db, s.id, false, null);
    expect(authenticate(db, "ravi", "5678").ok).toBe(false);
    setActive(db, s.id, true, null);
    expect(authenticate(db, "ravi", "5678").ok).toBe(true);
  });

  it(`locks ONE username for ${LOCK_SECONDS}s after ${MAX_ATTEMPTS} wrong PINs (even for the right PIN), others unaffected, then recovers`, () => {
    const { db } = twoUsers();
    const t0 = 50_000_000;
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(authenticate(db, "ravi", "0000", t0)).toEqual({ ok: false, locked: false, retryAfterSec: 0 });
    expect(authenticate(db, "ravi", "0000", t0)).toMatchObject({ ok: false, locked: true, retryAfterSec: LOCK_SECONDS });
    expect(authenticate(db, "ravi", "5678", t0 + 30_000)).toMatchObject({ ok: false, locked: true, retryAfterSec: 30 });
    expect(authenticate(db, "owner", "1234", t0 + 30_000).ok).toBe(true); // a stranger guessing at Ravi can't lock the owner out
    expect(authenticate(db, "ravi", "5678", t0 + LOCK_SECONDS * 1000 + 1).ok).toBe(true);
  });

  it("throttles unknown usernames the same way (no way to tell they don't exist) and resets on success", () => {
    const { db } = twoUsers();
    for (let i = 0; i < MAX_ATTEMPTS; i++) authenticate(db, "ghost", "0000", 1);
    expect(authenticate(db, "ghost", "0000", 2)).toMatchObject({ locked: true });
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) authenticate(db, "ravi", "0000", 3);
    expect(authenticate(db, "ravi", "5678", 4).ok).toBe(true);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(authenticate(db, "ravi", "0000", 5).ok).toBe(false);
    expect(authenticate(db, "ravi", "5678", 6).ok).toBe(true); // counter restarted
  });
});

describe("sessions follow the user, not just a cookie", () => {
  it("a token resolves to its user and role", () => {
    const { db, s } = twoUsers();
    expect(resolveSession(db, createSessionToken(db, s.id))).toMatchObject({ id: s.id, username: "ravi", role: "staff" });
    expect(resolveSession(db, "garbage")).toBeNull();
  });

  it("sessions expire after 30 days", () => {
    const { db, s } = twoUsers();
    const t = createSessionToken(db, s.id, 0);
    expect(resolveSession(db, t, 29 * 86_400_000)).not.toBeNull();
    expect(resolveSession(db, t, 31 * 86_400_000)).toBeNull();
  });

  it("resetting a PIN, changing a role or deactivating signs out THAT user only", () => {
    const { db, a, s } = twoUsers();
    const staffTok = createSessionToken(db, s.id);
    const adminTok = createSessionToken(db, a.id);
    setUserPin(db, s.id, "4321", null);
    expect(resolveSession(db, staffTok)).toBeNull();
    expect(resolveSession(db, adminTok)).not.toBeNull();

    const t2 = createSessionToken(db, s.id);
    setRole(db, s.id, "admin", null);
    expect(resolveSession(db, t2)).toBeNull();

    const t3 = createSessionToken(db, s.id);
    setActive(db, s.id, false, null);
    expect(resolveSession(db, t3)).toBeNull();
    setActive(db, s.id, true, null);
    expect(resolveSession(db, t3)).toBeNull(); // reactivation doesn't resurrect old sessions
    expect(resolveSession(db, createSessionToken(db, s.id))).not.toBeNull();
  });
});

describe("own PIN and last-admin safety", () => {
  it("a user changes their own PIN with the current one; wrong current is refused and counts toward lockout", () => {
    const { db, s } = twoUsers();
    expect(() => changeOwnPin(db, s.id, "0000", "1111")).toThrowError(/incorrect/i);
    changeOwnPin(db, s.id, "5678", "1111");
    expect(authenticate(db, "ravi", "1111").ok).toBe(true);
    expect(authenticate(db, "ravi", "5678").ok).toBe(false);
    expect(() => changeOwnPin(db, s.id, "1111", "12")).toThrowError(/4 to 12 digits/);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(() => changeOwnPin(db, s.id, "0000", "2222")).toThrow();
    expect(() => changeOwnPin(db, s.id, "1111", "2222")).toThrowError(/Too many attempts|incorrect/); // locked or the 5th failure
  });

  it("the last active admin can't be demoted or deactivated; with a second admin it can", () => {
    const { db, a, s } = twoUsers();
    expect(() => setRole(db, a.id, "staff", null)).toThrowError(/at least one active admin/);
    expect(() => setActive(db, a.id, false, null)).toThrowError(/at least one active admin/);
    setRole(db, s.id, "admin", null);
    setRole(db, a.id, "staff", null);
    expect(getUser(db, a.id)!.role).toBe("staff");
    expect(() => setActive(db, s.id, false, null)).toThrowError(/at least one active admin/); // s is the only admin now
    expect(getUser(db, s.id)!.isActive).toBe(true);
  });

  it("no-op changes and unknown users are handled", () => {
    const { db, s } = twoUsers();
    setRole(db, s.id, "staff", null);
    setActive(db, s.id, true, null);
    expect(listAudit(db, { action: "user.set_role" })).toHaveLength(0);
    expect(() => setRole(db, 999, "staff", null)).toThrowError(/not found/i);
    expect(() => setUserPin(db, 999, "1234", null)).toThrowError(/not found/i);
  });

  it("users are never deleted from the database by any of these operations", () => {
    const { db, s } = twoUsers();
    setActive(db, s.id, false, null);
    expect(db.select().from(users).where(eq(users.id, s.id)).all()).toHaveLength(1);
  });
});

describe("who billed what", () => {
  it("invoices and dues payments record the person (snapshot of their name), and null when there are no accounts", () => {
    const { db, s } = twoUsers();
    const p = newProduct(db, { unitType: "pcs" });
    stock(db, p.id, { batch: "A", qtyMilli: 50_000, sell: 10_000 });
    const c = createCustomer(db, { name: "Cust" });
    const me = actorOf({ id: s.id, username: s.username, displayName: s.displayName, role: "staff" });

    const mine = createInvoice(db, { items: [{ productId: p.id, quantity: 1_000 }], paymentMode: "credit", customerId: c.id }, NOW, me);
    expect(mine.invoice).toMatchObject({ createdBy: s.id, createdByName: "Ravi" });
    const anon = createInvoice(db, { items: [{ productId: p.id, quantity: 1_000 }], paymentMode: "cash" }, NOW);
    expect(anon.invoice).toMatchObject({ createdBy: null, createdByName: null });

    expect(recordPayment(db, c.id, 4_000, "cash", null, NOW, me)).toMatchObject({ createdBy: s.id, createdByName: "Ravi" });
    setUserPin(db, s.id, "0000", null);
    setActive(db, s.id, false, null);
    expect(mine.invoice.createdByName).toBe("Ravi"); // history survives deactivation
  });
});
