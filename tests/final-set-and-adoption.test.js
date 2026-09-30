// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The engine judges what was done against what was prescribed.
//
//   - a live exercise records `prescribed`, so a first set logged short is a
//     miss, not the new target (it used to read 3/3/3 as PERFORMED_FULL);
//   - a short LAST set on an otherwise full session is final_set_miss: still
//     a light miss (the third in a row drops 5%), never a stall;
//   - a shortfall with reps in reserve is the lifter's choice: HOLD, never a
//     load cut (voluntary_shortfall), and it feeds the adoption streak;
//   - ADOPT_AFTER_SESSIONS qualifying voluntary shortfalls of the same size
//     adopt the lifter's reps as the target. Nothing else adopts.
//
// Records go through the real draft (logSet / finaliseDraft), the real
// history and the real engine (applySessionToEngine), carrying W and R
// forward the way SessionHost does.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { H, TS, newDraftLog, logSet, finaliseDraft } from "../lib/storage.js";
import { applySessionToEngine } from "../lib/session-engine.js";
import {
  computeNextPrescription, overrideStreakStep, isFinalSetMiss, lastSessionNote, ADOPT_AFTER_SESSIONS,
} from "../lib/progression.js";

const SQUAT = "Barbell Back Squat";
let day = 0;

// One session of the squat. `reps` per set; `rir` one value or one per set.
// `prescribed` defaults to the carried W / R (8 reps unless R says so).
function session(p, { reps, rir = 2, weight, target, prescribed, readiness = "normal", reach = [] }, carry) {
  day += 1;
  const draft = newDraftLog({ profileName: p, session: "strength-a", blockNumber: 1, readiness });
  draft.id = `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  draft.date = `2026-08-${String(day).padStart(2, "0")}`;
  const presc = prescribed === null ? null
    : prescribed ?? { reps: target ?? carry.R[SQUAT] ?? 8, weight: carry.W[SQUAT] ?? 100, sets: 3 };
  reps.forEach((r, i) => {
    const setRir = Array.isArray(rir) ? rir[i] : rir;
    logSet(draft, {
      blockId: "a1", blockType: "main", exerciseName: SQUAT, muscle: "Quadriceps",
      loadType: "barbell", weight: weight ?? carry.W[SQUAT] ?? 100, reps: r, rpe: 10 - setRir,
      reach: reach.includes(i), ...(presc ? { prescribed: presc } : {}),
    });
  });
  const rec = finaliseDraft(draft);
  H.append(p, rec);
  const out = applySessionToEngine(p, rec, { currentWeights: carry.W });
  Object.assign(carry.W, out.wwUpdates);
  Object.assign(carry.R, out.wrUpdates);
  const lift = TS.get(p).lifts[SQUAT];
  return { out, lift, last: lift.history.at(-1) };
}
const reasonOf = (h) => (h.rationale.find((r) => r.startsWith("decision_reason=")) || "").slice("decision_reason=".length);
const fresh = () => ({ W: { [SQUAT]: 100 }, R: {} });
// A lift's first session is a cold start; every streak begins after one.
// Full at RIR 2: an ADD, so the counters start clean.
const warm = (p, c, target) => session(p, { reps: [target ?? 8, target ?? 8, target ?? 8], rir: 2, target }, c);

beforeEach(() => { localStorage.clear(); day = 0; });

// ─── Judged against the prescription ─────────────────────────────────────────
describe("a first set logged short is a miss, not the new target", () => {
  it("3/3/3 against a prescribed 5 at RIR 1 is no ADD", () => {
    const c = fresh();
    session("p", { reps: [5, 5, 5], rir: 2, prescribed: { reps: 5, weight: 100, sets: 3 } }, c);
    const { out, last } = session("p", { reps: [3, 3, 3], rir: 1, prescribed: { reps: 5, weight: c.W[SQUAT], sets: 3 } }, c);
    expect(last.decision).not.toBe("ADD");
    expect(out.wwUpdates[SQUAT]).toBeLessThan(102.5);
    expect(reasonOf(last)).toMatch(/^missed_/);
  });

  it("an old record without `prescribed` keeps the implied target (first set)", () => {
    const c = fresh();
    session("p", { reps: [5, 5, 5], rir: 2, prescribed: null }, c);
    const { last } = session("p", { reps: [3, 3, 3], rir: 2, prescribed: null }, c);
    expect(last.decision).toBe("ADD");
  });
});

// ─── Final set short ─────────────────────────────────────────────────────────
describe("final set short on an otherwise full session", () => {
  const state = (extra = {}) => ({
    currentWeight: 100, sessionsCount: 6, consecutiveAdds: 0, consecutiveHolds: 1, consecutiveLightMisses: 0,
    stallSignal: null, currentRepRange: { reps: 5, sets: 3, baseReps: 5 }, history: [], ...extra,
  });

  it("at RPE 9: HOLD, final_set_miss, consecutiveHolds unchanged", () => {
    const c = fresh();
    session("p", { reps: [5, 5, 5], rir: 2, prescribed: { reps: 5, weight: 100, sets: 3 } }, c);
    TS.updateLift("p", SQUAT, { ...TS.get("p").lifts[SQUAT], consecutiveHolds: 1, consecutiveLightMisses: 0, stallSignal: null });
    const { lift, last, out } = session("p", { reps: [5, 5, 4], rir: 1, prescribed: { reps: 5, weight: c.W[SQUAT], sets: 3 } }, c);
    expect(last.decision).toBe("HOLD");
    expect(reasonOf(last)).toBe("final_set_miss");
    expect(lift.consecutiveHolds).toBe(1);
    expect(out.wwUpdates[SQUAT]).toBe(c.W[SQUAT]);
    expect(lastSessionNote(lift)).toEqual({ kind: "final_set_miss" });
  });

  it("still a light miss: it counts toward the run, and the third drops 5%", () => {
    const history = [{ id: "x", date: "2026-08-01", readiness: "normal", blocks: [{ type: "main", exercises: [{
      name: SQUAT, loadType: "barbell", prescribed: { reps: 5, sets: 3, weight: 100 },
      sets: [5, 5, 4].map((reps) => ({ weight: 100, effectiveLoad: 100, reps, rir: 1 })) }] }] }];
    const p = (n) => computeNextPrescription({ liftName: SQUAT, history, liftState: state({ consecutiveLightMisses: n }), context: { readiness: "normal" } });
    expect(p(0).decisionReason).toBe("final_set_miss");
    expect(p(2).decision).toBe("DROP_5");
    expect(p(2).decisionReason).toBe("missed_light_repeated");
  });

  it("an earlier set short is the ordinary light miss, and a stall step", () => {
    const c = fresh();
    session("p", { reps: [5, 5, 5], rir: 2, prescribed: { reps: 5, weight: 100, sets: 3 } }, c);
    const before = TS.get("p").lifts[SQUAT].consecutiveHolds;
    const { lift, last } = session("p", { reps: [5, 4, 5], rir: 1, prescribed: { reps: 5, weight: c.W[SQUAT], sets: 3 } }, c);
    expect(reasonOf(last)).toBe("missed_light");
    expect(lift.consecutiveHolds).toBe(before + 1);
  });

  it("all sets full at RIR ≥ threshold still ADDs", () => {
    const c = fresh();
    session("p", { reps: [5, 5, 5], rir: 2, prescribed: { reps: 5, weight: 100, sets: 3 } }, c);
    const { last, out } = session("p", { reps: [5, 5, 5], rir: 2, prescribed: { reps: 5, weight: c.W[SQUAT], sets: 3 } }, c);
    expect(last.decision).toBe("ADD");
    expect(out.wwUpdates[SQUAT]).toBeGreaterThan(100);
  });

  it("isFinalSetMiss is the last prescribed set only, by a light margin", () => {
    const ex = (reps, sets = 3) => ({ prescribed: { reps: 5, sets }, sets: reps.map((r) => ({ reps: r })) });
    expect(isFinalSetMiss(ex([5, 5, 4]))).toBe(true);
    expect(isFinalSetMiss(ex([5, 4, 5]))).toBe(false);
    expect(isFinalSetMiss(ex([5, 5, 1]))).toBe(false);   // not light: the existing path
    expect(isFinalSetMiss(ex([5, 5]))).toBe(false);      // partial: the last set never came
    expect(isFinalSetMiss(ex([4], 1))).toBe(false);      // one set is not "the rest on target"
  });
});

// ─── Voluntary shortfall ─────────────────────────────────────────────────────
describe("a shortfall with reps in reserve is a choice, not a failure", () => {
  it("6,6,6 of 8 at RIR 3: HOLD, voluntary_shortfall, no load cut, no stall step, streak 1", () => {
    const c = fresh();
    warm("p", c);
    const w = c.W[SQUAT];
    const { lift, last, out } = session("p", { reps: [6, 6, 6], rir: 3 }, c);
    expect(last.decision).toBe("HOLD");
    expect(reasonOf(last)).toBe("voluntary_shortfall");
    expect(out.wwUpdates[SQUAT]).toBe(w);
    expect(lift.consecutiveHolds).toBe(0);
    expect(lift.overrideStreak).toBe(1);
  });

  it("6,6,6 of 8 at RIR 0: the existing miss path, and no streak", () => {
    const c = fresh();
    warm("p", c);
    const w = c.W[SQUAT];
    const { lift, last, out } = session("p", { reps: [6, 6, 6], rir: 0 }, c);
    expect(reasonOf(last)).toBe("missed_moderate");
    expect(last.decision).toBe("DROP_5");
    expect(out.wwUpdates[SQUAT]).toBeLessThan(w);
    expect(lift.overrideStreak ?? 0).toBe(0);
  });
});

// ─── Adoption ────────────────────────────────────────────────────────────────
describe(`adopting a repeated chosen rep target (ADOPT_AFTER_SESSIONS = ${ADOPT_AFTER_SESSIONS})`, () => {
  const chosen = { reps: [6, 6, 6], rir: 3 };

  it("two sessions change nothing; the third adopts, writes wrUpdates and resets the streak", () => {
    const c = fresh();
    warm("p", c);
    let r = session("p", chosen, c);
    r = session("p", chosen, c);
    expect(r.lift.overrideStreak).toBe(2);
    expect(r.out.wrUpdates).toEqual({});
    expect(c.R).toEqual({});

    r = session("p", chosen, c);
    expect(r.out.wrUpdates).toEqual({ [SQUAT]: 6 });
    expect(r.lift.overrideStreak).toBe(0);
    expect(r.lift.adoptedAt).toBe(r.last.date);
    expect(r.lift.adoptedReps).toBe(6);
    expect(r.lift.currentRepRange).toMatchObject({ reps: 6, baseReps: 6 });
    expect(r.lift.consecutiveHolds).toBe(0);
    expect(lastSessionNote(r.lift)).toEqual({ kind: "adopted", reps: 6 });

    // The next session is judged against 6: full at RIR 2 is an ADD, and the
    // note is gone.
    r = session("p", { reps: [6, 6, 6], rir: 2 }, c);
    expect(r.last.decision).toBe("ADD");
    expect(c.R[SQUAT]).toBe(6);
    expect(lastSessionNote(r.lift)).toBe(null);
  });

  it("adopts the highest first set of the streak, and never below 3", () => {
    const c = fresh();
    warm("p", c);
    session("p", { reps: [6, 6, 6], rir: 3 }, c);
    session("p", { reps: [5, 5, 5], rir: 3 }, c);
    const r = session("p", { reps: [6, 5, 5], rir: 3 }, c);
    expect(r.out.wrUpdates).toEqual({ [SQUAT]: 6 });

    const c2 = fresh();
    let r2;
    warm("q", c2, 5);
    for (let i = 0; i < 3; i++) r2 = session("q", { reps: [2, 2, 2], rir: 3, target: 5 }, c2);
    expect(r2.out.wrUpdates).toEqual({ [SQUAT]: 3 });
  });

  it("a session on target resets it", () => {
    const c = fresh();
    warm("p", c);
    session("p", chosen, c);
    session("p", chosen, c);
    const r = session("p", { reps: [8, 8, 8], rir: 1 }, c);
    expect(r.lift.overrideStreak).toBe(0);
    const r2 = session("p", chosen, c);
    expect(r2.lift.overrideStreak).toBe(1);
    expect(r2.out.wrUpdates).toEqual({});
  });

  it("a first set outside ±1 of the streak starts a new one", () => {
    const c = fresh();
    warm("p", c);
    session("p", chosen, c);
    session("p", chosen, c);
    const r = session("p", { reps: [4, 4, 4], rir: 3 }, c);
    expect(r.lift.overrideStreak).toBe(1);
    expect(r.out.wrUpdates).toEqual({});
  });

  it("an engine load change resets it (a capacity miss that drops)", () => {
    const c = fresh();
    warm("p", c);
    session("p", chosen, c);
    session("p", chosen, c);
    const r = session("p", { reps: [6, 6, 6], rir: 0 }, c);
    expect(r.last.decision).toBe("DROP_5");
    expect(r.lift.overrideStreak).toBe(0);
  });

  it("a new target from elsewhere mid-streak restarts it", () => {
    const c = fresh();
    warm("p", c);
    session("p", chosen, c);
    session("p", chosen, c);
    c.R[SQUAT] = 7; // a trainer edit
    const r = session("p", chosen, c);
    expect(r.lift.overrideStreak).toBe(1);
    expect(r.out.wrUpdates).toEqual({});
  });

  it("a final-set-only shortfall never counts, even with reps in reserve", () => {
    const c = fresh();
    warm("p", c);
    session("p", chosen, c);
    const r = session("p", { reps: [8, 8, 6], rir: 3 }, c);
    expect(r.lift.overrideStreak).toBe(0);
  });

  it("cooked, partial and a different load freeze it", () => {
    const c = fresh();
    warm("p", c);
    session("p", chosen, c);
    session("p", chosen, c);
    let r = session("p", { ...chosen, readiness: "cooked" }, c);
    expect(r.lift.overrideStreak).toBe(2);
    r = session("p", { reps: [6, 6], rir: 3 }, c);
    expect(r.lift.overrideStreak).toBe(2);
    r = session("p", { ...chosen, weight: 90 }, c);
    expect(r.lift.overrideStreak).toBe(2);
    expect(c.R).toEqual({});
    // ...and the streak picks up where it was.
    r = session("p", chosen, c);
    expect(r.out.wrUpdates).toEqual({ [SQUAT]: 6 });
  });

  it("weight deviations never adopt anything", () => {
    const c = fresh();
    warm("p", c);
    let r;
    for (let i = 0; i < 4; i++) r = session("p", { reps: [8, 8, 8], rir: 3, weight: 90 }, c);
    expect(c.R).toEqual({});
    expect(r.lift.overrideStreak ?? 0).toBe(0);
    expect(r.lift.adoptedAt).toBeUndefined();
  });

  it("doing more is not adopted: the existing ADD answers it", () => {
    const c = fresh();
    warm("p", c);
    let r;
    for (let i = 0; i < 4; i++) r = session("p", { reps: [10, 10, 10], rir: 3 }, c);
    expect(r.last.decision).toBe("ADD");
    expect(c.R).toEqual({});
    expect(r.lift.adoptedAt).toBeUndefined();
  });

  it("reach sets are left out", () => {
    const c = fresh();
    warm("p", c);
    let r;
    for (let i = 0; i < 3; i++) r = session("p", { reps: [6, 6, 6, 2], rir: 3, reach: [3] }, c);
    expect(r.out.wrUpdates).toEqual({ [SQUAT]: 6 });
  });

  it("timed holds never adopt", () => {
    const hold = { decision: "HOLD", decisionReason: "voluntary_shortfall", rationale: [], repRangeChanged: false };
    const ex = { prescribed: { reps: "45s", sets: 3, weight: null }, sets: [30, 30, 30].map((reps) => ({ reps, rir: 3 })) };
    let st = null;
    for (let i = 0; i < 4; i++) {
      const step = overrideStreakStep(st, ex, hold, { timed: true });
      expect(step.adoptReps).toBe(null);
      expect(step.frozen).toBe(true);
      st = { overrideStreak: step.overrideStreak };
    }
  });

  it("a lift that never deviates keeps its old shape (no streak fields)", () => {
    const c = fresh();
    warm("p", c);
    let r;
    for (let i = 0; i < 3; i++) r = session("p", { reps: [8, 8, 8], rir: 2 }, c);
    expect(r.lift).not.toHaveProperty("overrideStreak");
    expect(r.lift).not.toHaveProperty("adoptedAt");
  });
});
