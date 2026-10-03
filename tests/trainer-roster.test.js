// Trainer roster signal: the pure line (rosterSignal), and the list route's
// one transaction that logs a roster look on every listed grant before one
// aggregate read. The Neon driver is faked with small in-memory tables, so the
// gate, the store and the route run for real and every statement is captured.
// The only writes allowed: the roster ring UPDATE and the gate's daily session
// INSERT. Nothing is ever deleted, and no client's profile is read whole.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import {
  rosterSignal, rosterDay, nextLooks, SIGNAL_KEYS, ROSTER_RECENT_DAYS, TREND_DAYS,
} from "@/lib/trainer-view";
import { makeDayContext, weeklyStrength, strengthRhythm } from "@/lib/day-state";
import { ensureScheduleHistory, scheduleEntryOn, normaliseWeek } from "@/lib/sync-merge";
import { isResting } from "@/lib/breaks";
import { addDaysIso, daysBetween } from "@/lib/dates";

const DAY = 86400000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const T = id26("t"); // trainer
const N = id26("n"); // another trainer
const A = id26("a"); // client "abe": trains Mon/Wed/Fri
const C = id26("c"); // client "cara": on an open breather, nothing in a year
const P = id26("p"); // client whose approving passkey is gone
const O = id26("o"); // client of the other trainer

const db = { tokens: new Map(), accounts: new Map(), handles: [], credentials: [], grants: [], meta: [], sessions: [] };
const calls = [];
const txns = [];
let failOn = null;    // a statement matching this throws
let leakyRead = false; // the read hands back whole records and whole meta, as if its SQL selected everything

const liveGrant = (g, t) => {
  const a = db.accounts.get(g.account_id);
  return g.kind === "trainer" && g.trainer_account_id === t && g.revoked_at == null && a && a.deleted_at == null
    && db.credentials.some((c) => c.id === g.credential_id && c.account_id === g.account_id && c.rp_id === "heatwayve.app");
};
const metaValue = (profile, field) => db.meta.find((m) => m.profile === profile && m.field === field)?.value ?? null;
const recDate = (s) => s.record?.date;

function run(q, v) {
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
  if (/^\s*SELECT g\.id, g\.profile, g\.scope, g\.created_at, g\.last_used_at, h\.handle, h\.display\s+FROM oauth_grants g/.test(q)) {
    const [t, ref] = v;
    return db.grants
      .filter((g) => liveGrant(g, t) && (ref === undefined || g.id === ref))
      .sort((a, b) => b.created_at - a.created_at)
      .map((g) => {
        const h = db.handles.find((x) => x.account_id === g.account_id && x.released_at == null);
        return { id: g.id, profile: g.profile, scope: g.scope, created_at: String(g.created_at),
          last_used_at: g.last_used_at == null ? null : String(g.last_used_at), handle: h?.handle ?? null, display: h?.display ?? null };
      });
  }
  if (/^\s*UPDATE oauth_grants SET\s+looks = jsonb_path_query_array\(/.test(q)) {
    // The roster ring statement, by hand: prepend { k:'r', d, at } unless the
    // ring already holds that day's roster entry; keep the newest 20.
    const [day, now, refs, t, guardDay] = v;
    expect(guardDay).toBe(day);
    const hit = db.grants.filter((g) => refs.includes(g.id) && g.kind === "trainer" && g.trainer_account_id === t && g.revoked_at == null
      && !(g.looks ?? []).some((e) => e?.k === "r" && e.d === day));
    for (const g of hit) {
      g.looks = [{ k: "r", d: day, at: now }, ...(g.looks ?? [])].slice(0, 20);
      g.look_count = (g.look_count ?? 0) + 1;
    }
    return [];
  }
  if (/^\s*SELECT g\.id AS ref,/.test(q)) {
    const [recentFrom, today1, trendFrom, today2, refs, t] = v;
    return db.grants
      .filter((g) => refs.includes(g.id) && g.kind === "trainer" && g.trainer_account_id === t && g.revoked_at == null)
      .map((g) => {
        const mine = db.sessions.filter((s) => s.profile === g.profile);
        const recent = mine.filter((s) => recDate(s) >= recentFrom && recDate(s) <= today1).sort((a, b) => a.id.localeCompare(b.id));
        const dates = mine.map(recDate).filter((d) => d >= trendFrom && d <= today2).sort();
        return {
          ref: g.id,
          recent: leakyRead
            ? recent.map((s) => s.record)
            : recent.map((s) => ({ id: s.id, date: s.record.date, session: s.record.session ?? null, scheduledLetter: s.record.scheduledLetter ?? null })),
          last_date: dates.length ? dates[dates.length - 1] : null,
          user_week: metaValue(g.profile, "userWeek"),
          breaks: metaValue(g.profile, "breaks"),
          ...(leakyRead ? { meta: db.meta.filter((m) => m.profile === g.profile) } : {}),
        };
      });
  }
  throw new Error(`unexpected SQL: ${q}`);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    // Lazy like the driver: a statement runs when awaited, or in its turn inside a transaction.
    const tag = (strings, ...v) => {
      const q = strings.join("?");
      const exec = async () => (/^\s*(CREATE|ALTER)\b/.test(q) ? [] : run(q, v));
      return { q, exec, then: (ok, ko) => exec().then(ok, ko) };
    };
    tag.transaction = async (queries) => {
      txns.push(queries.map((s) => s.q));
      const snapshot = structuredClone(db.grants);
      const out = [];
      try {
        for (const s of queries) out.push(await s.exec());
      } catch (e) {
        db.grants = snapshot;
        throw e;
      }
      return out;
    };
    return tag;
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));

