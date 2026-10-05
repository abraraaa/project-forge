// The home dot (/api/sync/notices): a derived read of rows that already exist
// against each account's seen mark. The Neon driver is faked with small
// in-memory tables, so lib/notices.js, the routes and the gate's token checks
// run for real and every statement is captured. Sign-in is faked at
// readTokenData / resolveTokenIdentity. The GET writes nothing; the one write
// is the mark, an upsert overwritten in place, from the bug list and the roster.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86400000;
const NOW = Date.now();
const id26 = (c) => "hwa_" + c.repeat(26);
const A = id26("a"); // a lifter, "abe"
const T = id26("t"); // trainer "tia"
const N = id26("n"); // trainer "nia"
const Z = id26("z"); // "zed", the admin in most tests
const C = id26("c"); // client "cara"
const X = id26("x"); // client whose account closed
const P = id26("p"); // client whose approving passkey is not native
const O = id26("o"); // client of the other trainer

const db = { accounts: new Map(), credentials: [], grants: [], sessions: [], bugs: [], applications: new Map(), marks: new Map(), changes: [] };
const calls = [];
let failOn = null;
const flat = (s) => s.replace(/\s+/g, " ").trim();
const ms = (t) => (typeof t === "number" ? t : Date.parse(t));

// The statements, pinned. The fake answers only these, by hand.
const LIVE = "FROM oauth_grants g"
  + " JOIN accounts a ON a.id = g.account_id AND a.deleted_at IS NULL"
  + " JOIN credentials c ON c.id = g.credential_id AND c.account_id = g.account_id AND c.rp_id = 'heatwayve.app'";
const SQL = {
  bugs: "SELECT count(*)::int AS n FROM bug_reports WHERE status = 'new'"
    + " AND created_at > to_timestamp(COALESCE((SELECT m.seen_at FROM notice_marks m WHERE m.account_id = ? AND m.kind = 'bugs'), 0) / 1000.0)",
  applications: "SELECT count(*)::int AS n FROM trainer_applications ta"
    + " JOIN accounts a ON a.id = ta.account_id AND a.deleted_at IS NULL WHERE ta.status = 'applied'",
  application: "SELECT status FROM trainer_applications WHERE account_id = ? AND status IN ('approved', 'denied') AND seen_at IS NULL",
  clients: `SELECT EXISTS (SELECT 1 ${LIVE}`
    + " WHERE g.kind = 'trainer' AND g.trainer_account_id = ? AND g.revoked_at IS NULL"
    + " AND EXISTS (SELECT 1 FROM sessions s WHERE s.profile = g.profile"
    + " AND s.updated_at > to_timestamp(GREATEST(COALESCE((SELECT m.seen_at FROM notice_marks m WHERE m.account_id = ? AND m.kind = 'clients'), 0), g.created_at) / 1000.0)"
    + " AND s.record->>'date' BETWEEN ? AND ?)) AS lit",
  trainerChange: "SELECT count(DISTINCT set_id)::int AS n FROM trainer_changes"
    + " WHERE client_account_id = ? AND source = 'trainer' AND status = 'sent' AND undone_at IS NULL"
    + " AND created_at > COALESCE((SELECT m.seen_at FROM notice_marks m WHERE m.account_id = ? AND m.kind = 'trainerChange'), 0)",
  mark: "INSERT INTO notice_marks (account_id, kind, seen_at) VALUES (?, ?, ?) ON CONFLICT (account_id, kind) DO UPDATE SET seen_at = EXCLUDED.seen_at",
  bugList: "SELECT id, profile, message, context, status, created_at FROM bug_reports ORDER BY created_at DESC LIMIT ?",
};
const mark = (acct, kind) => db.marks.get(`${acct}|${kind}`) ?? 0;

const liveGrant = (g, t) => {
  const a = db.accounts.get(g.account_id);
  return g.kind === "trainer" && g.trainer_account_id === t && g.revoked_at == null && a && a.deleted_at == null
    && db.credentials.some((c) => c.id === g.credential_id && c.account_id === g.account_id && c.rp_id === "heatwayve.app");
};

vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings, ...v) => {
    const text = strings.join("?");
    if (/^\s*(CREATE|ALTER)\b/.test(text)) return [];
    calls.push({ q: text, v });
    if (failOn && failOn.test(text)) throw new Error("db down");
    const f = flat(text);
    if (f === SQL.bugs) return [{ n: db.bugs.filter((b) => b.status === "new" && ms(b.created_at) > mark(v[0], "bugs")).length }];
    if (f === SQL.applications) {
      return [{ n: [...db.applications].filter(([id, r]) => r.status === "applied" && db.accounts.get(id)?.deleted_at == null).length }];
    }
    if (f === SQL.application) {
      const r = db.applications.get(v[0]);
      return r && ["approved", "denied"].includes(r.status) && r.seen_at == null ? [{ status: r.status }] : [];
    }
    if (f === SQL.clients) {
      const [t, m, from, to] = v;
      const lit = db.grants.some((g) => liveGrant(g, t) && db.sessions.some((s) => s.profile === g.profile
        && ms(s.updated_at) > Math.max(mark(m, "clients"), Number(g.created_at))
        && s.record.date >= from && s.record.date <= to));
      return [{ lit }];
    }
    if (f === SQL.trainerChange) {
      const [me, m] = v;
      const sets = new Set(db.changes.filter((c) => c.client_account_id === me && c.source === "trainer" && c.status === "sent"
        && c.undone_at == null && Number(c.created_at) > mark(m, "trainerChange")).map((c) => c.set_id));
      return [{ n: sets.size }];
    }
    if (f === SQL.mark) {
      db.marks.set(`${v[0]}|${v[1]}`, v[2]);
      return [];
    }
    if (f === SQL.bugList) return db.bugs.map((b) => ({ ...b }));
    throw new Error(`unexpected SQL: ${text}`);
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));

// Tokens: who they belong to and their scope. Profiles are handles.
const TOKENS = {
  "tok-abe": { who: A }, "tok-abe-sync": { who: A, scope: "sync" }, "tok-abe-photos": { who: A, scope: "photos" },
  "tok-abe-trainer": { who: A, scope: "trainer" }, "tok-tia": { who: T }, "tok-nia": { who: N }, "tok-zed": { who: Z },
};
const IDENTITIES = {
  [A]: { accountId: A, storageKey: "sk-abe", handle: "abe", roles: ["lifter"], plan: "free" },
  [T]: { accountId: T, storageKey: "tia", handle: "tia", roles: ["lifter", "trainer"], plan: "free" },
  [N]: { accountId: N, storageKey: "nia", handle: "nia", roles: ["lifter", "trainer"], plan: "free" },
  [Z]: { accountId: Z, storageKey: "zed", handle: "zed", roles: ["lifter"], plan: "free" },
};
vi.mock("@/lib/auth-server", async (importOriginal) => ({
  ...(await importOriginal()),
  readTokenData: async (t) => (TOKENS[t] ? { accountId: TOKENS[t].who, scope: TOKENS[t].scope, expires: NOW + DAY } : null),
  // The bugs gate names no handle (null); the sync gate names the profile's.
  resolveTokenIdentity: async (d, profile) => {
    const id = d && IDENTITIES[d.accountId];
    return id && (profile === null || id.handle === profile) ? { ...id } : null;
  },
}));

const { GET } = await import("@/app/api/sync/notices/route");
const bugsRoute = await import("@/app/api/bugs/route");
const { dbMarkSeen, dbNotices, NOTICE_KINDS, MARKED_KINDS } = await import("@/lib/notices");
const { rateLimit } = await import("@/lib/rate-limit");
const { addDaysIso } = await import("@/lib/dates");
const { DETAIL_DAYS } = await import("@/lib/trainer-view");

const TODAY = new Date(NOW).toISOString().slice(0, 10);
const daysAgo = (n) => addDaysIso(TODAY, -n);
const account = (id, roles = ["lifter"], extra = {}) => ({ id, roles, plan: "free", deleted_at: null, ...extra });
const grant = (id, client, trainer, cred, extra = {}) => ({
  id, account_id: client, profile: `sk-${id}`, credential_id: cred, kind: "trainer", trainer_account_id: trainer,
  created_at: NOW - 30 * DAY, revoked_at: null, ...extra,
});
const session = (profile, date, arrived) => ({ profile, id: `${date}T08:00:00.000Z`, record: { date }, updated_at: new Date(arrived).toISOString() });

const URL_BASE = "https://heatwayve.app/api/sync/notices";
const get = (token = "tok-abe", profile = "abe", how = "header") => GET(new NextRequest(`${URL_BASE}?profile=${profile}`, {
  headers: token ? (how === "cookie" ? { cookie: `hw_sync=${token}` } : { "x-hw-auth": token }) : {},
}));
const dots = async (...a) => (await (await get(...a)).json());
const listBugs = (token) => bugsRoute.GET(new NextRequest("https://heatwayve.app/api/bugs", { headers: token ? { "x-hw-auth": token } : {} }));
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.q));
const reads = () => calls.filter((c) => /^\s*SELECT\b/.test(c.q)).map((c) => flat(c.q));

