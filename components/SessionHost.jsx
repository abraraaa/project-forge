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
//
// Store reads and writes go through one adapter (lib/session-source.js), and
// the finish's writes through lib/session-commit.js, shared with Keep.
//
// Coached mode (mode.kind "coached", /trainer/coach): a trainer runs a
// client's session on their own device. The adapter reads the client's
// programme inputs from the trainer route's plan and writes no client store;
// the draft lives in forge:coachDraft. The finish opens Review (the sets, the
// day, Send) instead of writing, and Send hands the record to the change route.
// Review's "Discard this session" removes that client's draft, and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { track } from "@vercel/analytics";
import {
  P, newDraftLog, logSet, finaliseDraft, scaleForReadiness, planStartWeight, rpeToRir,
} from "@/lib/storage";
import {
  localSource, localSinks, coachedSource, coachedSinks, sessionDrum, recordOnDay, mintSessionSetId, capDraftSets,
  CD, coachTrainer, letterIndex, letterOf, sessionNameOf, COACH_MAX_SETS,
} from "@/lib/session-source";
import { changeStatus, sessionDayWords } from "@/lib/trainer-change";
import {
  SESSIONS, EXERCISE_POOLS,
  applyRotationToSession, applySwapsToSession, applyFocusToSession, applyMainLiftsToSession,
  WEEK, nextStrengthIdx,
} from "@/lib/programme";
import { deloadDayLabel, isFinalSetMiss, lastSessionNote, ADOPT_AFTER_SESSIONS, repTargetRepairs } from "@/lib/progression";
import { SESSION_COPY } from "@/lib/session-copy";
import { deriveTravelSession } from "@/lib/travel";
import { getLiftProfile, getLoadType, parseTimedReps, ADD_THRESHOLD_RIR, STEP_SIZES, addedLoadFor } from "@/lib/lift-translations";
import { restRemaining, restDeadline } from "@/lib/rest-clock";
import { unfinishedBlocks, nextUnfinishedIdx, loggedOnBlock, leadExerciseName } from "@/lib/session-progress";
import { pickFlashLine, isPullMovement } from "@/lib/set-flash";
import { EXERCISE_ANATOMY } from "@/lib/exercise-anatomy";
import { todayLocalIso, daysBetween, addDaysIso } from "@/lib/dates";
import { fetchWithTimeout } from "@/lib/net";
import { isStrengthRecord } from "@/lib/day-state";
import { T, DISPLAY } from "@/lib/tokens";
import { haptic } from "@/lib/a11y";
import { withNavTransition } from "@/lib/nav-transitions";
import ErrorBoundary from "@/components/ErrorBoundary";
import Glyph from "@/components/Glyph";
import BodyweightEditModal from "@/components/BodyweightEditModal";
import {
  ReadinessScreen, SessionScreen, DoneScreen, SessionOverviewSheet,
} from "@/components/SessionScreen";

const SESSION_KEYS = ["strength-a", "strength-b", "strength-c"];

/**
 * Who set this lift's number, when a trainer's change set it and it still
 * stands: the value is unchanged and no session of the lift came after it
 * landed (the same "in force" the client's change list shows). Read-only.
 * @param {Record<string, { id: string, after: any, by: string | null, at: string }> | undefined} mark  trainerLocal marks for the lift
 * @param {string} lift
 * @param {{ weights: Record<string, any>, reps: Record<string, any>, history: any[] }} state
 * @returns {string | null}
 */
