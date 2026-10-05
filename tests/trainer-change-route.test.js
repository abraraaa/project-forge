// POST /api/trainer/change: a trainer's change set, its dry run, and taking
// one back. The Neon driver is faked with small in-memory tables that answer
// only the statements the gate, the stores and db.js's profile read send, so
// all of them run for real and every statement is captured. The only writes
// allowed: the look ring UPDATE (before any read), the change-set INSERT
// (behind its lock), the withdraw UPDATE and the gate's daily session INSERT.
// The client's meta and sessions are never written. Nothing is ever deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer "tia"
const N = id26("n"); // another trainer "nia"
const A = id26("a"); // client "abe", Tia's
const O = id26("o"); // client "oli", Nia's
const setId = (c) => "hws_" + c.repeat(26);
const S1 = setId("a");
const SQUAT = "Barbell Back Squat";
const flat = (s) => s.replace(/\s+/g, " ").trim();

const db = { tokens: new Map(), accounts: new Map(), handles: [], credentials: [], grants: [], meta: [], sessions: [], changes: [] };
const calls = [];
let failOn = null; // a regex: the matching statement throws
let logMisses = false; // the look UPDATE matches nothing

const big = (v) => (v == null ? null : String(v));
const editsOn = (g) => g.edits_at != null && (g.edits_off_at == null || g.edits_off_at < g.edits_at);
const liveGrant = (g, t) => {
  const a = db.accounts.get(g.account_id);
  return g.kind === "trainer" && g.trainer_account_id === t && g.revoked_at == null && a && a.deleted_at == null
    && db.credentials.some((c) => c.id === g.credential_id && c.account_id === g.account_id && c.rp_id === "heatwayve.app");
};
/** The budget over every grant between the client and trainer of `grant`. */
const budget = (grant, since) => {
  const r = db.grants.find((g) => g.id === grant);
  const ids = new Set(db.grants.filter((g) => r && g.account_id === r.account_id && g.trainer_account_id === r.trainer_account_id).map((g) => g.id));
  const rows = db.changes.filter((c) => ids.has(c.grant_id) && c.source === "trainer" && c.created_at > since);
  return [{ used: new Set(rows.map((c) => c.set_id)).size, oldest: rows.length ? big(Math.min(...rows.map((c) => c.created_at))) : null }];
};
const pad = (i) => String(i).padStart(2, "0");
const blank = (v) => (v === null || v === undefined ? null : v);

// The store's statements, whitespace collapsed (pinned to the SQL in tests/trainer-changes-store.test.js).
const SQL = {
  lock: "SELECT pg_advisory_xact_lock(hashtext('tc:' || ?::text || ':' || ?::text))",
  insert: "INSERT INTO trainer_changes (id, set_id, grant_id, profile, client_account_id, author_account_id, source, status, kind, target,"
    + " old_value, new_value, basis, warnings, effective_from, created_at)"
    + " SELECT ?::text || '.' || lpad((o.i - 1)::text, 2, '0'), ?::text, ?::text, ?::text, ?::text, ?::text, 'trainer', 'sent', o.op->>'kind', o.op->>'target',"
    + " NULLIF(o.op->'before', 'null'::jsonb), NULLIF(o.op->'after', 'null'::jsonb), NULLIF(o.op->'basis', 'null'::jsonb),"
    + " NULLIF(o.op->'warnings', 'null'::jsonb), o.op->>'from', ?::bigint"
    + " FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS o(op, i)"
    + " WHERE NOT EXISTS (SELECT 1 FROM trainer_changes x WHERE x.set_id = ?::text)"
    + " AND EXISTS (SELECT 1 FROM oauth_grants r WHERE r.id = ?::text AND r.account_id = ?::text AND r.trainer_account_id = ?::text)"
    + " AND (SELECT count(DISTINCT b.set_id) FROM trainer_changes b"
    + " WHERE b.grant_id IN (SELECT g.id FROM oauth_grants g WHERE g.account_id = ?::text AND g.trainer_account_id = ?::text)"
    + " AND b.source = 'trainer' AND b.created_at > ?::bigint) < ?::int"
    + " ON CONFLICT (id) DO NOTHING RETURNING id",
  seen: "SELECT EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ? AND grant_id = ? AND author_account_id = ?) AS mine,"
    + " EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ?) AS taken,"
    + " EXISTS (SELECT 1 FROM oauth_grants WHERE id = ? AND account_id = ? AND trainer_account_id = ?) AS fits,"
    + " (SELECT count(*) FROM trainer_changes WHERE set_id = ?) = jsonb_array_length(?::jsonb)"
    + " AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS o(op, i)"
    + " WHERE NOT EXISTS (SELECT 1 FROM trainer_changes t WHERE t.id = ?::text || '.' || lpad((o.i - 1)::text, 2, '0')"
    + " AND t.kind = o.op->>'kind' AND t.target = o.op->>'target'"
    + " AND t.new_value IS NOT DISTINCT FROM NULLIF(o.op->'after', 'null'::jsonb)"
    + " AND t.effective_from IS NOT DISTINCT FROM o.op->>'from')) AS same",
  budget: "SELECT count(DISTINCT set_id)::int AS used, min(created_at) AS oldest FROM trainer_changes"
    + " WHERE grant_id IN (SELECT g.id FROM oauth_grants g JOIN oauth_grants r"
    + " ON r.account_id = g.account_id AND r.trainer_account_id = g.trainer_account_id WHERE r.id = ?)"
    + " AND source = 'trainer' AND created_at > ?::bigint",
  withdraw: "UPDATE trainer_changes SET undone_at = ?, undone_by = 'trainer'"
    + " WHERE (id = ? OR set_id = ?) AND grant_id = ? AND author_account_id = ? AND undone_at IS NULL"
    + " AND (outcome IS NULL"
    + " OR (outcome = 'applied' AND kind <> 'week' AND id IN (SELECT jsonb_array_elements_text(?::jsonb)))) RETURNING id",
  openGrant: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at,"
    + " (SELECT count(*) FROM trainer_changes s WHERE s.set_id = c.set_id)::int AS set_size"
    + " FROM trainer_changes c JOIN oauth_grants g ON g.id = c.grant_id"
    + " WHERE c.grant_id = ? AND c.author_account_id = ? AND c.source = 'trainer' AND c.status = 'sent'"
    + " AND c.outcome IS NULL AND c.undone_at IS NULL AND c.created_at > COALESCE(g.edits_at, 0) ORDER BY c.created_at, c.id",
  trainerList: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at,"
    + " COALESCE(g.revoked_at IS NULL AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at)"
    + " AND c.created_at > g.edits_at, false) AS edits_live"
    + " FROM trainer_changes c LEFT JOIN oauth_grants g ON g.id = c.grant_id"
    + " WHERE c.grant_id = ? AND c.author_account_id = ? AND c.source = 'trainer' AND c.status = 'sent'"
    + " AND (c.created_at > ?::bigint OR (c.outcome IS NULL AND c.undone_at IS NULL)) ORDER BY c.created_at DESC, c.id LIMIT ?",
};
const fits = (grant, client, trainer) => db.grants.some((g) => g.id === grant && g.account_id === client && g.trainer_account_id === trainer);
const stored = (c) => ({ id: c.id, set_id: c.set_id, kind: c.kind, target: c.target, effective_from: c.effective_from ?? null,
  old_value: c.old_value ?? null, new_value: c.new_value ?? null, warnings: c.warnings ?? null, created_at: big(c.created_at),
  applied_at: c.applied_at ?? null, outcome: c.outcome ?? null, undone_at: big(c.undone_at), undone_by: c.undone_by ?? null, reverted_at: c.reverted_at ?? null });
