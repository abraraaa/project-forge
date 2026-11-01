// @vitest-environment jsdom
// Muscle anchors come from reference lifts, derived from history on read
// (deriveMuscleAnchors, lib/lift-translations.js). The guard holds the
// declared list to the lift profiles; the pins hold the derivation: which
// records and sets count, the factor, the loaded-bodyweight fallback, the
// pre-v2 record the server reads unmigrated, the memo and the frozen shape.
// The readers' pins hold every plan surface to the derived anchor: the stored
// field is inert, a trainer's device derives nothing, the owner's cold starts
// come from the five sets that anchor them, and every reader agrees.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  REFERENCE_LIFTS, deriveMuscleAnchors, coldStartFromAnchor, startWeightFor, getLiftProfile, isBodyweightMovement, __test__,
} from "../lib/lift-translations.js";
import { hasCatalogueName, loadTypeOfName, planStartWeight, resolvedProgramme } from "../lib/programme-resolve.js";
import { migrateV1ToV2, migrateV2ToV3, H, TS, getLocalProfile } from "../lib/storage.js";
import { localSource, coachedSource } from "../lib/session-source.js";
import { applySessionToEngine } from "../lib/session-engine.js";
import { commitSessionRecord } from "../lib/session-commit.js";
import { runTool } from "../lib/mcp-server.js";
import { projectForTrainer } from "../lib/trainer-plan.js";
import { EXERCISE_POOLS } from "../lib/programme.js";

const { PROFILES, REFERENCE_MUSCLE_OF, referenceMuscleOf, BODY_INCLUSIVE_REFERENCE_LIFTS } = __test__;
const DECLARED = Object.values(REFERENCE_LIFTS).flat();
// Muscles with a lift that progresses by load at a factor above zero, but no
// reference lift: their lifts never read an anchor.
const NO_REFERENCE = ["Core", "Triceps"];

const round1 = (x) => Math.round(x * 10) / 10;
const epley = (w, r) => (r === 1 ? w : round1(w * (1 + r / 30)));

/** A record as finaliseDraft writes it, its exercises in one block. */
const rec = (date, exercises, extra = {}) => ({
  id: `${date}T10:00:00.000Z`, date, schemaVersion: 3, session: "strength-a", readiness: "normal",
  blocks: [{ id: "b1", type: "main", exercises }],
  ...extra,
});
/** An external-load lift: each [weight, reps, est1rm?] set as logSet caches it. */
const lift = (name, loadType, sets) => ({
  name, loadType,
  sets: sets.map(([weight, reps, est1rm = epley(weight, reps)]) => ({
    weight, reps, rir: 2, rpe: 8, loadType, bodyweightUsed: 80, effectiveLoad: weight, est1rm,
  })),
});
/** A pull-up family set: the e1RM sits on the body plus the belt. */
const pullUp = (set, name = "Pull-Up", exLoadType = "loaded_bodyweight") => ({
  name, loadType: exLoadType, sets: [{ rir: 2, rpe: 8, loadType: "loaded_bodyweight", ...set }],
});

const ohp = (w, r) => lift("Barbell Overhead Press", "barbell", [[w, r]]);
const rearDelt = lift("Rear Delt Fly", "per_db", [[16, 15]]);
const pulldown = lift("Lat Pulldown", "total", [[65, 10]]);
const bwPullUp = pullUp({ weight: null, reps: 9, bodyweightUsed: 79.8, effectiveLoad: 79.8, est1rm: 103.7 });

describe("the guard: the declared reference lifts against the lift profiles", () => {
  it("maps every declared name, so none was dropped at load", () => {
    expect(DECLARED.length).toBe(26);
    expect(REFERENCE_MUSCLE_OF.size).toBe(DECLARED.length);
  });

  it("each member is its own profile on its muscle, progressing by load at a factor above zero", () => {
    for (const [muscle, names] of Object.entries(REFERENCE_LIFTS)) {
      for (const name of names) {
        expect(Object.hasOwn(PROFILES, name), name).toBe(true);
        expect(PROFILES[name].primaryMuscle, name).toBe(muscle);
        expect(PROFILES[name].progressesByLoad, name).toBe(true);
        expect(PROFILES[name].factor, name).toBeGreaterThan(0);
        expect(REFERENCE_MUSCLE_OF.get(name), name).toBe(muscle);
      }
    }
  });

  it("each member appears under exactly one muscle", () => {
    for (const name of DECLARED) expect(DECLARED.filter((n) => n === name), name).toHaveLength(1);
  });

  it("every member is a lift the catalogue can put in front of a lifter", () => {
    expect(DECLARED.filter((name) => !hasCatalogueName(name))).toEqual([]);
  });

  it("the pull-up family is exactly the members the catalogue loads with the body, all on Back", () => {
    const family = [...BODY_INCLUSIVE_REFERENCE_LIFTS].sort();
    expect(family).toEqual(DECLARED.filter((name) => loadTypeOfName(name) === "loaded_bodyweight").sort());
    expect(family).toHaveLength(5);
    for (const name of family) expect(REFERENCE_MUSCLE_OF.get(name), name).toBe("Back");
  });

  it("names the muscles a loadable lift has but no reference lift serves", () => {
    const loadable = new Set(Object.values(PROFILES).filter((p) => p.progressesByLoad === true && p.factor > 0).map((p) => p.primaryMuscle));
    const served = new Set(REFERENCE_MUSCLE_OF.values());
    expect([...loadable].filter((m) => !served.has(m)).sort()).toEqual(NO_REFERENCE);
    // Calves has no reference either: none of its lifts translates (factor 0).
    const calves = Object.values(PROFILES).filter((p) => p.primaryMuscle === "Calves");
    expect(calves.length).toBeGreaterThan(0);
    expect(calves.filter((p) => p.factor > 0)).toEqual([]);
  });

  it("admits a name only as its own profile on its own muscle, loadable at a factor above zero, once", () => {
    const got = referenceMuscleOf({
      Back: ["Pull-Up", "Pull-Up", "Assisted Pull-Up", "Barbell Row", "constructor", "Push-Up"],
      Shoulders: ["Pull-Up"],
      Calves: ["Standing Calf Raise"],
    });
    expect([...got]).toEqual([["Pull-Up", "Back"]]);
    // Name inference would read Barbell Row as a Back lift; the guard never asks it.
    expect(getLiftProfile("Barbell Row")).toMatchObject({ primaryMuscle: "Back", factor: 0.5 });
  });

  it("Assisted Pull-Up and Standing Calf Raise cannot be members", () => {
    expect(PROFILES["Assisted Pull-Up"].factor).toBe(0);
    expect(PROFILES["Standing Calf Raise"].factor).toBe(0);
    expect(REFERENCE_MUSCLE_OF.has("Assisted Pull-Up")).toBe(false);
    expect(REFERENCE_MUSCLE_OF.has("Standing Calf Raise")).toBe(false);
    const h = [rec("2026-10-01", [
      { name: "Assisted Pull-Up", loadType: "assisted_bodyweight", sets: [{ weight: 20, reps: 8, loadType: "machine", bodyweightUsed: 80, effectiveLoad: 60, est1rm: 76 }] },
      lift("Standing Calf Raise", "machine", [[200, 12]]),
    ])];
    expect(deriveMuscleAnchors(h)).toEqual({});
  });

  it("the list is frozen", () => {
    expect(Object.isFrozen(REFERENCE_LIFTS)).toBe(true);
    for (const names of Object.values(REFERENCE_LIFTS)) expect(Object.isFrozen(names)).toBe(true);
  });
});

