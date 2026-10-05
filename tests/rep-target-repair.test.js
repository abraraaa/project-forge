// @vitest-environment jsdom
// A rep target left below its lift's base by the pre-contract engine (a short
// set's reps written into the target) reads as the base on the next plan, and
// that session's finalise stores it. Adoptions, rep climbs, timed holds, pure
// bodyweight climbs and session swaps keep their own target.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { repairRepTarget, repTargetRepairs, computeNextPrescription } from "../lib/progression.js";
import { applySessionToEngine } from "../lib/session-engine.js";
import { runTool } from "../lib/mcp-server.js";
import { SESSIONS } from "../lib/programme.js";
import { H, TS, P } from "../lib/storage.js";

const BENCH = "Barbell Bench Press";
const OHP = "Barbell Overhead Press";
const STRENGTH_A = SESSIONS[0];
const STRENGTH_B = SESSIONS[1];

const liftState = (range, extra = {}) => ({
  currentWeight: 95, sessionsCount: 9, consecutiveAdds: 0, consecutiveHolds: 0,
  consecutiveLightMisses: 0, stallSignal: null, history: [], currentRepRange: range, ...extra,
});
const BASE5 = { reps: 5, sets: 3, baseReps: 5 };

// The owner's bench, 21 Sep: 95 kg × 3/3/3 on a cooked day against a target of 5.
const benchRecord = (id, date, reps, { readiness = "cooked", prescribed = 5 } = {}) => ({
  id, date, dow: 0, type: "strength", session: "strength-a", readiness,
  blocks: [{ id: "a2", type: "main", exercises: [{
    name: BENCH, muscle: "Chest", loadType: "barbell",
    prescribed: { reps: prescribed, weight: 95, sets: 3 },
    sets: [1, 2, 3].map(() => ({ weight: 95, effectiveLoad: 95, reps, rir: 0, est1rm: 95 * (1 + reps / 30) })),
  }] }],
  duration: 3000,
});

describe("repairRepTarget", () => {
  it("the owner's bench: target 3 under a base of 5 is restored to 5", () => {
    expect(repairRepTarget({ target: 3, liftState: liftState(BASE5), templateReps: 5 }))
      .toEqual({ reps: 5, repaired: true, reason: "below_base" });
  });

  it("the owner's overhead press: target 4 (5/5/4 on 31 Aug) is restored to 5", () => {
    expect(repairRepTarget({ target: 4, liftState: liftState(BASE5), templateReps: 5 }).reps).toBe(5);
  });

  it("an adopted target (reps === baseReps === 4 after three sessions) is left alone", () => {
    // The range alone says so: an adoption writes reps and baseReps equal.
    const range = liftState({ reps: 4, sets: 3, baseReps: 4 });
    expect(repairRepTarget({ target: 4, liftState: range, templateReps: 5 }))
      .toEqual({ reps: 4, repaired: false, reason: null });
    const adopted = liftState({ reps: 4, sets: 3, baseReps: 4 }, { adoptedReps: 4, adoptedAt: "2026-09-30" });
    expect(repairRepTarget({ target: 4, liftState: adopted, templateReps: 5 }))
      .toEqual({ reps: 4, repaired: false, reason: "adopted" });
    // The adopted count is honoured even where the range still says 5.
    expect(repairRepTarget({ target: 4, liftState: liftState(BASE5, { adoptedReps: 4 }), templateReps: 5 }).repaired).toBe(false);
  });

  it("a rep-climbed target (6 over base 5) is never lowered", () => {
    const climbed = liftState({ reps: 6, sets: 3, baseReps: 5 });
    expect(repairRepTarget({ target: 6, liftState: climbed, templateReps: 5 }))
      .toEqual({ reps: 6, repaired: false, reason: null });
  });

  it("a timed hold is untouched, however it is stored", () => {
    expect(repairRepTarget({ target: 20, liftState: liftState({ reps: 30, sets: 3, baseReps: 30, timed: true }), templateReps: "45s" }).repaired).toBe(false);
    expect(repairRepTarget({ target: 20, liftState: null, templateReps: "45s" }).reason).toBe("timed");
    expect(repairRepTarget({ target: "20s", liftState: null, templateReps: 30 }).reason).toBe("timed");
  });

  it("a pure bodyweight lift and a bodyweight rep climb are untouched", () => {
    const bwClimb = liftState({ reps: 8, sets: 4, baseReps: 10, bwClimb: true });
    expect(repairRepTarget({ target: 8, liftState: bwClimb, templateReps: 10, loadType: "loaded_bodyweight" }).reason).toBe("bodyweight_climb");
    expect(repairRepTarget({ target: 6, liftState: null, templateReps: 10, loadType: "bodyweight" }).reason).toBe("bodyweight");
  });

  it("with no lift state or no range, the slot's template is the base; per-leg keeps its shape", () => {
    expect(repairRepTarget({ target: 3, liftState: null, templateReps: 5 }).reps).toBe(5);
    expect(repairRepTarget({ target: 7, liftState: liftState(null), templateReps: 10 }).reps).toBe(10);
    expect(repairRepTarget({ target: "6/leg", liftState: null, templateReps: "8/leg" }).reps).toBe("8/leg");
    expect(repairRepTarget({ target: 3, liftState: null, templateReps: null }).reason).toBe("no_base");
  });
});