const CHANGE_HANDLERS = {
  [flat(SQL.lock)]: () => [{ pg_advisory_xact_lock: "" }],
  [flat(SQL.insert)]: ([id1, set, grant, profile, client, author, now, ops, set2, grant2, client2, author2, client3, author3, since, cap]) => {
    expect([id1, set2, grant2, client2, author2, client3, author3]).toEqual([set, set, grant, client, author, client, author]);
    if (db.changes.some((c) => c.set_id === set)) return [];
    if (!fits(grant, client, author)) return [];
    if (budget(grant, since)[0].used >= cap) return [];
    return JSON.parse(ops).map((op, i) => {
      const id = `${set}.${pad(i)}`;
      db.changes.push({ id, set_id: set, grant_id: grant, profile, client_account_id: client, author_account_id: author,
        source: "trainer", status: "sent", kind: op.kind, target: op.target, old_value: blank(op.before), new_value: blank(op.after),
        basis: blank(op.basis), warnings: blank(op.warnings), effective_from: op.from ?? null, created_at: now,
        applied_at: null, outcome: null, undone_at: null, undone_by: null, reverted_at: null, cleared_at: null });
      return { id };
    });
  },
  [flat(SQL.seen)]: ([set, grant, author, , grant3, client3, author3, , ops]) => {
    const list = JSON.parse(ops);
    const rows = db.changes.filter((c) => c.set_id === set);
    return [{
      mine: db.changes.some((c) => c.set_id === set && c.grant_id === grant && c.author_account_id === author),
      taken: rows.length > 0,
      fits: fits(grant3, client3, author3),
      same: rows.length === list.length && list.every((o, i) => rows.some((c) => c.id === `${set}.${pad(i)}` && c.kind === o.kind
        && c.target === o.target && JSON.stringify(c.new_value ?? null) === JSON.stringify(o.after ?? null) && (c.effective_from ?? null) === (o.from ?? null))),
    }];
  },
  [flat(SQL.budget)]: ([grant, since]) => budget(grant, since),
  [flat(SQL.withdraw)]: ([now, x, x2, ref, me, inForce]) => db.changes
    .filter((c) => (c.id === x || c.set_id === x2) && c.grant_id === ref && c.author_account_id === me && c.undone_at == null
      && (c.outcome == null || (c.outcome === "applied" && c.kind !== "week" && JSON.parse(inForce).includes(c.id))))
    .map((c) => { Object.assign(c, { undone_at: now, undone_by: "trainer" }); return { id: c.id }; }),
  [flat(SQL.openGrant)]: ([ref, me]) => db.changes
    .filter((c) => {
      const g = db.grants.find((x) => x.id === c.grant_id);
      return g && c.grant_id === ref && c.author_account_id === me && c.outcome == null && c.undone_at == null
        && c.created_at > (g.edits_at ?? 0);
    })
    .map((c) => ({ ...stored(c), set_size: db.changes.filter((x) => x.set_id === c.set_id).length })),
  [flat(SQL.trainerList)]: ([ref, me, since, limit]) => db.changes
    .filter((c) => c.grant_id === ref && c.author_account_id === me && c.source === "trainer" && c.status === "sent"
      && (c.created_at > since || (c.outcome == null && c.undone_at == null)))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, limit)
    .map((c) => {
      const g = db.grants.find((x) => x.id === c.grant_id);
      return { ...stored(c), edits_live: !!g && g.revoked_at == null && editsOn(g) && c.created_at > g.edits_at };
    }),
};

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const q = async (strings, ...v) => {
      const text = strings.join("?");
      if (/^\s*(CREATE|ALTER)\b/.test(text)) return [];
      calls.push({ q: flat(text), v });
      if (failOn && failOn.test(text)) throw new Error("db down");
      const h = CHANGE_HANDLERS[flat(text)];
      if (h) return h(v);
      if (/^\s*SELECT profile, expires, scope, created_at, auth_at, credential_id, account_id FROM auth_tokens/.test(text)) {
        const r = db.tokens.get(v[0]) ?? (v[1] != null ? db.tokens.get(v[1]) : undefined);
        return r ? [{ ...r }] : [];
      }
      if (/^\s*INSERT INTO auth_tokens/.test(text)) {
        const [token, profile, expires, scope, created_at, auth_at, credential_id, account_id] = v;
        if (!db.tokens.has(token)) db.tokens.set(token, { profile, expires, scope, created_at, auth_at, credential_id, account_id });
        return [];
      }
      if (/^\s*SELECT \* FROM accounts WHERE id = \? LIMIT 1$/.test(text)) {
        const a = db.accounts.get(v[0]);
        return a ? [{ ...a }] : [];
      }
      if (/^\s*SELECT \* FROM accounts WHERE storage_key = \? LIMIT 1$/.test(text)) {
        const a = [...db.accounts.values()].find((x) => x.storage_key === v[0]);
        return a ? [{ ...a }] : [];
      }
      if (/AS cred_live/.test(text)) {
        const [cred, acct] = v;
        const a = db.accounts.get(acct);
        if (!a) return [];
        const live = db.credentials.some((c) => c.id === cred && c.account_id === a.id && c.rp_id === "heatwayve.app");
        return [{ roles: a.roles, plan: a.plan, trainer_terms: a.trainer_terms, deleted_at: a.deleted_at, cred_live: live }];
      }
      if (/^\s*SELECT handle, display FROM handles/.test(text)) {
        const h = db.handles.find((x) => x.account_id === v[0] && x.released_at == null);
        return h ? [{ handle: h.handle, display: h.display }] : [];
      }
      if (/^\s*SELECT g\.id, g\.profile, g\.scope, g\.created_at, g\.last_used_at, g\.edits_at, g\.edits_off_at, h\.handle, h\.display\s+FROM oauth_grants g/.test(text)) {
        const [t, ref] = v;
        return db.grants.filter((g) => liveGrant(g, t) && (ref === undefined || g.id === ref)).map((g) => {
          const h = db.handles.find((x) => x.account_id === g.account_id && x.released_at == null);
          return { id: g.id, profile: g.profile, scope: g.scope, created_at: big(g.created_at), last_used_at: big(g.last_used_at),
            edits_at: big(g.edits_at), edits_off_at: big(g.edits_off_at), handle: h?.handle ?? null, display: h?.display ?? null };
        });
      }
      if (/^\s*UPDATE oauth_grants SET\s+looks = CASE/.test(text)) {
        if (logMisses) return [];
        const now = v[0];
        const [ref, t] = v.slice(-2);
        const g = db.grants.find((x) => x.id === ref && x.kind === "trainer" && x.trainer_account_id === t && x.revoked_at == null);
        if (!g) return [];
        g.looks = [{ k: "v", at: now }, ...(g.looks ?? [])].slice(0, 20);
        return [{ id: g.id }];
      }
      if (/^\s*SELECT now\(\) AS t$/.test(text)) return [{ t: new Date() }];
      if (/^\s*SELECT field, value FROM meta WHERE profile = \?$/.test(text)) {
        return db.meta.filter((m) => m.profile === v[0]).map(({ field, value }) => ({ field, value }));
      }
      if (/^\s*SELECT record FROM sessions WHERE profile = \? ORDER BY id$/.test(text)) {
        return db.sessions.filter((s) => s.profile === v[0]).map((s) => ({ record: s.record }));
      }
      throw new Error(`unexpected SQL: ${flat(text)}`);
    };
    q.transaction = async (list) => Promise.all(list);
    return q;
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));
// Real implementations, wrapped so one test can make a store answer null or a
// closed account (branches the fake tables can't reach).
vi.mock("@/lib/trainer-changes-store", async (importOriginal) => {
  const m = /** @type {any} */ (await importOriginal());
  return { ...m, dbOpenChangesForGrant: vi.fn(m.dbOpenChangesForGrant) };
});
vi.mock("@/lib/identity-store", async (importOriginal) => {
  const m = /** @type {any} */ (await importOriginal());
  return { ...m, dbAccountByStorageKey: vi.fn(m.dbAccountByStorageKey) };
});

