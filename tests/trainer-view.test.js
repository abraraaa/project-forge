// What a trainer is shown of a client: the allow-list projection (both
// tiers), the schedule as runs, and the look ring's JS mirror. Pure; no DB.
import { describe, it, expect } from "vitest";
import {
  projectForTrainer, projectBreaks, scheduleRuns, runsWeekFor, nextLooks, trainerToday, rosterSignal, shownSetWeight,
  VIEW_KEYS, DETAIL_DAYS, TREND_DAYS, SELF_REF,
} from "@/lib/trainer-view";
import { mainLiftTrend, readinessBreakdown } from "@/lib/analytics";
import { auditHistoryVolume } from "@/lib/volume-audit";
import { makeDayContext, weeklyStrength, strengthRhythm } from "@/lib/day-state";
import { ensureScheduleHistory, scheduleEntryOn } from "@/lib/sync-merge";
import { addDaysIso, mondayOfWeekIso } from "@/lib/dates";
import { isResting } from "@/lib/breaks";
import { projectPlan, PLAN_KEYS, EDITS_STATUSES, editsStatus, projectForTrainer as projectWithPlan } from "@/lib/trainer-plan";
import { validateChangeSet, boundsFor, liftBasis, rowFromDb, weekBasis, anchorLogged, SETS_PER_WEEK } from "@/lib/trainer-change";
import { nextRung, CATEGORY_COLD_START_MAX_KG, getLiftProfile, isBodyweightMovement, sanitiseWorkingWeights } from "@/lib/lift-translations";
import { resolvedProgramme } from "@/lib/programme-resolve";

const TODAY = "2026-10-03";
const ago = (n, from = TODAY) => addDaysIso(from, -n);

// Seeded, so a failure reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Canary fixtures: every never-shared field, under its real name ─────────

const BW = 81.37; // the client's bodyweight: no output number may equal it
const set = (over = {}) => ({
  weight: 100, reps: 5, rpe: 8, rir: 2, loadType: "barbell", bodyweightUsed: BW, effectiveLoad: 7001.01,
  est1rm: 7001.02, volume: 7001.03, tempo: "CANARY-setTempo", reach: true, ...over,
});
const canaryRecord = (date, time, extra = {}) => ({
  id: `${date}T${time}.000Z`, date, dow: 3, profileName: "CANARY-profileName", schemaVersion: 3,
  loggedTz: "CANARY/Zone", loggedTzOffset: 7002.01, session: "strength-b", blockNumber: 2, weekStart: date,
  scheduledLetter: "B", mesocyclePhase: "CANARY-phase", readiness: "fresh", readinessReason: "CANARY-readinessReason",
  bodyweight: 7002.02, hoursSlept: 7002.03, daysSinceLast: 7002.04, startedAt: 1777777777777, duration: 7002.05,
  retrospective: "CANARY-retro", notes: "CANARY-notes", comment: "CANARY-comment",
  summary: { totalVolume: 7002.06, avgRir: 7002.07, completionRate: 7002.08 },
  blocks: [{
    id: "CANARY-blockId", type: "main", intent: "CANARY-intent", summary: { totalVolume: 7002.09 },
    exercises: [{
      id: "CANARY-exId", name: "Barbell Bench Press", muscle: "Chest", loadType: "barbell", swapped: true,
      fromPool: "CANARY-pool", tempo: "CANARY-tempo", prescribed: { weight: 7003.01, reps: 5 }, intent: "CANARY-exIntent",
      summary: { totalVolume: 7003.02, topSet: { est1rm: 7003.03 } }, notes: "CANARY-exNotes",
      sets: [set({ weight: 80, reps: 5 }), set({ weight: 82.5, reps: 4, rpe: 9, rir: 1, notes: "CANARY-setNotes" })],
    }, {
      name: "Pull-up", muscle: "Back", loadType: "bodyweight",
      // A vest set (proven: effectiveLoad = bodyweight + 10) and a stale working weight (effectiveLoad = bodyweight).
      sets: [set({ weight: 10, reps: 6, loadType: "bodyweight", effectiveLoad: BW + 10 }),
        set({ weight: 20, reps: 5, loadType: "bodyweight", effectiveLoad: BW })],
    }, {
      name: "Weighted Dip", muscle: "Chest", loadType: "loaded_bodyweight",
      sets: [set({ weight: 15, reps: 8, loadType: "loaded_bodyweight", effectiveLoad: BW + 15 })],
    }],
  }, {
    id: "CANARY-block2", type: "accessory", intent: "CANARY-intent2",
    exercises: [{ name: "Leg Curl", muscle: "Hamstrings", loadType: "machine", sets: [set({ weight: 40, reps: 12, loadType: "machine" })] }],
  }],
  ...extra,
});
const canaryMeta = () => ({
  displayName: "CANARY-displayName", bodyweight: 7004.01, bodyweightLog: [{ date: TODAY, kg: 7004.02 }],
  trainingState: { phase: "CANARY-trainingState" }, weights: { "Barbell Bench Press": 7004.03 }, reps: { x: 7004.04 },
  addedLoads: { "Pull-up": { kg: 7004.05 } }, streak: 7004.06, days: { [TODAY]: { note: "CANARY-days" } },
  photos: ["CANARY-photo.jpg"], notes: "CANARY-metaNotes",
  breaks: [
    { id: "2026-09-29T06:51:44.000Z", start: ago(4), reason: "injured", endedAt: null },
    { id: "2026-05-01T05:52:45.000Z", start: ago(150), reason: "travelling", endedAt: `${ago(140)}T19:22:33.000Z` },
    { id: "2025-01-01T05:53:46.000Z", start: "2025-01-01", reason: "busy", endedAt: "2025-01-10" },
  ],
  userWeek: [
    { editedAt: "2026-01-05T09:41:27.000Z", effectiveFrom: "2026-01-05", week: [
      { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "zone2" }, { type: "rest" }] },
    { editedAt: "2026-07-07T10:42:28.000Z", effectiveFrom: "2026-07-06", week: [
      { type: "strength" }, { type: "zone2" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "rest" }] },
  ],
});
const CANARIES = ["CANARY", "7001.", "7002.", "7003.", "7004.", "1777777777777", "injured", "travelling", "busy",
  "07:13:42", "06:51:44", "05:52:45", "05:53:46", "19:22:33", "09:41:27", "10:42:28", "18:04:05", "editedAt", "reason"];

const canaryData = () => ({
  meta: canaryMeta(),
  history: [
    canaryRecord(ago(2), "07:13:42"),
    canaryRecord(ago(2), "18:04:05", { readiness: "cooked", travel: true }),
    canaryRecord(ago(200), "07:13:42", { readiness: "normal" }),
    canaryRecord(ago(300), "18:04:05", { readiness: "weird" }),
  ],
});

/** Walk the output, holding every object to its declared keys. */
function assertAllowed(out) {
  const keys = (o, allowed, path) => {
    expect(o && typeof o === "object" && !Array.isArray(o), path).toBe(true);
    for (const k of Object.keys(o)) expect(allowed, `${path}.${k}`).toContain(k);
  };
  keys(out, VIEW_KEYS.root, "view");
  keys(out.window, VIEW_KEYS.window, "window");
  for (const b of out.breaks) keys(b, VIEW_KEYS.break, "break");
  for (const r of out.schedule) {
    keys(r, VIEW_KEYS.run, "run");
    for (const d of r.week ?? []) keys(d, VIEW_KEYS.day, "day");
  }
  for (const s of out.sessions) {
    keys(s, VIEW_KEYS.session, "session");
    for (const b of s.blocks) {
      keys(b, VIEW_KEYS.block, "block");
      for (const ex of b.exercises) {
        keys(ex, VIEW_KEYS.exercise, "exercise");
        for (const st of ex.sets) keys(st, VIEW_KEYS.set, "set");
      }
    }
  }
  for (const t of out.tops) {
    keys(t, VIEW_KEYS.top, "top");
    for (const b of t.blocks) {
      keys(b, VIEW_KEYS.topBlock, "topBlock");
      for (const ex of b.exercises) {
        keys(ex, VIEW_KEYS.topExercise, "topExercise");
        for (const st of ex.sets) keys(st, VIEW_KEYS.topSet, "topSet");
      }
    }
  }
}

const numbersIn = (v, out = []) => {
  if (typeof v === "number") out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) numbersIn(x, out);
  return out;
};