const { POST: clientsPOST } = await import("@/app/api/trainer/clients/route");
const { TRAINER_COOKIE } = await import("@/lib/trainer-session");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { dbRosterSignals } = await import("@/lib/trainer-store");

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, sk, roles, trainer_terms = null) => ({
  id, storage_key: sk, webauthn_user_id: "u-" + sk, roles, plan: "free", consent: null, trainer_terms,
  origin: "claim", created_at: null, lapsed_at: null, deleted_at: null,
});
let seq = 0;
const session = (acct, cred) => {
  const token = `tok-${++seq}`;
  db.tokens.set(hash(token), {
    profile: db.accounts.get(acct).storage_key, expires: Date.now() + 14 * DAY - 60_000, scope: "trainer",
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
const rosterWrites = () => calls.filter((c) => /^\s*UPDATE oauth_grants/.test(c.q));
const profileReads = () => calls.filter((c) => /^\s*SELECT (record FROM sessions|field, value FROM meta)\b/.test(c.q));
const list = (token, body) => clientsPOST(new NextRequest("https://heatwayve.app/api/trainer/clients", {
  method: "POST", headers: { "content-type": "application/json", cookie: `${TRAINER_COOKIE}=${token}` }, body: JSON.stringify(body),
}));
const G = (id) => db.grants.find((g) => g.id === id);

// Friday 2 October 2026, mid-morning in London.
const NOW = Date.parse("2026-10-02T10:00:00.000Z");
const TODAY = "2026-10-02";

// Every field the trainer must never see, under its real name, with a sentinel value.
const plantedRecord = (date, letter, time = "07:13:42") => ({
  id: `${date}T${time}.000Z`, date, dow: 3, profileName: "SENTINEL-profileName", schemaVersion: 3,
  loggedTz: "SENTINEL/Zone", loggedTzOffset: 777.11, session: `strength-${letter.toLowerCase()}`, blockNumber: 4, weekStart: date,
  scheduledLetter: letter, mesocyclePhase: "SENTINEL-phase", readiness: "cooked", readinessReason: "SENTINEL-readinessReason",
  bodyweight: 777.22, hoursSlept: 777.33, sleep: 777.34, daysSinceLast: 777.44, startedAt: 1777777777777, duration: 777.55,
  retrospective: "SENTINEL-retro", notes: "SENTINEL-notes", comment: "SENTINEL-comment", intent: "SENTINEL-recIntent",
  summary: { totalVolume: 777.66, avgRir: 777.77 },
  photos: ["SENTINEL-recPhoto.jpg"],
  blocks: [{
    id: "SENTINEL-blockId", type: "main", intent: "SENTINEL-intent",
    exercises: [{
      name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell", tempo: "SENTINEL-tempo",
      notes: "SENTINEL-exNotes", summary: { totalVolume: 777.99 },
      sets: [{ weight: 100, reps: 5, rpe: 8, rir: 2, loadType: "barbell", bodyweightUsed: 81.37, effectiveLoad: 778.11,
        est1rm: 778.22, volume: 778.33, comment: "SENTINEL-setComment" }],
    }],
  }],
});
const MON_WED_FRI = [
  { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "zone2" }, { type: "rest" }];
const plantedMeta = (profile, breaks) => [
  { profile, field: "displayName", value: "SENTINEL-displayName" },
  { profile, field: "bodyweight", value: 779.11 },
  { profile, field: "bodyweightLog", value: [{ date: TODAY, kg: 779.22 }] },
  { profile, field: "hoursSlept", value: 779.23 },
  { profile, field: "trainingState", value: { note: "SENTINEL-trainingState" } },
  { profile, field: "photos", value: ["SENTINEL-photo.jpg"] },
  { profile, field: "notes", value: "SENTINEL-metaNotes" },
  { profile, field: "breaks", value: breaks },
  { profile, field: "userWeek", value: [{ editedAt: "2026-03-03T09:41:27.000Z", effectiveFrom: "2026-03-02", week: MON_WED_FRI }] },
];
const FORBIDDEN = ["SENTINEL", "777.", "778.", "779.", "81.37", "injured", "ill", "07:13:42", "09:41:27", "08:15:16", "1777777777777",
  "readiness", "bodyweight", "hoursSlept", "sleep", "notes", "comment", "intent", "photo", "startedAt", "editedAt", "reason", "recent", "userWeek"];

// Abe trained every Mon/Wed/Fri of the last four weeks except Wed 16 Sep, and
// Mon and Wed this week; Friday (today) is still to come. One session is older
// than the roster read's 35 days.
const ABE_DATES = ["2026-08-01", "2026-09-07", "2026-09-09", "2026-09-11", "2026-09-14", "2026-09-18",
  "2026-09-21", "2026-09-23", "2026-09-25", "2026-09-28", "2026-09-30"];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  calls.length = 0;
  txns.length = 0;
  failOn = null;
  leakyRead = false;
  db.tokens.clear();
  db.accounts = new Map([
    [T, account(T, "tia", ["lifter", "trainer"], CURRENT)],
    [N, account(N, "nia", ["lifter", "trainer"], CURRENT)],
    [A, account(A, "sk-abe", ["lifter"])],
    [C, account(C, "sk-cara", ["lifter"])],
    [P, account(P, "sk-pia", ["lifter"])],
    [O, account(O, "sk-oli", ["lifter"])],
  ]);
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T, released_at: null },
    { handle: "abe", display: "Abe", account_id: A, released_at: null },
    { handle: "cara", display: "Cara", account_id: C, released_at: null },
    { handle: "pia", display: "Pia", account_id: P, released_at: null },
    { handle: "oli", display: "Oli", account_id: O, released_at: null },
  ];
  db.credentials = [
    { id: "cT", account_id: T, rp_id: "heatwayve.app" },
    { id: "cA", account_id: A, rp_id: "heatwayve.app" },
    { id: "cC", account_id: C, rp_id: "heatwayve.app" },
    { id: "cO", account_id: O, rp_id: "heatwayve.app" },
  ];
  db.grants = [
    grant("hwg_abe", A, T, "cA", { created_at: 1_790_100_000_000, last_used_at: 1_790_200_000_000 }),
    grant("hwg_cara", C, T, "cC"),
    grant("hwg_pia", P, T, "cP-gone"),
    grant("hwg_oli", O, N, "cO"),
    grant("hwg_old", A, T, "cA", { revoked_at: 1_780_000_000_000, revoked_by: "replaced" }),
  ];
  db.sessions = [
    ...ABE_DATES.map((d, i) => ({ profile: "sk-abe", id: `${d}T07:13:42.000Z`, record: plantedRecord(d, "ABC"[i % 3]) })),
    { profile: "sk-cara", id: "2025-09-01T08:00:00.000Z", record: plantedRecord("2025-09-01", "A", "08:00:00") },
    { profile: "sk-oli", id: "2026-09-30T08:00:00.000Z", record: plantedRecord("2026-09-30", "A", "08:00:00") },
  ];
  db.meta = [
    ...plantedMeta("sk-abe", [{ id: "2026-08-10T08:15:16.000Z", start: "2026-08-10", reason: "ill", endedAt: "2026-08-17" }]),
    ...plantedMeta("sk-cara", [{ id: "2026-09-20T08:15:16.000Z", start: "2026-09-20", reason: "injured", endedAt: null }]),
  ];
});
beforeEach(() => { process.env.DATABASE_URL = "postgres://fake"; });
afterEach(() => {
  vi.useRealTimers();
  delete process.env.DATABASE_URL;
});

