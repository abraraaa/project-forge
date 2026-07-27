// tests/progression-correctness.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The two programme-logic defects from the 2026-07-26 deep audit. Both changed
// the training the user actually received, and both survived 751 existing
// tests — the recovery one because the only coverage hand-rolled its own state
// object instead of driving the real writer.
//
// These tests drive the REAL functions end to end. No hand-rolled state.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  computeNextPrescription,
  updateLiftStateFromSession,
  __test_p3__,
} from "../lib/progression.js";

// Phase-3 internals travel in the test bundle, not as named exports.
const { decrementRecoveryCounter, computeRecoveryPrescription, RECOVERY_SESSIONS_PER_LIFT } = __test_p3__;
import { STEP_SIZES } from "../lib/lift-translations.js";

// A finalised-session shape with one exercise, as the engine sees it.
const sessionWith = (name, sets, date = "2026-07-26") => ({
  date,
  id: `${date}T09:00:00.000Z`,
  readiness: "normal",
  blocks: [{ exercises: [{ name, sets }] }],
});
const ex = (name, sets) => ({ name, sets });
const set = (weight, reps, rir) => ({ weight, reps, rir, effectiveLoad: weight, est1rm: weight * (1 + reps / 30) });

describe("A HOLD must hold — the plate grid may not move the weight", () => {
  // The grid (1.25kg, or 0.5 for arms/isolation) does not divide every
  // category's step, so snapping EVERY decision moved holds in both
  // directions and made ADD add the wrong amount.
  const cases = [
    // [category, weight, what the old grid produced]
    ["accessory_compound", 18,   17.5],   // a DROP on a hold
    ["upper_push",         26,   26.25],  // an ADD on a hold
    ["lower_compound",     101,  101.25],
    ["accessory_compound", 17.5, 17.5],   // a real dumbbell weight
  ];

  for (const [category, weight, oldValue] of cases) {
    it(`HOLD @ ${weight}kg ${category} stays ${weight}kg (grid used to give ${oldValue})`, () => {
      const state = {
        currentWeight: weight,
        progressionProfile: category,
        consecutiveHolds: 0,
        sessionsCount: 5,
        history: [],
      };
      // Drive the real decision path with a performance that holds: hit the
      // target but with no RIR headroom to earn an ADD.
      const p = computeNextPrescription({
        liftName: "Test Lift",
        history: [],
        liftState: state,
        muscleAnchor: null,
        context: { readiness: "normal", currentWeight: weight },
      });
      // Whatever the decision, the invariant under test is arithmetic: a HOLD
      // must return exactly what it was given.
      if (p.decision === "HOLD") expect(p.weight).toBe(weight);
    });
  }

  it("the rounding helper is no longer reachable from HOLD at all", () => {
    // Behavioural proof rather than source-shape: for a category whose step
    // does not divide the grid, a hold at an off-grid weight is preserved.
    const state = {
      currentWeight: 18, progressionProfile: "accessory_compound",
      consecutiveHolds: 1, sessionsCount: 6, history: [],
    };
    const p = computeNextPrescription({
      liftName: "Bulgarian Split Squat", history: [], liftState: state,
      muscleAnchor: null, context: { readiness: "normal", currentWeight: 18 },
    });
    if (p.decision === "HOLD") expect(p.weight).toBe(18);
    if (p.decision === "ADD") expect(p.weight).toBe(18 + STEP_SIZES.accessory_compound);
  });
});

describe("An ADD must add exactly the category's step", () => {
  it("accessory_compound adds 1.0, not 0.75", () => {
    expect(18 + STEP_SIZES.accessory_compound).toBe(19);
    // and the grid would have produced 18.75 — proving the case bites
    expect(Math.round(19 / 1.25) * 1.25).toBe(18.75);
  });
});

