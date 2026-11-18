// @vitest-environment jsdom
// The card shows the deload calendar's weight on the day it is due: the
// deload of the pre-deload weight from a lift's first deload visit, the
// re-entry on its first visit after the close, and the finalise writes the
// same values (lib/progression.js scheduledWeight, lib/programme-resolve.js
// scheduledPlan). Run through the real engine (commitSessionRecord).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { H, TS, P } from "../lib/storage.js";
import { commitSessionRecord } from "../lib/session-commit.js";
import { startDeload } from "../lib/progression.js";
import { scheduledPlan, planStartWeight } from "../lib/programme-resolve.js";

const PROFILE = "p";
const SQUAT = "Barbell Back Squat";
const DEADLIFT = "Hex Bar Deadlift";
const BENCH = "Barbell Bench Press";

const state = (currentWeight, reps = 5, over = {}) => ({
  currentWeight, nextPrescribed: currentWeight, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 0, consecutiveLightMisses: 0,
  stallSignal: null, history: [], currentRepRange: { reps, sets: 3, baseReps: reps }, ...over,
});

const at = (day, hour = 10) => new Date(2026, 10, day, hour, 0, 0);
const iso = (day) => `2026-11-${String(day).padStart(2, "0")}`;

const plan = () => scheduledPlan({
  weights: P.getWeights(PROFILE), reps: P.getReps(PROFILE), trainingState: TS.get(PROFILE), history: H.get(PROFILE),
});

/** The weight and reps the card opens with for a lift. */
const card = (name, loadType = "barbell", reps = 5) => {
  const p = plan();
  return {
    kg: loadType === "bodyweight" ? null : planStartWeight({ name, loadType, reps }, { working: p.weights, bodyweight: null, anchors: {} }),
    reps: p.reps[name] ?? reps,
  };
};

const sets = (kg, loadType, reps = 5, n = 3) => Array.from({ length: n }, () => ({
  weight: kg, reps, rir: 2, loadType,
  ...(loadType === "barbell" ? { effectiveLoad: kg, est1rm: kg * (1 + reps / 30) } : {}),
  ...(loadType === "loaded_bodyweight" ? { bodyweightUsed: 80, effectiveLoad: 80 + kg, est1rm: (80 + kg) * 1.2 } : {}),
  ...(loadType === "assisted_bodyweight" ? { bodyweightUsed: 80, effectiveLoad: 80 - kg, est1rm: (80 - kg) * 1.1 } : {}),
}));

/**
 * One session on `day`: the card is read, the lifter logs `lifted` (the
 * card's weight when omitted), and the record is committed.
 */
const visit = (day, name, { loadType = "barbell", lifted, readiness = "normal", reps = 5 } = {}) => {
  vi.setSystemTime(at(day));
  const shown = card(name, loadType, reps);
  const kg = lifted === undefined ? shown.kg : lifted;
  const rec = {
    v: 2, id: at(day).toISOString(), date: iso(day), readiness, session: "strength-a",
    blocks: [{ id: "a1", type: "main", exercises: [{
      name, loadType, prescribed: { sets: 3, reps: shown.reps, weight: shown.kg },
      sets: sets(kg, loadType, typeof shown.reps === "number" ? shown.reps : reps),
    }] }],
  };
  const engine = commitSessionRecord(PROFILE, rec, { currentWeights: plan().weights });
  return { card: shown.kg, reps: shown.reps, written: engine.wwUpdates[name], closed: engine.justCompletedDeload };
};

/** Accept the offer on Monday 2 November, before that day's session. */
const accept = () => {
  vi.setSystemTime(at(2, 7));
  TS.replaceState(PROFILE, startDeload(TS.get(PROFILE), { type: "stall_convergence", lifts: [SQUAT] }));
};