const { POST } = await import("@/app/api/trainer/change/route");
const { TRAINER_COOKIE, faceIdFresh, FACE_ID_WRITE_MS } = await import("@/lib/trainer-session");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { liftBasis } = await import("@/lib/trainer-change");
const { rateLimit, rateLimitShared } = await import("@/lib/rate-limit");
const { dbOpenChangesForGrant } = await import("@/lib/trainer-changes-store");
const { dbAccountByStorageKey } = await import("@/lib/identity-store");

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, sk, roles, trainer_terms = null) => ({
  id, storage_key: sk, webauthn_user_id: "u-" + sk, roles, plan: "free", consent: null, trainer_terms,
  origin: "claim", created_at: null, lapsed_at: null, deleted_at: null,
});
let seq = 0;
/** A trainer session; authAgeMs is how long ago its Face ID was. */
const session = (acct, cred, { ageMs = 60_000, authAgeMs = ageMs } = {}) => {
  const token = `tok-${++seq}`;
  db.tokens.set(hash(token), {
    profile: db.accounts.get(acct).storage_key, expires: Date.now() + 14 * DAY - ageMs, scope: "trainer",
    created_at: new Date(Date.now() - ageMs).toISOString(), auth_at: new Date(Date.now() - authAgeMs).toISOString(),
    credential_id: cred, account_id: acct,
  });
  return token;
};
const grant = (id, client, trainer, cred, extra = {}) => ({
  id, account_id: client, profile: db.accounts.get(client).storage_key, credential_id: cred, scope: "trainer:read",
  kind: "trainer", trainer_account_id: trainer, created_at: Date.now() - 30 * DAY, revoked_at: null, looks: [],
  last_used_at: null, edits_at: Date.now() - 20 * DAY, edits_off_at: null, ...extra,
});

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const squatRecord = (date, kg) => ({
  id: `${date}T09:00:00.000Z`, date, schemaVersion: 3, readiness: "fresh", session: "strength-a",
  blocks: [{ type: "main", exercises: [{ name: SQUAT, loadType: "barbell", prescribed: { weight: kg, reps: 5 },
    sets: [1, 2, 3].map(() => ({ weight: kg, reps: 5, rir: 2, loadType: "barbell" })) }] }],
});

