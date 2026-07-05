"use client";

// components/SessionHost.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Owner of the live strength-session flow (readiness → session → done),
// mounted by the /session route (PR3 3e-route). Storage-as-store, same
// pattern as /profile and /performance: everything hydrates from
// localStorage on mount — the home shell hands over only a one-shot
// SessionIntent ({ sessionIdx } to start fresh, { resume: true } to pick up
// a draft). With neither an intent nor a live draft, the route bounces home.
//
// The draft IS the navigation guard: every logged set persists to LS
// (D.save), so leaving this route via back-gesture simply pauses the
// session — home shows the resume card, and a refresh or deep-link back to
// /session auto-resumes from the draft. Only the explicit Quit button
// discards. No popstate interception needed; the data model makes back
// safe by construction.
//
// The finalise pipeline (history append, progression engine, deload
// transitions, volume aggregates, blob push) moved here verbatim from
// ForgeApp's done-effect. Home-screen projections (week strip, streak,
// deload offer) are NOT mirrored into state here — the LS writes are the
// source of truth and the home shell re-derives them when it remounts on
// return. Logic drift between the two hosts is prevented by there being
// only one host: ForgeApp no longer renders the session flow at all.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import {
  P, H, W, PB, F, TS, BW, Days, D, SessionIntent,
  newDraftLog, logSet, finaliseDraft, bumpStreak, scaleForReadiness,
  startingWeightForLift, blobPush, pushNow,
} from "@/lib/storage";
import {
  SESSIONS, EXERCISE_POOLS,
  applyRotationToSession, applySwapsToSession, applyFocusToSession,
  DEFAULT_FOCUS, WEEK,
} from "@/lib/programme";
import {
  computeNextPrescription, computeDeloadPrescription, computeRecoveryPrescription,
  updateLiftStateFromSession, updateMuscleAnchorFromSession,
  reconcileLiftStateWithSession, shouldOfferDeload,
  completeDeload, shouldAutoCompleteDeload, decrementRecoveryCounter,
  deloadDayLabel,
} from "@/lib/progression";
import { getLiftProfile, getLoadType } from "@/lib/lift-translations";
import { haptic } from "@/lib/a11y";
import { withNavTransition } from "@/lib/nav-transitions";
import { computeVolumeAggregates } from "@/lib/analytics";
import ErrorBoundary from "@/components/ErrorBoundary";
import BodyweightEditModal from "@/components/BodyweightEditModal";
import {
  ReadinessScreen, SessionScreen, DoneScreen, SessionOverviewSheet,
} from "@/components/SessionScreen";

const SESSION_KEYS = ["strength-a", "strength-b", "strength-c"];