const envKeys = ["DATABASE_URL", "ADMIN_ACCOUNT_ID", "ADMIN_PROFILE"];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  process.env.DATABASE_URL = "postgres://fake";
  calls.length = 0;
  failOn = null;
  db.accounts = new Map([
    [A, account(A)], [T, account(T, ["lifter", "trainer"])], [N, account(N, ["lifter", "trainer"])], [Z, account(Z)],
    [C, account(C)], [X, account(X, ["lifter"], { deleted_at: "2026-09-30T00:00:00.000Z" })], [P, account(P)], [O, account(O)],
  ]);
  db.credentials = [
    { id: "cC", account_id: C, rp_id: "heatwayve.app" },
    { id: "cX", account_id: X, rp_id: "heatwayve.app" },
    { id: "cP", account_id: P, rp_id: "forge-legacy.vercel.app" },
    { id: "cO", account_id: O, rp_id: "heatwayve.app" },
  ];
  db.grants = [];
  db.sessions = [];
  db.bugs = [];
  db.applications = new Map();
  db.marks = new Map();
  db.changes = [];
  vi.mocked(rateLimit).mockClear();
});
afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("GET /api/sync/notices: the gate", () => {
  it("no token, an unknown one, another handle, a photos or trainer scope: 401 and no SQL", async () => {
    for (const [tok, profile] of [[null, "abe"], ["nope", "abe"], ["tok-abe", "tia"], ["tok-abe-photos", "abe"], ["tok-abe-trainer", "abe"], ["tok-abe", ""]]) {
      const res = await get(tok, profile);
      expect(res.status, `${tok} ${profile}`).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Sign in to see what's new", requiresAuth: true });
    }
    expect(calls).toEqual([]);
  });

  it("the hw_sync cookie or a full-scope header admits; 60 a minute per IP; no-store", async () => {
    for (const how of ["header", "cookie"]) {
      const res = await get(how === "cookie" ? "tok-abe-sync" : "tok-abe", "abe", how);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ dots: {} });
    }
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["sync-notices-read", 60]);
  });

  it("no database: 503, so no dot; a store error: 500, so no dot", async () => {
    delete process.env.DATABASE_URL;
    expect((await get()).status).toBe(503);
    process.env.DATABASE_URL = "postgres://fake";
    failOn = /trainer_applications/;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/sync/notices: the kinds", () => {
  it("a lifter: only their own application is read, and the GET writes nothing", async () => {
    expect(await dots()).toEqual({ dots: {} });
    expect(reads()).toEqual([SQL.application, SQL.trainerChange]);
    expect(calls[0].v).toEqual([A]);
    expect(writes()).toEqual([]);
  });

  it("application: the caller's decided row until seen; waiting or withdrawn rows light nothing", async () => {
    for (const [row, want] of [
      [{ status: "approved", seen_at: null }, { application: "approved" }],
      [{ status: "denied", seen_at: null }, { application: "denied" }],
      [{ status: "approved", seen_at: NOW - DAY }, {}],
      [{ status: "applied", seen_at: null }, {}],
      [{ status: "withdrawn", seen_at: null }, {}],
    ]) {
      db.applications.set(A, row);
      expect((await dots()).dots, JSON.stringify(row)).toEqual(want);
    }
    // Someone else's decision is never the caller's.
    db.applications = new Map([[O, { status: "approved", seen_at: null }]]);
    expect((await dots()).dots).toEqual({});
  });

  it("admin kinds only for the admin account, server-side; counts as numbers; admin: true", async () => {
    db.bugs = [
      { id: 1, status: "new", created_at: new Date(NOW - 2 * DAY).toISOString() },
      { id: 2, status: "new", created_at: new Date(NOW - DAY).toISOString() },
      { id: 3, status: "killed", created_at: new Date(NOW - DAY).toISOString() },
    ];
    db.applications = new Map([
      [A, { status: "applied", seen_at: null }], [O, { status: "applied", seen_at: null }],
      [X, { status: "applied", seen_at: null }], [C, { status: "denied", seen_at: null }],
    ]);
    // No admin env: nobody is admin, nothing admin is read.
    expect(await dots("tok-zed", "zed")).toEqual({ dots: {} });
    expect(reads()).toEqual([SQL.application, SQL.trainerChange]);
    process.env.ADMIN_ACCOUNT_ID = Z;
    calls.length = 0;
    expect(await dots("tok-zed", "zed")).toEqual({ dots: { bugs: 2, applications: 2 }, admin: true });
    expect(reads().sort()).toEqual([SQL.application, SQL.applications, SQL.bugs, SQL.trainerChange].sort());
    expect(calls.find((c) => flat(c.q) === SQL.bugs).v).toEqual([Z]);
    // Anyone else, with the env set: no admin key, no admin read.
    calls.length = 0;
    expect(await dots("tok-abe", "abe")).toEqual({ dots: {} });
    expect(reads()).toEqual([SQL.application, SQL.trainerChange]);
    expect(writes()).toEqual([]);
  });

  it("bugs: only reports after the admin's mark; zero leaves the key out", async () => {
    process.env.ADMIN_ACCOUNT_ID = Z;
    db.bugs = [{ id: 1, status: "new", created_at: new Date(NOW - 2 * DAY).toISOString() }];
    db.marks.set(`${Z}|bugs`, NOW - DAY);
    expect((await dots("tok-zed", "zed")).dots).toEqual({});
    db.bugs.push({ id: 2, status: "new", created_at: new Date(NOW - 60_000).toISOString() });
    expect((await dots("tok-zed", "zed")).dots).toEqual({ bugs: 1 });
  });

  describe("clients", () => {
    beforeEach(() => {
      // Pre-launch only the admin may act as a trainer (trainerOpenFor): make Tia the admin.
      process.env.ADMIN_ACCOUNT_ID = T;
      db.grants = [
        grant("cara", C, T, "cC"), grant("xan", X, T, "cX"), grant("pia", P, T, "cP"), grant("oli", O, N, "cO"),
        grant("old", C, T, "cC", { revoked_at: NOW - 40 * DAY, created_at: NOW - 90 * DAY }),
      ];
    });
    const lit = async () => (await dots("tok-tia", "tia")).dots.clients === true;

    it("lit by a session that arrived after the grant, dated in the 24-week window", async () => {
      db.sessions = [session("sk-cara", daysAgo(1), NOW - 3600_000)];
      expect(await dots("tok-tia", "tia")).toEqual({ dots: { clients: true }, admin: true });
      const c = calls.find((x) => flat(x.q) === SQL.clients);
      expect(c.v).toEqual([T, T, addDaysIso(TODAY, -DETAIL_DAYS), addDaysIso(TODAY, 1)]);
      expect(writes()).toEqual([]);
    });

    it("not lit by: an arrival before the mark or before the grant, a date outside the window", async () => {
      db.sessions = [session("sk-cara", daysAgo(1), NOW - 3600_000)];
      db.marks.set(`${T}|clients`, NOW - 60_000);
      expect(await lit()).toBe(false);
      db.marks = new Map();
      db.sessions = [session("sk-cara", daysAgo(1), NOW - 31 * DAY)]; // synced before the client shared
      expect(await lit()).toBe(false);
      db.sessions = [session("sk-cara", daysAgo(DETAIL_DAYS + 1), NOW - 3600_000), session("sk-cara", addDaysIso(TODAY, 2), NOW - 3600_000)];
      expect(await lit()).toBe(false);
      db.sessions = [session("sk-cara", daysAgo(DETAIL_DAYS), NOW - 3600_000)];
      expect(await lit()).toBe(true);
    });

    it("never lit through a grant that is not live: closed account, non-native passkey, revoked, another trainer's", async () => {
      for (const p of ["sk-xan", "sk-pia", "sk-old", "sk-oli"]) {
        db.sessions = [session(p, daysAgo(1), NOW - 3600_000)];
        expect(await lit(), p).toBe(false);
      }
    });

    it("a trainer the launch switch does not open, or a lifter: no clients read at all", async () => {
      db.sessions = [session("sk-oli", daysAgo(1), NOW - 3600_000)];
      calls.length = 0;
      expect(await dots("tok-nia", "nia")).toEqual({ dots: {} });
      expect(await dots("tok-abe", "abe")).toEqual({ dots: {} });
      expect(reads()).toEqual([SQL.application, SQL.trainerChange, SQL.application, SQL.trainerChange]);
    });
  });
});

