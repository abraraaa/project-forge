// @ts-check
// lib/session-engine.js
// ─────────────────────────────────────────────────────────────────────────────
// THE session-finalise engine (audit #16). This ~120-line choreography lived
// twice — SessionHost's live finishSession and ForgeApp's retro-log path —
// and had already drifted once (the retro side grew the isLatestForLift
// guard the live side lacked). Per the house rule (third fix in the same
// territory → name the system), the system is: ONE function that takes a
// just-appended session record and applies it to the progression engine.
//
// The retro guard GENERALISES the live path rather than forking it: a live
// record's id is a fresh creation instant, so isLatestSessionForLift is
// vacuously true and the guard is a no-op there — one code path, both flows.
//
// What this does, in order:
//   1. Deload auto-close if this record crosses the threshold.
//   2. Per exercise: reconcile lift state → compute the next prescription
//      (deload / recovery / standard) → apply it to TS (with the older-
//      backfill guard: records that sort before the newest evidence join
//      history but never regress lift state) → update muscle anchors.
//   3. Recompute volume aggregates.
//
// UI mirrors stay with the CALLERS — this module owns engine state, not
// React state. Callers read the returned summary and mirror what they need
// (wwUpdates → setWW, justCompletedDeload → the celebration sheet, …).
// ─────────────────────────────────────────────────────────────────────────────

import { H, TS } from "./storage.js";
import {
  computeNextPrescription, computeDeloadPrescription, computeRecoveryPrescription,
  updateLiftStateFromSession, updateMuscleAnchorFromSession,
  reconcileLiftStateWithSession, completeDeload, shouldAutoCompleteDeload,
  decrementRecoveryCounter, isLatestSessionForLift,
} from "./progression.js";
import { getLiftProfile } from "./lift-translations.js";
import { computeVolumeAggregates } from "./analytics.js";

/**
 * Apply a just-appended session record to the progression engine.
 * @param {string} profile
 * @param {object} sessionRecord  the finalised record (already in H)
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.currentWeights]  the caller's working
 *   weights, used as prescription context ahead of the record's own top set
 * @returns {{ wwUpdates: Record<string, number>, justCompletedDeload: boolean,
 *             stillInDeload: boolean }}
 */
export function applySessionToEngine(profile, sessionRecord, { currentWeights = {} } = {}) {
  const summary = { wwUpdates: {}, justCompletedDeload: false, stillInDeload: false };
  if (!profile || !sessionRecord) return summary;

  try {
    const fullHistory = H.get(profile);
    let trainingState = TS.get(profile);

    // 1 — deload auto-close (applies to retro records crossing the
    // threshold too; edge case but correct).
    const wasInDeload = !!trainingState.mesocycle?.activeDeload;
    if (wasInDeload && shouldAutoCompleteDeload(trainingState, sessionRecord.date)) {
      trainingState = completeDeload(trainingState);
      TS.replaceState(profile, trainingState);
      summary.justCompletedDeload = true;
    }
    const stillInDeload = !summary.justCompletedDeload && wasInDeload;
    summary.stillInDeload = stillInDeload;

    // 2 — per-exercise engine application.
    for (const blk of sessionRecord.blocks || []) {
      for (const ex of blk.exercises || []) {
        // Older-backfill guard: a retro record can sort before the newest
        // evidence for this lift — it joins history but must not regress
        // lift state (currentWeight to a week-old top set, counters out of
        // order). Live records are always latest (fresh creation-instant
        // ids), so this is a no-op on the live path.
        const isLatestForLift = isLatestSessionForLift(fullHistory, sessionRecord.id, ex.name);

        const rawLiftState = trainingState.lifts?.[ex.name] || null;
        const liftState = isLatestForLift
          ? reconcileLiftStateWithSession(rawLiftState, ex)
          : rawLiftState;
        const liftProfile = getLiftProfile(ex.name);
        const anchorMuscle = liftProfile.primaryMuscle;
        const muscleAnchor = anchorMuscle
          ? trainingState.muscleAnchors?.[anchorMuscle] || null
          : null;

        let prescription;
        const context = {
          readiness: sessionRecord.readiness,
          currentWeight: currentWeights[ex.name] ?? ex.sets?.[0]?.weight ?? null,
        };
        if (stillInDeload) {
          prescription = computeDeloadPrescription(ex.name, liftState, context);
        } else if (liftState?.inRecoveryUntil > 0) {
          // Includes the auto-close session: completeDeload just set
          // inRecoveryUntil, so the NEXT session gets the pre-deload-
          // anchored re-entry; the decrement below stays skipped for it.
          prescription = computeRecoveryPrescription(ex.name, liftState, fullHistory, context);
        } else {
          prescription = computeNextPrescription({
            liftName: ex.name,
            history: fullHistory,
            liftState,
            muscleAnchor,
            context,
          });
        }

        if (prescription.weight !== null && prescription.weight !== undefined) {
          summary.wwUpdates[ex.name] = prescription.weight;
        }

        if (!isLatestForLift) {
          // History has the record; lift state stays anchored to the newer
          // live evidence.
        } else if (stillInDeload && liftState) {
          TS.updateLift(profile, ex.name, {
            ...liftState,
            history: [...(liftState.history || []), {
              date: sessionRecord.date,
              weight: ex.sets?.[0]?.weight ?? null,
              effectiveLoad: ex.sets?.[0]?.effectiveLoad ?? null,
              reps: ex.sets?.[0]?.reps ?? null,
              rir: ex.sets?.[0]?.rir ?? null,
              est1rm: null,
              decision: "DELOAD",
              rationale: ["deload_session_logged"],
            }].slice(-12),
          });
        } else {
          const newLiftState = updateLiftStateFromSession(liftState, sessionRecord, ex, prescription);
          const counterAdjusted = (liftState?.inRecoveryUntil > 0 && !summary.justCompletedDeload)
            ? decrementRecoveryCounter(newLiftState)
            : newLiftState;
          TS.updateLift(profile, ex.name, counterAdjusted);
        }

        if (isLatestForLift && anchorMuscle && liftProfile.progressesByLoad && !stillInDeload) {
          const currentAnchor = TS.get(profile).muscleAnchors?.[anchorMuscle] || null;
          const newAnchor = updateMuscleAnchorFromSession(currentAnchor, sessionRecord, ex);
          if (newAnchor) TS.updateMuscleAnchor(profile, anchorMuscle, newAnchor);
        }
      }
    }
  } catch (e) {
    console.error("[forge:session-engine]", e);
  }

  // 3 — volume aggregates (own try: a volume failure must not look like a
  // progression failure, matching the old separate-block behaviour).
  try {
    TS.updateVolume(profile, computeVolumeAggregates(H.get(profile)));
  } catch (e) {
    console.error("[forge:volume-tracking]", e);
  }

  return summary;
}
