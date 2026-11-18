// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/session-engine.js
// ─────────────────────────────────────────────────────────────────────────────
// THE session-finalise engine: takes a just-appended session record and
// applies it to the progression engine.
//
// What it does, in order:
//   1. Deload auto-close if this record crosses the threshold.
//   2. Per exercise: reconcile lift state → compute the next prescription →
//      apply it. A cold start reads the muscle anchors derived from history
//      (deriveMuscleAnchors); the stored muscleAnchors field is never written.
//   3. Recompute volume aggregates.
//
// INVARIANTS:
//   · ONE code path for both live and retrospective logging. The guards here
//     are written to generalise, not to fork — a second copy of this
//     choreography is how the two drifted apart before.
//   · A record that sorts BEFORE the newest evidence joins history but must
//     never regress lift state.
//   · This module owns engine state, not React state. UI mirroring stays with
//     the callers, which read the returned summary.
// ─────────────────────────────────────────────────────────────────────────────

import { H, TS, P } from "./storage.js";
import {
  computeNextPrescription, computeRecoveryPrescription, deloadDayPrescription, scheduledWeight,
  updateLiftStateFromSession,
  reconcileLiftStateWithSession, completeDeload, shouldAutoCompleteDeload, endDeloadEarly, deloadDeclinedBy, deloadBaseWeight,
  decrementRecoveryCounter, isLatestSessionForLift, overrideStreakStep,
  recordCookedSession, cookedSeedWeight, RECOVERY_SESSIONS_PER_LIFT,
} from "./progression.js";
import { getLiftProfile, deriveMuscleAnchors } from "./lift-translations.js";
import { loadTypeOfName, repsForSession, isWorkingWeight } from "./programme-resolve.js";
import { computeVolumeAggregates } from "./analytics.js";
import { timedTargetFor } from "./programme.js";

export { repsForSession };

// Lifts the programme prescribes as a hold in seconds — pools, sessions AND
// swap substitutes (a swapped-in Wall Sit is timed too). A drum override
// logs whole seconds, so the record alone cannot say a lift is timed.
/** @param {string} name */
function isTimedLift(name) {
  return timedTargetFor(name) !== null;
}

// The rep-adoption streak (lib/progression.js overrideStreakStep), folded into
// the lift state about to be written. Fields are additive and only appear once
// a lift has had a streak, so a lift that never deviates keeps its old shape.
// An adoption writes the new target the way a user-set target lands: rep range
// base and reps, and the run of holds cleared so the rep climb cannot climb
// straight back past it.
function withOverrideStreak(nextState, prevState, ex, prescription, sessionRecord, timed, summary) {
  const step = overrideStreakStep(prevState, ex, prescription, { readiness: sessionRecord.readiness, timed });
  if (step.frozen) return nextState;
  const had = prevState?.overrideStreak !== undefined;
  if (step.adoptReps !== null) {
    const next = repsForSession(step.adoptReps, ex.prescribed?.reps);
    if (next === null) return nextState;
    summary.wrUpdates[ex.name] = next;
    const range = nextState.currentRepRange || {};
    return {
      ...nextState,
      currentRepRange: { ...range, reps: step.adoptReps, baseReps: step.adoptReps },
      consecutiveHolds: 0,
      stallSignal: null,
      overrideStreak: 0, overrideFirstSets: [], overrideTarget: null,
      adoptedAt: sessionRecord.date,
      adoptedReps: step.adoptReps,
    };
  }
  if (!had && step.overrideStreak === 0) return nextState;
  return {
    ...nextState,
    overrideStreak: step.overrideStreak,
    overrideFirstSets: step.overrideFirstSets,
    overrideTarget: step.overrideTarget,
  };
}

/**
 * Apply a just-appended session record to the progression engine.
 * @param {string} profile
 * @param {object} sessionRecord  the finalised record (already in H)
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.currentWeights]  the caller's working
 *   weights, used as prescription context ahead of the record's own top set
 * @param {Record<string, number|string>} [opts.repairedReps]  rep targets the
 *   session showed repaired (repTargetRepairs); persisted for each lift logged
 * @returns {{ wwUpdates: Record<string, number>, wrUpdates: Record<string, number|string>, justCompletedDeload: boolean,
 *             stillInDeload: boolean, deloadEnded: string|null }}
 */