describe("trainerChange: the change sets a trainer sent, after the client's mark (E10)", () => {
  const S = (c) => "hws_" + c.repeat(26);
  // One stored change, as trainer_changes holds it.
  const change = (set, i, extra = {}) => ({ id: `${set}.${i}`, set_id: set, client_account_id: A, source: "trainer", status: "sent",
    created_at: NOW - DAY, undone_at: null, ...extra });
  // The rule in JS, over the same rows: distinct sets for the client, sent by a
  // trainer, the row not taken back, created after the client's mark.
  const reference = (rows, me, seenAt) => new Set(rows.filter((c) => c.client_account_id === me && c.source === "trainer"
    && c.status === "sent" && c.undone_at == null && Number(c.created_at) > seenAt).map((c) => c.set_id)).size;

  it("counts sets, not changes; any account; the GET writes nothing", async () => {
    db.changes = [change(S("a"), 0), change(S("a"), 1), change(S("b"), 0, { created_at: NOW - 60_000 })];
    expect(await dots()).toEqual({ dots: { trainerChange: 2 } });
    const c = calls.find((x) => flat(x.q) === SQL.trainerChange);
    expect(c.v).toEqual([A, A]);
    expect(writes()).toEqual([]);
  });

  it("not lit by: a set before the mark, a set taken back entirely, another client's, a proposal, an AI source", async () => {
    db.marks.set(`${A}|trainerChange`, NOW - 2 * DAY);
    db.changes = [
      change(S("a"), 0, { created_at: NOW - 3 * DAY }),
      change(S("b"), 0, { undone_at: NOW - 60_000 }), change(S("b"), 1, { undone_at: NOW - 60_000 }),
      change(S("c"), 0, { client_account_id: O }),
      change(S("d"), 0, { status: "proposed" }),
      change(S("e"), 0, { source: "ai" }),
    ];
    expect((await dots()).dots).toEqual({});
    // A set with one change still standing lights.
    db.changes.push(change(S("f"), 0, { undone_at: NOW - 60_000 }), change(S("f"), 1));
    expect((await dots()).dots).toEqual({ trainerChange: 1 });
    // The mark moves past it: nothing new.
    db.marks.set(`${A}|trainerChange`, NOW);
    expect((await dots()).dots).toEqual({});
  });

  it("matches the JS reference across generated rows and marks", async () => {
    let seed = 7;
    // The high bits of a small LCG: the low ones cycle too fast to vary.
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
    const seenCounts = new Set();
    for (let round = 0; round < 40; round++) {
      const rows = Array.from({ length: rnd(12) }, (_, i) => change(S("abcdefgh"[rnd(8)]), i, {
        client_account_id: rnd(5) ? A : O, source: rnd(6) ? "trainer" : "ai", status: rnd(6) ? "sent" : "proposed",
        created_at: NOW - rnd(10) * DAY, undone_at: rnd(4) ? null : NOW - DAY,
      }));
      const seenAt = rnd(3) ? NOW - rnd(10) * DAY : 0;
      db.changes = rows;
      db.marks = seenAt ? new Map([[`${A}|trainerChange`, seenAt]]) : new Map();
      const n = reference(rows, A, seenAt);
      seenCounts.add(n);
      expect((await dots()).dots.trainerChange ?? 0, `round ${round}`).toBe(n);
    }
    // The fixtures reach both nothing new and several sets.
    expect(seenCounts.has(0) && [...seenCounts].some((n) => n > 1)).toBe(true);
  });

  it("the mark is the one upsert, by kind trainerChange", async () => {
    expect(await dbMarkSeen(A, "trainerChange", NOW)).toBe(true);
    expect(writes().map((c) => [flat(c.q), c.v])).toEqual([[SQL.mark, [A, "trainerChange", NOW]]]);
  });
});