export function setByLine(mark, lift, { weights, reps, history }) {
  if (!mark || typeof mark !== "object") return null;
  const meta = { weights, reps };
  const todayIso = todayLocalIso();
  /** @param {"weight" | "reps"} kind */
  const holder = (kind) => {
    const m = mark[kind];
    if (!m || typeof m.id !== "string" || typeof m.at !== "string") return undefined;
    const row = { id: m.id, kind, target: lift, after: m.after, appliedAt: m.at, outcome: "applied" };
    if (changeStatus(row, { meta, history, todayIso }).status !== "in_force") return undefined;
    return typeof m.by === "string" && m.by ? m.by : "your trainer";
  };
  const w = holder("weight");
  const r = holder("reps");
  if (w && r && w === r) return `Set by ${w}`;
  const parts = [w && `Weight set by ${w}`, r && `${w ? "reps" : "Reps"} set by ${r}`].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Whether a draft already holds its one reach. */
const draftHasReach = (draft) => Object.values(draft?.blocks || {}).some((b) =>
  Object.values(b?.exercises || {}).some((ex) => (ex?.sets || []).some((st) => st?.reach === true)));

/**
 * @param {{ mode?: {
 *   kind: "coached", ref: string, name: string | null, letter: string, plan: any, view: any,
 *   entry: import("@/lib/session-source").CoachDraft | null,
 *   post: (body: any) => Promise<{ status: number, body: any }>,
 *   onFaceId: () => Promise<boolean | "unknown">,
 * } | null }} [props]  no mode: the lifter's own session
 */
export default function SessionHost({ mode = null } = {}) {
  const router = useRouter();
  const coached = mode?.kind === "coached";
  // Where Quit and Send lead.
  const exitTo = coached ? "/trainer" : "/";

  // ─── Identity + LS hydration (lazy initialisers — LS is canonical) ────────
  // Coached: no profile on this device is read or written.
  const [profile] = useState(() => (coached ? null : P.getActive()));
  // Every store read and write goes through these (lib/session-source.js).
  const [source] = useState(() => (coached ? coachedSource(mode.plan, mode.view, mode.entry) : localSource(profile)));
  const [sinks] = useState(() => (coached
    ? coachedSinks(mode.ref, { letter: mode.letter, name: mode.name, plan: mode.plan, entry: mode.entry, post: mode.post })
    : localSinks(profile)));
  // W and R are the PRESCRIPTION: what the engine set for each lift. Only the
  // engine (finishSession) and a cold-start seed write them. What the lifter
  // spins on the drum today lives in the session plan below.
  const [workingWeights, setWWState] = useState(() => source.weights());
  const [workingReps, setWRState]    = useState(() => source.reps());
  // Today's plan: the drum's edits, session-scoped. The drum is what you did,
  // so it carries to the next set as the default but never rewrites the
  // prescription. Lost with the session; a resume re-seeds it from the draft.
  const [sessionWeights, setSessionWeights] = useState({});
  const [sessionReps, setSessionReps]       = useState({});
  const planWeights = useMemo(() => ({ ...workingWeights, ...sessionWeights }), [workingWeights, sessionWeights]);
  // Lift state as the session opened, for the card's note on last session.
  const [liftStates] = useState(() => source.liftStates());
  // Who set each lift's number, as the session opened (device-local marks a
  // trainer's change leaves when it lands). Display only.
  const [trainerMarks] = useState(() => source.trainerMarks());
  // Muscle anchors as the session opened: the cold-start rung of every plan
  // weight (planStartWeight). Only finalise moves them.
  const [muscleAnchors] = useState(() => source.muscleAnchors());
  const [history]                    = useState(() => source.history());
  const [bodyweight, setBodyweight]  = useState(() => source.bodyweight());
  const [programmeBlock]             = useState(() => source.programmeBlock());
  const [userFocus]                  = useState(() => source.focus());
  const [mainLifts]                  = useState(() => source.mainLifts());
  // Optional added load on pure bodyweight lifts — the user's alone. Saved
  // per lift with its own stamp and pushed on change. The engine never
  // writes it.
  const [addedLoads, setAddedLoadsState] = useState(() => source.addedLoads());
  const [userWeek]                   = useState(() => source.userWeek());
  const [activeDeload, setActiveDeload] = useState(() => source.activeDeload());

  // ─── Flow state (session-only — moved from ForgeApp) ──────────────────────
  // entry: resolved once on mount from the intent stash / live draft.
  //   null = still resolving (first render), "bounce" = go home.
  const [flow, setFlow] = useState(null); // null | "readiness" | "session" | "done"
  const [activeSessionIdx, setActiveSessionIdx] = useState(0);
  // A coached draft carries its swaps, so a resumed slot keeps the lift it logged.
  const [sessionSwaps, setSessionSwaps] = useState(() => (coached && mode.entry?.swaps ? mode.entry.swaps : {}));
  const [blockIdx, setBlockIdx] = useState(0);
  const [setNum, setSetNum]     = useState(1);
  const [phase, setPhase]       = useState("A");
  const [sessionOverviewOpen, setSessionOverviewOpen] = useState(false);
  const [overviewDraftSnapshot, setOverviewDraftSnapshot] = useState(null);
  const [readiness, setReadiness]             = useState(null);
  const [readinessReason, setReadinessReason] = useState(null);
  // Travel mode is STICKY across sessions, so it seeds from the store rather
  // than starting false each time. Lazy init: no localStorage during SSR, and
  // this host is ssr:false anyway.
  const [travel, setTravelState]              = useState(() => source.travel());
  const setTravel = useCallback((on) => {
    setTravelState(on);
    sinks.travel(on);
  }, [sinks]);
  const [showVid, setShowVid]       = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [awaitRpe, setAwaitRpe]     = useState(false);
  const [ssRoundDone, setSsRoundDone] = useState(false);
  const [restActive, setRestActive]   = useState(false);
  const [restRemain, setRestRemain]   = useState(180);
  const draftLogRef = useRef(null);
  // Screen-reader channel for moments that are otherwise only visual (or a
  // haptic iOS ignores). Cleared first so a repeated message is re-announced.
  const [srMsg, setSrMsg] = useState("");
  const announce = (msg) => { setSrMsg(""); setTimeout(() => setSrMsg(msg), 60); };
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
      sinks.saveW(next);
      return next;
    });
  }, [sinks]);
  const setWR = useCallback((upd) => {
    setWRState(prev => {
      const next = typeof upd === "function" ? upd(prev) : upd;
      sinks.saveR(next);
      return next;
    });
  }, [sinks]);
  // The sink writes the lift's added load and pushes.
  const setAddedLoad = useCallback((name, kg) => {
    if ((!profile && !coached) || !name) return;
    setAddedLoadsState(sinks.addedLoad(name, kg));
  }, [profile, coached, sinks]);

  // Rest timer. A DEADLINE against the wall clock, not a decrementing tally:
  // iOS suspends timers when the phone locks, so the old counter simply stopped
  // and a four-minute break read as 2:10 on return.
  //
  // The anchor is set when rest STARTS rather than by each caller, because
  // SessionScreen also starts and skips rest through the same setters.
  const restEndsAtRef = useRef(null);
  useEffect(() => {
    restEndsAtRef.current = restActive ? restDeadline(restRemain) : null;
    // restRemain deliberately absent: re-anchoring on every tick would make
    // the deadline chase itself and never arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restActive]);

  useEffect(() => {
    if (!restActive) return;
    const sync = () => {
      const left = restRemaining(restEndsAtRef.current);
      setRestRemain(left);
      if (left === 0) {
        setRestActive(false);
        // Android fires; iOS Safari silently no-ops. Started from a tap, so
        // gesture rules allow it.
        haptic.alert();
        announce("Rest over");
      }
    };
    const t = setInterval(sync, 1000);
    // Resume is the whole point: catch up the instant the screen comes back
    // rather than waiting up to a second for the next tick.
    const onVisible = () => { if (document.visibilityState === "visible") sync(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [restActive]);

  // The sink writes the bodyweight and pushes.
  const updateBodyweight = useCallback((kg) => {
    if (!profile || !kg) return;
    sinks.bodyweight(kg);
    setBodyweight(kg);
  }, [profile, sinks]);

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
    if (!profile && !coached) { router.replace("/"); return; }
    const intent = sinks.draft.take();
    const wrapped = sinks.draft.load(); // { draft, ageMs, ... } | null

    const resumeFromDraft = (draft) => {
      const idx = SESSION_KEYS.indexOf(draft.session);
      const session = idx !== -1 ? SESSIONS[idx] : null;
      if (!session) { sinks.draft.clear(); router.replace(exitTo); return; }
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
      // The plan carries the last logged set of each lift, as it did before
      // the refresh. A pure bodyweight lift's weight is its added load, kept
      // in its own store, so it never seeds the plan.
      const seedW = {}, seedR = {};
      for (const b of Object.values(draft.blocks || {})) {
        for (const ex of Object.values(b?.exercises || {})) {
          const lastSet = (ex?.sets || [])[ex.sets.length - 1];
          if (!ex?.name || !lastSet) continue;
          if (lastSet.reps !== null && lastSet.reps !== undefined) seedR[ex.name] = lastSet.reps;
          if (ex.loadType !== "bodyweight" && typeof lastSet.weight === "number") seedW[ex.name] = lastSet.weight;
        }
      }
      // A coached draft also kept today's plan as it stood: laid over the seed,
      // so a reload loses nothing.
      setSessionWeights(coached ? { ...seedW, ...(mode.entry?.sessionWeights || {}) } : seedW);
      setSessionReps(coached ? { ...seedR, ...(mode.entry?.sessionReps || {}) } : seedR);
      // Best-available baseline for the Done diff — the original pre-session
      // snapshot isn't stored on the draft. See ForgeApp's old resume note.
      setSessionStartWeights({ ...source.weights() });
      setActiveSessionIdx(idx);
      setReadiness(draft.readiness);
      setReadinessReason(draft.readinessReason);
      if (draft.travel === true) setTravelState(true);
      setBlockIdx(resumeBlockIdx);
      // Unclamped, as in handleJumpToBlock.
      setSetNum(setsOnCurrent + 1);
      setPhase("A");
      setFlow("session");
    };

    if (intent?.resume && wrapped?.draft) { resumeFromDraft(wrapped.draft); return; }
    // Coached: this client's draft on this device resumes (no intent store here).
    if (coached && wrapped?.draft) { resumeFromDraft(wrapped.draft); return; }
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
  // Durable main-lift choice first, so a one-off session swap still wins.
  const mainSession    = applyMainLiftsToSession(rotatedSession, mainLifts);
  const swappedSession = applySwapsToSession(mainSession, sessionSwaps);
  const focusedSession = applyFocusToSession(swappedSession, userFocus, programmeBlock?.config, mainLifts);
  // Travel converts what focus finished choosing, and readiness still trims
  // on top — a cooked day drops its finisher whether or not you're in a hotel.
  const travelledSession = travel ? deriveTravelSession(focusedSession) : focusedSession;
  const activeSession  = scaleForReadiness(travelledSession, readiness);
  // The prescription the session shows: R, with any target left below its
  // lift's base read as the base (repTargetRepairs). Templates come from the
  // programme slot as composed before swaps and readiness; a lift placed by a
  // session swap keeps its own target. Travel sessions never reach the engine,
  // so they show R as stored. Persisted at finalise (repairedReps).
  const repRepairs = useMemo(() => {
    if (travel) return {};
    const config = programmeBlock?.config;
    const programmed = applyFocusToSession(
      applyMainLiftsToSession(applyRotationToSession(SESSIONS[activeSessionIdx], config), mainLifts),
      userFocus, config, mainLifts,
    );
    return repTargetRepairs({
      reps: workingReps,
      lifts: liftStates,
      sessions: [programmed],
      exclude: Object.values(sessionSwaps).map((s) => s?.name).filter(Boolean),
    });
  }, [travel, programmeBlock, activeSessionIdx, mainLifts, userFocus, workingReps, liftStates, sessionSwaps]);
  const prescribedReps = useMemo(() => ({ ...workingReps, ...repRepairs }), [workingReps, repRepairs]);
  const planReps = useMemo(() => ({ ...prescribedReps, ...sessionReps }), [prescribedReps, sessionReps]);
  const block   = activeSession.blocks[blockIdx];
  const isSS    = block.type === "superset" || block.type === "finisher";
  const swapKey = isSS ? `${block.id}-${phase}` : block.id;

  const resolvedExA = isSS ? (block.exA ?? null) : null;
  const resolvedExB = isSS ? (block.exB ?? null) : null;
  const resolvedEx  = !isSS ? (block.ex ?? null) : null;
  const activeEx    = isSS ? (phase === "A" ? resolvedExA : resolvedExB) : resolvedEx;
  // What the finished-block fork's primary names: the next block still short
  // of its sets, so a block done out of order is never offered again. null
  // when every later block is done. draftView is a render-safe copy of the
  // draft, refreshed on every advance by the loggedSets effect below.
  const [draftView, setDraftView] = useState(null);
  const nextIdx     = nextUnfinishedIdx(activeSession, draftView, blockIdx);
  const nextBlock   = nextIdx === null ? null : activeSession.blocks[nextIdx];
  const nextExName  = nextBlock ? leadExerciseName(nextBlock) : null;
  // With nothing left ahead, the fork first points back at any earlier block
  // left short (jumped past via the overview, or Next'd early): a finished
  // session can't be amended.
  const firstShort  = !nextBlock ? (unfinishedBlocks(activeSession, draftView, blockIdx)[0] ?? null) : null;
  const backTo      = firstShort ? { idx: firstShort.idx, name: leadExerciseName(firstShort.block) } : null;

  // The card, the drum and the log read today's plan, which defaults to the
  // prescription until the drum moves.
  const getW = useCallback((ex) => (
    ex ? planStartWeight(ex, { working: planWeights, bodyweight, anchors: muscleAnchors }) : null
  ), [planWeights, bodyweight, muscleAnchors]);
  const getR = useCallback((ex) => ex ? (planReps[ex.name] ?? ex.reps) : null, [planReps]);

  const onSwap = (key, newEx) => {
    setSessionSwaps(prev => ({ ...prev, [key]: newEx }));
    // Seed a cold start for a lift the user has never trained.
    //
    // The swap deliberately drops the old slot's weight whenever the load
    // maths differ — 28kg of landmine press is not 28kg of Arnold press, and
    // carrying it over would be worse than carrying nothing. But "nothing"
    // left the drum with no number at all, and the card then fell through to
    // its bodyweight branch and announced a dumbbell press as bodyweight
    // (boss report, 2026-08-13). Give it the anchor-derived start, the same
    // one the engine's cold start computes (lib/progression.js). Neither gives
    // one to a bodyweight-based movement, pure, loaded or assisted: its W is
    // added kg, not an anchor-sized load. Only the anchor rung is written
    // (no bodyweight, no template): a one-time W write.
    const name = newEx?.name;
    if (!name || newEx.weight != null || workingWeights[name] !== undefined) return;
    const seed = planStartWeight(newEx, { anchors: muscleAnchors, bodyweight: null, template: null });
    if (seed) setWW((prev) => ({ ...prev, [name]: seed }));
  };

  // ─── The reach — a Fresh-day nudge on the headline lift ───────────────────
  // Fresh and Normal used to produce a byte-identical session: scaleForReadiness
  // only ever branched on "cooked", so declaring yourself fresh changed nothing
  // and the copy promised a difference the engine never delivered.
  //
  // The offer lands ONCE, on the final prescribed set of the session's first
  // main block, and only on a day that can carry it: fresh, not deloading, not
  // travelling (a hotel room has no plates to add). Two doors, both optional —
  // one more set, or this one heavier by the lift's own progression step. The
  // set that follows is flagged `reach`, and lib/progression.js makes that
  // upside-only: never a miss, and it moves the working weight only if the user
  // actually met the target at the heavier load.
  //
  // ORDERING NOTE: every render-body read of an activeSession-derived value has
  // to sit ABOVE resolveExFn. That callback closes over activeSession, and the
  // React Compiler treats a later read as a possible mutation — it then refuses
  // to preserve the memoization and silently skips optimising the whole
  // component. Hence resolveExFn now lives below this block.
  const [reachArmed, setReachArmed] = useState(false);   // next set is a reach
  const [bonusSets, setBonusSets]   = useState(0);       // extra sets, this block
  // Offered once a session; a resumed coached draft that took it stays spent.
  const [reachSpent, setReachSpent] = useState(() => coached && draftHasReach(mode.entry?.draft));
  const headlineBlockIdx = activeSession.blocks.findIndex((b) => b.type === "main");
  const isHeadline = headlineBlockIdx >= 0 && blockIdx === headlineBlockIdx;
  const blockSets = block.sets + (isHeadline ? bonusSets : 0);
  const reachStep = activeEx?.name
    ? (STEP_SIZES[getLiftProfile(activeEx.name).category] ?? 2.5)
    : 2.5;
  // Resolved WITHOUT calling getW: invoking a useCallback from the render body
  // is the other thing that makes the compiler bail here.
  const reachWeight = activeEx
    ? planStartWeight(activeEx, { working: planWeights, bodyweight, anchors: muscleAnchors })
    : null;
  // Never ask before two sets are in the bank. Today every main block is 3 or
  // 4 sets, so "last set" already lands on the 3rd or later — but that is a
  // property of the template, not a guarantee. Stated explicitly here so a
  // future 2-set main block can't quietly start asking after set one, when
  // nobody yet knows what kind of day it is.
  const REACH_EARLIEST_SET = 3;
  const canReach =
    readiness === "fresh" && !reachSpent && !reachArmed && !activeDeload && !travel &&
    !isSS && isHeadline && setNum === blockSets && setNum >= REACH_EARLIEST_SET &&
    getLoadType(activeEx) !== "bodyweight" && Number.isFinite(reachWeight);

  // Announce the reach offer once, when it appears.
  const reachAnnounced = useRef(false);
  useEffect(() => {
    if (canReach && !reachAnnounced.current) {
      reachAnnounced.current = true;
      announce("Last set, and you came in fresh.");
    }
  }, [canReach]);

  // Plain handlers, like commitLog/handleLog below — the React Compiler
  // memoizes them, and hand-rolling it here made the component bail too.
  const takeReach = (door) => {
    setReachSpent(true);
    setReachArmed(true);
    if (door === "heavier") {
      // Exactly what flipping the wheels does — no new prescription plumbing,
      // and the engine reconciles from the logged sets at finalise regardless.
      const name = activeEx?.name;
      const next = Math.round(((reachWeight ?? 0) + reachStep) * 100) / 100;
      if (name) setSessionWeights((prev) => ({ ...prev, [name]: next }));
    } else {
      setBonusSets(1);
    }
  };
  const declineReach = () => setReachSpent(true);

  // One line on the card about how the engine read this lift last time: a
  // target adopted from the lifter's own repeated choice, or a last set that
  // came up short on an otherwise full session.
  const lastNote = activeEx?.name ? lastSessionNote(liftStates[activeEx.name]) : null;
  const coachLine = lastNote?.kind === "adopted" ? SESSION_COPY.adoptedTarget(lastNote.reps, ADOPT_AFTER_SESSIONS)
    : lastNote?.kind === "final_set_miss" ? SESSION_COPY.ownAllSets(block.sets)
    : null;
  // A quieter line under it when a trainer set today's number.
  const setBy = activeEx?.name
    ? setByLine(trainerMarks[activeEx.name], activeEx.name, { weights: workingWeights, reps: workingReps, history })
    : null;
  const cardLine = !setBy ? coachLine : (
    <>
      {coachLine && <span style={{ display: "block" }}>{coachLine}</span>}
      <span style={{ display: "block", marginTop: coachLine ? 4 : 0, fontSize: 12, color: T.ink3 }}>{setBy}</span>
    </>
  );

  const resolveExFn = useCallback((blockId, ph, defaultEx) => {
    const b = activeSession.blocks.find(x => x.id === blockId);
    if (!b) return defaultEx;
    if (ph === "A") return b.exA ?? defaultEx;
    if (ph === "B") return b.exB ?? defaultEx;
    return b.ex ?? defaultEx;
  }, [activeSession]);



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
    // A pure bodyweight set logs only the user's optional added load — null
    // when none, so a no-vest set is exactly what it always was. W is never
    // read for these lifts (the engine never prescribes one there).
    const resolvedWeight = loadType === "bodyweight" ? addedLoadFor(addedLoads, ex.name)
      : planStartWeight(ex, { working: planWeights, bodyweight, anchors: muscleAnchors });
    // The prescription this set was measured against — W/R, never the drum —
    // so the engine judges what was done against what was asked.
    const prescribedWeight = loadType === "bodyweight" ? null
      : planStartWeight(ex, { working: workingWeights, bodyweight, anchors: muscleAnchors });
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
      reps: planReps[ex.name] ?? ex.reps,
      rpe: rpe || null,
      reach: reachArmed,
      prescribed: { reps: prescribedReps[ex.name] ?? ex.reps, weight: prescribedWeight, sets: block.sets },
    });
    // The coached sink keeps today's plan and swaps with the draft.
    sinks.draft.save(draftLogRef.current, { swaps: sessionSwaps, sessionWeights, sessionReps });
    // Bodyweight prompt — once per session, timed to the RPE card fade.
    // ONLY the bodyweight family: these are the load types whose effective
    // load is uncomputable without a weigh-in (computeEffectiveLoad).
    // `!== "external"` also caught per_db/cable/total — a dumbbell curl
    // interrupting the session to ask your weight (boss report,
    // 2026-08-03). Other surfaces (Home card, Locker Room) carry the
    // general nudge.
    const needsBw = loadType === "bodyweight" || loadType === "loaded_bodyweight" || loadType === "assisted_bodyweight";
    // Never on a trainer's device: the bodyweight is the client's.
    if (needsBw && bodyweight === null && !bwPromptedThisSession && !coached) {
      setBwPromptedThisSession(true);
      setTimeout(() => setBwEditOpen(true), 280);
    }
  }, [block, isSS, phase, sessionSwaps, sessionWeights, sessionReps, workingWeights, prescribedReps, planWeights, planReps, addedLoads, muscleAnchors, resolveExFn, sinks, bodyweight, bwPromptedThisSession, reachArmed, coached]);

  // Final-set flash — one quiet line after rating the LAST set of an
  // exercise (lib/set-flash.js: no repeats this session, Easy falls back to
  // Normal on short reps, bar lines skipped for bodyweight). Lives here, not
  // in SessionScreen, so it survives the block advance and still lands when
  // finishSession() swaps to the done screen. Cascade: the commit advances
  // the screen instantly, then the line fades in ~450ms later onto the
  // settled view, holds, and fades out — never blocking, never tappable.
  const [setFlash, setSetFlash]       = useState(null);
  const [flashLeaving, setFlashLeaving] = useState(false);
  const usedFlashRef  = useRef(new Set());
  const flashTimersRef = useRef([]);
  useEffect(() => () => flashTimersRef.current.forEach(clearTimeout), []);
  const showFlash = (line) => {
    usedFlashRef.current.add(line);
    flashTimersRef.current.forEach(clearTimeout);
    setFlashLeaving(false);
    setSetFlash(null);
    flashTimersRef.current = [
      setTimeout(() => { setSetFlash(line); announce(line); }, 450),  // let the screen swap settle
      setTimeout(() => setFlashLeaving(true), 3200),
      setTimeout(() => { setSetFlash(null); setFlashLeaving(false); }, 3800),
    ];
  };
  const maybeFlash = (rpe) => {
    if (isSS) return;
    // Measured against the prescription, not the template: the drum moves
    // today's plan, and a climbed target is still the target.
    const shownReps = activeEx ? (prescribedReps[activeEx.name] ?? activeEx.reps) : null;
    const timed  = parseTimedReps(activeEx?.reps);
    const target = typeof shownReps === "number" ? shownReps
      : timed ? timed.seconds : parseInt(shownReps, 10);
    const done   = getR(activeEx);
    // The last prescribed set came up short at full effort, every earlier one
    // on target: the engine reads that as a good day (final_set_miss).
    if (setNum === block.sets && !timed && activeEx?.name) {
      const prior = draftLogRef.current?.blocks?.[block.id]?.exercises?.[activeEx.name]?.sets || [];
      const rir = rpeToRir(rpe);
      const asLogged = { prescribed: { reps: shownReps, sets: block.sets }, sets: [...prior, { reps: done }] };
      if (rir !== null && rir <= 1 && isFinalSetMiss(asLogged)) { showFlash(SESSION_COPY.finalSetMiss); return; }
    }
    if (setNum !== blockSets) return; // last set of a plain block only
    const fullReps = !Number.isFinite(target) || (typeof done === "number" ? done >= target : true);
    // Unambiguous-ADD certification for the consequence lines ("Next time,
    // heavier."): full reps + effort at/above this lift's ADD threshold +
    // no active deload + lift not in post-deload recovery. Same
    // ADD_THRESHOLD_RIR table the engine reads at finalise; every
    // ambiguous case (deload, recovery, sub-threshold effort) falls back
    // to acknowledgement lines that promise nothing — the flash must
    // never say what the engine might not deliver.
    let addLikely = false;
    try {
      // Coached: the engine's state is the client's, so heavier is never promised.
      if (fullReps && !activeDeload && !coached && activeEx?.name) {
        const rir = rpeToRir(rpe);
        const threshold = ADD_THRESHOLD_RIR[getLiftProfile(activeEx.name).category] ?? 2;
        const inRecovery = source.inRecovery(activeEx.name);
        addLikely = rir !== null && rir >= threshold && !inRecovery;
      }
    } catch { /* certification is best-effort — silence beats a wrong promise */ }
    const line = pickFlashLine(rpe, {
      fullReps,
      barLoaded: getLoadType(activeEx) !== "bodyweight",
      pullMovement: isPullMovement(activeEx?.name, EXERCISE_ANATOMY[activeEx?.name]?.primary ?? null),
      used: usedFlashRef.current,
      addLikely,
    });
    if (!line) return;
    showFlash(line);
  };

  const commitLog = (rpe) => {
    maybeFlash(rpe);
    const exes = isSS
      ? [resolveExFn(block.id, "A", block.exA), resolveExFn(block.id, "B", block.exB)]
      : [resolveExFn(block.id, null, block.ex)];
    exes.forEach(ex => pushSetToDraft(ex, rpe));
    setReachArmed(false);            // a reach is one set, never a mode
    // Past the last set the block stays put: the screen forks into "Add
    // another set" or Next (handleNext). Never advances on its own.
    setSetNum(p => p + 1);
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
      setSetNum(p => p + 1);           // as commitLog: the fork, not an advance
      setRestRemain(block.rest);
      setRestActive(true);
      return;
    }
    setAwaitRpe(true);
  };

  // The fork's primary: move on to the next block still to do, or finish.
  const handleNext = () => {
    const target = nextUnfinishedIdx(activeSession, draftLogRef.current, blockIdx);
    if (target === null) { finishSession(); return; }
    setBlockIdx(target);
    setSetNum(loggedOnBlock(draftLogRef.current, activeSession.blocks[target].id) + 1);
    setPhase("A");
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
    // Unclamped: clamping landed you on the last set of a finished block,
    // reading as "one still to do" while the overview called it Done.
    setSetNum(pairs + 1);
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
      travel,
    });
    setFlow("session");
  };

  // Explicit quit — the ONLY path that discards the draft. Back-gesture and
  // refresh keep it (pause semantics), see the module comment.
  const handleQuit = () => {
    draftLogRef.current = null;
    sinks.draft.clear();
    // Typed back-transition: leaving the session for home slides down
    // (modal-dismiss idiom) via the layout <ViewTransition> boundary.
    // Coached: the sink keeps the draft until its Send.
    withNavTransition(() => router.replace(exitTo), "nav-back");
  };

  // Coached Review: the finished record, its drum, the lifts held to ten sets,
  // and the set id. One id for the session (a new one only when the route
  // says this one went with something else), and one record while the draft
  // is unchanged, so a send whose reply was lost replays as sent after Back
  // or a reload too. Both are kept with the draft (CD).
  const [review, setReview] = useState(/** @type {{ record: any, drum: Record<string, number>, setId: string, over: string[] } | null} */ (null));
  const setIdRef = useRef(/** @type {string | null} */ (null));
  // The record as first reviewed, while the draft is unchanged: finaliseDraft
  // stamps the duration from the clock, so a second Review would otherwise
  // differ from what a lost reply already stored and never replay.
  const reviewedRef = useRef(/** @type {{ key: string, record: any, drum: Record<string, number> } | null} */ (null));
  /** @type {any} */
  const coachSinks = sinks;

  // ─── Session-finalise pipeline — moved from ForgeApp's done-effect, now
  // run as an EVENT (called by the handler that transitions to done) rather
  // than an effect keyed on flow: no cascade, no double-fire risk. Home-
  // screen state mirrors (weekDone / streak / history / deloadOffer) are
  // dropped — those projections re-derive from LS when home remounts.
  const finishSession = () => {
    // Coached: no writes here. The record goes to Review; Back returns to the
    // session with the draft as it was (finaliseDraft is pure).
    if (coached) {
      const capped = draftLogRef.current ? capDraftSets(draftLogRef.current) : null;
      const key = capped ? JSON.stringify(capped.draft) : null;
      // What an earlier Review of this draft kept with it (a reload loses the refs).
      const held = coachSinks.draft.held();
      if (capped && reviewedRef.current?.key !== key) {
        const fresh = finaliseDraft(capped.draft);
        const record = held.duration === null ? fresh : { ...fresh, duration: held.duration };
        reviewedRef.current = { key: /** @type {string} */ (key), record, drum: sessionDrum(record, sessionWeights) };
      }
      const reviewed = capped ? reviewedRef.current : null;
      setIdRef.current ??= held.setId ?? mintSessionSetId();
      coachSinks.draft.hold({ setId: setIdRef.current, ...(reviewed ? { duration: reviewed.record.duration } : {}) });
      setReview(reviewed ? { record: reviewed.record, drum: reviewed.drum, setId: setIdRef.current, over: capped?.over ?? [] } : null);
      setFlow("review");
      return;
    }
    if (profile) {
      // Week-strip completion is marked FROM THE SESSION RECORD'S DATE, not
      // the wall clock. The record's date is stamped at draft creation, so a
      // session finished after midnight (start 23:40, finish 00:20) belongs
      // to the day it was started. Using new Date() here marked the NEXT
      // day complete — which then also appeared in missed workouts because
      // Days/history (correctly date-keyed below) had no record for it.
      // Found on device: the classic midnight in-and-out. commitSessionRecord
      // marks the day from the record (lib/session-commit.js).

      // "Back at it" gap — read the newest strength record BEFORE appending.
      {
        const prior = source.history()
          .filter(r => r?.date && isStrengthRecord(r))
          .map(r => r.date).sort().pop();
        if (prior) {
          const gap = daysBetween(prior, todayLocalIso());
          setReturnGapDays(gap > 7 ? gap : null);
        } else {
          setReturnGapDays(null);
        }
      }

      const sessionRecord = draftLogRef.current ? finaliseDraft(draftLogRef.current) : null;
      // The finish's writes (lib/session-source.js): the streak; then history,
      // the day, the engine and W/R through commitSessionRecord, THE engine
      // path (lib/session-engine, #16) shared with Keep; then the push of the
      // FULL canonical snapshot, never a hand-rolled subset. The old
      // hand-rolled payload omitted weightStamps/repStamps/trainingState/
      // bodyweight/breaks: stamp-less weights read as epoch and LOST the
      // server merge to the blob's older stamped values, and the engine state
      // never reached the blob at all (audit S1, re-verified 2026-07-15).
      sinks.finish(sessionRecord, {
        // Context only (a first-time lift's fallback weight): today's plan,
        // which is what these weights held when the drum wrote them.
        currentWeights: planWeights,
        repairedReps: repRepairs,
        // The draft goes once the record is in history and the day is marked.
        afterHistory: () => {
          draftLogRef.current = null;
          sinks.draft.clear();
        },
        // The engine's W/R go through the persisting setters, so the screen's
        // state and the store move together.
        saveWeights: (wwUpdates) => setWW(p => ({ ...p, ...wwUpdates })),
        saveReps: (wrUpdates) => setWR(p => ({ ...p, ...wrUpdates })),
        // After the writes, before the push. Home-screen mirrors re-derive
        // from LS when home remounts.
        onCommitted: (engine) => {
          if (engine?.justCompletedDeload) {
            setActiveDeload(null);
            setShowDeloadComplete(true);
          }
          try {
            // No readiness here: how a session felt is health data, and it
            // stays with the user (see /privacy).
            track("session_complete", {
              session: sessionRecord?.session || "strength",
              block: String(programmeBlock?.number ?? 1),
            });
          } catch {}
        },
      });
    }
    setFlow("done");
  };

  // Logged sets for the CURRENT block — the draft is an external mutable
  // store (logSet mutates the ref'd object), so it's mirrored into render
  // state by an effect keyed on every advance (set logged / block change /
  // resume). Powers the logged-set rows with their heat marks on the
  // session screen; for supersets the active exercise's side is shown.
  const [loggedSets, setLoggedSets] = useState([]);
  useEffect(() => {
    // Mirrors the mutable draft (external store) into render state after
    // each advance; keyed deps make it converge in one pass, no cascade.
    // A fresh wrapper each time, so readers re-derive from the mutated draft.
    setDraftView(draftLogRef.current ? { ...draftLogRef.current } : null);
    const saved = draftLogRef.current?.blocks?.[block?.id];
    if (!saved?.exercises) { setLoggedSets([]); return; }
    const ex = saved.exercises[activeEx?.name]
      ?? Object.values(saved.exercises)[0];
    setLoggedSets((ex?.sets || []).map(s => ({ weight: s.weight ?? null, reps: s.reps ?? null, rpe: s.rpe ?? null })));
  }, [flow, blockIdx, setNum, phase, block?.id, activeEx?.name]);

  // ─── Render ────────────────────────────────────────────────────────────────
  if (!flow) return null; // resolving entry (or bouncing)

  const sProps = {
    // Coached: the header names the client ("Strength A with Sam").
    session: coached && mode.name ? { ...activeSession, name: `${activeSession.name} with ${mode.name}` } : activeSession,
    block, blockIdx, totalBlocks: activeSession.blocks.length, setNum, phase, isSS,
    blockSets, nextExName, onNext: handleNext,
    backTo, onJumpToBlock: handleJumpToBlock,
    activeEx, resolvedExA, resolvedExB, resolvedEx,
    swapKey, onSwap,
    showVid, setShowVid, getW, getR, editTarget, setEditTarget,
    // The screen edits today's plan only; the prescription is read-only here
    // (the drum's dot marks it).
    planWeights, setPlanWeights: setSessionWeights, planReps, setPlanReps: setSessionReps,
    prescribedReps, coachLine: cardLine, travel,
    history, loggedSets,
    awaitRpe, ssRoundDone,
    restActive, restRemain, setRestActive, setRestRemain,
    onCommit: commitLog, onLog: handleLog, onQuit: handleQuit,
    onShowOverview: () => {
      setOverviewDraftSnapshot(draftLogRef.current);
      setSessionOverviewOpen(true);
    },
    bodyweight,
    addedLoads, setAddedLoad,
    canReach, reachStep, reachArmed, onTakeReach: takeReach, onDeclineReach: declineReach,
    // Coached: the plan says only that a deload is on.
    deloadDayTag: activeDeload ? (coached ? "deload" : deloadDayLabel(activeDeload)) : null,
    // Coached: a lift sends at most ten sets, so no eleventh is offered.
    maxSets: coached ? COACH_MAX_SETS : null,
  };

  return (
    <ErrorBoundary>
      {flow === "readiness" && (
        <ReadinessScreen
          readiness={readiness} setReadiness={setReadiness}
          reason={readinessReason} setReason={setReadinessReason}
          onStart={handleReadinessStart}
          travel={travel} setTravel={coached ? null : setTravel}
          planDay={coached && mode.name ? `${focusedSession?.name} with ${mode.name}` : focusedSession?.name} onHome={handleQuit}
        />
      )}
      {flow === "session" && <SessionScreen {...sProps} />}
      {flow === "review" && coached && (
        <CoachedReview key={review?.setId ?? "empty"} review={review} name={mode.name} title={focusedSession?.name ?? sessionNameOf(activeSessionIdx)}
          send={coachSinks.send} onFaceId={mode.onFaceId}
          onSetId={(id) => { setIdRef.current = id; coachSinks.draft.hold({ setId: id }); }}
          onBack={() => setFlow("session")}
          onSent={() => withNavTransition(() => router.replace(exitTo), "nav-back")}
          onDiscard={() => {
            // The trainer's confirmed Discard: this client's draft goes, nothing else.
            draftLogRef.current = null;
            coachSinks.discard();
            withNavTransition(() => router.replace(exitTo), "nav-back");
          }}/>
      )}
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
      {!coached && <BodyweightEditModal open={bwEditOpen} onClose={() => setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight} profileName={profile} />}
      {/* Final-set flash toast. Centred with left/right insets (no transform
          on the positioned element — fadeSlide's translateY would override
          translateX centring); the rise animation sits on the inner span.
          Non-interactive, floats 96px above the safe area — never paints the
          viewport edge, so the sheet/chin constraint doesn't apply. */}
      {/* bottom offset clears the thumb-pinned action zone (partner card +
          Log button) now the session layout anchors actions at the fold. */}
      {/* Always mounted: a live region inserted with its content is often
          not announced. */}
      <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{srMsg}</div>
      {setFlash && (
        <div style={{ position: "fixed", left: 0, right: 0, margin: "0 auto", width: "calc(100% - 64px)", maxWidth: 366, bottom: "calc(env(safe-area-inset-bottom,0px) + 190px)", pointerEvents: "none", zIndex: 60, textAlign: "center", opacity: flashLeaving ? 0 : 1, transition: "opacity 600ms ease" }}>
          {/* Vellum chip — the toast material. Sensation lives in the copy
              and the timing, not a third type voice. */}
          <span className="forge-vellum" style={{ display: "inline-block", animation: `fadeSlide 400ms ${T.ease}`, fontFamily: T.text, fontSize: 14, fontWeight: 500, color: T.ink, lineHeight: 1.45, borderRadius: 12, padding: "10px 16px", boxShadow: "0 10px 24px -14px rgba(36,28,25,0.35)" }}>{setFlash}</span>
        </div>
      )}
    </ErrorBoundary>
  );
}