const seed = (lifts, weights) => {
  TS.save(PROFILE, { ...TS.get(PROFILE), lifts });
  P.saveWeights(PROFILE, weights);
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("a three-day week through a deload accepted on Monday", () => {
  it("every lift shows 65 on its deload day, 90 on its first visit after, then the ordinary climb", () => {
    seed({ [SQUAT]: state(100), [DEADLIFT]: state(100), [BENCH]: state(100) }, { [SQUAT]: 100, [DEADLIFT]: 100, [BENCH]: 100 });
    accept();
    const rows = [
      ["Mon", visit(2, SQUAT)],
      ["Wed", visit(4, DEADLIFT)],
      ["Fri", visit(6, BENCH)],
      ["Mon", visit(9, SQUAT)],
      ["Wed", visit(11, DEADLIFT)],
      ["Fri", visit(13, BENCH)],
      ["Mon", visit(16, SQUAT)],
      ["Wed", visit(18, DEADLIFT)],
      ["Fri", visit(20, BENCH)],
    ].map(([d, v]) => [d, v.card, v.written, v.closed]);
    expect(rows).toEqual([
      // The deload week: every lift's first visit shows the deload.
      ["Mon", 65, 65, false],
      ["Wed", 65, 65, false],
      // Friday closes it: its card is still a deload day; the write is the re-entry.
      ["Fri", 65, 90, true],
      // First visit after the close: the re-entry, anchored on 100.
      ["Mon", 90, 92.5, false],
      ["Wed", 90, 92.5, false],
      ["Fri", 90, 91.25, false],
      // Then the ordinary climb from what was lifted.
      ["Mon", 92.5, 95, false],
      ["Wed", 92.5, 95, false],
      ["Fri", 91.25, 92.5, false],
    ]);
  });

  it("the deload already running from a stored snapshot shows the deload on its next card, with nothing rewritten", () => {
    seed({ [SQUAT]: state(100) }, { [SQUAT]: 100 });
    accept();
    const before = JSON.stringify({ ts: TS.get(PROFILE), w: P.getWeightsRaw(PROFILE) });
    vi.setSystemTime(at(4));
    expect(card(SQUAT).kg).toBe(65);
    expect(JSON.stringify({ ts: TS.get(PROFILE), w: P.getWeightsRaw(PROFILE) })).toBe(before);
  });
});

describe("a lift with no snapshot entry", () => {
  it("first logged during the deload: its first session sets the base, later visits deload that base and never compound", () => {
    seed({ [SQUAT]: state(100) }, { [SQUAT]: 100 });
    accept();
    expect(TS.get(PROFILE).mesocycle.activeDeload.preDeloadWeights).not.toHaveProperty(DEADLIFT);
    // No base yet: the card keeps the stored weight it would open with.
    P.saveWeights(PROFILE, { ...P.getWeights(PROFILE), [DEADLIFT]: 80 });
    const first = visit(2, DEADLIFT);
    expect(first.card).toBe(80);
    expect(first.written).toBe(52.5);
    const second = visit(3, DEADLIFT);
    expect(second.card).toBe(52.5);
    expect(second.written).toBe(52.5);
    const third = visit(4, DEADLIFT);
    expect(third.card).toBe(52.5);
    expect(third.written).toBe(52.5);
    // The close anchors its re-entry on that base: 90% of 80.
    expect(visit(6, SQUAT).closed).toBe(true);
    expect(TS.get(PROFILE).lifts[DEADLIFT]).toMatchObject({ inRecoveryUntil: 3, preDeloadWeight: 80 });
    expect(visit(9, DEADLIFT).card).toBe(72.5);
  });
});

describe("bodyweight and assisted lifts (set counts: tests/deload-rules.test.js)", () => {
  it("bodyweight: the card keeps the reps on a deload day, writes no weight, and the reps hold after the close", () => {
    seed({ "Push-Up": state(null, 12), [SQUAT]: state(100) }, { [SQUAT]: 100 });
    P.saveReps(PROFILE, { "Push-Up": 12 });
    accept();
    const day = visit(2, "Push-Up", { loadType: "bodyweight", reps: 12 });
    expect(day.reps).toBe(12);
    expect(day.card).toBeNull();
    expect(day.written).toBeUndefined();
    expect(P.getReps(PROFILE)["Push-Up"]).toBe(12);
    expect(visit(6, SQUAT).closed).toBe(true);
    vi.setSystemTime(at(9));
    expect(card("Push-Up", "bodyweight", 12).reps).toBe(12);
  });

  it("assisted: the card holds the help and the reps", () => {
    seed({ "Assisted Pull-Up": state(20, 8) }, { "Assisted Pull-Up": 20 });
    P.saveReps(PROFILE, { "Assisted Pull-Up": 8 });
    accept();
    const day = visit(2, "Assisted Pull-Up", { loadType: "assisted_bodyweight", reps: 8 });
    expect(day).toMatchObject({ card: 20, reps: 8, written: 20 });
  });

  it("belted: the card deloads the added load from its snapshot", () => {
    seed({ "Pull-Up": state(10, 6) }, { "Pull-Up": 10 });
    accept();
    const day = visit(2, "Pull-Up", { loadType: "loaded_bodyweight", reps: 6 });
    expect(day).toMatchObject({ card: 6.25, reps: 6, written: 6.25 });
    expect(visit(3, "Pull-Up", { loadType: "loaded_bodyweight", reps: 6 }).card).toBe(6.25);
  });
});

describe("the lifter can always lift what they like", () => {
  it("a deload day dialled up to 100 shows 65, writes 65, keeps 100 as lifted, and re-enters at 90", () => {
    seed({ [SQUAT]: state(100), [BENCH]: state(100) }, { [SQUAT]: 100, [BENCH]: 100 });
    accept();
    const day = visit(2, SQUAT, { lifted: 100 });
    expect(day).toMatchObject({ card: 65, written: 65 });
    expect(TS.get(PROFILE).lifts[SQUAT].currentWeight).toBe(100);
    // Followed next time, so the deload runs on (two in a row would end it:
    // tests/deload-rules.test.js).
    expect(visit(4, SQUAT).card).toBe(65);
    expect(visit(6, BENCH).closed).toBe(true);
    expect(visit(9, SQUAT).card).toBe(90);
  });

  it("a cooked deload day shows 65 and writes 65", () => {
    seed({ [SQUAT]: state(100) }, { [SQUAT]: 100 });
    accept();
    expect(visit(2, SQUAT, { readiness: "cooked", lifted: 50 })).toMatchObject({ card: 65, written: 65 });
    expect(visit(3, SQUAT).card).toBe(65);
  });
});

describe("no deload active", () => {
  it("the stored weights and reps come back as they are", () => {
    seed({ [SQUAT]: state(100), "Push-Up": state(null, 12) }, { [SQUAT]: 100 });
    P.saveReps(PROFILE, { "Push-Up": 12 });
    const weights = P.getWeights(PROFILE);
    const reps = P.getReps(PROFILE);
    const out = scheduledPlan({ weights, reps, trainingState: TS.get(PROFILE), history: [] });
    expect(out.weights).toBe(weights);
    expect(out.reps).toBe(reps);
    expect(visit(2, SQUAT).card).toBe(100);
  });
});
