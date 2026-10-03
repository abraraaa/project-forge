// Trainer invite route. The Neon driver is faked with small in-memory tables
// (trainer_invites keeps its primary key and its unique code index), so the
// gate, the store and the route run for real and every statement is captured.
// The only writes allowed: the slot upsert, the cancel UPDATE and the gate's
// daily session INSERT. Nothing is ever deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const DAY = 86400000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer, the admin
const N = id26("n"); // trainer, not the admin
const L = id26("l"); // lifter

const db = { tokens: new Map(), accounts: new Map(), handles: [], credentials: [], invites: new Map(), grants: [] };
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
    if (/^\s*SELECT \* FROM accounts WHERE storage_key = \? LIMIT 1$/.test(q)) {
      const a = [...db.accounts.values()].find((x) => x.storage_key === v[0]);
      return a ? [{ ...a }] : [];
    }
    if (/AS cred_live/.test(q)) {
      const [cred, acct] = v;
      const a = db.accounts.get(acct);
      if (!a) return [];
      const live = db.credentials.some((c) => c.id === cred && c.account_id === a.id && c.rp_id === "heatwayve.app");
      return [{ roles: a.roles, plan: a.plan, trainer_terms: a.trainer_terms, deleted_at: a.deleted_at, cred_live: live }];
    }
    if (/^\s*INSERT INTO trainer_invites .* ON CONFLICT \(trainer_account_id\) DO UPDATE SET code_hash = EXCLUDED\.code_hash, issued_at = EXCLUDED\.issued_at,\s+expires_at = EXCLUDED\.expires_at, used_at = NULL, grant_id = NULL$/s.test(q)) {
      const [t, h, issued, expires] = v;
      for (const [k, r] of db.invites) {
        if (k !== t && r.code_hash === h) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      db.invites.set(t, { code_hash: h, issued_at: issued, expires_at: expires, used_at: null, grant_id: null });
      return [];
    }
    if (/^\s*UPDATE trainer_invites SET expires_at = \?\s+WHERE trainer_account_id = \? AND used_at IS NULL AND expires_at > \? RETURNING trainer_account_id$/.test(q)) {
      const [now, t, guard] = v;
      const r = db.invites.get(t);
      if (r && r.used_at == null && r.expires_at > guard) { r.expires_at = now; return [{ trainer_account_id: t }]; }
      return [];
    }
    if (/FROM trainer_invites i\s+LEFT JOIN oauth_grants g/.test(q)) {
      const r = db.invites.get(v[0]);
      if (!r) return [];
      const g = db.grants.find((x) => x.id === r.grant_id && x.kind === "trainer" && x.trainer_account_id === v[0] && x.revoked_at == null);
      const h = g && db.handles.find((x) => x.account_id === g.account_id && x.released_at == null);
      return [{ expires_at: String(r.expires_at), used_at: r.used_at, handle: h?.handle ?? null, display: h?.display ?? null }];
    }
    throw new Error(`unexpected SQL: ${q}`);
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));

const { GET, POST } = await import("@/app/api/trainer/invite/route");
const { TRAINER_COOKIE } = await import("@/lib/trainer-session");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { normaliseCode } = await import("@/lib/trainer-code");
const { rateLimit, rateLimitShared } = await import("@/lib/rate-limit");
const { NextResponse } = await import("next/server");

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, sk, roles, trainer_terms = null) => ({
  id, storage_key: sk, webauthn_user_id: "u-" + sk, roles, plan: "free", consent: null, trainer_terms,
  origin: "claim", created_at: null, lapsed_at: null, deleted_at: null,
});
let seq = 0;
const session = (acct, cred, { scope = "trainer", ageMs = 60_000, ttlMs = 14 * DAY } = {}) => {
  const token = `tok-${++seq}`;
  db.tokens.set(hash(token), {
    profile: db.accounts.get(acct).storage_key, expires: Date.now() + ttlMs - ageMs, scope,
    created_at: new Date(Date.now() - ageMs).toISOString(), auth_at: new Date(Date.now() - ageMs).toISOString(),
    credential_id: cred, account_id: acct,
  });
  return token;
};
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.q));
const verbs = () => writes().map((c) => c.q.trim().match(/^(INSERT INTO|UPDATE) \w+/)[0]);
const H = "https://heatwayve.app/api/trainer/invite";
const cookie = (t) => (t ? { cookie: `${TRAINER_COOKIE}=${t}` } : {});
const post = (token, body) => POST(new NextRequest(H, {
  method: "POST", headers: { "content-type": "application/json", ...cookie(token) }, body: JSON.stringify(body),
}));
const get = (token) => GET(new NextRequest(H, { headers: cookie(token) }));
const SIGN_IN = { error: "Sign in to see your clients", requiresAuth: true };

