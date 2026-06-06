// tests/progression.test.js
// ────────────────────────────────────────────────────────────────────────────
// Unit tests for the progression engine. The engine is the single most
// load-bearing piece of business logic in Forge — a regression here silently
// rolls back user progression for weeks before anyone notices.
//
// Coverage focus:
//   1. Cold start — first session, no history, no anchor; fallback to anchor
//   2. Decision tree — each ADD/HOLD/DROP path with realistic preconditions
//   3. RIR thresholds per category — power vs lower vs accessory vs isolation
//   4. Cooked override — readiness=cooked must never trigger ADD
//   5. State transitions — updateLiftStateFromSession produces expected shape
//   6. Phase 3 — deload signal detection, prescription scaling, recovery
//   7. Edge cases — null history, missing fields, parse failures
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  computeNextPrescription,
  updateLiftStateFromSession,
  reconcileLiftStateWithSession,
  // Phase 3
  detectDeloadSignals,
  shouldOfferDeload,
  computeDeloadPrescription,
  computeRecoveryPrescription,
  startDeload,
  completeDeload,
  dismissDeloadOffer,
  decrementRecoveryCounter,
  shouldAutoCompleteDeload,
  deloadCardCopy,
  deloadDayLabel,
  __test__,
  __test_p3__,
} from "../lib/progression.js";
import { startingWeightForLift, roundToHalfPlate } from "../lib/storage.js";
import {
  coldStartFromAnchor, sanitiseWorkingWeights, CATEGORY_COLD_START_MAX_KG,
} from "../lib/lift-translations.js";

// ─── Test helpers ───────────────────────────────────────────────────────────
function buildSet({ weight = 100, reps = 5, rir = 2, effectiveLoad = null, volume = null }) {
  return {
    weight,
    reps,
    rir,
    effectiveLoad: effectiveLoad ?? weight,
    volume: volume ?? weight * reps,
  };
}

function buildExercise({ name = "Barbell Back Squat", sets = [buildSet({})], muscle = "Quadriceps", prescribed = null }) {
  // prescribed is required by evaluatePerformance to know the target reps;
  // if not provided, we infer from the first set so tests of "user hit reps"
  // work without ceremony. Tests of "user missed reps" must pass prescribed
  // explicitly so the engine knows what was being aimed for.
  const inferredPrescribed = prescribed || {
    sets: sets.length,
    reps: sets[0]?.reps ?? 5,
    weight: sets[0]?.weight ?? null,
  };
  return {
    name,
    muscle,
    sets,
    prescribed: inferredPrescribed,
    summary: {
      totalVolume: sets.reduce((s, x) => s + (x.volume || 0), 0),
      topSet: sets[0],
    },
  };
}

