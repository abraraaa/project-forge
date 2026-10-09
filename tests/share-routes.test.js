// Share peek and approve. The Neon driver is faked with small in-memory
// tables (tokens, accounts, handles, credentials, invites, grants and the
// rate counters), and statements are lazy as in the real driver, so a
// transaction runs in order and rolls back whole. db.js, identity-store,
// trainer-store, auth-server, the gates, failureGate and both routes run for
// real. The only writes allowed: the approve transaction, one failure count
// per approve miss, and the ceremony token's expiry after a success.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer, the admin
const N = id26("n"); // trainer, not the admin: open once live
const L = id26("l"); // client
const M = id26("m"); // another client

const db = {
  tokens: new Map(), accounts: new Map(), handles: [], credentials: [],
  invites: [], grants: [], buckets: new Map(),
};
const calls = [];
let failOn = null;      // a regex: the matching statement throws
let beforeTxn = null;   // runs just before a transaction's first statement
const flat = (q) => q.replace(/\s+/g, " ").trim();
const unique = () => Object.assign(new Error("duplicate key value violates unique constraint \"oauth_grants_one_trainer\""), { code: "23505" });
const alive = (id) => { const a = db.accounts.get(id); return !!a && !a.deleted_at; };

/** The value list of S3's SELECT, column by column, as Postgres would build it. */
function s3Row(q, v, invite) {
  const cols = q.match(/INSERT INTO oauth_grants \(([^)]+)\)/)[1].split(",").map((s) => s.trim());
  const exprs = q.match(/SELECT (.+?)\s+FROM trainer_invites/s)[1].split(",").map((s) => s.trim());
  let i = 0;
  const vals = exprs.map((e) => {
    if (e === "?") return v[i++];
    if (e === "NULL") return null;
    if (e === "i.trainer_account_id") return invite.trainer_account_id;
    if (e === "'[]'::jsonb") return [];
    if (/^'[^']*'$/.test(e)) return e.slice(1, -1);
    if (/^\d+$/.test(e)) return Number(e);
    throw new Error(`unexpected S3 expression ${e}`);
  });
  expect(vals).toHaveLength(cols.length);
  return Object.fromEntries(cols.map((c, k) => [c, vals[k]]));
}

