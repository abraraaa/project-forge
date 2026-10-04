// What a trainer is shown of a client: the allow-list projection (both
// tiers), the schedule as runs, and the look ring's JS mirror. Pure; no DB.
import { describe, it, expect } from "vitest";
import {
  projectForTrainer, projectBreaks, scheduleRuns, runsWeekFor, nextLooks, trainerToday, rosterSignal,
  VIEW_KEYS, DETAIL_DAYS, TREND_DAYS, SELF_REF,
} from "@/lib/trainer-view";
import { mainLiftTrend, readinessBreakdown } from "@/lib/analytics";
import { auditHistoryVolume } from "@/lib/volume-audit";
import { makeDayContext, weeklyStrength, strengthRhythm } from "@/lib/day-state";
import { ensureScheduleHistory, scheduleEntryOn } from "@/lib/sync-merge";
import { addDaysIso, mondayOfWeekIso } from "@/lib/dates";
import { isResting } from "@/lib/breaks";

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