function buildSession({
  id = "2026-04-27T10:00:00.000Z",
  date = "2026-04-27",
  readiness = "normal",
  exercises = [buildExercise({})],
  retrospective = false,
}) {
  return {
    v: 2,
    id,
    date,
    readiness,
    retrospective,
    blocks: [{ id: "a1", type: "main", exercises }],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Cold start — first session, no history
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — cold start", () => {
  it("returns COLD_START when no history and no liftState", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [],
      liftState: null,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 60 },
    });
    expect(result.decision).toBe("COLD_START");
    expect(result.weight).toBe(60); // fall back to currentWeight
  });

  it("uses muscleAnchor for cold start when anchor lift is known", () => {
    const result = computeNextPrescription({
      liftName: "Pec Deck",
      history: [],
      liftState: null,
      muscleAnchor: { bestE1RM: 95, bestE1RMLift: "Barbell Bench Press" },
      context: { readiness: "normal", currentWeight: null },
    });
    // Pec Deck factor 0.25, applied to 75% of e1RM (~71kg) = 17.8 → rounds to ~18
    expect(result.weight).toBeGreaterThan(15);
    expect(result.weight).toBeLessThan(22);
    expect(result.decision).toBe("COLD_START");
  });

  it("returns currentWeight when neither history nor anchor available", () => {
    const result = computeNextPrescription({
      liftName: "Random New Lift",
      history: [],
      liftState: null,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 40 },
    });
    expect(result.weight).toBe(40);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Decision tree — ADD / HOLD / DROP with realistic preconditions
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — decision tree", () => {
  // Helper to construct lift state representing a recent successful session
  const buildLiftState = ({ currentWeight = 100, prescribedReps = 5, prescribedSets = 3, e1RM = 117 }) => ({
    currentWeight,
    currentRepRange: { reps: prescribedReps, sets: prescribedSets },
    bestE1RM: e1RM,
    consecutiveHolds: 0,
    stallSignal: null,
    history: [],
  });

  it("ADDs when user hits all reps with RIR >= category threshold (lower compound)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 3 })], // RIR 3 — clearly more in tank
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("ADD");
    expect(result.weight).toBe(102.5); // +2.5 for lower_compound
  });

  it("HOLDs when user hits reps but at RIR 1 (close to limit)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 1 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
    expect(result.weight).toBe(100);
  });

  it("HOLDs when user hits reps at RIR 0 (max effort)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 0 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
  });

  it("HOLDs when user missed by 1 rep (light miss)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 4, rir: 0 })], // prescribed 5, hit 4
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
  });

  it("DROP_5 when user missed by 2 reps (moderate miss)", () => {
    // Prescribed: 3 sets of 5 = 15 reps target. User did 1 set of 3 = 3 reps,
    // missed 2 sets entirely. totalShortfall = 2 + 5 + 5 = 12, ratio = 0.80.
    // BUT > 0.30 → MISSED_HEAVY → DROP_10. So a single set of 3 reps is too
    // sparse for MISSED_MODERATE. Need 3 sets, each missing slightly.
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 4, rir: 0 }), // missed by 1
          buildSet({ weight: 100, reps: 4, rir: 0 }), // missed by 1
          buildSet({ weight: 100, reps: 3, rir: 0 }), // missed by 2 — total 4
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("DROP_5");
    expect(result.weight).toBe(95); // 100 × 0.95 → 95kg
  });

  it("DROP_10 when user missed badly (heavy miss)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 2, rir: 0 }), // -3
          buildSet({ weight: 100, reps: 1, rir: 0 }), // -4
          buildSet({ weight: 100, reps: 0, rir: 0 }), // -5 → totalShortfall=12, ratio=0.80
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("DROP_10");
    expect(result.weight).toBe(90); // 100 × 0.90
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Category-specific RIR thresholds
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — category thresholds", () => {
  it("Power Clean requires RIR >= 3 to ADD (power category)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Power Clean",
        muscle: "Full body / explosive",
        sets: [buildSet({ weight: 60, reps: 3, rir: 2 })], // RIR 2 — would ADD for compound, not for power
      })],
    });
    const result = computeNextPrescription({
      liftName: "Power Clean",
      history: [lastSession],
      liftState: { currentWeight: 60, currentRepRange: { reps: 3, sets: 3 }, bestE1RM: 70, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 60 },
    });
    expect(result.decision).toBe("HOLD"); // not enough margin for power
  });

  it("Power Clean ADDs at RIR 3", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Power Clean",
        muscle: "Full body / explosive",
        sets: [buildSet({ weight: 60, reps: 3, rir: 3 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Power Clean",
      history: [lastSession],
      liftState: { currentWeight: 60, currentRepRange: { reps: 3, sets: 3 }, bestE1RM: 70, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 60 },
    });
    expect(result.decision).toBe("ADD");
    expect(result.weight).toBe(62.5); // +2.5 for power
  });

  it("Lateral Raise (isolation) ADDs by 0.5kg", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Lateral Raise",
        muscle: "Side delts",
        sets: [buildSet({ weight: 10, reps: 12, rir: 2 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Lateral Raise",
      history: [lastSession],
      liftState: { currentWeight: 10, currentRepRange: { reps: 12, sets: 3 }, bestE1RM: 12, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 10 },
    });
    expect(result.decision).toBe("ADD");
    expect(result.weight).toBe(10.5); // +0.5 for isolation
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Cooked override — readiness="cooked" must never ADD
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — cooked override", () => {
  // The cooked override is conservative-by-design: a cooked session is
  // assumed to not reflect the user's true performance, so the engine
  // falls back to HOLD regardless of what numbers were logged. Two effects:
  //   1. Cooked sessions don't trigger ADD even on great numbers
  //   2. Cooked sessions don't trigger DROP on bad numbers either
  // The latter is debatable — a user who's cooked AND missing reps is
  // arguably in trouble — but the current contract is "cooked = ignore
  // performance, hold steady." This test locks in that contract.

  it("HOLDs when readiness=cooked, even with full reps + good RIR", () => {
    // Note: `findMostRecentLiftSession` skips cooked sessions when looking
    // for last performance. So a cooked session in history is invisible to
    // the next prescription's lookback. To test the cooked override we need
    // a CLEAN session in history + context.readiness="cooked" passed in.
    const cleanSession = buildSession({
      readiness: "normal",
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 3 })],
        prescribed: { sets: 1, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [cleanSession],
      liftState: { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "cooked", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
    expect(result.weight).toBe(100);
    // Engine writes "decision_reason=readiness_cooked" into rationale
    expect(result.rationale.some(r => r.includes("readiness_cooked"))).toBe(true);
  });

  it("HOLDs (does NOT drop) even when last session shows missed reps if context=cooked", () => {
    // Documents that the cooked override blocks drops too — a deliberate
    // contract choice. If you want this to drop instead, that's a real
    // engine change to discuss separately.
    const lastSession = buildSession({
      readiness: "normal",
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 2, rir: 0 }),
          buildSet({ weight: 100, reps: 1, rir: 0 }),
          buildSet({ weight: 100, reps: 0, rir: 0 }),
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "cooked", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD"); // cooked wins — no drop
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. State transitions — updateLiftStateFromSession
// ────────────────────────────────────────────────────────────────────────────
describe("updateLiftStateFromSession", () => {
  it("returns a new liftState with appended history entry, currentWeight tracks what was performed", () => {
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: [] };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 102.5, reps: 5, sets: 3, rir: 2, decision: "ADD", rationale: ["full_reps_with_margin"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    // currentWeight reflects what was JUST lifted in the session (100kg), not the
    // prescription for next time (102.5kg). The "next prescription" lives in
    // ForgeApp's workingWeights map, separately. This separation matters because
    // the engine reads currentWeight as "user's current strength" not "next target".
    expect(next.currentWeight).toBe(100);
    expect(next.history).toHaveLength(1);
    expect(next.history[0].decision).toBe("ADD");
    expect(next.consecutiveHolds).toBe(0);
  });

  it("increments consecutiveHolds on HOLD decision", () => {
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 1, stallSignal: null, history: [] };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 100, reps: 5, sets: 3, rir: 2, decision: "HOLD", rationale: ["rir_too_low"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    expect(next.consecutiveHolds).toBe(2);
  });

  it("sets stallSignal=stall after 3+ consecutive holds", () => {
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 2, stallSignal: null, history: [] };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 100, reps: 5, sets: 3, rir: 2, decision: "HOLD", rationale: ["rir_too_low"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    expect(next.consecutiveHolds).toBe(3);
    expect(next.stallSignal).toBe("stall");
  });

  it("caps history at 12 entries (rolling window)", () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ date: `2026-04-${i+1}`, decision: "HOLD" }));
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: long };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 102.5, reps: 5, sets: 3, rir: 2, decision: "ADD", rationale: ["full_reps_with_margin"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    expect(next.history).toHaveLength(12); // capped
    expect(next.history[11].decision).toBe("ADD"); // newest at end
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Phase 3 — Deload signals
// ────────────────────────────────────────────────────────────────────────────
describe("Phase 3 — detectDeloadSignals", () => {
  it("returns empty array on fresh state", () => {
    expect(detectDeloadSignals({ lifts: {}, mesocycle: {} }, [])).toEqual([]);
  });

  it("detects stall convergence when 2+ lifts are stalled", () => {
    const ts = {
      lifts: {
        "Squat": { stallSignal: "stall" },
        "Bench": { stallSignal: "stall" },
      },
      mesocycle: { deloadSignals: {} },
    };
    const sigs = detectDeloadSignals(ts, []);
    expect(sigs.length).toBe(1);
    expect(sigs[0].type).toBe("stall_convergence");
  });

  it("detects deep_stall on a single lift with 4+ holds", () => {
    const ts = {
      lifts: {
        "Squat": { stallSignal: "deep_stall", consecutiveHolds: 4 },
      },
      mesocycle: { deloadSignals: {} },
    };
    const sigs = detectDeloadSignals(ts, []);
    expect(sigs.length).toBe(1);
    expect(sigs[0].type).toBe("deep_stall");
  });
});

describe("Phase 3 — shouldOfferDeload cooldowns", () => {
  it("respects 14-day cooldown after completion", () => {
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const ts = {
      lifts: { "Squat": { stallSignal: "stall" }, "Bench": { stallSignal: "stall" } },
      mesocycle: { deloadSignals: { lastDeloadCompletedAt: recent } },
    };
    expect(shouldOfferDeload(ts, [])).toBe(null); // within cooldown
  });

  it("respects 5-day cooldown after dismiss", () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const ts = {
      lifts: { "Squat": { stallSignal: "stall" }, "Bench": { stallSignal: "stall" } },
      mesocycle: { deloadSignals: { lastOfferDismissedAt: recent } },
    };
    expect(shouldOfferDeload(ts, [])).toBe(null);
  });

  it("returns signal when cooldowns expired AND signals present", () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ts = {
      lifts: { "Squat": { stallSignal: "stall" }, "Bench": { stallSignal: "stall" } },
      mesocycle: { deloadSignals: { lastDeloadCompletedAt: old } },
    };
    expect(shouldOfferDeload(ts, [])).not.toBe(null);
  });
});

describe("Phase 3 — computeDeloadPrescription", () => {
  it("scales main lift to 65% with 2 sets", () => {
    const result = computeDeloadPrescription("Barbell Back Squat", {
      currentWeight: 100,
      currentRepRange: { reps: 5, sets: 3 },
    }, {});
    expect(result.weight).toBe(65);
    expect(result.sets).toBe(2);
    expect(result.decision).toBe("DELOAD");
  });

  it("scales accessory to 70% with 2 sets", () => {
    const result = computeDeloadPrescription("Lateral Raise", {
      currentWeight: 10,
      currentRepRange: { reps: 12, sets: 3 },
    }, {});
    expect(result.weight).toBe(7);
    expect(result.sets).toBe(2);
  });

  it("scales power lift to 60% (rounds to nearest 1.25kg plate)", () => {
    const result = computeDeloadPrescription("Power Clean", {
      currentWeight: 60,
      currentRepRange: { reps: 3, sets: 3 },
    }, {});
    // 60 × 0.60 = 36.0, rounds to nearest 1.25 plate → 36.25kg.
    // The 1.25kg increment is correct: deload weights still need to be loadable.
    expect(result.weight).toBe(36.25);
  });
});

describe("Phase 3 — startDeload + completeDeload + dismissDeloadOffer", () => {
  it("startDeload creates activeDeload subtree, snapshots preDeloadWeights map", () => {
    const ts = {
      lifts: { "Squat": { currentWeight: 100, stallSignal: "stall" } },
      mesocycle: { deloadSignals: {} },
    };
    const signal = { type: "stall_convergence", detectedAt: new Date().toISOString(), severity: 0.7 };
    const next = startDeload(ts, signal);
    expect(next.mesocycle.activeDeload).toBeTruthy();
    expect(next.mesocycle.activeDeload.plannedDays).toBe(5);
    // preDeloadWeights is a map keyed by lift name on the mesocycle subtree,
    // NOT a per-lift field. This is so completeDeload() can rebuild from a
    // single source rather than walking every lift's individual snapshot.
    expect(next.mesocycle.activeDeload.preDeloadWeights.Squat).toBe(100);
  });

  it("completeDeload clears activeDeload and sets inRecoveryUntil per lift", () => {
    const ts = {
      lifts: { "Squat": { currentWeight: 65, preDeloadWeight: 100, stallSignal: "stall" } },
      mesocycle: { activeDeload: { startedAt: "x", plannedDays: 5 }, deloadSignals: {} },
    };
    const next = completeDeload(ts);
    expect(next.mesocycle.activeDeload).toBe(null);
    expect(next.mesocycle.deloadSignals.lastDeloadCompletedAt).toBeTruthy();
    expect(next.lifts.Squat.inRecoveryUntil).toBe(3); // 3 recovery sessions per lift
  });

  it("dismissDeloadOffer sets lastOfferDismissedAt without changing lifts", () => {
    const ts = {
      lifts: { "Squat": { currentWeight: 100 } },
      mesocycle: { deloadSignals: {} },
    };
    const next = dismissDeloadOffer(ts);
    expect(next.mesocycle.deloadSignals.lastOfferDismissedAt).toBeTruthy();
    expect(next.lifts.Squat.currentWeight).toBe(100); // untouched
  });
});

describe("Phase 3 — shouldAutoCompleteDeload", () => {
  it("returns true when current session is >= 4 days after deload start", () => {
    const ts = {
      mesocycle: {
        activeDeload: { startedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
      },
    };
    const sessionDate = new Date().toISOString().slice(0, 10);
    expect(shouldAutoCompleteDeload(ts, sessionDate)).toBe(true);
  });

  it("returns false when within the 4-day window", () => {
    const ts = {
      mesocycle: {
        activeDeload: { startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
      },
    };
    const sessionDate = new Date().toISOString().slice(0, 10);
    expect(shouldAutoCompleteDeload(ts, sessionDate)).toBe(false);
  });

  it("returns false when no active deload", () => {
    expect(shouldAutoCompleteDeload({ mesocycle: {} }, "2026-04-27")).toBe(false);
  });
});

describe("Phase 3 — computeRecoveryPrescription", () => {
  it("rebuilds at 110% of deloaded weight (rounds to nearest 1.25kg plate)", () => {
    const liftState = {
      currentWeight: 65, // deloaded
      preDeloadWeight: 100,
      currentRepRange: { reps: 5, sets: 3 },
      inRecoveryUntil: 3,
    };
    const result = computeRecoveryPrescription("Barbell Back Squat", liftState, [], {});
    // 65 × 1.10 = 71.5, rounds to nearest 1.25 plate → 71.25kg.
    expect(result.weight).toBe(71.25);
    expect(result.decision).toBe("RECOVERY");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Edge cases — defensive paths
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — edge cases", () => {
  it("handles null history gracefully", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: null,
      liftState: null,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result).toBeTruthy();
    expect(result.weight).toBe(100); // falls back to currentWeight
  });

  it("handles missing context.readiness", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [],
      liftState: null,
      muscleAnchor: null,
      context: { currentWeight: 100 },
    });
    expect(result).toBeTruthy();
  });

  it("handles undefined liftState fields without throwing", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [],
      liftState: { currentWeight: 100 }, // missing most fields
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Internal helpers (via __test__ export)
// ────────────────────────────────────────────────────────────────────────────
describe("Internal helpers (__test__)", () => {
  it("parseReps handles plain integer", () => {
    expect(__test__.parseReps(5)).toBe(5);
    expect(__test__.parseReps("8")).toBe(8);
  });

  it("parseReps handles unilateral notation", () => {
    expect(__test__.parseReps("8/leg")).toBe(8);
    expect(__test__.parseReps("10/side")).toBe(10);
  });

  it("topSetRir returns the RIR of the heaviest set", () => {
    const ex = buildExercise({
      sets: [
        buildSet({ weight: 90, reps: 5, rir: 3 }),
        buildSet({ weight: 100, reps: 5, rir: 1 }), // heaviest
        buildSet({ weight: 95, reps: 5, rir: 2 }),
      ],
    });
    expect(__test__.topSetRir(ex)).toBe(1);
  });

  it("topSetWeight returns actual performed top set, NOT max-blended with stale fallback", () => {
    // Regression test for the engine bug: previously topSetWeight did
    //   Math.max(...loads, fallbackWeight)
    // which let a stale liftState.currentWeight override what the user just
    // performed. Now actual performed loads always win; fallback is used
    // only when no loads were performed.
    const ex = buildExercise({
      sets: [
        buildSet({ weight: 80, reps: 5, rir: 1 }),
        buildSet({ weight: 80, reps: 5, rir: 1 }),
        buildSet({ weight: 80, reps: 5, rir: 1 }),
      ],
    });
    // stale fallback = 110, actual performed = 80. We expect 80.
    expect(__test__.topSetWeight(ex, 110)).toBe(80);
  });

  it("topSetWeight uses fallback only when sets are empty or all-zero", () => {
    const empty = buildExercise({ sets: [] });
    expect(__test__.topSetWeight(empty, 100)).toBe(100);

    const allZero = buildExercise({
      sets: [
        buildSet({ weight: null, reps: 5, rir: 2, effectiveLoad: 0 }),
        buildSet({ weight: null, reps: 5, rir: 2, effectiveLoad: 0 }),
      ],
    });
    expect(__test__.topSetWeight(allZero, 75)).toBe(75);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9. Engine bug — full path: stale liftState seed + in-session dial-down
//    must HOLD at the actually-performed weight, not "ADD" off the stale basis.
// ────────────────────────────────────────────────────────────────────────────
describe("Engine bug — stale liftState seed reconciliation", () => {
  it("HOLDs at performed weight when user dials DOWN in-session and grinds it out", () => {
    // Scenario: user has stale liftState.currentWeight = 110 (from old
    // hardcoded SESSIONS default before recalibration). They adjust DOWN
    // in-session to 100kg, perform 100kg × 5 at max effort (rir=0). The
    // engine MUST recognise that 100kg is the actual basis — not max-blend
    // with the stale 110 number.
    const lastSession = buildSession({
      readiness: "normal",
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 5, rir: 0 }), // max effort
          buildSet({ weight: 100, reps: 5, rir: 0 }),
          buildSet({ weight: 100, reps: 5, rir: 0 }),
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const staleLiftState = {
      currentWeight: 110,                      // stale seed
      currentRepRange: { reps: 5, sets: 3 },
      bestE1RM: 117,
      consecutiveHolds: 0,
      stallSignal: null,
      history: [],
    };
    // Reconcile (mirrors ForgeApp's finalise pipeline)
    const reconciled = reconcileLiftStateWithSession(
      staleLiftState,
      lastSession.blocks[0].exercises[0],
    );
    expect(reconciled.currentWeight).toBe(100); // reconciled to actual

    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: reconciled,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    // rir=0 grinder → HOLD; weight must be the actually-performed 100, not
    // the stale 110.
    expect(result.decision).toBe("HOLD");
    expect(result.weight).toBe(100);
  });

  it("HOLDs at performed weight when set RPE is 'hard' (rir=1) and basis was stale", () => {
    const lastSession = buildSession({
      readiness: "normal",
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 5, rir: 1 }), // hard / close to limit
          buildSet({ weight: 100, reps: 5, rir: 1 }),
          buildSet({ weight: 100, reps: 5, rir: 1 }),
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const staleLiftState = {
      currentWeight: 110,
      currentRepRange: { reps: 5, sets: 3 },
      bestE1RM: 117,
      consecutiveHolds: 0,
      stallSignal: null,
      history: [],
    };
    const reconciled = reconcileLiftStateWithSession(
      staleLiftState,
      lastSession.blocks[0].exercises[0],
    );
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: reconciled,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
    expect(result.weight).toBe(100); // not 110, not 112.5
  });

  it("reconcileLiftStateWithSession returns input untouched when nothing performed", () => {
    const liftState = { currentWeight: 100, history: [] };
    const ex = buildExercise({ sets: [] });
    expect(reconcileLiftStateWithSession(liftState, ex)).toBe(liftState);
  });

  it("reconcileLiftStateWithSession handles null liftState", () => {
    expect(reconcileLiftStateWithSession(null, buildExercise({}))).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10. Starting-weight helpers — BW% multipliers for main lifts (Task 5)
// ────────────────────────────────────────────────────────────────────────────
describe("startingWeightForLift — BW% seeded starts", () => {
  it("computes Back Squat at 0.75 × bodyweight, rounded to 2.5kg", () => {
    expect(startingWeightForLift("Barbell Back Squat", 80)).toBe(60);   // 60.0
    expect(startingWeightForLift("Barbell Back Squat", 73)).toBe(55);   // 54.75 → 55
  });

  it("computes Hex Bar Deadlift at 1.0 × bodyweight", () => {
    expect(startingWeightForLift("Hex Bar Deadlift", 80)).toBe(80);
  });

  it("computes Barbell Bench Press at 0.65 × bodyweight", () => {
    expect(startingWeightForLift("Barbell Bench Press", 80)).toBe(52.5); // 52.0 → 52.5
  });

  it("computes OHP at 0.40 × bodyweight", () => {
    expect(startingWeightForLift("Barbell Overhead Press", 80)).toBe(32.5); // 32.0 → 32.5
  });

  it("computes Power Clean at 0.50 × bodyweight", () => {
    expect(startingWeightForLift("Power Clean", 80)).toBe(40);
  });

  it("floors at 20kg (empty bar) for very light users", () => {
    expect(startingWeightForLift("Barbell Bench Press", 25)).toBe(20); // 16.25 → 20
    expect(startingWeightForLift("Barbell Overhead Press", 40)).toBe(20); // 16 → 20
  });

  it("returns null when bodyweight is null/undefined", () => {
    expect(startingWeightForLift("Barbell Back Squat", null)).toBe(null);
    expect(startingWeightForLift("Barbell Back Squat", undefined)).toBe(null);
  });

  it("returns null for non-main lifts (caller falls back to SESSIONS default)", () => {
    expect(startingWeightForLift("DB Curl", 80)).toBe(null);
    expect(startingWeightForLift("Lateral Raise", 80)).toBe(null);
    expect(startingWeightForLift("Chest-Supported DB Row", 80)).toBe(null);
  });

  it("roundToHalfPlate rounds to nearest 2.5kg", () => {
    expect(roundToHalfPlate(50)).toBe(50);
    expect(roundToHalfPlate(51)).toBe(50);
    // 51.25 is exactly halfway → JS Math.round rounds half-up → 52.5
    expect(roundToHalfPlate(51.25)).toBe(52.5);
    expect(roundToHalfPlate(52.5)).toBe(52.5);
    expect(roundToHalfPlate(53.74)).toBe(52.5);
    expect(roundToHalfPlate(53.76)).toBe(55);
  });
});

// ─── Cold-start sanity cap ──────────────────────────────────────────────────
// Real-world bug: user reported 110kg recommendation for Leaning Lateral
// Raise (an isolation movement; sensible working weight ~7-15kg). The cap
// in CATEGORY_COLD_START_MAX_KG prevents an inflated muscleAnchor from
// producing absurd cold-start recommendations.
describe("coldStartFromAnchor — sanity cap", () => {
  it("clamps absurd anchor-derived cold-start to the category cap", () => {
    // Construct a shoulder anchor that would translate to ~108kg cold-start
    // for Leaning Lateral Raise (factor 0.12): 1200 × 0.75 × 0.12 = 108.
    // The accessory_isolation cap is 25kg, so output should be ≤25.
    const inflatedAnchor = { bestE1RM: 1200, bestE1RMLift: "Phantom", bestE1RMDate: null };
    const out = coldStartFromAnchor("Leaning Lateral Raise", inflatedAnchor);
    expect(out).toBeLessThanOrEqual(CATEGORY_COLD_START_MAX_KG.accessory_isolation);
    expect(out).toBeGreaterThan(0);
  });

  it("leaves a realistic cold-start untouched", () => {
    // OHP at 60kg × 5 → e1RM 70 → for Leaning Lateral Raise (factor 0.12)
    // gives 70 × 0.75 × 0.12 = 6.3 → rounds to 6.5kg. Well under cap.
    const realisticAnchor = { bestE1RM: 70, bestE1RMLift: "Barbell Overhead Press" };
    const out = coldStartFromAnchor("Leaning Lateral Raise", realisticAnchor);
    expect(out).toBeGreaterThanOrEqual(5);
    expect(out).toBeLessThanOrEqual(10);
  });

  it("returns null for BW-progression lifts (no anchor weight)", () => {
    const anchor = { bestE1RM: 100 };
    expect(coldStartFromAnchor("Pike Push-Up", anchor)).toBeNull();
  });
});

describe("sanitiseWorkingWeights", () => {
  it("returns the input reference when nothing needs clamping", () => {
    const weights = {
      "Leaning Lateral Raise": 8,
      "Barbell Back Squat": 100,
      "Bench Press": 80,
    };
    expect(sanitiseWorkingWeights(weights)).toBe(weights);
  });

  it("clamps an obviously-corrupt isolation weight back to the cap", () => {
    const weights = { "Leaning Lateral Raise": 110 };  // ~5× cap of 25
    const out = sanitiseWorkingWeights(weights);
    expect(out).not.toBe(weights);
    expect(out["Leaning Lateral Raise"]).toBe(CATEGORY_COLD_START_MAX_KG.accessory_isolation);
  });

  it("leaves slightly-above-cap values alone (likely legitimate progression)", () => {
    // Isolation cap = 25; 1.5× buffer = 37.5. 30kg is above cap but below
    // buffer, should be preserved (a strong lifter might legitimately do
    // lateral raises at this weight).
    const weights = { "Lateral Raise": 30 };
    expect(sanitiseWorkingWeights(weights)).toBe(weights);
  });

  it("ignores BW-progression lifts (no weight cap applies)", () => {
    const weights = { "Pike Push-Up": 999 };  // nonsensical but BW has no cap
    expect(sanitiseWorkingWeights(weights)).toBe(weights);
  });

  it("ignores non-numeric or invalid entries", () => {
    const weights = { "Bench Press": null, "Lateral Raise": "twenty", "Other": Infinity };
    expect(sanitiseWorkingWeights(weights)).toBe(weights);
  });

  it("handles null/empty input safely", () => {
    expect(sanitiseWorkingWeights(null)).toBe(null);
    expect(sanitiseWorkingWeights(undefined)).toBe(undefined);
    const empty = {};
    expect(sanitiseWorkingWeights(empty)).toBe(empty);
  });
});