describe("deriveMuscleAnchors: reference lifts only", () => {
  it("an isolation lift never sets the anchor: Shoulders is the press's 71.5, never 240", () => {
    const h = [rec("2026-10-09", [ohp(61.25, 5), rearDelt])];
    expect(h[0].blocks[0].exercises.map((e) => e.sets[0].est1rm)).toEqual([71.5, 24]);
    expect(deriveMuscleAnchors(h)).toEqual({
      Shoulders: { bestE1RM: 71.5, bestE1RMLift: "Barbell Overhead Press", bestE1RMDate: "2026-10-09" },
    });
    // The cold start reads the derived shape as it is: 71.5 x 0.75 x 0.45,
    // where the isolation lift's 240 capped Landmine Squeeze Press at 80.
    expect(coldStartFromAnchor("Landmine Squeeze Press", deriveMuscleAnchors(h).Shoulders)).toBe(24);
    expect(coldStartFromAnchor("Landmine Squeeze Press", { bestE1RM: 240 })).toBe(80);
    expect(startWeightFor({ name: "Landmine Squeeze Press", weight: 30, loadType: "barbell" }, { anchors: deriveMuscleAnchors(h) })).toBe(23.75);
  });

  it("a heavier reference set raises it, a lighter one does not", () => {
    const first = rec("2026-10-09", [ohp(61.25, 5)]);
    const raised = [first, rec("2026-10-16", [ohp(65, 5)])];
    expect(deriveMuscleAnchors(raised).Shoulders).toEqual({ bestE1RM: 75.8, bestE1RMLift: "Barbell Overhead Press", bestE1RMDate: "2026-10-16" });
    const lighter = [first, rec("2026-10-16", [ohp(59, 5)])];
    expect(lighter[1].blocks[0].exercises[0].sets[0].est1rm).toBe(68.8);
    expect(deriveMuscleAnchors(lighter).Shoulders).toEqual({ bestE1RM: 71.5, bestE1RMLift: "Barbell Overhead Press", bestE1RMDate: "2026-10-09" });
  });

  it("the same record id with a lighter set, in a new array, lowers it; with the record gone the muscle is absent", () => {
    const before = [rec("2026-10-09", [ohp(61.25, 5)])];
    expect(deriveMuscleAnchors(before).Shoulders.bestE1RM).toBe(71.5);
    const edited = [rec("2026-10-09", [ohp(55, 5)])];
    expect(edited[0].id).toBe(before[0].id);
    expect(deriveMuscleAnchors(edited).Shoulders.bestE1RM).toBe(64.2);
    expect(deriveMuscleAnchors([])).toEqual({});
    expect(deriveMuscleAnchors([rec("2026-10-10", [rearDelt])])).toEqual({});
    // The first array still reads as it did.
    expect(deriveMuscleAnchors(before).Shoulders.bestE1RM).toBe(71.5);
  });

  it("reads the same array once: the same frozen object comes back", () => {
    const h = [rec("2026-10-09", [ohp(61.25, 5)])];
    const a = deriveMuscleAnchors(h);
    expect(deriveMuscleAnchors(h)).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    // A copy is another array: derived afresh, to the same values.
    const copy = deriveMuscleAnchors([...h]);
    expect(copy).not.toBe(a);
    expect(copy).toEqual(a);
  });

  it("takes no bodyweight: only the history", () => {
    expect(deriveMuscleAnchors.length).toBe(1);
  });

  it("a non-reference lift never anchors its muscle, however heavy", () => {
    const h = [rec("2026-10-01", [
      lift("Leg Press", "machine", [[257.5, 10]]),            // 228.9 on the squat's scale
      lift("Face Pull", "total", [[28, 15]]),                 // 210 on the press's
      lift("Dumbbell Bent-Over Row", "per_db", [[40, 10]]),
      lift("Machine Hamstring Curl", "machine", [[45, 12]]),
      lift("Tricep Pushdown", "total", [[40, 12]]),
      lift("Barbell Row", "external", [[100, 5]]),
      pullUp({ weight: 20, reps: 8, bodyweightUsed: 80, effectiveLoad: 100, est1rm: 126.7 }, "Weighted Dips"),
    ])];
    expect(deriveMuscleAnchors(h)).toEqual({});
  });

  it("each member sets its own muscle at its e1RM over its own factor", () => {
    for (const name of DECLARED) {
      const muscle = REFERENCE_MUSCLE_OF.get(name);
      const lt = loadTypeOfName(name);
      const ex = lt === "loaded_bodyweight"
        ? pullUp({ weight: 10, reps: 6, bodyweightUsed: 80, effectiveLoad: 90, est1rm: 108 }, name)
        : lift(name, lt, [[40, 6]]);
      const e1rm = ex.sets[0].est1rm;
      expect(deriveMuscleAnchors([rec("2026-10-01", [ex])]), name).toEqual({
        [muscle]: { bestE1RM: round1(e1rm / PROFILES[name].factor), bestE1RMLift: name, bestE1RMDate: "2026-10-01" },
      });
    }
  });

  it("a member's factor puts its e1RM on the muscle's scale", () => {
    const h = [rec("2026-10-01", [
      lift("Push Press", "barbell", [[70, 5]]),                // 81.7 / 1.2 = 68.1
      lift("Dumbbell Shoulder Press", "per_db", [[24, 8]]),    // 30.4 / 0.4 = 76.0
    ])];
    expect(deriveMuscleAnchors(h).Shoulders).toEqual({ bestE1RM: 76, bestE1RMLift: "Dumbbell Shoulder Press", bestE1RMDate: "2026-10-01" });
  });

  it("a tie goes to the first seen", () => {
    const squat = rec("2026-10-01", [lift("Barbell Back Squat", "barbell", [[100, 5]])]);       // 116.7
    const front = rec("2026-10-02", [lift("Front Squat", "barbell", [[85, 5, 99.2]])]);          // 99.2 / 0.85 = 116.7
    expect(deriveMuscleAnchors([squat, front]).Quadriceps.bestE1RMLift).toBe("Barbell Back Squat");
    expect(deriveMuscleAnchors([front, squat]).Quadriceps.bestE1RMLift).toBe("Front Squat");
    expect(deriveMuscleAnchors([front, squat]).Quadriceps.bestE1RM).toBe(116.7);
  });

  it("a set's cached est1rm is its e1RM", () => {
    const h = [rec("2026-10-01", [lift("Barbell Back Squat", "barbell", [[100, 5, 50]])])];
    expect(deriveMuscleAnchors(h).Quadriceps.bestE1RM).toBe(50);
  });

  it("a record without a date anchors with a null date", () => {
    const { date: _date, ...undated } = rec("2026-10-01", [ohp(61.25, 5)]);
    expect(deriveMuscleAnchors([undated]).Shoulders).toEqual({ bestE1RM: 71.5, bestE1RMLift: "Barbell Overhead Press", bestE1RMDate: null });
  });
});