const writes = () => calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/.test(c.q));
const dataReads = () => calls.filter((c) => /FROM (meta|sessions)\b/.test(c.q));
const grantReads = () => calls.filter((c) => /FROM oauth_grants g/.test(c.q) && /^SELECT g\.id/.test(c.q));
const inserts = () => calls.filter((c) => /^INSERT INTO trainer_changes/.test(c.q));
const looks = () => calls.filter((c) => /^UPDATE oauth_grants SET looks/.test(c.q));
const URL_BASE = "https://heatwayve.app/api/trainer/change";
const post = (token, body) => POST(new NextRequest(URL_BASE, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { cookie: `${TRAINER_COOKIE}=${token}` } : {}) },
  body: JSON.stringify(body),
}));

/** What Tia's pane showed for Abe's squat, from the same profile the route reads. */
const basis = () => {
  const meta = Object.fromEntries(db.meta.filter((m) => m.profile === "sk-abe").map((m) => [m.field, m.value]));
  const history = db.sessions.filter((s) => s.profile === "sk-abe").map((s) => s.record);
  return { lifts: { [SQUAT]: liftBasis(SQUAT, { meta, history, todayIso: TODAY }) }, mains: {}, week: {} };
};
const body = (set = S1, kg = 105, extra = {}) => ({
  ref: "hwg_abe", today: TODAY, set: { id: set, ops: [{ kind: "weight", lift: SQUAT, kg }] }, basis: basis(), ...extra,
});

let tia;
beforeEach(() => {
  calls.length = 0;
  failOn = null;
  logMisses = false;
  db.tokens.clear();
  db.accounts = new Map([
    [T, account(T, "tia", ["lifter", "trainer"], CURRENT)],
    [N, account(N, "nia", ["lifter", "trainer"], CURRENT)],
    [A, account(A, "sk-abe", ["lifter"])],
    [O, account(O, "sk-oli", ["lifter"])],
  ]);
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T, released_at: null },
    { handle: "nia", display: "Nia", account_id: N, released_at: null },
    { handle: "abe", display: "Abe", account_id: A, released_at: null },
    { handle: "oli", display: "Oli", account_id: O, released_at: null },
  ];
  db.credentials = [
    { id: "cT", account_id: T, rp_id: "heatwayve.app" },
    { id: "cN", account_id: N, rp_id: "heatwayve.app" },
    { id: "cA", account_id: A, rp_id: "heatwayve.app" },
    { id: "cO", account_id: O, rp_id: "heatwayve.app" },
  ];
  db.grants = [grant("hwg_abe", A, T, "cA"), grant("hwg_oli", O, N, "cO")];
  db.meta = [{ profile: "sk-abe", field: "weights", value: { [SQUAT]: 100 } }];
  db.sessions = [{ profile: "sk-abe", record: squatRecord(daysAgo(2), 100) }];
  db.changes = [];
  process.env.DATABASE_URL = "postgres://fake";
  vi.mocked(rateLimit).mockClear();
  vi.mocked(rateLimit).mockImplementation(() => null);
  vi.mocked(rateLimitShared).mockClear();
  vi.mocked(dbOpenChangesForGrant).mockReset();
  vi.mocked(dbAccountByStorageKey).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  tia = session(T, "cT");
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("faceIdFresh", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  it("a Face ID under 24 hours old is fresh; 24 hours and older is not", () => {
    expect(FACE_ID_WRITE_MS).toBe(DAY);
    expect(faceIdFresh(new Date(now - 23 * HOUR).toISOString(), now)).toBe(true);
    expect(faceIdFresh(new Date(now - DAY + 1000).toISOString(), now)).toBe(true);
    expect(faceIdFresh(new Date(now - DAY).toISOString(), now)).toBe(false);
    expect(faceIdFresh(new Date(now - 25 * HOUR).toISOString(), now)).toBe(false);
  });
  it("a missing, unreadable or future instant is not fresh", () => {
    for (const v of [null, undefined, "", "yesterday", 123]) expect(faceIdFresh(/** @type {any} */ (v), now), String(v)).toBe(false);
    expect(faceIdFresh(new Date(now + 10 * 60_000).toISOString(), now)).toBe(false);
  });
});

