// tests/travel.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Travel mode's contract. The old travel mode was a swap-sheet filter that
// offered nothing for main lifts; the replacement converts a whole resolved
// session, so the invariants worth pinning are structural: every slot still
// exists, every slot is trainable with the assumed kit, nothing is prescribed
// twice, and the record can never feed the progression engine.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  deriveTravelSession, travelReps, travelTwin,
  TRAVEL_MOVES, TRAVEL_TWINS, TRAVEL_FALLBACK_BY_MUSCLE, TRAVEL_NATIVE,
} from "../lib/travel.js";
import { SESSIONS } from "../lib/programme.js";
import { EXERCISE_ANATOMY, getAnatomy } from "../lib/exercise-anatomy.js";
import { __test__, isLatestSessionForLift } from "../lib/progression.js";
import { newDraftLog, finaliseDraft } from "../lib/storage.js";
import { PROFILE_SUFFIXES } from "../lib/store-health.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const slotsOf = (session) =>
  session.blocks.flatMap((b) => [b.ex, b.exA, b.exB].filter(Boolean));

describe("travelReps — the prescription moves with the slot's job", () => {
  it("doubles heavy main-lift reps into a hard bodyweight range", () => {
    expect(travelReps(3, "main")).toBe(6);
    expect(travelReps(5, "main")).toBe(10);
    expect(travelReps(8, "main")).toBe(12);   // clamped — never a marathon set
  });

  it("lifts accessories to 10–15 and finishers toward 25", () => {
    expect(travelReps(8, "superset")).toBe(10);
    expect(travelReps(10, "superset")).toBe(13);
    expect(travelReps(12, "superset")).toBe(15);  // clamped
    expect(travelReps(12, "finisher")).toBe(15);
    expect(travelReps(20, "finisher")).toBe(25);
  });

  it("keeps the written shape: per-leg stays per-leg, holds stay holds", () => {
    expect(travelReps("8/leg", "superset")).toBe("10/leg");
    expect(travelReps("20s", "finisher")).toBe("20s");   // a plank is already bodyweight
    expect(travelReps("30s", "superset")).toBe("30s");
  });

  it("passes through anything it cannot read rather than inventing a number", () => {
    expect(travelReps(null, "main")).toBe(null);
    expect(travelReps("AMRAP", "finisher")).toBe("AMRAP");
  });
});

describe("travelTwin — resolution order", () => {
  it("leaves movements that already travel alone", () => {
    expect(travelTwin({ name: "Pull-Up" })).toBeNull();
    expect(travelTwin({ name: "Hanging Leg Raise" })).toBeNull();
    expect(travelTwin({ name: "Dead Bug" })).toBeNull();
  });

  it("prefers the curated twin", () => {
    expect(travelTwin({ name: "Barbell Back Squat" })).toBe("Bulgarian Split Squat");
    expect(travelTwin({ name: "Hex Bar Deadlift" })).toBe("Single-Leg RDL");
  });

  it("falls back on anatomy for movements no twin covers — the rotation case", () => {
    // Never referenced in TRAVEL_TWINS; rotation can still serve it.
    expect(TRAVEL_TWINS["Hack Squat"]).toBeUndefined();
    expect(travelTwin({ name: "Hack Squat" })).toBe("Bulgarian Split Squat");
  });

  it("takes the next alternate when the preferred twin is already prescribed", () => {
    const claimed = new Set(["Bulgarian Split Squat"]);
    expect(travelTwin({ name: "Hack Squat" }, claimed)).toBe("Step-Up");
  });

  it("repeats rather than empties a slot when every alternate is taken", () => {
    const claimed = new Set(TRAVEL_FALLBACK_BY_MUSCLE.Calves);
    expect(travelTwin({ name: "Standing Calf Raise" }, claimed)).toBe("Single-Leg Calf Raise");
  });
});

describe("deriveTravelSession — the A/B/C shape survives", () => {
  for (const session of SESSIONS) {
    it(`${session.name}: same blocks, same slots, same order`, () => {
      const t = deriveTravelSession(session);
      expect(t.blocks).toHaveLength(session.blocks.length);
      t.blocks.forEach((b, i) => {
        expect(b.type).toBe(session.blocks[i].type);
        expect(b.id).toBe(session.blocks[i].id);
        // A slot that existed still exists; one that didn't isn't invented.
        for (const key of ["ex", "exA", "exB"]) {
          expect(Boolean(b[key])).toBe(Boolean(session.blocks[i][key]));
        }
      });
    });

    it(`${session.name}: every slot is bodyweight and carries its kit`, () => {
      for (const ex of slotsOf(deriveTravelSession(session))) {
        expect(ex.travel).toBe(true);
        // No gym load survives — including on movements that pass through
        // unconverted, which are still prescribed at a barbell weight upstream.
        expect(ex.weight ?? null).toBeNull();
        expect(ex.loadType).toBe("bodyweight");
        if (ex.travelFrom) expect(TRAVEL_MOVES[ex.name]).toBeDefined();
      }
    });

    it(`${session.name}: no movement is prescribed twice`, () => {
      const names = slotsOf(deriveTravelSession(session)).map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
    });
  }

  it("is pure — the source session is untouched", () => {
    const before = JSON.stringify(SESSIONS[0]);
    deriveTravelSession(SESSIONS[0]);
    expect(JSON.stringify(SESSIONS[0])).toBe(before);
  });

  it("flags the session so downstream can tell what it is", () => {
    expect(deriveTravelSession(SESSIONS[0]).travel).toBe(true);
  });

  it("tolerates a malformed session rather than throwing mid-flow", () => {
    expect(deriveTravelSession(null)).toBeNull();
    expect(deriveTravelSession({})).toEqual({});
  });
});