function run(q, v) {
  calls.push({ q, v });
  if (failOn && failOn.test(q)) throw new Error("db down");
  if (/^\s*SELECT profile, expires, scope, created_at, auth_at, credential_id, account_id FROM auth_tokens/.test(q)) {
    const r = db.tokens.get(v[0]) ?? (v[1] != null ? db.tokens.get(v[1]) : undefined);
    return r ? [{ ...r }] : [];
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
  if (/^\s*SELECT \* FROM accounts WHERE id = \? LIMIT 1$/.test(q)) {
    const a = db.accounts.get(v[0]);
    return a ? [{ ...a }] : [];
  }
  if (/FROM handles h JOIN accounts a/.test(q)) {
    const h = db.handles.find((x) => x.handle === v[0]);
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
    const h = db.handles.find((x) => x.account_id === v[0]);
    return h ? [{ handle: h.handle, display: h.display }] : [];
  }
  if (/^\s*SELECT count FROM rate_buckets WHERE bucket = \? AND window_start = \?$/.test(q)) {
    const r = db.buckets.get(v[0]);
    return r && r.window_start === v[1] ? [{ count: r.count }] : [];
  }
  if (/^\s*INSERT INTO rate_buckets/.test(q)) {
    const [bucket, windowStart] = v;
    const r = db.buckets.get(bucket);
    const count = r && r.window_start === windowStart ? r.count + 1 : 1;
    db.buckets.set(bucket, { window_start: windowStart, count });
    return [{ count }];
  }
  if (/^\s*SELECT i\.trainer_account_id, i\.expires_at, a\.id, a\.storage_key, a\.roles, a\.plan, a\.trainer_terms/.test(q)) {
    const [h, now] = v;
    const i = db.invites.find((x) => x.code_hash === h && x.used_at == null && x.expires_at > now && alive(x.trainer_account_id));
    if (!i) return [];
    const a = db.accounts.get(i.trainer_account_id);
    return [{ trainer_account_id: i.trainer_account_id, expires_at: String(i.expires_at), id: a.id, storage_key: a.storage_key, roles: a.roles, plan: a.plan, trainer_terms: a.trainer_terms }];
  }
  if (/^\s*SELECT id, trainer_account_id FROM oauth_grants/.test(q)) {
    return db.grants.filter((g) => g.account_id === v[0] && g.kind === "trainer" && g.revoked_at == null)
      .map((g) => ({ id: g.id, trainer_account_id: g.trainer_account_id }));
  }
  if (/^\s*UPDATE trainer_invites SET used_at = \?, grant_id = \?/.test(q)) {
    const [now, gid, h, guard, client] = v;
    for (const i of db.invites) {
      if (i.code_hash === h && i.used_at == null && i.expires_at > guard && i.trainer_account_id !== client) { i.used_at = now; i.grant_id = gid; }
    }
    return [];
  }
  if (/^\s*UPDATE oauth_grants SET revoked_at = \?, revoked_by = 'replaced'/.test(q)) {
    // Modelled from the text: the id filter applies only if the statement has one.
    const [now, client] = v;
    const gid = v[v.length - 1];
    const byId = /AND id = \?/.test(q);
    if (!db.invites.some((i) => i.grant_id === gid && alive(i.trainer_account_id))) return [];
    for (const g of db.grants) {
      if (g.account_id === client && g.kind === "trainer" && g.revoked_at == null && (!byId || (v[2] != null && g.id === v[2]))) {
        g.revoked_at = now; g.revoked_by = "replaced";
      }
    }
    return [];
  }
  if (/^\s*INSERT INTO oauth_grants/.test(q)) {
    const gid = v[v.length - 1];
    const invite = db.invites.find((i) => i.grant_id === gid && alive(i.trainer_account_id));
    if (!invite) return [];
    const row = s3Row(q, v, invite);
    // oauth_grants_one_trainer: one live trainer grant per client.
    if (db.grants.some((g) => g.account_id === row.account_id && g.kind === "trainer" && g.revoked_at == null)) throw unique();
    db.grants.push({ ...row, revoked_at: null, revoked_by: null, last_used_at: null });
    return [{ id: row.id }];
  }
  throw new Error(`unexpected SQL: ${q}`);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    // Lazy like the driver: a statement runs when awaited, or in its turn inside a transaction.
    const tag = (strings, ...v) => {
      const q = strings.join("?");
      const exec = async () => (/^\s*(CREATE|ALTER)\b/.test(q) ? [] : run(q, v));
      return { exec, then: (ok, ko) => exec().then(ok, ko) };
    };
    tag.transaction = async (queries) => {
      if (beforeTxn) beforeTxn(); // another request commits first
      const snapshot = structuredClone({ invites: db.invites, grants: db.grants });
      const out = [];
      try {
        for (const s of queries) out.push(await s.exec());
      } catch (e) {
        db.invites = snapshot.invites;
        db.grants = snapshot.grants;
        throw e;
      }
      return out;
    };
    return tag;
  },
}));
// TRAINER_LIVE as shipped unless a test closes it.
const switchLive = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/trainer-terms", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, get TRAINER_LIVE() { return switchLive.value; } };
});
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal()),
  rateLimit: vi.fn(() => null),
  rateLimitShared: vi.fn(async () => null),
}));

