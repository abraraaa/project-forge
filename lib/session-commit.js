// lib/session-commit.js
// ─────────────────────────────────────────────────────────────────────────────
// The writes that make a finished session part of the lifter's record, in the
// live finish's order. One function, so a session the client keeps from a
// trainer lands exactly as one they logged themselves.
//
// Writes, in order (all to the profile's own device stores):
//   1. H.append                 history (forge:<p>:history)
//   2. recordCompletion         the day (Days, keyed on rec.date)
//   3. applySessionToEngine     trainingState, and anything it writes
//   4. W, then R                only for lifts the engine moved, through
//                               ctx.saveWeights / ctx.saveReps when given,
//                               otherwise P.saveWeights / P.saveReps over the
//                               stored map
// Nothing is deleted, and nothing is pushed: the caller pushes, and does its
// own streak and analytics (tests/forge-app-mutation-coverage.test.js checks
// that every caller pushes).
// ─────────────────────────────────────────────────────────────────────────────

import { H, P, recordCompletion } from "./storage.js";
import { applySessionToEngine } from "./session-engine.js";

/**
 * @typedef {{ wwUpdates: Record<string, any>, wrUpdates: Record<string, any>, justCompletedDeload: boolean, stillInDeload: boolean }} EngineSummary
 */

/**
 * Save a finalised session record and run the engine on it.
 *
 * `ctx.afterHistory` runs once the record and its day are written and before
 * the engine (the live finish clears its draft there). `ctx.saveWeights` and
 * `ctx.saveReps` receive only the engine's changed lifts; the live host passes
 * its own persisting setters so its React state and the store move together.
 *
 * @param {string} profile
 * @param {any} rec  a record as finaliseDraft returns it
 * @param {{
 *   currentWeights?: Record<string, any>,
 *   repairedReps?: Record<string, any>,
 *   afterHistory?: () => void,
 *   saveWeights?: (updates: Record<string, any>) => void,
 *   saveReps?: (updates: Record<string, any>) => void,
 * }} [ctx]
 * @returns {EngineSummary}
 */
export function commitSessionRecord(profile, rec, ctx = {}) {
  H.append(profile, rec);
  // The day comes from the record, not the wall clock: a session finished
  // after midnight belongs to the day it started. (The legacy P.markDayDone
  // that once sat beside this resolved the weekday in the current week and
  // minted phantom days on a Sun→Mon straddle; all reads are Days-backed.)
  recordCompletion(profile, rec.date, {
    kind: "session",
    sessionId: rec.id,
  });
  ctx.afterHistory?.();

  const engine = applySessionToEngine(profile, rec, { currentWeights: ctx.currentWeights, repairedReps: ctx.repairedReps });
  if (Object.keys(engine.wwUpdates).length) {
    if (ctx.saveWeights) ctx.saveWeights(engine.wwUpdates);
    else P.saveWeights(profile, { ...P.getWeights(profile), ...engine.wwUpdates });
  }
  if (Object.keys(engine.wrUpdates || {}).length) {
    if (ctx.saveReps) ctx.saveReps(engine.wrUpdates);
    else P.saveReps(profile, { ...P.getReps(profile), ...engine.wrUpdates });
  }
  return engine;
}
