// Trainer session and upgrade. The Neon driver is faked with small in-memory
// tables, so db.js, identity-store, trainer-store, auth-server, the gates and
// the routes all run for real, and every statement they send is captured.
// The only writes allowed: INSERT auth_tokens (a session), UPDATE
// auth_tokens.expires (a ceremony token or a sign-out), and the upgrade's
// UPDATE accounts. Nothing is ever deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const DAY = 86400000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer, the admin
const L = id26("l"); // lifter
const N = id26("n"); // trainer, not the admin
const M = id26("m"); // another account

/** @type {{ tokens: Map<string, any>, accounts: Map<string, any>, handles: any[], credentials: any[] }} */
const db = { tokens: new Map(), accounts: new Map(), handles: [], credentials: [] };
const calls = [];
let failOn = null; // a regex: the matching statement throws

vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings, ...v) => {
    const q = strings.join("?");
    if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
    calls.push({ q, v });
    if (failOn && failOn.test(q)) throw new Error("db down");
    if (/^\s*SELECT profile, expires, scope, created_at, auth_at, credential_id, account_id FROM auth_tokens/.test(q)) {
      const r = db.tokens.get(v[0]) ?? (v[1] != null ? db.tokens.get(v[1]) : undefined);
      return r ? [{ ...r }] : [];
    }
    if (/^\s*INSERT INTO auth_tokens/.test(q)) {
      const [token, profile, expires, scope, created_at, auth_at, credential_id, account_id] = v;
      if (!db.tokens.has(token)) db.tokens.set(token, { profile, expires, scope, created_at, auth_at, credential_id, account_id });
      return [];
    }
    if (/^\s*UPDATE auth_tokens SET expires = \?\s+WHERE \(token = \? OR token = \?\) AND expires > \? RETURNING expires$/.test(q)) {
      const [now, h, legacy, guard] = v;
      const out = [];
      for (const key of [h, legacy]) {
        const r = key != null && db.tokens.get(key);
        if (r && r.expires > guard) { r.expires = now; out.push({ expires: now }); }
      }
      return out;
    }
    if (/^\s*UPDATE auth_tokens SET expires = \?\s+WHERE account_id = \? AND scope = 'trainer' AND expires > \? RETURNING expires$/.test(q)) {
      const [now, acct, guard] = v;
      const out = [];
      for (const r of db.tokens.values()) if (r.account_id === acct && r.scope === "trainer" && r.expires > guard) { r.expires = now; out.push({ expires: now }); }
      return out;
    }
    if (/^\s*SELECT \* FROM accounts WHERE id = \? LIMIT 1$/.test(q)) {
      const a = db.accounts.get(v[0]);
      return a ? [{ ...a }] : [];
    }
    if (/^\s*SELECT \* FROM accounts WHERE storage_key = \? LIMIT 1$/.test(q)) {
      const a = [...db.accounts.values()].find((x) => x.storage_key === v[0]);
      return a ? [{ ...a }] : [];
    }
    if (/FROM handles h JOIN accounts a/.test(q)) {
      const h = db.handles.find((x) => x.handle === v[0] && x.released_at == null);
      const a = h && db.accounts.get(h.account_id);
      return a && !a.deleted_at ? [{ ...a, handle: h.handle, display: h.display, kind: "primary", claimed_at: null, hold_until: null }] : [];
    }
    if (/AS cred_live/.test(q)) {
      const [cred, acct] = v;
      const a = db.accounts.get(acct);
      if (!a) return [];
      const live = db.credentials.some((c) => c.id === cred && c.account_id === a.id && c.rp_id === "heatwayve.app");
      return [{ roles: a.roles, plan: a.plan, trainer_terms: a.trainer_terms, deleted_at: a.deleted_at, cred_live: live }];
    }
    if (/^\s*SELECT handle, display FROM handles/.test(q)) {
      const h = db.handles.find((x) => x.account_id === v[0] && x.released_at == null);
      return h ? [{ handle: h.handle, display: h.display }] : [];
    }
    if (/^\s*UPDATE accounts SET roles = CASE WHEN 'trainer' = ANY\(roles\) THEN roles ELSE array_append\(roles, 'trainer'\) END/.test(q)) {
      const [terms, acct] = v;
      const a = db.accounts.get(acct);
      if (!a || a.deleted_at) return [];
      if (!a.roles.includes("trainer")) a.roles = [...a.roles, "trainer"];
      a.trainer_terms = JSON.parse(terms);
      return [{ id: acct }];
    }
    throw new Error(`unexpected SQL: ${q}`);
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));

