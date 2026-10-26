// POST /api/trainer/terms: Continue on the roster's Terms notice. The Neon
// driver is faked with small in-memory tables, so the gate, identity-store and
// the route run for real and every statement is captured. The only writes
// allowed: the acceptance UPDATE of accounts.trainer_terms and the gate's
// daily session INSERT. Nothing is ever deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86400000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer, the admin
const N = id26("n"); // trainer, not the admin

const db = { tokens: new Map(), accounts: new Map(), credentials: [] };
const calls = [];
let failOn = null;

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
    if (/^\s*SELECT \* FROM accounts WHERE id = \? LIMIT 1$/.test(q)) {
      const a = db.accounts.get(v[0]);
      return a ? [{ ...a }] : [];
    }
    if (/AS cred_live/.test(q)) {
      const [cred, acct] = v;
      const a = db.accounts.get(acct);
      if (!a) return [];
      const live = db.credentials.some((c) => c.id === cred && c.account_id === a.id && c.rp_id === "heatwayve.app");
      return [{ roles: a.roles, plan: a.plan, trainer_terms: a.trainer_terms, deleted_at: a.deleted_at, cred_live: live }];
    }
    if (/^\s*UPDATE accounts SET trainer_terms = \?::jsonb\s+WHERE id = \? AND deleted_at IS NULL RETURNING id$/.test(q)) {
      const [terms, acct] = v;
      const a = db.accounts.get(acct);
      if (!a || a.deleted_at) return [];
      a.trainer_terms = JSON.parse(terms);
      return [{ id: acct }];
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
// The real store, with the Terms write spy-able so one test can answer "no database".
vi.mock("@/lib/identity-store", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, dbAcceptTrainerTerms: vi.fn(real.dbAcceptTrainerTerms) };
});
// TRAINER_LIVE as shipped unless a test closes it.
const switchLive = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/trainer-terms", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, get TRAINER_LIVE() { return switchLive.value; } };
});

const { POST } = await import("@/app/api/trainer/terms/route");
const { TRAINER_COOKIE, trainerGate } = await import("@/lib/trainer-session");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { rateLimit, rateLimitShared } = await import("@/lib/rate-limit");
const { dbAcceptTrainerTerms } = await import("@/lib/identity-store");

const OLDER = { version: "draft-2026-10-05b", at: "2026-10-06T00:00:00.000Z", adult: true };
const account = (id, sk, trainer_terms) => ({
  id, storage_key: sk, webauthn_user_id: "u-" + sk, roles: ["lifter", "trainer"], plan: "free", consent: null, trainer_terms,
  origin: "claim", created_at: null, lapsed_at: null, deleted_at: null,
});
let seq = 0;
/** A trainer session row as the session route mints it; returns the raw token. */
const session = (acct, { cred = "cT", ageMs = 60_000 } = {}) => {
  const token = `tok-${++seq}`;
  const a = db.accounts.get(acct);
  db.tokens.set(hash(token), {
    profile: a.storage_key, expires: Date.now() + 14 * DAY - ageMs, scope: "trainer",
    created_at: new Date(Date.now() - ageMs).toISOString(), auth_at: new Date(Date.now() - ageMs).toISOString(),
    credential_id: cred, account_id: acct,
  });
  return token;
};
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.q));
const H = "https://heatwayve.app";
const post = (body, token) => POST(new NextRequest(`${H}/api/trainer/terms`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { cookie: `${TRAINER_COOKIE}=${token}` } : {}) },
  body: JSON.stringify(body),
}));
const accept = (token) => post({ version: TRAINER_TERMS_VERSION }, token);

beforeEach(() => {
  calls.length = 0;
  failOn = null;
  db.tokens.clear();
  db.accounts = new Map([[T, account(T, "tia", OLDER)], [N, account(N, "nia", OLDER)]]);
  db.credentials = [{ id: "cT", account_id: T, rp_id: "heatwayve.app" }, { id: "cN", account_id: N, rp_id: "heatwayve.app" }];
  process.env.DATABASE_URL = "postgres://fake";
  process.env.ADMIN_ACCOUNT_ID = T;
  switchLive.value = true;
  vi.mocked(rateLimit).mockClear();
  vi.mocked(rateLimitShared).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_ACCOUNT_ID;
});