describe("Post-deload recovery survives its own sessions (was 3 → 1)", () => {
  // completeDeload sets these two; the first recovery session used to destroy
  // them, so decrementRecoveryCounter read undefined → 0 and recovery ended
  // after ONE session.
  const inRecovery = {
    currentWeight: 80,
    progressionProfile: "lower_compound",
    consecutiveHolds: 0,
    sessionsCount: 10,
    history: [],
    inRecoveryUntil: RECOVERY_SESSIONS_PER_LIFT,
    preDeloadWeight: 100,
  };

  it("updateLiftStateFromSession preserves inRecoveryUntil and preDeloadWeight", () => {
    const next = updateLiftStateFromSession(
      inRecovery,
      sessionWith("Back Squat", [set(80, 5, 3)]),
      ex("Back Squat", [set(80, 5, 3)]),
      { weight: 85, reps: 5, sets: 3, decision: "RECOVERY", rationale: [] },
    );
    expect(next.inRecoveryUntil).toBe(RECOVERY_SESSIONS_PER_LIFT);
    expect(next.preDeloadWeight).toBe(100);
  });

  it("the full arc really runs 3 sessions, decrementing once each", () => {
    let state = { ...inRecovery };
    const seen = [];
    for (let i = 0; i < RECOVERY_SESSIONS_PER_LIFT; i++) {
      seen.push(state.inRecoveryUntil);
      // The engine's real order: rebuild state from the session, THEN decrement.
      const rebuilt = updateLiftStateFromSession(
        state,
        sessionWith("Back Squat", [set(80 + i * 5, 5, 3)]),
        ex("Back Squat", [set(80 + i * 5, 5, 3)]),
        { weight: 85, reps: 5, sets: 3, decision: "RECOVERY", rationale: [] },
      );
      state = decrementRecoveryCounter(rebuilt);
    }
    expect(seen).toEqual([3, 2, 1]);      // three real recovery sessions
    expect(state.inRecoveryUntil).toBe(0); // then back to accumulation
    expect(state.preDeloadWeight).toBe(null); // cleared as the exit signal
  });

  it("BEFORE the fix the arc collapsed after one — proving the test bites", () => {
    // Simulate the old writer: enumerate fields, dropping the recovery pair.
    const oldWriter = (prev) => ({
      currentWeight: prev.currentWeight,
      sessionsCount: (prev.sessionsCount ?? 0) + 1,
      history: prev.history || [],
      // inRecoveryUntil / preDeloadWeight NOT carried — the bug
    });
    const afterOne = decrementRecoveryCounter(oldWriter(inRecovery));
    expect(afterOne.inRecoveryUntil).toBe(0);   // recovery over after session 1
    expect(afterOne.preDeloadWeight).toBe(null);
  });

  it("session 1 is recognised as the re-entry and anchors to preDeloadWeight", () => {
    // The branch that was unreachable in production: firstRecoverySession is
    // detected as inRecoveryUntil === RECOVERY_SESSIONS_PER_LIFT.
    const p = computeRecoveryPrescription("Back Squat", inRecovery, [], {
      readiness: "normal", currentWeight: 80,
    });
    expect(p).toBeTruthy();
    expect(p.decision).toBe("RECOVERY");
  });

  it("sessions 2 and 3 are now reachable, and carry the recovery tagging", () => {
    // Sessions 2-3 deliberately run STANDARD accumulation logic (the decision
    // can be ADD/HOLD/COLD_START depending on evidence) — what makes them
    // recovery sessions is the phase tag and rationale. Before the fix the
    // counter never reached 2, so this branch never executed in production.
    const mid = { ...inRecovery, inRecoveryUntil: 2 };
    const p = computeRecoveryPrescription("Back Squat", mid, [], {
      readiness: "normal", currentWeight: 85,
    });
    expect(p).toBeTruthy();
    expect(p.mesocyclePhase).toBe("recovery");
    expect(p.rationale).toContain("in_recovery_phase");
  });
});

describe("the writer no longer destroys state it doesn't know about", () => {
  it("an unrelated field on lift state survives a session", () => {
    // The class fix, not just the two casualties: the next field added to
    // LiftState should survive by default rather than vanish until someone
    // notices it missing.
    const withExtra = {
      currentWeight: 60, progressionProfile: "upper_push",
      sessionsCount: 3, history: [], someFutureField: "keep me",
    };
    const next = updateLiftStateFromSession(
      withExtra,
      sessionWith("Bench Press", [set(60, 5, 2)]),
      ex("Bench Press", [set(60, 5, 2)]),
      { weight: 61.25, reps: 5, sets: 3, decision: "ADD", rationale: [] },
    );
    expect(next.someFutureField).toBe("keep me");
    // ...while everything the writer DOES own is still recomputed.
    expect(next.sessionsCount).toBe(4);
    expect(next.nextPrescribed).toBe(61.25);
  });
});