const { POST: sessionPOST } = await import("@/app/api/trainer/session/route");
const { POST: upgradePOST } = await import("@/app/api/trainer/upgrade/route");
const { POST: endPOST } = await import("@/app/api/trainer/session/end/route");
const ts = await import("@/lib/trainer-session");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { rateLimit, rateLimitShared } = await import("@/lib/rate-limit");
const { freshCeremony, trainerGate, TRAINER_COOKIE } = ts;

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, sk, roles, trainer_terms = null) => ({
  id, storage_key: sk, webauthn_user_id: "u-" + sk, roles, plan: "free", consent: null, trainer_terms,
  origin: "claim", created_at: null, lapsed_at: null, deleted_at: null,
});
let seq = 0;
/** A token row as login-verify mints it; returns the raw token. */
const mint = (acct, { cred = null, scope = null, ageMs = 60_000, authAgeMs = ageMs, ttlMs = 3600_000 } = {}) => {
  const token = `tok-${++seq}`;
  const a = db.accounts.get(acct);
  db.tokens.set(hash(token), {
    profile: a.storage_key, expires: Date.now() + ttlMs - ageMs, scope,
    created_at: new Date(Date.now() - ageMs).toISOString(), auth_at: new Date(Date.now() - authAgeMs).toISOString(),
    credential_id: cred, account_id: acct,
  });
  return token;
};
const row = (token) => db.tokens.get(hash(token));
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.q));
const H = "https://heatwayve.app";
const post = (fn, path, body, headers = {}) => fn(new NextRequest(`${H}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
}));
const withCookie = (token) => ({ cookie: `${TRAINER_COOKIE}=${token}` });
const gateReq = (headers) => new NextRequest(`${H}/api/trainer/clients`, { method: "POST", headers });
const FACE_ID = { error: "Face ID didn't go through. Try again.", requiresAuth: true };
const SIGN_IN = { error: "Sign in to see your clients", requiresAuth: true };

beforeEach(() => {
  calls.length = 0;
  failOn = null;
  db.tokens.clear();
  db.accounts = new Map([
    [T, account(T, "tia", ["lifter", "trainer"], CURRENT)],
    [L, account(L, "leo", ["lifter"])],
    [N, account(N, "nia", ["lifter", "trainer"], CURRENT)],
    [M, account(M, "mal", ["lifter"])],
  ]);
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T, released_at: null },
    { handle: "leo", display: "Leo", account_id: L, released_at: null },
    { handle: "nia", display: "Nia", account_id: N, released_at: null },
    { handle: "mal", display: "Mal", account_id: M, released_at: null },
  ];
  db.credentials = [
    { id: "cT", account_id: T, rp_id: "heatwayve.app" },
    { id: "cL", account_id: L, rp_id: "heatwayve.app" },
    { id: "cLegacy", account_id: L, rp_id: "theforged.fit" },
    { id: "cN", account_id: N, rp_id: "heatwayve.app" },
    { id: "cM", account_id: M, rp_id: "heatwayve.app" },
  ];
  process.env.DATABASE_URL = "postgres://fake";
  process.env.ADMIN_ACCOUNT_ID = T;
  vi.mocked(rateLimit).mockClear();
  vi.mocked(rateLimitShared).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_ACCOUNT_ID;
});

describe("freshCeremony", () => {
  it("admits a native, indexed ceremony from the last 5 minutes", async () => {
    const c = await freshCeremony({ authToken: mint(T, { cred: "cT", ageMs: 4 * 60_000 }), profile: "Tia" });
    expect(c).toMatchObject({ identity: { accountId: T, storageKey: "tia" }, credentialId: "cT", account: { credLive: true } });
    expect(writes()).toEqual([]);
  });

  const refusals = {
    "an expired token": () => ({ authToken: mint(T, { cred: "cT", ttlMs: 30_000 }), profile: "tia" }),
    "a sync-scope token": () => ({ authToken: mint(T, { cred: "cT", scope: "sync" }), profile: "tia" }),
    "a photos-scope token": () => ({ authToken: mint(T, { cred: "cT", scope: "photos" }), profile: "tia" }),
    "a trainer-scope token": () => ({ authToken: mint(T, { cred: "cT", scope: "trainer" }), profile: "tia" }),
    "a token naming no passkey": () => ({ authToken: mint(T), profile: "tia" }),
    "a Face ID older than 5 minutes": () => ({ authToken: mint(T, { cred: "cT", ageMs: 5 * 60_000 + 1000 }), profile: "tia" }),
    "a handle held by another account": () => ({ authToken: mint(T, { cred: "cT" }), profile: "mal" }),
    "an unknown token": () => ({ authToken: "nope", profile: "tia" }),
    "no token": () => ({ profile: "tia" }),
    "no handle": () => ({ authToken: mint(T, { cred: "cT" }) }),
  };
  for (const [label, body] of Object.entries(refusals)) {
    it(`refuses ${label} with the Face ID 401`, async () => {
      const c = await freshCeremony(body());
      expect(c.fail.status).toBe(401);
      expect(await c.fail.json()).toEqual(FACE_ID);
    });
  }

  it("refuses a closed account", async () => {
    const authToken = mint(T, { cred: "cT" });
    db.accounts.get(T).deleted_at = "2026-10-02T00:00:00.000Z";
    expect((await freshCeremony({ authToken, profile: "tia" })).fail.status).toBe(401);
  });

  it("a legacy-rp index row needs a native passkey first (409)", async () => {
    const c = await freshCeremony({ authToken: mint(L, { cred: "cLegacy" }), profile: "leo" });
    expect(c.fail.status).toBe(409);
    expect(await c.fail.json()).toEqual({ needsNativePasskey: true });
  });

  it("a passkey held only in the Blob doc (not in the index) needs a native passkey first (409)", async () => {
    const c = await freshCeremony({ authToken: mint(L, { cred: "cBlobOnly" }), profile: "leo" });
    expect(c.fail.status).toBe(409);
  });

  it("reads the passkey from the token record only, and checks it in one index SELECT", async () => {
    await freshCeremony({ authToken: mint(L, { cred: "cL" }), profile: "leo", credentialId: "cLegacy" });
    const sel = calls.find((c) => /AS cred_live/.test(c.q));
    expect(sel.v).toEqual(["cL", L]);
  });
});

describe("POST /api/trainer/session", () => {
  const signIn = (authToken, profile = "tia") => post(sessionPOST, "/api/trainer/session", { authToken, profile });

  it("exchanges a quiet ceremony for the trainer cookie, then expires the ceremony token", async () => {
    const authToken = mint(T, { cred: "cT", ageMs: 90_000 });
    const ceremonyAuthAt = row(authToken).auth_at;
    const res = await signIn(authToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Tia" });
    expect(res.headers.get("cache-control")).toBe("no-store");

    // Writes, complete and in order: the session INSERT, then the ceremony token's expiry.
    const w = writes();
    expect(w.map((c) => c.q.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual(["INSERT INTO", "UPDATE auth_tokens"]);
    const [, , expires, scope, , authAt, credentialId, accountId] = w[0].v;
    expect({ scope, authAt, credentialId, accountId }).toEqual({ scope: "trainer", authAt: ceremonyAuthAt, credentialId: "cT", accountId: T });
    expect(expires).toBeGreaterThan(Date.now() + 14 * DAY - 5000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    expect(w[1].v.slice(1, 3)).toEqual([hash(authToken), authToken]);
    expect(row(authToken).expires).toBeLessThanOrEqual(Date.now());

    // The cookie: __Host- attributes, 14 days.
    const set = res.headers.get("set-cookie");
    expect(set).toMatch(/^__Host-hw_trainer=[^;]+; Path=\/; .*Max-Age=1209600; .*Secure/i);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=strict/i);
    expect(set).not.toMatch(/Domain=/i);

    // The cookie opens the trainer gate, and the ceremony token is spent.
    const session = res.cookies.get(TRAINER_COOKIE).value;
    const g = await trainerGate(gateReq(withCookie(session)));
    expect(g).toMatchObject({ identity: { accountId: T }, refresh: null });
    expect((await freshCeremony({ authToken, profile: "tia" })).fail.status).toBe(401);
    // ...and the session token is no ceremony token.
    expect((await freshCeremony({ authToken: session, profile: "tia" })).fail.status).toBe(401);
  });

  it("a lifter gets 403 notTrainer, nothing written, and the ceremony token stays usable for the upgrade", async () => {
    const authToken = mint(L, { cred: "cL" });
    const res = await signIn(authToken, "leo");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ notTrainer: true });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(writes()).toEqual([]);
    expect((await freshCeremony({ authToken, profile: "leo" })).identity.accountId).toBe(L);
  });

  it("stale Trainer Terms give 403 needsTerms, nothing written", async () => {
    db.accounts.get(T).trainer_terms = { ...CURRENT, version: "older" };
    const res = await signIn(mint(T, { cred: "cT" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ needsTerms: true });
    expect(writes()).toEqual([]);
  });

  it("terms without the 18+ attestation are stale too", async () => {
    db.accounts.get(T).trainer_terms = { version: TRAINER_TERMS_VERSION, at: CURRENT.at };
    expect((await signIn(mint(T, { cred: "cT" }))).status).toBe(403);
  });

  it("a trainer other than the admin gets 503 before launch, nothing written", async () => {
    const res = await signIn(mint(N, { cred: "cN" }), "nia");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Not open yet." });
    expect(writes()).toEqual([]);
  });

  it("a failed or legacy ceremony mints nothing", async () => {
    db.accounts.get(L).roles = ["lifter", "trainer"];
    db.accounts.get(L).trainer_terms = CURRENT;
    process.env.ADMIN_ACCOUNT_ID = L;
    const legacy = await signIn(mint(L, { cred: "cLegacy" }), "leo");
    expect(legacy.status).toBe(409);
    const stale = await signIn(mint(L, { cred: "cL", ageMs: 6 * 60_000 }), "leo");
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual(FACE_ID);
    for (const r of [legacy, stale]) expect(r.headers.get("set-cookie")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("limits: 10 a minute in memory, 20 shared", async () => {
    await signIn("nope");
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-session", 10]);
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["trainer-session", 20]);
  });

  it("a store failure is a generic 500 with no cookie", async () => {
    const authToken = mint(T, { cred: "cT" });
    failOn = /^\s*INSERT INTO auth_tokens/;
    const res = await signIn(authToken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/trainer/upgrade", () => {
  const upgrade = (authToken, extra = {}) => post(upgradePOST, "/api/trainer/upgrade", {
    authToken, profile: "leo", terms: { version: TRAINER_TERMS_VERSION }, adult: true, ...extra,
  });
  beforeEach(() => { process.env.ADMIN_ACCOUNT_ID = L; });

  it("adds the role and the terms, mints the session, then expires the ceremony token", async () => {
    const authToken = mint(L, { cred: "cL" });
    const res = await upgrade(authToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Leo" });
    expect(res.cookies.get(TRAINER_COOKIE)).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 14 * 86400 });

    const w = writes();
    expect(w).toHaveLength(3);
    expect(w[0].q).toMatch(/^UPDATE accounts SET roles = CASE WHEN 'trainer' = ANY\(roles\) THEN roles ELSE array_append\(roles, 'trainer'\) END,\s+trainer_terms = \?::jsonb\s+WHERE id = \? AND deleted_at IS NULL RETURNING id$/);
    const terms = JSON.parse(w[0].v[0]);
    expect(terms).toMatchObject({ version: TRAINER_TERMS_VERSION, adult: true });
    expect(Object.keys(terms).sort()).toEqual(["adult", "at", "version"]);
    expect(Date.parse(terms.at)).toBeGreaterThan(Date.now() - 5000);
    expect(w[0].v[1]).toBe(L);
    expect(w[1].q).toMatch(/^INSERT INTO auth_tokens/);
    expect(w[1].v[3]).toBe("trainer");
    expect(w[2].q).toMatch(/^UPDATE auth_tokens SET expires/);
    expect(w[2].v[1]).toBe(hash(authToken));

    const a = db.accounts.get(L);
    expect(a.roles).toEqual(["lifter", "trainer"]);
    expect(a.plan).toBe("free");
    // The new cookie opens the gate straight away.
    expect(await trainerGate(gateReq(withCookie(res.cookies.get(TRAINER_COOKIE).value)))).toMatchObject({ identity: { accountId: L } });
  });

  it("is idempotent: re-accepting only overwrites trainer_terms", async () => {
    await upgrade(mint(L, { cred: "cL" }));
    await upgrade(mint(L, { cred: "cL" }));
    expect(db.accounts.get(L).roles).toEqual(["lifter", "trainer"]);
  });

  const refused = {
    "an unknown terms version": { terms: { version: "draft-2020-01" } },
    "no terms": { terms: undefined },
    "a bare version string": { terms: TRAINER_TERMS_VERSION },
    "adult false": { adult: false },
    "adult as a string": { adult: "true" },
    "no adult attestation": { adult: undefined },
  };
  for (const [label, extra] of Object.entries(refused)) {
    it(`refuses ${label} with 400, nothing written`, async () => {
      const res = await upgrade(mint(L, { cred: "cL" }), extra);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Accept the Trainer Terms to continue." });
      expect(writes()).toEqual([]);
    });
  }

  it("is not open to anyone but the admin before launch (503, after the ceremony check)", async () => {
    process.env.ADMIN_ACCOUNT_ID = T;
    const res = await upgrade(mint(L, { cred: "cL" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Not open yet." });
    expect((await upgrade("nope")).status).toBe(401);
    expect(writes()).toEqual([]);
  });

  it("a legacy passkey gets 409 needsNativePasskey, nothing written", async () => {
    const res = await upgrade(mint(L, { cred: "cLegacy" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ needsNativePasskey: true });
    expect(writes()).toEqual([]);
  });

  it("limits: 5 a minute in memory, 10 shared", async () => {
    await upgrade("nope");
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-upgrade", 5]);
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["trainer-upgrade", 10]);
  });
});

describe("trainerGate", () => {
  const session = (acct, opts = {}) => mint(acct, { cred: "cT", scope: "trainer", ttlMs: 14 * DAY, ...opts });

  it("refuses no cookie", async () => {
    const g = await trainerGate(gateReq({}));
    expect(g.fail.status).toBe(401);
    expect(await g.fail.json()).toEqual(SIGN_IN);
  });

  it("never reads x-hw-auth: a valid session in the header, with no cookie, is refused", async () => {
    for (const t of [session(T), mint(T, { cred: "cT" })]) {
      expect((await trainerGate(gateReq({ "x-hw-auth": t }))).fail.status).toBe(401);
    }
  });

  it("refuses every other scope in the trainer cookie", async () => {
    for (const scope of [null, "sync", "photos", "trainer:read"]) {
      expect((await trainerGate(gateReq(withCookie(mint(T, { cred: "cT", scope }))))).fail.status, String(scope)).toBe(401);
    }
  });

  it("refuses a trainer token that names no passkey", async () => {
    expect((await trainerGate(gateReq(withCookie(session(T, { cred: null }))))).fail.status).toBe(401);
  });

  it("refuses an expired session", async () => {
    expect((await trainerGate(gateReq(withCookie(session(T, { ageMs: 15 * DAY }))))).fail.status).toBe(401);
  });

  it("refuses a closed account", async () => {
    const t = session(T);
    db.accounts.get(T).deleted_at = "2026-10-02T00:00:00.000Z";
    expect((await trainerGate(gateReq(withCookie(t)))).fail.status).toBe(401);
  });

  it("refuses an account without the trainer role", async () => {
    db.accounts.get(T).roles = ["lifter"];
    expect((await trainerGate(gateReq(withCookie(session(T))))).fail.status).toBe(401);
  });

  it("stale terms are 403 needsTerms", async () => {
    db.accounts.get(T).trainer_terms = { ...CURRENT, version: "older" };
    const g = await trainerGate(gateReq(withCookie(session(T))));
    expect(g.fail.status).toBe(403);
    expect(await g.fail.json()).toEqual({ needsTerms: true });
  });

  it("refuses once the passkey that signed it in is gone from the index or not native", async () => {
    const t = session(T);
    db.credentials = db.credentials.filter((c) => c.id !== "cT");
    expect((await trainerGate(gateReq(withCookie(t)))).fail.status).toBe(401);
    db.credentials.push({ id: "cT", account_id: T, rp_id: "theforged.fit" });
    expect((await trainerGate(gateReq(withCookie(t)))).fail.status).toBe(401);
    // Another live passkey on the account does not stand in for it.
    expect(db.credentials.some((c) => c.account_id === T && c.rp_id === "heatwayve.app")).toBe(false);
    db.credentials.push({ id: "cT2", account_id: T, rp_id: "heatwayve.app" });
    expect((await trainerGate(gateReq(withCookie(t)))).fail.status).toBe(401);
  });

  it("admits a live session with no write while it is under a day old", async () => {
    const g = await trainerGate(gateReq(withCookie(session(T, { ageMs: DAY - 60_000 }))));
    expect(g).toMatchObject({ identity: { accountId: T, storageKey: "tia" }, account: { credLive: true }, refresh: null });
    expect(writes()).toEqual([]);
  });

  it("slides after a day, carrying the passkey and the original Face ID", async () => {
    const t = session(T, { ageMs: 2 * DAY, authAgeMs: 20 * DAY });
    const g = await trainerGate(gateReq(withCookie(t)));
    expect(typeof g.refresh).toBe("string");
    const next = row(g.refresh);
    expect(next).toMatchObject({ scope: "trainer", credential_id: "cT", account_id: T, auth_at: row(t).auth_at });
    // Face ID 20 days old: the new token lives the remaining 10 days of the 30-day cap, not 14.
    expect(next.expires).toBeGreaterThan(Date.now() + 10 * DAY - 5000);
    expect(next.expires).toBeLessThan(Date.now() + 10 * DAY + 5000);
    expect(writes().map((c) => c.q.trim().slice(0, 23))).toEqual(["INSERT INTO auth_tokens"]);
    // The rotated token is itself a working session.
    expect(await trainerGate(gateReq(withCookie(g.refresh)))).toMatchObject({ refresh: null });
  });

  it("never slides past 30 days from the Face ID", async () => {
    const g = await trainerGate(gateReq(withCookie(session(T, { ageMs: 2 * DAY, authAgeMs: 30 * DAY + 60_000 }))));
    expect(g).toMatchObject({ identity: { accountId: T }, refresh: null });
    expect(writes()).toEqual([]);
  });

  it("cookie name and attributes are pinned", () => {
    expect(TRAINER_COOKIE).toBe("__Host-hw_trainer");
    expect(ts.TRAINER_COOKIE_OPTS).toEqual({ httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 14 * 86400 });
    expect([ts.TRAINER_TTL_MS, ts.TRAINER_ROTATE_AFTER_MS, ts.TRAINER_CAP_MS]).toEqual([14 * DAY, DAY, 30 * DAY]);
  });
});

describe("POST /api/trainer/session/end", () => {
  const end = (token, body = {}) => post(endPOST, "/api/trainer/session/end", body, token ? withCookie(token) : {});
  const cleared = (res) => {
    const set = res.headers.get("set-cookie");
    expect(set).toMatch(/^__Host-hw_trainer=; Path=\/; .*Max-Age=0/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/HttpOnly/i);
  };
  const session = (acct, cred, opts = {}) => mint(acct, { cred, scope: "trainer", ttlMs: 14 * DAY, ...opts });

  it("ends this session by UPDATE (the row stays) and clears the cookie", async () => {
    const t = session(T, "cT");
    const other = session(T, "cT");
    const res = await end(t);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    cleared(res);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].q).toMatch(/^UPDATE auth_tokens SET expires = \?\s+WHERE \(token = \? OR token = \?\) AND expires > \? RETURNING expires$/);
    expect(db.tokens.has(hash(t))).toBe(true);
    expect((await trainerGate(gateReq(withCookie(t)))).fail.status).toBe(401);
    // Another device's session lives on.
    expect(await trainerGate(gateReq(withCookie(other)))).toMatchObject({ identity: { accountId: T } });
  });

  it("everywhere ends every trainer session of this account, and nothing else", async () => {
    const t = session(T, "cT");
    const other = session(T, "cT");
    const sync = mint(T, { cred: "cT", scope: "sync", ttlMs: 30 * DAY });
    const theirs = session(N, "cN");
    const res = await end(t, { everywhere: true });
    expect(res.status).toBe(200);
    cleared(res);
    const w = writes();
    expect(w).toHaveLength(2);
    expect(w[1].q).toMatch(/^UPDATE auth_tokens SET expires = \?\s+WHERE account_id = \? AND scope = 'trainer' AND expires > \? RETURNING expires$/);
    expect(w[1].v[1]).toBe(T);
    for (const gone of [t, other]) expect(row(gone).expires).toBeLessThanOrEqual(Date.now());
    for (const kept of [sync, theirs]) expect(row(kept).expires).toBeGreaterThan(Date.now() + DAY);
    expect(db.tokens.size).toBe(4);
  });

  it("an expired cookie still clears; it cannot end other sessions", async () => {
    const stale = session(T, "cT", { ageMs: 15 * DAY });
    const other = session(T, "cT");
    const res = await end(stale, { everywhere: true });
    expect(res.status).toBe(200);
    cleared(res);
    expect(writes().some((c) => /account_id = \?/.test(c.q))).toBe(false);
    expect(row(other).expires).toBeGreaterThan(Date.now());
  });

  it("no cookie, or a non-trainer token in it: clears, writes nothing", async () => {
    const sync = mint(T, { cred: "cT", scope: "sync", ttlMs: 30 * DAY });
    const ceremony = mint(T, { cred: "cT" });
    for (const t of [null, "nope", sync, ceremony]) {
      const res = await end(t, { everywhere: true });
      expect(res.status).toBe(200);
      cleared(res);
    }
    expect(writes()).toEqual([]);
    expect(row(sync).expires).toBeGreaterThan(Date.now());
    expect(row(ceremony).expires).toBeGreaterThan(Date.now());
  });

  it("a store failure is a generic 500 that still clears the cookie", async () => {
    const t = session(T, "cT");
    failOn = /^\s*UPDATE auth_tokens/;
    const res = await end(t);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    cleared(res);
  });

  it("limit: 20 a minute in memory", async () => {
    await end(null);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-session-end", 20]);
  });
});

describe("SQL and source pins", () => {
  const root = resolve(__dirname, "..");
  const read = (f) => readFileSync(resolve(root, f), "utf8");
  const walk = (d) => readdirSync(resolve(root, d)).flatMap((e) => {
    const p = join(d, e);
    return statSync(resolve(root, p)).isDirectory() ? walk(p) : [p];
  });
  const TRAINER_FILES = ["lib/trainer-store.js", "lib/trainer-session.js", ...walk("app/api/trainer")];

  it("dbTrainerAccount is one SELECT: roles, plan, terms, closure, and the native index row", async () => {
    await freshCeremony({ authToken: mint(T, { cred: "cT" }), profile: "tia" });
    const q = calls.find((c) => /AS cred_live/.test(c.q)).q.replace(/\s+/g, " ").trim();
    expect(q).toBe("SELECT a.roles, a.plan, a.trainer_terms, a.deleted_at, EXISTS (SELECT 1 FROM credentials c WHERE c.id = ? AND c.account_id = a.id AND c.rp_id = 'heatwayve.app') AS cred_live FROM accounts a WHERE a.id = ?");
  });

  it("the two expiry statements are UPDATEs with their full WHERE", () => {
    const src = read("lib/db.js").replace(/\s+/g, " ");
    expect(src).toContain("UPDATE auth_tokens SET expires = ${now} WHERE (token = ${tokenKey(token)} OR token = ${legacyKey(token)}) AND expires > ${now} RETURNING expires");
    expect(src).toContain("UPDATE auth_tokens SET expires = ${now} WHERE account_id = ${accountId} AND scope = 'trainer' AND expires > ${now} RETURNING expires");
  });

  it("no DELETE, DROP, TRUNCATE or token delete in any trainer file", () => {
    expect(TRAINER_FILES.length).toBeGreaterThanOrEqual(5);
    for (const f of TRAINER_FILES) {
      expect(read(f), f).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bdel\(|dbDeleteToken|removeItem/);
    }
  });

  it("every trainer route runs in lhr1, is dynamic, and never returns e.message", () => {
    const routes = walk("app/api/trainer").filter((f) => f.endsWith("route.js"));
    expect(routes.sort()).toEqual(["app/api/trainer/invite/route.js", "app/api/trainer/session/end/route.js", "app/api/trainer/session/route.js", "app/api/trainer/upgrade/route.js"]);
    for (const f of routes) {
      const s = read(f);
      expect(s, f).toContain('export const preferredRegion = "lhr1";');
      expect(s, f).toContain('export const dynamic = "force-dynamic";');
      expect(s, f).not.toMatch(/e(rr)?\.message/);
    }
  });

  it("trainerGate reads the trainer cookie and never x-hw-auth", () => {
    const src = read("lib/trainer-session.js");
    const gate = src.slice(src.indexOf("export async function trainerGate"));
    expect(gate).toContain("request.cookies?.get?.(TRAINER_COOKIE)");
    expect(gate).not.toContain("x-hw-auth");
  });
});

describe("a session never outlives its Face ID by more than 30 days", () => {
  it("trainerSessionTtl: 14 days while young, the remainder of the 30 days near the cap, nothing past it", async () => {
    const { trainerSessionTtl, TRAINER_TTL_MS, TRAINER_CAP_MS } = await import("@/lib/trainer-session");
    const DAY = 86_400_000;
    const authAt = new Date("2026-10-01T10:00:00.000Z");
    const at = (days) => authAt.getTime() + days * DAY;
    expect(trainerSessionTtl(authAt.toISOString(), at(0))).toBe(TRAINER_TTL_MS);
    expect(trainerSessionTtl(authAt.toISOString(), at(15))).toBe(TRAINER_TTL_MS);
    expect(trainerSessionTtl(authAt.toISOString(), at(29))).toBe(TRAINER_CAP_MS - 29 * DAY);
    expect(trainerSessionTtl(authAt.toISOString(), at(31))).toBe(0);
    expect(trainerSessionTtl(null, at(0))).toBe(TRAINER_TTL_MS);
  });
});