describe("deriveMuscleAnchors: which records and sets count", () => {
  it("skips a travel and a cooked record; a kept coached record counts", () => {
    const heavy = [ohp(80, 5)];
    expect(deriveMuscleAnchors([rec("2026-10-01", heavy, { travel: true })])).toEqual({});
    expect(deriveMuscleAnchors([rec("2026-10-01", heavy, { readiness: "cooked" })])).toEqual({});
    const coached = rec("2026-10-02", [ohp(61.25, 5)], { loggedBy: { name: "Coach", accountId: "acct-1" }, loggedAt: "2026-10-02T11:00:00.000Z" });
    expect(deriveMuscleAnchors([rec("2026-10-01", heavy, { travel: true }), coached, rec("2026-10-03", heavy, { readiness: "cooked" })]).Shoulders)
      .toEqual({ bestE1RM: 71.5, bestE1RMLift: "Barbell Overhead Press", bestE1RMDate: "2026-10-02" });
  });

  it("a pull-up set typed assisted or bodyweight leaves Back absent", () => {
    const assisted = pullUp({ weight: 20, reps: 8, loadType: "assisted_bodyweight", bodyweightUsed: 80, effectiveLoad: 60, est1rm: 76 });
    const bodyweight = pullUp({ weight: null, reps: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 80, est1rm: 101.3 });
    expect(deriveMuscleAnchors([rec("2026-10-01", [assisted])])).toEqual({});
    expect(deriveMuscleAnchors([rec("2026-10-01", [bodyweight])])).toEqual({});
    // The exercise's type answers for a set without its own.
    const exTyped = { name: "Pull-Up", loadType: "assisted_bodyweight", sets: [{ weight: 20, reps: 8, bodyweightUsed: 80, effectiveLoad: 60, est1rm: 76 }] };
    expect(deriveMuscleAnchors([rec("2026-10-01", [exTyped])])).toEqual({});
    // The set's own type wins over the exercise's.
    const setTyped = pullUp({ weight: 10, reps: 8, bodyweightUsed: 80, effectiveLoad: 90, est1rm: 114 }, "Pull-Up", "bodyweight");
    expect(deriveMuscleAnchors([rec("2026-10-01", [setTyped])]).Back.bestE1RM).toBe(114);
  });

  it("a loaded pull-up reads the body plus the belt; an unknown bodyweight leaves Back absent", () => {
    const belted = pullUp({ weight: 10, reps: 8, bodyweightUsed: 80, effectiveLoad: 90, est1rm: 114 });
    expect(deriveMuscleAnchors([rec("2026-10-01", [belted])]).Back).toEqual({ bestE1RM: 114, bestE1RMLift: "Pull-Up", bestE1RMDate: "2026-10-01" });
    const unknownBody = pullUp({ weight: 10, reps: 8, bodyweightUsed: null, effectiveLoad: null, est1rm: null });
    expect(deriveMuscleAnchors([rec("2026-10-01", [unknownBody])])).toEqual({});
  });

  it("a null est1rm stays null: the set is skipped, never recomputed", () => {
    const h = [rec("2026-10-01", [{ name: "Barbell Overhead Press", loadType: "barbell", sets: [{ weight: 60, reps: 5, loadType: "barbell", bodyweightUsed: 80, est1rm: null }] }])];
    expect(deriveMuscleAnchors(h)).toEqual({});
  });
});