describe("projectForTrainer: what never leaves", () => {
  it("canary: no planted field, value or time of day appears anywhere in either tier", () => {
    const out = projectForTrainer(canaryData(), { todayIso: TODAY });
    expect(out.sessions.length).toBe(2);
    expect(out.tops.length).toBe(2);
    const text = JSON.stringify(out);
    for (const c of CANARIES) expect(text, c).not.toContain(c);
  });

  it("every object holds only allow-listed keys, at every depth, per tier", () => {
    assertAllowed(projectForTrainer(canaryData(), { todayIso: TODAY }));
  });

  it("the output is new: mutating it leaves the input untouched", () => {
    const data = canaryData();
    const before = JSON.stringify(data);
    const out = projectForTrainer(data, { todayIso: TODAY });
    out.sessions[0].blocks[0].exercises[0].sets[0].weight = -1;
    out.sessions[0].blocks[0].exercises[0].name = "x";
    out.schedule[0].week[0].type = "x";
    expect(JSON.stringify(data)).toBe(before);
  });

  it("bodyweight is off: no output number equals effectiveLoad − weight for any planted set", () => {
    const data = canaryData();
    const derived = [];
    for (const r of data.history) for (const b of r.blocks) for (const ex of b.exercises) for (const s of ex.sets) {
      if (typeof s.effectiveLoad === "number" && typeof s.weight === "number") derived.push(s.effectiveLoad - s.weight);
    }
    expect(derived.some((d) => Math.abs(d - BW) < 1e-9)).toBe(true);
    const nums = numbersIn(projectForTrainer(data, { todayIso: TODAY }));
    for (const d of derived) for (const n of nums) expect(Math.abs(n - d) < 1e-9, `${n} vs ${d}`).toBe(false);
  });

  it("a pure bodyweight set shows proven added kg only; a stale working weight reads 0", () => {
    const out = projectForTrainer(canaryData(), { todayIso: TODAY });
    const pull = out.sessions[0].blocks[0].exercises.find((e) => e.name === "Pull-up");
    expect(pull.sets.map((s) => s.weight)).toEqual([10, 0]);
    expect(pull.sets.map((s) => s.reps)).toEqual([6, 5]);
    // A bodyweight set with no weight stays null (not counted as loaded).
    const one = projectForTrainer({ history: [{ id: "x", date: TODAY, blocks: [{ type: "main", exercises: [
      { name: "Push-up", loadType: "bodyweight", sets: [{ weight: null, reps: 12, loadType: "bodyweight" }] }] }] }] }, { todayIso: TODAY });
    expect(one.sessions[0].blocks[0].exercises[0].sets[0].weight).toBeNull();
  });

  it("a set with no load type on it or its exercise reads by the name: a bodyweight movement never shows the body", () => {
    const out = projectForTrainer({ history: [{ id: "x", date: TODAY, blocks: [{ type: "main", exercises: [
      { name: "Push-up", sets: [{ weight: BW, reps: 12 }] },
      { name: "Barbell Back Squat", sets: [{ weight: 100, reps: 5 }] }] }] }] }, { todayIso: TODAY });
    const [push, squat] = out.sessions[0].blocks[0].exercises;
    expect(push.sets[0].weight).toBe(0);
    expect(squat.sets[0].weight).toBe(100);
    expect(JSON.stringify(out)).not.toContain(String(BW));
  });

  it("breathers are bare spans: dates only, no id, no reason; an injured breather reads like any other", () => {
    const out = projectForTrainer(canaryData(), { todayIso: TODAY });
    expect(out.breaks).toEqual([{ start: ago(4), endedAt: null }, { start: ago(150), endedAt: ago(140) }]);
    expect(isResting(out.breaks)).toBe(true);
    expect(projectBreaks([{ start: "nope" }, { start: TODAY, endedAt: "garbage" }, null])).toEqual([]);
  });

  it("the schedule ships as runs over the window, without edit times", () => {
    const out = projectForTrainer(canaryData(), { todayIso: TODAY });
    expect(out.schedule.map((r) => r.from)).toEqual([ago(DETAIL_DAYS), "2026-07-06"]);
    expect(out.schedule[1].week.map((d) => d.type)).toEqual(["strength", "zone2", "strength", "rest", "strength", "rest", "rest"]);
  });
});

describe("projectForTrainer: what is always shared", () => {
  it("every session and top carries readiness (a band or null); every detail set carries rpe and rir", () => {
    const out = projectForTrainer(canaryData(), { todayIso: TODAY });
    for (const s of [...out.sessions, ...out.tops]) expect(s).toHaveProperty("readiness");
    expect(out.sessions.map((s) => s.readiness)).toEqual(["fresh", "cooked"]);
    expect(out.tops.map((s) => s.readiness)).toEqual([null, "normal"]);
    for (const s of out.sessions) for (const b of s.blocks) for (const ex of b.exercises) for (const st of ex.sets) {
      expect(st).toHaveProperty("rpe");
      expect(st).toHaveProperty("rir");
    }
    const bench = out.sessions[0].blocks[0].exercises[0];
    expect(bench.sets).toEqual([
      { weight: 80, reps: 5, rpe: 8, rir: 2, loadType: "barbell" },
      { weight: 82.5, reps: 4, rpe: 9, rir: 1, loadType: "barbell" },
    ]);
    expect(out.sessions[1].travel).toBe(true);
    expect(out.sessions[0]).not.toHaveProperty("travel");
  });

  it("synthetic ids: noon plus a per-day ordinal by the original id; the start time is gone", () => {
    const out = projectForTrainer(canaryData(), { todayIso: TODAY });
    expect(out.sessions.map((s) => s.id)).toEqual([`${ago(2)}T12:00:00.000Z`, `${ago(2)}T12:00:01.000Z`]);
    expect(out.tops.map((s) => s.id)).toEqual([`${ago(300)}T12:00:00.000Z`, `${ago(200)}T12:00:00.000Z`]);
  });
});

describe("projectForTrainer: windows", () => {
  const at = (n) => ({ id: `${ago(n)}T08:00:00.000Z`, date: ago(n), session: "strength-a", readiness: "normal", blocks: [
    { type: "main", exercises: [
      { name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell", sets: [{ weight: 100, reps: 5, rpe: 8, rir: 2 }, { weight: 110, reps: 3, rpe: 9, rir: 1 }] },
      { name: "Barbell Deadlift", muscle: "Back", loadType: "barbell", sets: [{ weight: 140, reps: 5, rpe: 8, rir: 2 }] },
      { name: "Pull-up", muscle: "Back", loadType: "bodyweight", sets: [{ weight: 10, reps: 6, loadType: "bodyweight", bodyweightUsed: BW, effectiveLoad: BW + 10 }] },
    ] },
    { type: "accessory", exercises: [{ name: "Leg Curl", muscle: "Hamstrings", loadType: "machine", sets: [{ weight: 40, reps: 12, rir: 2 }] }] },
  ] });

  it("detail: 168 days in, 169 out; trend: 365 in, 366 out; nothing after today", () => {
    const out = projectForTrainer({ history: [at(-1), at(0), at(168), at(169), at(365), at(366)] }, { todayIso: TODAY });
    expect(out.window).toEqual({ from: ago(DETAIL_DAYS), trendFrom: ago(TREND_DAYS), to: TODAY });
    expect(out.sessions.map((s) => s.date)).toEqual([ago(168), ago(0)]);
    expect(out.tops.map((s) => s.date)).toEqual([ago(365), ago(169)]);
  });

  it("a record at day 200 appears only in tops: one set per main lift, no accessory, no body-loaded lift, no rir", () => {
    const out = projectForTrainer({ history: [at(200)] }, { todayIso: TODAY });
    expect(out.sessions).toEqual([]);
    expect(out.tops).toEqual([{
      id: `${ago(200)}T12:00:00.000Z`, date: ago(200), readiness: "normal",
      blocks: [{ type: "main", exercises: [
        { name: "Barbell Back Squat", sets: [{ weight: 110, reps: 3, rpe: 9 }] },
        { name: "Barbell Deadlift", sets: [{ weight: 140, reps: 5, rpe: 8 }] },
      ] }],
    }]);
  });

  it("a trend-tier set with no load type anywhere reads as the view reads it: an untyped pure bodyweight set never leaves raw", () => {
    const body = 83.37;
    const untyped = (name) => ({ id: `${ago(200)}T07:00:00.000Z`, date: ago(200), readiness: "normal",
      blocks: [{ type: "main", exercises: [{ name, sets: [{ weight: body, reps: 12, rpe: 8 }] }] }] });
    // The programme's lookup says bodyweight, though the name alone does not.
    const lookup = (name) => (name === "45-Degree Hip Extension" ? "bodyweight" : null);
    for (const [name, loadTypeOf] of [["45-Degree Hip Extension", lookup], ["Push-up", null]]) {
      const out = projectForTrainer({ history: [untyped(name)] }, { todayIso: TODAY, loadTypeOf });
      expect(out.tops, name).toEqual([]);
      expect(JSON.stringify(out), name).not.toContain(String(body));
    }
    // A Pull-Up logged under 'bodyweight' with the body as its weight: the view shows 0, so the trend has no point.
    const legacy = { id: `${ago(200)}T07:00:00.000Z`, date: ago(200), readiness: "normal", blocks: [{ type: "main", exercises: [
      { name: "Pull-Up", loadType: "loaded_bodyweight", sets: [{ weight: body, reps: 6, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }] },
      { name: "Barbell Back Squat", sets: [{ weight: 100, reps: 5 }] },
    ] }] };
    const out = projectForTrainer({ history: [legacy] }, { todayIso: TODAY });
    expect(out.tops[0].blocks[0].exercises).toEqual([{ name: "Barbell Back Squat", sets: [{ weight: 100, reps: 5, rpe: null }] }]);
    expect(JSON.stringify(out)).not.toContain(String(body));
  });

  it("a trend-tier record with no main-lift point is dropped", () => {
    const rec = { id: "x", date: ago(250), blocks: [{ type: "accessory", exercises: [{ name: "Leg Curl", sets: [{ weight: 40, reps: 10 }] }] }] };
    expect(projectForTrainer({ history: [rec] }, { todayIso: TODAY }).tops).toEqual([]);
  });

  it("an empty or missing profile projects to empty lists", () => {
    for (const data of [null, undefined, {}, { meta: null, history: null }]) {
      const out = projectForTrainer(data, { todayIso: TODAY });
      expect(out).toEqual({ window: { from: ago(168), trendFrom: ago(365), to: TODAY }, breaks: [], schedule: [], sessions: [], tops: [] });
    }
  });
});

// ── Equivalence: the trainer's numbers equal the client's own ──────────────

const MAIN = [["Barbell Back Squat", "Quads"], ["Barbell Bench Press", "Chest"], ["Barbell Deadlift", "Back"], ["Overhead Press", "Shoulders"]];
const ACC = [["Leg Curl", "Hamstrings", "machine"], ["Cable Row", "Back", "cable"], ["Dumbbell Curl", "Arms", "per_db"], ["Calf Raise", "Calves", "machine"]];

/** About 14 months of training ending at `end`, with doubles, travel, cooked days, bodyweight lifts, breathers and schedule edits. */
function generate(seed, end = TODAY) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const history = [];
  let letter = 0;
  for (let n = 430; n >= 0; n--) {
    const date = ago(n, end);
    if (r() > 0.45) continue;
    const doubles = r() < 0.06 ? 2 : 1;
    for (let k = 0; k < doubles; k++) {
      const hh = String(6 + Math.floor(r() * 14)).padStart(2, "0");
      const mm = String(Math.floor(r() * 60)).padStart(2, "0");
      const travel = r() < 0.08;
      const mains = travel
        ? [{ name: "Push-up", muscle: "Chest", loadType: "bodyweight", sets: [1, 2, 3].map(() => {
          const vest = r() < 0.4 ? 10 : null;
          return { weight: vest, reps: 8 + Math.floor(r() * 8), rpe: 8, rir: 2, loadType: "bodyweight", bodyweightUsed: BW, effectiveLoad: vest ? BW + vest : BW };
        }) }]
        : [pick(MAIN), pick(MAIN)].map(([name, muscle]) => ({
          name, muscle, loadType: "barbell",
          sets: [1, 2, 3].map(() => {
            const w = 40 + Math.round(r() * 120) * 1.25;
            const reps = r() < 0.1 ? "5" : 3 + Math.floor(r() * 6);
            return { weight: w, reps, rpe: r() < 0.1 ? null : 6 + Math.round(r() * 8) / 2, rir: Math.floor(r() * 4), loadType: "barbell",
              bodyweightUsed: BW, effectiveLoad: w, est1rm: w * 1.1, volume: w * 5, tempo: "3-1-1-0" };
          }),
        }));
      if (!travel && r() < 0.3) {
        mains.push({ name: "Pull-up", muscle: "Back", loadType: "bodyweight", sets: [{ weight: r() < 0.5 ? 20 : null, reps: 6, rpe: 8, rir: 2, loadType: "bodyweight", bodyweightUsed: BW, effectiveLoad: BW }] });
      }
      const acc = [pick(ACC), pick(ACC)].map(([name, muscle, loadType]) => ({
        name, muscle, loadType, sets: [1, 2].map(() => ({ weight: 10 + Math.floor(r() * 40), reps: 8 + Math.floor(r() * 7), rpe: 8, rir: 2, loadType })),
      }));
      const L = "ABC"[letter++ % 3];
      history.push({
        id: `${date}T${hh}:${mm}:${String(k).padStart(2, "0")}.000Z`, date, session: `strength-${L.toLowerCase()}`, scheduledLetter: L,
        readiness: pick(["fresh", "normal", "normal", "cooked"]), readinessReason: "tired", travel: travel || undefined,
        bodyweight: BW, hoursSlept: 7, loggedTz: "Europe/London", startedAt: 1, duration: 3600,
        blocks: [{ id: "b1", type: "main", intent: "strength", exercises: mains }, { id: "b2", type: "accessory", exercises: acc }],
      });
    }
  }
  history.sort((a, b) => a.id.localeCompare(b.id)); // dbReadProfile's order
  const breaks = [
    { id: "x1", start: ago(90, end), reason: "injured", endedAt: `${ago(80, end)}T10:00:00.000Z` },
    { id: "x2", start: ago(20, end), reason: "busy", endedAt: ago(17, end) },
    ...(seed % 2 ? [{ id: "x3", start: ago(3, end), reason: "resting", endedAt: null }] : []),
  ];
  const W = (types) => types.map((type) => ({ type }));
  const userWeek = [
    { editedAt: "2025-01-01T00:00:00.000Z", effectiveFrom: "2025-01-01", week: W(["strength", "rest", "strength", "rest", "strength", "rest", "rest"]) },
    { editedAt: "2026-05-04T08:00:00.000Z", effectiveFrom: "2026-05-04", week: W(["strength", "zone2", "rest", "strength", "rest", "strength", "rest"]) },
    // An older edit dated later: the latest-edited entry must still win.
    { editedAt: "2026-04-01T08:00:00.000Z", effectiveFrom: "2026-06-01", week: W(["rest", "rest", "rest", "rest", "rest", "rest", "strength"]) },
    { editedAt: "2026-08-10T08:00:00.000Z", effectiveFrom: "2026-08-10", week: W(["strength", "rest", "strength", "rest", "strength", "rest", "rest"]) },
  ];
  return { meta: { userWeek, breaks, bodyweight: BW }, history };
}

