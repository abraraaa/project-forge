// @vitest-environment jsdom
// tests/session-engine.test.js
// ─────────────────────────────────────────────────────────────────────────────
// #16 locks: ONE session-finalise engine, shared by the live and retro paths.
// Behavioural: the engine applies a record to TS (lift state advances,
// volume aggregates recompute) and honours the older-backfill guard.
// Class lock: neither component may ever grow a second engine copy.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { H, TS } from "../lib/storage.js";
import { applySessionToEngine } from "../lib/session-engine.js";
import { coldStartFromAnchor } from "../lib/lift-translations.js";
import { lastSessionNote } from "../lib/progression.js";
import { SESSION_COPY } from "../lib/session-copy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const record = (id, date, weight) => ({
  id, date, dow: 1, type: "strength", session: "strength-a", readiness: "normal",
  blocks: [{ id: "a1", type: "main", exercises: [{
    name: "Barbell Back Squat", muscle: "Quadriceps",
    sets: [{ weight, reps: 5, rir: 2, volume: weight * 5, effectiveLoad: weight, est1rm: weight * 1.16 }],
    totalVolume: weight * 10, topSet: { weight, reps: 5 },
  }]}],
  duration: 3000,
});

describe("applySessionToEngine", () => {
  beforeEach(() => localStorage.clear());

  it("applies a live record: lift state advances, volume recomputes, prescription lands in wwUpdates", () => {
    const rec = record(new Date().toISOString(), "2026-07-24", 100);
    H.append("p", rec);
    const out = applySessionToEngine("p", rec);
    const lift = TS.get("p").lifts?.["Barbell Back Squat"];
    expect(lift).toBeTruthy();
    expect(lift.currentWeight).toBeGreaterThan(0);
    expect(typeof out.wwUpdates["Barbell Back Squat"]).toBe("number");
    expect(out.justCompletedDeload).toBe(false);
    expect(TS.get("p").volume).toBeTruthy();
  });

  it("older-backfill guard: a retro record older than the newest evidence never regresses lift state", () => {
    const newer = record("2026-07-20T10:00:00.000Z", "2026-07-20", 110);
    H.append("p2", newer);
    applySessionToEngine("p2", newer);
    const before = TS.get("p2").lifts["Barbell Back Squat"].currentWeight;

    const older = record("2026-07-01T10:00:00.000Z", "2026-07-01", 80);
    H.append("p2", older);
    applySessionToEngine("p2", older);
    expect(TS.get("p2").lifts["Barbell Back Squat"].currentWeight).toBe(before); // untouched
  });

  it("is defensive: null inputs return the empty summary without touching stores", () => {
    expect(applySessionToEngine(null, null)).toEqual({ wwUpdates: {}, wrUpdates: {}, justCompletedDeload: false, stillInDeload: false });
  });
});

describe("#16 class lock — the engine lives ONCE", () => {
  it("neither component contains the per-exercise engine loop any more", () => {
    // The live host reaches the engine through lib/session-commit.js.
    for (const rel of ["components/SessionHost.jsx", "lib/session-commit.js", "components/ForgeApp.jsx"]) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect(src, `${rel} re-grew an engine copy`).not.toContain("computeNextPrescription(");
      expect(src, rel).not.toContain("updateLiftStateFromSession(");
      expect(src, rel).not.toContain("reconcileLiftStateWithSession(");
      if (rel !== "components/SessionHost.jsx") expect(src, rel).toContain("applySessionToEngine(");
    }
  });
});

// A stale total (bodyweight) stored as a pull-up's added load heals on the
// next unloaded session: the engine writes 0 back (2026-09-25).
describe("bodyweight lifts heal a stale working weight", () => {
  beforeEach(() => localStorage.clear());
  it("an unloaded pull-up session writes 0 added, and lift state follows", () => {
    const BW = 79.8;
    const set = { weight: 0, reps: 8, rir: 2, loadType: "loaded_bodyweight", bodyweightUsed: BW, effectiveLoad: BW };
    const rec = {
      v: 2, id: new Date().toISOString(), date: "2026-09-25", readiness: "normal", session: "strength_b",
      blocks: [{ id: "bss1", type: "superset", exercises: [{
        name: "Pull-Up", muscle: "Lats", loadType: "loaded_bodyweight", sets: [set, set, set],
        prescribed: { sets: 3, reps: 8, weight: BW }, summary: { topSet: set },
      }] }],
    };
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: BW, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0 } } });
    H.append("p", rec);
    const out = applySessionToEngine("p", rec, { currentWeights: { "Pull-Up": BW } });
    expect(out.wwUpdates["Pull-Up"]).toBe(0);
    expect(TS.get("p").lifts["Pull-Up"].currentWeight).toBe(0);
  });
});