// ─── Coached: Review, then Send ─────────────────────────────────────────────

/** @type {import("react").CSSProperties} */
const commitBtn = {
  width: "100%", height: 52, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer",
  fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong,
};
/** @type {import("react").CSSProperties} */
const outlineBtn = {
  width: "100%", height: 52, background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer",
  fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.ink,
};
/** @type {import("react").CSSProperties} */
const pageWrap = { maxWidth: 430, margin: "0 auto", padding: "52px 24px 48px" };
/** @type {import("react").CSSProperties} */
const nums = { fontVariantNumeric: "tabular-nums" };

const kgText = (kg) => String(Math.round(kg * 100) / 100);

/**
 * One exercise as Review lists it: "Back Squat · 100 × 5, 5, 5 · felt 8, 8, 9".
 * A pure bodyweight lift's weight is its added load ("+10").
 * @param {any} ex  a finalised exercise
 */
export function reviewLine(ex) {
  const sets = Array.isArray(ex?.sets) ? ex.sets : [];
  const bw = ex?.loadType === "bodyweight";
  const kg = (w) => (typeof w !== "number" || (bw && w <= 0) ? null : bw ? `+${kgText(w)}` : kgText(w));
  const reps = (st) => (st?.reps === null || st?.reps === undefined ? "–" : String(st.reps));
  const first = kg(sets[0]?.weight);
  const same = sets.every((st) => kg(st?.weight) === first);
  const body = same
    ? (first === null ? sets.map(reps).join(", ") : `${first} × ${sets.map(reps).join(", ")}`)
    : sets.map((st) => (kg(st?.weight) === null ? reps(st) : `${kg(st.weight)} × ${reps(st)}`)).join(", ");
  const felt = sets.map((st) => st?.rpe).filter((r) => typeof r === "number");
  return [ex?.name, body, felt.length ? `felt ${felt.join(", ")}` : null].filter(Boolean).join(" · ");
}