beforeEach(() => {
  calls.length = 0;
  failOn = null;
  db.tokens.clear();
  db.invites.clear();
  db.grants = [];
  db.accounts = new Map([
    [T, account(T, "tia", ["lifter", "trainer"], CURRENT)],
    [N, account(N, "nia", ["lifter", "trainer"], CURRENT)],
    [L, account(L, "leo", ["lifter"])],
  ]);
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T, released_at: null },
    { handle: "nia", display: "Nia", account_id: N, released_at: null },
    { handle: "leo", display: "Leo", account_id: L, released_at: null },
  ];
  db.credentials = [
    { id: "cT", account_id: T, rp_id: "heatwayve.app" },
    { id: "cN", account_id: N, rp_id: "heatwayve.app" },
    { id: "cL", account_id: L, rp_id: "heatwayve.app" },
  ];
  process.env.DATABASE_URL = "postgres://fake";
  process.env.ADMIN_ACCOUNT_ID = T;
  vi.mocked(rateLimit).mockClear();
  vi.mocked(rateLimitShared).mockClear();
  vi.mocked(rateLimitShared).mockImplementation(async () => null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_ACCOUNT_ID;
});

describe("POST /api/trainer/invite: issue", () => {
  it("returns the code once, stores only its hash, 60 minutes", async () => {
    const t = session(T, "cT");
    const before = Date.now();
    const res = await post(t, { action: "issue" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["code", "expiresAt"]);
    expect(normaliseCode(body.code)).toBe(body.code);
    expect(body.expiresAt - before).toBeGreaterThanOrEqual(3_600_000);
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);

    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].q).toMatch(/^INSERT INTO trainer_invites/);
    expect(w[0].v[0]).toBe(T);
    expect(db.invites.get(T)).toMatchObject({ code_hash: hash(body.code), used_at: null, grant_id: null, expires_at: body.expiresAt });
    expect(JSON.stringify([...db.invites.values(), ...calls])).not.toContain(body.code);
  });

  it("issuing again overwrites the one slot: the old code is gone, a used slot is fresh again", async () => {
    const t = session(T, "cT");
    const first = await (await post(t, { action: "issue" })).json();
    db.invites.get(T).used_at = Date.now();
    db.invites.get(T).grant_id = "hwg_x";
    const second = await (await post(t, { action: "issue" })).json();
    expect(second.code).not.toBe(first.code);
    expect(db.invites.size).toBe(1);
    expect(db.invites.get(T)).toMatchObject({ code_hash: hash(second.code), used_at: null, grant_id: null });
    expect([...db.invites.values()].some((r) => r.code_hash === hash(first.code))).toBe(false);
    expect(verbs()).toEqual(["INSERT INTO trainer_invites", "INSERT INTO trainer_invites"]);
  });

  it("another trainer's slot is never touched", async () => {
    await post(session(T, "cT"), { action: "issue" });
    const theirs = { ...db.invites.get(T) };
    process.env.ADMIN_ACCOUNT_ID = N;
    await post(session(N, "cN"), { action: "issue" });
    expect(db.invites.get(T)).toEqual(theirs);
    expect(db.invites.size).toBe(2);
  });
});

describe("POST /api/trainer/invite: cancel", () => {
  it("ends a pending code by UPDATE expires_at; the row stays", async () => {
    const t = session(T, "cT");
    await post(t, { action: "issue" });
    calls.length = 0;
    const res = await post(t, { action: "cancel" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].q).toMatch(/^UPDATE trainer_invites SET expires_at = \?\s+WHERE trainer_account_id = \? AND used_at IS NULL AND expires_at > \? RETURNING trainer_account_id$/);
    expect(w[0].v[1]).toBe(T);
    expect(db.invites.get(T).expires_at).toBeLessThanOrEqual(Date.now());
    expect((await (await get(t)).json()).status).toBe("expired");
  });

  it("a used code stays used, and cancelling with no slot is a quiet ok", async () => {
    const t = session(T, "cT");
    expect(await (await post(t, { action: "cancel" })).json()).toEqual({ ok: true });
    await post(t, { action: "issue" });
    const slot = db.invites.get(T);
    slot.used_at = Date.now();
    const exp = slot.expires_at;
    await post(t, { action: "cancel" });
    expect(db.invites.get(T)).toMatchObject({ expires_at: exp });
  });
});