describe("deriveMuscleAnchors: the loaded-bodyweight fallback", () => {
  it("an external-load reference wins over the pull-up family whenever one is logged", () => {
    expect(pulldown.sets[0].est1rm).toBe(86.7);
    const both = [rec("2026-10-01", [pulldown, bwPullUp])];
    expect(deriveMuscleAnchors(both).Back).toEqual({ bestE1RM: 102, bestE1RMLift: "Lat Pulldown", bestE1RMDate: "2026-10-01" });
    // In either order, and across records.
    expect(deriveMuscleAnchors([rec("2026-10-01", [bwPullUp]), rec("2026-10-08", [pulldown])]).Back.bestE1RMLift).toBe("Lat Pulldown");
    expect(deriveMuscleAnchors([rec("2026-10-01", [pulldown]), rec("2026-10-08", [bwPullUp])]).Back.bestE1RMLift).toBe("Lat Pulldown");
  });

  it("with no external-load reference the pull-up answers", () => {
    expect(deriveMuscleAnchors([rec("2026-10-01", [bwPullUp])]).Back).toEqual({ bestE1RM: 103.7, bestE1RMLift: "Pull-Up", bestE1RMDate: "2026-10-01" });
  });

  it("only a qualifying set of the same muscle suppresses it", () => {
    // Another muscle's external reference does not.
    const bench = lift("Barbell Bench Press", "barbell", [[95, 5]]);
    expect(deriveMuscleAnchors([rec("2026-10-01", [bench, bwPullUp])]).Back.bestE1RMLift).toBe("Pull-Up");
    // A pulldown in a cooked record decides nothing, so it does not either.
    expect(deriveMuscleAnchors([rec("2026-10-01", [pulldown], { readiness: "cooked" }), rec("2026-10-08", [bwPullUp])]).Back.bestE1RM).toBe(103.7);
    // Nor does a pulldown set with no usable e1RM.
    const empty = lift("Lat Pulldown", "total", [[null, 10, null]]);
    expect(deriveMuscleAnchors([rec("2026-10-01", [empty, bwPullUp])]).Back.bestE1RM).toBe(103.7);
  });

  it("a pull-up family set counts only with the body in its load: a belt-only set never stands in as the reference", () => {
    // A pre-v2 set the migration typed external, logged without a bodyweight: the belt alone.
    const beltOnly = { name: "Pull-Up", loadType: "external", sets: [{ weight: 10, reps: 8, rir: 2, rpe: 8, loadType: "external", bodyweightUsed: null, effectiveLoad: 10, est1rm: 12.7 }] };
    expect(deriveMuscleAnchors([rec("2026-06-15", [beltOnly]), rec("2026-10-01", [bwPullUp])]).Back)
      .toEqual({ bestE1RM: 103.7, bestE1RMLift: "Pull-Up", bestE1RMDate: "2026-10-01" });
    expect(deriveMuscleAnchors([rec("2026-06-15", [beltOnly])]).Back).toBeUndefined();
    // The same set as the server reads a raw v1 record: no load type anywhere.
    const rawBelt = { name: "Pull-Up", sets: [{ weight: 10, reps: 8, rpe: "normal" }] };
    expect(deriveMuscleAnchors([rec("2026-06-15", [rawBelt]), rec("2026-10-01", [bwPullUp])]).Back.bestE1RM).toBe(103.7);
    expect(deriveMuscleAnchors([rec("2026-06-15", [rawBelt])])).toEqual({});
    // The bucket is the lift's, not the set's: a pulldown stays an external-load reference whatever its set says.
    const oddPulldown = lift("Lat Pulldown", "loaded_bodyweight", [[65, 10]]);
    expect(deriveMuscleAnchors([rec("2026-10-01", [oddPulldown, bwPullUp])]).Back.bestE1RMLift).toBe("Lat Pulldown");
  });

  it("the loaded_bw spelling falls back too", () => {
    const heavy = pullUp({ weight: 20, reps: 8, loadType: "loaded_bw", bodyweightUsed: 80, effectiveLoad: 100, est1rm: 110 });
    expect(deriveMuscleAnchors([rec("2026-10-01", [pulldown, heavy])]).Back).toEqual({ bestE1RM: 102, bestE1RMLift: "Lat Pulldown", bestE1RMDate: "2026-10-01" });
    expect(deriveMuscleAnchors([rec("2026-10-01", [heavy])]).Back.bestE1RM).toBe(110);
  });
});

describe("deriveMuscleAnchors: a pre-v2 record read unmigrated", () => {
  const LOAD_TYPES = [undefined, "external", "barbell", "per_db", "total", "machine", "loaded_bodyweight", "loaded_bw", "bodyweight", "assisted_bodyweight"];
  const deviceRead = (raw) => migrateV2ToV3(migrateV1ToV2(raw));
  /** A v1 record: no schemaVersion, est1rm, effectiveLoad or (unless given) loadType. */
  const v1 = (exercises) => ({ id: "2026-06-15T10:00:00.000Z", date: "2026-06-15", session: "strength-a", readiness: "normal", blocks: [{ id: "b1", type: "main", exercises }] });

  it("a v1 squat derives from weight and reps, as the device's migrated read does", () => {
    const raw = v1([{ name: "Barbell Back Squat", sets: [{ weight: 55, reps: 5, rpe: "normal" }] }]);
    expect(deriveMuscleAnchors([raw])).toEqual({ Quadriceps: { bestE1RM: 64.2, bestE1RMLift: "Barbell Back Squat", bestE1RMDate: "2026-06-15" } });
    expect(deriveMuscleAnchors([deviceRead(raw)])).toEqual(deriveMuscleAnchors([raw]));
  });

  it("derives exactly what the migrated record derives, over load types and bodyweight present or absent", () => {
    let anchored = 0;
    let cases = 0;
    for (const name of ["Barbell Back Squat", "Pull-Up", "Lat Pulldown"]) {
      for (const lt of LOAD_TYPES) {
        // On the set, on the exercise, or on the exercise under a set typed "".
        for (const on of ["set", "exercise", "under-empty"]) {
          for (const body of ["absent", null, 80]) {
            for (const [weight, reps] of [[60, 5], [10, 1], [0, 8], [null, 8], [40, "8/leg"], [40, " 8"], [40, "-3"], [60, 0]]) {
              const set = { weight, reps, rpe: "normal" };
              if (on === "set" && lt !== undefined) set.loadType = lt;
              if (on === "under-empty") set.loadType = "";
              if (body !== "absent") set.bodyweightUsed = body;
              const ex = { name, sets: [set] };
              if (on !== "set" && lt !== undefined) ex.loadType = lt;
              const raw = v1([ex]);
              const got = deriveMuscleAnchors([raw]);
              expect(got, JSON.stringify(raw.blocks[0].exercises[0])).toEqual(deriveMuscleAnchors([deviceRead(raw)]));
              cases++;
              if (Object.keys(got).length) anchored++;
            }
          }
        }
      }
    }
    // Both outcomes in number: the matrix compares anchors, not only empties.
    expect(cases).toBe(3 * LOAD_TYPES.length * 3 * 3 * 8);
    expect(anchored).toBeGreaterThan(100);
    expect(cases - anchored).toBeGreaterThan(100);
  });

  it("the fallback reads the same either way", () => {
    const raw = v1([
      { name: "Pull-Up", loadType: "loaded_bodyweight", sets: [{ weight: 0, reps: 9, rpe: "normal", bodyweightUsed: 79.8 }] },
      { name: "Lat Pulldown", sets: [{ weight: 65, reps: 10, rpe: "normal" }] },
    ]);
    expect(deriveMuscleAnchors([raw]).Back).toEqual({ bestE1RM: 102, bestE1RMLift: "Lat Pulldown", bestE1RMDate: "2026-06-15" });
    expect(deriveMuscleAnchors([deviceRead(raw)])).toEqual(deriveMuscleAnchors([raw]));
    const pullUpOnly = v1([raw.blocks[0].exercises[0]]);
    expect(deriveMuscleAnchors([pullUpOnly]).Back.bestE1RM).toBe(103.7);
    expect(deriveMuscleAnchors([deviceRead(pullUpOnly)])).toEqual(deriveMuscleAnchors([pullUpOnly]));
  });
});

