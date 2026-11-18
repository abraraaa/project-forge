// @vitest-environment jsdom
// How a deload ends besides its calendar close, through the real engine
// (commitSessionRecord) and the card's plan (scheduledPlan): two sessions in
// a row whose main lift ignored it end it as declined; time off as long as
// the deload ends it as rested. Nothing stored is deleted; the end is
// recorded beside the calendar close.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { H, TS, P, recordCompletion } from "../lib/storage.js";
import { commitSessionRecord } from "../lib/session-commit.js";
import { startDeload, liveDeload, deloadDayLabel } from "../lib/progression.js";
import { scheduledPlan, planStartWeight } from "../lib/programme-resolve.js";

const PROFILE = "p";
const SQUAT = "Barbell Back Squat";
const BENCH = "Barbell Bench Press";
const DEADLIFT = "Hex Bar Deadlift";

const state = (currentWeight, reps = 5, over = {}) => ({
  currentWeight, nextPrescribed: currentWeight, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 0, consecutiveLightMisses: 0,
  stallSignal: null, history: [], currentRepRange: { reps, sets: 3, baseReps: reps }, ...over,
});

const at = (day, hour = 10) => new Date(2026, 10, day, hour, 0, 0);
const iso = (day) => `2026-11-${String(day).padStart(2, "0")}`;

const plan = () => scheduledPlan({
  weights: P.getWeights(PROFILE), reps: P.getReps(PROFILE), trainingState: TS.get(PROFILE), history: H.get(PROFILE),
});

/** The weight and reps the card opens with for a lift on the current clock. */
const card = (name, loadType = "barbell", reps = 5) => {
  const p = plan();
  return {
    kg: loadType === "bodyweight" ? null : planStartWeight({ name, loadType, reps }, { working: p.weights, bodyweight: null, anchors: {} }),
    reps: p.reps[name] ?? reps,
  };
};

const sets = (kg, loadType, reps, n, rir) => Array.from({ length: n }, () => ({
  weight: kg, reps, rir, rpe: 10 - rir, loadType,
  ...(loadType === "barbell" ? { effectiveLoad: kg, est1rm: kg * (1 + reps / 30) } : {}),
}));

/**
 * One session on `day`: each lift's card is read, the lifter logs `lifted`
 * (the card's weight when omitted), and the record is committed. The first
 * lift sits in the session's first main block.
 * @param {number} day
 * @param {Array<{ name: string, lifted?: number|null, loadType?: string, reps?: number, rir?: number, n?: number }>} lifts
 */
