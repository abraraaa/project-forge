// Trainer read routes: one client's view and the client list. The Neon driver
// is faked with small in-memory tables, so the gate, the store, db.js's
// profile read and the routes run for real and every statement is captured.
// The only writes allowed: the full-look ring UPDATE, the trainer's remove
// UPDATE, the gate's daily session INSERT and, after a roster read, the
// trainer's clients notice mark (an upsert). Nothing is ever deleted. The
// trainer's own training ({ ref: "me" }) writes nothing at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86400000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer
const N = id26("n"); // another trainer
const A = id26("a"); // client "abe"
const C = id26("c"); // client "cara"
const X = id26("x"); // client whose account closed
const P = id26("p"); // client whose approving passkey is gone
const O = id26("o"); // client of the other trainer

const db = { tokens: new Map(), accounts: new Map(), handles: [], credentials: [], grants: [], meta: [], sessions: [], changes: [] };
const calls = [];
let failOn = null;
let logMisses = false; // the look UPDATE matches nothing (revoked between the join and the log)

const liveGrant = (g, t) => {
  const a = db.accounts.get(g.account_id);
  return g.kind === "trainer" && g.trainer_account_id === t && g.revoked_at == null && a && a.deleted_at == null
    && db.credentials.some((c) => c.id === g.credential_id && c.account_id === g.account_id && c.rp_id === "heatwayve.app");
};

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
    if (/^\s*SELECT handle, display FROM handles/.test(q)) {
      const h = db.handles.find((x) => x.account_id === v[0] && x.released_at == null);
      return h ? [{ handle: h.handle, display: h.display }] : [];
    }
    if (/^\s*SELECT g\.id, g\.profile, g\.scope, g\.created_at, g\.last_used_at, g\.edits_at, g\.edits_off_at, g\.consent_version, h\.handle, h\.display\s+FROM oauth_grants g/.test(q)) {
      const [t, ref] = v;
      return db.grants
        .filter((g) => liveGrant(g, t) && (ref === undefined || g.id === ref))
        .sort((a, b) => b.created_at - a.created_at)
        .map((g) => {
          const h = db.handles.find((x) => x.account_id === g.account_id && x.released_at == null);
          return { id: g.id, profile: g.profile, scope: g.scope, created_at: String(g.created_at),
            last_used_at: g.last_used_at == null ? null : String(g.last_used_at),
            edits_at: g.edits_at == null ? null : String(g.edits_at), edits_off_at: g.edits_off_at == null ? null : String(g.edits_off_at),
            handle: h?.handle ?? null, display: h?.display ?? null };
        });
    }
    if (/^\s*UPDATE oauth_grants SET\s+looks = CASE/.test(q)) {
      if (logMisses) return [];
      const now = v[0];
      const [ref, t] = v.slice(-2);
      const g = db.grants.find((x) => x.id === ref && x.kind === "trainer" && x.trainer_account_id === t && x.revoked_at == null);
      if (!g) return [];
      // The SQL, by hand: both CASEs read the row as it was.
      const top = g.looks?.[0];
      const coalesce = top?.k === "v" && Number(top.at) > now - 900000;
      g.looks = coalesce ? [{ ...top, at: now }, ...g.looks.slice(1)] : [{ k: "v", at: now }, ...(g.looks ?? [])].slice(0, 20);
      g.look_count = (g.look_count ?? 0) + (coalesce ? 0 : 1);
      g.last_used_at = v[4];
      return [{ id: g.id }];
    }
    if (/^\s*UPDATE oauth_grants SET revoked_at = \?, revoked_by = 'trainer'\s+WHERE id = \? AND kind = 'trainer' AND trainer_account_id = \? AND revoked_at IS NULL RETURNING id$/.test(q)) {
      const [now, ref, t] = v;
      const g = db.grants.find((x) => x.id === ref && x.kind === "trainer" && x.trainer_account_id === t && x.revoked_at == null);
      if (!g) return [];
      g.revoked_at = now;
      g.revoked_by = "trainer";
      return [{ id: g.id }];
    }
    if (/^\s*INSERT INTO notice_marks /.test(q)) return []; // pinned in tests/notices.test.js
    if (/^\s*SELECT now\(\) AS t$/.test(q)) return [{ t: new Date() }];
    // The trainer's own changes on one grant (dbChangesForTrainer). Whole stored rows come back,
    // basis and bookkeeping included, so the projection is what keeps them home.
    if (/^\s*SELECT c\.id, c\.set_id, .* AS edits_live\s+FROM trainer_changes c LEFT JOIN oauth_grants g/s.test(q)) {
      const [ref, t, since] = v;
      return db.changes
        .filter((c) => c.grant_id === ref && c.author_account_id === t && c.source === "trainer" && c.status === "sent"
          && (c.created_at > since || (c.outcome == null && c.undone_at == null)))
        .map((c) => {
          const g = db.grants.find((x) => x.id === c.grant_id);
          const live = !!g && g.revoked_at == null && g.edits_at != null && (g.edits_off_at == null || g.edits_off_at < g.edits_at) && c.created_at > g.edits_at;
          return { ...c, created_at: String(c.created_at), edits_live: live };
        });
    }
    if (/^\s*SELECT count\(DISTINCT set_id\)::int AS used, min\(created_at\) AS oldest FROM trainer_changes/.test(q)) {
      const [ref, since] = v;
      // The plan-set count, or the session count apart.
      const sessions = /AND kind = 'session'/.test(q);
      const rows = db.changes.filter((c) => c.grant_id === ref && c.source === "trainer" && c.created_at > since && (c.kind === "session") === sessions);
      return [{ used: new Set(rows.map((c) => c.set_id)).size, oldest: rows.length ? String(Math.min(...rows.map((c) => c.created_at))) : null }];
    }
    if (/^\s*SELECT field, value FROM meta WHERE profile = \?$/.test(q)) {
      return db.meta.filter((m) => m.profile === v[0]).map(({ field, value }) => ({ field, value }));
    }
    if (/^\s*SELECT record FROM sessions WHERE profile = \? ORDER BY id$/.test(q)) {
      return db.sessions.filter((s) => s.profile === v[0]).sort((a, b) => a.id.localeCompare(b.id)).map((s) => ({ record: s.record }));
    }
    throw new Error(`unexpected SQL: ${q}`);
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));
// The roster's log and read have their own fake and tests (tests/trainer-roster.test.js).
vi.mock("@/lib/trainer-store", async (importOriginal) => ({ ...(await importOriginal()), dbRosterSignals: vi.fn(async () => null) }));