export default function SessionHost() {
  const router = useRouter();

  // ─── Identity + LS hydration (lazy initialisers — LS is canonical) ────────
  const [profile] = useState(() => P.getActive());
  const [workingWeights, setWWState] = useState(() => (profile ? P.getWeights(profile) : {}));
  const [workingReps, setWRState]    = useState(() => (profile ? P.getReps(profile) : {}));
  const [history]                    = useState(() => (profile ? H.get(profile) : []));
  const [bodyweight, setBodyweight]  = useState(() => (profile ? BW.getKg(profile) : null));
  const [programmeBlock]             = useState(() => PB.get());
  const [userFocus]                  = useState(() => (profile ? F.get(profile) || DEFAULT_FOCUS : DEFAULT_FOCUS));
  const [userWeek]                   = useState(() => W.get());
  const [activeDeload, setActiveDeload] = useState(() => {
    if (!profile) return null;
    try { return TS.get(profile)?.mesocycle?.activeDeload || null; } catch { return null; }
  });

  // ─── Flow state (session-only — moved from ForgeApp) ──────────────────────
  // entry: resolved once on mount from the intent stash / live draft.
  //   null = still resolving (first render), "bounce" = go home.
  const [flow, setFlow] = useState(null); // null | "readiness" | "session" | "done"
  const [activeSessionIdx, setActiveSessionIdx] = useState(0);
  const [sessionSwaps, setSessionSwaps] = useState({});
  const [blockIdx, setBlockIdx] = useState(0);
  const [setNum, setSetNum]     = useState(1);
  const [phase, setPhase]       = useState("A");
  const [sessionOverviewOpen, setSessionOverviewOpen] = useState(false);
  const [overviewDraftSnapshot, setOverviewDraftSnapshot] = useState(null);
  const [readiness, setReadiness]             = useState(null);
  const [readinessReason, setReadinessReason] = useState(null);
  const [showVid, setShowVid]       = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [awaitRpe, setAwaitRpe]     = useState(false);
  const [ssRoundDone, setSsRoundDone] = useState(false);
  const [restActive, setRestActive]   = useState(false);
  const [restRemain, setRestRemain]   = useState(180);
  const draftLogRef = useRef(null);
  const [sessionStartWeights, setSessionStartWeights] = useState({});
  const [showDeloadComplete, setShowDeloadComplete] = useState(false);
  const [returnGapDays, setReturnGapDays] = useState(null);
  const [bwEditOpen, setBwEditOpen] = useState(false);
  const [bwPromptedThisSession, setBwPromptedThisSession] = useState(false);

  // Persisting setters — mirror ForgeApp's setWW/setWR exactly so every
  // weight/rep adjustment lands in LS immediately (home re-reads on return).
  const setWW = useCallback((upd) => {
    setWWState(prev => {
      const next = typeof upd === "function" ? upd(prev) : upd;
      if (profile) P.saveWeights(profile, next);
      return next;
    });
  }, [profile]);
  const setWR = useCallback((upd) => {
    setWRState(prev => {
      const next = typeof upd === "function" ? upd(prev) : upd;
      if (profile) P.saveReps(profile, next);
      return next;
    });
  }, [profile]);

  // Rest timer tick — moved from ForgeApp with the timer state. The
  // reached-zero transition happens inside the timeout callback (an event,
  // not a render-synchronous effect write).
  useEffect(() => {
    if (!restActive) return;
    const t = setTimeout(() => {
      setRestRemain(p => {
        if (p <= 1) {
          setRestActive(false);
          // Haptic: Android fires; iOS Safari silently no-ops. Defensive
          // wrap — timer started from a button tap, so gesture rules allow.
          haptic.alert();
          return 0;
        }
        return p - 1;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [restActive, restRemain]);

  const updateBodyweight = useCallback((kg) => {
    if (!profile || !kg) return;
    BW.set(profile, kg);
    setBodyweight(kg);
    pushNow(profile);
  }, [profile]);

  // ─── Entry resolution (mount-once) ─────────────────────────────────────────
  // Intent stash → fresh start at readiness. No intent but a live draft →
  // resume (also covers refresh / deep-link mid-session). Neither → bounce.
  const resolvedRef = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect -- mount-once hydration
     of flow state from an external store (one-shot LS intent + draft);
     take() is side-effectful so it cannot live in a lazy initializer. */
  useEffect(() => {
    // Mount-once entry resolution. A ref guard makes it idempotent under
    // dev StrictMode double-invocation — SessionIntent.take() is a one-shot
    // LS read-and-delete, so the second invocation would otherwise see null
    // and wrongly bounce. setState here is the point: this effect hydrates
    // flow state from an external store exactly once.
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    if (!profile) { router.replace("/"); return; }
    const intent = SessionIntent.take(profile);
    const wrapped = D.load(profile); // { draft, ageMs, ... } | null

    const resumeFromDraft = (draft) => {
      const idx = SESSION_KEYS.indexOf(draft.session);
      const session = idx !== -1 ? SESSIONS[idx] : null;
      if (!session) { D.clear(profile); router.replace("/"); return; }
      // Find the furthest block with logged sets + the next set number —
      // same maths as ForgeApp's handleResumeDraft did.
      let resumeBlockIdx = 0;
      let setsOnCurrent = 0;
      for (let i = 0; i < session.blocks.length; i++) {
        const saved = draft.blocks[session.blocks[i].id];
        if (!saved) continue;
        const setsHere = Object.values(saved.exercises || {})
          .reduce((n, ex) => n + (ex.sets || []).length, 0);
        if (setsHere > 0) {
          resumeBlockIdx = i;
          setsOnCurrent = Math.max(
            ...Object.values(saved.exercises || {}).map(ex => (ex.sets || []).length)
          );
        }
      }
      draftLogRef.current = draft;
      // Best-available baseline for the Done diff — the original pre-session
      // snapshot isn't stored on the draft. See ForgeApp's old resume note.
      setSessionStartWeights({ ...P.getWeights(profile) });
      setActiveSessionIdx(idx);
      setReadiness(draft.readiness);
      setReadinessReason(draft.readinessReason);
      setBlockIdx(resumeBlockIdx);
      setSetNum(Math.min(setsOnCurrent + 1, session.blocks[resumeBlockIdx].sets));
      setPhase("A");
      setFlow("session");
    };

    if (intent?.resume && wrapped?.draft) { resumeFromDraft(wrapped.draft); return; }
    if (intent && typeof intent.sessionIdx === "number") {
      setActiveSessionIdx(intent.sessionIdx);
      setFlow("readiness");
      return;
    }
    // No intent — refresh or deep link. Live draft resumes; otherwise home.
    if (wrapped?.draft) { resumeFromDraft(wrapped.draft); return; }
    router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ─── Session derivation chain — verbatim from ForgeApp ────────────────────
  // Derivation chain — plain expressions; the React Compiler memoizes them
  // (manual useMemo here trips its "memoization could not be preserved"
  // diagnostic, and the compiler's own caching is the project default).
  const rawSession     = SESSIONS[activeSessionIdx];
  const rotatedSession = applyRotationToSession(rawSession, programmeBlock?.config);
  const swappedSession = applySwapsToSession(rotatedSession, sessionSwaps);
  const focusedSession = applyFocusToSession(swappedSession, userFocus, programmeBlock?.config);
  const activeSession  = scaleForReadiness(focusedSession, readiness);
  const block   = activeSession.blocks[blockIdx];
  const isSS    = block.type === "superset" || block.type === "finisher";
  const swapKey = isSS ? `${block.id}-${phase}` : block.id;

  const resolveExFn = useCallback((blockId, ph, defaultEx) => {
    const b = activeSession.blocks.find(x => x.id === blockId);
    if (!b) return defaultEx;
    if (ph === "A") return b.exA ?? defaultEx;
    if (ph === "B") return b.exB ?? defaultEx;
    return b.ex ?? defaultEx;
  }, [activeSession]);

  const resolvedExA = isSS ? (block.exA ?? null) : null;
  const resolvedExB = isSS ? (block.exB ?? null) : null;
  const resolvedEx  = !isSS ? (block.ex ?? null) : null;
  const activeEx    = isSS ? (phase === "A" ? resolvedExA : resolvedExB) : resolvedEx;

  const getW = useCallback((ex) => {
    if (!ex) return null;
    if (workingWeights[ex.name] !== undefined) return workingWeights[ex.name];
    const bwSeeded = startingWeightForLift(ex.name, bodyweight);
    if (bwSeeded !== null) return bwSeeded;
    return ex.weight;
  }, [workingWeights, bodyweight]);
  const getR = useCallback((ex) => ex ? (workingReps[ex.name] ?? ex.reps) : null, [workingReps]);

  const onSwap = useCallback((key, newEx) => {
    setSessionSwaps(prev => ({ ...prev, [key]: newEx }));
  }, []);

  // ─── Set logging + advancement — verbatim from ForgeApp ───────────────────
  const pushSetToDraft = useCallback((ex, rpe) => {
    if (!draftLogRef.current || !ex) return;
    let key = block.id;
    if (isSS) {
      const resolvedA = resolveExFn(block.id, "A", block.exA);
      const resolvedB = resolveExFn(block.id, "B", block.exB);
      const derivedPhase = ex.name === resolvedA?.name ? "A"
                         : ex.name === resolvedB?.name ? "B"
                         : phase;
      key = `${block.id}-${derivedPhase}`;
    }
    const swapPick = sessionSwaps[key];
    const swapped  = !!swapPick;
    const fromPool = EXERCISE_POOLS[key] ? key : null;
    const loadType = getLoadType(ex);
    const resolvedWeight = workingWeights[ex.name]
      ?? startingWeightForLift(ex.name, bodyweight)
      ?? ex.weight;
    logSet(draftLogRef.current, {
      blockId: block.id,
      blockType: block.type,
      exerciseName: ex.name,
      muscle: ex.muscle,
      swapped,
      fromPool,
      loadType,
      bodyweight: bodyweight,
      weight: resolvedWeight,
      reps: workingReps[ex.name] ?? ex.reps,
      rpe: rpe || null,
    });
    D.save(profile, draftLogRef.current);
    // Bodyweight prompt — once per session, timed to the RPE card fade.
    if (loadType !== "external" && bodyweight === null && !bwPromptedThisSession) {
      setBwPromptedThisSession(true);
      setTimeout(() => setBwEditOpen(true), 280);
    }
  }, [block, isSS, phase, sessionSwaps, workingWeights, workingReps, resolveExFn, profile, bodyweight, bwPromptedThisSession]);

  const commitLog = (rpe) => {
    const exes = isSS
      ? [resolveExFn(block.id, "A", block.exA), resolveExFn(block.id, "B", block.exB)]
      : [resolveExFn(block.id, null, block.ex)];
    exes.forEach(ex => pushSetToDraft(ex, rpe));
    if (setNum >= block.sets) {
      if (blockIdx < activeSession.blocks.length - 1) { setBlockIdx(p => p + 1); setSetNum(1); setPhase("A"); }
      else finishSession();
    } else setSetNum(p => p + 1);
    // Start the rest timer directly — no trigger-effect indirection needed
    // now these are plain event handlers (the old restTrigger state existed
    // to re-fire an effect between same-duration sets).
    setRestRemain(block.rest);
    setRestActive(true);
    setSsRoundDone(false);
    setAwaitRpe(false);
  };

  const handleLog = () => {
    if (isSS) {
      if (phase === "A") {
        if (block.type === "finisher") {
          pushSetToDraft(resolveExFn(block.id, "A", block.exA), null);
        }
        setPhase("B"); return;
      }
      setPhase("A");
      if (block.type === "superset") { setSsRoundDone(true); return; }
      pushSetToDraft(resolveExFn(block.id, "B", block.exB), null);
      if (setNum >= block.sets) {
        if (blockIdx < activeSession.blocks.length - 1) { setBlockIdx(p => p + 1); setSetNum(1); setPhase("A"); }
        else finishSession();
      } else setSetNum(p => p + 1);
      setRestRemain(block.rest);
      setRestActive(true);
      return;
    }
    setAwaitRpe(true);
  };

  const handleJumpToBlock = (targetIdx) => {
    if (typeof targetIdx !== "number" || targetIdx < 0) return;
    if (!activeSession?.blocks?.[targetIdx]) return;
    const targetBlock = activeSession.blocks[targetIdx];
    const saved = draftLogRef.current?.blocks?.[targetBlock.id];
    const pairs = saved?.exercises
      ? Math.max(0, ...Object.values(saved.exercises).map(ex => (ex.sets || []).length))
      : 0;
    setBlockIdx(targetIdx);
    setSetNum(Math.min(pairs + 1, targetBlock.sets));
    setPhase("A");
    setAwaitRpe(false);
    setSsRoundDone(false);
    setRestActive(false);
    setSessionOverviewOpen(false);
  };

  // Readiness "start" — initialise the draft and enter the session.
  const handleReadinessStart = () => {
    setSessionStartWeights({ ...workingWeights });
    draftLogRef.current = newDraftLog({
      profileName: profile,
      session: SESSION_KEYS[activeSessionIdx],
      blockNumber: programmeBlock.number,
      readiness,
      readinessReason,
    });
    setFlow("session");
  };

  // Explicit quit — the ONLY path that discards the draft. Back-gesture and
  // refresh keep it (pause semantics), see the module comment.
  const handleQuit = () => {
    draftLogRef.current = null;
    D.clear(profile);
    // Typed back-transition: leaving the session for home slides down
    // (modal-dismiss idiom) via the layout <ViewTransition> boundary.
    withNavTransition(() => router.replace("/"), "nav-back");
  };

  // ─── Session-finalise pipeline — moved from ForgeApp's done-effect, now
  // run as an EVENT (called by the handler that transitions to done) rather
  // than an effect keyed on flow: no cascade, no double-fire risk. Home-
  // screen state mirrors (weekDone / streak / history / deloadOffer) are
  // dropped — those projections re-derive from LS when home remounts.
  const finishSession = () => {
    if (profile) {
      bumpStreak(profile);
      // Week-strip completion is marked FROM THE SESSION RECORD'S DATE, not
      // the wall clock. The record's date is stamped at draft creation, so a
      // session finished after midnight (start 23:40, finish 00:20) belongs
      // to the day it was started. Using new Date() here marked the NEXT
      // day complete — which then also appeared in missed workouts because
      // Days/history (correctly date-keyed below) had no record for it.
      // Found on device: the classic midnight in-and-out. The mark happens
      // after finaliseDraft below so both stores share one date.

      // "Back at it" gap — read the newest strength record BEFORE appending.
      {
        const prior = H.get(profile)
          .filter(r => r?.date && String(r.session || "").startsWith("strength"))
          .map(r => r.date).sort().pop();
        if (prior) {
          const gap = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(prior).setHours(0, 0, 0, 0)) / 86400000);
          setReturnGapDays(gap > 7 ? gap : null);
        } else {
          setReturnGapDays(null);
        }
      }

      let sessionRecord = null;
      if (draftLogRef.current) {
        sessionRecord = finaliseDraft(draftLogRef.current);
        H.append(profile, sessionRecord);
        const effective = W.getEffectiveOn(sessionRecord.date);
        const dowMon = (() => {
          const [y, m, d] = sessionRecord.date.split("-").map(Number);
          const js = new Date(y, m - 1, d).getDay();
          return js === 0 ? 6 : js - 1;
        })();
        // Legacy week-strip mark — same record-date weekday as Days below
        // (see the midnight-straddle note above).
        P.markDayDone(profile, dowMon);
        const scheduledType = effective && effective[dowMon] ? effective[dowMon].type : "strength";
        Days.set(profile, sessionRecord.date, {
          scheduledType,
          completedType: "strength",
          sessionId: sessionRecord.id,
        });
        draftLogRef.current = null;
      }
      D.clear(profile);

      // Progression engine + deload transitions (Phase 2 + 3).
      if (sessionRecord) {
        try {
          const fullHistory = H.get(profile);
          let trainingState = TS.get(profile);
          const wwUpdates = {};

          const wasInDeload = !!trainingState.mesocycle?.activeDeload;
          let justCompletedDeload = false;
          if (wasInDeload && shouldAutoCompleteDeload(trainingState, sessionRecord.date)) {
            trainingState = completeDeload(trainingState);
            TS.replaceState(profile, trainingState);
            justCompletedDeload = true;
            setActiveDeload(null);
            setShowDeloadComplete(true);
          }
          const stillInDeload = !justCompletedDeload && wasInDeload;

          for (const blk of sessionRecord.blocks || []) {
            for (const ex of blk.exercises || []) {
              const rawLiftState = trainingState.lifts?.[ex.name] || null;
              const liftState    = reconcileLiftStateWithSession(rawLiftState, ex);
              const liftProfile  = getLiftProfile(ex.name);
              const anchorMuscle = liftProfile.primaryMuscle;
              const muscleAnchor = anchorMuscle
                ? trainingState.muscleAnchors?.[anchorMuscle] || null
                : null;

              let prescription;
              const context = {
                readiness: sessionRecord.readiness,
                currentWeight: workingWeights[ex.name] ?? ex.sets?.[0]?.weight ?? null,
              };

              if (stillInDeload) {
                prescription = computeDeloadPrescription(ex.name, liftState, context);
              } else if (liftState?.inRecoveryUntil > 0 && !justCompletedDeload) {
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
                wwUpdates[ex.name] = prescription.weight;
              }

              if (stillInDeload && liftState) {
                const lastHistEntry = {
                  date: sessionRecord.date,
                  weight: ex.sets?.[0]?.weight ?? null,
                  effectiveLoad: ex.sets?.[0]?.effectiveLoad ?? null,
                  reps: ex.sets?.[0]?.reps ?? null,
                  rir: ex.sets?.[0]?.rir ?? null,
                  est1rm: null,
                  decision: "DELOAD",
                  rationale: ["deload_session_logged"],
                };
                TS.updateLift(profile, ex.name, {
                  ...liftState,
                  history: [...(liftState.history || []), lastHistEntry].slice(-12),
                });
              } else {
                const newLiftState = updateLiftStateFromSession(
                  liftState,
                  sessionRecord,
                  ex,
                  prescription,
                );
                const counterAdjusted = (liftState?.inRecoveryUntil > 0 && !justCompletedDeload)
                  ? decrementRecoveryCounter(newLiftState)
                  : newLiftState;
                TS.updateLift(profile, ex.name, counterAdjusted);
              }

              if (anchorMuscle && liftProfile.progressesByLoad && !stillInDeload) {
                const currentAnchor = TS.get(profile).muscleAnchors?.[anchorMuscle] || null;
                const newAnchor = updateMuscleAnchorFromSession(currentAnchor, sessionRecord, ex);
                if (newAnchor) TS.updateMuscleAnchor(profile, anchorMuscle, newAnchor);
              }
            }
          }

          if (Object.keys(wwUpdates).length) {
            setWW(p => ({ ...p, ...wwUpdates }));
          }
          // shouldOfferDeload is home's card to show — evaluated on home
          // remount from the same LS state; no mirror needed here.
          void shouldOfferDeload;
        } catch (e) {
          console.error("[forge:progression]", e);
        }
      }

      // Phase 4 — silent volume tracking.
      if (sessionRecord) {
        try {
          const fullHistory = H.get(profile);
          const aggregates = computeVolumeAggregates(fullHistory);
          TS.updateVolume(profile, aggregates);
        } catch (e) {
          console.error("[forge:volume-tracking]", e);
        }
      }

      try {
        track("session_complete", {
          session: sessionRecord?.session || "strength",
          readiness: readiness || "normal",
          readinessReason: readinessReason || "unspecified",
          block: String(programmeBlock?.number ?? 1),
        });
      } catch {}

      blobPush(profile, {
        meta: {
          weights: P.getWeights(profile),
          reps: P.getReps(profile),
          streak: P.getStreak(profile),
          programmeBlock,
          userWeek: W.getHistory(),
          userFocus: F.get(profile),
          days: Days.getAll(profile),
        },
        history: sessionRecord ? [sessionRecord] : [],
      });
    }
    setFlow("done");
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  if (!flow) return null; // resolving entry (or bouncing)

  const sProps = {
    session: activeSession,
    block, blockIdx, totalBlocks: activeSession.blocks.length, setNum, phase, isSS,
    activeEx, resolvedExA, resolvedExB, resolvedEx,
    swapKey, onSwap,
    showVid, setShowVid, getW, getR, editTarget, setEditTarget,
    workingWeights, setWW, workingReps, setWR,
    history,
    awaitRpe, ssRoundDone,
    restActive, restRemain, setRestActive, setRestRemain,
    onCommit: commitLog, onLog: handleLog, onQuit: handleQuit,
    onShowOverview: () => {
      setOverviewDraftSnapshot(draftLogRef.current);
      setSessionOverviewOpen(true);
    },
    bodyweight,
    deloadDayTag: activeDeload ? deloadDayLabel(activeDeload) : null,
  };

  return (
    <ErrorBoundary>
      {flow === "readiness" && (
        <ReadinessScreen
          readiness={readiness} setReadiness={setReadiness}
          reason={readinessReason} setReason={setReadinessReason}
          onStart={handleReadinessStart}
        />
      )}
      {flow === "session" && <SessionScreen {...sProps} />}
      {flow === "done" && (
        <DoneScreen
          session={activeSession} profileName={profile}
          workingWeights={workingWeights} sessionStartWeights={sessionStartWeights}
          userWeek={userWeek || WEEK}
          onHome={() => { setShowDeloadComplete(false); setReturnGapDays(null); withNavTransition(() => router.replace("/"), "nav-back"); }}
          deloadCompleted={showDeloadComplete} returnGapDays={returnGapDays}
        />
      )}
      {sessionOverviewOpen && flow === "session" && (
        <SessionOverviewSheet
          session={activeSession}
          currentBlockIdx={blockIdx}
          draftLog={overviewDraftSnapshot}
          onJumpToBlock={handleJumpToBlock}
          onCancel={() => setSessionOverviewOpen(false)}
        />
      )}
      <BodyweightEditModal open={bwEditOpen} onClose={() => setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight} />
    </ErrorBoundary>
  );
}