describe("gates, in order", () => {
  it("the per-IP limit comes first: 10 a minute, and nothing else runs when it trips", async () => {
    vi.mocked(rateLimit).mockImplementation(() => /** @type {any} */ (Response.json({ error: "Too many requests" }, { status: 429 })));
    const res = await post(tia, body());
    expect(res.status).toBe(429);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-change", 10]);
    expect(calls).toEqual([]);
  });

  it("no trainer cookie: 401 and no grant is read", async () => {
    const res = await post(null, body());
    expect(res.status).toBe(401);
    expect(grantReads()).toEqual([]);
  });

  it("authAt 25 h old gets 403", async () => {
    const stale = session(T, "cT", { ageMs: 60_000, authAgeMs: 25 * HOUR });
    const res = await post(stale, body());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ needsFaceId: true });
    expect(grantReads()).toEqual([]);
    expect(writes()).toEqual([]);
    // 23 hours is within the window.
    const fresh = session(T, "cT", { ageMs: 60_000, authAgeMs: 23 * HOUR });
    expect((await post(fresh, body())).status).toBe(200);
  });

  it("the slide never refreshes the Face ID: a two-day-old session slid this morning still needs one", async () => {
    const slid = session(T, "cT", { ageMs: 2 * HOUR, authAgeMs: 2 * DAY });
    const res = await post(slid, body());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ needsFaceId: true });
  });

  it("SELF_REF, a missing ref and an oversized ref are 404 before any grant read", async () => {
    for (const ref of ["me", undefined, 7, "x".repeat(129)]) {
      const res = await post(tia, { ...body(), ref });
      expect(res.status, String(ref)).toBe(404);
      expect(await res.json()).toEqual({ error: "Not shared with you now." });
    }
    expect(grantReads()).toEqual([]);
    expect(vi.mocked(rateLimitShared)).not.toHaveBeenCalled();
  });

  it("the per-grant burst guard: 200 a day, keyed by the grant", async () => {
    await post(tia, body());
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["trainer-change", 200, { windowMs: DAY, id: "hwg_abe" }]);
  });

  it("another trainer's client, or an unknown grant, is 404 with no look and no read", async () => {
    for (const ref of ["hwg_oli", "hwg_nope"]) {
      const res = await post(tia, { ...body(), ref });
      expect(res.status, ref).toBe(404);
    }
    expect(looks()).toEqual([]);
    expect(dataReads()).toEqual([]);
  });

  it("edits_off grant gets 403", async () => {
    db.grants[0].edits_off_at = db.grants[0].edits_at + 1;
    let res = await post(tia, body());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ editsOff: true });
    // Changes never turned on (a grant from before the consent included them).
    db.grants[0].edits_at = null;
    db.grants[0].edits_off_at = null;
    res = await post(tia, body());
    expect(res.status).toBe(403);
    expect(looks()).toEqual([]);
    expect(dataReads()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("look-log failure reads nothing", async () => {
    failOn = /^\s*UPDATE oauth_grants SET\s+looks/;
    let res = await post(tia, body());
    expect(res.status).toBe(503);
    expect(dataReads()).toEqual([]);
    expect(inserts()).toEqual([]);
    failOn = null;
    // The grant ended between the read and the log: not shared, nothing read.
    logMisses = true;
    res = await post(tia, body());
    expect(res.status).toBe(404);
    expect(dataReads()).toEqual([]);
    expect(inserts()).toEqual([]);
  });
});