describe("the catalogue is closed — a twin cannot name something that doesn't exist", () => {
  const referenced = new Set([
    ...Object.values(TRAVEL_TWINS),
    ...Object.values(TRAVEL_FALLBACK_BY_MUSCLE).flat(),
  ]);

  it("every referenced movement is in TRAVEL_MOVES", () => {
    expect([...referenced].filter((n) => !TRAVEL_MOVES[n])).toEqual([]);
  });

  it("every referenced movement has CURATED anatomy, not a pattern guess", () => {
    // Travel volume feeds the same audit as barbell volume. A movement that
    // only resolves by pattern lands its sets somewhere plausible rather than
    // somewhere true — which is the one thing the audit may not do.
    expect([...referenced].filter((n) => !EXERCISE_ANATOMY[n])).toEqual([]);
  });

  it("every native movement resolves anatomy too", () => {
    expect([...TRAVEL_NATIVE].filter((n) => !getAnatomy(n))).toEqual([]);
  });

  it("every A/B/C default slot has an explicit twin or already travels", () => {
    // The fallback exists for rotation picks, not for the template itself —
    // the default session is the one we hand-tune.
    const uncovered = SESSIONS.flatMap(slotsOf)
      .map((e) => e.name)
      .filter((n) => !TRAVEL_TWINS[n] && !TRAVEL_NATIVE.has(n));
    expect(uncovered).toEqual([]);
  });
});

describe("the progression engine never takes a prescription from a travel session", () => {
  // The specific danger: travel keeps the NAME of any movement that already
  // travels, so a bodyweight "Bulgarian Split Squat" logged at null weight
  // sits in history next to loaded ones. Without the guards, that reads as
  // the newest evidence for the lift and the engine prescribes down from it —
  // a user who trained honestly on holiday comes home to a wrecked barbell
  // prescription. These lock both funnels.
  const rec = (id, { travel = false, weight = 100 } = {}) => ({
    id, date: id.slice(0, 10), readiness: "normal",
    ...(travel ? { travel: true } : {}),
    blocks: [{ type: "main", exercises: [{
      name: "Bulgarian Split Squat",
      sets: [{ weight, reps: 8, rir: 2 }],
    }] }],
  });

  it("findMostRecentLiftSession looks past a travel record to the last real one", () => {
    const history = [rec("2026-08-01T10:00:00.000Z", { weight: 100 })];
    const found = () => __test__.findMostRecentLiftSession(history, "Bulgarian Split Squat");
    expect(found().exercise.sets[0].weight).toBe(100);

    history.push(rec("2026-08-03T10:00:00.000Z", { travel: true, weight: null }));
    expect(found().exercise.sets[0].weight).toBe(100);   // still the gym session
    expect(found().session.travel).toBeUndefined();
  });

  it("a travel record is not newer evidence for a lift", () => {
    const history = [
      rec("2026-08-01T10:00:00.000Z"),
      rec("2026-08-03T10:00:00.000Z", { travel: true, weight: null }),
    ];
    expect(isLatestSessionForLift(history, "2026-08-01T10:00:00.000Z", "Bulgarian Split Squat")).toBe(true);
  });

  it("a real later session still counts as newer evidence — the guard is narrow", () => {
    const history = [
      rec("2026-08-01T10:00:00.000Z"),
      rec("2026-08-03T10:00:00.000Z"),
    ];
    expect(isLatestSessionForLift(history, "2026-08-01T10:00:00.000Z", "Bulgarian Split Squat")).toBe(false);
  });

  it("the engine's per-exercise application is skipped for travel records", () => {
    const src = readFileSync(resolve(root, "lib/session-engine.js"), "utf8");
    expect(src).toContain("sessionRecord.travel === true");
    expect(src).toMatch(/isTravel \? \[\] : sessionRecord\.blocks/);
    // Volume still runs — travel training counts in the Lab.
    expect(src).toContain("TS.updateVolume");
  });
});

describe("the travel flag on the record", () => {
  it("is stamped only when asked, and never as an explicit false", () => {
    // Pre-travel records have no such field. Storing `travel: false` on every
    // new record would bloat the sync payload for a flag that reads the same
    // as absent, so the draft carries it only when true.
    const on  = newDraftLog({ profileName: "t", session: "strength-a", blockNumber: 1, readiness: "normal", travel: true });
    const off = newDraftLog({ profileName: "t", session: "strength-a", blockNumber: 1, readiness: "normal" });
    expect(on.travel).toBe(true);
    expect(off.travel).toBeUndefined();
    expect(finaliseDraft(on).travel).toBe(true);
  });

  it("is a registered profile suffix, so a wipe clears it", () => {
    expect(PROFILE_SUFFIXES.has("travel")).toBe(true);
  });

  it("is device-local — it must never ride the sync payload", () => {
    // Travel describes where the DEVICE is, not who the user is. Syncing it
    // would put the phone left at home into travel mode.
    const src = readFileSync(resolve(root, "lib/storage.js"), "utf8");
    const payload = src.slice(src.indexOf("getLocalProfile"), src.indexOf("getLocalProfile") + 4000);
    expect(payload).not.toMatch(/:travel`/);
  });
});