const { POST: peekPOST } = await import("@/app/api/share/peek/route");
const { POST: approvePOST } = await import("@/app/api/share/approve/route");
const { TRAINER_TERMS_VERSION, SHARE_CONSENT_VERSION, TRAINER_SCOPE } = await import("@/lib/trainer-terms");
const { TRAINER_RESOURCE } = await import("@/lib/oauth");
const { sharedBucket, rateLimit, rateLimitShared } = await import("@/lib/rate-limit");
const { formatCode, shareUrl } = await import("@/lib/trainer-code");

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, sk, roles, trainer_terms = null) => ({
  id, storage_key: sk, webauthn_user_id: "u-" + sk, roles, plan: "free", consent: null, trainer_terms,
  origin: "claim", created_at: null, lapsed_at: null, deleted_at: null,
});
let seq = 0;
/** A quiet ceremony token as login-verify mints it; returns the raw token. */
const mint = (acct, { cred = null, scope = null, ageMs = 60_000 } = {}) => {
  const token = `tok-${++seq}`;
  const a = db.accounts.get(acct);
  db.tokens.set(hash(token), {
    profile: a.storage_key, expires: Date.now() + 3600_000 - ageMs, scope,
    created_at: new Date(Date.now() - ageMs).toISOString(), auth_at: new Date(Date.now() - ageMs).toISOString(),
    credential_id: cred, account_id: acct,
  });
  return token;
};
const tokenLive = (token) => db.tokens.get(hash(token)).expires > Date.now();
/** A pending invite in the trainer's slot. */
const invite = (trainer, code, { expiresAt = Date.now() + 3600_000, usedAt = null } = {}) => {
  db.invites = db.invites.filter((i) => i.trainer_account_id !== trainer);
  db.invites.push({ trainer_account_id: trainer, code_hash: hash(code), issued_at: Date.now(), expires_at: expiresAt, used_at: usedAt, grant_id: null });
  return code;
};
const grant = (id, client, trainer) => db.grants.push({
  id, client_id: "hw:trainer", account_id: client, profile: db.accounts.get(client).storage_key, credential_id: "c?",
  scope: "trainer:read", created_at: 1, kind: "trainer", resource: TRAINER_RESOURCE, expires_at: null,
  trainer_account_id: trainer, consent_version: SHARE_CONSENT_VERSION, looks: [], look_count: 0,
  revoked_at: null, revoked_by: null, last_used_at: null,
});
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.q)).map((c) => flat(c.q).split(" ").slice(0, 3).join(" "));
const strikes = () => db.buckets.get(sharedBucket("share-approve-fail", L))?.count ?? 0;
const live = (client) => db.grants.filter((g) => g.account_id === client && g.revoked_at == null);