describe("deriveMuscleAnchors: malformed input and the frozen shape", () => {
  it("never throws on malformed history", () => {
    const junk = [
      null, undefined, 3, "x", [], { blocks: "abc" }, { blocks: null }, { blocks: { b1: { exercises: [] } } },
      { blocks: [null, 7, "x", { exercises: "abc" }, { exercises: null }, { exercises: { "Pull-Up": {} } }, { exercises: [
        null, 5, "Barbell Overhead Press", { name: "Barbell Overhead Press" }, { name: "Barbell Overhead Press", sets: "abc" },
        { name: "Barbell Overhead Press", sets: [
          null, 4, "x", { weight: NaN, reps: 5 }, { weight: 60, reps: NaN }, { weight: Infinity, reps: 5 }, { weight: -60, reps: 5 },
          { est1rm: NaN }, { est1rm: "71.5" }, { est1rm: -5 }, { est1rm: Infinity }, { weight: 60, reps: "x8" },
        ] },
      ] }] },
    ];
    expect(() => deriveMuscleAnchors(junk)).not.toThrow();
    expect(deriveMuscleAnchors(junk)).toEqual({});
  });

  it("reads a string's leading rep count, as storage's parser does", () => {
    const h = [rec("2026-10-01", [{ name: "Barbell Overhead Press", sets: [{ weight: 60, reps: "8/leg" }] }])];
    expect(deriveMuscleAnchors(h).Shoulders.bestE1RM).toBe(76);
  });

  it("returns a frozen empty object for anything but an array", () => {
    for (const input of [null, undefined, 0, "history", {}, { length: 1, 0: rec("2026-10-01", [ohp(61.25, 5)]) }, new Set()]) {
      const got = deriveMuscleAnchors(input);
      expect(got).toEqual({});
      expect(Object.isFrozen(got)).toBe(true);
    }
  });

  it("output is frozen, every anchor too, and each value lands on a tenth", () => {
    const h = [rec("2026-10-01", [
      lift("Front Squat", "barbell", [[100, 5]]),      // 116.7 / 0.85 = 137.29...
      lift("Romanian Deadlift", "barbell", [[97.5, 8]]),
      lift("EZ Bar Curl", "barbell", [[37.5, 9]]),
      pullUp({ weight: 7.5, reps: 7, bodyweightUsed: 81.3, effectiveLoad: 88.8, est1rm: 109.5 }, "Chin-Up"),
    ])];
    const a = deriveMuscleAnchors(h);
    expect(a.Quadriceps.bestE1RM).toBe(137.3);
    expect(Object.keys(a).sort()).toEqual(["Back", "Biceps", "Hamstrings", "Quadriceps"]);
    for (const anchor of Object.values(a)) {
      expect(anchor.bestE1RM).toBe(round1(anchor.bestE1RM));
      expect(Object.isFrozen(anchor)).toBe(true);
    }
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => { a.Quadriceps.bestE1RM = 1; }).toThrow(TypeError);
    expect(() => { a.Chest = { bestE1RM: 1 }; }).toThrow(TypeError);
    expect(a.Quadriceps.bestE1RM).toBe(137.3);
  });
});