const session = (day, lifts, { readiness = "normal" } = {}) => {
  vi.setSystemTime(at(day));
  const cards = {};
  const blocks = lifts.map(({ name, lifted, loadType = "barbell", reps = 5, rir = 2, n = 3 }, i) => {
    const shown = card(name, loadType, reps);
    cards[name] = shown;
    const kg = lifted === undefined ? shown.kg : lifted;
    return { id: `b${i}`, type: i === 0 ? "main" : "accessory", exercises: [{
      name, loadType, prescribed: { sets: n, reps: shown.reps, weight: shown.kg },
      sets: sets(kg, loadType, typeof shown.reps === "number" ? shown.reps : reps, n, rir),
    }] };
  });
  const rec = { v: 2, id: at(day).toISOString(), date: iso(day), readiness, session: "strength-a", blocks };
  const engine = commitSessionRecord(PROFILE, rec, { currentWeights: plan().weights });
  return { cards, written: engine.wwUpdates, ended: engine.deloadEnded, closed: engine.justCompletedDeload };
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

const three = () => seed(
  { [SQUAT]: state(100), [BENCH]: state(100), [DEADLIFT]: state(100) },
  { [SQUAT]: 100, [BENCH]: 100, [DEADLIFT]: 100 },
);
const lastEvent = () => TS.get(PROFILE).mesocycle.deloadSignals.history.at(-1);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("ignoring a deload", () => {
  it("two sessions in a row at the pre-deload weight end it at the second, with no re-entry drop", () => {
    three();
    accept();
    const mon = session(2, [{ name: SQUAT, lifted: 100 }, { name: BENCH }]);
    expect(mon.cards[SQUAT].kg).toBe(65);
    expect(mon.ended).toBeNull();
    expect(mon.written).toMatchObject({ [SQUAT]: 65, [BENCH]: 65 });

    const wed = session(4, [{ name: SQUAT, lifted: 100 }]);
    expect(wed.cards[SQUAT].kg).toBe(65);
    expect(wed.ended).toBe("declined");
    expect(wed.closed).toBe(false);
    // The main lift climbs from what was lifted; a lift left at its deload
    // weight returns to its pre-deload one; an untouched lift is left alone.
    expect(wed.written[SQUAT]).toBe(102.5);
    expect(wed.written[BENCH]).toBe(100);
    expect(wed.written).not.toHaveProperty(DEADLIFT);

    const ts = TS.get(PROFILE);
    expect(ts.mesocycle.activeDeload).toBeNull();
    expect(lastEvent()).toMatchObject({ event: "deload_completed", reason: "declined" });
    expect(ts.mesocycle.deloadSignals.history.map((e) => e.event)).toEqual(["deload_started", "deload_completed"]);
    for (const name of [SQUAT, BENCH, DEADLIFT]) expect(ts.lifts[name].inRecoveryUntil ?? 0).toBe(0);

    // The next cards: the ordinary weights, no deload and no 90%.
    vi.setSystemTime(at(6));
    expect(card(SQUAT).kg).toBe(102.5);
    expect(card(BENCH).kg).toBe(100);
    expect(card(DEADLIFT).kg).toBe(100);
  });

  it("a lift in the closing session that followed the deload card returns to its pre-deload weight", () => {
    three();
    accept();
    session(2, [{ name: SQUAT, lifted: 100 }]);
    const wed = session(4, [{ name: SQUAT, lifted: 100 }, { name: BENCH }]);
    expect(wed.cards[BENCH].kg).toBe(65);
    expect(wed.ended).toBe("declined");
    expect(wed.written[BENCH]).toBe(100);
    vi.setSystemTime(at(6));
    expect(card(BENCH).kg).toBe(100);
  });

  it("one ignored session does not end it", () => {
    three();
    accept();
    expect(session(2, [{ name: SQUAT, lifted: 100 }]).ended).toBeNull();
    expect(TS.get(PROFILE).mesocycle.activeDeload).not.toBeNull();
    vi.setSystemTime(at(3));
    expect(card(SQUAT).kg).toBe(65);
  });

  it("ignored, then followed, then ignored does not end it", () => {
    three();
    accept();
    expect(session(2, [{ name: SQUAT, lifted: 100 }]).ended).toBeNull();
    expect(session(3, [{ name: SQUAT }]).ended).toBeNull();
    const third = session(4, [{ name: SQUAT, lifted: 100 }]);
    expect(third.ended).toBeNull();
    expect(third.written[SQUAT]).toBe(65);
    expect(TS.get(PROFILE).mesocycle.activeDeload).not.toBeNull();
    vi.setSystemTime(at(5));
    expect(card(SQUAT).kg).toBe(65);
  });

  it("only the session's main lift counts", () => {
    three();
    accept();
    session(2, [{ name: SQUAT }, { name: BENCH, lifted: 100 }]);
    expect(session(3, [{ name: SQUAT }, { name: BENCH, lifted: 100 }]).ended).toBeNull();
    expect(TS.get(PROFILE).mesocycle.activeDeload).not.toBeNull();
  });
});

describe("a deload taken as a rest week", () => {
  // The last strength session before the offer: Saturday 31 October.
  const lastSaturday = () => H.append(PROFILE, { v: 2, id: new Date(2026, 9, 31, 10).toISOString(), date: "2026-10-31", session: "strength-c", blocks: [] });
  const tag = () => deloadDayLabel(liveDeload(TS.get(PROFILE).mesocycle.activeDeload, H.get(PROFILE)));

  it("a 5-day gap after a deload session: the next card shows the pre-deload weights and its session closes the deload as rested", () => {
    three();
    lastSaturday();
    accept();
    expect(session(2, [{ name: SQUAT }, { name: BENCH }]).written).toMatchObject({ [SQUAT]: 65, [BENCH]: 65 });
    vi.setSystemTime(at(6));
    expect(card(SQUAT).kg).toBe(65);
    expect(tag()).toBe("deload · day 5 of 5");
    vi.setSystemTime(at(7));
    expect(card(SQUAT).kg).toBe(100);
    expect(card(BENCH).kg).toBe(100);
    expect(tag()).toBeNull();

    const sat = session(7, [{ name: SQUAT }]);
    expect(sat.cards[SQUAT].kg).toBe(100);
    expect(sat.ended).toBe("rested");
    expect(sat.closed).toBe(false);
    expect(sat.written[SQUAT]).toBe(102.5);
    expect(sat.written[BENCH]).toBe(100);
    expect(TS.get(PROFILE).mesocycle.activeDeload).toBeNull();
    expect(lastEvent()).toMatchObject({ event: "deload_completed", reason: "rested" });
    for (const name of [SQUAT, BENCH, DEADLIFT]) expect(TS.get(PROFILE).lifts[name].inRecoveryUntil ?? 0).toBe(0);

    vi.setSystemTime(at(9));
    expect([card(SQUAT).kg, card(BENCH).kg, card(DEADLIFT).kg]).toEqual([102.5, 100, 100]);
  });

  it("no session at all through the deload: a late return sees the normal weights, not one more deload card", () => {
    three();
    lastSaturday();
    accept();
    vi.setSystemTime(at(5));
    expect(card(SQUAT).kg).toBe(100);
    expect(tag()).toBeNull();
    const thu = session(5, [{ name: SQUAT }]);
    expect(thu.ended).toBe("rested");
    expect(thu.written[SQUAT]).toBe(102.5);
  });

  it("a conditioning tick is not a strength session: it does not shorten the gap", () => {
    three();
    lastSaturday();
    accept();
    recordCompletion(PROFILE, iso(3), { kind: "tick" });
    vi.setSystemTime(at(5));
    expect(card(SQUAT).kg).toBe(100);
  });

  it("a 4-day gap is the calendar close: a deload card that day, then the re-entry", () => {
    three();
    lastSaturday();
    accept();
    session(2, [{ name: SQUAT }]);
    const fri = session(6, [{ name: BENCH }]);
    expect(fri.cards[BENCH].kg).toBe(65);
    expect(fri.ended).toBeNull();
    expect(fri.closed).toBe(true);
    vi.setSystemTime(at(9));
    expect(card(SQUAT).kg).toBe(90);
  });
});

describe("no deload active", () => {
  it("two sessions at the working weight are ordinary sessions", () => {
    three();
    const a = session(2, [{ name: SQUAT, lifted: 100 }]);
    const b = session(4, [{ name: SQUAT }]);
    expect([a.ended, b.ended]).toEqual([null, null]);
    expect(b.cards[SQUAT].kg).toBe(102.5);
    expect(TS.get(PROFILE).mesocycle.deloadSignals?.history ?? []).toEqual([]);
  });
});