// ── The pure signal ─────────────────────────────────────────────────────────

const slim = (records) => records.map((r) => ({ id: r.id, date: r.date, session: r.session ?? null, scheduledLetter: r.scheduledLetter ?? null }));
const abeRow = () => ({
  recent: slim(ABE_DATES.filter((d) => d >= addDaysIso(TODAY, -ROSTER_RECENT_DAYS)).map((d, i) => plantedRecord(d, "ABC"[i % 3]))),
  lastDate: "2026-09-30",
  userWeek: [{ editedAt: "2026-03-03T09:41:27.000Z", effectiveFrom: "2026-03-02", week: MON_WED_FRI }],
  breaks: [{ id: "x", start: "2026-08-10", reason: "ill", endedAt: "2026-08-17" }],
});

describe("rosterSignal", () => {
  it("last trained, done and planned this week, 28-day rhythm, paused: exactly those five", () => {
    const s = rosterSignal(abeRow(), TODAY);
    // 11 strength days fell due in the 28 days (today is due, not missed); 10 were trained.
    expect(s).toEqual({ lastTrainedDaysAgo: 2, weekDone: 2, weekPlanned: 3, rhythmPct: 91, paused: false });
    expect(Object.keys(s)).toEqual([...SIGNAL_KEYS]);
    expect(SIGNAL_KEYS).toEqual(["lastTrainedDaysAgo", "weekDone", "weekPlanned", "rhythmPct", "paused"]);
  });

  it("an open breather gives paused, and takes its days out of planned and the rhythm", () => {
    // From Tue 15 Sep: the missed Wed 16 and today's Friday fall out; days trained anyway still count.
    const row = { ...abeRow(), breaks: [{ id: "x", start: "2026-09-15", reason: "injured", endedAt: null }] };
    expect(rosterSignal(row, TODAY)).toEqual({ lastTrainedDaysAgo: 2, weekDone: 2, weekPlanned: 2, rhythmPct: 100, paused: true });
    const ended = { ...abeRow(), breaks: [{ id: "x", start: "2026-09-29", reason: "injured", endedAt: "2026-10-01" }] };
    expect(rosterSignal(ended, TODAY).paused).toBe(false);
  });

  it("nothing in the window: last trained null; rhythm null when nothing fell due; week planned from the schedule", () => {
    expect(rosterSignal({ recent: [], lastDate: null, userWeek: null, breaks: null }, TODAY))
      .toEqual({ lastTrainedDaysAgo: null, weekDone: 0, weekPlanned: 3, rhythmPct: 0, paused: false });
    const resting = { recent: [], lastDate: null, userWeek: null, breaks: [{ start: "2026-08-01", endedAt: null }] };
    expect(rosterSignal(resting, TODAY)).toEqual({ lastTrainedDaysAgo: null, weekDone: 0, weekPlanned: 0, rhythmPct: null, paused: true });
    expect(rosterSignal(null, TODAY)).toEqual({ lastTrainedDaysAgo: null, weekDone: 0, weekPlanned: 3, rhythmPct: 0, paused: false });
  });

  it("trained today reads 0 days; a malformed or future last date reads null", () => {
    expect(rosterSignal({ ...abeRow(), lastDate: TODAY }, TODAY).lastTrainedDaysAgo).toBe(0);
    for (const bad of ["2026-9-30", "yesterday", 20260930, "2026-10-03"]) {
      expect(rosterSignal({ ...abeRow(), lastDate: bad }, TODAY).lastTrainedDaysAgo, String(bad)).toBeNull();
    }
  });

  it("whole records and whole meta in, five values out: nothing planted reaches the signal", () => {
    const row = {
      recent: ABE_DATES.slice(1).map((d, i) => plantedRecord(d, "ABC"[i % 3])),
      lastDate: "2026-09-30",
      userWeek: plantedMeta("sk-abe", []).find((m) => m.field === "userWeek").value,
      breaks: [{ id: "2026-09-01T08:15:16.000Z", start: "2026-08-10", reason: "injured", endedAt: "2026-08-17", note: "SENTINEL-breakNote" }],
      bodyweightLog: [{ date: TODAY, kg: 779.22 }], hoursSlept: 779.23, photos: ["SENTINEL-photo.jpg"], notes: "SENTINEL-rowNotes",
    };
    const s = rosterSignal(row, TODAY);
    expect(Object.keys(s)).toEqual([...SIGNAL_KEYS]);
    const text = JSON.stringify(s);
    for (const f of FORBIDDEN) expect(text, f).not.toContain(f);
    for (const k of ["lastTrainedDaysAgo", "weekDone", "weekPlanned", "rhythmPct"]) expect(Number.isInteger(s[k]), k).toBe(true);
    expect(typeof s.paused).toBe("boolean");
  });
});