describe("dry run and send", () => {
  it("a dryRun issues no INSERT: the look is its only write", async () => {
    const res = await post(tia, body(S1, 105, { dryRun: true }));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toEqual({
      preview: { ops: [{ i: 0, kind: "weight", target: SQUAT, from: null, before: 100, after: 105, warnings: [] }], warnings: [] },
      budget: { used: 0, of: 10, freeAt: null },
    });
    expect(JSON.stringify(out)).not.toMatch(/anchorId|trainedId|basis/);
    expect(writes().map((c) => c.q.slice(0, 29))).toEqual(["UPDATE oauth_grants SET looks"]);
    expect(db.changes).toEqual([]);
  });

  it("logs the look, then reads the client's profile, then INSERTs one row per change with the server's own basis", async () => {
    const res = await post(tia, body());
    expect(res.status).toBe(200);
    // The first set in the window frees up a week after it was sent.
    expect(await res.json()).toEqual({ sent: { set: S1, ids: [`${S1}.00`] }, budget: { used: 1, of: 10, freeAt: db.changes[0].created_at + 7 * DAY } });
    const order = calls.map((c) => c.q);
    const at = (re) => order.findIndex((q) => re.test(q));
    expect(at(/^UPDATE oauth_grants SET looks/)).toBeGreaterThan(at(/^SELECT g\.id/));
    expect(at(/FROM meta WHERE/)).toBeGreaterThan(at(/^UPDATE oauth_grants SET looks/));
    expect(at(/^INSERT INTO trainer_changes/)).toBeGreaterThan(at(/FROM meta WHERE/));
    expect(db.changes).toHaveLength(1);
    expect(db.changes[0]).toMatchObject({
      id: `${S1}.00`, set_id: S1, grant_id: "hwg_abe", profile: "sk-abe", client_account_id: A, author_account_id: T,
      source: "trainer", status: "sent", kind: "weight", target: SQUAT, old_value: 100, new_value: 105, warnings: null,
      basis: { anchorId: `${daysAgo(2)}T09:00:00.000Z`, w: 100 },
    });
  });

  it("zero writes to the client's meta or sessions, whatever the request", async () => {
    await post(tia, body(S1, 105, { dryRun: true }));
    await post(tia, body());
    await post(tia, body());
    await post(tia, { ref: "hwg_abe", withdraw: S1 });
    await post(tia, body(setId("b"), 200));
    for (const w of writes()) {
      expect(w.q, w.q).toMatch(/^(UPDATE oauth_grants SET looks|INSERT INTO trainer_changes|UPDATE trainer_changes SET undone_at|INSERT INTO auth_tokens)/);
    }
    expect(calls.some((c) => /\b(meta|sessions)\b/.test(c.q) && /^(INSERT|UPDATE|DELETE)/.test(c.q))).toBe(false);
  });

  it("an idempotent replay writes one set", async () => {
    expect((await post(tia, body())).status).toBe(200);
    const again = await post(tia, body());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ sent: { set: S1, ids: [] }, replay: true });
    expect(db.changes).toHaveLength(1);
    expect(new Set(db.changes.map((c) => c.set_id)).size).toBe(1);
  });

  it("a set id another grant already used is refused, never merged", async () => {
    db.changes.push({ id: `${S1}.00`, set_id: S1, grant_id: "hwg_oli", author_account_id: N, source: "trainer", created_at: Date.now() - DAY });
    const res = await post(tia, body());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ taken: true });
    expect(db.changes).toHaveLength(1);
  });

  it("11th set refused; dryRun not counted", async () => {
    const letters = "bcdefghijk";
    for (const c of "lmn") expect((await post(tia, body(setId(c), 105, { dryRun: true }))).status).toBe(200);
    for (const c of letters) expect((await post(tia, body(setId(c)))).status, c).toBe(200);
    expect(new Set(db.changes.map((c) => c.set_id)).size).toBe(10);
    const dry = await post(tia, body(setId("o"), 105, { dryRun: true }));
    expect((await dry.json()).budget).toMatchObject({ used: 10, of: 10 });
    const res = await post(tia, body(setId("p")));
    expect(res.status).toBe(429);
    const out = await res.json();
    expect(out.budget).toMatchObject({ used: 10, of: 10 });
    expect(out.budget.freeAt).toBe(Math.min(...db.changes.map((c) => c.created_at)) + 7 * DAY);
    // The UTC day freeAt falls on, as en-GB writes it ("Wed 9 Sept" in September).
    const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
      .format(new Date(out.budget.freeAt));
    expect(out.error).toBe(`That's this week's changes for Abe. More from ${day}.`);
    expect(db.changes.some((c) => c.set_id === setId("p"))).toBe(false);
    // Withdrawn sets still count.
    await post(tia, { ref: "hwg_abe", withdraw: setId("b") });
    expect((await post(tia, body(setId("q")))).status).toBe(429);
  });

  it("at most 16 changes in a set: a 17th is refused and nothing is written", async () => {
    const ops = Array.from({ length: 17 }, () => ({ kind: "weight", lift: SQUAT, kg: 105 }));
    const res = await post(tia, { ...body(), set: { id: S1, ops } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ refusals: [{ i: null, code: "set_size" }] });
    expect(inserts()).toEqual([]);
  });

  it("a refusal is 422 with its codes, and writes nothing but the look", async () => {
    const res = await post(tia, body(S1, 112.5)); // past +10% / two steps on a 100 kg squat
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ refusals: [{ i: 0, code: "per_change" }] });
    expect(inserts()).toEqual([]);
    expect((await post(tia, { ...body(), set: { id: "nope", ops: [] } })).status).toBe(422);
    expect((await post(tia, { ref: "hwg_abe", today: TODAY })).status).toBe(422);
    expect(inserts()).toEqual([]);
  });

  it("a stale basis is 409, and nothing is written", async () => {
    const stale = body();
    stale.basis.lifts[SQUAT].w = 95;
    const res = await post(tia, stale);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ stale: true, error: "They've trained or changed it since you looked. Refresh." });
    expect(inserts()).toEqual([]);
  });

  it("the budget is read from the log: if it can't be, nothing is written", async () => {
    failOn = /count\(DISTINCT set_id\)::int AS used/;
    const res = await post(tia, body());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(inserts()).toEqual([]);
    expect(db.changes).toEqual([]);
  });

  it("only a missing or false dryRun sends: any other value previews and writes no change", async () => {
    for (const dryRun of ["true", 1, "yes", null, 0, "", {}]) {
      const res = await post(tia, body(S1, 105, { dryRun }));
      expect(res.status, JSON.stringify(dryRun)).toBe(200);
      expect(await res.json(), JSON.stringify(dryRun)).toHaveProperty("preview");
    }
    expect(inserts()).toEqual([]);
    const res = await post(tia, body(S1, 105, { dryRun: false }));
    expect(await res.json()).toMatchObject({ sent: { set: S1, ids: [`${S1}.00`] } });
  });

  it("a resent set still waiting is a replay, even after the client has trained", async () => {
    expect((await post(tia, body())).status).toBe(200);
    const next = body(setId("b")); // a new set, drafted against the same view
    db.sessions.push({ profile: "sk-abe", record: squatRecord(daysAgo(0), 102.5) });
    const again = await post(tia, body());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ sent: { set: S1, ids: [] }, replay: true, budget: { used: 1, of: 10, freeAt: db.changes[0].created_at + 7 * DAY } });
    expect(inserts()).toHaveLength(1);
    // A new set against the old view is stale.
    expect((await post(tia, next)).status).toBe(409);
  });

  it("no data for the client on the server: stale, and nothing is written", async () => {
    const b0 = body();
    db.meta = [];
    db.sessions = [];
    for (const extra of [{}, { dryRun: true }]) {
      const res = await post(tia, { ...b0, ...extra });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ stale: true });
    }
    expect(inserts()).toEqual([]);
  });

  it("no budget count: 503, and nothing is written", async () => {
    vi.mocked(dbOpenChangesForGrant).mockResolvedValueOnce(null);
    const res = await post(tia, body());
    expect(res.status).toBe(503);
    expect(inserts()).toEqual([]);
  });

  it("the client's account closed between the reads: not shared, and nothing is written", async () => {
    const real = await vi.importActual("@/lib/identity-store");
    vi.mocked(dbAccountByStorageKey).mockImplementationOnce(async (sk) => {
      const a = await /** @type {any} */ (real).dbAccountByStorageKey(sk);
      return a && { ...a, deletedAt: Date.now() };
    });
    const res = await post(tia, body());
    expect(res.status).toBe(404);
    expect(inserts()).toEqual([]);
  });

  it("a note sent in the body is ignored", async () => {
    await post(tia, { ...body(), note: "eat more", set: { id: S1, ops: [{ kind: "weight", lift: SQUAT, kg: 105, note: "x" }] } });
    expect(JSON.stringify(db.changes)).not.toMatch(/eat more|"note"/);
  });
});