describe("POST /api/trainer/terms", () => {
  it("an older-version trainer accepts on the cookie: exactly { ok, termsChanged: null }, the record overwritten in place", async () => {
    const t = session(T);
    const before = Date.now();
    const res = await accept(t);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ok: true, termsChanged: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rec = db.accounts.get(T).trainer_terms;
    expect(Object.keys(rec).sort()).toEqual(["adult", "at", "version"]);
    expect(rec).toMatchObject({ version: TRAINER_TERMS_VERSION, adult: true });
    expect(new Date(rec.at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rec.at).not.toBe(OLDER.at);
    expect(db.accounts.get(T).roles).toEqual(["lifter", "trainer"]);
    // One write, the acceptance UPDATE on the caller's own row; nothing deleted.
    expect(writes()).toHaveLength(1);
    expect(writes()[0].v.at(-1)).toBe(T);
    // The same cookie no longer carries the change.
    const g = await trainerGate(new NextRequest(`${H}/api/trainer/clients`, { method: "POST", headers: { cookie: `${TRAINER_COOKIE}=${t}` } }));
    expect(g).toMatchObject({ identity: { accountId: T }, termsChanged: null });
    // The other trainer is untouched.
    expect(db.accounts.get(N).trainer_terms).toEqual(OLDER);
  });

  it("a current-version trainer accepts again: 200, the same shape, idempotent", async () => {
    db.accounts.get(T).trainer_terms = { version: TRAINER_TERMS_VERSION, at: "2026-10-21T09:00:00.000Z", adult: true };
    const t = session(T);
    for (let i = 0; i < 2; i++) {
      const res = await accept(t);
      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({ ok: true, termsChanged: null });
    }
    expect(db.accounts.get(T).trainer_terms).toMatchObject({ version: TRAINER_TERMS_VERSION, adult: true });
    expect(db.accounts.get(T).roles).toEqual(["lifter", "trainer"]);
  });

  it.each([
    ["an older version", { version: "draft-2026-10-05b" }],
    ["an unknown version", { version: "draft-2099-01-01" }],
    ["no version", {}],
    ["a non-string version", { version: 1 }],
    ["the upgrade's shape", { terms: { version: TRAINER_TERMS_VERSION } }],
    ["no object", null],
  ])("%s is 400 with nothing written", async (_, body) => {
    const res = await post(body, session(T));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Accept the Trainer Terms to continue." });
    expect(writes()).toEqual([]);
    expect(db.accounts.get(T).trainer_terms).toEqual(OLDER);
  });

  it("no cookie is the gate's 401, nothing written", async () => {
    const res = await accept(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in to see your clients", requiresAuth: true });
    expect(writes()).toEqual([]);
  });

  it("a ceremony token in the cookie (not a trainer session) is 401, nothing written", async () => {
    const t = session(T);
    db.tokens.get(hash(t)).scope = null;
    expect((await accept(t)).status).toBe(401);
    expect(writes()).toEqual([]);
  });

  it("a trainer who never accepted keeps the gate's 403 needsTerms; this route never makes a first acceptance", async () => {
    db.accounts.get(T).trainer_terms = null;
    const res = await accept(session(T));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ needsTerms: true });
    expect(writes()).toEqual([]);
    expect(db.accounts.get(T).trainer_terms).toBeNull();
  });

  it("with the switch closed, a trainer other than the admin may not re-accept: 503, nothing written; the admin may", async () => {
    switchLive.value = false;
    const res = await accept(session(N, { cred: "cN" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Not open yet." });
    expect(writes()).toEqual([]);
    expect((await accept(session(T))).status).toBe(200);
  });

  it("a session older than a day slides on the reply, as the other cookie routes do", async () => {
    const t = session(T, { ageMs: DAY + 60_000 });
    const res = await accept(t);
    expect(res.status).toBe(200);
    const slid = res.cookies.get(TRAINER_COOKIE)?.value;
    expect(slid).toBeTruthy();
    expect(slid).not.toBe(t);
    // A young session sets no cookie.
    expect((await accept(session(T))).cookies.get(TRAINER_COOKIE)).toBeUndefined();
  });

  it("a store failure is a 500 with no server detail", async () => {
    failOn = /^\s*UPDATE accounts/;
    const res = await accept(session(T));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("no database is an outage, not a sign-out: 500, nothing written, no requiresAuth", async () => {
    vi.mocked(dbAcceptTrainerTerms).mockResolvedValueOnce(null);
    const res = await accept(session(T));
    expect(res.status).toBe(500);
    expect((await res.json()).requiresAuth).toBeUndefined();
    expect(db.accounts.get(T).trainer_terms).toEqual(OLDER);
    expect(writes().filter((c) => /UPDATE accounts/.test(c.q))).toHaveLength(0);
  });

  it("limits: 5 a minute in memory, 10 shared, as the upgrade", async () => {
    await accept(null);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-terms", 5]);
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["trainer-terms", 10]);
  });

  it("source: the write is the upgrade's own acceptance call; no delete", () => {
    const src = readFileSync(resolve(__dirname, "../app/api/trainer/terms/route.js"), "utf8");
    expect(src).toContain("dbAcceptTrainerTerms(g.identity.accountId, { version, at: new Date().toISOString(), adult: true })");
    expect(src).not.toContain("dbGrantTrainerRole");
    expect(src).not.toMatch(/\bDELETE\b|\bDROP\b|\bdel\(|removeItem|freshCeremony|authToken/);
  });
});