// ─── The readers ─────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..");
const NOW = new Date("2026-10-30T12:00:00Z");
const BODY = 79.8;
const pool = (slot, name) => EXERCISE_POOLS[slot].pool.find((p) => p.name === name);
/** A source file with its comment lines stripped. */
const code = (f) => readFileSync(join(ROOT, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\/?\*|\{\/\*)/.test(l)).join("\n");

/** The owner's external-load set, as logSet cached it at their bodyweight. */
const owned = (name, w, r) => ({
  name, loadType: "barbell",
  sets: [{ weight: w, reps: r, rir: 2, rpe: 8, loadType: "barbell", bodyweightUsed: BODY, effectiveLoad: w, est1rm: epley(w, r) }],
});
// The owner's anchor-setting sets, one record each, and nothing else of their history.
const OWNER = [
  rec("2026-09-28", [owned("Barbell Back Squat", 130, 5)]),     // 151.7
  rec("2026-09-30", [owned("Barbell Bench Press", 95, 5)]),     // 110.8
  rec("2026-10-02", [owned("Barbell Overhead Press", 61.25, 5)]), // 71.5
  rec("2026-10-05", [owned("Barbell Hip Thrust", 140, 10)]),    // 186.7
  rec("2026-10-07", [bwPullUp]),                                // the body alone, 79.8 x 9: 103.7
];
// The owner's Day A rotation, every lift in it never logged.
const OWNER_SLOTS = [
  ["ass1-A", "DB Step-Up"], ["ass1-B", "Landmine Squeeze Press"], ["ass2-A", "Reverse Hyperextension"],
  ["ass2-B", "Seal Row"], ["afin-B", "Leg Press Calf Raise"],
];
const OWNER_CONFIG = Object.fromEntries(OWNER_SLOTS.map(([slot, name]) => [slot, pool(slot, name)]));

/** A meta whose rep targets name every lift in its programme, so current_loads lists each. */
function metaFor(extra = {}) {
  const base = { bodyweight: { kg: BODY }, weights: {}, programmeBlock: { number: 3, config: OWNER_CONFIG }, ...extra };
  const reps = {};
  for (const l of resolvedProgramme(base)) if (!(l.name in reps)) reps[l.name] = l.ex.reps;
  return { ...base, reps };
}
/** The programme's lifts that load a bar or a stack and progress by it, once each, none of them in `history`. */
function neverLoggedLoaded(meta, history) {
  const logged = new Set(history.flatMap((r) => r.blocks.flatMap((b) => b.exercises.map((e) => e.name))));
  const seen = new Set();
  return resolvedProgramme(meta, history).filter((l) => {
    if (seen.has(l.name) || logged.has(l.name)) return false;
    seen.add(l.name);
    return !l.timed && !isBodyweightMovement(l.loadType) && getLiftProfile(l.name).progressesByLoad;
  });
}
/** Every lift's first session, logged with no weight: nothing to seed a lift state from. */
const unloadedSession = (lifts) => rec("2026-10-12", lifts.map((l) => ({
  name: l.name, loadType: l.loadType,
  sets: [1, 2].map(() => ({ weight: null, reps: l.reps, rir: 2, loadType: l.loadType, effectiveLoad: null, est1rm: null })),
})));
/** The engine's start for each lift, from that session applied after `history`. */
function engineStarts(history, lifts, { stored = null, currentWeights = {} } = {}) {
  localStorage.clear();
  if (stored) TS.save("p", { ...TS.get("p"), muscleAnchors: stored });
  for (const r of history) H.append("p", r);
  const session = unloadedSession(lifts);
  H.append("p", session);
  return applySessionToEngine("p", session, { currentWeights }).wwUpdates;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A lift's suggested start as the MCP programme tool words it. */
const programmeStart = (text, name) => {
  const m = text.match(new RegExp(`(?:: |\\+ )${escape(name)} \\d+ × \\S+ @ ([\\d.]+) kg`));
  return m ? Number(m[1]) : null;
};
/** A lift's suggested start as current_loads words it. */
const loadsStart = (text, name) => {
  const m = text.match(new RegExp(`^- ${escape(name)}: ([\\d.]+) kg`, "m"));
  return m ? Number(m[1]) : null;
};

describe("the stored field is inert", () => {
  beforeEach(() => localStorage.clear());
  const files = (dir) => readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(ROOT, dir, f);
    return statSync(p).isDirectory() ? files(relative(ROOT, p)) : /\.(jsx?|mjs)$/.test(f) ? [relative(ROOT, p)] : [];
  });
  // A property read of the stored field: `.muscleAnchors` not called, or its bracket form.
  const READ = /\.muscleAnchors\b(?!\s*\()|\[\s*["'`]muscleAnchors["'`]\s*\]/g;
  const MUSCLES = [...new Set(Object.values(PROFILES).map((p) => p.primaryMuscle).filter(Boolean))];
  const ABSURD = Object.fromEntries(MUSCLES.map((m) => [m, { bestE1RM: 9999, bestE1RMLift: "Barbell Back Squat", bestE1RMDate: "2026-01-01" }]));

  it("only storage, the sync merge and the diag page read it", () => {
    const readers = {};
    for (const f of [...files("lib"), ...files("components"), ...files("app")]) {
      const n = (code(f).match(READ) || []).length;
      if (n) readers[f] = n;
    }
    expect(Object.keys(readers).sort()).toEqual(["app/diag-sync/page.jsx", "lib/storage.js", "lib/sync-merge.js"]);
  });

  it("names it nowhere new: every mention, destructured or not, is counted per file", () => {
    // READ sees a property read only; a destructured one gets past it. So a
    // new mention of the name anywhere fails here until someone looks at it.
    const MENTIONS = {
      "app/diag-sync/page.jsx": 1,      // the legacy count it shows
      "components/ForgeApp.jsx": 4,     // homePlan's anchors to the card and the retro sheet; the sheet's prop and its plan
      "components/HomeScreen.jsx": 2,   // the prop and its plan
      "components/SessionHost.jsx": 8,  // the source's anchors, read once, and the plans that take them
      "lib/session-source.js": 2,       // each source's method
      "lib/storage.js": 2,              // the default shape and the richness check
      "lib/sync-merge.js": 2,           // the richness check
    };
    const mentions = {};
    for (const f of [...files("lib"), ...files("components"), ...files("app")]) {
      const n = (code(f).match(/\bmuscleAnchors\b/g) || []).length;
      if (n) mentions[f] = n;
    }
    expect(mentions).toEqual(MENTIONS);
  });

  it("an absurd stored anchor with no history plans as no stored field does, everywhere", () => {
    const meta = metaFor();
    const lifts = neverLoggedLoaded(meta, []);
    expect(lifts.length).toBeGreaterThan(15);
    // Read, the absurd anchor would move the plan.
    const moved = lifts.filter((l) => planStartWeight(l.ex, { working: {}, bodyweight: BODY, anchors: ABSURD }) !== planStartWeight(l.ex, { working: {}, bodyweight: BODY, anchors: {} }));
    expect(moved.length).toBeGreaterThan(10);

    // The home card and the session, through the lifter's source.
    const homeStarts = (stored) => {
      localStorage.clear();
      if (stored) TS.save("p", { ...TS.get("p"), muscleAnchors: stored });
      const source = localSource("p");
      for (const anchors of [source.muscleAnchors(), source.muscleAnchors(H.get("p"))]) expect(anchors).toEqual({});
      return lifts.map((l) => planStartWeight(l.ex, { working: {}, bodyweight: BODY, anchors: source.muscleAnchors(H.get("p")) }));
    };
    expect(homeStarts(ABSURD)).toEqual(homeStarts(null));

    // The MCP tools and the resolved programme, from a synced meta.
    const absurdMeta = { ...meta, trainingState: { muscleAnchors: ABSURD } };
    for (const tool of ["programme", "current_loads"]) {
      expect(runTool(tool, {}, { meta: absurdMeta, history: [] }, NOW).text, tool).toBe(runTool(tool, {}, { meta, history: [] }, NOW).text);
    }
    expect(resolvedProgramme(absurdMeta, []).map((l) => l.start)).toEqual(resolvedProgramme(meta, []).map((l) => l.start));

    // The engine: an unloaded first session takes the caller's weight, as with no field.
    const currentWeights = Object.fromEntries(lifts.map((l) => [l.name, 20]));
    const plain = engineStarts([], lifts, { currentWeights });
    expect(engineStarts([], lifts, { stored: ABSURD, currentWeights })).toEqual(plain);
    expect(plain).toEqual(currentWeights);
  });

  it("a finish with reference and isolation lifts leaves the stored field as seeded", () => {
    // As an older version left it: an isolation lift's inflated Shoulders,
    // with its window of top sets, and a bare Chest entry.
    const SEEDED = {
      Shoulders: {
        bestE1RM: 240, bestE1RMLift: "Rear Delt Fly", bestE1RMDate: "2026-09-01",
        recentTopSets: [{ date: "2026-09-01", lift: "Rear Delt Fly", weight: 16, reps: 15, effectiveLoad: 16, est1rm: 24, anchorEquivalentE1RM: 240 }],
      },
      Chest: { bestE1RM: 80, bestE1RMLift: "Barbell Bench Press" },
    };
    const finishes = [
      rec("2026-10-12", [ohp(65, 5), lift("Barbell Back Squat", "barbell", [[130, 5]]), rearDelt, lift("Leg Extension", "machine", [[90, 12]])]),
      rec("2026-10-14", [ohp(67.5, 5), lift("Barbell Bench Press", "barbell", [[100, 5]]), lift("Cable Lateral Raise", "cable", [[12.5, 15]])]),
    ];
    for (const stored of [SEEDED, null]) {
      localStorage.clear();
      if (stored) TS.save("p", { ...TS.get("p"), muscleAnchors: stored });
      const want = JSON.stringify(stored ?? {});
      for (const r of finishes) {
        commitSessionRecord("p", r);
        for (const ex of r.blocks[0].exercises) expect(TS.get("p").lifts[ex.name], ex.name).toBeDefined();
        // Byte for byte, in the store and in the sync payload.
        expect(JSON.stringify(TS.get("p").muscleAnchors)).toBe(want);
        expect(JSON.stringify(getLocalProfile("p").meta.trainingState.muscleAnchors)).toBe(want);
      }
      // The derived anchors moved with the reference lifts alone.
      const pairs = Object.fromEntries(Object.entries(deriveMuscleAnchors(H.get("p"))).map(([m, a]) => [m, [a.bestE1RM, a.bestE1RMLift]]));
      expect(pairs).toEqual({ Shoulders: [78.8, "Barbell Overhead Press"], Quadriceps: [151.7, "Barbell Back Squat"], Chest: [116.7, "Barbell Bench Press"] });
    }
  });
});

describe("a trainer's device derives no anchor", () => {
  it("the coached source answers none, though the view's sessions hold reference-lift sets", () => {
    // Sets logged as external load, as older records hold them.
    const history = [
      rec("2026-10-02", [lift("Barbell Overhead Press", "external", [[61.25, 5]])]),
      rec("2026-10-05", [lift("Barbell Back Squat", "external", [[130, 5]])]),
    ];
    const view = projectForTrainer({ meta: metaFor(), history }, { todayIso: "2026-10-09", edits: { rows: [], used: 0, freeAt: null } });
    const sessions = view.sessions;
    expect(sessions.map((s) => s.blocks[0].exercises[0].name)).toEqual(["Barbell Overhead Press", "Barbell Back Squat"]);
    // The view's sets carry no est1rm: a derivation there would compute one
    // from weight x reps.
    expect(JSON.stringify(sessions)).not.toContain("est1rm");
    expect(Object.keys(deriveMuscleAnchors(sessions)).sort()).toEqual(["Quadriceps", "Shoulders"]);
    const source = coachedSource(view.plan, view);
    expect(source.muscleAnchors(sessions)).toEqual({});
    expect(source.muscleAnchors(source.history())).toEqual({});
  });

  it("the session host derives nothing itself: its anchors come through its source, once", () => {
    const host = readFileSync(join(ROOT, "components/SessionHost.jsx"), "utf8");
    expect(host).not.toMatch(/deriveMuscleAnchors/);
    expect(code("components/SessionHost.jsx").match(/\bsource\.muscleAnchors\(/g)).toEqual(["source.muscleAnchors("]);
    expect(code("components/SessionHost.jsx")).toMatch(/useState\(\(\) => source\.muscleAnchors\(history\)\)/);
  });
});

describe("the owner's cold starts, from only the sets that anchor them", () => {
  const STARTS = { "DB Step-Up": 21, "Landmine Squeeze Press": 23.75, "Reverse Hyperextension": 50, "Seal Row": 23, "Leg Press Calf Raise": 55 };
  // Where the stored anchor started them.
  const OLD = { "DB Step-Up": 31, "Landmine Squeeze Press": 80, "Reverse Hyperextension": 50, "Seal Row": 35, "Leg Press Calf Raise": 55 };

  it("five sets anchor five muscles", () => {
    const pairs = Object.fromEntries(Object.entries(deriveMuscleAnchors(OWNER)).map(([m, a]) => [m, [a.bestE1RM, a.bestE1RMLift]]));
    expect(pairs).toEqual({
      Quadriceps: [151.7, "Barbell Back Squat"], Chest: [110.8, "Barbell Bench Press"], Shoulders: [71.5, "Barbell Overhead Press"],
      Back: [103.7, "Pull-Up"], Glutes: [186.7, "Barbell Hip Thrust"],
    });
  });

  it("the never-logged lifts start at 21 each, 23.75, 50, 23 each and 55, none above its old start", () => {
    const anchors = deriveMuscleAnchors(OWNER);
    const got = Object.fromEntries(OWNER_SLOTS.map(([slot, name]) => [name, planStartWeight(pool(slot, name), { working: {}, bodyweight: BODY, anchors })]));
    expect(got).toEqual(STARTS);
    for (const name of Object.keys(OLD)) expect(got[name], name).toBeLessThanOrEqual(OLD[name]);
    expect(["DB Step-Up", "Seal Row"].map((n) => loadTypeOfName(n))).toEqual(["per_db", "per_db"]);
    // The calf raise keeps its template: at factor 0 no anchor sizes it.
    expect(pool("afin-B", "Leg Press Calf Raise").weight).toBe(55);
    expect(coldStartFromAnchor("Leg Press Calf Raise", { bestE1RM: 9999 })).toBeNull();
  });
});

describe("every reader plans a never-logged lift at the same start", () => {
  beforeEach(() => localStorage.clear());

  /**
   * Every reader's start for each never-logged loaded lift after `records`,
   * held equal; returns the derived anchors, the lifts an anchor sized and
   * the engine's starts.
   */
  function readersAgree(records) {
    const meta = metaFor();
    for (const r of records) H.append("p", r);
    const history = H.get("p");
    const anchors = localSource("p").muscleAnchors(history);
    expect(anchors).toEqual(deriveMuscleAnchors(records));
    const lifts = neverLoggedLoaded(meta, history);
    for (const [, name] of OWNER_SLOTS) expect(lifts.map((l) => l.name)).toContain(name);
    const programme = runTool("programme", {}, { meta, history }, NOW).text;
    const loads = runTool("current_loads", {}, { meta, history }, NOW).text;
    const engine = engineStarts(records, lifts);
    const anchored = [];
    for (const l of lifts) {
      const home = planStartWeight(l.ex, { working: {}, bodyweight: BODY, anchors });
      expect(home, l.name).toBeGreaterThan(0);
      expect(l.start, l.name).toBe(home);
      expect(programmeStart(programme, l.name), l.name).toBe(home);
      expect(loadsStart(loads, l.name), l.name).toBe(home);
      // An unloaded first session starts where the card did whenever an anchor
      // sizes the lift; with none, the engine sizes nothing on its own.
      if (planStartWeight(l.ex, { anchors, bodyweight: null, template: null }) !== null) {
        anchored.push(l.name);
        expect(engine[l.name], l.name).toBe(home);
      } else {
        expect(Object.hasOwn(engine, l.name), l.name).toBe(false);
      }
    }
    return { anchors, anchored, engine };
  }

  it("the home card, the resolved programme, both MCP tools and the engine agree", () => {
    expect(readersAgree(OWNER).anchored.length).toBeGreaterThanOrEqual(10);
  });

  it("an anchor that rounds a lift's start to 0 starts it on no reader", () => {
    // One pulldown at 2.5 x 10 (e1RM 3.3) beside the pull-ups: the external
    // set wins the fallback, so Back is 3.9 and Seal Row's anchor start is 0.
    const light = [...OWNER, rec("2026-10-09", [lift("Lat Pulldown", "total", [[2.5, 10]])])];
    const { anchors, anchored, engine } = readersAgree(light);
    expect(anchors.Back).toEqual({ bestE1RM: 3.9, bestE1RMLift: "Lat Pulldown", bestE1RMDate: "2026-10-09" });
    expect(coldStartFromAnchor("Seal Row", anchors.Back)).toBe(0);
    // The card plans it as with no anchor; the engine writes no 0 under it.
    const seal = pool("ass2-B", "Seal Row");
    expect(planStartWeight(seal, { working: {}, bodyweight: BODY, anchors })).toBe(planStartWeight(seal, { working: {}, bodyweight: BODY, anchors: {} }));
    expect(anchored).not.toContain("Seal Row");
    expect(Object.values(engine)).not.toContain(0);
    // A Back lift the light anchor still starts above 0 keeps it.
    expect(anchored).toContain("Seated Cable Row");
    expect(anchored.length).toBeGreaterThanOrEqual(10);
  });

  it("the home card and the retro sheet plan with the anchors derived from the history the card shows", () => {
    // ForgeApp's homePlan feeds both; the home leg above plans as HomeScreen
    // does, from the anchors this memo derives.
    const app = code("components/ForgeApp.jsx");
    const memo = app.match(/const homePlan = useMemo\(\(\) => \{([\s\S]*?)\n\s*\}, \[([^\]]*)\]\);/);
    expect(memo, "homePlan").not.toBeNull();
    expect(memo[1]).toMatch(/\banchors: deriveMuscleAnchors\(history\) \};/);
    expect(memo[1]).not.toMatch(/\bmuscleAnchors\b/);
    expect(memo[2].split(",").map((d) => d.trim())).toEqual(["activeProfile", "workingWeights", "workingReps", "history"]);
    expect(app.match(/muscleAnchors=\{homePlan\.anchors\}/g)).toHaveLength(2);
    expect(app).toMatch(/<HomeScreen [^\n]*\bmuscleAnchors=\{homePlan\.anchors\}/);
    expect(app).toMatch(/<RetrospectiveSessionSheet [^\n]*\bmuscleAnchors=\{homePlan\.anchors\}/);
    // Each plans with the prop as it comes.
    expect(code("components/HomeScreen.jsx")).toMatch(/\{ reps: liveReps, weights: workingWeights, bodyweight, anchors: muscleAnchors \};/);
    expect(app).toMatch(/planStartWeight\(ex, \{ working: workingWeights, bodyweight, anchors: muscleAnchors \}\)/);
  });
});