// The bodyweight rep climb reaches the session screen through wrUpdates, up to
// base + 3, then holds (2026-09-29).
describe("bodyweight rep climb reaches the session", () => {
  beforeEach(() => localStorage.clear());
  let n = 0;
  // Live-shaped: no prescribed; every set logs the target the session showed.
  const bwRecord = (name, reps, { rir = 2, loadType = "bodyweight", weight = null } = {}) => {
    n += 1;
    const set = { weight, reps, rir, loadType };
    const at = new Date(Date.UTC(2026, 8, n, 10)).toISOString();
    return {
      v: 2, id: at, date: at.slice(0, 10),
      readiness: "normal", session: "strength-a",
      blocks: [{ id: "ass2", type: "superset", exercises: [{ name, muscle: "Glutes", loadType, sets: [set, set, set] }] }],
    };
  };
  const seed = (name) => TS.save("p", { lifts: { [name]: { currentWeight: null, sessionsCount: 3, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
  const apply = (rec) => { H.append("p", rec); return applySessionToEngine("p", rec); };

  it("a full, easy pure-bodyweight session writes the next target", () => {
    seed("Glute Bridge");
    const out = apply(bwRecord("Glute Bridge", 12));
    expect(out.wrUpdates["Glute Bridge"]).toBe(13);
    expect(out.wwUpdates["Glute Bridge"]).toBeUndefined();
  });

  it("climbs session by session to base + 3, then holds without a stall", () => {
    seed("Glute Bridge");
    let target = 12;
    const shown = [];
    for (let i = 0; i < 6; i++) {
      const out = apply(bwRecord("Glute Bridge", target));
      target = out.wrUpdates["Glute Bridge"] ?? target;
      shown.push(target);
    }
    expect(shown).toEqual([13, 14, 15, 15, 15, 15]);
    const lift = TS.get("p").lifts["Glute Bridge"];
    expect(lift.stallSignal).toBeNull();
    expect(lift.currentRepRange).toMatchObject({ reps: 15, baseReps: 12, bwClimb: true });
  });

  it("keeps the per-leg shape", () => {
    seed("Reverse Lunge");
    expect(apply(bwRecord("Reverse Lunge", "15/leg")).wrUpdates["Reverse Lunge"]).toBe("16/leg");
  });

  it("a retro record takes the shape from its prescribed target", () => {
    seed("Reverse Lunge");
    const rec = bwRecord("Reverse Lunge", 15);
    rec.blocks[0].exercises[0].prescribed = { sets: 3, reps: "15/leg", weight: null, rir: null };
    expect(apply(rec).wrUpdates["Reverse Lunge"]).toBe("16/leg");
  });

  it("a timed hold writes nothing", () => {
    seed("L-Sit Hold");
    const out = apply(bwRecord("L-Sit Hold", "20s", { rir: 3 }));
    expect(out.wrUpdates).toEqual({});
    expect(TS.get("p").lifts["L-Sit Hold"].currentRepRange.reps).toBe(20);
    // A met hold is not a stall.
    expect(TS.get("p").lifts["L-Sit Hold"].consecutiveHolds).toBe(0);
  });

  it("an unloaded pull-up climbs reps and keeps 0 added", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
    const out = apply(bwRecord("Pull-Up", 8, { loadType: "loaded_bodyweight", weight: 0 }));
    expect(out.wrUpdates["Pull-Up"]).toBe(9);
    expect(out.wwUpdates["Pull-Up"]).toBe(0);
  });

  it("an unloaded pull-up at the ceiling holds and adds no load", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [],
      currentRepRange: { reps: 11, sets: 3, baseReps: 8, bwClimb: true } } } });
    const out = apply(bwRecord("Pull-Up", 11, { loadType: "loaded_bodyweight", weight: 0, rir: 3 }));
    expect(out.wrUpdates["Pull-Up"]).toBeUndefined();
    expect(out.wwUpdates["Pull-Up"]).toBe(0);
  });

  it("a belted session does not reset the unloaded climb's base", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
    let target = 8;
    const shown = [];
    // Unloaded to the ceiling, then belt and no belt alternating.
    const belts = [0, 0, 0, 0, 5, 0, 0, 5, 0, 5, 0, 0];
    for (const weight of belts) {
      const out = apply(bwRecord("Pull-Up", target, { loadType: "loaded_bodyweight", weight, rir: 3 }));
      target = out.wrUpdates["Pull-Up"] ?? target;
      shown.push(target);
    }
    expect(shown.slice(0, 4)).toEqual([9, 10, 11, 11]);
    expect(Math.max(...shown)).toBe(11);
  });

  it("belted stalls and unloaded sessions alternating never climb past base + 3", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
    let target = 8;
    const shown = [];
    // Hard belted sessions stall and climb the loaded target; easy unloaded
    // ones then climb from wherever that left it.
    const round = [...Array(7).fill([5, 1]), ...Array(4).fill([0, 3])];
    for (const [weight, rir] of [...round, ...round, ...round]) {
      const out = apply(bwRecord("Pull-Up", target, { loadType: "loaded_bodyweight", weight, rir }));
      target = out.wrUpdates["Pull-Up"] ?? target;
      shown.push(target);
    }
    expect(Math.max(...shown)).toBe(11);
    expect(TS.get("p").lifts["Pull-Up"].currentRepRange.baseReps).toBe(8);
  });

  it("a belted session after an unloaded climb banks the reps back to base", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [],
      currentRepRange: { reps: 11, sets: 3, baseReps: 8, bwClimb: true } } } });
    const out = apply(bwRecord("Pull-Up", 11, { loadType: "loaded_bodyweight", weight: 5, rir: 3 }));
    expect(out.wrUpdates["Pull-Up"]).toBe(8);
    expect(out.wwUpdates["Pull-Up"]).toBeGreaterThan(5);
  });

  it("a belted session after an unloaded climb banks at RPE 9 too", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [],
      currentRepRange: { reps: 11, sets: 3, baseReps: 8, bwClimb: true } } } });
    const out = apply(bwRecord("Pull-Up", 11, { loadType: "loaded_bodyweight", weight: 5, rir: 1 }));
    expect(out.wrUpdates["Pull-Up"]).toBe(8);
    expect(out.wwUpdates["Pull-Up"]).toBeGreaterThan(5);
  });

  it("a timed hold logged as integer seconds still never climbs", () => {
    seed("L-Sit Hold");
    apply(bwRecord("L-Sit Hold", "20s", { rir: 3 }));
    // A drum override logs whole seconds, not "25s".
    const out = apply(bwRecord("L-Sit Hold", 25, { rir: 3 }));
    expect(out.wrUpdates).toEqual({});
    expect(TS.get("p").lifts["L-Sit Hold"].currentRepRange).toMatchObject({ reps: 25, timed: true });
  });

  it("a timed hold drummed to whole seconds before any timed record still never climbs", () => {
    TS.save("p", { lifts: { "L-Sit Hold": { currentWeight: null, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [],
      currentRepRange: { reps: 25, sets: 3, baseReps: 25 } } } });
    const out = apply(bwRecord("L-Sit Hold", 25, { rir: 3 }));
    expect(out.wrUpdates).toEqual({});
    expect(TS.get("p").lifts["L-Sit Hold"].currentRepRange).toMatchObject({ reps: 25, timed: true });
  });
});