/** The Lab's own fixture shape (tests/components/PerformanceLab.populated.test.jsx). */
function labHistory() {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const date = ago(i * 4);
    out.push({ v: 2, id: `${date}T10:00:00.000Z`, date, readiness: "normal", session: "strength A",
      blocks: [{ id: "main", type: "main", sets: 3, rest: 180, exercises: [{ name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell",
        sets: [1, 2, 3].map(() => ({ weight: 100, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 100, volume: 500 })),
        summary: { totalVolume: 1500 } }] }],
      summary: { totalVolume: 1500 } });
  }
  return { meta: {}, history: out };
}

const rawWeekFor = (userWeek) => {
  const h = ensureScheduleHistory(userWeek);
  return (iso) => scheduleEntryOn(h, iso)?.week ?? null;
};

describe("equivalence: raw history vs the projection", () => {
  const cases = [["lab fixture", labHistory(), TODAY], ...[1, 2, 3, 4].map((s) => [`generated #${s}`, generate(s, ago(s * 9)), ago(s * 9)])];

  for (const [label, data, today] of cases) {
    it(`${label}: trend, bests, volume audit, readiness and weekly rhythm all match`, () => {
      const out = projectForTrainer(data, { todayIso: today });
      const within = (days) => data.history.filter((r) => r.date >= ago(days, today) && r.date <= today);
      const both = [...out.tops, ...out.sessions];

      // The projection always carries an rpe (null when none was logged).
      const trend = (h, o) => JSON.parse(JSON.stringify(mainLiftTrend(h, o), (k, v) => (k === "rpe" ? v ?? null : v)));
      expect(trend(both)).toEqual(trend(within(365)));
      expect(trend(both, { includeCooked: true })).toEqual(trend(within(365), { includeCooked: true }));
      expect(Object.keys(mainLiftTrend(both)).length).toBeGreaterThan(0);
      const now = new Date(`${today}T12:00:00`);
      expect(auditHistoryVolume(out.sessions, { weeks: 2, now })).toEqual(auditHistoryVolume(within(168), { weeks: 2, now }));
      expect(readinessBreakdown(out.sessions)).toEqual(readinessBreakdown(within(168)));

      const raw = makeDayContext({ todayIso: today, history: data.history, breaks: data.meta.breaks, weekFor: rawWeekFor(data.meta.userWeek) });
      const proj = makeDayContext({ todayIso: today, history: out.sessions, breaks: out.breaks, weekFor: runsWeekFor(out.schedule) });
      expect(weeklyStrength(proj, { weeks: 24 })).toEqual(weeklyStrength(raw, { weeks: 24 }));
      expect(strengthRhythm(proj, { days: 28 })).toEqual(strengthRhythm(raw, { days: 28 }));
      expect(isResting(out.breaks)).toBe(isResting(data.meta.breaks));
    });
  }

  it("the generated histories exercise the cases that matter", () => {
    const data = generate(1, ago(9));
    const out = projectForTrainer(data, { todayIso: ago(9) });
    expect(out.tops.length).toBeGreaterThan(50);
    expect(out.sessions.length).toBeGreaterThan(40);
    expect(out.sessions.some((s) => s.travel)).toBe(true);
    expect(new Set(out.sessions.map((s) => s.date)).size).toBeLessThan(out.sessions.length); // doubles
    expect(out.sessions.some((s) => s.readiness === "cooked")).toBe(true);
    expect(out.schedule.length).toBeGreaterThan(1);
  });

  it("runsWeekFor(scheduleRuns) equals the schedule in force, over 120 dates, both log shapes", () => {
    const r = rng(7);
    const logs = [generate(1).meta.userWeek, canaryMeta().userWeek,
      [{ type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "rest" }], null, "junk"];
    for (const uw of logs) {
      const all = runsWeekFor(scheduleRuns(uw));
      const raw = rawWeekFor(uw);
      const from = ago(DETAIL_DAYS);
      const to = addDaysIso(mondayOfWeekIso(TODAY), 6);
      const windowed = runsWeekFor(scheduleRuns(uw, { from, to }));
      for (let i = 0; i < 120; i++) {
        const iso = ago(Math.floor(r() * 700) - 30);
        expect(all(iso), iso).toEqual(raw(iso));
        if (iso >= from && iso <= to) expect(windowed(iso), iso).toEqual(raw(iso));
      }
    }
  });
});

// ── The look ring mirror ─────────────────────────────────────────────────────

const londonDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(ms));

describe("nextLooks: the ring's JS mirror", () => {
  const MIN = 60_000;
  const t0 = Date.parse("2026-10-03T08:00:00Z");

  it("two full looks 14 minutes apart are one entry; 16 minutes apart are two", () => {
    let s = nextLooks([], { k: "v" }, t0);
    expect(s).toEqual({ looks: [{ k: "v", at: t0 }], added: 1 });
    s = nextLooks(s.looks, { k: "v" }, t0 + 14 * MIN);
    expect(s).toEqual({ looks: [{ k: "v", at: t0 + 14 * MIN }], added: 0 });
    s = nextLooks(s.looks, { k: "v" }, t0 + 30 * MIN);
    expect(s.added).toBe(1);
    expect(s.looks).toHaveLength(2);
  });

  it("two roster looks on one London day are one entry; on two days, two", () => {
    // 23:30 UTC on a BST date is already the next London day.
    const late = Date.parse("2026-10-03T23:30:00Z");
    expect(londonDay(late)).toBe("2026-10-04");
    let s = nextLooks(null, { k: "r", d: londonDay(t0) }, t0);
    s = nextLooks(s.looks, { k: "r", d: londonDay(t0 + 3 * 3_600_000) }, t0 + 3 * 3_600_000);
    expect(s).toEqual({ looks: [{ k: "r", d: "2026-10-03", at: t0 }], added: 0 });
    s = nextLooks(s.looks, { k: "r", d: londonDay(late) }, late);
    expect(s.added).toBe(1);
    expect(s.looks.map((l) => l.d)).toEqual(["2026-10-04", "2026-10-03"]);
  });

  it("a roster look between two full looks breaks the coalescing", () => {
    let s = nextLooks([], { k: "v" }, t0);
    s = nextLooks(s.looks, { k: "r", d: londonDay(t0) }, t0 + MIN);
    s = nextLooks(s.looks, { k: "v" }, t0 + 2 * MIN);
    expect(s.looks.map((l) => l.k)).toEqual(["v", "r", "v"]);
  });

  it("500 random sequences: at most 20, newest first, the count is every look not coalesced", () => {
    const r = rng(42);
    for (let run = 0; run < 500; run++) {
      let looks = [];
      let count = 0;
      let expected = 0;
      let now = t0 + Math.floor(r() * 1e9);
      let prev = null; // the newest entry, as the model sees it
      const steps = 1 + Math.floor(r() * 60);
      for (let i = 0; i < steps; i++) {
        now += r() < 0.5 ? Math.floor(r() * 30 * MIN) : Math.floor(r() * 3 * 86_400_000);
        const look = r() < 0.6 ? { k: "v" } : { k: "r", d: londonDay(now) };
        const wouldCoalesce = look.k === "v"
          ? prev?.k === "v" && prev.at > now - 15 * MIN
          : looks.some((e) => e.k === "r" && e.d === look.d);
        const s = nextLooks(looks, look, now);
        expect(s.added).toBe(wouldCoalesce ? 0 : 1);
        if (!wouldCoalesce) expected += 1;
        count += s.added;
        looks = s.looks;
        prev = looks[0];
        expect(looks.length).toBeLessThanOrEqual(20);
        for (let j = 1; j < looks.length; j++) expect(looks[j - 1].at).toBeGreaterThanOrEqual(looks[j].at);
      }
      expect(count).toBe(expected);
    }
  });
});