export function applySessionToEngine(profile, sessionRecord, { currentWeights = {}, repairedReps = {} } = {}) {
  /** @type {{ wwUpdates: Record<string, number>, wrUpdates: Record<string, number|string>, justCompletedDeload: boolean, stillInDeload: boolean, deloadEnded: string|null }} */
  const summary = { wwUpdates: {}, wrUpdates: {}, justCompletedDeload: false, stillInDeload: false, deloadEnded: null };
  if (!profile || !sessionRecord) return summary;

  try {
    const fullHistory = H.get(profile);
    let trainingState = TS.get(profile);
    // Every cold start below reads the muscle anchors derived once from the
    // history without this record: a record never sizes its own cold start,
    // so an unloaded first session starts where its card did.
    const anchors = deriveMuscleAnchors(fullHistory.filter((r) => r?.id !== sessionRecord.id));
    // The stored working weights, as every reader sees them (not the caller's
    // in-session plan weights): a cooked seed goes only to a lift with none.
    const storedWeights = P.getWeights(profile);

    // 1 — deload close (applies to retro records too). A second session in a
    // row that ignored the deload ends it as declined, before the calendar
    // close; otherwise the calendar auto-close.
    const endedDeload = trainingState.mesocycle?.activeDeload || null;
    const wasInDeload = !!endedDeload;
    const preCloseLifts = trainingState.lifts || {};
    if (wasInDeload && deloadDeclinedBy(endedDeload, fullHistory, sessionRecord)) {
      summary.deloadEnded = "declined";
      trainingState = endDeloadEarly(trainingState, summary.deloadEnded);
      TS.replaceState(profile, trainingState);
    } else if (wasInDeload && shouldAutoCompleteDeload(trainingState, sessionRecord.date)) {
      trainingState = completeDeload(trainingState);
      TS.replaceState(profile, trainingState);
      summary.justCompletedDeload = true;
    }
    const stillInDeload = !summary.justCompletedDeload && !summary.deloadEnded && wasInDeload;
    summary.stillInDeload = stillInDeload;
    // Lifts judged on the standard path this session; on an early end every
    // other lift returns to its deload base (step 2b).
    /** @type {Set<string>} */
    const ordinary = new Set();

    // 2 — per-exercise engine application. SKIPPED ENTIRELY for a travel
    // session (lib/travel.js): no prescription, no lift state, and
    // deriveMuscleAnchors skips the record too. Bodyweight work away from the
    // gym is real training and counts as volume — step 3 below still runs,
    // and it recomputes from the full history — but it carries no
    // information about what to load on a bar.
    // The deload auto-close above is deliberately left running: that is a
    // calendar judgement about elapsed recovery, not a load judgement.
    const isTravel = sessionRecord.travel === true;
    for (const blk of (isTravel ? [] : sessionRecord.blocks || [])) {
      for (const ex of blk.exercises || []) {
        // Older-backfill guard: a retro record can sort before the newest
        // evidence for this lift — it joins history but must not regress
        // lift state (currentWeight to a week-old top set, counters out of
        // order). Live records are always latest (fresh creation-instant
        // ids), so this is a no-op on the live path.
        const isLatestForLift = isLatestSessionForLift(fullHistory, sessionRecord.id, ex.name);

        const loggedLoadType = ex.loadType ?? ex.sets?.find((s) => s?.loadType)?.loadType;
        // A record without a load type falls back to the catalogue's, not the
        // name's: name inference reads "Assisted Pull-Up" as belted.
        const knownLoadType = loggedLoadType ?? loadTypeOfName(ex.name);
        const rawLiftState = trainingState.lifts?.[ex.name] || null;
        const liftProfile = getLiftProfile(ex.name);

        // A cooked record is history only: no prescription from its sets, no
        // lift-state update, no rep write. It counts as a session and records
        // its e1RM. A load-progressed lift with no working weight takes the
        // session's top set as its seed, as a first session does. The deload
        // calendar still writes the weight it schedules (scheduledWeight). An
        // older backfilled cooked record writes nothing.
        if (sessionRecord.readiness === "cooked") {
          if (!isLatestForLift) continue;
          const seedable = !Number.isFinite(rawLiftState?.currentWeight) && !Number.isFinite(storedWeights[ex.name])
            && liftProfile.progressesByLoad && !isTimedLift(ex.name)
            && knownLoadType !== "bodyweight" && knownLoadType !== "assisted_bodyweight";
          const seed = seedable ? cookedSeedWeight(ex, knownLoadType) : null;
          TS.updateLift(profile, ex.name, recordCookedSession(rawLiftState, sessionRecord, ex, { seed }));
          if (seed !== null) {
            summary.wwUpdates[ex.name] = seed;
          } else {
            const due = scheduledWeight(ex.name, rawLiftState, trainingState, stillInDeload, fullHistory,
              { readiness: sessionRecord.readiness, loadType: knownLoadType, currentWeight: null, timed: isTimedLift(ex.name) });
            if (due !== null) summary.wwUpdates[ex.name] = due;
          }
          continue;
        }

        const liftState = isLatestForLift
          ? reconcileLiftStateWithSession(rawLiftState, { ...ex, loadType: knownLoadType })
          : rawLiftState;
        const anchorMuscle = liftProfile.primaryMuscle;
        const muscleAnchor = anchorMuscle ? anchors[anchorMuscle] ?? null : null;

        let prescription;
        const context = {
          readiness: sessionRecord.readiness,
          pureBodyweight: loggedLoadType === "bodyweight",
          loadType: loggedLoadType,
          currentWeight: currentWeights[ex.name] ?? ex.sets?.[0]?.weight ?? null,
          timed: isTimedLift(ex.name),
        };
        const knownContext = { ...context, loadType: knownLoadType };
        // On a declined close, a lift logged below its deload base followed
        // the deload card and is recorded as a deload day.
        const base = summary.deloadEnded === "declined" ? deloadBaseWeight(ex.name, rawLiftState, endedDeload) : null;
        const top = Math.max(-Infinity, ...(ex.sets || []).map((/** @type {any} */ s) => (Number.isFinite(s?.weight) ? s.weight : -Infinity)));
        const deloadDay = stillInDeload || (summary.deloadEnded === "declined" && !(base !== null && top >= base));
        if (deloadDay) {
          // The lift state keeps what was lifted; the deload base is the
          // pre-deload snapshot.
          prescription = deloadDayPrescription(ex.name, liftState, stillInDeload ? trainingState : { ...trainingState, mesocycle: { activeDeload: endedDeload } }, knownContext);
        } else if (liftState?.inRecoveryUntil > 0) {
          // Includes the auto-close session: completeDeload just set
          // inRecoveryUntil, so the NEXT session gets the pre-deload-
          // anchored re-entry; the decrement below stays skipped for it.
          // Any other session at the full count is the re-entry itself (its
          // card showed it, scheduledWeight), so what follows it is the
          // standard path of the later recovery sessions.
          const reentryShown = liftState.inRecoveryUntil === RECOVERY_SESSIONS_PER_LIFT && !summary.justCompletedDeload;
          const recoveryState = reentryShown ? { ...liftState, inRecoveryUntil: RECOVERY_SESSIONS_PER_LIFT - 1 } : liftState;
          prescription = computeRecoveryPrescription(ex.name, recoveryState, fullHistory, knownContext);
        } else if (rawLiftState === null && isLatestForLift) {
          // A lift's first logged session. The card's start was a cold-start
          // guess; what was lifted replaces it, so a loaded first session
          // progresses from its performed top set on the standard path.
          // State is still built from null below. A belted Pull-Up or Dip
          // seeds from its added kg like a loaded lift. Pure bodyweight,
          // assisted, timed and unloaded first sessions keep the cold start
          // (assistance kg is not load to add to); an anchor start snaps to
          // the implement.
          const firstContext = knownContext;
          const seed = reconcileLiftStateWithSession({ currentWeight: null }, { ...ex, loadType: firstContext.loadType });
          const seeded = liftProfile.progressesByLoad && !context.timed
            && firstContext.loadType !== "bodyweight" && firstContext.loadType !== "assisted_bodyweight"
            && seed.currentWeight > 0;
          prescription = computeNextPrescription({
            liftName: ex.name,
            history: fullHistory,
            liftState: seeded ? seed : null,
            muscleAnchor,
            context: firstContext,
          });
        } else {
          prescription = computeNextPrescription({
            liftName: ex.name,
            history: fullHistory,
            liftState,
            muscleAnchor,
            context: knownContext,
          });
        }

        if (prescription.weight !== null && prescription.weight !== undefined) {
          summary.wwUpdates[ex.name] = prescription.weight;
        }
        // A repaired target the session showed becomes the stored one. A rep
        // climb or adoption below is judged against it and writes over it.
        if (isLatestForLift && Object.hasOwn(repairedReps, ex.name)) {
          summary.wrUpdates[ex.name] = repairedReps[ex.name];
        }
        // A rep climb (or banking one) changes the target the session shows.
        // The shape comes from the target the session showed: the retro path
        // records it as prescribed.reps; the live path logs it on every set.
        if (prescription.repRangeChanged) {
          const next = repsForSession(prescription.reps, ex.prescribed?.reps ?? ex.sets?.[0]?.reps);
          if (next !== null) summary.wrUpdates[ex.name] = next;
        }

        if (!isLatestForLift) {
          // History has the record; lift state stays anchored to the newer
          // live evidence.
        } else if (deloadDay && liftState) {
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
          if (!deloadDay) ordinary.add(ex.name);
          const newLiftState = updateLiftStateFromSession(liftState, sessionRecord, ex, prescription);
          const counterAdjusted = (liftState?.inRecoveryUntil > 0 && !summary.justCompletedDeload)
            ? decrementRecoveryCounter(newLiftState)
            : newLiftState;
          TS.updateLift(profile, ex.name, withOverrideStreak(counterAdjusted, liftState, ex, prescription, sessionRecord, context.timed, summary));
        }
      }
    }

    // 2b — an early end: every lift the deload scaled by load, other than
    // those judged on the standard path above, returns to its deload base.
    if (summary.deloadEnded) {
      for (const [name, st] of Object.entries(preCloseLifts)) {
        if (ordinary.has(name) || !getLiftProfile(name).progressesByLoad) continue;
        const loadType = loadTypeOfName(name);
        if (loadType === "bodyweight" || loadType === "assisted_bodyweight") continue;
        const base = deloadBaseWeight(name, st, endedDeload);
        if (base === null) continue;
        if (Object.hasOwn(summary.wwUpdates, name) || (isWorkingWeight(storedWeights[name]) && storedWeights[name] !== base)) {
          summary.wwUpdates[name] = base;
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