describe("repTargetRepairs over the composed programme", () => {
  it("names the owner's bench (Strength A) and press (Strength B), nothing else", () => {
    const reps = { [BENCH]: 3, [OHP]: 4, "Barbell Back Squat": 5, "Chest-Supported DB Row": 10 };
    const lifts = { [BENCH]: liftState(BASE5), [OHP]: liftState(BASE5), "Barbell Back Squat": liftState(BASE5) };
    expect(repTargetRepairs({ reps, lifts, sessions: [STRENGTH_A, STRENGTH_B] })).toEqual({ [BENCH]: 5, [OHP]: 5 });
  });

  it("a lift placed by a session swap keeps the target it carries", () => {
    // Session swap put Incline DB Press in a slot; its stored 8 sits under a
    // base of 10 but is the user's choice for this session.
    const swapped = { ...STRENGTH_A, blocks: STRENGTH_A.blocks.map((b) => b.id === "ass2"
      ? { ...b, exB: { name: "Incline DB Press", reps: 8, weight: 26, loadType: "per_db" } } : b) };
    const reps = { "Incline DB Press": 8 };
    const lifts = { "Incline DB Press": liftState({ reps: 10, sets: 3, baseReps: 10 }) };
    expect(repTargetRepairs({ reps, lifts, sessions: [swapped], exclude: ["Incline DB Press"] })).toEqual({});
    // Without the swap marker the same stored target would be repaired.
    expect(repTargetRepairs({ reps, lifts, sessions: [swapped] })).toEqual({ "Incline DB Press": 10 });
  });

  it("an adopted target in the programme stays as adopted", () => {
    const reps = { [BENCH]: 4 };
    const lifts = { [BENCH]: liftState({ reps: 4, sets: 3, baseReps: 4 }, { adoptedReps: 4 }) };
    expect(repTargetRepairs({ reps, lifts, sessions: [STRENGTH_A] })).toEqual({});
  });
});

describe("the repaired target persists through finalise, once", () => {
  beforeEach(() => localStorage.clear());

  it("bench: cooked 3/3/3 left target 3; next plan shows 5, finalise stores 5, the plan after needs no repair", () => {
    const who = "owner";
    // Stored state as the pre-contract engine left it.
    H.append(who, benchRecord("2026-09-21T10:00:00.000Z", "2026-09-21", 3));
    TS.updateLift(who, BENCH, liftState(BASE5));
    P.saveReps(who, { [BENCH]: 3 });

    // The cooked miss changes nothing about the target the engine holds.
    const held = computeNextPrescription({ liftName: BENCH, history: H.get(who), liftState: TS.get(who).lifts[BENCH], context: { loadType: "barbell" } });
    expect(held.repRangeChanged).toBe(false);

    // Next plan.
    const plan1 = repTargetRepairs({ reps: P.getReps(who), lifts: TS.get(who).lifts, sessions: [STRENGTH_A] });
    expect(plan1).toEqual({ [BENCH]: 5 });

    // The session runs against 5 and finalises.
    const rec = benchRecord("2026-10-06T10:00:00.000Z", "2026-10-06", 5, { readiness: "normal" });
    rec.blocks[0].exercises[0].sets.forEach((s) => { s.rir = 2; });
    H.append(who, rec);
    const out = applySessionToEngine(who, rec, { repairedReps: plan1 });
    expect(out.wrUpdates).toEqual({ [BENCH]: 5 });
    // The finalise is what writes R (SessionHost's setWR → P.saveReps).
    P.saveReps(who, { ...P.getReps(who), ...out.wrUpdates });
    expect(P.getReps(who)[BENCH]).toBe(5);
    expect(TS.get(who).lifts[BENCH].currentRepRange.baseReps).toBe(5);

    // Next plan: nothing to repair, and the next finalise writes no target.
    const plan2 = repTargetRepairs({ reps: P.getReps(who), lifts: TS.get(who).lifts, sessions: [STRENGTH_A] });
    expect(plan2).toEqual({});
    const rec2 = benchRecord("2026-10-08T10:00:00.000Z", "2026-10-08", 5, { readiness: "normal" });
    rec2.blocks[0].exercises[0].sets.forEach((s) => { s.rir = 2; });
    H.append(who, rec2);
    expect(applySessionToEngine(who, rec2, { repairedReps: plan2 }).wrUpdates).toEqual({});
  });

  it("a rep climb in the same session writes over the repair", () => {
    const who = "climber";
    TS.updateLift(who, BENCH, liftState(BASE5, { consecutiveHolds: 3, stallSignal: "stall", currentWeight: 95 }));
    const rec = benchRecord("2026-10-06T10:00:00.000Z", "2026-10-06", 5, { readiness: "normal" });
    rec.blocks[0].exercises[0].sets.forEach((s) => { s.rir = 1; });
    H.append(who, rec);
    const out = applySessionToEngine(who, rec, { repairedReps: { [BENCH]: 5 } });
    expect(out.wrUpdates[BENCH]).toBe(6);
  });

  it("a lift not logged in the session is not written", () => {
    const who = "skipper";
    const rec = benchRecord("2026-10-06T10:00:00.000Z", "2026-10-06", 5, { readiness: "normal" });
    H.append(who, rec);
    expect(applySessionToEngine(who, rec, { repairedReps: { [OHP]: 5 } }).wrUpdates[OHP]).toBeUndefined();
  });
});