describe("the mark: one row per account and kind, overwritten in place", () => {
  it("dbMarkSeen is the pinned upsert; a second mark overwrites the first", async () => {
    expect(await dbMarkSeen(T, "clients", NOW - 5)).toBe(true);
    expect(await dbMarkSeen(T, "clients", NOW)).toBe(true);
    expect(writes().map((c) => [flat(c.q), c.v])).toEqual([[SQL.mark, [T, "clients", NOW - 5]], [SQL.mark, [T, "clients", NOW]]]);
    expect([...db.marks]).toEqual([[`${T}|clients`, NOW]]);
  });

  it("only bugs, clients and trainerChange have a mark; anything else throws before any SQL; null with no DB", async () => {
    expect(NOTICE_KINDS).toEqual(["bugs", "applications", "application", "clients", "trainerChange"]);
    expect(MARKED_KINDS).toEqual(["bugs", "clients", "trainerChange"]);
    for (const k of ["application", "applications", "junk", ""]) await expect(dbMarkSeen(T, k, NOW)).rejects.toThrow();
    await expect(dbMarkSeen("", "bugs", NOW)).rejects.toThrow();
    await expect(dbMarkSeen(T, "bugs", NaN)).rejects.toThrow();
    expect(calls).toEqual([]);
    delete process.env.DATABASE_URL;
    expect(await dbMarkSeen(T, "bugs", NOW)).toBeNull();
    expect(await dbNotices(IDENTITIES[A], IDENTITIES[A], NOW)).toBeNull();
  });
});