// ── Equivalence: the 35-day slice gives the full-history numbers ────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** About 16 months of training on a changing schedule, with doubles, off-plan days, conditioning records and breathers. */
function generated(seed) {
  const rnd = mulberry32(seed);
  const types = ["strength", "rest", "zone2", "cardio", "hiit"];
  const week = () => Array.from({ length: 7 }, (_, i) => ({ type: i === 0 || rnd() < 0.4 ? "strength" : types[1 + Math.floor(rnd() * 4)] }));
  const userWeek = [
    { editedAt: "2025-06-01T09:00:00.000Z", effectiveFrom: "2025-06-02", week: week() },
    { editedAt: "2025-12-10T09:00:00.000Z", effectiveFrom: "2025-12-15", week: week() },
    { editedAt: "2026-05-20T09:00:00.000Z", effectiveFrom: "2026-05-25", week: week() },
    { editedAt: "2026-09-02T09:00:00.000Z", effectiveFrom: "2026-09-21", week: week() },
  ];
  const plan = (iso) => normaliseWeek(scheduleEntryOn(ensureScheduleHistory(userWeek), iso).week);
  const breaks = [
    { id: "b1", start: "2025-10-06", reason: "injured", endedAt: "2025-11-20" },
    { id: "b2", start: "2026-02-14", reason: "travel", endedAt: "2026-02-19" },
    { id: "b3", start: "2026-06-01", reason: "ill", endedAt: "2026-06-04" },
    { id: "b4", start: "2026-09-01", reason: "injured", endedAt: null },
  ];
  const history = [];
  let letter = 0;
  for (let iso = "2025-07-01"; iso <= "2026-10-31"; iso = addDaysIso(iso, 1)) {
    const resting = breaks.some((b) => b.start <= iso && (b.endedAt === null || iso < b.endedAt));
    const planned = plan(iso)[(new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7].type;
    let n = 0;
    if (planned === "strength") n = rnd() < (resting ? 0.1 : 0.75) ? 1 : 0;
    else if (rnd() < 0.08) n = 1;
    if (n && rnd() < 0.07) n = 2;
    for (let k = 0; k < n; k++) {
      const L = "ABC"[letter++ % 3];
      history.push({ ...plantedRecord(iso, L, `0${7 + k}:13:42`), scheduledLetter: rnd() < 0.15 ? undefined : L });
    }
    if (rnd() < 0.05) history.push({ id: `${iso}T18:00:00.000Z`, date: iso, session: "zone2" });
  }
  return { history, userWeek, breaks };
}

describe("rosterSignal on the roster read's slice equals the full-history numbers", () => {
  it("over 120 dates and generated histories with breathers and schedule changes", () => {
    const seen = { paused: new Set(), rhythmNull: new Set(), lastNull: new Set(), weekDone: new Set() };
    for (const seed of [1, 2, 3]) {
      const { history, userWeek, breaks } = generated(seed);
      const rnd = mulberry32(seed * 7919);
      for (let i = 0; i < 40; i++) {
        const today = addDaysIso("2025-07-01", Math.floor(rnd() * 488));
        // What the client's own phone held that day.
        const held = history.filter((r) => r.date <= today);
        const brk = breaks.filter((b) => b.start <= today).map((b) => ({ ...b, endedAt: b.endedAt && b.endedAt <= today ? b.endedAt : null }));
        const ctx = makeDayContext({
          todayIso: today, history: held, breaks: brk,
          weekFor: (iso) => { const e = scheduleEntryOn(ensureScheduleHistory(userWeek), iso); return e ? normaliseWeek(e.week) : null; },
        });
        const w = weeklyStrength(ctx, { weeks: 1 })[0];
        const r = strengthRhythm(ctx, { days: 28 });
        const inYear = held.filter((x) => x.date >= addDaysIso(today, -TREND_DAYS)).map((x) => x.date).sort();
        const full = {
          lastTrainedDaysAgo: inYear.length ? daysBetween(inYear[inYear.length - 1], today) : null,
          weekDone: w.done, weekPlanned: w.planned,
          rhythmPct: r.expected ? Math.round(100 * r.ratio) : null,
          paused: isResting(brk),
        };
        // The read's slice: 35 days of id, date, session and letter, ordered by id.
        const recent = slim(held.filter((x) => x.date >= addDaysIso(today, -ROSTER_RECENT_DAYS)))
          .sort((a, b) => a.id.localeCompare(b.id));
        const got = rosterSignal({ recent, lastDate: inYear.length ? inYear[inYear.length - 1] : null, userWeek, breaks: brk }, today);
        expect(got, `${seed} ${today}`).toEqual(full);
        seen.paused.add(got.paused);
        seen.rhythmNull.add(got.rhythmPct === null);
        seen.lastNull.add(got.lastTrainedDaysAgo === null);
        seen.weekDone.add(got.weekDone);
      }
    }
    // The dates cover the variants the roster renders.
    expect([...seen.paused].sort()).toEqual([false, true]);
    expect([...seen.rhythmNull].sort()).toEqual([false, true]);
    expect([...seen.lastNull].sort()).toEqual([false, true]);
    expect(seen.weekDone.size).toBeGreaterThanOrEqual(3);
  });

  it("a slice shorter than the read's would not do: 7 days gives a different answer on some date", () => {
    const { history, userWeek, breaks } = generated(1);
    let differs = 0;
    for (let i = 0; i < 120; i++) {
      const today = addDaysIso("2026-01-01", i * 2);
      const held = history.filter((r) => r.date <= today);
      const brk = breaks.filter((b) => b.start <= today).map((b) => ({ ...b, endedAt: b.endedAt && b.endedAt <= today ? b.endedAt : null }));
      const row = (days) => ({ recent: slim(held.filter((x) => x.date >= addDaysIso(today, -days))), lastDate: null, userWeek, breaks: brk });
      if (JSON.stringify(rosterSignal(row(7), today)) !== JSON.stringify(rosterSignal(row(ROSTER_RECENT_DAYS), today))) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });
});

describe("rosterDay", () => {
  it("is the London calendar date: 23:30 UTC on a summer date is already tomorrow; in winter it is today", () => {
    expect(rosterDay(Date.parse("2026-07-15T23:30:00.000Z"))).toBe("2026-07-16");
    expect(rosterDay(Date.parse("2026-07-15T22:59:59.000Z"))).toBe("2026-07-15");
    expect(rosterDay(Date.parse("2026-01-15T23:30:00.000Z"))).toBe("2026-01-15");
  });
});

// ── The route and the store ─────────────────────────────────────────────────

describe("POST /api/trainer/clients: the roster", () => {
  it("each live client carries the signal; a roster look is logged on each listed grant, nowhere else", async () => {
    const res = await list(session(T, "cT"), { today: TODAY });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      me: { name: "Tia" },
      clients: [
        { ref: "hwg_abe", name: "Abe", since: 1_790_100_000_000, lastLooked: 1_790_200_000_000,
          signal: { lastTrainedDaysAgo: 2, weekDone: 2, weekPlanned: 3, rhythmPct: 91, paused: false } },
        { ref: "hwg_cara", name: "Cara", since: 1_790_000_000_000, lastLooked: null,
          signal: { lastTrainedDaysAgo: null, weekDone: 0, weekPlanned: 0, rhythmPct: 0, paused: true } },
      ],
    });
    for (const id of ["hwg_abe", "hwg_cara"]) {
      expect(G(id).looks, id).toEqual([{ k: "r", d: TODAY, at: NOW }]);
      expect(G(id).look_count, id).toBe(1);
      expect(G(id).last_used_at, id).toBe(id === "hwg_abe" ? 1_790_200_000_000 : null); // a roster look is not a full look
    }
    for (const id of ["hwg_pia", "hwg_oli", "hwg_old"]) expect(G(id).looks, id).toEqual([]);
    expect(db.grants).toHaveLength(5);
  });

  it("one transaction, log then read, over the live refs; no whole profile is ever read", async () => {
    await list(session(T, "cT"), { today: TODAY });
    expect(txns).toHaveLength(1);
    expect(txns[0].map((q) => q.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual(["UPDATE oauth_grants", "SELECT g.id"]);
    const log = calls.findIndex((c) => /^\s*UPDATE oauth_grants/.test(c.q));
    const read = calls.findIndex((c) => /^\s*SELECT g\.id AS ref,/.test(c.q));
    expect(log).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(log);
    expect(calls[log].v[2]).toEqual(["hwg_abe", "hwg_cara"]);
    expect(calls[read].v[4]).toEqual(["hwg_abe", "hwg_cara"]);
    expect(profileReads()).toEqual([]);
    expect(writes().map((c) => c.q.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual(["UPDATE oauth_grants"]);
  });

  it("logs once per London day: a second load writes nothing new; the next day adds one entry", async () => {
    const t = session(T, "cT");
    await list(t, { today: TODAY });
    vi.setSystemTime(NOW + 3 * 3600_000);
    const again = await (await list(t, { today: TODAY })).json();
    expect(again.clients.every((c) => c.signal !== null)).toBe(true);
    expect(G("hwg_abe").looks).toEqual([{ k: "r", d: TODAY, at: NOW }]);
    expect(G("hwg_abe").look_count).toBe(1);
    vi.setSystemTime(NOW + DAY);
    await list(t, { today: "2026-10-03" });
    expect(G("hwg_abe").looks).toEqual([{ k: "r", d: "2026-10-03", at: NOW + DAY }, { k: "r", d: TODAY, at: NOW }]);
    expect(G("hwg_abe").look_count).toBe(2);
  });

  it("the ring keeps 20: a full ring pushes its oldest entry out, the count keeps every look; the JS mirror agrees", async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ k: "v", at: NOW - (i + 1) * DAY }));
    Object.assign(G("hwg_abe"), { looks: full, look_count: 57 });
    await list(session(T, "cT"), { today: TODAY });
    expect(G("hwg_abe").looks).toHaveLength(20);
    expect(G("hwg_abe").looks[0]).toEqual({ k: "r", d: TODAY, at: NOW });
    expect(G("hwg_abe").looks.slice(1)).toEqual(full.slice(0, 19));
    expect(G("hwg_abe").look_count).toBe(58);
    expect(nextLooks(full, { k: "r", d: TODAY }, NOW)).toEqual({ looks: G("hwg_abe").looks, added: 1 });
  });

  it("the roster day is London's: at 23:30 UTC on a summer date the look is dated tomorrow, the windows stay on the trainer's today", async () => {
    const late = Date.parse("2026-07-15T23:30:00.000Z");
    vi.setSystemTime(late);
    await list(session(T, "cT"), { today: "2026-07-15" });
    const log = calls.find((c) => /^\s*UPDATE oauth_grants/.test(c.q));
    expect([log.v[0], log.v[1], log.v[4]]).toEqual(["2026-07-16", late, "2026-07-16"]);
    expect(G("hwg_abe").looks).toEqual([{ k: "r", d: "2026-07-16", at: late }]);
    const read = calls.find((c) => /^\s*SELECT g\.id AS ref,/.test(c.q));
    expect(read.v).toEqual(["2026-06-10", "2026-07-15", "2025-07-15", "2026-07-15", ["hwg_abe", "hwg_cara"], T]);
  });

  it("an implausible today falls back to the server's UTC date for the windows", async () => {
    await list(session(T, "cT"), { today: "2027-01-01" });
    const read = calls.find((c) => /^\s*SELECT g\.id AS ref,/.test(c.q));
    expect(read.v.slice(0, 4)).toEqual([addDaysIso(TODAY, -35), TODAY, addDaysIso(TODAY, -365), TODAY]);
  });

  it("a log that throws: names and dates only, every signal null, nothing read, nothing written", async () => {
    failOn = /^\s*UPDATE oauth_grants SET\s+looks = jsonb_path_query_array/;
    const before = JSON.stringify(db.grants);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await list(session(T, "cT"), { today: TODAY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      me: { name: "Tia" },
      clients: [
        { ref: "hwg_abe", name: "Abe", since: 1_790_100_000_000, lastLooked: 1_790_200_000_000, signal: null },
        { ref: "hwg_cara", name: "Cara", since: 1_790_000_000_000, lastLooked: null, signal: null },
      ],
    });
    expect(calls.some((c) => /^\s*SELECT g\.id AS ref,/.test(c.q))).toBe(false);
    expect(profileReads()).toEqual([]);
    expect(JSON.stringify(db.grants)).toBe(before);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("a read that throws after the log rolls the log back and shows names only", async () => {
    failOn = /^\s*SELECT g\.id AS ref,/;
    const before = JSON.stringify(db.grants);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await list(session(T, "cT"), { today: TODAY })).json();
    expect(body.clients.map((c) => c.signal)).toEqual([null, null]);
    expect(JSON.stringify(db.grants)).toBe(before);
    errors.mockRestore();
  });

  it("no live clients: no transaction, no roster write", async () => {
    // Nia, once her one client's grant has been ended by the client.
    db.credentials.push({ id: "cN", account_id: N, rp_id: "heatwayve.app" });
    Object.assign(G("hwg_oli"), { revoked_at: NOW - DAY });
    const res = await list(session(N, "cN"), { today: TODAY });
    expect(await res.json()).toEqual({ me: { name: null }, clients: [] });
    expect(txns).toEqual([]);
    expect(rosterWrites()).toEqual([]);
    expect(await dbRosterSignals(T, [], { day: TODAY, today: TODAY, now: NOW })).toEqual(new Map());
    expect(txns).toEqual([]);
  });

  it("data minimisation: planted records and meta never reach the response, even if the read handed back everything", async () => {
    for (const leaky of [false, true]) {
      leakyRead = leaky;
      const res = await list(session(T, "cT"), { today: TODAY });
      const text = await res.text();
      for (const f of FORBIDDEN) expect(text, `${leaky} ${f}`).not.toContain(f);
      const body = JSON.parse(text);
      expect(Object.keys(body).sort()).toEqual(["clients", "me"]);
      for (const c of body.clients) {
        expect(Object.keys(c).sort(), c.ref).toEqual(["lastLooked", "name", "ref", "signal", "since"]);
        expect(Object.keys(c.signal), c.ref).toEqual([...SIGNAL_KEYS]);
      }
      expect(body.clients.map((c) => c.signal)).toEqual([
        { lastTrainedDaysAgo: 2, weekDone: 2, weekPlanned: 3, rhythmPct: 91, paused: false },
        { lastTrainedDaysAgo: null, weekDone: 0, weekPlanned: 0, rhythmPct: 0, paused: true },
      ]);
    }
  });
});

describe("SQL pins", () => {
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  it("the roster ring statement: once per London day by the @> guard, ring of 20, this trainer's live listed grants only", async () => {
    await dbRosterSignals(T, ["hwg_abe"], { day: TODAY, today: TODAY, now: NOW });
    const c = calls.find((x) => /^\s*UPDATE oauth_grants/.test(x.q));
    expect(norm(c.q)).toBe(norm(`UPDATE oauth_grants SET
      looks = jsonb_path_query_array(
        jsonb_build_array(jsonb_build_object('k', 'r', 'd', ?::text, 'at', ?::bigint)) || COALESCE(looks, '[]'::jsonb),
        '$[0 to 19]'),
      look_count = COALESCE(look_count, 0) + 1
    WHERE id = ANY(?) AND kind = 'trainer' AND trainer_account_id = ? AND revoked_at IS NULL
      AND NOT COALESCE(looks @> jsonb_build_array(jsonb_build_object('k', 'r', 'd', ?::text)), false)`));
    expect(c.v).toEqual([TODAY, NOW, ["hwg_abe"], T, TODAY]);
    expect(c.q).not.toMatch(/last_used_at|revoked_at =|DELETE/);
  });

  it("the read: one aggregate SELECT; sessions give only id, date, session and letter, over 35 days and 12 months", async () => {
    await dbRosterSignals(T, ["hwg_abe"], { day: TODAY, today: TODAY, now: NOW });
    const c = calls.find((x) => /^\s*SELECT g\.id AS ref,/.test(x.q));
    expect(norm(c.q)).toBe(norm(`SELECT g.id AS ref,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'date', s.record->>'date',
                'session', s.record->'session', 'scheduledLetter', s.record->'scheduledLetter') ORDER BY s.id), '[]'::jsonb)
         FROM sessions s WHERE s.profile = g.profile AND s.record->>'date' BETWEEN ? AND ?) AS recent,
      (SELECT max(s.record->>'date') FROM sessions s
         WHERE s.profile = g.profile AND s.record->>'date' BETWEEN ? AND ?) AS last_date,
      (SELECT m.value FROM meta m WHERE m.profile = g.profile AND m.field = 'userWeek') AS user_week,
      (SELECT m.value FROM meta m WHERE m.profile = g.profile AND m.field = 'breaks') AS breaks
    FROM oauth_grants g
    WHERE g.id = ANY(?) AND g.kind = 'trainer' AND g.trainer_account_id = ? AND g.revoked_at IS NULL`));
    expect(c.v).toEqual(["2026-08-28", TODAY, "2025-10-02", TODAY, ["hwg_abe"], T]);
    expect(c.q).not.toMatch(/s\.record\b(?!->>?'(date|session|scheduledLetter)')/);
  });
});