/**
 * The words for a send that didn't go. Never the server's text.
 * @param {{ status: number, body: any }} r
 * @param {{ name: string | null, title: string, dayWords: string }} c
 */
function sendWords(r, { name, title, dayWords }) {
  const b = r.body || {};
  const who = name || "them";
  const kept = "It's saved here.";
  if (r.status === 0) return "Not sent. It's saved here. Send when you're back online.";
  if (r.status === 403 && b.editsOff) return `Changes are off for ${who} now. Ask them to turn changes on in Profile. ${kept}`;
  if (r.status === 403 && b.fresh) return `Ask ${who} for a fresh code. ${kept}`;
  if (r.status === 404) return `Not shared with you now. ${kept}`;
  if (r.status === 409 && b.stale) return `${name ? `${name}'s` : "Their"} plan changed since this session started, so it can't be sent as it is. ${kept}`;
  if (r.status === 409 && (b.alreadySent || b.code === "already_sent")) return `You've already sent ${title} for ${dayWords}.`;
  const refusals = Array.isArray(b.refusals) ? b.refusals : [];
  if (r.status === 422 && refusals.some((x) => x?.code === "already_logged")) return `${name || "They"} already logged ${title} for ${dayWords}.`;
  // The day moved under an open Review (past midnight): a fresh Review re-reads it.
  if (r.status === 422 && refusals.some((x) => x?.code === "day")) return `That day can't be sent now. Go back and review it again to pick the day. ${kept}`;
  if (r.status === 422) return `Some of this is outside their limits, so it can't be sent. ${kept}`;
  if (r.status === 429 && (b.budget || b.full)) return `That's seven sessions with ${who} this week. ${kept}`;
  if (r.status === 429) return "Too many tries. Wait a minute, then try again.";
  return "That didn't send. Try again.";
}