describe("trainerToday", () => {
  const now = Date.parse("2026-10-03T23:30:00Z");
  it("takes the device's date within a day of the server's UTC date, else the UTC date", () => {
    expect(trainerToday("2026-10-04", now)).toBe("2026-10-04");
    expect(trainerToday("2026-10-02", now)).toBe("2026-10-02");
    expect(trainerToday("2026-10-05", now)).toBe("2026-10-03");
    expect(trainerToday("2026-02-31", now)).toBe("2026-10-03");
    expect(trainerToday("2026-10-03T00:00", now)).toBe("2026-10-03");
    expect(trainerToday(undefined, now)).toBe("2026-10-03");
  });
});

describe("rosterSignal: the last date", () => {
  const today = "2026-10-03";
  const row = (lastDate) => ({ recent: [], lastDate, userWeek: null, breaks: null });
  it("an impossible but well-formed date reads as no date, not a day that rolled over", () => {
    expect(rosterSignal(row("2026-09-30"), today).lastTrainedDaysAgo).toBe(3);
    // "2026-02-30" would parse as 2 March and print "Last trained 215 days ago".
    for (const bad of ["2026-02-30", "2026-09-31", "2026-13-01", "2026-00-10", "2025-02-29"]) {
      expect(rosterSignal(row(bad), today).lastTrainedDaysAgo, bad).toBeNull();
    }
    expect(rosterSignal(row("2024-02-29"), "2024-03-01").lastTrainedDaysAgo).toBe(1);
  });
});

describe("SELF_REF", () => {
  it("is 'me', which no grant id (hwg_…) can ever equal", () => {
    expect(SELF_REF).toBe("me");
    expect(SELF_REF.startsWith("hwg_")).toBe(false);
  });
});

// ── The plan: what a trainer may change, only with the client's changes on ──

const SQUAT = "Barbell Back Squat";
const BENCH = "Barbell Bench Press";
const PULL = "Pull-Up";
const HIP = "45-Degree Hip Extension";
const LUNGE = "DB Reverse Lunge";
const SET_A = "hws_" + "a".repeat(26);
const SET_B = "hws_" + "b".repeat(26);
const NEXT_MONDAY = "2026-10-05";

/** One exercise; a bodyweight movement's sets carry the body as the app logs them. */
const ex = (name, loadType, sets, bw, extra = {}) => ({
  name, muscle: "x", loadType, ...extra,
  sets: sets.map(([weight, reps]) => {
    const body = loadType.includes("bodyweight");
    return { weight, reps, rpe: 8, rir: 2, loadType, ...(body ? { bodyweightUsed: bw, effectiveLoad: bw + (weight || 0) } : {}) };
  }),
});
const rec = (date, time, exercises, extra = {}) => ({
  id: `${date}T${time}.000Z`, date, session: "strength-a", scheduledLetter: "A", readiness: "normal", blocks: [{ type: "main", exercises }], ...extra,
});

/** A client with two weeks of training; bw is their bodyweight. */
function planData(bw = 80) {
  return {
    meta: {
      weights: { [SQUAT]: 102.5, [BENCH]: 72.5, [PULL]: 10, [LUNGE]: 16 },
      reps: { [SQUAT]: 5 },
      bodyweight: { kg: bw }, bodyweightLog: [{ date: TODAY, kg: bw }],
      addedLoads: { [HIP]: { kg: 5 } },
    },
    history: [
      rec(ago(10), "07:00:00", [ex(SQUAT, "barbell", [[95, 5], [95, 5], [95, 5]], bw), ex(BENCH, "barbell", [[70, 5]], bw)]),
      rec(ago(3), "07:00:00", [
        ex(SQUAT, "barbell", [[100, 5], [100, 5], [97.5, 6]], bw),
        ex(BENCH, "barbell", [[72.5, 5]], bw, { prescribed: { weight: 72.5, reps: 5 } }),
        ex(PULL, "loaded_bodyweight", [[10, 6], [10, 5]], bw),
        ex(HIP, "bodyweight", [[null, 15], [null, 14]], bw),
        ex(LUNGE, "per_db", [[16, "8/leg"]], bw),
      ]),
    ],
  };
}

/** A stored change as dbChangesForTrainer returns it (snake_case through rowFromDb, plus editsLive). */
const change = (i, over = {}, editsLive = true, set = SET_A) => ({
  ...rowFromDb({
    id: `${set}.${i}`, set_id: set, kind: "weight", target: SQUAT, old_value: 102.5, new_value: 105, effective_from: null,
    basis: null, created_at: String(1_790_000_000_000 + i * 1000), applied_at: null, outcome: null,
    undone_at: null, undone_by: null, reverted_at: null, warnings: [], ...over,
  }),
  editsLive,
});

/** Walk a plan, holding every object to its declared keys. */
function assertPlanAllowed(plan) {
  const keys = (o, allowed, path) => {
    expect(o && typeof o === "object" && !Array.isArray(o), path).toBe(true);
    for (const k of Object.keys(o)) expect(allowed, `${path}.${k}`).toContain(k);
  };
  const days = (week, path) => {
    expect(Array.isArray(week), path).toBe(true);
    for (const d of week) keys(d, VIEW_KEYS.day, path);
  };
  const flat = (v, path) => expect(v === null || typeof v !== "object", path).toBe(true);
  keys(plan, PLAN_KEYS.plan, "plan");
  for (const l of plan.lifts) {
    keys(l, PLAN_KEYS.planLift, `lift ${l.name}`);
    for (const k of ["name", "session", "loadType", "w", "reps"]) flat(l[k], `${l.name}.${k}`);
    if (l.anchor) keys(l.anchor, PLAN_KEYS.planAnchor, "anchor");
    if (l.bounds) keys(l.bounds, PLAN_KEYS.planBounds, "bounds");
    if (l.blocked) keys(l.blocked, PLAN_KEYS.planBlocked, "blocked");
    if (l.pending) keys(l.pending, PLAN_KEYS.planPending, "pending");
    keys(l.basis, PLAN_KEYS.planBasis, "basis");
    for (const o of [l.anchor, l.bounds, l.blocked, l.pending, l.basis]) for (const v of Object.values(o ?? {})) flat(v, l.name);
  }
  for (const m of plan.mains) {
    keys(m, PLAN_KEYS.planMain, "main");
    for (const o of m.options) expect(typeof o).toBe("string");
    flat(m.choice, "choice");
    flat(m.basis, "main basis");
  }
  keys(plan.deload, PLAN_KEYS.planDeload, "deload");
  for (const r of plan.week) {
    keys(r, PLAN_KEYS.planRun, "run");
    days(r.week, "run.week");
    if (r.pending !== null) days(r.pending, "run.pending");
  }
  for (const c of plan.changes) {
    keys(c, PLAN_KEYS.planChange, "change");
    for (const k of ["before", "after"]) if (c.kind === "week" && c[k] !== null) days(c[k], k); else flat(c[k], k);
    for (const w of c.warnings) expect(typeof w).toBe("string");
  }
  keys(plan.budget, PLAN_KEYS.planBudget, "budget");
}

/** The plan as the route sends it to the validator: the basis the pane shows, sent back. */
const ctxFrom = (data, plan) => ({
  meta: data.meta, history: data.history, todayIso: TODAY, phase: "write",
  basis: {
    lifts: Object.fromEntries(plan.lifts.map((l) => [l.name, l.basis])),
    mains: Object.fromEntries(plan.mains.map((m) => [m.canonical, m.basis])),
  },
});
const sendWeight = (ctx, lift, kg) => validateChangeSet({ id: SET_B, ops: [{ kind: "weight", lift, kg, from: null }] }, ctx);
const LIMIT_CODES = ["per_change", "per_week", "no_history", "range", "floor"];