describe("replays", () => {
  it("a resend of a waiting set with other changes is 409 replay_mismatch and writes nothing, even after they trained", async () => {
    expect((await post(tia, body())).status).toBe(200);
    const extra = { kind: "weight", lift: SQUAT, kg: 105, from: TODAY };
    db.sessions.push({ profile: "sk-abe", record: squatRecord(daysAgo(0), 102.5) });
    for (const set of [
      { id: S1, ops: [{ kind: "weight", lift: SQUAT, kg: 102.5 }] },
      { id: S1, ops: [{ kind: "weight", lift: SQUAT, kg: 105 }, extra] },
      { id: S1, ops: [{ kind: "reps", lift: SQUAT, reps: 105 }] },
      { id: S1, ops: [] },
      { id: S1 },
    ]) {
      const res = await post(tia, { ...body(), set });
      expect(res.status, JSON.stringify(set)).toBe(409);
      expect(await res.json()).toEqual({ error: "That didn't send. Try again.", code: "replay_mismatch" });
    }
    // The same changes still read as a replay.
    expect(await (await post(tia, body())).json()).toMatchObject({ replay: true });
    expect(inserts()).toHaveLength(1);
    expect(db.changes.map((c) => [c.id, c.new_value])).toEqual([[`${S1}.00`, 105]]);
  });

  it("a set that has landed, resent with other changes, is a mismatch from the store; the same changes are a replay", async () => {
    expect((await post(tia, body())).status).toBe(200);
    Object.assign(db.changes[0], { outcome: "applied", applied_at: new Date().toISOString() });
    const res = await post(tia, body(S1, 102.5));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "replay_mismatch" });
    expect(await (await post(tia, body(S1, 105))).json()).toMatchObject({ sent: { set: S1, ids: [] }, replay: true });
    expect(db.changes).toHaveLength(1);
  });

  it("a dry run never answers as a replay: it previews, whatever was sent under that id", async () => {
    expect((await post(tia, body())).status).toBe(200);
    for (const kg of [105, 102.5]) {
      const res = await post(tia, body(S1, kg, { dryRun: true }));
      expect(res.status, String(kg)).toBe(200);
      const out = await res.json();
      expect(out, String(kg)).not.toHaveProperty("replay");
      expect(out.preview.ops[0]).toMatchObject({ after: kg });
    }
    expect(inserts()).toHaveLength(1);
  });
});

describe("store failures", () => {
  it("a thrown profile read is a labelled 503, and nothing is written", async () => {
    failOn = /FROM meta WHERE/;
    for (const extra of [{}, { dryRun: true }]) {
      const res = await post(tia, body(S1, 105, extra));
      expect(res.status, JSON.stringify(extra)).toBe(503);
      expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
    }
    expect(vi.mocked(console.error)).toHaveBeenCalledWith("[forge:trainer-change]", expect.stringContaining("db down"));
    expect(inserts()).toEqual([]);
  });

  it("a thrown budget read is a labelled 503, and nothing is written", async () => {
    failOn = /count\(DISTINCT set_id\)::int AS used/;
    const res = await post(tia, body());
    expect(res.status).toBe(503);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith("[forge:trainer-change]", expect.stringContaining("db down"));
    expect(inserts()).toEqual([]);
  });
});