/**
 * The end of a coached session: the sets, the day it was (today or
 * yesterday), and Send. A dry run goes first; the send carries the same set
 * id. Back returns to the session with every set as it was. "Discard this
 * session" asks once more, then removes this client's draft from the device
 * (onDiscard); it is there whether or not the session can still be sent.
 * @param {{
 *   review: { record: any, drum: Record<string, number>, setId: string, over?: string[] } | null,
 *   name: string | null, title: string,
 *   send: (s: { record: any, drum: Record<string, number>, setId: string, dryRun: boolean }) => Promise<{ status: number, body: any }>,
 *   onFaceId?: () => Promise<boolean | "unknown">, onSetId?: (id: string) => void, onBack: () => void, onSent: () => void,
 *   onDiscard: () => void,
 * }} props
 */
function CoachedReview({ review, name, title, send, onFaceId, onSetId, onBack, onSent, onDiscard }) {
  const record = review?.record ?? null;
  const exercises = (record?.blocks || []).flatMap((b) => b?.exercises || []);
  // The two days Send offers, each only where the route takes it: within a
  // day of when the session started (its id is that UTC instant).
  const [today] = useState(() => todayLocalIso());
  const yesterday = addDaysIso(today, -1);
  const startDay = typeof record?.id === "string" ? record.id.slice(0, 10) : null;
  const near = (d) => { const n = startDay && d ? daysBetween(startDay, d) : null; return n !== null && Math.abs(n) <= 1; };
  const days = /** @type {[string, string][]} */ ([["Today", today], ["Yesterday", yesterday]]).filter(([, d]) => near(d));
  const [day, setDay] = useState(() => days.find(([, d]) => d === record?.date)?.[1] ?? days[0]?.[1] ?? null);
  const [setId, setSetId] = useState(() => review?.setId ?? mintSessionSetId());
  // ready · sending · face
  const [phase, setPhase] = useState("ready");
  const [note, setNote] = useState("");
  const inFlight = useRef(false);
  const over = review?.over ?? [];
  const dayWords = (day && sessionDayWords(day, today)) || "that day";
  // Discard asks first. Focus follows the swap to the confirm and back.
  const [discarding, setDiscarding] = useState(false);
  const discardAskRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const discardRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const wasDiscarding = useRef(false);
  useEffect(() => {
    if (discarding) discardRef.current?.focus();
    else if (wasDiscarding.current) discardAskRef.current?.focus();
    wasDiscarding.current = discarding;
  }, [discarding]);

  const settle = (r) => {
    const b = r.body || {};
    if (r.status === 200 && b.sent) { onSent(); return; }
    if (r.status === 403 && b.needsFaceId) { setNote(""); setPhase("face"); return; }
    // The set id went with something else: a new one, and try again.
    if (r.status === 409 && (b.taken || b.code === "replay_mismatch")) {
      const id = mintSessionSetId();
      setSetId(id);
      onSetId?.(id);
    }
    setNote(sendWords(r, { name, title, dayWords }));
    setPhase("ready");
  };
  const run = async () => {
    if (inFlight.current || !record || !day || !review) return;
    inFlight.current = true;
    setNote("");
    setPhase("sending");
    const rec = recordOnDay(record, day);
    let r = await send({ record: rec, drum: review.drum, setId, dryRun: true });
    // A dry run that finds this day's session already sent goes on to the
    // send with the same set id: if it is this one (a send whose reply was
    // lost) the route replays it as sent; if not, it says already sent again.
    const mine = r.status === 409 && (r.body?.alreadySent || r.body?.code === "already_sent");
    if ((r.status === 200 && r.body?.preview) || mine) r = await send({ record: rec, drum: review.drum, setId, dryRun: false });
    else if (r.status === 200) r = { status: 500, body: {} };
    inFlight.current = false;
    settle(r);
  };
  const confirmIt = async () => {
    setNote("");
    const ok = await onFaceId?.().catch(() => false);
    // No trainer name on this page (a reload): the pane hands it over.
    if (ok === "unknown") { setNote(`Open ${name || "them"} again from your trainer page to confirm it's you. It's saved here.`); return; }
    if (!ok) { setNote("Face ID didn't go through. Try again."); return; }
    run();
  };

  const busy = phase === "sending";
  return (
    <div style={pageWrap}>
      <div style={{ fontSize: 13, color: T.ink2, marginBottom: 8 }}>Review</div>
      <h1 style={{ ...DISPLAY, fontSize: 34, color: T.ink, margin: "0 0 18px", lineHeight: 1.1 }}>
        {name ? `${title} with ${name}` : title}
      </h1>
      {exercises.length === 0 ? (
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.6, margin: "0 0 24px" }}>Nothing logged yet.</p>
      ) : (
        <ul aria-label="Sets" style={{ listStyle: "none", margin: "0 0 24px", padding: 0, borderTop: `1px solid ${T.rule}` }}>
          {exercises.map((ex, i) => (
            <li key={`${ex.name}:${i}`} style={{ padding: "12px 0", borderBottom: `1px solid ${T.ruleFaint}`, fontSize: 15, color: T.ink, lineHeight: 1.45, ...nums }}>
              {reviewLine(ex)}
            </li>
          ))}
        </ul>
      )}
      {over.length > 0 && (
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "0 0 18px" }}>
          {over.length === 1 ? `Only the first ten sets of ${over[0]} go.` : "Only the first ten sets of each lift go."} Ten is the most for one lift.
        </p>
      )}
      {exercises.length > 0 && (days.length ? (
        <div role="group" aria-label="Which day" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: T.ink3, marginBottom: 10 }}>Which day was it?</div>
          <div style={{ display: "flex", gap: 8 }}>
            {days.map(([label, d]) => {
              const sel = day === d;
              return (
                <button key={d} type="button" className="forge-press" aria-pressed={sel} disabled={busy}
                  onClick={() => { haptic.toggle(); setDay(d); }}
                  style={{ flex: 1, height: 44, borderRadius: T.rSm, cursor: "pointer", fontFamily: T.text, fontSize: 15,
                    fontWeight: sel ? 500 : 400, color: sel ? T.ink : T.ink2, background: sel ? T.surface : "transparent",
                    border: `1px solid ${sel ? "transparent" : T.rule}`, boxShadow: sel ? T.elev : "none" }}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.6, margin: "0 0 20px" }}>
          Too old to send. It started {(record?.date && sessionDayWords(record.date, today)) || "more than a day ago"}.
        </p>
      ))}
      {exercises.length > 0 && days.length > 0 && (
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "0 0 18px" }}>
          {name ? `${name} sees` : "They see"} it next time they open the app. It&apos;s kept after five hours unless they say otherwise.
        </p>
      )}
      <div role="status" aria-live="polite" style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, marginBottom: 12 }}>
        {phase === "face" ? (note || "Confirm it's you to send.") : phase === "sending" ? "Sending" : note}
      </div>
      {exercises.length > 0 && days.length > 0 && (phase === "face" ? (
        <button type="button" onClick={confirmIt} style={commitBtn}>Confirm it&apos;s you</button>
      ) : (
        <button type="button" onClick={run} aria-disabled={busy} data-send=""
          style={{ ...commitBtn, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>
          {busy ? "One moment" : name ? `Send to ${name}` : "Send"}
        </button>
      ))}
      <button type="button" onClick={() => { if (!busy) onBack(); }} className="forge-press forge-tint"
        style={{ ...outlineBtn, marginTop: 10 }}>
        Back to the session
      </button>
      {!discarding ? (
        <button type="button" ref={discardAskRef} onClick={() => { if (!busy) setDiscarding(true); }}
          style={{ display: "block", width: "100%", minHeight: 44, marginTop: 14, background: "none", border: "none", cursor: "pointer", fontFamily: T.text, fontSize: 14, color: T.ink3 }}>
          Discard this session
        </button>
      ) : (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${T.rule}` }}>
          <p style={{ fontSize: 14, color: T.ink, lineHeight: 1.5, margin: "0 0 14px" }}>
            Discard this session? It&apos;s removed from this device.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            {/* Not while a send is in flight: it could still land. */}
            <button type="button" ref={discardRef} onClick={() => { if (busy || inFlight.current) return; haptic.tap(); onDiscard(); }}
              style={{ flex: 1, height: 48, background: T.ground, border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.ink }}>
              Discard
            </button>
            <button type="button" onClick={() => setDiscarding(false)}
              style={{ flexShrink: 0, height: 48, padding: "0 18px", background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 14, color: T.ink2 }}>
              Keep editing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Coached: the /trainer/coach page ───────────────────────────────────────

/** JSON in, { status, body } out; status 0 when the network failed. */
async function call(path, body) {
  try {
    const res = await fetchWithTimeout(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, body: {} };
  }
}

/**
 * The pane's hand-off: ref and letter from the fragment only, which never
 * reaches a server or analytics (components/AnalyticsScrubbed.jsx). A ref in
 * the query is not read. Else the ones this history entry holds (a reload).
 * @returns {{ ref: string | null, letter: string | null, inUrl: boolean }}
 */
function coachParams() {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const held = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
  const str = (v) => (typeof v === "string" && v ? v : null);
  return {
    ref: str(h.get("ref")) ?? str(held.coachRef),
    letter: str(h.get("letter")) ?? str(held.coachLetter),
    inUrl: !!(window.location.search || window.location.hash),
  };
}

/**
 * /trainer/coach: a client's session, run on the trainer's device. A draft
 * of this client's on the device resumes from its cached plan with no
 * network; otherwise one look at the client (POST /api/trainer/client) gives
 * the plan. The grant ref leaves the address bar as soon as it is read and
 * stays in this history entry's state, so a reload reopens the same client.
 * With neither, the draft saved last resumes.
 */
export function CoachedSessionPage() {
  const router = useRouter();
  // null: opening · { mode } · { text }
  const [state, setState] = useState(/** @type {{ mode?: any, text?: string } | null} */ (null));
  const opened = useRef(false);

  /* eslint-disable react-hooks/set-state-in-effect -- mount-once: reads the
     URL hand-off and the device's coached draft, then the client's plan. */
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const params = coachParams();
    const ref = params.ref ?? CD.latest();
    // History state, not a store: it lives and goes with this tab's entry.
    if (params.inUrl || ref) {
      window.history.replaceState({ ...(window.history.state || {}), coachRef: ref, coachLetter: params.letter }, "", "/trainer/coach");
    }
    if (!ref) { setState({ text: "Open a client on your trainer page to run a session with them." }); return; }
    const post = (body) => call("/api/trainer/change", { ...body, ref, today: todayLocalIso() });
    // Face ID for a send: the quiet sign-in again, for the trainer signed in.
    const onFaceId = async () => {
      const name = coachTrainer.get();
      if (!name) return "unknown";
      let auth;
      try {
        const { authenticatePasskey } = await import("@/lib/webauthn");
        auth = await authenticatePasskey(name, { quiet: true });
      } catch {
        return false;
      }
      if (!auth?.authToken) return false;
      const r = await call("/api/trainer/session", { authToken: auth.authToken, profile: name });
      return r.status === 200;
    };
    const entry = CD.load(ref);
    if (entry) {
      setState({ mode: { kind: "coached", ref, name: entry.name ?? null, letter: entry.letter, plan: entry.plan, view: null, entry, post, onFaceId } });
      return;
    }
    call("/api/trainer/client", { ref, today: todayLocalIso() }).then((r) => {
      const b = r.body || {};
      const name = typeof b.client?.name === "string" && b.client.name ? b.client.name : null;
      const who = name || "them";
      const plan = b.view?.plan;
      if (r.status === 200 && !b.self && plan?.programme && Array.isArray(plan.lifts)) {
        const idx = letterIndex(params.letter);
        const letter = letterOf(idx >= 0 ? idx : nextStrengthIdx(b.view.sessions || []));
        setState({ mode: { kind: "coached", ref, name, letter, plan, view: b.view, entry: null, post, onFaceId } });
      } else if (r.status === 200 && b.view?.edits === "off") {
        setState({ text: `Changes are off for ${who}. Ask them to turn changes on in Profile.` });
      } else if (r.status === 200 && b.view?.edits === "fresh") {
        setState({ text: `Ask ${who} for a fresh code to run a session with them.` });
      } else if (r.status === 404) {
        setState({ text: "Not shared with you now." });
      } else if (r.status === 401) {
        setState({ text: "Sign in on your trainer page first." });
      } else if (r.status === 403 && b.needsTerms) {
        setState({ text: "Agree to the updated Trainer Terms on your trainer page first." });
      } else if (r.status === 0) {
        setState({ text: "You're offline. Open it again when you're back." });
      } else {
        setState({ text: "Couldn't open that just now." });
      }
    });
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (state?.mode) return <SessionHost mode={state.mode}/>;
  return (
    <div style={pageWrap}>
      <button type="button" onClick={() => withNavTransition(() => router.replace("/trainer"), "nav-back")}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2, marginBottom: 22, display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Glyph name="arrowLeft" size={12} color={T.ink3}/> Your clients
      </button>
      <div role="status" style={{ fontSize: 15, color: state ? T.ink : T.ink3, lineHeight: 1.6 }}>
        {state?.text ?? "One moment"}
      </div>
    </div>
  );
}