describe("the plan: only on a grant with changes on", () => {
  it("the route's projection adds plan only when edits are passed; the rest of the view is the read-only one", () => {
    const data = planData();
    const without = projectForTrainer(data, { todayIso: TODAY });
    expect(without).not.toHaveProperty("plan");
    expect(without).not.toHaveProperty("edits");
    expect(projectWithPlan(data, { todayIso: TODAY })).toEqual(without);
    // The read-only view never builds a plan, whatever it is passed.
    expect(projectForTrainer(data, /** @type {any} */ ({ todayIso: TODAY, edits: { rows: [], used: 0, freeAt: null }, status: "on" }))).toEqual(without);
    for (const edits of [null, undefined]) expect(projectWithPlan(data, { todayIso: TODAY, edits })).not.toHaveProperty("plan");
    const withPlan = projectWithPlan(data, { todayIso: TODAY, edits: { rows: [], used: 0, freeAt: null } });
    expect(Object.keys(withPlan).sort()).toEqual([...Object.keys(without), "plan", "edits"].sort());
    for (const k of Object.keys(without)) expect(withPlan[k]).toEqual(without[k]);
    expect(withPlan.plan).toEqual(projectPlan(data, { todayIso: TODAY, rows: [], used: 0, freeAt: null }));
    expect(withPlan.edits).toBe("on");
    expect(VIEW_KEYS.root).toEqual(["window", "breaks", "schedule", "sessions", "tops", "plan", "edits"]);
  });

  it("the edits status: on with the trainer's changes read; unavailable when they could not be; fresh on the old consent; off", () => {
    const changes = { rows: [], used: 0, freeAt: null };
    expect(editsStatus({ edits: true, editsAt: 1 }, changes)).toBe("on");
    for (const unread of [null, undefined]) expect(editsStatus({ edits: true, editsAt: 1 }, unread)).toBe("unavailable");
    // Every grant on the current consent starts on, so one never turned on predates it.
    expect(editsStatus({ edits: false, editsAt: null }, null)).toBe("fresh");
    expect(editsStatus({ edits: false }, null)).toBe("fresh");
    expect(editsStatus({ edits: false, editsAt: 1_790_000_000_000 }, null)).toBe("off");
    // Changes are never read for a grant with them off; if they were, still no plan.
    expect(editsStatus({ edits: false, editsAt: 1_790_000_000_000 }, changes)).toBe("off");
    expect(EDITS_STATUSES).toEqual(["on", "off", "fresh", "unavailable"]);
  });

  it("the view carries each status as given, and a plan only when on with the changes read", () => {
    const data = planData();
    const base = projectForTrainer(data, { todayIso: TODAY });
    const changes = { rows: [], used: 0, freeAt: null };
    for (const status of /** @type {const} */ (["off", "fresh", "unavailable"])) {
      for (const edits of [null, changes]) {
        const v = projectWithPlan(data, { todayIso: TODAY, edits, status });
        expect(v, `${status} ${!!edits}`).toEqual({ ...base, edits: status });
        expect(v).not.toHaveProperty("plan");
      }
    }
    const on = projectWithPlan(data, { todayIso: TODAY, edits: changes, status: "on" });
    expect(on.edits).toBe("on");
    expect(on.plan).toEqual(projectPlan(data, { todayIso: TODAY, ...changes }));
    // On but nothing read: no plan (the route sends unavailable then).
    expect(projectWithPlan(data, { todayIso: TODAY, edits: null, status: "on" })).toEqual({ ...base, edits: "on" });
    // The trainer's own training: neither key. Anything not a status is dropped.
    expect(projectWithPlan(data, { todayIso: TODAY, status: null })).toEqual(base);
    expect(projectWithPlan(data, /** @type {any} */ ({ todayIso: TODAY, status: "CANARY" }))).toEqual(base);
  });

  it("every object holds only allow-listed keys, at every depth", () => {
    const rows = [
      change(0), change(1, { kind: "reps", target: SQUAT, old_value: 5, new_value: 8 }),
      change(2, { kind: "mainLift", target: SQUAT, old_value: SQUAT, new_value: "Front Squat" }),
      change(3, { kind: "week", target: "week", effective_from: NEXT_MONDAY, old_value: [], new_value: [
        { type: "strength" }, { type: "cardio", label: "Pilates" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "rest" }] }),
    ];
    const plan = projectPlan(planData(), { todayIso: TODAY, rows, used: 1, freeAt: 1_790_604_800_000 });
    assertPlanAllowed(plan);
    expect(plan.lifts.length).toBeGreaterThan(20);
    expect(plan.mains.length).toBe(5);
    expect(plan.changes).toHaveLength(4);
  });

  it("canary: no planted field or value leaves (bodyweight, added loads, engine state, record ids and times, a change's basis and bookkeeping)", () => {
    const data = planData();
    data.meta = {
      ...data.meta, displayName: "CANARY-displayName", photos: ["CANARY-photo.jpg"], notes: "CANARY-notes", streak: 7004.06,
      days: { [TODAY]: { note: "CANARY-days" } }, bodyweightLog: [{ date: TODAY, kg: 7004.02 }],
      addedLoads: { [HIP]: { kg: 7004.05 }, [PULL]: { kg: 7004.09 } },
      trainingState: { phase: "CANARY-trainingState", lifts: { [SQUAT]: { currentWeight: 7004.07, est1rm: 7004.08, note: "CANARY-liftState" } } },
      userWeek: [{ editedAt: "2026-07-07T09:41:27.000Z", effectiveFrom: "2026-07-06", week: [
        { type: "strength" }, { type: "zone2" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "rest" }] }],
    };
    data.history = data.history.map((r, i) => ({
      ...r, id: `${r.date}T07:13:4${i}.000Z`, readinessReason: "CANARY-reason", notes: "CANARY-recNotes", loggedTz: "CANARY/Zone",
      startedAt: 1777777777777, hoursSlept: 7002.01, bodyweight: 7002.02,
      blocks: r.blocks.map((b) => ({ ...b, exercises: b.exercises.map((e) => ({ ...e, notes: "CANARY-exNotes",
        sets: e.sets.map((st) => ({ ...st, est1rm: 7002.04, volume: 7002.05, tempo: "CANARY-tempo" })) })) })),
    }));
    const recId = data.history[1].id;
    const junk = { profile: "CANARY-profile", grant_id: "CANARY-grant", client_account_id: "CANARY-client", author_account_id: "CANARY-author", source: "CANARY-source", status: "CANARY-status" };
    const rows = [
      { ...change(0, { basis: { anchorId: recId, trainedId: recId, w: 102.5, r: 5 }, warnings: ["big_drop", "CANARY-warning", "<b>x</b>"] }), ...junk },
      { ...change(1, { outcome: "applied", applied_at: "2026-10-01T06:51:44.000Z", basis: { anchorId: recId } }), ...junk },
      { ...change(2, { kind: "reps", outcome: "applied", applied_at: "2026-10-01T06:51:44.000Z", undone_at: "1777777777777", undone_by: "client", reverted_at: "2026-10-02T05:52:45.000Z", old_value: 5, new_value: 8 }), ...junk },
      { ...change(3, { kind: "week", target: "week", effective_from: NEXT_MONDAY, basis: { weekEditedAt: "2026-07-07T09:41:27.000Z" }, new_value: [
        { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "rest" }] }), ...junk },
    ];
    const plan = projectPlan(data, { todayIso: TODAY, rows, used: 2, freeAt: null });
    assertPlanAllowed(plan);
    const text = JSON.stringify(plan);
    for (const c of ["CANARY", "7002.", "7004.", "1777777777777", "07:13:4", "06:51:44", "05:52:45", "09:41:27", "<b>",
      "editedAt", "anchorId", "trainedId", "appliedAt", "revertedAt", "undoneAt", "undoneBy", "editsLive", "account", "grant", "profile"]) {
      expect(text, c).not.toContain(c);
    }
    expect(plan.changes[0].warnings).toEqual(["big_drop"]);
    // The engine's numbers that are shared: the stored W and R, the logged top set.
    expect(plan.lifts.find((l) => l.name === SQUAT)).toMatchObject({ w: 102.5, reps: 5, anchor: { date: ago(3), kg: 100, reps: 5 } });
  });

  it("nothing moves with bodyweight: the same training at 61.3 kg and 97.9 kg projects byte for byte the same", () => {
    const rows = [change(0), change(1, { kind: "reps", outcome: "applied", applied_at: "2026-10-02T08:00:00.000Z", old_value: 5, new_value: 6 })];
    const light = JSON.stringify(projectPlan(planData(61.3), { todayIso: TODAY, rows }));
    const heavy = JSON.stringify(projectPlan(planData(97.9), { todayIso: TODAY, rows }));
    expect(light).toBe(heavy);
    // With no bodyweight on file, the same again.
    const none = planData();
    delete none.meta.bodyweight;
    delete none.meta.bodyweightLog;
    expect(JSON.stringify(projectPlan(none, { todayIso: TODAY, rows }))).toBe(light);
  });

  it("a never-trained lift's top is the larger of its category's cold-start cap and its template weight (public), whatever the bodyweight or muscle anchors", () => {
    const at = (bw, anchors) => {
      const data = planData(bw ?? 80);
      if (bw === null) { delete data.meta.bodyweight; delete data.meta.bodyweightLog; }
      if (anchors) data.meta.trainingState = { muscleAnchors: anchors };
      return projectPlan(data, { todayIso: TODAY });
    };
    const ref = at(80);
    const ohp = ref.lifts.find((l) => l.name === "Barbell Overhead Press");
    expect(ohp.anchor).toBeNull();
    expect(ohp.bounds).toEqual({ min: 1.25, max: CATEGORY_COLD_START_MAX_KG.upper_push, step: 1.25, warnBelow: null });
    expect(ohp.blocked).toBeNull();
    // Every loaded lift with no performed top set: the cap or the template on its grid, nothing else.
    let checked = 0;
    const template = (name) => resolvedProgramme(planData().meta).find((x) => x.name === name)?.ex?.weight ?? 0;
    for (const l of ref.lifts) {
      if (!l.bounds || l.basis.anchorKg !== null || isBodyweightMovement(l.loadType)) continue;
      const top = Math.max(CATEGORY_COLD_START_MAX_KG[getLiftProfile(l.name).category], template(l.name));
      expect(l.bounds.max, l.name).toBe(Math.floor(top / l.bounds.step + 1e-9) * l.bounds.step);
      expect(l.bounds.warnBelow, l.name).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    // Template over cap: the calf raise and the hamstring curl (35 kg, the isolation cap is 25).
    for (const name of ["Standing Calf Raise", "Machine Hamstring Curl"]) {
      expect(ref.lifts.find((l) => l.name === name)?.bounds, name).toMatchObject({ max: 35 });
    }
    // Probe: no bodyweight, far-apart bodyweights, strong and weak muscle anchors: byte for byte the same.
    const text = JSON.stringify(ref);
    const strong = { Shoulders: { bestE1RM: 300 }, Chest: { bestE1RM: 400 }, Back: { bestE1RM: 400 }, Quadriceps: { bestE1RM: 500 }, Hamstrings: { bestE1RM: 500 } };
    const weak = Object.fromEntries(Object.keys(strong).map((m) => [m, { bestE1RM: 5 }]));
    for (const [label, plan] of [["none", at(null)], ["1 kg", at(1)], ["1000 kg", at(1000)], ["40 kg", at(40)], ["160 kg", at(160)],
      ["strong anchors", at(80, strong)], ["weak anchors", at(80, weak)], ["anchors, no bodyweight", at(null, strong)]]) {
      expect(JSON.stringify(plan), label).toBe(text);
    }
    // The route accepts the cap and refuses one rung past it, at every one of those.
    const data = planData(80);
    data.meta.trainingState = { muscleAnchors: weak };
    const ctx = ctxFrom(data, projectPlan(data, { todayIso: TODAY }));
    expect(sendWeight(ctx, "Barbell Overhead Press", ohp.bounds.max).ok).toBe(true);
    expect(sendWeight(ctx, "Barbell Overhead Press", nextRung(ohp.bounds.max, "barbell", +1)).ok).toBe(false);
  });

  it("a top set read from a derived load (body-based effectiveLoad on a set logged as barbell) offers reps only", () => {
    const data = planData();
    data.history[1].blocks[0].exercises[0].sets = [{ weight: 100, reps: 5, rir: 2, loadType: "barbell", bodyweightUsed: 83.37, effectiveLoad: 183.37 }];
    const plan = projectPlan(data, { todayIso: TODAY });
    const squat = plan.lifts.find((l) => l.name === SQUAT);
    // The top set is found by the load the validator read; its reps are shared, its load is not.
    expect(squat).toMatchObject({ w: null, bounds: null, anchor: { date: ago(3), kg: null, reps: 5 } });
    expect(squat.basis).toEqual({ anchorDate: ago(3), anchorKg: null, w: null, r: 5 });
    expect(JSON.stringify(plan)).not.toContain("83.37");
  });

  it("a pure bodyweight lift shows reps only: no W, no load, no bounds", () => {
    const hip = projectPlan(planData(), { todayIso: TODAY }).lifts.find((l) => l.name === HIP);
    expect(hip).toEqual({
      name: HIP, session: "A", loadType: "bodyweight", w: null, reps: 15,
      anchor: { date: ago(3), kg: null, reps: 15 }, bounds: null, blocked: null, pending: null,
      basis: { anchorDate: ago(3), anchorKg: null, w: null, r: null },
    });
  });

  it("a pure bodyweight lift's logged weight never leaves: not a stale working weight, not one equal to the body", () => {
    const body = 83.37;
    const hipSets = (sets) => {
      const data = planData();
      data.history[1].blocks[0].exercises[3].sets = sets.map(([weight, r]) => (
        { weight, reps: r, rpe: 8, rir: 2, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }));
      return projectPlan(data, { todayIso: TODAY });
    };
    for (const [label, sets, topReps] of [
      ["a stale working weight (effectiveLoad is the body alone)", [[61.25, 15], [61.25, 14]], 15],
      // The most reps of the session: never the set a withheld load picks.
      ["a legacy set whose weight is the body", [[61.25, 15], [body, 12]], 15],
    ]) {
      const plan = hipSets(sets);
      const hip = plan.lifts.find((l) => l.name === HIP);
      expect(hip.anchor, label).toEqual({ date: ago(3), kg: null, reps: topReps });
      expect(hip.basis, label).toEqual({ anchorDate: ago(3), anchorKg: null, w: null, r: null });
      expect(hip.w, label).toBeNull();
      expect(hip.bounds, label).toBeNull();
      const text = JSON.stringify(plan);
      for (const n of ["61.25", "83.37"]) expect(text, `${label}: ${n}`).not.toContain(n);
    }
  });

  it("an anchor kg leaves only as the session view shows that set: never the body, a stale working weight or a derived load", () => {
    const body = 83.37;
    const pull = (sets, extra = {}) => {
      const data = planData();
      Object.assign(data.history[1].blocks[0].exercises[2], extra, { sets });
      return data;
    };
    const cases = [
      // A Pull-Up set logged under 'bodyweight' whose weight is the body: the validator reads it as added kg.
      ["pull-up, weight = body", pull([{ weight: body, reps: 6, rir: 2, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }])],
      // The same with a stale working weight: not proven added load, so the view shows 0.
      ["pull-up, stale working weight", pull([{ weight: 61.25, reps: 6, rir: 2, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }])],
      // No load type on the set: the exercise's ('bodyweight') decides, as in the view.
      ["pull-up, exercise's load type", pull([{ weight: body, reps: 6, rir: 2 }], { loadType: "bodyweight" })],
    ];
    // A non-bodyweight lift's set with no effectiveLoad, logged under 'bodyweight' with the body as weight.
    const squat = planData();
    squat.history[1].blocks[0].exercises[0].sets = [{ weight: body, reps: 5, rir: 2, loadType: "bodyweight" }];
    cases.push(["squat, no effectiveLoad, weight = body", squat]);
    for (const [label, data] of cases) {
      const plan = projectPlan(data, { todayIso: TODAY });
      const view = projectForTrainer(data, { todayIso: TODAY });
      const name = label.startsWith("squat") ? SQUAT : PULL;
      const lift = plan.lifts.find((l) => l.name === name);
      // The route's own anchor is the withheld number.
      expect(liftBasis(name, { meta: data.meta, history: data.history, todayIso: TODAY }).anchorKg, label).toBe(label.includes("stale") ? 61.25 : body);
      expect(lift.anchor, label).toEqual({ date: ago(3), kg: null, reps: label.startsWith("squat") ? 5 : 6 });
      expect(lift, label).toMatchObject({ w: null, bounds: null, basis: { anchorDate: ago(3), anchorKg: null, w: null } });
      // The view shows that set as 0, and the plan never says otherwise.
      const shown = view.sessions.find((x) => x.date === ago(3)).blocks[0].exercises.find((e) => e.name === name).sets[0].weight;
      expect(shown, label).toBe(0);
      const text = JSON.stringify(plan);
      for (const n of ["83.37", "61.25"]) expect(text, `${label}: ${n}`).not.toContain(n);
    }
  });

  it("an anchor kg the view shows leaves: proven added kg on a pull-up, a plain set with no effectiveLoad", () => {
    const data = planData();
    // Logged under 'bodyweight' with the added kg proven by its effectiveLoad.
    data.history[1].blocks[0].exercises[2].sets = [{ weight: 12.5, reps: 6, rir: 2, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 92.5 }];
    data.history[1].blocks[0].exercises[0].sets = [{ weight: 100, reps: 5, rir: 2, loadType: "barbell" }];
    const plan = projectPlan(data, { todayIso: TODAY });
    expect(plan.lifts.find((l) => l.name === PULL).anchor).toEqual({ date: ago(3), kg: 12.5, reps: 6 });
    expect(plan.lifts.find((l) => l.name === SQUAT).anchor).toEqual({ date: ago(3), kg: 100, reps: 5 });
    const view = projectForTrainer(data, { todayIso: TODAY });
    const ex3 = view.sessions.find((x) => x.date === ago(3)).blocks[0].exercises;
    expect(ex3.find((e) => e.name === PULL).sets[0].weight).toBe(12.5);
    expect(ex3.find((e) => e.name === SQUAT).sets[0].weight).toBe(100);
  });

  it("a set with no load type anywhere reads by the programme's type, or the name's, whichever is bodyweight", () => {
    const body = 83.37;
    const data = planData();
    // A bodyweight movement in the programme whose name alone does not say so.
    const i = data.history[1].blocks[0].exercises.findIndex((e) => e.name === HIP);
    data.history[1].blocks[0].exercises[i] = { name: HIP, muscle: "x", sets: [{ weight: body, reps: 15, rir: 2 }] };
    const out = projectWithPlan(data, { todayIso: TODAY, edits: { rows: [], used: 0, freeAt: null } });
    const hip = out.sessions.find((x) => x.date === ago(3)).blocks[0].exercises.find((e) => e.name === HIP);
    expect(hip.sets[0].weight).toBe(0);
    expect(out.plan.lifts.find((l) => l.name === HIP)).toMatchObject({ w: null, bounds: null, anchor: { date: ago(3), kg: null } });
    expect(JSON.stringify(out)).not.toContain(String(body));
  });

  it("shownSetWeight and anchorLogged: a top set counts only when every loaded set reads as the view shows it", () => {
    const body = 83.37;
    const one = (name, exLt, sets) => [{ id: `${ago(3)}T07:00:00.000Z`, date: ago(3), readiness: "normal",
      blocks: [{ type: "main", exercises: [{ name, ...(exLt ? { loadType: exLt } : {}), sets }] }] }];
    expect(shownSetWeight({ weight: 100 }, { name: SQUAT, loadType: "barbell" })).toBe(100);
    expect(shownSetWeight({ weight: 12.5, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 92.5 }, { name: PULL })).toBe(12.5);
    expect(shownSetWeight({ weight: body, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }, { name: PULL })).toBe(0);
    expect(shownSetWeight({ weight: body }, { name: SQUAT }, "bodyweight")).toBe(0);
    expect(anchorLogged(one(SQUAT, "barbell", [{ weight: 100, reps: 5 }]), SQUAT, "barbell")).toBe(true);
    expect(anchorLogged(one(PULL, null, [{ weight: 12.5, reps: 6, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 92.5 }]), PULL, "loaded_bodyweight")).toBe(true);
    // The body, or a stale weight, on a bodyweight set.
    expect(anchorLogged(one(PULL, null, [{ weight: body, reps: 6, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }]), PULL, "loaded_bodyweight")).toBe(false);
    expect(anchorLogged(one(PULL, null, [{ weight: 61.25, reps: 6, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }]), PULL, "loaded_bodyweight")).toBe(false);
    // No load type on set or exercise: bodyweight when the programme says so.
    expect(anchorLogged(one(SQUAT, null, [{ weight: body, reps: 5 }]), SQUAT, "bodyweight")).toBe(false);
    expect(anchorLogged(one(SQUAT, null, [{ weight: 100, reps: 5 }]), SQUAT, "barbell")).toBe(true);
    // A derived load in any one set, however small next to the plain one.
    expect(anchorLogged(one(SQUAT, "barbell", [{ weight: 100, reps: 5, loadType: "barbell" }, { weight: 1.25, reps: 8, loadType: "loaded_bodyweight", effectiveLoad: 1.25 + 40 }]), SQUAT, "barbell")).toBe(false);
    // Nothing loaded, or no session: nothing to withhold.
    expect(anchorLogged(one(SQUAT, "barbell", [{ weight: null, reps: 5 }]), SQUAT, "barbell")).toBe(true);
    expect(anchorLogged([], SQUAT, "barbell")).toBe(true);
  });

  it("mixed load types: a squat or bench with a plain set and a body-loaded or assisted set is reps only, the same at 50 to 120 kg", () => {
    // Assisted: body − assist, which equals the assist at body 80.
    const second = {
      loaded: (body) => ({ weight: 20, reps: 8, rpe: 8, rir: 2, loadType: "loaded_bodyweight", bodyweightUsed: body, effectiveLoad: 20 + body }),
      assisted: (body) => ({ weight: 40, reps: 8, rpe: 8, rir: 2, loadType: "assisted_bodyweight", bodyweightUsed: body, effectiveLoad: body - 40 }),
    };
    const mixed = (name, body, shape) => {
      const data = planData(body);
      const i = data.history[1].blocks[0].exercises.findIndex((e) => e.name === name);
      data.history[1].blocks[0].exercises[i].sets = [{ weight: 100, reps: 5, rpe: 8, rir: 2, loadType: "barbell" }, second[shape](body)];
      return data;
    };
    for (const [name, shape] of [[SQUAT, "loaded"], [BENCH, "loaded"], [SQUAT, "assisted"], [BENCH, "assisted"]]) {
      const seen = [50, 60, 80, 100, 120].map((body) => {
        const data = mixed(name, body, shape);
        const plan = projectPlan(data, { todayIso: TODAY });
        const lift = plan.lifts.find((l) => l.name === name);
        const ctx = ctxFrom(data, plan);
        const codes = [];
        for (let kg = 1.25; kg <= 400; kg = Math.round((kg + 1.25) * 100) / 100) {
          const v = sendWeight(ctx, name, kg);
          codes.push(v.refusals[0]?.code ?? (v.stale ? "stale" : "ok"));
        }
        // The whole plan, byte for byte: nothing in it moves with the body.
        return JSON.stringify({ plan, codes, bounds: lift.bounds, anchor: lift.anchor, basis: lift.basis, w: lift.w,
          dry: boundsFor(name, { meta: data.meta, history: data.history, todayIso: TODAY, phase: "write" }) });
      });
      for (const x of seen) expect(x, `${name} ${shape}`).toBe(seen[0]);
      const one = JSON.parse(seen[0]);
      expect(new Set(one.codes), name).toEqual(new Set(["reps_only"]));
      expect(one).toMatchObject({ bounds: null, dry: null, w: null, anchor: { date: ago(3), kg: null, reps: 8 }, basis: { anchorKg: null, w: null } });
    }
  });

  it("the route answers a withheld anchor with one code for every kg, whatever the bodyweight", () => {
    const cases = (body) => {
      const pull = planData(body);
      pull.history[1].blocks[0].exercises[2].sets = [{ weight: body, reps: 6, rir: 2, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }];
      const stale = planData(body);
      stale.history[1].blocks[0].exercises[2].sets = [{ weight: 61.25, reps: 6, rir: 2, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }];
      const squat = planData(body);
      squat.history[1].blocks[0].exercises[0].sets = [{ weight: body, reps: 5, rir: 2, loadType: "bodyweight" }];
      return [["pull-up, weight = body", PULL, pull], ["pull-up, stale weight", PULL, stale], ["squat, weight = body", SQUAT, squat]];
    };
    for (const body of [70, 100]) {
      for (const [label, name, data] of cases(body)) {
        const ctx = ctxFrom(data, projectPlan(data, { todayIso: TODAY }));
        const codes = new Set();
        for (let kg = 1.25; kg <= 400; kg = Math.round((kg + 1.25) * 100) / 100) {
          const v = sendWeight(ctx, name, kg);
          codes.add(v.refusals[0]?.code ?? (v.stale ? "stale" : "ok"));
        }
        expect([...codes], `${label} at ${body}`).toEqual(["reps_only"]);
      }
    }
  });

  it("a week-ago top set the view withholds sets no limit: one rung that week", () => {
    const run = (body) => {
      const data = planData(body);
      // A week-ago squat logged under 'bodyweight' with the body as weight; this week's is plain.
      data.history[0].blocks[0].exercises[0].sets = [{ weight: body, reps: 5, rir: 2, loadType: "bodyweight" }];
      return projectPlan(data, { todayIso: TODAY }).lifts.find((l) => l.name === SQUAT).bounds;
    };
    expect(run(88)).toEqual(run(93));
    expect(run(88).max).toBe(nextRung(100, "barbell", +1));
  });

  it("an anchor of any age stays: the last top set two years back is the basis, outside the view's windows", () => {
    const data = planData();
    const old = ago(730);
    data.history = [rec(old, "07:00:00", [ex(BENCH, "barbell", [[60, 5], [62.5, 4]], 80)]), data.history[1]];
    data.history[1] = { ...data.history[1], blocks: [{ type: "main", exercises: data.history[1].blocks[0].exercises.filter((e) => e.name !== BENCH) }] };
    const plan = projectPlan(data, { todayIso: TODAY });
    const bench = plan.lifts.find((l) => l.name === BENCH);
    expect(bench.anchor).toEqual({ date: old, kg: 62.5, reps: 4 });
    expect(bench.basis).toMatchObject({ anchorDate: old, anchorKg: 62.5 });
    expect(bench.bounds.max).toBeGreaterThan(62.5);
    // The read-only view does not reach that far: the plan carries it on purpose (consent and privacy page say so).
    const view = projectForTrainer(data, { todayIso: TODAY });
    expect(old < view.window.trendFrom).toBe(true);
    expect([...view.sessions, ...view.tops].some((x) => x.date === old)).toBe(false);
  });
});

describe("the plan: an unset (a stored null weight or reps) reads as no stored value", () => {
  /** planData with the squat and pull-up weights and the squat reps unset, or the keys absent. */
  const variant = (unset) => {
    const d = planData();
    const weights = { ...d.meta.weights };
    const reps = { ...d.meta.reps };
    for (const m of [weights, reps]) for (const k of [SQUAT, PULL]) { if (unset) m[k] = null; else delete m[k]; }
    return { ...d, meta: { ...d.meta, weights, reps } };
  };
  const planted = variant(true);
  const absent = variant(false);
  const opts = { todayIso: TODAY, rows: [], used: 0, freeAt: null };

  it("the plan is the one with the keys absent: w null, the template reps, no NaN or \"null\" copy", () => {
    const plan = projectPlan(planted, opts);
    expect(plan).toEqual(projectPlan(absent, opts));
    const squat = plan.lifts.find((l) => l.name === SQUAT);
    expect([squat.w, squat.basis.w, squat.basis.r]).toEqual([null, null, null]);
    expect(squat.reps).toBe(5);
    expect(JSON.stringify(plan)).not.toMatch(/NaN|"null"/);
    expect(JSON.stringify(projectWithPlan(planted, { todayIso: TODAY, edits: { rows: [], used: 0, freeAt: null } }))).not.toMatch(/NaN/);
  });

  it("the validator reads the same basis and before, and a change onto the unset lift is checked the same", () => {
    expect(liftBasis(SQUAT, { meta: planted.meta, history: planted.history, todayIso: TODAY }))
      .toEqual(liftBasis(SQUAT, { meta: absent.meta, history: absent.history, todayIso: TODAY }));
    const a = sendWeight(ctxFrom(planted, projectPlan(planted, opts)), SQUAT, 102.5);
    const b = sendWeight(ctxFrom(absent, projectPlan(absent, opts)), SQUAT, 102.5);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(a.ops[0].before).toBeNull();
  });

  it("resolvedProgramme and the working-weight bound leave the null alone", () => {
    const l = resolvedProgramme(planted.meta).find((x) => x.name === SQUAT);
    expect(l.w).toBeNull();
    expect(typeof l.start).toBe("number");
    expect(resolvedProgramme(planted.meta)).toEqual(resolvedProgramme(absent.meta));
    expect(sanitiseWorkingWeights(planted.meta.weights)).toBe(planted.meta.weights);
  });
});

describe("the plan: bounds are the route's (E4)", () => {
  it("every offered max and min is accepted; one rung past either is refused by a limit", () => {
    const data = planData();
    const plan = projectPlan(data, { todayIso: TODAY });
    const ctx = ctxFrom(data, plan);
    let checked = 0;
    for (const l of plan.lifts) {
      if (!l.bounds || l.blocked || l.bounds.max === null) continue;
      const { min, max } = l.bounds;
      const up = sendWeight(ctx, l.name, max);
      expect(up.ok, `${l.name} max ${max}: ${JSON.stringify(up.refusals)}`).toBe(true);
      const over = sendWeight(ctx, l.name, nextRung(max, l.loadType, +1));
      expect(over.ok, `${l.name} over`).toBe(false);
      expect(LIMIT_CODES, l.name).toContain(over.refusals[0]?.code);
      expect(sendWeight(ctx, l.name, min).ok, `${l.name} min ${min}`).toBe(true);
      const under = nextRung(min, l.loadType, -1);
      if (under > 0) expect(LIMIT_CODES, `${l.name} under`).toContain(sendWeight(ctx, l.name, under).refusals[0]?.code);
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
    // The anchored squat: 100 kg last time, 95 a week before that. Up to +15% on the 95
    // (under +10% on the 100), down to the deload floor, a warning below 85%.
    expect(plan.lifts.find((l) => l.name === SQUAT).bounds).toEqual({ min: 65, max: 108.75, step: 1.25, warnBelow: 85 });
  });

  it("warnBelow sits on the implement's grid, and warns exactly where the route does", () => {
    const data = planData();
    // 85% of the bench's 72.5 is 61.625: between rungs.
    const plan = projectPlan(data, { todayIso: TODAY });
    const ctx = ctxFrom(data, plan);
    expect(plan.lifts.find((l) => l.name === BENCH).bounds).toMatchObject({ step: 1.25, warnBelow: 62.5 });
    let checked = 0;
    for (const l of plan.lifts) {
      const b = l.bounds;
      if (!b || b.warnBelow === null || l.blocked) continue;
      const rungs = b.warnBelow / b.step;
      expect(Math.abs(rungs - Math.round(rungs)), l.name).toBeLessThan(1e-9);
      const warns = (kg) => sendWeight(ctx, l.name, kg).warnings.some((w) => w.code === "big_drop");
      expect(b.warnBelow, l.name).toBeGreaterThanOrEqual(b.min);
      expect(warns(b.warnBelow), `${l.name} at ${b.warnBelow}`).toBe(false);
      const below = nextRung(b.warnBelow, l.loadType, -1);
      if (below >= b.min) {
        expect(warns(below), `${l.name} at ${below}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2);
  });

  it("the basis the pane shows, sent back unchanged, is never stale; a moved basis is", () => {
    const data = planData();
    const plan = projectPlan(data, { todayIso: TODAY });
    const ctx = ctxFrom(data, plan);
    const set = validateChangeSet({ id: SET_B, ops: [
      { kind: "weight", lift: SQUAT, kg: 105, from: null },
      { kind: "reps", lift: LUNGE, reps: 10, from: null },
      { kind: "mainLift", canonical: BENCH, choice: plan.mains.find((m) => m.canonical === BENCH).options[1], from: null },
    ] }, ctx);
    expect(set.refusals).toEqual([]);
    expect(set.stale).toBe(false);
    expect(set.ok).toBe(true);
    // The client trains again: the same basis is now stale.
    const later = { ...data, history: [...data.history, rec(ago(1), "07:00:00", [ex(SQUAT, "barbell", [[102.5, 5]], 80)])] };
    expect(sendWeight({ ...ctx, history: later.history }, SQUAT, 105).stale).toBe(true);
  });

  it("week runs carry the types the route checks a week change against, every Monday to the horizon", () => {
    const data = planData();
    data.meta.userWeek = [
      { editedAt: "2026-01-05T09:00:00.000Z", effectiveFrom: "2026-01-05", week: ["strength", "rest", "strength", "rest", "strength", "zone2", "rest"].map((type) => ({ type })) },
      { editedAt: "2026-09-30T09:00:00.000Z", effectiveFrom: "2026-10-19", week: ["strength", "strength", "rest", "strength", "rest", "cardio", "rest"].map((type) => ({ type, ...(type === "cardio" ? { label: "Swim" } : {}) })) },
    ];
    const plan = projectPlan(data, { todayIso: TODAY });
    expect(plan.week.map((r) => r.from)).toEqual(["2026-09-28", "2026-10-19"]);
    const weekFor = runsWeekFor(plan.week);
    for (let m = "2026-09-28"; m <= addDaysIso(TODAY, 28); m = addDaysIso(m, 7)) {
      expect(weekFor(m).map((d) => d.type), m).toEqual(weekBasis(data.meta, m));
    }
    expect(plan.week[1].week[5]).toEqual({ s: "S", label: "Swim", type: "cardio" });
    // No week of their own: the app's default week, from this Monday.
    const dflt = projectPlan(planData(), { todayIso: TODAY }).week;
    expect(dflt).toHaveLength(1);
    expect(dflt[0].from).toBe("2026-09-28");
    expect(dflt[0].week.map((d) => d.type)).toEqual(weekBasis({}, "2026-09-28"));
  });
});

describe("the plan: deload, recovery, main lifts, budget", () => {
  it("a deload blocks every load with its end date, the route's own; reps-only lifts stay open", () => {
    const data = planData();
    data.meta.trainingState = { mesocycle: { activeDeload: { startedAt: "2026-10-01T08:00:00.000Z", plannedDays: 7, signal: "CANARY-signal" } } };
    const plan = projectPlan(data, { todayIso: TODAY });
    expect(plan.deload).toEqual({ active: true, until: "2026-10-08" });
    expect(JSON.stringify(plan)).not.toContain("CANARY");
    const ctx = ctxFrom(data, plan);
    for (const l of plan.lifts) {
      if (!l.bounds) { expect(l.blocked, l.name).toBeNull(); continue; }
      expect(l.blocked, l.name).toEqual({ code: "deload", until: "2026-10-08" });
      expect(sendWeight(ctx, l.name, l.bounds.min).refusals[0]).toMatchObject({ code: "deload", until: "2026-10-08" });
    }
    expect(projectPlan(planData(), { todayIso: TODAY }).deload).toEqual({ active: false, until: null });
  });

  it("recovery session 1 blocks that lift only", () => {
    const data = planData();
    data.meta.trainingState = { lifts: { [SQUAT]: { inRecoveryUntil: 3 } } };
    const plan = projectPlan(data, { todayIso: TODAY });
    expect(plan.lifts.find((l) => l.name === SQUAT).blocked).toEqual({ code: "recovery", until: null });
    expect(plan.lifts.find((l) => l.name === BENCH).blocked).toBeNull();
    expect(plan.deload.active).toBe(false);
  });

  it("main lifts: each programme main, its choice, its listed options, and the choice as the basis", () => {
    const data = planData();
    data.meta.mainLifts = { [SQUAT]: "Front Squat", [BENCH]: "not a lift" };
    const plan = projectPlan(data, { todayIso: TODAY });
    const squat = plan.mains.find((m) => m.canonical === SQUAT);
    expect(squat.choice).toBe("Front Squat");
    expect(squat.basis).toBe("Front Squat");
    expect(squat.options[0]).toBe(SQUAT);
    expect(squat.options).toContain("Front Squat");
    // An invalid stored choice reads as the programme's own.
    expect(plan.mains.find((m) => m.canonical === BENCH)).toMatchObject({ choice: BENCH, basis: BENCH });
    // The chosen lift is in the plan, under its own name.
    expect(plan.lifts.some((l) => l.name === "Front Squat")).toBe(true);
  });

  it("the budget: used, of 10, and when one frees up", () => {
    expect(projectPlan(planData(), { todayIso: TODAY, used: 7, freeAt: 1_790_604_800_000 }).budget).toEqual({ used: 7, of: SETS_PER_WEEK, freeAt: 1_790_604_800_000 });
    expect(projectPlan(planData(), { todayIso: TODAY }).budget).toEqual({ used: 0, of: 10, freeAt: null });
  });
});

describe("the plan: the trainer's changes and what each reads as", () => {
  const appliedAt = `${ago(5)}T08:00:00.000Z`; // before the last session (ago 3)
  const appliedLate = `${ago(1)}T08:00:00.000Z`; // after it
  const rows = () => [
    change(0, { new_value: 105 }),
    change(1, { new_value: 107.5 }), // newer, same lift: the one pending
    change(2, { kind: "reps", target: BENCH, old_value: null, new_value: 8 }, false), // changes turned off before it landed
    change(3, { kind: "reps", target: SQUAT, old_value: 6, new_value: 5, outcome: "applied", applied_at: appliedLate }),
    change(4, { kind: "weight", target: BENCH, old_value: 70, new_value: 72.5, outcome: "applied", applied_at: appliedAt }),
    change(5, { kind: "weight", target: PULL, old_value: 7.5, new_value: 12.5, outcome: "applied", applied_at: appliedLate }),
    change(6, { undone_at: "1790000009000", undone_by: "trainer" }),
    change(7, { undone_at: "1790000009000", undone_by: "client" }),
    change(8, { outcome: "superseded" }),
    change(9, { kind: "week", target: "week", effective_from: NEXT_MONDAY, new_value: [
      { type: "strength" }, { type: "cardio", label: "Pilates" }, { type: "strength" }, { type: "rest" }, { type: "strength" }, { type: "rest" }, { type: "rest" }] }),
  ];

  it("status per change, as the client's device reads it; the trainer's words come from these", () => {
    const plan = projectPlan(planData(), { todayIso: TODAY, rows: rows(), used: 1 });
    const st = Object.fromEntries(plan.changes.map((c) => [c.id.split(".")[1], [c.status, c.reason, c.date]]));
    expect(st).toEqual({
      0: ["waiting", null, null], 1: ["waiting", null, null], 2: ["not_applied", "stopped", null],
      3: ["in_force", null, null], 4: ["trained_yours", null, ago(3)], 5: ["changed_since", null, null],
      6: ["withdrawn", null, null], 7: ["undone", null, null], 8: ["not_applied", "superseded", null],
      9: ["waiting", null, NEXT_MONDAY],
    });
    const c4 = plan.changes.find((c) => c.id === `${SET_A}.4`);
    expect(c4).toEqual({ id: `${SET_A}.4`, set: SET_A, kind: "weight", target: BENCH, before: 70, after: 72.5, from: null,
      status: "trained_yours", reason: null, date: ago(3), at: 1_790_000_004_000, warnings: [] });
  });

  it("a cooked session at their number reads as trained, marked cooked", () => {
    const data = planData();
    data.history[1].readiness = "cooked";
    const c = projectPlan(data, { todayIso: TODAY, rows: rows() }).changes.find((x) => x.id === `${SET_A}.4`);
    expect(c).toMatchObject({ status: "trained_yours", cooked: true });
  });

  it("pending: the newest waiting change per lift; a change that will not land is not pending", () => {
    const plan = projectPlan(planData(), { todayIso: TODAY, rows: rows() });
    const lift = (n) => plan.lifts.find((l) => l.name === n);
    expect(lift(SQUAT).pending).toEqual({ w: 107.5, reps: null });
    expect(lift(BENCH).pending).toBeNull(); // the reps change is stopped, the weight change landed
    expect(lift(PULL).pending).toBeNull();
    // The waiting week marks its run, split from the week in force.
    expect(plan.week.map((r) => [r.from, r.pending === null])).toEqual([["2026-09-28", true], [NEXT_MONDAY, false]]);
    expect(plan.week[1].week).toEqual(plan.week[0].week);
    expect(plan.week[1].pending[1]).toEqual({ s: "T", label: "Pilates", type: "cardio" });
  });

  it("pending prefers a change that is due over a later-dated one, as the device picks", () => {
    const plan = projectPlan(planData(), { todayIso: TODAY, rows: [
      change(0, { new_value: 105 }), // next session
      change(1, { new_value: 110, effective_from: "2026-10-12" }), // sent later, lands later
      change(2, { kind: "reps", new_value: 6, effective_from: "2026-10-12" }),
      change(3, { kind: "reps", new_value: 7, effective_from: "2026-10-19" }), // neither due: the newest
    ] });
    expect(plan.changes.map((c) => c.status)).toEqual(["waiting", "waiting", "waiting", "waiting"]);
    expect(plan.lifts.find((l) => l.name === SQUAT).pending).toEqual({ w: 105, reps: 7 });
  });

  it("rep adoption carries on, and the trainer sees it: their target reads changed since, the lift shows what the client settled on", () => {
    const data = planData();
    data.meta.reps = { [SQUAT]: 6 };
    const plan = projectPlan(data, { todayIso: TODAY, rows: [change(0, { kind: "reps", old_value: 5, new_value: 8, outcome: "applied", applied_at: appliedLate })] });
    expect(plan.changes[0]).toMatchObject({ status: "changed_since", before: 5, after: 8 });
    expect(plan.lifts.find((l) => l.name === SQUAT).basis.r).toBe(6);
  });

  it("values are rebuilt by kind: wrong-typed stored values read as null", () => {
    const plan = projectPlan(planData(), { todayIso: TODAY, rows: [
      change(0, { new_value: { kg: 105 } }), change(1, { kind: "mainLift", new_value: ["x"] }),
      change(2, { kind: "week", target: "week", effective_from: NEXT_MONDAY, new_value: [{ type: "rest" }] }),
    ] });
    expect(plan.changes.map((c) => c.after)).toEqual([null, null, null]);
    expect(projectPlan(planData(), { todayIso: TODAY, rows: [null, { id: 3 }, "x"] }).changes).toEqual([]);
  });
});