describe("withdraw", () => {
  it("is author-only, reads nothing of the client's and logs no look", async () => {
    await post(tia, body());
    calls.length = 0;
    // Nia, through her own grant, cannot take back Tia's set.
    const nia = session(N, "cN");
    const other = await post(nia, { ref: "hwg_oli", withdraw: S1 });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ withdrawn: [] });
    expect(db.changes[0].undone_at).toBe(null);
    // Nor through Tia's grant.
    expect((await post(nia, { ref: "hwg_abe", withdraw: S1 })).status).toBe(404);
    const res = await post(tia, { ref: "hwg_abe", withdraw: S1 });
    expect(await res.json()).toEqual({ withdrawn: [`${S1}.00`] });
    expect(db.changes[0]).toMatchObject({ undone_by: "trainer" });
    expect(looks()).toEqual([]);
    expect(dataReads()).toEqual([]);
    // Again: nothing more to take back.
    expect(await (await post(tia, { ref: "hwg_abe", withdraw: `${S1}.00` })).json()).toEqual({ withdrawn: [] });
  });

  it("runs behind the same gates: Face ID, grant, changes on", async () => {
    await post(tia, body());
    const stale = session(T, "cT", { authAgeMs: 25 * HOUR });
    expect((await post(stale, { ref: "hwg_abe", withdraw: S1 })).status).toBe(403);
    db.grants[0].edits_off_at = db.grants[0].edits_at + 1;
    expect(await (await post(tia, { ref: "hwg_abe", withdraw: S1 })).json()).toEqual({ editsOff: true });
    expect(db.changes[0].undone_at).toBe(null);
  });

  describe("a change that landed", () => {
    const BENCH = "Barbell Bench Press";
    const DEAD = "Conventional Deadlift";
    const landedAt = () => `${daysAgo(1)}T08:00:00.000Z`;
    const liftRecord = (date, name, kg) => ({
      id: `${date}T10:00:00.000Z`, date, schemaVersion: 3, readiness: "fresh", session: "strength-b",
      blocks: [{ type: "main", exercises: [{ name, loadType: "barbell", prescribed: { weight: kg, reps: 5 },
        sets: [1, 2, 3].map(() => ({ weight: kg, reps: 5, rir: 2, loadType: "barbell" })) }] }],
    });
    const change = (i, extra) => ({ id: `${S1}.${pad(i)}`, set_id: S1, grant_id: "hwg_abe", profile: "sk-abe", client_account_id: A,
      author_account_id: T, source: "trainer", status: "sent", kind: "weight", target: SQUAT, old_value: 100, new_value: 105,
      basis: null, warnings: null, effective_from: null, created_at: Date.now() - 2 * DAY, applied_at: landedAt(), outcome: "applied",
      undone_at: null, undone_by: null, reverted_at: null, cleared_at: null, ...extra });
    beforeEach(() => {
      db.meta = [{ profile: "sk-abe", field: "weights", value: { [SQUAT]: 105, [DEAD]: 140, [BENCH]: 82.5 } }];
      db.sessions = [{ profile: "sk-abe", record: squatRecord(daysAgo(3), 100) }, { profile: "sk-abe", record: liftRecord(daysAgo(0), BENCH, 82.5) }];
      db.changes = [
        change(0, {}), // in force: still 105, not trained since
        change(1, { target: DEAD, old_value: 135, new_value: 145 }), // changed since: they set 140
        change(2, { target: BENCH, old_value: 80, new_value: 82.5 }), // trained at: today's bench was 82.5
        change(3, { target: SQUAT, kind: "reps", old_value: 5, new_value: 6, outcome: null, applied_at: null }), // still waiting
      ];
    });

    it("goes back only while in force; the look is logged before their profile is read", async () => {
      const res = await post(tia, { ref: "hwg_abe", withdraw: S1, today: TODAY });
      expect(await res.json()).toEqual({ withdrawn: [`${S1}.00`, `${S1}.03`] });
      expect(db.changes.map((c) => c.undone_by)).toEqual(["trainer", null, null, "trainer"]);
      const order = calls.map((c) => c.q);
      const at = (re) => order.findIndex((q) => re.test(q));
      expect(looks()).toHaveLength(1);
      expect(at(/FROM meta WHERE/)).toBeGreaterThan(at(/^UPDATE oauth_grants SET looks/));
      expect(at(/^UPDATE trainer_changes SET undone_at/)).toBeGreaterThan(at(/FROM sessions WHERE/));
      expect(calls.find((c) => /^UPDATE trainer_changes/.test(c.q)).v.at(-1)).toBe(JSON.stringify([`${S1}.00`]));
    });

    it("by change id: one trained at or changed since stays, and says nothing was taken back", async () => {
      for (const i of [1, 2]) {
        expect(await (await post(tia, { ref: "hwg_abe", withdraw: `${S1}.${pad(i)}` })).json()).toEqual({ withdrawn: [] });
      }
      expect(await (await post(tia, { ref: "hwg_abe", withdraw: `${S1}.00` })).json()).toEqual({ withdrawn: [`${S1}.00`] });
    });

    it("if the look can't be logged, or their profile can't be read, nothing is taken back", async () => {
      failOn = /^\s*UPDATE oauth_grants SET\s+looks/;
      expect((await post(tia, { ref: "hwg_abe", withdraw: S1 })).status).toBe(503);
      expect(dataReads()).toEqual([]);
      failOn = null;
      logMisses = true;
      expect((await post(tia, { ref: "hwg_abe", withdraw: S1 })).status).toBe(404);
      expect(dataReads()).toEqual([]);
      logMisses = false;
      failOn = /FROM meta WHERE/;
      const res = await post(tia, { ref: "hwg_abe", withdraw: S1 });
      expect(res.status).toBe(503);
      expect(vi.mocked(console.error)).toHaveBeenCalledWith("[forge:trainer-change]", expect.stringContaining("db down"));
      expect(db.changes.every((c) => c.undone_at == null)).toBe(true);
      expect(calls.filter((c) => /^UPDATE trainer_changes/.test(c.q))).toEqual([]);
    });
  });

  it("a malformed withdraw is 400 and writes nothing", async () => {
    for (const withdraw of [7, "", "x".repeat(65), null]) {
      expect((await post(tia, { ref: "hwg_abe", withdraw })).status, String(withdraw)).toBe(400);
    }
    expect(writes()).toEqual([]);
  });
});

describe("source pins", () => {
  const src = readFileSync(resolve(__dirname, "..", "app/api/trainer/change/route.js"), "utf8");
  const inOrder = (text, order) => {
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  };
  it("gates in the spec's order, the look before any read of theirs on both paths, and the INSERT last", () => {
    const post = src.slice(src.indexOf("export async function POST"));
    inOrder(post, ["rateLimit(request", "await trainerGate(", "faceIdFresh(", "!== SELF_REF", "await rateLimitShared(",
      "await dbTrainerGrants(", 'if ("withdraw" in b)']);
    const withdraw = post.slice(post.indexOf('if ("withdraw" in b)'), post.indexOf("await dbWithdrawChanges("));
    inOrder(withdraw, ["await dbChangesForTrainer(", "if (landed.length)", "await logLook(", "dbReadProfile(", "changeStatus("]);
    const send = post.slice(post.indexOf("await dbWithdrawChanges("));
    inOrder(send, ["await logLook(", "dbReadProfile(", "validateChangeSet(", "await dbInsertChangeSet("]);
    // Exactly two reads of the profile, each straight after its look.
    expect(post.match(/dbReadProfile\(/g)).toHaveLength(2);
    expect(post.match(/await logLook\(ref, me, now\);\n\s+if \(failed\) return slid\(g, failed\);/g)).toHaveLength(2);
    // The look helper logs, and answers 503 or 404 when it can't.
    const helper = src.slice(src.indexOf("async function logLook"), src.indexOf("export async function POST"));
    expect(helper).toContain("logged = await dbLogFullLook(ref, me, now);");
    expect(helper).toContain('if (logged === null) return unavailable(new Error("look log unavailable"));');
    expect(helper).toContain("return logged ? null : notShared();");
  });
  it("never writes client data, never queries directly, never deletes", () => {
    expect(src).not.toMatch(/dbUpsertMetaFields|dbUpsertProfile|dbInsertRecords|@\/lib\/storage|\bq`|\bsql\(|\bDELETE\b|\bdel\(/);
  });
});