const H = "https://heatwayve.app";
const post = (fn, path, body) => fn(new NextRequest(`${H}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const peek = (code) => post(peekPOST, "/api/share/peek", { code });
const approve = (body) => post(approvePOST, "/api/share/approve", { consent: { version: SHARE_CONSENT_VERSION }, profile: "leo", ...body });

const CODE = "ABCDEFGHJKMN";
const CODE_N = "0123456789AB";
const MISS = { error: "That code didn't work. Check it, or ask your trainer for a fresh one." };
const TOO_MANY = { error: "Too many tries. Ask your trainer for a fresh code, then try again in an hour." };
const UNAVAILABLE = { error: "Sharing is unavailable right now. Try again in a bit." };

beforeEach(() => {
  switchLive.value = true;
  calls.length = 0;
  failOn = null;
  beforeTxn = null;
  db.tokens.clear();
  db.buckets.clear();
  db.invites = [];
  db.grants = [];
  db.accounts = new Map([
    [T, account(T, "tia", ["lifter", "trainer"], CURRENT)],
    [N, account(N, "nia", ["lifter", "trainer"], CURRENT)],
    [L, account(L, "leo", ["lifter"])],
    [M, account(M, "mal", ["lifter"])],
  ]);
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T },
    { handle: "nia", display: "Nia", account_id: N },
    { handle: "leo", display: "Leo", account_id: L },
    { handle: "mal", display: "Mal", account_id: M },
  ];
  db.credentials = [
    { id: "cT", account_id: T, rp_id: "heatwayve.app" },
    { id: "cL", account_id: L, rp_id: "heatwayve.app" },
    { id: "cLegacy", account_id: L, rp_id: "theforged.fit" },
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
  delete process.env.TRAINER_PREVIEW_ACCOUNTS;
});

describe("POST /api/share/peek", () => {
  it("names the trainer behind a pending code, read only", async () => {
    invite(T, CODE);
    const res = await peek(CODE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trainer: { name: "Tia" }, expiresAt: db.invites[0].expires_at });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(writes()).toEqual([]);
  });

  it("a spaced lowercase code, a dashed code and a whole share link all peek", async () => {
    invite(T, CODE);
    for (const typed of [formatCode(CODE).toLowerCase(), "abcd-efgh-jkmn", shareUrl(CODE)]) {
      expect((await peek(typed)).status, typed).toBe(200);
    }
  });

  it("live: a trainer other than the admin peeks, with no admin and no preview list set", async () => {
    delete process.env.ADMIN_ACCOUNT_ID;
    invite(N, CODE_N);
    const res = await peek(CODE_N);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trainer: { name: "Nia" }, expiresAt: db.invites[0].expires_at });
    expect(writes()).toEqual([]);
  });

  it("one byte-identical 404 for malformed, unknown, used, expired, closed, non-trainer, stale-terms and not-open codes", async () => {
    const cases = {
      malformed: () => "ABCD",
      "with a U": () => "ABCDEFGHJKMU",
      unknown: () => "ZZZZZZZZZZZZ",
      used: () => invite(T, CODE, { usedAt: Date.now() - 1 }),
      expired: () => invite(T, CODE, { expiresAt: Date.now() - 1 }),
      "closed trainer": () => { db.accounts.get(T).deleted_at = "2026-10-02T00:00:00.000Z"; return invite(T, CODE); },
      "not a trainer": () => { db.accounts.get(T).roles = ["lifter"]; return invite(T, CODE); },
      "stale terms": () => { db.accounts.get(T).trainer_terms = { ...CURRENT, version: "older" }; return invite(T, CODE); },
      "terms without 18+": () => { db.accounts.get(T).trainer_terms = { version: TRAINER_TERMS_VERSION }; return invite(T, CODE); },
      // With the switch closed: only the admin's codes peek, whatever the preview list says.
      "not open (a trainer other than the admin)": () => { switchLive.value = false; return invite(N, CODE_N); },
      "not open, even for a preview client's own trainer": () => { switchLive.value = false; process.env.TRAINER_PREVIEW_ACCOUNTS = N; return invite(N, CODE_N); },
    };
    const bodies = new Set();
    for (const [label, setup] of Object.entries(cases)) {
      switchLive.value = true;
      db.accounts.get(T).deleted_at = null;
      db.accounts.get(T).roles = ["lifter", "trainer"];
      db.accounts.get(T).trainer_terms = CURRENT;
      db.invites = [];
      const res = await peek(setup());
      expect(res.status, label).toBe(404);
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      bodies.add(await res.text());
    }
    expect([...bodies]).toEqual([JSON.stringify(MISS)]);
    // A peek miss never counts against anyone's approve tries.
    expect(writes()).toEqual([]);
    expect(db.buckets.size).toBe(0);
  });

  it("no body, or a non-string code, is the same miss", async () => {
    for (const body of [undefined, { code: 123 }, { code: null }]) {
      const res = await post(peekPOST, "/api/share/peek", body);
      expect(await res.json()).toEqual(MISS);
    }
  });

  it("limits: 10 a minute in memory, 30 a minute shared, per IP", async () => {
    await peek(CODE);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["share-peek", 10]);
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["share-peek", 30]);
  });

  it("a store failure is a generic 500, no-store", async () => {
    invite(T, CODE);
    failOn = /FROM trainer_invites i JOIN accounts a/;
    const res = await peek(CODE);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/share/approve", () => {
  it("live: a client approves a trainer other than the admin, with no admin and no preview list set", async () => {
    delete process.env.ADMIN_ACCOUNT_ID;
    invite(N, CODE_N);
    const authToken = mint(L, { cred: "cL" });
    const res = await approve({ code: CODE_N, authToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trainer: { name: "Nia" }, replaced: null });
    expect(live(L)).toHaveLength(1);
    expect(live(L)[0]).toMatchObject({ trainer_account_id: N, kind: "trainer" });
    expect(strikes()).toBe(0);
  });

  it("approves: one transaction marks the code used and writes the grant; then the ceremony token expires", async () => {
    invite(T, CODE);
    const authToken = mint(L, { cred: "cL" });
    const before = Date.now();
    const res = await approve({ code: formatCode(CODE), authToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trainer: { name: "Tia" }, replaced: null });
    expect(res.headers.get("cache-control")).toBe("no-store");

    // Writes, complete and in order.
    expect(writes()).toEqual(["UPDATE trainer_invites SET", "UPDATE oauth_grants SET", "INSERT INTO oauth_grants", "UPDATE auth_tokens SET"]);
    expect(tokenLive(authToken)).toBe(false);

    // The grant row, every column.
    expect(db.grants).toHaveLength(1);
    const g = db.grants[0];
    expect(g.id).toMatch(/^hwg_[A-Za-z0-9_-]{43}$/);
    expect(g.created_at).toBeGreaterThanOrEqual(before);
    expect(g).toEqual({
      id: g.id, client_id: "hw:trainer", account_id: L, profile: "leo", credential_id: "cL", scope: "trainer:read",
      created_at: g.created_at, kind: "trainer", resource: "https://heatwayve.app/trainer", expires_at: null,
      trainer_account_id: T, consent_version: SHARE_CONSENT_VERSION, looks: [], look_count: 0, edits_at: g.created_at,
      revoked_at: null, revoked_by: null, last_used_at: null,
    });
    expect(TRAINER_SCOPE).toBe(g.scope);
    expect(TRAINER_RESOURCE).toBe(g.resource);
    // The invite is spent and points at the grant.
    expect(db.invites[0]).toMatchObject({ used_at: g.created_at, grant_id: g.id });
    // The code cannot be used again, by anyone.
    expect((await peek(CODE)).status).toBe(404);
    expect(strikes()).toBe(0);
  });

  it("a body asking for other scopes still writes 'trainer:read'", async () => {
    invite(T, CODE);
    const res = await approve({ code: CODE, authToken: mint(L, { cred: "cL" }), scopes: { readiness: false }, admin: true, scope: "training:read" });
    expect(res.status).toBe(200);
    expect(db.grants[0].scope).toBe("trainer:read");
    expect(Object.keys(db.grants[0])).not.toContain("scopes");
  });

  it("your own code: 409 self, no strike, nothing written, the token stays usable", async () => {
    invite(T, CODE);
    const authToken = mint(T, { cred: "cT" });
    const res = await approve({ code: CODE, authToken, profile: "tia" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ self: true, error: "That's your own code." });
    expect(writes()).toEqual([]);
    expect(db.buckets.size).toBe(0);
    expect(tokenLive(authToken)).toBe(true);
  });

  it("a miss is the peek 404 and one strike on the client's counter; the token stays usable", async () => {
    const authToken = mint(L, { cred: "cL" });
    const res = await approve({ code: "ZZZZZZZZZZZZ", authToken });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify(MISS));
    expect(writes()).toEqual(["INSERT INTO rate_buckets"]);
    expect(strikes()).toBe(1);
    expect(tokenLive(authToken)).toBe(true);
    // A malformed code and, with the switch closed, a not-open trainer's code strike the same way.
    switchLive.value = false;
    invite(N, CODE_N);
    expect((await approve({ code: "ABC", authToken })).status).toBe(404);
    expect((await approve({ code: CODE_N, authToken })).status).toBe(404);
    expect(strikes()).toBe(3);
    expect(db.grants).toEqual([]);
  });

  it("an out-of-date page: 400 stale, no strike, nothing written", async () => {
    invite(T, CODE);
    // "2026-10" is the version before the roster rows were widened; "2026-10-04" before plan changes.
    for (const consent of [undefined, { version: "2025-01" }, "2026-10", { version: "2026-10" }, { version: "2026-10-04" }]) {
      const authToken = mint(L, { cred: "cL" });
      const res = await approve({ code: CODE, authToken, consent });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ stale: true, error: "This page is out of date. Reload and try again." });
      expect(tokenLive(authToken)).toBe(true);
    }
    expect(writes()).toEqual([]);
  });

  it("never replaces a trainer without asking: 409 replaces, then a resend with replace:true switches", async () => {
    grant("hwg_old", L, N);
    invite(T, CODE);
    const authToken = mint(L, { cred: "cL" });

    const ask = await approve({ code: CODE, authToken });
    expect(ask.status).toBe(409);
    expect(await ask.json()).toEqual({ replaces: { name: "Nia" } });
    expect(writes()).toEqual([]);
    expect(tokenLive(authToken)).toBe(true);
    expect(db.invites[0].used_at).toBeNull();
    // replace must be exactly true.
    expect((await approve({ code: CODE, authToken, replace: "yes" })).status).toBe(409);
    expect(writes()).toEqual([]);

    const res = await approve({ code: CODE, authToken, replace: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trainer: { name: "Tia" }, replaced: { name: "Nia" } });
    const old = db.grants.find((g) => g.id === "hwg_old");
    expect(old).toMatchObject({ revoked_by: "replaced" });
    expect(old.revoked_at).toBe(db.invites[0].used_at);
    expect(live(L).map((g) => g.trainer_account_id)).toEqual([T]);
    expect(tokenLive(authToken)).toBe(false);
    expect(strikes()).toBe(0);
  });

  it("a new code from the same trainer renews the share without asking", async () => {
    grant("hwg_same", L, T);
    invite(T, CODE);
    const res = await approve({ code: CODE, authToken: mint(L, { cred: "cL" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trainer: { name: "Tia" }, replaced: null });
    expect(db.grants.find((g) => g.id === "hwg_same")).toMatchObject({ revoked_by: "replaced" });
    expect(live(L)).toHaveLength(1);
    expect(live(L)[0].id).not.toBe("hwg_same");
  });

  it("a grant that appears after the check is never replaced: the index refuses, 409, all rolled back, no strike", async () => {
    invite(T, CODE);
    const authToken = mint(L, { cred: "cL" });
    beforeTxn = () => grant("hwg_racer", L, N);
    const res = await approve({ code: CODE, authToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Something changed. Try again." });
    // S1 rolled back: the code is still pending; the other grant is untouched.
    expect(db.invites[0]).toMatchObject({ used_at: null, grant_id: null });
    expect(db.grants.find((g) => g.id === "hwg_racer")).toMatchObject({ revoked_at: null, revoked_by: null });
    expect(live(L)).toHaveLength(1);
    expect(strikes()).toBe(0);
    expect(tokenLive(authToken)).toBe(true);
    expect(writes()).not.toContain("UPDATE auth_tokens SET");
  });

  it("a code used or expired between the check and the write: 404 and a strike, nothing written", async () => {
    invite(T, CODE);
    const authToken = mint(L, { cred: "cL" });
    beforeTxn = () => { db.invites[0].used_at = Date.now(); };
    const res = await approve({ code: CODE, authToken });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(MISS);
    expect(db.grants).toEqual([]);
    expect(strikes()).toBe(1);
    expect(tokenLive(authToken)).toBe(true);
  });

  it("a trainer who closed after the check: S2 and S3 write nothing, 404", async () => {
    grant("hwg_old", L, N);
    invite(T, CODE);
    beforeTxn = () => { db.accounts.get(T).deleted_at = "2026-10-03T00:00:00.000Z"; };
    const res = await approve({ code: CODE, authToken: mint(L, { cred: "cL" }), replace: true });
    expect(res.status).toBe(404);
    expect(db.grants.find((g) => g.id === "hwg_old").revoked_at).toBeNull();
    expect(db.grants).toHaveLength(1);
  });

  it("10 misses in the hour: the next try is 429 with the fresh-code copy, even with a good code", async () => {
    const authToken = mint(L, { cred: "cL" });
    for (let k = 0; k < 10; k++) expect((await approve({ code: "ZZZZZZZZZZZZ", authToken })).status).toBe(404);
    expect(strikes()).toBe(10);
    invite(T, CODE);
    calls.length = 0;
    const res = await approve({ code: CODE, authToken });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(TOO_MANY);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
    expect(writes()).toEqual([]);
    expect(db.grants).toEqual([]);
    expect(strikes()).toBe(10);
  });

  it("9 misses still let a good code through", async () => {
    const authToken = mint(L, { cred: "cL" });
    for (let k = 0; k < 9; k++) await approve({ code: "ZZZZZZZZZZZZ", authToken });
    invite(T, CODE);
    expect((await approve({ code: CODE, authToken })).status).toBe(200);
  });

  it("the counter is the signed-in client's: another client's misses do not count", async () => {
    for (let k = 0; k < 10; k++) await approve({ code: "ZZZZZZZZZZZZ", authToken: mint(M, { cred: "cM" }), profile: "mal" });
    invite(T, CODE);
    expect((await approve({ code: CODE, authToken: mint(L, { cred: "cL" }) })).status).toBe(200);
  });

  it("fails CLOSED: an unreadable counter is 503 and no grant, even with a good code", async () => {
    invite(T, CODE);
    const authToken = mint(L, { cred: "cL" });
    failOn = /FROM rate_buckets/;
    const res = await approve({ code: CODE, authToken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(db.grants).toEqual([]);
    expect(db.invites[0].used_at).toBeNull();
    expect(tokenLive(authToken)).toBe(true);
  });

  it("a strike that cannot be written is 503, not a free miss", async () => {
    const authToken = mint(L, { cred: "cL" });
    failOn = /^\s*INSERT INTO rate_buckets/;
    const res = await approve({ code: "ZZZZZZZZZZZZ", authToken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
  });

  it("the ceremony gate comes first: a failed or legacy Face ID writes nothing and strikes nothing", async () => {
    invite(T, CODE);
    const stale = await approve({ code: CODE, authToken: mint(L, { cred: "cL", ageMs: 6 * 60_000 }) });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: "Face ID didn't go through. Try again.", requiresAuth: true });
    const legacy = await approve({ code: CODE, authToken: mint(L, { cred: "cLegacy" }) });
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toEqual({ needsNativePasskey: true });
    const scoped = await approve({ code: CODE, authToken: mint(L, { cred: "cL", scope: "sync" }) });
    expect(scoped.status).toBe(401);
    const otherHandle = await approve({ code: CODE, authToken: mint(L, { cred: "cL" }), profile: "mal" });
    expect(otherHandle.status).toBe(401);
    expect(writes()).toEqual([]);
    expect(db.buckets.size).toBe(0);
  });

  it("limits: 10 a minute in memory, 20 a minute shared, per IP; the failure counter is per account", async () => {
    invite(T, CODE);
    await approve({ code: CODE, authToken: mint(L, { cred: "cL" }) });
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["share-approve", 10]);
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["share-approve", 20]);
    const read = calls.find((c) => /FROM rate_buckets/.test(c.q));
    expect(read.v).toEqual([sharedBucket("share-approve-fail", L), Math.floor(Date.now() / 3_600_000) * 3_600_000]);
  });
});

describe("the approve transaction (SQL pins)", () => {
  it("three statements in order; S2 and S3 run only on the stamped grant id; S2 ends only the grant it is given", async () => {
    grant("hwg_old", L, N);
    invite(T, CODE);
    await approve({ code: CODE, authToken: mint(L, { cred: "cL" }), replace: true });
    const [s1, s2, s3] = calls.filter((c) => /^\s*(UPDATE trainer_invites|UPDATE oauth_grants|INSERT INTO oauth_grants)/.test(c.q));
    const gid = db.grants[1].id;
    const now = db.grants[1].created_at;
    expect(flat(s1.q)).toBe("UPDATE trainer_invites SET used_at = ?, grant_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND trainer_account_id <> ?");
    expect(s1.v).toEqual([now, gid, hash(CODE), now, L]);
    expect(flat(s2.q)).toBe(
      "UPDATE oauth_grants SET revoked_at = ?, revoked_by = 'replaced' WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL AND id = ? " +
      "AND EXISTS (SELECT 1 FROM trainer_invites i JOIN accounts t ON t.id = i.trainer_account_id AND t.deleted_at IS NULL WHERE i.grant_id = ?)",
    );
    expect(s2.v).toEqual([now, L, "hwg_old", gid]);
    expect(flat(s3.q)).toBe(
      "INSERT INTO oauth_grants (id, client_id, account_id, profile, credential_id, scope, created_at, kind, resource, expires_at, trainer_account_id, consent_version, looks, look_count, edits_at) " +
      "SELECT ?, 'hw:trainer', ?, ?, ?, 'trainer:read', ?, 'trainer', ?, NULL, i.trainer_account_id, ?, '[]'::jsonb, 0, ? " +
      "FROM trainer_invites i JOIN accounts t ON t.id = i.trainer_account_id AND t.deleted_at IS NULL WHERE i.grant_id = ? RETURNING id",
    );
    expect(s3.v).toEqual([gid, L, "leo", "cL", now, TRAINER_RESOURCE, SHARE_CONSENT_VERSION, now, gid]);
  });

  it("with no current grant, S2 is given null and so ends nothing", async () => {
    invite(T, CODE);
    await approve({ code: CODE, authToken: mint(L, { cred: "cL" }) });
    const s2 = calls.find((c) => /^\s*UPDATE oauth_grants/.test(c.q));
    expect(s2.v[2]).toBeNull();
  });

  it("the peek SELECT joins only open trainer accounts and pending codes", async () => {
    invite(T, CODE);
    await peek(CODE);
    const sel = calls.find((c) => /FROM trainer_invites i JOIN accounts a/.test(c.q));
    expect(flat(sel.q)).toBe(
      "SELECT i.trainer_account_id, i.expires_at, a.id, a.storage_key, a.roles, a.plan, a.trainer_terms " +
      "FROM trainer_invites i JOIN accounts a ON a.id = i.trainer_account_id AND a.deleted_at IS NULL " +
      "WHERE i.code_hash = ? AND i.used_at IS NULL AND i.expires_at > ?",
    );
    expect(sel.v[0]).toBe(hash(CODE));
  });

  it("the current-grant read is SELECT-only", async () => {
    invite(T, CODE);
    await approve({ code: CODE, authToken: mint(L, { cred: "cL" }) });
    const sel = calls.find((c) => /^\s*SELECT id, trainer_account_id FROM oauth_grants/.test(c.q));
    expect(flat(sel.q)).toBe("SELECT id, trainer_account_id FROM oauth_grants WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL");
    expect(sel.v).toEqual([L]);
  });
});

describe("share routes: source", () => {
  const root = resolve(__dirname, "..");
  for (const f of ["app/api/share/peek/route.js", "app/api/share/approve/route.js"]) {
    it(`${f}: lhr1, force-dynamic, no e.message, no SQL of its own`, () => {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src).toContain('export const preferredRegion = "lhr1"');
      expect(src).toContain('export const dynamic = "force-dynamic"');
      expect(src).not.toMatch(/e\.message/);
      expect(src).not.toMatch(/\bq`|\bsql\(/);
    });
  }
});