describe("GET /api/bugs marks the bug notice seen", () => {
  beforeEach(() => {
    db.bugs = [{ id: 1, profile: null, message: "m", context: {}, status: "new", created_at: new Date(NOW - DAY).toISOString() }];
  });

  it("a successful admin list writes the mark after the read, timed at its start; the dot clears; a later report lights it again", async () => {
    process.env.ADMIN_ACCOUNT_ID = Z;
    expect((await dots("tok-zed", "zed")).dots).toEqual({ bugs: 1 });
    calls.length = 0;
    const before = Date.now();
    const res = await listBugs("tok-zed");
    expect(res.status).toBe(200);
    expect((await res.json()).reports).toHaveLength(1);
    expect(calls.map((c) => flat(c.q))).toEqual([SQL.bugList, SQL.mark]);
    const [acct, kind, at] = calls[1].v;
    expect([acct, kind]).toEqual([Z, "bugs"]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect((await dots("tok-zed", "zed")).dots).toEqual({});
    db.bugs.push({ id: 2, status: "new", created_at: new Date(Date.now() + 1000).toISOString() });
    expect((await dots("tok-zed", "zed")).dots).toEqual({ bugs: 1 });
  });

  it("no mark for a refused caller, nor for a passkey holder let in by the dev fallback (not the admin)", async () => {
    process.env.ADMIN_ACCOUNT_ID = Z;
    expect((await listBugs("tok-abe")).status).toBe(403);
    expect((await listBugs(null)).status).toBe(401);
    delete process.env.ADMIN_ACCOUNT_ID;
    expect((await listBugs("tok-abe")).status).toBe(200); // NODE_ENV is "test": the documented dev fallback
    expect(writes()).toEqual([]);
  });

  it("a mark that fails never fails the list", async () => {
    process.env.ADMIN_ACCOUNT_ID = Z;
    failOn = /^\s*INSERT INTO notice_marks/;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await listBugs("tok-zed");
    expect(res.status).toBe(200);
    expect((await res.json()).reports).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("a list that fails writes no mark", async () => {
    process.env.ADMIN_ACCOUNT_ID = Z;
    failOn = /FROM bug_reports ORDER BY/;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await listBugs("tok-zed")).status).toBe(500);
    expect(writes()).toEqual([]);
  });
});

describe("source pins", () => {
  const root = resolve(__dirname, "..");
  const read = (f) => readFileSync(resolve(root, f), "utf8");

  it("the clients read uses dbTrainerGrants' live-grant predicate verbatim", () => {
    const store = read("lib/trainer-store.js");
    const fn = store.slice(store.indexOf("export async function dbTrainerGrants"));
    const listed = fn.slice(fn.indexOf("FROM oauth_grants g"), fn.indexOf("LEFT JOIN handles"));
    expect(flat(listed)).toBe(LIVE);
    expect(flat(fn)).toContain("WHERE g.kind = 'trainer' AND g.trainer_account_id = ${trainerId} AND g.revoked_at IS NULL");
    const notices = read("lib/notices.js");
    expect(flat(notices)).toContain(`${LIVE} WHERE g.kind = 'trainer' AND g.trainer_account_id = \${me} AND g.revoked_at IS NULL`);
    // The window is the share's 24 weeks, in SQL.
    expect(notices).toContain("const from = addDaysIso(today, -DETAIL_DAYS);");
    expect(notices).toContain("AND s.record->>'date' BETWEEN ${from} AND ${to}");
  });

  it("lib/notices.js writes exactly one statement, the mark, and the route none", () => {
    const src = read("lib/notices.js");
    expect([...src.matchAll(/q`\s*(INSERT INTO \w+|UPDATE \w+|DELETE\b)/g)].map((m) => m[1])).toEqual(["INSERT INTO notice_marks"]);
    expect(src).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/);
    const route = read("app/api/sync/notices/route.js");
    expect(route).not.toMatch(/\bq`|\bsql\(|dbMarkSeen|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  });
});