describe("POST /api/trainer/invite: gates", () => {
  it("no cookie, a lifter, or a non-trainer token: 401, nothing written", async () => {
    for (const t of [null, "nope", session(L, "cL"), session(T, "cT", { scope: null }), session(T, "cT", { scope: "sync" })]) {
      const res = await post(t, { action: "issue" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(SIGN_IN);
    }
    expect(writes()).toEqual([]);
    expect(db.invites.size).toBe(0);
  });

  it("stale terms: 403 needsTerms, nothing written", async () => {
    db.accounts.get(T).trainer_terms = { ...CURRENT, version: "older" };
    const res = await post(session(T, "cT"), { action: "issue" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ needsTerms: true });
    expect(writes()).toEqual([]);
  });

  it("a trainer other than the admin gets 503 before launch, for issue and cancel alike", async () => {
    const t = session(N, "cN");
    for (const action of ["issue", "cancel"]) {
      const res = await post(t, { action });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Not open yet." });
    }
    expect(writes()).toEqual([]);
  });

  it("an unknown action is 400 and writes nothing", async () => {
    const t = session(T, "cT");
    for (const body of [{}, { action: "delete" }, { action: ["issue"] }, null]) {
      const res = await post(t, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown action" });
    }
    expect(writes()).toEqual([]);
  });

  it("limits: 10 a minute in memory, then 30 an hour shared per trainer account", async () => {
    await post(session(T, "cT"), { action: "issue" });
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-invite", 10]);
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["trainer-invite", 30, { windowMs: 3_600_000, id: T }]);
  });

  it("over the shared limit: 429, no-store, the slot untouched", async () => {
    vi.mocked(rateLimitShared).mockImplementation(async () => NextResponse.json({ error: "Too many requests" }, { status: 429 }));
    const res = await post(session(T, "cT"), { action: "issue" });
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(db.invites.size).toBe(0);
  });

  it("a store failure is a generic 500, no-store, no code", async () => {
    failOn = /^\s*INSERT INTO trainer_invites/;
    const res = await post(session(T, "cT"), { action: "issue" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("carries the gate's daily slide on the response", async () => {
    const res = await post(session(T, "cT", { ageMs: 2 * DAY }), { action: "issue" });
    expect(res.status).toBe(200);
    const next = res.cookies.get(TRAINER_COOKIE);
    expect(next?.value).toBeTruthy();
    expect(db.tokens.get(hash(next.value))).toMatchObject({ scope: "trainer", credential_id: "cT", account_id: T });
    expect(verbs()).toEqual(["INSERT INTO auth_tokens", "INSERT INTO trainer_invites"]);
  });
});

describe("GET /api/trainer/invite", () => {
  it("none, then pending, then expired; reads only", async () => {
    const t = session(T, "cT");
    expect(await (await get(t)).json()).toEqual({ status: "none", expiresAt: null });
    const { expiresAt } = await (await post(t, { action: "issue" })).json();
    calls.length = 0;
    const res = await get(t);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "pending", expiresAt });
    db.invites.get(T).expires_at = Date.now() - 1;
    expect((await (await get(t)).json()).status).toBe("expired");
    expect(writes()).toEqual([]);
  });

  it("used names the client only while their grant to this trainer is live", async () => {
    const t = session(T, "cT");
    await post(t, { action: "issue" });
    Object.assign(db.invites.get(T), { used_at: Date.now(), grant_id: "hwg_1" });
    db.grants = [{ id: "hwg_1", kind: "trainer", account_id: L, trainer_account_id: T, revoked_at: null }];
    const live = await (await get(t)).json();
    expect(live).toMatchObject({ status: "used", usedBy: "Leo" });
    db.grants[0].revoked_at = Date.now();
    const ended = await (await get(t)).json();
    expect(ended.status).toBe("used");
    expect(ended).not.toHaveProperty("usedBy");
  });

  it("is behind the trainer gate, never x-hw-auth", async () => {
    const res = await GET(new NextRequest(H, { headers: { "x-hw-auth": session(T, "cT") } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(SIGN_IN);
  });

  it("limit: 60 a minute in memory, nothing shared", async () => {
    await get(session(T, "cT"));
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-invite-status", 60]);
    expect(rateLimitShared).not.toHaveBeenCalled();
  });
});
