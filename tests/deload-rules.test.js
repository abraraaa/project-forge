// @vitest-environment jsdom
// How a deload runs and ends, through the real engine
// (commitSessionRecord) and the card's plan (scheduledPlan): two sessions in
// a row whose main lift ignored it end it as declined. Its window runs from
// the day it was accepted to the next Monday: every session in it is a deload
// day, the first one after re-enters, or, with none in it, finds it rested.
// A bodyweight or assisted lift keeps its reps on a deload day and drops one
// set only after a hard last session. Nothing stored is deleted; the end is
// recorded beside the calendar close.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { H, TS, P, recordCompletion } from "../lib/storage.js";
import { commitSessionRecord } from "../lib/session-commit.js";
import { startDeload, liveDeload, deloadDayLabel } from "../lib/progression.js";
import { scheduledPlan, planStartWeight, deloadSessionSets } from "../lib/programme-resolve.js";
import { SESSIONS } from "../lib/programme.js";

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

/** Accept the offer on `day` November (Monday 2nd by default), before that day's session. */
const accept = (day = 2) => {
  vi.setSystemTime(at(day, 7));
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

  it("a backfilled ignored session before a later followed one does not end it", () => {
    three();
    accept();
    expect(session(2, [{ name: SQUAT, lifted: 100 }]).ended).toBeNull();
    expect(session(4, [{ name: SQUAT }]).ended).toBeNull();
    // Logged on Thursday 5th for Tuesday 3rd, at the pre-deload weight.
    vi.setSystemTime(at(5, 9));
    const rec = { v: 2, id: at(5, 9).toISOString(), date: iso(3), readiness: "normal", session: "strength-a",
      blocks: [{ id: "b0", type: "main", exercises: [{ name: SQUAT, loadType: "barbell", prescribed: { sets: 3, reps: 5, weight: 65 }, sets: sets(100, "barbell", 5, 3, 2) }] }] };
    const engine = commitSessionRecord(PROFILE, rec, { currentWeights: plan().weights });
    expect(engine.deloadEnded).toBeNull();
    expect(TS.get(PROFILE).mesocycle.activeDeload).not.toBeNull();
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

describe("the deload's window: from the day it was accepted to the next Monday", () => {
  // The last strength session before the offer: Saturday 31 October.
  const lastSaturday = () => H.append(PROFILE, { v: 2, id: new Date(2026, 9, 31, 10).toISOString(), date: "2026-10-31", session: "strength-c", blocks: [] });
  const tag = () => deloadDayLabel(liveDeload(TS.get(PROFILE).mesocycle.activeDeload, H.get(PROFILE)));

  it("accepted Monday, trained Monday and Sunday: both deload days, and the next Monday re-enters at 90", () => {
    three();
    lastSaturday();
    accept();
    expect(TS.get(PROFILE).mesocycle.activeDeload.plannedDays).toBe(7);
    expect(tag()).toBe("deload · day 1 of 7");
    const mon = session(2, [{ name: SQUAT }, { name: BENCH }]);
    expect([mon.cards[SQUAT].kg, mon.written[SQUAT], mon.ended, mon.closed]).toEqual([65, 65, null, false]);
    vi.setSystemTime(at(8));
    expect(tag()).toBe("deload · day 7 of 7");
    const sun = session(8, [{ name: SQUAT }]);
    expect([sun.cards[SQUAT].kg, sun.written[SQUAT], sun.ended, sun.closed]).toEqual([65, 65, null, false]);
    vi.setSystemTime(at(9));
    expect(tag()).toBeNull();
    expect([card(SQUAT).kg, card(BENCH).kg]).toEqual([90, 90]);
    const next = session(9, [{ name: SQUAT }]);
    expect([next.cards[SQUAT].kg, next.written[SQUAT], next.ended, next.closed]).toEqual([90, 92.5, null, true]);
    expect(TS.get(PROFILE).mesocycle.activeDeload).toBeNull();
    vi.setSystemTime(at(11));
    expect(card(BENCH).kg).toBe(90);
  });

  it("accepted Thursday: four days to Monday, a Saturday session is a deload day, and the Monday session re-enters", () => {
    three();
    lastSaturday();
    accept(5);
    expect(TS.get(PROFILE).mesocycle.activeDeload.plannedDays).toBe(4);
    expect(tag()).toBe("deload · day 1 of 4");
    const sat = session(7, [{ name: SQUAT }]);
    expect([sat.cards[SQUAT].kg, sat.written[SQUAT], sat.ended, sat.closed]).toEqual([65, 65, null, false]);
    vi.setSystemTime(at(8));
    expect(tag()).toBe("deload · day 4 of 4");
    const mon = session(9, [{ name: SQUAT }]);
    expect([mon.cards[SQUAT].kg, mon.written[SQUAT], mon.closed]).toEqual([90, 92.5, true]);
  });

  it("accepted Monday, no session until the next Tuesday: closed as rested, with the normal weights", () => {
    three();
    lastSaturday();
    accept();
    vi.setSystemTime(at(10));
    expect(tag()).toBeNull();
    expect([card(SQUAT).kg, card(BENCH).kg]).toEqual([100, 100]);
    const tue = session(10, [{ name: SQUAT }]);
    expect(tue.cards[SQUAT].kg).toBe(100);
    expect(tue.ended).toBe("rested");
    expect(tue.closed).toBe(false);
    expect(tue.written[SQUAT]).toBe(102.5);
    expect(lastEvent()).toMatchObject({ event: "deload_completed", reason: "rested" });
    for (const name of [SQUAT, BENCH, DEADLIFT]) expect(TS.get(PROFILE).lifts[name].inRecoveryUntil ?? 0).toBe(0);
  });

  it("a conditioning tick inside the window is not a strength session", () => {
    three();
    lastSaturday();
    accept();
    recordCompletion(PROFILE, iso(5), { kind: "tick" });
    vi.setSystemTime(at(9));
    expect(card(SQUAT).kg).toBe(100);
  });

  describe("a deload stored with only plannedDays (accepted before the window)", () => {
    // Accepted Monday 2 November with the old five-day count: its window is 2 to 6 November.
    const legacy = () => {
      vi.setSystemTime(at(2, 7));
      const ts = TS.get(PROFILE);
      TS.replaceState(PROFILE, { ...ts, mesocycle: { ...ts.mesocycle, currentPhase: "deload", activeDeload: {
        startedAt: at(2, 7).toISOString(), plannedDays: 5, triggeredBy: "stall_convergence", triggeredLifts: [SQUAT],
        preDeloadWeights: { [SQUAT]: 100, [BENCH]: 100, [DEADLIFT]: 100 } } } });
    };

    it("its days count to 5, a session in them is a deload day, and the first one after re-enters and closes it", () => {
      three();
      legacy();
      expect(tag()).toBe("deload · day 1 of 5");
      expect(session(2, [{ name: SQUAT }]).written[SQUAT]).toBe(65);
      expect(session(6, [{ name: BENCH }])).toMatchObject({ closed: false, ended: null });
      const sat = session(7, [{ name: SQUAT }]);
      expect([sat.cards[SQUAT].kg, sat.written[SQUAT], sat.closed]).toEqual([90, 92.5, true]);
    });

    it("with no session in its days, it closes as rested", () => {
      three();
      lastSaturday();
      legacy();
      const sat = session(7, [{ name: SQUAT }]);
      expect([sat.cards[SQUAT].kg, sat.ended]).toEqual([100, "rested"]);
    });
  });

  it("a deload accepted after a long gap runs from the day it was accepted", () => {
    three();
    H.append(PROFILE, { v: 2, id: new Date(2026, 9, 20, 10).toISOString(), date: "2026-10-20", session: "strength-a", blocks: [] });
    accept();
    const mon = session(2, [{ name: SQUAT }]);
    expect(mon.cards[SQUAT].kg).toBe(65);
    expect(mon.ended).toBeNull();
    expect(TS.get(PROFILE).mesocycle.activeDeload).not.toBeNull();
  });

  describe("a backfill dated before the deload was accepted", () => {
    // Accepted Wednesday 4th; logged that day for Tuesday 3rd.
    it("plans the day without the deload", () => {
      three();
      lastSaturday();
      accept(4);
      const active = TS.get(PROFILE).mesocycle.activeDeload;
      expect(liveDeload(active, H.get(PROFILE), iso(3))).toBeNull();
      const p = scheduledPlan({ weights: P.getWeights(PROFILE), reps: P.getReps(PROFILE), trainingState: TS.get(PROFILE), history: H.get(PROFILE), todayIso: iso(3) });
      expect(p.weights).toMatchObject({ [SQUAT]: 100, [BENCH]: 100 });
      expect(p.sets.day).toBe(false);
      expect(scheduledPlan({ weights: P.getWeights(PROFILE), trainingState: TS.get(PROFILE), history: H.get(PROFILE), todayIso: iso(4) }).weights[SQUAT]).toBe(65);
    });

    it("is not a deload day, and the deload runs on", () => {
      three();
      lastSaturday();
      accept(4);
      vi.setSystemTime(at(4, 9));
      const rec = { v: 2, id: at(4, 9).toISOString(), date: iso(3), readiness: "normal", session: "strength-a",
        blocks: [{ id: "b0", type: "main", exercises: [{ name: SQUAT, loadType: "barbell", prescribed: { sets: 3, reps: 5, weight: 100 }, sets: sets(100, "barbell", 5, 3, 2) }] }] };
      const engine = commitSessionRecord(PROFILE, rec, { currentWeights: { [SQUAT]: 100 } });
      expect(engine.deloadEnded).toBeNull();
      expect(engine.wwUpdates[SQUAT]).toBe(102.5);
      expect(TS.get(PROFILE).mesocycle.activeDeload).not.toBeNull();
      expect(card(SQUAT).kg).toBe(65);
    });
  });

  it("a backfilled record dated before the deload never closes it as rested", () => {
    three();
    H.append(PROFILE, { v: 2, id: new Date(2026, 9, 24, 10).toISOString(), date: "2026-10-24", session: "strength-b", blocks: [] });
    lastSaturday();
    accept();
    session(2, [{ name: SQUAT }, { name: BENCH }]);
    // Logged on Tuesday 3rd for Friday 30 October.
    vi.setSystemTime(at(3, 9));
    const rec = { v: 2, id: "2026-10-30T12:00:00.000Z", date: "2026-10-30", readiness: "normal", session: "strength-a",
      blocks: [{ id: "b0", type: "main", exercises: [{ name: SQUAT, loadType: "barbell", prescribed: { sets: 3, reps: 5, weight: 100 }, sets: sets(100, "barbell", 5, 3, 2) }] }] };
    const engine = commitSessionRecord(PROFILE, rec, { currentWeights: plan().weights });
    expect(engine.deloadEnded).toBeNull();
    expect(TS.get(PROFILE).mesocycle.activeDeload).not.toBeNull();
    // Not a deload day: judged on the standard path, and the card keeps the deload.
    expect(engine.wwUpdates[SQUAT]).not.toBe(65);
    expect(P.getWeights(PROFILE)[BENCH]).toBe(65);
    expect([card(SQUAT).kg, card(BENCH).kg]).toEqual([65, 65]);
  });
});

describe("bodyweight and assisted lifts on a deload day", () => {
  const PUSHUP = "Push-Up";
  const ASSISTED = "Assisted Pull-Up";
  /** A one-block session of `name`, three sets, as the session composes it. */
  const block = (name, sets = 3) => ({ name: "t", blocks: [{ id: "x1", type: "accessory", sets, ex: { name, reps: 10 } }] });
  const setsShown = (name, sets) => deloadSessionSets(block(name, sets), plan().sets).blocks[0].sets;
  const before = (rir) => {
    seed({ [PUSHUP]: state(null, 12), [ASSISTED]: state(20, 8), [SQUAT]: state(100) }, { [ASSISTED]: 20, [SQUAT]: 100 });
    P.saveReps(PROFILE, { [PUSHUP]: 12, [ASSISTED]: 8 });
    session(1, [{ name: SQUAT }, { name: PUSHUP, loadType: "bodyweight", reps: 12, rir }, { name: ASSISTED, loadType: "assisted_bodyweight", reps: 8, rir }]);
    accept();
    vi.setSystemTime(at(3));
  };

  it("an easy last session (RPE 7): the reps stay, one set fewer, and the assisted lift keeps its help", () => {
    before(3);
    // The reps as stored (the RPE 7 session climbed them to 13), not halved.
    expect(P.getReps(PROFILE)[PUSHUP]).toBe(13);
    expect(card(PUSHUP, "bodyweight", 12).reps).toBe(13);
    expect(card(ASSISTED, "assisted_bodyweight", 8)).toMatchObject({ kg: 20, reps: 8 });
    expect(setsShown(PUSHUP, 3)).toBe(2);
    expect(setsShown(ASSISTED, 3)).toBe(2);
    expect(setsShown(PUSHUP, 2)).toBe(2);
    // The loaded lift still deloads by load.
    expect(card(SQUAT).kg).toBe(65);
  });

  it("last session at RPE 8.5: the reps stay and the block drops one set, never below 2", () => {
    before(1.5);
    expect(card(PUSHUP, "bodyweight", 12).reps).toBe(12);
    expect(setsShown(PUSHUP, 3)).toBe(2);
    expect(setsShown(PUSHUP, 2)).toBe(2);
    expect(setsShown(ASSISTED, 4)).toBe(3);
    expect(card(ASSISTED, "assisted_bodyweight", 8).kg).toBe(20);
  });

  it("the deload day writes no reps and the help as it was", () => {
    before(1.5);
    const reps = P.getReps(PROFILE);
    const day = session(3, [{ name: SQUAT }, { name: PUSHUP, loadType: "bodyweight", reps: 12 }, { name: ASSISTED, loadType: "assisted_bodyweight", reps: 8 }]);
    expect(day.written).not.toHaveProperty(PUSHUP);
    expect(day.written[ASSISTED]).toBe(20);
    expect(P.getReps(PROFILE)).toEqual(reps);
  });

  it("a superset takes the smaller of its lifts' counts: a loaded partner's deload sets", () => {
    before(3);
    const ss = { name: "t", blocks: [{ id: "s1", type: "superset", sets: 4, exA: { name: PUSHUP }, exB: { name: BENCH } }] };
    expect(deloadSessionSets(ss, plan().sets).blocks[0].sets).toBe(2);
  });

  it("with no deload active nothing drops", () => {
    seed({ [PUSHUP]: state(null, 12) }, {});
    session(1, [{ name: PUSHUP, loadType: "bodyweight", reps: 12, rir: 0 }]);
    vi.setSystemTime(at(3));
    expect(plan().sets).toEqual({ day: false, lifts: {} });
    const s = SESSIONS[0];
    expect(deloadSessionSets(s, plan().sets)).toBe(s);
    expect(card(PUSHUP, "bodyweight", 12).reps).toBe(12);
  });
});

describe("loaded lifts on a deload day take the deload's set count", () => {
  const A = SESSIONS[0];
  const setsOf = (session, id) => session.blocks.find((b) => b.id === id).sets;
  const shown = () => deloadSessionSets(A, plan().sets);

  it("a 3-set main lift shows 2 sets on a deload day and 3 the day after the window, a loaded superset 2", () => {
    three();
    accept();
    expect([setsOf(A, "a1"), setsOf(A, "ass1")]).toEqual([3, 3]);
    expect([setsOf(shown(), "a1"), setsOf(shown(), "a2"), setsOf(shown(), "ass1")]).toEqual([2, 2, 2]);
    vi.setSystemTime(at(8));
    expect(setsOf(shown(), "a1")).toBe(2);
    vi.setSystemTime(at(9));
    expect(setsOf(shown(), "a1")).toBe(3);
    expect(shown()).toBe(A);
  });

  it("a 5-set power lift shows 3, and a lift never logged still takes its deload sets", () => {
    three();
    accept();
    const power = { name: "t", blocks: [{ id: "p1", type: "main", sets: 5, ex: { name: "Power Clean" } }, { id: "p2", type: "main", sets: 2, ex: { name: SQUAT } }] };
    const out = deloadSessionSets(power, plan().sets);
    expect(out.blocks.map((b) => b.sets)).toEqual([3, 2]);
    expect(plan().sets.lifts).not.toHaveProperty("Power Clean");
  });

  it("the deload day writes as before: the load cut, nothing stored beyond the session", () => {
    three();
    accept();
    const before = P.getReps(PROFILE);
    expect(session(2, [{ name: SQUAT, n: 2 }]).written[SQUAT]).toBe(65);
    expect(P.getReps(PROFILE)).toEqual(before);
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

describe("a weekend acceptance still gets a real deload", () => {
  it("runs to the next Monday, or the one after when fewer than three days are left", async () => {
    const { deloadWindowDays, deloadUntilWords } = await import("../lib/progression.js");
    // 16 Nov 2026 is a Monday.
    const day = (d) => new Date(2026, 10, d, 9, 0);
    expect([16, 17, 18, 19, 20, 21, 22].map((d) => deloadWindowDays(day(d)))).toEqual([7, 6, 5, 4, 3, 9, 8]);
    expect(deloadUntilWords(day(20))).toBe("until Monday");
    expect(deloadUntilWords(day(21))).toBe("until a week on Monday");
    expect(deloadUntilWords(day(22))).toBe("until a week on Monday");
  });

  it("a Sunday acceptance stores the eight-day window and the offer names it", async () => {
    const { startDeload, deloadCardCopy } = await import("../lib/progression.js");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 22, 9, 0));
      const ts = startDeload({ mesocycle: {}, lifts: {} }, { type: "stall_convergence", lifts: ["Barbell Back Squat"] });
      expect(ts.mesocycle.activeDeload.plannedDays).toBe(8);
      expect(deloadCardCopy({ type: "other" }).body).toBe("Lighter loads and reduced volume until a week on Monday. A short deload lets the fatigue clear before you push again.");
      vi.setSystemTime(new Date(2026, 10, 19, 9, 0));
      expect(deloadCardCopy({ type: "other" }).body).toBe("Lighter loads and reduced volume until Monday. A short deload lets the fatigue clear before you push again.");
    } finally { vi.useRealTimers(); }
  });
});

describe("ignoring a deload needs a deload that asks for something lighter", () => {
  it("lifting the card's weight never counts as ignoring when the deload rounds back to the pre-deload weight", async () => {
    const { ignoresDeload, computeDeloadPrescription } = await import("../lib/progression.js");
    const rec = (name, kg) => ({ blocks: [{ type: "main", exercises: [{ name, loadType: "barbell", sets: [{ weight: kg, reps: 5 }] }] }] });
    const OHP = "Barbell Overhead Press";
    // At 1.25 kg the deload rounds straight back to the pre-deload weight.
    expect(computeDeloadPrescription(OHP, { currentWeight: 1.25 }, { loadType: "barbell" }).weight).toBe(1.25);
    expect(ignoresDeload(rec(OHP, 1.25), { preDeloadWeights: { [OHP]: 1.25 } })).toBe(false);
    expect(ignoresDeload(rec("Barbell Back Squat", 100), { preDeloadWeights: { "Barbell Back Squat": 100 } })).toBe(true);
    expect(ignoresDeload(rec("Barbell Back Squat", 65), { preDeloadWeights: { "Barbell Back Squat": 100 } })).toBe(false);
  });
});
