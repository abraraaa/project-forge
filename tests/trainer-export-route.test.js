// POST /api/trainer/export: the trainer's CSV download of one client. The Neon
// driver is faked with small in-memory tables (as in tests/trainer-routes.test.js),
// so the gate, the store, the rate count, db.js's profile read and the route run
// for real and every statement is captured. The only writes allowed: the
// day's rate count (an upsert), the full-look ring UPDATE and the gate's daily
// session INSERT. Nothing is ever deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const DAY = 86400000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer
const N = id26("n"); // another trainer
const C = id26("c"); // client "cara"
const L = id26("l"); // a lifter, not a trainer

const db = { tokens: new Map(), accounts: new Map(), handles: [], credentials: [], grants: [], meta: [], sessions: [], changes: [], buckets: new Map() };
const calls = [];
let failOn = null;

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
    if (/^\s*INSERT INTO auth_tokens/.test(q)) return [];
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
    if (/^\s*SELECT g\.id, g\.profile, g\.scope, g\.created_at, g\.last_used_at, g\.edits_at, g\.edits_off_at, h\.handle, h\.display\s+FROM oauth_grants g/.test(q)) {
      const [t, ref] = v;
      return db.grants
        .filter((g) => liveGrant(g, t) && (ref === undefined || g.id === ref))
        .map((g) => {
          const h = db.handles.find((x) => x.account_id === g.account_id && x.released_at == null);
          return { id: g.id, profile: g.profile, scope: g.scope, created_at: String(g.created_at), last_used_at: null,
            edits_at: g.edits_at == null ? null : String(g.edits_at), edits_off_at: null, handle: h?.handle ?? null, display: h?.display ?? null };
        });
    }
    if (/^\s*UPDATE oauth_grants SET\s+looks = CASE/.test(q)) {
      const now = v[0];
      const [ref, t] = v.slice(-2);
      const g = db.grants.find((x) => x.id === ref && x.kind === "trainer" && x.trainer_account_id === t && x.revoked_at == null);
      if (!g) return [];
      const top = g.looks?.[0];
      const coalesce = top?.k === "v" && Number(top.at) > now - 900000;
      g.looks = coalesce ? [{ ...top, at: now }, ...g.looks.slice(1)] : [{ k: "v", at: now }, ...(g.looks ?? [])].slice(0, 20);
      g.look_count = (g.look_count ?? 0) + (coalesce ? 0 : 1);
      g.last_used_at = v[4];
      return [{ id: g.id }];
    }
    // failureGate's count: a read, then an in-place upsert per bucket and window.
    if (/^\s*SELECT count FROM rate_buckets WHERE bucket = \? AND window_start = \?$/.test(q)) {
      const b = db.buckets.get(v[0]);
      return b && b.window_start === v[1] ? [{ count: b.count }] : [];
    }
    if (/^\s*INSERT INTO rate_buckets \(bucket, window_start, count\) VALUES \(\?, \?, 1\)\s+ON CONFLICT \(bucket\) DO UPDATE/.test(q)) {
      const [bucket, ws] = v;
      const b = db.buckets.get(bucket);
      const next = b && b.window_start === ws ? { window_start: ws, count: b.count + 1 } : { window_start: ws, count: 1 };
      db.buckets.set(bucket, next);
      return [{ count: next.count }];
    }
    if (/^\s*SELECT now\(\) AS t$/.test(q)) return [{ t: new Date() }];
    if (/^\s*SELECT c\.id, c\.set_id, .* AS edits_live\s+FROM trainer_changes c LEFT JOIN oauth_grants g/s.test(q)) {
      const [ref, t] = v;
      return db.changes.filter((c) => c.grant_id === ref && c.author_account_id === t)
        .map((c) => ({ ...c, created_at: String(c.created_at), edits_live: true }));
    }
    if (/^\s*SELECT count\(DISTINCT set_id\)::int AS used, min\(created_at\) AS oldest FROM trainer_changes/.test(q)) {
      return [{ used: 0, oldest: null }];
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
// The per-IP minute limit is in memory; the daily count (failureGate) runs for real on the fake.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({ ...(await importOriginal()), rateLimit: vi.fn(() => null) }));

const exportRoute = await import("@/app/api/trainer/export/route");
const { POST, EXPORTS_PER_DAY } = exportRoute;
const { TRAINER_COOKIE } = await import("@/lib/trainer-session");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { rateLimit } = await import("@/lib/rate-limit");

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, sk, roles, trainer_terms = null) => ({
  id, storage_key: sk, webauthn_user_id: "u-" + sk, roles, plan: "free", consent: null, trainer_terms,
  origin: "claim", created_at: null, lapsed_at: null, deleted_at: null,
});
let seq = 0;
const session = (acct, cred, { scope = "trainer" } = {}) => {
  const token = `tok-${++seq}`;
  db.tokens.set(hash(token), {
    profile: db.accounts.get(acct).storage_key, expires: Date.now() + 14 * DAY, scope,
    created_at: new Date(Date.now() - 60_000).toISOString(), auth_at: new Date(Date.now() - 60_000).toISOString(),
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
const dataReads = () => calls.filter((c) => /FROM (meta|sessions)\b/.test(c.q));
const lookAt = () => calls.findIndex((c) => /^\s*UPDATE oauth_grants SET\s+looks = CASE/.test(c.q));
const H = "https://heatwayve.app/api/trainer/export";
/** @type {Request[]} */
const sent = [];
// body: an object is sent as JSON; a string is sent as is (a malformed body); undefined sends none.
const post = (token, body) => {
  const req = new NextRequest(H, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { cookie: `${TRAINER_COOKIE}=${token}` } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  sent.push(req);
  return POST(req);
};
const BOM = [0xef, 0xbb, 0xbf];
const NOT_SHARED = JSON.stringify({ error: "Not shared with you now." });

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const SQUAT = "Barbell Back Squat";
const record = (date) => ({
  id: `${date}T07:13:42.000Z`, date, session: "strength-a", scheduledLetter: "A", readiness: "cooked",
  readinessReason: "SENTINEL-reason", bodyweight: 777.22, hoursSlept: 777.33, startedAt: 1777777777777, notes: "SENTINEL-notes",
  blocks: [{ type: "main", exercises: [{ name: SQUAT, muscle: "Quads", loadType: "barbell", prescribed: { weight: 100 }, sets: [
    { weight: 100, reps: 5, rpe: 8, rir: 2, loadType: "barbell", bodyweightUsed: 81.37, effectiveLoad: 778.11, est1rm: 778.22, volume: 778.33 },
  ] }] }],
});
// The allow-list canary: forbidden fields planted on the stored meta, under their real names.
const PLANTED_META = {
  displayName: "SENTINEL-displayName", bodyweight: 779.11, bodyweightLog: [{ date: TODAY, kg: 779.22 }],
  photos: ["SENTINEL-photo.jpg"], est1rm: { [SQUAT]: 779.33 }, sleep: [{ date: TODAY, hours: 779.44 }],
  breaks: [{ id: "2026-09-01T08:15:16.000Z", start: daysAgo(3), reason: "injured", endedAt: null }],
};
const FORBIDDEN = ["SENTINEL", "777.", "778.", "779.", "81.37", "injured", "07:13:42", "08:15:16", "1777777777777", "est1rm", "bodyweight", "photo"];

beforeEach(() => {
  calls.length = 0;
  failOn = null;
  db.tokens.clear();
  db.buckets.clear();
  db.accounts = new Map([
    [T, account(T, "tia", ["lifter", "trainer"], CURRENT)],
    [N, account(N, "nia", ["lifter", "trainer"], { ...CURRENT, version: "draft-2026-10" })],
    [C, account(C, "sk-cara", ["lifter"])],
    [L, account(L, "sk-leo", ["lifter"])],
  ]);
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T, released_at: null },
    { handle: "nia", display: "Nia", account_id: N, released_at: null },
    { handle: "cara", display: "Cara", account_id: C, released_at: null },
    { handle: "leo", display: "Leo", account_id: L, released_at: null },
  ];
  db.credentials = [
    { id: "cT", account_id: T, rp_id: "heatwayve.app" },
    { id: "cN", account_id: N, rp_id: "heatwayve.app" },
    { id: "cC", account_id: C, rp_id: "heatwayve.app" },
    { id: "cL", account_id: L, rp_id: "heatwayve.app" },
  ];
  db.grants = [
    grant("hwg_cara", C, T, "cC"),
    grant("hwg_old", C, T, "cC", { revoked_at: 1_789_000_000_000 }),
  ];
  db.meta = Object.entries(PLANTED_META).map(([field, value]) => ({ profile: "sk-cara", field, value }));
  db.sessions = [daysAgo(1), daysAgo(200)].map((d) => ({ profile: "sk-cara", id: `${d}T07:13:42.000Z`, record: record(d) }));
  db.changes = [];
  process.env.DATABASE_URL = "postgres://fake";
  vi.mocked(rateLimit).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("POST /api/trainer/export", () => {
  it("is POST only, the grant ref in the JSON body and never in the URL", async () => {
    expect(exportRoute).not.toHaveProperty("GET");
    sent.length = 0;
    const res = await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    expect(sent.map((r) => [r.method, r.url])).toEqual([["POST", H]]);
    for (const r of sent) expect(r.url).not.toContain("hwg_");
  });

  it("answers the client's CSV as an attachment, never cached, with a UTF-8 BOM first", async () => {
    const res = await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="heatwayve-cara-${TODAY}.csv"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual(BOM);
    // The comment line follows the mark directly.
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).startsWith("\uFEFF# Heatwayve export for Cara")).toBe(true);
    // text() decodes UTF-8 and drops the mark, as a spreadsheet does.
    const text = await res.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(`# Heatwayve export for Cara, ${TODAY}, shared with Tia`);
    expect(lines[1]).toBe("date,session,block,lift,set,prescribed_reps,reps,kg,felt,top_set,set_by");
    expect(lines).toContain(`${daysAgo(1)},A,main,${SQUAT},1,,5,100,RPE 8,1,`);
    expect(lines).toContain(`${daysAgo(200)},,main,${SQUAT},top,,5,100,RPE 8,1,`);
  });

  it("logs the look before reading the client's data, by the grant's storage key; the only writes are the count and the look", async () => {
    const res = await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    const iLog = lookAt();
    const reads = dataReads();
    expect(iLog).toBeGreaterThan(-1);
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect(calls.indexOf(r)).toBeGreaterThan(iLog);
      expect(r.v).toEqual(["sk-cara"]);
    }
    expect(writes().map((w) => w.q.trim().replace(/\s+/g, " ").slice(0, 24))).toEqual(["INSERT INTO rate_buckets", "UPDATE oauth_grants SET "]);
    const g = db.grants.find((x) => x.id === "hwg_cara");
    expect(g.look_count).toBe(1);
    expect(g.looks[0].k).toBe("v");
  });

  it("the day's count is taken only after the grant is found live, then the look, then the read", async () => {
    const res = await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    const at = (re) => calls.findIndex((c) => re.test(c.q));
    const iGrant = at(/FROM oauth_grants g/);
    const iCount = at(/FROM rate_buckets/);
    const iStrike = at(/^\s*INSERT INTO rate_buckets/);
    const iRead = calls.indexOf(dataReads()[0]);
    expect(iGrant).toBeGreaterThan(-1);
    expect(iCount).toBeGreaterThan(iGrant);
    expect(iStrike).toBeGreaterThan(iCount);
    expect(lookAt()).toBeGreaterThan(iStrike);
    expect(iRead).toBeGreaterThan(lookAt());
  });

  it("an export straight after a look coalesces with it, as the client route's looks do", async () => {
    const t = session(T, "cT");
    await post(t, { ref: "hwg_cara", today: TODAY });
    await post(t, { ref: "hwg_cara", today: TODAY });
    const g = db.grants.find((x) => x.id === "hwg_cara");
    expect(g.look_count).toBe(1);
    expect(g.looks).toHaveLength(1);
  });

  it("canary: bodyweight, photos, est1rm, sleep, breather reasons and start times never reach the file", async () => {
    const text = await (await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).text();
    expect(text).toContain(SQUAT);
    for (const f of FORBIDDEN) expect(text, f).not.toContain(f);
    expect(calls.some((c) => /photo/i.test(c.q))).toBe(false);
  });

  it("unauthenticated: 401 before any lookup, count or read", async () => {
    for (const res of [
      await post(null, { ref: "hwg_cara" }),
      await POST(new NextRequest(H, { method: "POST", headers: { "content-type": "application/json", "x-hw-auth": session(T, "cT") }, body: JSON.stringify({ ref: "hwg_cara" }) })),
      await post(session(L, "cL", { scope: null }), { ref: "hwg_cara" }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls.some((c) => /oauth_grants|rate_buckets/.test(c.q))).toBe(false);
    expect(dataReads()).toEqual([]);
  });

  it("not entitled: a lifter's trainer-scoped session is refused (401, as the client route), stale Terms 403; nothing looked up", async () => {
    const lifter = await post(session(L, "cL"), { ref: "hwg_cara" });
    expect(lifter.status).toBe(401);
    const stale = await post(session(N, "cN"), { ref: "hwg_cara" });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ needsTerms: true });
    expect(stale.headers.get("cache-control")).toBe("no-store");
    expect(calls.some((c) => /oauth_grants|rate_buckets/.test(c.q))).toBe(false);
    expect(dataReads()).toEqual([]);
  });

  it("ended, unknown or missing grant: the client route's 404, nothing counted, logged or read", async () => {
    const t = session(T, "cT");
    const bodies = [{ ref: "hwg_old", today: TODAY }, { ref: "hwg_nope" }, { ref: "" }, {}, { ref: "x".repeat(129) }, { ref: 7 }, undefined, "{not json", "null"];
    for (const b of bodies) {
      calls.length = 0;
      const res = await post(t, b);
      expect(res.status, JSON.stringify(b)).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(NOT_SHARED);
      expect(writes(), JSON.stringify(b)).toEqual([]);
      expect(calls.some((c) => /rate_buckets/.test(c.q)), JSON.stringify(b)).toBe(false);
      expect(dataReads(), JSON.stringify(b)).toEqual([]);
    }
  });

  it(`rate limit: ${EXPORTS_PER_DAY} a day per grant, then 429 with nothing logged or read`, async () => {
    // The window is the UTC day: pinned mid-day so the eleven posts can't straddle midnight.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
    try {
      expect(EXPORTS_PER_DAY).toBe(10);
      const t = session(T, "cT");
      for (let i = 0; i < 10; i++) expect((await post(t, { ref: "hwg_cara", today: TODAY })).status).toBe(200);
      calls.length = 0;
      const res = await post(t, { ref: "hwg_cara", today: TODAY });
      expect(res.status).toBe(429);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await res.json()).toEqual({ error: "That's today's downloads. Try again tomorrow." });
      expect(lookAt()).toBe(-1);
      expect(dataReads()).toEqual([]);
      expect(writes()).toEqual([]);
      // The trainer's own export counts in its own bucket.
      expect((await post(t, { ref: "me", today: TODAY })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate limit fails closed: a count that can't be read or written is 503, nothing logged or read", async () => {
    const t = session(T, "cT");
    for (const re of [/^\s*SELECT count FROM rate_buckets/, /^\s*INSERT INTO rate_buckets/]) {
      calls.length = 0;
      failOn = re;
      const res = await post(t, { ref: "hwg_cara", today: TODAY });
      expect(res.status, String(re)).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(lookAt()).toBe(-1);
      expect(dataReads()).toEqual([]);
    }
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-export", 30]);
  });

  it("if the look can't be logged: 503 and the client's data is never read", async () => {
    failOn = /^\s*UPDATE oauth_grants SET\s+looks = CASE/;
    const res = await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(503);
    expect(dataReads()).toEqual([]);
  });

  it("with the client's changes on, set_by names the trainer on the lift and date they trained at the change", async () => {
    Object.assign(db.grants[0], { edits_at: Date.now() - 3 * DAY });
    const RECORD_ID = `${daysAgo(1)}T07:13:42.000Z`;
    db.meta.push({ profile: "sk-cara", field: "weights", value: { [SQUAT]: 100 } });
    db.changes = [{
      id: "hws_" + "t".repeat(26) + ".0", set_id: "hws_" + "t".repeat(26), grant_id: "hwg_cara", author_account_id: T, source: "trainer",
      status: "sent", kind: "weight", target: SQUAT, old_value: 95, new_value: 100, basis: { anchorId: RECORD_ID, trainedId: RECORD_ID, w: 95, r: null },
      warnings: [], effective_from: null, created_at: Date.now() - 2 * DAY, applied_at: `${daysAgo(2)}T09:00:00.000Z`, outcome: "applied",
      undone_at: null, undone_by: null, reverted_at: null,
    }];
    const text = await (await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY })).text();
    const lines = text.split("\r\n");
    // Trained at the session after it landed (prescribed 100): that set was the trainer's.
    expect(lines).toContain(`${daysAgo(1)},A,main,${SQUAT},1,,5,100,RPE 8,1,Tia`);
    // The older top set predates the change.
    expect(lines).toContain(`${daysAgo(200)},,main,${SQUAT},top,,5,100,RPE 8,1,`);
    // The changes are read after the look, like the profile.
    expect(calls.findIndex((c) => /FROM trainer_changes c LEFT JOIN/.test(c.q))).toBeGreaterThan(lookAt());
  });

  it("a client whose handle leaves nothing ASCII is saved as heatwayve-client-<date>.csv, never by the grant ref", async () => {
    db.handles.find((h) => h.account_id === C).display = "名前";
    db.handles.find((h) => h.account_id === C).handle = "名前";
    const res = await post(session(T, "cT"), { ref: "hwg_cara", today: TODAY });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="heatwayve-client-${TODAY}.csv"`);
  });

  it("{ ref: \"me\" }: the trainer's own training, no grant, no look; counted per trainer", async () => {
    db.sessions.push({ profile: "tia", id: `${daysAgo(1)}T07:13:42.000Z`, record: record(daysAgo(1)) });
    const res = await post(session(T, "cT"), { ref: "me", today: TODAY });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="heatwayve-tia-${TODAY}.csv"`);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe(`# Heatwayve export for Tia, ${TODAY}`);
    expect(calls.some((c) => /oauth_grants/.test(c.q))).toBe(false);
    for (const r of dataReads()) expect(r.v).toEqual(["tia"]);
    expect(writes().map((w) => w.q.trim().slice(0, 24))).toEqual(["INSERT INTO rate_buckets"]);
  });
});