// The loaded rep climb reaches the session the same way: a stall met short
// of failure raises the target, at most to base + 2, and hitting the top of
// it at RPE 9.5 banks one rung of weight. Misses and failure never climb.
describe("loaded rep climb reaches the session", () => {
  beforeEach(() => localStorage.clear());
  const SQUAT = "Barbell Back Squat";
  let n = 0;
  // Live-shaped: every set logs the target the session showed.
  const squat = (weight, reps, rir, readiness = "normal") => {
    n += 1;
    const counts = Array.isArray(reps) ? reps : [reps, reps, reps];
    const at = new Date(Date.UTC(2026, 9, n, 10)).toISOString();
    return {
      v: 2, id: at, date: at.slice(0, 10), readiness, session: "strength-a",
      blocks: [{ id: "a1", type: "main", exercises: [{
        name: SQUAT, muscle: "Quadriceps", loadType: "barbell",
        sets: counts.map((r) => ({ weight, reps: r, rir, loadType: "barbell", effectiveLoad: weight, est1rm: weight * (1 + r / 30) })),
      }] }],
    };
  };
  const seed = (extra = {}) => TS.save("p", { lifts: { [SQUAT]: {
    currentWeight: 162.5, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 0, consecutiveLightMisses: 0,
    stallSignal: null, history: [], currentRepRange: { reps: 5, sets: 3, baseReps: 5 }, ...extra,
  } } });
  const apply = (rec) => { H.append("p", rec); return applySessionToEngine("p", rec); };
  const lift = () => TS.get("p").lifts[SQUAT];

  it("three tight holds stall it; the next two climb 5 to 6 to 7; 7 at RPE 9.5 banks to 165 x 5", () => {
    seed();
    for (let i = 0; i < 3; i++) {
      const out = apply(squat(162.5, 5, 1));
      expect(out.wrUpdates).toEqual({});
      expect(out.wwUpdates[SQUAT]).toBe(162.5);
    }
    expect(lift().stallSignal).toBe("stall");
    expect(apply(squat(162.5, 5, 1)).wrUpdates[SQUAT]).toBe(6);
    expect(apply(squat(162.5, 6, 1)).wrUpdates[SQUAT]).toBe(7);
    expect(lift().currentRepRange).toMatchObject({ reps: 7, baseReps: 5 });
    const out = apply(squat(162.5, 7, 0.5));
    expect(out.wwUpdates[SQUAT]).toBe(165);
    expect(out.wrUpdates[SQUAT]).toBe(5);
    expect(lift().consecutiveHolds).toBe(0);
  });

  it("the next card's note: the climb with its numbers, then failure, then nothing", () => {
    seed({ consecutiveHolds: 3, stallSignal: "stall" });
    apply(squat(162.5, 5, 1));
    expect(lastSessionNote(lift())).toEqual({ kind: "rep_climb", reps: 6, base: 5, holds: 4, banks: false });
    expect(SESSION_COPY.repClimb(lastSessionNote(lift())))
      .toBe("6 reps, not 5. The weight has held for four sessions, so the reps climb to break the stall.");
    apply(squat(162.5, 6, 1));
    expect(SESSION_COPY.repClimb(lastSessionNote(lift())))
      .toBe("7 reps, not 5. The weight has held for five sessions, so the reps climb to break the stall. Hit 7 at 9.5 or lower and the weight goes up next time.");
    apply(squat(162.5, 7, 0.5));
    expect(lastSessionNote(lift())).toBe(null);
    apply(squat(165, 5, 0));
    expect(lastSessionNote(lift())).toEqual({ kind: "failure" });
    apply(squat(165, 5, 0.5));
    expect(lastSessionNote(lift())).toBe(null);
    expect(lift().nextPrescribed).toBe(167.5);
  });

  it("7 at RPE 10 holds 162.5 x 7", () => {
    seed({ consecutiveHolds: 5, stallSignal: "deep_stall", currentRepRange: { reps: 7, sets: 3, baseReps: 5 } });
    const out = apply(squat(162.5, 7, 0));
    expect(out.wwUpdates[SQUAT]).toBe(162.5);
    expect(out.wrUpdates).toEqual({});
    expect(lift().currentRepRange).toMatchObject({ reps: 7, baseReps: 5 });
  });

  it("a miss at a stall holds 5: 3 of 5 on the last set changes no target", () => {
    seed({ consecutiveHolds: 3, stallSignal: "stall" });
    const out = apply(squat(162.5, [5, 5, 3], 0));
    expect(out.wrUpdates).toEqual({});
    expect(lift().currentRepRange).toMatchObject({ reps: 5, baseReps: 5 });
  });

  it("a miss on a climbed target drops the weight and posts 5 again", () => {
    seed({ consecutiveHolds: 5, stallSignal: "deep_stall", currentRepRange: { reps: 7, sets: 3, baseReps: 5 } });
    const out = apply(squat(162.5, [7, 5, 5], 0));
    expect(out.wwUpdates[SQUAT]).toBeLessThan(162.5);
    expect(out.wrUpdates[SQUAT]).toBe(5);
    expect(lift().currentRepRange).toMatchObject({ reps: 5, baseReps: 5 });
    expect(lastSessionNote(lift())).toBe(null);
  });

  it("a cooked day after failure keeps the failure note and the add after it", () => {
    seed({ currentWeight: 165 });
    apply(squat(165, 5, 0));
    apply(squat(165, 5, 1, "cooked"));
    expect(lastSessionNote(lift())).toEqual({ kind: "failure" });
    apply(squat(165, 5, 0.5));
    expect(lift().nextPrescribed).toBe(167.5);
  });

  it("a cooked day mid-climb keeps the climbed target and its base", () => {
    seed({ consecutiveHolds: 3, stallSignal: "stall" });
    expect(apply(squat(162.5, 5, 1)).wrUpdates[SQUAT]).toBe(6);
    expect(apply(squat(162.5, 6, 2, "cooked")).wrUpdates).toEqual({});
    expect(lift().currentRepRange).toMatchObject({ reps: 6, baseReps: 5 });
    expect(lastSessionNote(lift())).toMatchObject({ kind: "rep_climb", reps: 6, base: 5 });
    expect(apply(squat(162.5, 6, 1)).wrUpdates[SQUAT]).toBe(7);
    expect(lift().currentRepRange).toMatchObject({ reps: 7, baseReps: 5 });
  });

  it("three grinders then a grinder holds 162.5 x 5 and builds the stall", () => {
    seed();
    for (let i = 0; i < 4; i++) {
      const out = apply(squat(162.5, 5, 0));
      expect(out.wrUpdates).toEqual({});
      expect(out.wwUpdates[SQUAT]).toBe(162.5);
    }
    expect(lift().consecutiveHolds).toBe(4);
    expect(lift().stallSignal).toBe("deep_stall");
  });
});