const { POST: clientPOST } = await import("@/app/api/trainer/client/route");
const { POST: clientsPOST } = await import("@/app/api/trainer/clients/route");
const { TRAINER_COOKIE } = await import("@/lib/trainer-session");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { dbLogFullLook, dbRosterSignals } = await import("@/lib/trainer-store");
const { rateLimit, rateLimitShared } = await import("@/lib/rate-limit");
const { PLAN_KEYS } = await import("@/lib/trainer-plan");

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
const grant = (id, client, trainer, cred, extra = {}) => ({
  id, client_id: "hw:trainer", account_id: client, profile: db.accounts.get(client).storage_key, credential_id: cred,
  scope: "trainer:read", kind: "trainer", trainer_account_id: trainer, created_at: 1_790_000_000_000,
  revoked_at: null, revoked_by: null, looks: [], look_count: 0, last_used_at: null, ...extra,
});
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.q));
const changeReads = () => calls.filter((c) => /FROM trainer_changes\b/.test(c.q));
const dataReads = () => calls.filter((c) => /FROM (meta|sessions)\b/.test(c.q));
const H = "https://heatwayve.app/api/trainer";
const cookie = (t) => (t ? { cookie: `${TRAINER_COOKIE}=${t}` } : {});
const post = (handler, path, token, body, headers = {}) => handler(new NextRequest(`${H}/${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...cookie(token), ...headers }, body: JSON.stringify(body),
}));
const view = (token, body) => post(clientPOST, "client", token, body);
const list = (token, body = { today: "2026-10-03" }) => post(clientsPOST, "clients", token, body);
const NOT_SHARED = JSON.stringify({ error: "Not shared with you now." });

// Every field the trainer must never see, under its real name, with a sentinel value.
const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const plantedRecord = (date, time) => ({
  id: `${date}T${time}.000Z`, date, dow: 3, profileName: "SENTINEL-profileName", schemaVersion: 3,
  loggedTz: "SENTINEL/Zone", loggedTzOffset: 777.11, session: "strength-a", blockNumber: 4, weekStart: date,
  scheduledLetter: "A", mesocyclePhase: "SENTINEL-phase", readiness: "cooked", readinessReason: "SENTINEL-readinessReason",
  bodyweight: 777.22, hoursSlept: 777.33, daysSinceLast: 777.44, startedAt: 1777777777777, duration: 777.55,
  retrospective: "SENTINEL-retro", notes: "SENTINEL-notes", comment: "SENTINEL-comment",
  summary: { totalVolume: 777.66, avgRir: 777.77 },
  blocks: [{
    id: "SENTINEL-blockId", type: "main", intent: "SENTINEL-intent",
    exercises: [{
      name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell", swapped: true, fromPool: "SENTINEL-pool",
      tempo: "SENTINEL-tempo", prescribed: { weight: 777.88 }, summary: { totalVolume: 777.99 },
      sets: [{ weight: 100, reps: 5, rpe: 8, rir: 2, loadType: "barbell", bodyweightUsed: 81.37, effectiveLoad: 778.11,
        est1rm: 778.22, volume: 778.33, tempo: "SENTINEL-setTempo", reach: true }],
    }, {
      name: "Pull-up", muscle: "Back", loadType: "bodyweight",
      sets: [{ weight: 10, reps: 6, rpe: 9, rir: 1, loadType: "bodyweight", bodyweightUsed: 81.37, effectiveLoad: 91.37, est1rm: 778.44, volume: 778.55 }],
    }],
  }],
});
const PLANTED_META = {
  displayName: "SENTINEL-displayName", bodyweight: 779.11, bodyweightLog: [{ date: TODAY, kg: 779.22 }],
  trainingState: { note: "SENTINEL-trainingState" }, weights: { "Barbell Back Squat": 779.33 }, streak: 779.44,
  photos: ["SENTINEL-photo.jpg"], addedLoads: { "Pull-up": { kg: 779.55 } },
  breaks: [{ id: "2026-09-01T08:15:16.000Z", start: daysAgo(3), reason: "injured", endedAt: null }],
  userWeek: [{ editedAt: "2026-03-03T09:41:27.000Z", effectiveFrom: "2026-03-02", week: [
    { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "zone2" }, { type: "rest" }] }],
};
const FORBIDDEN = ["SENTINEL", "777.", "778.", "779.", "81.37", "injured", "07:13:42", "09:41:27", "08:15:16", "1777777777777"];

beforeEach(() => {
  calls.length = 0;
  failOn = null;
  logMisses = false;
  db.tokens.clear();
  db.accounts = new Map([
    [T, account(T, "tia", ["lifter", "trainer"], CURRENT)],
    [N, account(N, "nia", ["lifter", "trainer"], CURRENT)],
    [A, account(A, "sk-abe", ["lifter"])],
    [C, account(C, "sk-cara", ["lifter"])],
    [X, { ...account(X, "sk-xan", ["lifter"]), deleted_at: "2026-09-30T00:00:00.000Z" }],
    [P, account(P, "sk-pia", ["lifter"])],
    [O, account(O, "sk-oli", ["lifter"])],
  ]);
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T, released_at: null },
    { handle: "nia", display: "Nia", account_id: N, released_at: null },
    { handle: "abe", display: "Abe", account_id: A, released_at: null },
    { handle: "cara", display: "Cara", account_id: C, released_at: null },
    { handle: "xan", display: "Xan", account_id: X, released_at: null },
    { handle: "pia", display: "Pia", account_id: P, released_at: null },
    { handle: "oli", display: "Oli", account_id: O, released_at: null },
  ];
  db.credentials = [
    { id: "cT", account_id: T, rp_id: "heatwayve.app" },
    { id: "cN", account_id: N, rp_id: "heatwayve.app" },
    { id: "cA", account_id: A, rp_id: "heatwayve.app" },
    { id: "cC", account_id: C, rp_id: "heatwayve.app" },
    { id: "cX", account_id: X, rp_id: "heatwayve.app" },
    { id: "cP", account_id: P, rp_id: "forge-legacy.vercel.app" },
    { id: "cO", account_id: O, rp_id: "heatwayve.app" },
  ];
  db.grants = [
    grant("hwg_cara", C, T, "cC", { created_at: 1_790_000_000_000 }),
    grant("hwg_abe", A, T, "cA", { created_at: 1_790_100_000_000, last_used_at: 1_790_200_000_000 }),
    grant("hwg_old", A, T, "cA", { revoked_at: 1_789_000_000_000, revoked_by: null }),
    grant("hwg_xan", X, T, "cX"),
    grant("hwg_pia", P, T, "cP"),
    grant("hwg_oli", O, N, "cO"),
  ];
  db.meta = Object.entries(PLANTED_META).map(([field, value]) => ({ profile: "sk-cara", field, value }));
  db.changes = [];
  db.sessions = [daysAgo(1), daysAgo(200)].map((d, i) => {
    const record = plantedRecord(d, i ? "18:02:03" : "07:13:42");
    return { profile: "sk-cara", id: record.id, record };
  });
  process.env.DATABASE_URL = "postgres://fake";
  vi.mocked(rateLimit).mockClear();
  vi.mocked(rateLimitShared).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("POST /api/trainer/client", () => {
  it("logs the look, then reads the client's profile by its storage key, then answers with the projection only", async () => {
    const res = await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["client", "view"]);
    expect(body.client).toEqual({ name: "Cara", since: 1_790_000_000_000 });
    expect(Object.keys(body.view).sort()).toEqual(["breaks", "edits", "ran", "schedule", "sessions", "tops", "window"]);
    // A grant approved before plan changes (no edits_at): read only until a fresh approval.
    expect(body.view.edits).toBe("fresh");
    // No plan; only the sessions this trainer ran with them (none here) and the session count.
    expect(body.view.ran).toEqual({ changes: [], budget: { used: 0, of: 7, freeAt: null } });
    for (const k of ["meta", "history", "scopes", "scope", "profile", "ref", "cursor"]) {
      expect(body, k).not.toHaveProperty(k);
      expect(body.view, k).not.toHaveProperty(k);
    }
    expect(body.view.sessions).toHaveLength(1);
    expect(body.view.tops).toHaveLength(1);
    expect(body.view.breaks).toEqual([{ start: daysAgo(3), endedAt: null }]);

    // Order: the ring UPDATE comes before either data read, and the reads are by the grant's storage key.
    const iLog = calls.findIndex((c) => /^\s*UPDATE oauth_grants SET\s+looks = CASE/.test(c.q));
    const reads = dataReads();
    expect(iLog).toBeGreaterThan(-1);
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect(calls.indexOf(r)).toBeGreaterThan(iLog);
      expect(r.v).toEqual(["sk-cara"]);
    }
    // The trainer's own rows on the grant are read after the look too.
    for (const r of changeReads()) expect(calls.indexOf(r)).toBeGreaterThan(iLog);
    // Only the look was written.
    expect(writes().map((w) => w.q.trim().slice(0, 20))).toEqual(["UPDATE oauth_grants "]);
    const g = db.grants.find((x) => x.id === "hwg_cara");
    expect(g.look_count).toBe(1);
    expect(g.looks).toHaveLength(1);
    expect(g.looks[0].k).toBe("v");
    expect(g.last_used_at).toBe(g.looks[0].at);
  });

  it("never sends photos, bodyweight, sleep, breather reasons, start times, notes or any planted field", async () => {
    const res = await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    const text = await res.text();
    for (const f of FORBIDDEN) expect(text, f).not.toContain(f);
    // The data reads touch meta and sessions only: never photos.
    expect(calls.some((c) => /photo/i.test(c.q))).toBe(false);
  });

  it("one 404, byte for byte, for revoked, closed, dead passkey, another trainer's client, unknown and missing; nothing logged, nothing read", async () => {
    const t = session(T, "cT");
    const bodies = [];
    for (const ref of ["hwg_old", "hwg_xan", "hwg_pia", "hwg_oli", "hwg_nope", undefined, 42]) {
      calls.length = 0;
      const res = await view(t, { ref, today: TODAY });
      expect(res.status, String(ref)).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      bodies.push(await res.text());
      expect(writes(), String(ref)).toEqual([]);
      expect(dataReads(), String(ref)).toEqual([]);
    }
    expect(new Set(bodies)).toEqual(new Set([NOT_SHARED]));
  });

  it("a removed grant answers the same 404 straight after", async () => {
    const t = session(T, "cT");
    expect((await post(clientsPOST, "clients", t, { remove: "hwg_cara" })).status).toBe(200);
    const res = await view(t, { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_SHARED);
  });

  it("if the look can't be logged: 503 and the client's data is never read", async () => {
    failOn = /^\s*UPDATE oauth_grants SET\s+looks = CASE/;
    const res = await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
    expect(dataReads()).toEqual([]);
  });

  it("a grant revoked between the check and the log (0 rows): 404 and nothing read", async () => {
    logMisses = true;
    const res = await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_SHARED);
    expect(dataReads()).toEqual([]);
  });

  it("only the trainer cookie admits: none, a lifter-scoped header token, or a non-trainer is refused before any lookup", async () => {
    const lifter = session(C, "cC", { scope: null });
    for (const res of [
      await view(null, { ref: "hwg_cara" }),
      await post(clientPOST, "client", null, { ref: "hwg_cara" }, { "x-hw-auth": session(T, "cT") }),
      await view(lifter, { ref: "hwg_cara" }),
      await view(session(C, "cC"), { ref: "hwg_cara" }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls.some((c) => /FROM oauth_grants|UPDATE oauth_grants/.test(c.q))).toBe(false);
    expect(dataReads()).toEqual([]);
  });

  it("limits: 60 a minute per IP, 300 a day per grant", async () => {
    await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-client", 60]);
    const [, route, n, opts] = vi.mocked(rateLimitShared).mock.calls[0];
    expect([route, n, opts]).toEqual(["trainer-client", 300, { windowMs: DAY, id: "hwg_cara" }]);
  });

  it("an out-of-range today falls back to the server's UTC date", async () => {
    const res = await view(session(T, "cT"), { ref: "hwg_cara", today: "2020-01-01" });
    expect((await res.json()).view.window.to).toBe(TODAY);
  });
});

describe("POST /api/trainer/client { ref: 'me' }: the trainer's own training", () => {
  // The trainer lifts too: the same planted data under their own storage key.
  const plantOwn = () => {
    db.meta.push(...db.meta.filter((m) => m.profile === "sk-cara").map((m) => ({ ...m, profile: "tia" })));
    db.sessions.push(...db.sessions.filter((x) => x.profile === "sk-cara").map((x) => ({ ...x, profile: "tia" })));
  };

  it("reads the trainer's own storage key through the same projection; no grant, no look, nothing written", async () => {
    plantOwn();
    const t = session(T, "cT");
    const theirs = await (await view(t, { ref: "hwg_cara", today: TODAY })).json();
    calls.length = 0;
    const looksBefore = JSON.stringify(db.grants.map((g) => [g.id, g.looks, g.look_count, g.last_used_at]));

    const res = await view(t, { ref: "me", today: TODAY });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["client", "self", "view"]);
    expect(body.self).toBe(true);
    expect(body.client).toEqual({ name: "Tia" });
    // Same allow-list: the projection of the same data is the same, byte for byte.
    const { edits: _grantOnly, ran: _grantOnlyToo, ...theirView } = theirs.view;
    expect(body.view).toEqual(theirView);
    expect(body.view).not.toHaveProperty("edits");
    expect(body.view).not.toHaveProperty("ran");
    for (const f of FORBIDDEN) expect(text, f).not.toContain(f);

    const reads = dataReads();
    expect(reads).toHaveLength(2);
    for (const r of reads) expect(r.v).toEqual(["tia"]);
    expect(calls.some((c) => /oauth_grants/.test(c.q)), "no grant read or look logged").toBe(false);
    expect(writes()).toEqual([]);
    expect(JSON.stringify(db.grants.map((g) => [g.id, g.looks, g.look_count, g.last_used_at]))).toBe(looksBefore);
  });

  it("a trainer with no training gets an empty view, not a 404", async () => {
    const body = await (await view(session(T, "cT"), { ref: "me", today: TODAY })).json();
    expect(body.self).toBe(true);
    expect(body.view.sessions).toEqual([]);
    expect(body.view.tops).toEqual([]);
    expect(dataReads().every((r) => r.v[0] === "tia")).toBe(true);
  });

  it("only the exact ref: near misses and dead grants still answer the one 404, nothing read", async () => {
    plantOwn();
    const t = session(T, "cT");
    for (const ref of ["Me", "me ", "ME", "hwg_old", "hwg_xan", "hwg_oli"]) {
      calls.length = 0;
      const res = await view(t, { ref, today: TODAY });
      expect(res.status, ref).toBe(404);
      expect(await res.text(), ref).toBe(NOT_SHARED);
      expect(dataReads(), ref).toEqual([]);
      expect(writes(), ref).toEqual([]);
    }
  });

  it("only the trainer cookie admits: a lifter's own session never reads through it", async () => {
    for (const res of [
      await view(null, { ref: "me" }),
      await view(session(C, "cC", { scope: null }), { ref: "me" }),
      await view(session(C, "cC"), { ref: "me" }),
    ]) expect(res.status).toBe(401);
    expect(dataReads()).toEqual([]);
  });

  it("limits as the client route: 60 a minute per IP, 300 a day keyed by the trainer, never one shared 'me' bucket", async () => {
    await view(session(T, "cT"), { ref: "me", today: TODAY });
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-client", 60]);
    const [, route, n, opts] = vi.mocked(rateLimitShared).mock.calls[0];
    expect([route, n, opts]).toEqual(["trainer-client", 300, { windowMs: DAY, id: T }]);
  });
});

describe("POST /api/trainer/client: the plan, with the client's changes on", () => {
  const SQUAT = "Barbell Back Squat";
  const SET = "hws_" + "t".repeat(26);
  const SET_S = "hws_" + "s".repeat(26);
  const EDITS_AT = Date.now() - 3 * DAY;
  const RECORD_ID = `${daysAgo(1)}T07:13:42.000Z`;
  const editsOn = (ref = "hwg_cara", extra = {}) => Object.assign(db.grants.find((g) => g.id === ref), { edits_at: EDITS_AT, ...extra });
  // With changes on the trainer sees the stored W: a plain number here, not a sentinel.
  const plainWeights = () => { db.meta.find((m) => m.profile === "sk-cara" && m.field === "weights").value = { [SQUAT]: 100 }; };
  const stored = (i, over = {}) => ({
    id: `${SET}.${i}`, set_id: SET, grant_id: "hwg_cara", profile: "sk-cara", client_account_id: C, author_account_id: T,
    source: "trainer", status: "sent", kind: "weight", target: SQUAT, old_value: 100, new_value: 105,
    basis: { anchorId: RECORD_ID, trainedId: RECORD_ID, w: 100, r: null }, warnings: ["big_drop"], effective_from: null,
    created_at: Date.now() - DAY + i, applied_at: null, outcome: null, undone_at: null, undone_by: null, reverted_at: null, cleared_at: null,
    ...over,
  });

  it("the view carries the plan, read after the look; the only write is still the look", async () => {
    editsOn();
    plainWeights();
    db.changes = [
      stored(0),
      stored(1, { author_account_id: N, set_id: "hws_" + "n".repeat(26), id: "hws_" + "n".repeat(26) + ".0" }), // another trainer's
      stored(2, { grant_id: "hwg_abe", id: `${SET}.2` }), // another client's
    ];
    const res = await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body)).toEqual(["client", "view"]);
    expect(Object.keys(body.view).sort()).toEqual(["breaks", "edits", "plan", "schedule", "sessions", "tops", "window"]);
    expect(body.view.edits).toBe("on");
    const { plan } = body.view;
    expect(Object.keys(plan)).toEqual(PLAN_KEYS.plan);
    // Only this trainer's changes on this grant; the budget counts every set on the grant.
    expect(plan.changes.map((c) => c.id)).toEqual([`${SET}.0`]);
    expect(plan.changes[0]).toEqual({ id: `${SET}.0`, set: SET, kind: "weight", target: SQUAT, before: 100, after: 105, from: null,
      status: "waiting", reason: null, date: null, at: db.changes[0].created_at, warnings: ["big_drop"] });
    expect(plan.budget).toEqual({ used: 2, of: 10, freeAt: db.changes[0].created_at + 7 * DAY, sessions: { used: 0, of: 7, freeAt: null } });
    const squat = plan.lifts.find((l) => l.name === SQUAT);
    expect(squat.pending).toEqual({ w: 105, reps: null });

    // Order: the ring UPDATE, then the profile and the changes; the changes read is this grant and this trainer.
    const iLog = calls.findIndex((c) => /^\s*UPDATE oauth_grants SET\s+looks = CASE/.test(c.q));
    expect(iLog).toBeGreaterThan(-1);
    const reads = changeReads();
    expect(reads).toHaveLength(3); // the list, the plan-set count and the session count
    for (const r of reads) {
      expect(calls.indexOf(r)).toBeGreaterThan(iLog);
      expect(r.v[0]).toBe("hwg_cara");
    }
    expect(reads.find((r) => /edits_live/.test(r.q)).v[1]).toBe(T);
    expect(writes().map((w) => w.q.trim().slice(0, 20))).toEqual(["UPDATE oauth_grants "]);
  });

  it("a coached session row: its status, letter, day and size, never the record; counted apart from the plan sets", async () => {
    editsOn();
    plainWeights();
    const SS = "hws_" + "s".repeat(26);
    const day = daysAgo(0);
    const record = { id: `${day}T08:15:16.000Z`, date: day, session: "strength-b", scheduledLetter: "B", readiness: "fresh",
      readinessReason: "SENTINEL-reason", blocks: [{ id: "b1", type: "main", exercises: [
        { name: "SENTINEL-lift", sets: [{ weight: 777.5, reps: 5 }, { weight: 777.5, reps: 5 }] }, { name: SQUAT, sets: [{ weight: 100, reps: 5 }] }] }] };
    const delivered = new Date(Date.now() - DAY / 24).toISOString();
    db.changes = [
      stored(0),
      stored(1, { id: `${SS}.00`, set_id: SS, kind: "session", target: `${day}:B`, old_value: null, new_value: { record, drum: { [SQUAT]: 779.5 } },
        basis: null, warnings: null, effective_from: day, delivered_at: delivered }),
    ];
    const text = await (await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).text();
    for (const f of [...FORBIDDEN, "drum", "readinessReason"]) expect(text, f).not.toContain(f);
    const { plan } = JSON.parse(text).view;
    expect(JSON.stringify(plan.changes)).not.toMatch(/blocks|record|"name"/);
    expect(plan.changes.find((c) => c.kind === "session")).toEqual({
      id: `${SS}.00`, set: SS, kind: "session", target: `${day}:B`, before: null,
      after: { letter: "B", date: day, exercises: 2, sets: 3 }, from: day,
      status: "seen", reason: null, date: day, at: db.changes[1].created_at, delivered, warnings: [],
    });
    // A plan change carries no delivered key.
    expect(plan.changes.find((c) => c.kind === "weight")).not.toHaveProperty("delivered");
    // A waiting session is never a lift's pending change.
    expect(plan.lifts.find((l) => l.name === SQUAT).pending).toEqual({ w: 105, reps: null });
    expect(plan.budget).toEqual({ used: 1, of: 10, freeAt: db.changes[0].created_at + 7 * DAY,
      sessions: { used: 1, of: 7, freeAt: db.changes[1].created_at + 7 * DAY } });
    // What the trainer's device composes the session from.
    expect(Object.keys(plan.programme)).toEqual(PLAN_KEYS.planProgramme);
    expect(writes().map((w) => w.q.trim().slice(0, 20))).toEqual(["UPDATE oauth_grants "]);
  });

  it("never sends a planted field, a change's basis or bookkeeping, or a load read from bodyweight", async () => {
    editsOn();
    plainWeights();
    db.sessions[0].record.readiness = "normal"; // a top set the engine reads
    // A pure bodyweight lift whose logged weight is the body itself (a legacy set): never its load.
    db.sessions[0].record.blocks[0].exercises.push({ name: "45-Degree Hip Extension", muscle: "Glutes", loadType: "bodyweight",
      sets: [{ weight: 81.37, reps: 12, rpe: 8, rir: 2, loadType: "bodyweight", bodyweightUsed: 81.37, effectiveLoad: 81.37 }] });
    db.changes = [stored(0, { applied_at: "2026-09-01T06:51:44.000Z", outcome: "applied", reverted_at: "2026-09-02T05:52:45.000Z",
      undone_at: 1777777777777, undone_by: "client" })];
    const text = await (await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).text();
    for (const f of [...FORBIDDEN, "06:51:44", "05:52:45", "anchorId", "trainedId", "sk-cara", C, "editsLive", "edits_live", "cleared"]) {
      expect(text, f).not.toContain(f);
    }
    // The planted squat set's load is a body-based effectiveLoad (778.11), not its logged 100: reps only.
    const squat = JSON.parse(text).view.plan.lifts.find((l) => l.name === SQUAT);
    expect(squat).toMatchObject({ w: null, bounds: null, anchor: { date: daysAgo(1), kg: null } });
    const hip = JSON.parse(text).view.plan.lifts.find((l) => l.name === "45-Degree Hip Extension");
    expect(hip).toMatchObject({ w: null, bounds: null, anchor: { date: daysAgo(1), kg: null, reps: 12 } });
  });

  it("an anchor kg the session view withholds never leaves through the plan (the body as a Pull-Up's weight, a stale working weight, no effectiveLoad, no load type)", async () => {
    editsOn();
    plainWeights();
    const rec0 = db.sessions[0].record;
    rec0.readiness = "normal";
    const base = rec0.blocks[0].exercises.map((e) => ({ ...e }));
    const variants = [
      ["pull-up, weight = body", [{ name: "Pull-Up", muscle: "Lats", loadType: "loaded_bodyweight",
        sets: [{ weight: 81.37, reps: 6, rpe: 9, rir: 1, loadType: "bodyweight", bodyweightUsed: 81.37, effectiveLoad: 81.37 }] }]],
      ["pull-up, stale working weight", [{ name: "Pull-Up", muscle: "Lats", loadType: "loaded_bodyweight",
        sets: [{ weight: 61.25, reps: 6, rpe: 9, rir: 1, loadType: "bodyweight", bodyweightUsed: 81.37, effectiveLoad: 81.37 }] }]],
      ["bench, no effectiveLoad, weight = body", [{ name: "Barbell Bench Press", muscle: "Chest", loadType: "barbell",
        sets: [{ weight: 81.37, reps: 5, rpe: 8, rir: 2, loadType: "bodyweight" }] }]],
      // No load type on set or exercise: the programme's ('bodyweight') decides, though the name alone does not say so.
      ["hip extension, no load type anywhere, weight = body", [{ name: "45-Degree Hip Extension", muscle: "Glutes",
        sets: [{ weight: 81.37, reps: 12, rpe: 8, rir: 2 }] }]],
    ];
    for (const [label, extra] of variants) {
      rec0.blocks[0].exercises = [...base, ...extra];
      const text = await (await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).text();
      const { plan, sessions } = JSON.parse(text).view;
      const name = extra[0].name;
      // The session view shows that set as 0; the plan's anchor carries no kg, and no bounds or W.
      expect(sessions[0].blocks[0].exercises.find((e) => e.name === name).sets[0].weight, label).toBe(0);
      expect(plan.lifts.find((l) => l.name === name), label).toMatchObject({ w: null, bounds: null, anchor: { date: daysAgo(1), kg: null } });
      for (const f of [...FORBIDDEN, "61.25"]) expect(JSON.stringify(plan), `${label}: ${f}`).not.toContain(f);
      for (const f of FORBIDDEN) expect(text, `${label}: ${f}`).not.toContain(f);
    }
  });

  it("mixed load types, and an untyped bodyweight set in the trend tier: the body never leaves", async () => {
    editsOn();
    plainWeights();
    const recent = db.sessions[0].record;
    recent.readiness = "normal";
    // A bench session with a plain set and a body-loaded set (effectiveLoad 20 + 81.37).
    recent.blocks[0].exercises = [{ name: "Barbell Bench Press", muscle: "Chest", loadType: "barbell", sets: [
      { weight: 100, reps: 5, rpe: 8, rir: 2, loadType: "barbell" },
      { weight: 20, reps: 8, rpe: 8, rir: 2, loadType: "loaded_bodyweight", bodyweightUsed: 81.37, effectiveLoad: 101.37 },
    ] }];
    // 200 days back (trend tier): a pure bodyweight main-block set with no load type anywhere, its weight the body.
    const old = db.sessions[1].record;
    old.readiness = "normal";
    old.blocks[0].exercises = [
      { name: "45-Degree Hip Extension", muscle: "Glutes", sets: [{ weight: 81.37, reps: 12, rpe: 8 }] },
      { name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell", sets: [{ weight: 100, reps: 5, rpe: 8, loadType: "barbell" }] },
    ];
    const text = await (await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).text();
    const { plan, tops } = JSON.parse(text).view;
    expect(plan.lifts.find((l) => l.name === "Barbell Bench Press")).toMatchObject({ w: null, bounds: null, anchor: { date: daysAgo(1), kg: null } });
    for (const f of ["81.37", "101.37"]) {
      expect(JSON.stringify(plan), f).not.toContain(f);
      expect(text, f).not.toContain(f);
    }
    expect(tops.flatMap((t) => t.blocks[0].exercises.map((e) => e.name))).toEqual(["Barbell Back Squat"]);
    for (const f of FORBIDDEN) expect(text, f).not.toContain(f);
  });

  it("changes never on, or turned off: no plan, only the sessions the trainer ran and their count", async () => {
    const t = session(T, "cT");
    // A plan change, and a session already on their phone when changes went off.
    const delivered = new Date(Date.now() - 3600e3).toISOString();
    const record = { id: `${daysAgo(1)}T09:00:00.000Z`, date: daysAgo(1), session: "strength-a", scheduledLetter: "A",
      blocks: [{ id: "a1", type: "main", exercises: [{ name: SQUAT, sets: [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }] }] }] };
    const sessionRow = stored(1, { id: `${SET_S}.00`, set_id: SET_S, kind: "session", target: `${daysAgo(1)}:A`, old_value: null,
      new_value: { record, drum: {} }, basis: null, warnings: null, effective_from: daysAgo(1), delivered_at: delivered });
    for (const [extra, status] of [[null, "fresh"], [{ edits_off_at: EDITS_AT + 1 }, "off"]]) {
      if (extra) editsOn("hwg_cara", extra);
      calls.length = 0;
      db.changes = [stored(0), sessionRow];
      const res = await view(t, { ref: "hwg_cara", today: TODAY });
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body.view, JSON.stringify(extra)).not.toHaveProperty("plan");
      expect(body.view.edits, JSON.stringify(extra)).toBe(status);
      // Read on a live grant whatever the status: the session rows only, never the plan change.
      expect(changeReads().length, JSON.stringify(extra)).toBeGreaterThan(0);
      expect(body.view.ran.changes.map((c) => [c.id, c.kind, c.status, c.reason, c.delivered]))
        .toEqual([[`${SET_S}.00`, "session", "seen", "stopped", delivered]]);
      expect(body.view.ran.changes[0].after).toEqual({ letter: "A", date: daysAgo(1), exercises: 1, sets: 2 });
      expect(body.view.ran.budget).toEqual({ used: 1, of: 7, freeAt: sessionRow.created_at + 7 * DAY });
      // Never the record, the basis or the plan change.
      for (const f of ["record", "basis", "big_drop", RECORD_ID]) expect(text, f).not.toContain(f);
    }
    // Turned back on: the plan is back.
    editsOn("hwg_cara", { edits_at: EDITS_AT + 2, edits_off_at: EDITS_AT + 1 });
    const back = (await (await view(t, { ref: "hwg_cara", today: TODAY })).json()).view;
    expect(back).toHaveProperty("plan");
    expect(back.edits).toBe("on");
  });

  it("the trainer's own training never carries a plan", async () => {
    const body = await (await view(session(T, "cT"), { ref: "me", today: TODAY })).json();
    expect(body.view).not.toHaveProperty("plan");
    expect(body.view).not.toHaveProperty("edits");
    expect(changeReads()).toEqual([]);
  });

  it("look-before-read holds for the plan: no look, no changes read; not shared, nothing read", async () => {
    editsOn();
    editsOn("hwg_oli");
    failOn = /^\s*UPDATE oauth_grants SET\s+looks = CASE/;
    expect((await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).status).toBe(503);
    expect(changeReads()).toEqual([]);
    failOn = null;
    logMisses = true;
    expect((await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).status).toBe(404);
    logMisses = false;
    calls.length = 0;
    expect((await view(session(T, "cT"), { ref: "hwg_oli", today: TODAY })).status).toBe(404);
    expect(changeReads()).toEqual([]);
    expect(dataReads()).toEqual([]);
  });

  it("look-before-read holds with changes off: no look, no session rows read; on a look, the read comes after it", async () => {
    for (const extra of [null, { edits_at: EDITS_AT, edits_off_at: EDITS_AT + 1 }]) {
      if (extra) editsOn("hwg_cara", extra);
      calls.length = 0;
      failOn = /^\s*UPDATE oauth_grants SET\s+looks = CASE/;
      expect((await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).status, JSON.stringify(extra)).toBe(503);
      expect(changeReads(), JSON.stringify(extra)).toEqual([]);
      failOn = null;
      logMisses = true;
      expect((await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).status, JSON.stringify(extra)).toBe(404);
      expect(changeReads(), JSON.stringify(extra)).toEqual([]);
      logMisses = false;
      calls.length = 0;
      expect((await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).status, JSON.stringify(extra)).toBe(200);
      const look = calls.findIndex((c) => /^\s*UPDATE oauth_grants SET\s+looks = CASE/.test(c.q));
      const read = calls.findIndex((c) => /FROM trainer_changes\b/.test(c.q));
      expect(look, JSON.stringify(extra)).toBeGreaterThanOrEqual(0);
      expect(read, JSON.stringify(extra)).toBeGreaterThan(look);
    }
  });

  it("a changes read that fails: the view still answers, without a plan, and the failure is logged", async () => {
    editsOn();
    failOn = /FROM trainer_changes/;
    const res = await view(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view).not.toHaveProperty("plan");
    // Changes are on but could not be read: the pane can tell this from changes off.
    expect(body.view.edits).toBe("unavailable");
    expect(body.view.sessions).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes("trainer-client-plan"))).toBe(true);
  });
});

describe("the look ring on the grant row", () => {
  it("full looks within 15 minutes coalesce; the ring keeps 20 and the count keeps every look", async () => {
    const t0 = 1_800_000_000_000;
    expect(await dbLogFullLook("hwg_cara", T, t0)).toBe(true);
    expect(await dbLogFullLook("hwg_cara", T, t0 + 14 * 60_000)).toBe(true);
    const g = db.grants.find((x) => x.id === "hwg_cara");
    expect(g.looks).toEqual([{ k: "v", at: t0 + 14 * 60_000 }]);
    expect(g.look_count).toBe(1);
    expect(await dbLogFullLook("hwg_cara", T, t0 + 30 * 60_000)).toBe(true);
    expect(g.looks).toHaveLength(2);
    expect(g.look_count).toBe(2);
    for (let i = 1; i <= 25; i++) await dbLogFullLook("hwg_cara", T, t0 + 30 * 60_000 + i * 16 * 60_000);
    expect(g.looks).toHaveLength(20);
    expect(g.look_count).toBe(27);
    expect(g.looks[0].at).toBe(t0 + 30 * 60_000 + 25 * 16 * 60_000);
  });

  it("another trainer's grant, or a revoked one, is never logged on", async () => {
    expect(await dbLogFullLook("hwg_oli", T, Date.now())).toBe(false);
    expect(await dbLogFullLook("hwg_old", T, Date.now())).toBe(false);
    expect(db.grants.find((x) => x.id === "hwg_oli").looks).toEqual([]);
    expect(db.grants.find((x) => x.id === "hwg_old").looks).toEqual([]);
  });
});

describe("POST /api/trainer/clients: list", () => {
  it("the trainer's live clients by name: ref, name, since, lastLooked; signal (null here: the roster is stubbed), no training data, nothing written", async () => {
    const res = await list(session(T, "cT"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      me: { name: "Tia" },
      clients: [
        { ref: "hwg_abe", name: "Abe", since: 1_790_100_000_000, lastLooked: 1_790_200_000_000, signal: null },
        { ref: "hwg_cara", name: "Cara", since: 1_790_000_000_000, lastLooked: null, signal: null },
      ],
    });
    expect(writes()).toEqual([]);
    expect(dataReads()).toEqual([]);
  });

  it("limits: 30 a minute per IP, 600 a day per trainer", async () => {
    await list(session(T, "cT"));
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-clients", 30]);
    const [, route, n, opts] = vi.mocked(rateLimitShared).mock.calls[0];
    expect([route, n, opts]).toEqual(["trainer-clients", 600, { windowMs: DAY, id: T }]);
  });

  it("signed out: 401, no lookup", async () => {
    const res = await list(null);
    expect(res.status).toBe(401);
    expect(calls.some((c) => /oauth_grants/.test(c.q))).toBe(false);
  });
});

describe("POST /api/trainer/clients: the clients notice", () => {
  const marks = () => writes().filter((c) => /^\s*INSERT INTO notice_marks /.test(c.q));
  const row = { recent: [], lastDate: null, userWeek: null, breaks: null };

  it("a roster that was logged and read marks clients seen, after the read, at the read's own time", async () => {
    vi.mocked(dbRosterSignals).mockResolvedValueOnce(new Map([["hwg_abe", row], ["hwg_cara", row]]));
    const res = await list(session(T, "cT"));
    expect(res.status).toBe(200);
    expect((await res.json()).clients.every((c) => c.signal !== null)).toBe(true);
    const m = marks();
    expect(m).toHaveLength(1);
    expect(writes()).toEqual(m);
    const [trainer, refs, opts] = vi.mocked(dbRosterSignals).mock.lastCall;
    expect([trainer, refs]).toEqual([T, ["hwg_abe", "hwg_cara"]]);
    expect(m[0].v).toEqual([T, "clients", opts.now]);
    // After the mark, only the trainer's own name is read.
    expect(calls.slice(calls.indexOf(m[0]) + 1).map((c) => c.q.trim().split(/\s+/).slice(0, 4).join(" "))).toEqual(["SELECT handle, display FROM"]);
  });

  it("no mark when the roster could not be logged or read, when there are no live clients, or on remove", async () => {
    const t = session(T, "cT");
    expect((await list(t)).status).toBe(200); // dbRosterSignals answers null here: the log failed
    db.grants = db.grants.filter((g) => g.trainer_account_id !== T);
    expect((await (await list(t)).json()).clients).toEqual([]);
    await post(clientsPOST, "clients", t, { remove: "hwg_nope" });
    expect(marks()).toEqual([]);
  });

  it("a mark that fails never fails the list", async () => {
    vi.mocked(dbRosterSignals).mockResolvedValueOnce(new Map([["hwg_abe", row], ["hwg_cara", row]]));
    failOn = /^\s*INSERT INTO notice_marks /;
    const res = await list(session(T, "cT"));
    expect(res.status).toBe(200);
    expect((await res.json()).clients.map((c) => c.ref)).toEqual(["hwg_abe", "hwg_cara"]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("POST /api/trainer/clients: remove", () => {
  it("ends the grant by UPDATE revoked_at, revoked_by 'trainer'; the row stays and leaves the list", async () => {
    const t = session(T, "cT");
    const res = await post(clientsPOST, "clients", t, { remove: "hwg_cara" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].v.slice(1)).toEqual(["hwg_cara", T]);
    const g = db.grants.find((x) => x.id === "hwg_cara");
    expect(g.revoked_by).toBe("trainer");
    expect(g.revoked_at).toBe(w[0].v[0]);
    expect(db.grants).toHaveLength(6);
    expect((await (await list(t)).json()).clients.map((c) => c.ref)).toEqual(["hwg_abe"]);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-clients-remove", 20]);
  });

  it("another trainer's client, an ended grant, unknown or malformed: 404 and nothing changes", async () => {
    const t = session(T, "cT");
    const before = JSON.stringify(db.grants);
    for (const ref of ["hwg_oli", "hwg_old", "hwg_nope", null, 7]) {
      const res = await post(clientsPOST, "clients", t, { remove: ref });
      expect(res.status, String(ref)).toBe(404);
      expect(await res.text()).toBe(NOT_SHARED);
    }
    expect(JSON.stringify(db.grants)).toBe(before);
  });
});

describe("SQL pins", () => {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const run = async (fn) => { calls.length = 0; await fn(); return calls; };

  it("liveness: one join on the open client account and its native approving passkey; with a ref, that grant only", async () => {
    const BASE = "SELECT g.id, g.profile, g.scope, g.created_at, g.last_used_at, g.edits_at, g.edits_off_at, g.consent_version, h.handle, h.display FROM oauth_grants g"
      + " JOIN accounts a ON a.id = g.account_id AND a.deleted_at IS NULL"
      + " JOIN credentials c ON c.id = g.credential_id AND c.account_id = g.account_id AND c.rp_id = 'heatwayve.app'"
      + " LEFT JOIN handles h ON h.account_id = g.account_id AND h.kind = 'primary' AND h.released_at IS NULL"
      + " WHERE g.kind = 'trainer' AND g.trainer_account_id = ? AND g.revoked_at IS NULL";
    const t = session(T, "cT");
    const all = (await run(() => list(t))).find((c) => /FROM oauth_grants g/.test(c.q));
    expect(norm(all.q)).toBe(`${BASE} ORDER BY g.created_at DESC`);
    expect(all.v).toEqual([T]);
    const one = (await run(() => view(t, { ref: "hwg_cara", today: TODAY }))).find((c) => /FROM oauth_grants g/.test(c.q));
    expect(norm(one.q)).toBe(`${BASE} AND g.id = ? ORDER BY g.created_at DESC`);
    expect(one.v).toEqual([T, "hwg_cara"]);
  });

  it("the full-look statement: 15-minute coalesce on both looks and look_count, ring of 20, scoped to this trainer's live grant", async () => {
    const now = 1_800_000_000_000;
    const c = (await run(() => dbLogFullLook("hwg_cara", T, now))).find((x) => /UPDATE oauth_grants/.test(x.q));
    expect(norm(c.q)).toBe(norm(`UPDATE oauth_grants SET
      looks = CASE
        WHEN looks->0->>'k' = 'v' AND (looks->0->>'at')::bigint > ?::bigint - 900000
          THEN jsonb_set(looks, '{0,at}', to_jsonb(?::bigint))
        ELSE jsonb_path_query_array(
          jsonb_build_array(jsonb_build_object('k', 'v', 'at', ?::bigint)) || COALESCE(looks, '[]'::jsonb),
          '$[0 to 19]')
      END,
      look_count = CASE
        WHEN looks->0->>'k' = 'v' AND (looks->0->>'at')::bigint > ?::bigint - 900000
          THEN COALESCE(look_count, 0)
        ELSE COALESCE(look_count, 0) + 1
      END,
      last_used_at = ?
    WHERE id = ? AND kind = 'trainer' AND trainer_account_id = ? AND revoked_at IS NULL
    RETURNING id`));
    expect(c.v).toEqual([now, now, now, now, now, "hwg_cara", T]);
  });

  it("the routes write only through the store and never DELETE", () => {
    const root = resolve(__dirname, "..");
    for (const f of ["app/api/trainer/client/route.js", "app/api/trainer/clients/route.js"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, f).not.toMatch(/\bq`|\bsql\(|\bDELETE\b|\bdel\(/);
    }
    // The client route reads the profile only after the log statement.
    const src = readFileSync(resolve(root, "app/api/trainer/client/route.js"), "utf8");
    expect(src.indexOf("await dbLogFullLook(")).toBeGreaterThan(-1);
    expect(src.indexOf("await dbReadProfile(")).toBeGreaterThan(src.indexOf("await dbLogFullLook("));
  });
});