describe("current_loads and programme show the repaired target", () => {
  const meta = {
    weights: { [BENCH]: 95, [OHP]: 60, "Barbell Back Squat": 112.5 },
    reps: { [BENCH]: 3, [OHP]: 4, "Barbell Back Squat": 5 },
    trainingState: { lifts: { [BENCH]: liftState(BASE5), [OHP]: liftState(BASE5, { currentWeight: 60 }) } },
  };
  const now = new Date("2026-10-05T12:00:00Z");

  it("current_loads", () => {
    const lines = runTool("current_loads", {}, { meta, history: [] }, now).text.split("\n");
    expect(lines).toContain(`- ${BENCH}: 95 kg × 5`);
    expect(lines).toContain(`- ${OHP}: 60 kg × 5`);
    expect(lines).toContain("- Barbell Back Squat: 112.5 kg × 5");
  });

  it("programme", () => {
    const text = runTool("programme", {}, { meta, history: [] }, now).text;
    expect(text).toContain(`${BENCH} 3 × 5 @ 95 kg`);
    expect(text).toContain(`${OHP} 3 × 5 @ 60 kg`);
  });

  it("an adopted target reads as adopted", () => {
    const m = { ...meta, reps: { [BENCH]: 4 }, trainingState: { lifts: { [BENCH]: liftState({ reps: 4, sets: 3, baseReps: 4 }, { adoptedReps: 4 }) } } };
    expect(runTool("current_loads", {}, { meta: m, history: [] }, now).text).toContain(`- ${BENCH}: 95 kg × 4`);
  });

  it("without synced lift state, the template base still repairs a relic, as the app does on that device", () => {
    const { trainingState: _ts, ...m } = meta;
    expect(runTool("current_loads", {}, { meta: m, history: [] }, now).text).toContain(`- ${BENCH}: 95 kg × 5`);
  });
});

describe("wiring", () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components/SessionHost.jsx"), "utf8");
  it("the live host plans from the repaired targets and hands them to finalise", () => {
    expect(src).toContain("repTargetRepairs({");
    expect(src).toContain("repairedReps: repRepairs");
    expect(src).toContain("exclude: Object.values(sessionSwaps).map((s) => s?.name)");
    expect(src).toContain("prescribed: { reps: prescribedReps[ex.name] ?? ex.reps");
  });
});

describe("the retro path repairs too", () => {
  it("ForgeApp hands the retro sheet repaired targets and tells the engine which it repaired", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components/ForgeApp.jsx"), "utf8");
    expect(src).toMatch(/const retroRepairs = useMemo\(\(\) => repTargetRepairs\(\{ reps: workingReps, lifts: TS\.get\(activeProfile\)\?\.lifts \?\? \{\}, sessions: SESSIONS \}\)/);
    expect(src).toContain("workingReps={retroReps}");
    expect(src).toContain("applySessionToEngine(activeProfile, sessionRecord, { currentWeights: workingWeights, repairedReps: retroRepairs })");
  });
});