// A lift's first logged session replaces the cold-start guess: the next
// prescription progresses from what was lifted, never from the anchor
// (2026-10-13). The anchors are the ones that produced the live numbers.
describe("a lift's first logged session progresses from what was lifted", () => {
  beforeEach(() => localStorage.clear());
  const firstRecord = (name, loadType, weight, reps, rir) => {
    const sets = reps.map((r) => ({ weight, reps: r, rir, loadType, effectiveLoad: weight, est1rm: weight * (1 + r / 30) }));
    return {
      v: 2, id: "2026-10-11T10:00:00.000Z", date: "2026-10-11", readiness: "normal", session: "strength-c",
      blocks: [{ id: "css2", type: "superset", exercises: [{ name, loadType, sets }] }],
    };
  };
  const apply = (rec, muscleAnchors) => {
    TS.save("p", { ...TS.get("p"), muscleAnchors });
    H.append("p", rec);
    return applySessionToEngine("p", rec);
  };

  it("a 26 kg cable row: 26 or 27.5, never the anchor's 62.5", () => {
    const back = { Back: { bestE1RM: 152.4, bestE1RMLift: "Chest-Supported DB Row" } };
    for (const [rir, want] of [[1.5, 26], [2, 27.5]]) {
      localStorage.clear();
      const out = apply(firstRecord("Face-Away Cable Row", "cable", 26, [10, 10, 10, 10], rir), back);
      expect(out.wwUpdates["Face-Away Cable Row"], `rir ${rir}`).toBe(want);
      expect(out.wwUpdates["Face-Away Cable Row"]).not.toBe(62.5);
      const lift = TS.get("p").lifts["Face-Away Cable Row"];
      expect(lift.currentWeight).toBe(26);
      expect(lift.nextPrescribed).toBe(want);
      expect(lift.sessionsCount).toBe(1);
    }
  });

  it("a cooked first session holds 26 kg, never the anchor's 62.5", () => {
    const back = { Back: { bestE1RM: 152.4, bestE1RMLift: "Chest-Supported DB Row" } };
    const rec = { ...firstRecord("Face-Away Cable Row", "cable", 26, [10, 10, 10, 10], 1), readiness: "cooked" };
    const out = apply(rec, back);
    expect(out.wwUpdates["Face-Away Cable Row"]).toBe(26);
    const lift = TS.get("p").lifts["Face-Away Cable Row"];
    expect(lift.nextPrescribed).toBe(26);
    expect(lift.history.at(-1).decision).toBe("HOLD");
  });

  it("a second cooked session, still with no counted one, holds 26 kg, never the anchor's 62.5", () => {
    const back = { Back: { bestE1RM: 152.4, bestE1RMLift: "Chest-Supported DB Row" } };
    const cooked = (id) => ({ ...firstRecord("Face-Away Cable Row", "cable", 26, [10, 10, 10, 10], 1), id, date: id.slice(0, 10), readiness: "cooked" });
    expect(apply(cooked("2026-10-11T10:00:00.000Z"), back).wwUpdates["Face-Away Cable Row"]).toBe(26);
    expect(TS.get("p").lifts["Face-Away Cable Row"].currentRepRange).toMatchObject({ reps: 10, sets: 4 });
    const out = apply(cooked("2026-10-13T10:00:00.000Z"), back);
    expect(out.wwUpdates["Face-Away Cable Row"]).toBe(26);
    const lift = TS.get("p").lifts["Face-Away Cable Row"];
    expect(lift.history.at(-1).decision).toBe("HOLD");
    expect(lift.sessionsCount).toBe(2);
  });

  for (const kg of [20, 30]) {
    it(`a later cooked session, still with no counted one, takes its own top set: 26 then ${kg} holds ${kg}`, () => {
      const back = { Back: { bestE1RM: 152.4, bestE1RMLift: "Chest-Supported DB Row" } };
      const cooked = (id, weight) => ({ ...firstRecord("Face-Away Cable Row", "cable", weight, [10, 10, 10, 10], 1), id, date: id.slice(0, 10), readiness: "cooked" });
      expect(apply(cooked("2026-10-11T10:00:00.000Z", 26), back).wwUpdates["Face-Away Cable Row"]).toBe(26);
      expect(apply(cooked("2026-10-13T10:00:00.000Z", kg), back).wwUpdates["Face-Away Cable Row"]).toBe(kg);
    });
  }

  it("a 6 kg Lu raise adds a kilo, never the anchor's 16", () => {
    const shoulders = { Shoulders: { bestE1RM: 210, bestE1RMLift: "Overhead Press" } };
    const out = apply(firstRecord("DB Lu Raise", "per_db", 6, [10, 10, 10], 2), shoulders);
    expect(out.wwUpdates["DB Lu Raise"]).toBe(7);
    expect(out.wwUpdates["DB Lu Raise"]).not.toBe(16);
  });

  it("a 16 kg split squat at RPE 9.5 holds 16, never the anchor's 43", () => {
    const quads = { Quadriceps: { bestE1RM: 228.9, bestE1RMLift: "Leg Press" } };
    const out = apply(firstRecord("DB Split Squat", "per_db", 16, [10, 10, 10], 0.5), quads);
    expect(out.wwUpdates["DB Split Squat"]).toBe(16);
    expect(out.wwUpdates["DB Split Squat"]).not.toBe(43);
    expect(TS.get("p").lifts["DB Split Squat"].history.at(-1).decision).toBe("HOLD");
  });

  it("an unrated first session holds the performed weight", () => {
    const calves = { Calves: { bestE1RM: 100, bestE1RMLift: "Standing Calf Raise" } };
    const out = apply(firstRecord("Seated Calf Raise", "machine", 40, [15, 15, 15, 15], null), calves);
    expect(out.wwUpdates["Seated Calf Raise"]).toBe(40);
    expect(TS.get("p").lifts["Seated Calf Raise"].history.at(-1).decision).toBe("HOLD");
  });

  // A belted Pull-Up stores the added kg; effectiveLoad carries bodyweight.
  const back = { Back: { bestE1RM: 152.4, bestE1RMLift: "Chest-Supported DB Row" } };
  const pullUp = (weight, rir) => {
    const rec = firstRecord("Pull-Up", "loaded_bodyweight", weight, [8, 8, 8], rir);
    for (const set of rec.blocks[0].exercises[0].sets) set.effectiveLoad = 80 + weight;
    return rec;
  };

  it("a first belted pull-up progresses from the 10 kg added, never the anchor", () => {
    const out = apply(pullUp(10, 3), back);
    const w = out.wwUpdates["Pull-Up"];
    // 10 kg plus one 1.25 kg rung at RIR 3.
    expect(w).toBe(11.25);
    expect(w).not.toBe(coldStartFromAnchor("Pull-Up", back.Back));
    const lift = TS.get("p").lifts["Pull-Up"];
    expect(lift.currentWeight).toBe(10);
    expect(lift.history.at(-1).decision).not.toBe("COLD_START");
  });

  it("a first unloaded pull-up keeps the bodyweight cold start", () => {
    const out = apply(pullUp(0, 3), back);
    expect(out.wwUpdates["Pull-Up"]).toBe(0);
    expect(out.wrUpdates).toEqual({});
    expect(TS.get("p").lifts["Pull-Up"].history.at(-1).decision).toBe("COLD_START");
  });

  // Assistance kg is help, not load to add to: an assisted first session is
  // not seeded, so it keeps the cold start and holds the assistance it used.
  const assisted = (name, weight, reps, rir, id = "2026-10-11T10:00:00.000Z") => {
    const rec = { ...firstRecord(name, "assisted_bodyweight", weight, reps, rir), id, date: id.slice(0, 10) };
    for (const set of rec.blocks[0].exercises[0].sets) {
      set.bodyweightUsed = 80;
      set.effectiveLoad = 80 - weight;
      set.est1rm = (80 - weight) * (1 + set.reps / 30);
    }
    return rec;
  };

  it("a first assisted pull-up keeps the cold start and holds 20 kg", () => {
    for (const name of ["Assisted Pull-Up", "Pull-Up"]) {
      localStorage.clear();
      const out = apply(assisted(name, 20, [8, 8, 8], 3), back);
      expect(out.wwUpdates[name], name).toBe(20);
      const lift = TS.get("p").lifts[name];
      expect(lift.history.at(-1).decision, name).toBe("COLD_START");
      expect(lift.currentWeight, name).toBe(20);
      // Factor 0: Assisted Pull-Up never writes the Back anchor from band kg.
      if (name === "Assisted Pull-Up") expect(TS.get("p").muscleAnchors.Back).toEqual(back.Back);
    }
  });

  it("the second assisted session takes a rung of help off: 20 to 18.75", () => {
    apply(assisted("Assisted Pull-Up", 20, [8, 8, 8], 3), back);
    const out = apply(assisted("Assisted Pull-Up", 20, [8, 8, 8], 3, "2026-10-13T10:00:00.000Z"), back);
    expect(out.wwUpdates["Assisted Pull-Up"]).toBe(18.75);
    expect(TS.get("p").lifts["Assisted Pull-Up"].currentWeight).toBe(20);
    expect(TS.get("p").muscleAnchors.Back).toEqual(back.Back);
  });

  it("a deload session on an assisted lift leaves the 20 kg: the load type reaches the deload", () => {
    TS.save("p", {
      ...TS.get("p"),
      lifts: { "Assisted Pull-Up": { currentWeight: 20, currentRepRange: { reps: 8, sets: 3, baseReps: 8 }, sessionsCount: 4, consecutiveHolds: 0, consecutiveAdds: 0, history: [] } },
      mesocycle: { ...TS.get("p").mesocycle, currentPhase: "deload", activeDeload: { startedAt: "2026-10-12T12:00:00.000Z", plannedDays: 7, preDeloadWeights: { "Assisted Pull-Up": 20 } } },
    });
    H.append("p", assisted("Assisted Pull-Up", 20, [4, 4], 4, "2026-10-13T10:00:00.000Z"));
    const out = applySessionToEngine("p", assisted("Assisted Pull-Up", 20, [4, 4], 4, "2026-10-13T10:00:00.000Z"));
    expect(out.stillInDeload).toBe(true);
    // Without the load type the upper_pull multiplier would cut help to 12.5.
    expect(out.wwUpdates["Assisted Pull-Up"]).toBe(20);
    expect(TS.get("p").lifts["Assisted Pull-Up"].history.at(-1).decision).toBe("DELOAD");
  });

  // A record with no load type at all reads the catalogue's (assisted), not
  // the name's (belted), so the help still moves the right way.
  const unlabelled = (rec) => {
    const ex = rec.blocks[0].exercises[0];
    delete ex.loadType;
    for (const set of ex.sets) delete set.loadType;
    return rec;
  };

  it("an unlabelled first assisted session holds 20 kg, not a belted 21.25", () => {
    const out = apply(unlabelled(assisted("Assisted Pull-Up", 20, [8, 8, 8], 3)), back);
    expect(out.wwUpdates["Assisted Pull-Up"]).toBe(20);
    expect(TS.get("p").lifts["Assisted Pull-Up"].history.at(-1).decision).toBe("COLD_START");
  });

  it("an unlabelled deload session on an assisted lift still leaves the 20 kg", () => {
    TS.save("p", {
      ...TS.get("p"),
      lifts: { "Assisted Pull-Up": { currentWeight: 20, currentRepRange: { reps: 8, sets: 3, baseReps: 8 }, sessionsCount: 4, consecutiveHolds: 0, consecutiveAdds: 0, history: [] } },
      mesocycle: { ...TS.get("p").mesocycle, currentPhase: "deload", activeDeload: { startedAt: "2026-10-12T12:00:00.000Z", plannedDays: 7, preDeloadWeights: { "Assisted Pull-Up": 20 } } },
    });
    const rec = unlabelled(assisted("Assisted Pull-Up", 20, [4, 4], 4, "2026-10-13T10:00:00.000Z"));
    H.append("p", rec);
    const out = applySessionToEngine("p", rec);
    expect(out.stillInDeload).toBe(true);
    expect(out.wwUpdates["Assisted Pull-Up"]).toBe(20);
  });

  it("an unlabelled assisted session on a known lift takes a rung of help off: 20 to 18.75", () => {
    TS.save("p", {
      ...TS.get("p"),
      lifts: { "Assisted Pull-Up": { currentWeight: 20, currentRepRange: { reps: 8, sets: 3, baseReps: 8 }, sessionsCount: 4, consecutiveHolds: 0, consecutiveAdds: 0, history: [] } },
    });
    const rec = unlabelled(assisted("Assisted Pull-Up", 20, [8, 8, 8], 3, "2026-10-13T10:00:00.000Z"));
    H.append("p", rec);
    const out = applySessionToEngine("p", rec);
    expect(out.wwUpdates["Assisted Pull-Up"]).toBe(18.75);
  });

  it("an assisted session does not re-save the Back anchor it leaves alone", () => {
    const spy = vi.spyOn(TS, "updateMuscleAnchor");
    try {
      apply(assisted("Assisted Pull-Up", 20, [8, 8, 8], 3), back);
      apply(assisted("Assisted Pull-Up", 20, [8, 8, 8], 3, "2026-10-13T10:00:00.000Z"), back);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a cooked first belted pull-up holds 10 kg", () => {
    const out = apply({ ...pullUp(10, 1), readiness: "cooked" }, back);
    expect(out.wwUpdates["Pull-Up"]).toBe(10);
    expect(TS.get("p").lifts["Pull-Up"].history.at(-1).decision).toBe("HOLD");
  });

  // As their first sessions do, a lift moving by reps or by assistance keeps
  // the cold start while its sessions are all cooked: no lifted load to hold.
  it("a pure bodyweight lift whose sessions are all cooked never gets a W, vest or not", () => {
    const cooked = (weight, id) => ({ ...firstRecord("Push-Up", "bodyweight", weight, [12, 12, 12], 1), id, date: id.slice(0, 10), readiness: "cooked" });
    expect(apply(cooked(null, "2026-10-11T10:00:00.000Z"), back).wwUpdates).not.toHaveProperty("Push-Up");
    expect(apply(cooked(10, "2026-10-13T10:00:00.000Z"), back).wwUpdates).not.toHaveProperty("Push-Up");
  });

  it("an assisted lift whose sessions are all cooked keeps the cold start", () => {
    apply({ ...assisted("Assisted Pull-Up", 20, [8, 8, 8], 1), readiness: "cooked" }, back);
    const out = apply({ ...assisted("Assisted Pull-Up", 15, [8, 8, 8], 1, "2026-10-13T10:00:00.000Z"), readiness: "cooked" }, back);
    expect(out.wwUpdates["Assisted Pull-Up"]).toBe(15);
    expect(TS.get("p").lifts["Assisted Pull-Up"].history.at(-1).decision).toBe("COLD_START");
  });
});

// A cooked session never moves an earned working weight: the next W is the
// one in force that day, whatever the session lifted.
describe("a cooked session never moves an earned weight", () => {
  beforeEach(() => localStorage.clear());
  const SQUAT = "Barbell Back Squat";
  const set = (weight, reps, rir) => ({ weight, reps, rir, loadType: "barbell", effectiveLoad: weight, est1rm: weight * (1 + reps / 30) });
  const atKg = (weight, rir) => [0, 1, 2].map(() => set(weight, 5, rir));
  // As the session records it: prescribed is W, whatever the drum was set to.
  const squat = (id, sets, prescribedKg, readiness = "normal") => ({
    v: 2, id, date: id.slice(0, 10), readiness, session: "strength-a",
    blocks: [{ id: "a1", type: "main", exercises: [{
      name: SQUAT, muscle: "Quadriceps", loadType: "barbell",
      prescribed: { sets: 3, reps: 5, weight: prescribedKg },
      sets,
    }] }],
  });
  const apply = (rec) => { H.append("p", rec); return applySessionToEngine("p", rec); };
  const earnAdd = () => {
    TS.save("p", { lifts: { [SQUAT]: {
      currentWeight: 100, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 0, consecutiveLightMisses: 0,
      stallSignal: null, history: [], currentRepRange: { reps: 5, sets: 3, baseReps: 5 },
    } } });
    return apply(squat("2026-10-20T10:00:00.000Z", atKg(100, 3), 100));
  };
  const cookedAfterAdd = (sets) => apply(squat("2026-10-27T10:00:00.000Z", sets, 102.5, "cooked"));

  it("an add earned before a cooked session survives it", () => {
    expect(earnAdd().wwUpdates[SQUAT]).toBe(102.5);
    expect(cookedAfterAdd(atKg(102.5, 2)).wwUpdates[SQUAT]).toBe(102.5);
    expect(TS.get("p").lifts[SQUAT].history.at(-1).decision).toBe("HOLD");
  });

  it("a cooked session dialled down leaves W", () => {
    expect(earnAdd().wwUpdates[SQUAT]).toBe(102.5);
    expect(cookedAfterAdd(atKg(97.5, 2)).wwUpdates[SQUAT]).toBe(102.5);
  });

  it("a failed heavier single on a cooked day leaves W", () => {
    expect(earnAdd().wwUpdates[SQUAT]).toBe(102.5);
    expect(cookedAfterAdd([set(107.5, 1, 0), set(95, 5, 2), set(95, 5, 2)]).wwUpdates[SQUAT]).toBe(102.5);
  });

  it("an assisted cooked session with more help leaves the help in force", () => {
    const LIFT = "Assisted Pull-Up";
    const help = (kg, reps, rir) => ({ weight: kg, reps, rir, loadType: "assisted_bodyweight", bodyweightUsed: 80, effectiveLoad: 80 - kg, est1rm: (80 - kg) * (1 + reps / 30) });
    const pullUp = (id, sets, prescribedKg, readiness = "normal") => ({
      v: 2, id, date: id.slice(0, 10), readiness, session: "strength-b",
      blocks: [{ id: "b1", type: "main", exercises: [{ name: LIFT, loadType: "assisted_bodyweight", prescribed: { sets: 3, reps: 6, weight: prescribedKg }, sets }] }],
    });
    TS.save("p", { lifts: { [LIFT]: {
      currentWeight: 20, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 0, consecutiveLightMisses: 0,
      stallSignal: null, history: [], currentRepRange: { reps: 6, sets: 3, baseReps: 6 },
    } } });
    expect(apply(pullUp("2026-10-20T10:00:00.000Z", [help(20, 6, 3), help(20, 6, 3), help(20, 6, 3)], 20)).wwUpdates[LIFT]).toBe(18.75);
    const cooked = pullUp("2026-10-27T10:00:00.000Z", [help(25, 6, 2), help(25, 6, 2), help(25, 6, 2)], 18.75, "cooked");
    expect(apply(cooked).wwUpdates[LIFT]).toBe(18.75);
  });

  // A Pull-Up logs the added kg on every set; effectiveLoad carries bodyweight.
  const PULL_UP = "Pull-Up";
  const belt = (kg, rir) => ({ weight: kg, reps: 8, rir, loadType: "loaded_bodyweight", bodyweightUsed: 80, effectiveLoad: 80 + kg, est1rm: (80 + kg) * (1 + 8 / 30) });
  const pullUp = (id, kg, rir, prescribedKg, readiness = "normal") => ({
    v: 2, id, date: id.slice(0, 10), readiness, session: "strength-b",
    blocks: [{ id: "bss1", type: "superset", exercises: [{ name: PULL_UP, loadType: "loaded_bodyweight", prescribed: { sets: 3, reps: 8, weight: prescribedKg }, sets: [0, 1, 2].map(() => belt(kg, rir)) }] }],
  });
  const seedPullUp = (currentWeight) => TS.save("p", { lifts: { [PULL_UP]: {
    currentWeight, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 0, consecutiveLightMisses: 0,
    stallSignal: null, history: [], currentRepRange: { reps: 8, sets: 3, baseReps: 8 },
  } } });

  it("a belted Pull-Up keeps its added kg through an unbelted cooked day", () => {
    seedPullUp(10);
    expect(apply(pullUp("2026-10-20T10:00:00.000Z", 10, 3, 10)).wwUpdates[PULL_UP]).toBe(11.25);
    expect(apply(pullUp("2026-10-27T10:00:00.000Z", 0, 2, 11.25, "cooked")).wwUpdates[PULL_UP]).toBe(11.25);
  });

  // An unbelted counted session prescribes 0 kg; 5 kg was set outside the
  // engine since, so the cooked record carries 5 as its prescription.
  it("a W set after an unbelted counted session survives a cooked day, belted or not", () => {
    for (const kg of [5, 0]) {
      localStorage.clear();
      seedPullUp(0);
      expect(apply(pullUp("2026-10-20T10:00:00.000Z", 0, 2, 0)).wwUpdates[PULL_UP]).toBe(0);
      expect(apply(pullUp("2026-10-27T10:00:00.000Z", kg, 2, 5, "cooked")).wwUpdates[PULL_UP], `${kg} kg`).toBe(5);
    }
  });

  it("a backfilled counted record older than the lift's newest session still writes W", () => {
    expect(earnAdd().wwUpdates[SQUAT]).toBe(102.5);
    expect(apply(squat("2026-10-13T10:00:00.000Z", atKg(95, 2), 100)).wwUpdates[SQUAT]).toBe(102.5);
  });

  it("a backfilled cooked record older than the lift's newest session writes no W", () => {
    expect(earnAdd().wwUpdates[SQUAT]).toBe(102.5);
    const before = TS.get("p").lifts[SQUAT];
    // Backfilled after the add, so it records today's W.
    const out = apply(squat("2026-10-13T10:00:00.000Z", atKg(95, 2), 102.5, "cooked"));
    expect(out.wwUpdates).not.toHaveProperty(SQUAT);
    expect(TS.get("p").lifts[SQUAT]).toEqual(before);
  });
});

// A cooked day holds the rep target on the rep paths too: nothing written to
// the target, no add counted, the climb as it stands. The next counted session
// carries on as if the cooked day had not happened.
describe("a cooked day holds the rep target on the rep paths", () => {
  beforeEach(() => localStorage.clear());
  const apply = (p, rec) => { H.append(p, rec); return applySessionToEngine(p, rec); };
  const kept = (s) => ({
    consecutiveAdds: s.consecutiveAdds, consecutiveHolds: s.consecutiveHolds, stallSignal: s.stallSignal,
    currentRepRange: s.currentRepRange, nextPrescribed: s.nextPrescribed,
  });
  const lifts = [
    ["Push-Up", { weight: null, loadType: "bodyweight" }],
    // A belted lift with no belt on: its unloaded branch.
    ["Pull-Up", { weight: 0, loadType: "loaded_bodyweight", bodyweightUsed: 80, effectiveLoad: 80 }],
  ];
  for (const [name, load] of lifts) {
    // Live-shaped: every set logs the target the session showed.
    const rec = (day, reps, readiness = "normal") => ({
      v: 2, id: `2026-10-${day}T10:00:00.000Z`, date: `2026-10-${day}`, readiness, session: "strength-b",
      blocks: [{ id: "bss1", type: "superset", exercises: [{ name, loadType: load.loadType, sets: [0, 1, 2].map(() => ({ ...load, reps, rir: 3 })) }] }],
    });
    // Inside an unloaded climb from 9.
    const seed = (p) => TS.save(p, { lifts: { [name]: {
      currentWeight: load.weight, sessionsCount: 5, consecutiveAdds: 1, consecutiveHolds: 0, consecutiveLightMisses: 0,
      stallSignal: null, history: [], currentRepRange: { reps: 10, sets: 3, baseReps: 9, bwClimb: true },
    } } });
    const lift = (p) => TS.get(p).lifts[name];

    it(`${name}: a cooked day writes no target and moves no counter`, () => {
      seed("p");
      expect(apply("p", rec(20, 10)).wrUpdates[name]).toBe(11);
      const before = kept(lift("p"));
      expect(apply("p", rec(23, 11, "cooked")).wrUpdates).not.toHaveProperty(name);
      expect(kept(lift("p"))).toEqual(before);
      expect(lift("p").history.at(-1).decision).toBe("HOLD");
    });

    it(`${name}: the next counted session carries on as if the cooked day had not happened`, () => {
      for (const p of ["a", "b"]) {
        seed(p);
        apply(p, rec(20, 10));
      }
      apply("b", rec(23, 11, "cooked"));
      const a = apply("a", rec(27, 11));
      expect(a.wrUpdates[name]).toBe(12);
      expect(apply("b", rec(27, 11))).toEqual(a);
      expect(kept(lift("b"))).toEqual(kept(lift("a")));
    });
  }
});
