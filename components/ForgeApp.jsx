"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import {
  WEEK, SESSIONS, deriveStrengthDaySessions,
  EXERCISE_POOLS, rotateAccessories, rotationDiff, pushHistoryBlock, computeRotationStimulusDelta,
  dedupeRotationConfig,
  ROTATION_OPTIONAL, ROTATION_AUTO, ROTATION_FORCED,
  SWAP_DB, EQ_COLOUR,
  FOCUS_OPTIONS, DEFAULT_FOCUS, FOCUS_SUMMARIES, applyFocusToSession, applyRotationToSession, applySwapsToSession,
  // Retrospective logging helpers (compute past-date programme metadata + missing-day detection)
  sessionMetaForDate, findRecentDays, hasMissedStrength, findUntickedRecent, weekdayIdxForDate,
} from "@/lib/programme";
import {
  LS, P, PB, W, F, H, BW, PN, Days, bumpStreak,
  computeRhythm, detectRecoveryPattern,
  blobPush, flushPendingPushes, getLocalProfile, backgroundSync, SyncStatus,
  enableAutoSync, disableAutoSync, pushNow, pushDeferred,
  applyRpe, weeksSince, dateOfWeekdayIdxInCurrentWeek,
  newDraftLog, logSet, finaliseDraft, scaleForReadiness, D, TS,
  inferLoadType, LOAD_TYPES, startingWeightForLift,
} from "@/lib/storage";
import { T, MUSCLE_COLOURS } from "@/lib/tokens";
import {
  computeNextPrescription,
  updateLiftStateFromSession,
  updateMuscleAnchorFromSession,
  reconcileLiftStateWithSession,
  // Phase 3
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
} from "@/lib/progression";
import { getLiftProfile, sanitiseWorkingWeights } from "@/lib/lift-translations";
import {
  isWebAuthnSupported, isPlatformAuthenticatorAvailable,
  registerPasskey, hasPasskey,
} from "@/lib/webauthn";
import { track } from "@vercel/analytics";
import {
  computeVolumeAggregates, recentForExercise,
  totalTonnage, pendingTonnageMilestone, formatTonnage,
} from "@/lib/analytics";
import { useModalA11y, haptic } from "@/lib/a11y";
import ErrorBoundary from "@/components/ErrorBoundary";
import { Fade, Card, Tag, CARD_SHADOW } from "@/components/ui";
import ScrollDrum from "@/components/ScrollDrum";
import BodyweightEditModal from "@/components/BodyweightEditModal";
import ProfileScreen from "@/components/ProfileScreen";
import FocusPickerSheet from "@/components/FocusPickerSheet";
import HomeScreen from "@/components/HomeScreen";
import { activateProfileCore, saveFocusCore, takePendingRotationSummary } from "@/lib/profile-actions";


// ─── Shared helper: resolve load type for an exercise ────────────────────────
// Used by both the session-finalise logger (in pushSetToDraft) and the session
// screen render. Centralises the "honour ex.loadType if set, otherwise infer
// from name" pattern so both call sites can't drift.
function getLoadType(ex) {
  return ex?.loadType || inferLoadType(ex?.name);
}

// Real-world implement increments per loadType. Dumbbells rarely come in
// fractional kg — most racks step in whole kg from 2-30kg then 2.5kg above.
// Cable stacks are typically pinned at 2.5kg per plate. Barbells take micro-
// plates as small as 1.25kg. Bodyweight has no scale. Used by every drum that
// edits a weight so the scroll feels honest to what you can actually load.
function weightStepForLoadType(lt) {
  if (lt === "per_db")            return 1;     // most DB racks step in whole kg
  if (lt === "cable" || lt === "total") return 2.5;  // pin-loaded stacks
  if (lt === "bodyweight" || lt === "loaded_bodyweight" || lt === "assisted_bodyweight") return 1.25;
  return 1.25;  // barbell / external default
}

// Detect a "timed" prescription string like "20s", "30sec", "1m". Returns
// either { seconds: 20 } for a parseable duration or null for everything
// else. Lets the session screen show "20s · hold" instead of "20 reps",
// and lets the drum edit overlay swap its unit to seconds. The string
// form lives in the pool data (L-Sit Hold reps:"20s"); when a user
// overrides via the drum we store an integer alongside — same shape as
// numeric reps — and treat it as seconds whenever the prescribed value
// was originally timed.
function parseTimedReps(reps) {
  if (typeof reps !== "string") return null;
  const m = reps.trim().match(/^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const seconds = unit.startsWith("m") ? n * 60 : n;
  return { seconds };
}


// What does the number the user types represent? Resolves the per-DB vs
// total-load ambiguity the picker has historically left implicit. Two
// vocabularies coexist: programme.js entries carry "barbell"/"per_db"/
// "total"/"machine"/"loaded_bw"/"bodyweight"; storage.js inference can
// also produce "external"/"loaded_bodyweight"/"assisted_bodyweight" for
// exercises without an explicit programme.js loadType. We cover both.
// "bodyweight" intentionally has no caption — the picker hides the weight
// field entirely for those.
const WEIGHT_CAPTIONS = {
  barbell:               "weight on the bar",
  per_db:                "weight per dumbbell",
  total:                 "total weight",
  machine:               "machine stack weight",
  loaded_bw:             "added weight",
  loaded_bodyweight:     "added weight",
  assisted_bodyweight:   "band assistance",
};

// ScrollDrum now lives in components/ScrollDrum.jsx (PR3 3c).

// SyncStatusCard + SyncNowRow now live in components/sync-cards.jsx (PR3 3c).

// ─── Root ──────────────────────────────────────────────────────────────────────
export default function ForgeApp(){
  const [mounted,setMounted]=useState(false);
  // Canonical SSR client-mount guard: fires once, no cascade. Intentional.
  useEffect(()=>setMounted(true),[]);

  // Next router — PR3 real-routes migration. Screens that have become real
  // routes (Performance Lab → /performance) navigate via soft client routing
  // (no document reload, no shimmer) rather than setScreen state.
  const router = useRouter();

  const [activeProfile,setActiveProfileState]=useState(()=>typeof window!=="undefined"?P.getActive():null);
  // showProfiles retired (PR3 3d-route): the switch/settings surface is the
  // /profile route now; this gate renders only when there is NO profile.

  // Hydrating state — blocks the home screen render while we pull the user's
  // training data from blob storage. Critical because localStorage is
  // per-context (PWA vs Safari are separate sandboxes on iOS), so a returning
  // user opening the app on a different surface has empty localStorage until
  // the blob round-trip completes. Without this, the UI flashes "no history"
  // for ~500ms-2s before the data lands, which makes users think the app
  // has lost their data and forces them to close-reopen.
  //
  // Defaults to true when an activeProfile is already set on mount (returning
  // user) and stays true until the activation effect's blob sync resolves.
  const [hydrating,setHydrating]=useState(()=>{
    if (typeof window === "undefined") return false;
    return P.getActive() !== null;
  });
  const [streak,setStreak]=useState(0); // retained for compat — now derived from history, see useMemo below
  const [screen,setScreenRaw]=useState(()=>{
    if (typeof window === "undefined") return "home";
    return LS.get("forge:onboarded", false) ? "home" : "onboarding";
  });
  // Screen swap wrapped in the View Transitions API where supported (Safari
  // 18.2+, Chrome 111+). On unsupported runtimes (older Safari, jsdom in
  // tests, SSR) this falls straight through to a plain setState — no
  // behaviour change, just a slide swap where the platform lets us.
  // flushSync forces React to commit the state change inside the callback
  // so the browser can snapshot before/after frames; without it, React
  // 19's deferred batching would skip the transition entirely.
  //
  // Direction: forward (slide up from below) for any destination, back
  // (old slides down off the bottom) when returning to home. The "back"
  // view-transition-type is matched by :active-view-transition-type(back)
  // rules in globals.css. Heuristic is intentionally simple — every screen
  // exits to home, so "next === home" cleanly captures the back direction
  // without needing a navigation history stack.
  //
  // Reduced-motion users: prefers-reduced-motion is honoured at the CSS
  // layer (animation-duration → 0.01ms) so the swap still happens, instantly.
  const setScreen = useCallback((next) => {
    if (typeof document === "undefined" || !document.startViewTransition) {
      setScreenRaw(next);
      return;
    }
    document.startViewTransition({
      update: () => flushSync(() => setScreenRaw(next)),
      types: [next === "home" ? "back" : "forward"],
    });
  }, []);
  const [activeSessionIdx,setActiveSessionIdx]=useState(0);
  const [sessionSwaps,setSessionSwaps]=useState({});
  const [programmeBlock,setProgrammeBlock]=useState(()=>PB.get());
  const [weekDone,setWeekDone]=useState({});
  // Date-keyed { [ISO date]: true }. Source of truth for "this day is done."
  // Strength session finalises auto-write it; non-strength Mark ✓ writes it
  // explicitly; cross-week back-marking just works because the key is the
  // date, not the weekday-of-current-week. weekDone stays as a derived
  // projection for the home week strip to render against without re-deriving
  // the math at every cell.
  const [dayDone,setDayDone]=useState({});
  const [bonusDone,setBonusDone]=useState({});
  const [userFocus,setUserFocus]=useState(DEFAULT_FOCUS);
  const [focusPickerOpen,setFocusPickerOpen]=useState(false);
  const [blockIdx,setBlockIdx]=useState(0);
  const [setNum,setSetNum]=useState(1);
  const [phase,setPhase]=useState("A");
  // Session overview — lets users jump between blocks when gym constraints
  // dictate a different order than the prescribed flow. Auto-advance still
  // happens; this is the escape hatch.
  const [sessionOverviewOpen,setSessionOverviewOpen]=useState(false);
  const [readiness,setReadiness]=useState(null);
  const [readinessReason,setReadinessReason]=useState(null);
  const [showVid,setShowVid]=useState(false);
  const [editTarget,setEditTarget]=useState(null);
  const [awaitRpe,setAwaitRpe]=useState(false);
  const [ssRoundDone,setSsRoundDone]=useState(false);
  const [workingWeights,setWWState]=useState({});
  const [workingReps,setWRState]=useState({});
  const [restActive,setRestActive]=useState(false);
  const [restRemain,setRestRemain]=useState(180);
  const [restTrigger,setRestTrigger]=useState(null);
  // Append-only session log built during an active session
  const draftLogRef = useRef(null);
  // Snapshot of workingWeights at SESSION START. State (not ref) because the
  // DoneScreen consumes it during render. Set in handleReadinessStart /
  // handleResumeDraft. Without this, the Done summary compared the user's
  // current (post-progression) weight against the static SESSIONS template
  // default — so a user training at 100kg Bench for weeks saw "50 → 100kg"
  // every session ("base" = template default 50kg). Now base = what the
  // user lifted at the start of this session; if the engine bumped weight
  // after the session, the diff is real.
  const [sessionStartWeights, setSessionStartWeights] = useState({});
  // Snapshot of the in-progress draft log, captured when the overview sheet
  // opens. State (not ref) for the same render-time-readability reason — the
  // sheet displays "sets done per block" at open time; subsequent set-logs
  // while the sheet is open don't need to live-update (user is mid-jump).
  const [overviewDraftSnapshot, setOverviewDraftSnapshot] = useState(null);
  // Shown when auto-rotation fires — acknowledge before starting session
  const [rotationSummary,setRotationSummary]=useState(null);
  // Preview-before-commit for user-initiated rotation. Holds the candidate
  // computed by computeRotationPreview(); null = sheet closed. Re-rolling
  // replaces the candidate; confirm commits it; cancel drops it (engine
  // state stays untouched because computeRotationPreview never mutates).
  const [rotationPreview,setRotationPreview]=useState(null);
  // Full session history — loaded from localStorage, merged from blob
  const [history,setHistory]=useState([]);
  // Anti-dysmorphia: dismiss-once-per-render for recovery nudge
  const [recoveryDismissed,setRecoveryDismissed]=useState(false);
  // PWA install prompt (iOS needs custom UI; Android gets the OS prompt for free)
  const [showIosInstall,setShowIosInstall]=useState(false);
  // Sync status for subtle UI indicator
  const [syncState,setSyncState]=useState("idle"); // "idle" | "pulling" | "pushing" | "error"
  // In-flight draft from a prior, interrupted session — shown as a resume card on home
  const [pendingDraft,setPendingDraft]=useState(null); // { draft, ageMs, setCount } | null
  // Bodyweight state — loaded from BW helper, used for bodyweight movements
  const [bodyweight,setBodyweightState]=useState(null); // current BW in kg or null
  const [bwIsStale,setBwIsStale]=useState(false); // true if BW > 14 days old or never set
  const [bwCardDismissed,setBwCardDismissed]=useState(false); // in-memory dismiss for this session
  const [bwEditOpen,setBwEditOpen]=useState(false); // BW edit modal state
  const [bwPromptedThisSession,setBwPromptedThisSession]=useState(false); // only prompt once per session

  // Phase 3 — Deload state. Driven by training-state mesocycle subtree.
  //   activeDeload: when set, every prescribed weight is deloaded + carries the day-N tag.
  //   deloadOffer: signal object when an offer should surface on home; null when not.
  //   showDeloadComplete: one-shot flag for "Deload complete. Welcome back." on Done screen.
  const [activeDeload,setActiveDeload]=useState(null); // { startedAt, plannedDays, ... } | null
  const [deloadOffer,setDeloadOffer]=useState(null);   // signal object | null
  const [showDeloadComplete,setShowDeloadComplete]=useState(false); // one-shot for Done screen
  // One-shot for the Done screen's "Back at it" praise: days since the
  // PREVIOUS strength session, computed in the done effect BEFORE the new
  // record is appended (afterwards the newest record is today's and the gap
  // is always 0). null = no praise (regular cadence or first-ever session).
  const [returnGapDays,setReturnGapDays]=useState(null);

  // Retrospective logging state. Driven from the home picker — when retroDate
  // is set the app jumps to a single-screen form pre-populated from the
  // programme rotation for that date. After submit, the record lands in
  // history and runs through the same finalise pipeline as a live session.
  // 3-day rolling window — anything older is archaeology, not gap-filling.
  const [retroPickerOpen,setRetroPickerOpen]=useState(false);
  const [retroDate,setRetroDate]            =useState(null); // ISO YYYY-MM-DD or null
  const [retroToast,setRetroToast]          =useState(null); // { date, sessionName } | null

  // Passkey nudge state. PN.stage(profile) returns "chip" | "card" | "hidden",
  // recomputed from createdAt + snoozedUntil + current time. We pull it once
  // per profile activation + once per home-screen render trigger and store
  // the effective stage here so the UI can subscribe without re-reading LS.
  // Also tracks the WebAuthn support flag and the registration ceremony state
  // so the home nudge can register a passkey directly without bouncing through
  // ProfileScreen — every extra tap leaks conversion.
  const [pnStage,setPnStage]               =useState("hidden");
  const [pnWebAuthnSupported,setPnWebAuthnSupported]=useState(false);
  const [pnHasPasskey,setPnHasPasskey]     =useState(false);
  const [pnBusy,setPnBusy]                 =useState(false);
  const [pnError,setPnError]               =useState(null);
  const [pnSuccessToast,setPnSuccessToast] =useState(false);

  // Subscribe to sync status changes
  useEffect(() => {
    return SyncStatus.subscribe(status => setSyncState(status.state));
  }, []);

  // Rhythm — derived from history, no persistence needed
  const rhythm = useMemo(() => computeRhythm(history), [history]);
  const recoveryNudge = useMemo(
    () => (recoveryDismissed ? null : detectRecoveryPattern(history)),
    [history, recoveryDismissed]
  );

  // Silent migration for cross-slot duplicate rotation picks. Pools overlap
  // (Leaning Lateral Raise lives in both bfin-B and css1-B) so two
  // independent picks could land on the same exercise — re-rolls the later
  // slot from its pool excluding the claimed name. Returns input reference
  // when nothing needs changing; cheap guard keeps this from looping.
  //
  // The stale-name prune (pruneStaleRotationConfig) was retired here: the
  // session derivation chain (rawSession → applyRotationToSession → ...)
  // self-heals at read time so the ghost-pick problem is solved without
  // mutating storage. Prune is still exported for callers that want clean
  // persisted state, just no longer wired here.
  // mutation-audit: exempt — silent read-time dedupe migration. Runs on every
  // programmeBlock change; pushing on each render that triggers it would
  // be excessive (and unnecessary since the dedupe is deterministic — every
  // device reaches the same state on read, so eventual consistency holds).
  useEffect(() => {
    if (!activeProfile || !programmeBlock?.config) return;
    const deduped = dedupeRotationConfig(programmeBlock.config, programmeBlock.history, { focus: userFocus });
    if (deduped === programmeBlock.config) return;
    const next = { ...programmeBlock, config: deduped };
    setProgrammeBlock(next);
    PB.save(next);
  }, [activeProfile, programmeBlock, userFocus]);

  // Lifetime-tonnage milestone. Recomputes on every history change (cheap — O(n)
  // over sessions). When the user crosses a new milestone, a small card surfaces
  // on home as a once-per-threshold celebration. Tap dismisses, persists the
  // milestone so it doesn't reappear. No backfill — the first time we see a
  // user above a threshold, that threshold becomes their "highest seen" and the
  // next one upwards is the next surprise.
  const [tonnageMilestoneSeen, setTonnageMilestoneSeen] = useState(0);
  useEffect(() => {
    setTonnageMilestoneSeen(LS.get("forge:tonnageMilestoneSeen", 0));
  }, []);
  const totalKg = useMemo(() => totalTonnage(history), [history]);
  const pendingMilestone = useMemo(
    () => pendingTonnageMilestone(totalKg, tonnageMilestoneSeen),
    [totalKg, tonnageMilestoneSeen]
  );
  const handleDismissTonnageMilestone = () => {
    if (!pendingMilestone) return;
    LS.set("forge:tonnageMilestoneSeen", pendingMilestone);
    setTonnageMilestoneSeen(pendingMilestone);
  };

  // Retro discoverability — only surface the "Log past session" link on home
  // when there's actually something to fill. If the user trained every strength
  // day in the last 3, the link stays hidden and home stays calm. Recomputed
  // automatically as history grows.
  // User-customised week (per-device). useState so the editor sheet can
  // commit a new week and have the home strip / retro / done screens reflow
  // without a reload. Falls back to the default WEEK when nothing is stored.
  const [userWeek, setUserWeek] = useState(() => W.get() || WEEK);

  const strengthDaySessions = useMemo(() => deriveStrengthDaySessions(userWeek), [userWeek]);
  // Single source of truth for catch-up state. dayDone is date-keyed
  // (`{ "2026-06-13": true, ... }`) — strength session finalises write it,
  // the Mark ✓ path writes it explicitly. findUntickedRecent returns the
  // actionable list (date + type + "log"/"tick" hint). Link surfaces when
  // length > 0; picker drives off the same list; count goes into the
  // editorial label so the user knows the scope up front.
  const untickedDays = useMemo(
    () => findUntickedRecent(history, 7, dayDone, { week: userWeek }),
    [history, dayDone, userWeek]
  );
  const hasRetroGaps = untickedDays.length > 0;
  const [weekEditorOpen, setWeekEditorOpen] = useState(false);
  const handleSaveWeek = (newWeek) => {
    W.save(newWeek);
    setUserWeek(W.get() || WEEK); // re-read so state mirrors the persisted/normalised shape
    setWeekEditorOpen(false);
    pushNow(activeProfile);
  };
  const handleResetWeek = () => {
    W.reset();
    setUserWeek(WEEK);
    setWeekEditorOpen(false);
    pushNow(activeProfile);
  };

  // Seed on profile change: instant load from localStorage, background sync from blob
  useEffect(()=>{
    if(!activeProfile) return;
    
    // INSTANT: Load from localStorage (0ms, works offline)
    const local = getLocalProfile(activeProfile);
    // One-shot handoff: if focus was changed on the /profile route, the
    // rotation summary was stashed for us (the modal lives on this shell).
    const pendingSummary = takePendingRotationSummary(activeProfile);
    if (pendingSummary) setRotationSummary(pendingSummary);
    // Hydrating React state from the localStorage cache on profile change —
    // synchronising with an external store, which is exactly what effects are
    // for. The seed runs once per profile, no cascade. Intentional.
    // Sanity-clamp wildly-out-of-range workingWeights at load (defensive
    // against corruption from earlier bugs — e.g. 110kg recommendation for
    // an isolation movement). Only clamps values > 1.5× category cap.
    const rawWeights = local.meta.weights || {};
    const sanitisedWeights = sanitiseWorkingWeights(rawWeights);
    if (sanitisedWeights !== rawWeights) {
      P.saveWeights(activeProfile, sanitisedWeights);
    }
    setWWState(sanitisedWeights);
    setWRState(local.meta.reps || {});
    setStreak(local.meta.streak?.count || 0);
    setProgrammeBlock(local.meta.programmeBlock || PB.get());
    // Completion reads now come from the unified Day entity (date-keyed,
    // type-stamped at mark time). weekDone = any completion this week
    // (strength session OR manual non-strength tick); bonusDone = bonus
    // marks this week; dayDone = manual non-strength ticks by date (feeds
    // the retro picker). A schedule edit can't change a stored Day, so
    // completion no longer drifts when the week is reshaped.
    {
      const proj = Days.projectCurrentWeek(activeProfile);
      setWeekDone(proj.complete);
      setBonusDone(proj.bonus);
      setDayDone(Days.manualTickDates(activeProfile));
    }
    setUserFocus(F.get(activeProfile));
    setHistory(local.history || []);

    // Retry any failed pushes from previous sessions
    flushPendingPushes((profile) => ({
      meta: {
        weights: P.getWeights(profile),
        reps: P.getReps(profile),
        streak: P.getStreak(profile),
        programmeBlock: PB.get(),
      },
      history: H.get(profile),
    }));

    // Cancellation flag — if this effect cleans up (e.g. user switches
    // profiles before the sync resolves), we ignore the late callback to
    // avoid setting state after unmount or polluting the new profile's view.
    let cancelled = false;

    // BACKGROUND: Sync from blob, update state if remote has newer data
    const onSyncUpdate = ({ meta, history: remoteHistory }) => {
      if (cancelled) return;
      // Blob had newer data — update React state silently (clamping any
      // wildly-out-of-range weights along the way; see sanitiseWorkingWeights)
      if (meta.weights) {
        const sanitised = sanitiseWorkingWeights(meta.weights);
        if (sanitised !== meta.weights) P.saveWeights(activeProfile, sanitised);
        setWWState(sanitised);
      }
      if (meta.reps) setWRState(meta.reps);
      if (meta.streak?.count) setStreak(meta.streak.count);
      if (meta.programmeBlock) setProgrammeBlock(meta.programmeBlock);
      if (remoteHistory?.length) setHistory(remoteHistory);
    };

    // BLOCKING sync — await blob round-trip before unblocking the UI. On
    // error, still unblock (we'll show whatever's in localStorage — a
    // recoverable error state, not a frozen UI).
    backgroundSync(activeProfile, { onUpdate: onSyncUpdate })
      .then(() => { if (!cancelled) setHydrating(false); })
      .catch((e) => {
        console.error("[forge:hydrate]", e);
        if (!cancelled) setHydrating(false);
      });

    // Enable auto-sync on visibility change and online events.
    // The third arg is the "push current snapshot" callback — fires on
    // visibilitychange=hidden and pagehide so a backgrounding event is a
    // durability checkpoint, not a data-loss window.
    enableAutoSync(activeProfile, onSyncUpdate);

    // Check for an interrupted session — surfaces as a resume card on home
    const interrupted = D.load(activeProfile);
    setPendingDraft(interrupted);

    // Load bodyweight state
    const bw = BW.getKg(activeProfile);
    setBodyweightState(bw);
    setBwIsStale(BW.isStale(activeProfile));

    // Phase 3 — hydrate deload state from training state
    // activeDeload tells the session screen to show the "deload · day N" tag.
    // shouldOfferDeload checks signals + cooldowns to decide if the home card surfaces.
    try {
      const ts = TS.get(activeProfile);
      const fullHist = H.get(activeProfile);
      setActiveDeload(ts?.mesocycle?.activeDeload || null);
      setDeloadOffer(shouldOfferDeload(ts, fullHist));
    } catch (e) {
      console.error("[forge:phase3-hydrate]", e);
    }

    // Passkey nudge — hydrate stage + WebAuthn capability + current passkey state.
    // PN.init is idempotent so calling it on every activation is safe; for a
    // returning user it's a no-op, for a brand-new profile (claimed via
    // ProfileScreen → first appearance here) it seeds the createdAt timestamp
    // that drives the chip→card escalation.
    PN.init(activeProfile);
    setPnStage(PN.stage(activeProfile));
    isPlatformAuthenticatorAvailable().then(supported => {
      setPnWebAuthnSupported(supported);
      // Capability gate — if the device can't do WebAuthn, hide the nudge
      // entirely. No point asking for something that can't be delivered.
      if (!supported) setPnStage("hidden");
    });
    hasPasskey(activeProfile).then(has => {
      setPnHasPasskey(has);
      // If they already have a passkey, the nudge is moot — hide forever.
      if (has) setPnStage("hidden");
    });

    return () => {
      cancelled = true;
      disableAutoSync();
    };
  },[activeProfile]);

  // Rest timer tick
  useEffect(()=>{
    if(!restActive) return;
    if(restRemain<=0){
      // Countdown reached zero — stop the timer. State machine driven by the
      // tick below; not a render-cascade. Intentional.
      setRestActive(false);
      // Haptic: Android fires; iOS Safari silently no-ops (returns false).
      // Wrapped defensively — some browsers throw on invocation without
      // a prior user gesture (shouldn't happen here since timer started
      // from a button tap, but belt-and-braces).
      haptic.alert();  // rest timer expired — felt, not just shown
      return;
    }
    const t=setTimeout(()=>setRestRemain(p=>p-1),1000);
    return()=>clearTimeout(t);
  },[restActive,restRemain]);

  // PWA install prompt — iOS needs a custom overlay because Safari has no
  // beforeinstallprompt event. Android/Chrome handles this natively via
  // the manifest, so we only target iOS Safari here.
  //
  // Trigger rule: after the user has completed ≥1 session and isn't already
  // installed. Shown once, dismissable, remembered via localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!activeProfile) return;

    // Already dismissed in the past? Leave it alone.
    if (LS.get("forge:iosInstallDismissed", false)) return;

    // Not on iOS? Android handles the prompt natively via the manifest.
    const ua = window.navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    if (!isIOS) return;

    // Already installed (launched from home screen)?
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    if (isStandalone) return;

    // Gate on ≥1 completed session — don't nag new visitors
    if (history.length < 1) return;

    // Let the user settle on home for a beat before surfacing
    const t = setTimeout(() => setShowIosInstall(true), 1200);
    return () => clearTimeout(t);
  }, [activeProfile, history.length]);

  useEffect(()=>{
    if(!restTrigger) return;
    // Start the rest timer in response to a trigger fired from set-logging
    // handlers. Translating an external event into timer state. Intentional.
    setRestRemain(restTrigger.duration);
    setRestActive(true);
  },[restTrigger]);

  const setWW=useCallback((upd)=>{
    setWWState(prev=>{
      const next=typeof upd==="function"?upd(prev):upd;
      if(activeProfile) P.saveWeights(activeProfile,next);
      return next;
    });
  },[activeProfile]);
  const setWR=useCallback((upd)=>{
    setWRState(prev=>{
      const next=typeof upd==="function"?upd(prev):upd;
      if(activeProfile) P.saveReps(activeProfile,next);
      return next;
    });
  },[activeProfile]);

  const updateBodyweight = useCallback((kg) => {
    // Guard: no-op if profile isn't active yet (theoretical race during onboarding
    // where claimProfile resolved but the parent state hasn't reflected it).
    // We log so the case is visible in DevTools rather than failing silently.
    if (!activeProfile) {
      console.warn("[forge:updateBodyweight] no active profile — BW not saved", { kg });
      return;
    }
    if (!kg) return;
    BW.set(activeProfile, kg);
    setBodyweightState(kg);
    setBwIsStale(false);
    pushNow(activeProfile);
  }, [activeProfile]);

  // Open Performance Lab — triggers background sync first to hydrate from blob
  // if localStorage is stale (e.g. switching from PWA to Safari on same device).
  // Navigation happens immediately; sync runs in background and updates state
  // silently if newer data is found.
  // Performance Lab is now a real route (PR3 3a). Soft-navigate via the
  // router — the page reads history + runs its own background refresh on
  // mount, so the sync that used to live here moved there.
  const handleOpenPerformance = useCallback(() => {
    router.push("/performance");
  }, [router]);

  // Thin wrapper over the shared core (lib/profile-actions). The in-place
  // gate path reflects activation into React state directly; the /profile
  // route calls the same core then navigates home, where this component
  // remounts and hydrates from LS.
  const activateProfile = async (name, opts = {}) => {
    const result = await activateProfileCore(name, opts);
    if (result.ok) setActiveProfileState(result.name);
    return result;
  };

  // Scale session by readiness (cooked = 85% weight on mains, -1 set supersets, no finishers).
  // Three-step derivation: rotation config (substitutes the user's currently-
  // active accessory exercise per slot) → focus programming (Strong drops a
  // superset + shifts accessory reps; Sculpt bumps aligned slots + shifts
  // those reps) → readiness scaling (cooked = 85% weight, -1 superset set,
  // no finishers). Order matters: rotation first so focus/readiness operate
  // on the user's actual exercises; readiness last so it reshapes only
  // today's instance.
  // Single derivation chain. Order matters:
  //   raw template → rotation pick (with pool self-heal) → in-session swap →
  //   focus reshape → readiness scale.
  // SessionScreen and every other consumer read exercises straight off
  // `activeSession.blocks[i]` — the substitution has already happened. This
  // is the fix for the historical split-brain where the home overview saw
  // the resolved exercise but the in-session resolver re-resolved from raw
  // config and could pick up stale entries (DB Kickback ghost) or skip
  // pool validation.
  const rawSession = SESSIONS[activeSessionIdx];
  const rotatedSession = useMemo(
    () => applyRotationToSession(rawSession, programmeBlock?.config),
    [rawSession, programmeBlock?.config]
  );
  const swappedSession = useMemo(
    () => applySwapsToSession(rotatedSession, sessionSwaps),
    [rotatedSession, sessionSwaps]
  );
  const focusedSession = useMemo(
    () => applyFocusToSession(swappedSession, userFocus, programmeBlock?.config),
    [swappedSession, userFocus, programmeBlock?.config]
  );
  const activeSession = useMemo(
    () => scaleForReadiness(focusedSession, readiness),
    [focusedSession, readiness]
  );
  const block    = activeSession.blocks[blockIdx];
  const isSS     = block.type==="superset"||block.type==="finisher";
  const swapKey  = isSS ? `${block.id}-${phase}` : block.id;

  // resolveExFn reads from the already-resolved activeSession instead of
  // re-walking sessionSwaps + programmeBlock.config. Same callsites, single
  // truth — drift between overview and session is no longer possible.
  // Still parameterised by blockId/phase so legacy callers (pushSetToDraft,
  // rest-timer setup, finisher pushes) keep their signatures.
  const resolveExFn = useCallback((blockId, ph, defaultEx) => {
    const b = activeSession.blocks.find(x => x.id === blockId);
    if (!b) return defaultEx;
    if (ph === "A") return b.exA ?? defaultEx;
    if (ph === "B") return b.exB ?? defaultEx;
    return b.ex ?? defaultEx;
  }, [activeSession]);

  // Pre-resolve both sides of the current block so SessionScreen
  // never needs to touch block.exA/exB directly
  const resolvedExA = isSS ? (block.exA ?? null) : null;
  const resolvedExB = isSS ? (block.exB ?? null) : null;
  const resolvedEx  = !isSS ? (block.ex ?? null) : null;
  const activeEx    = isSS ? (phase==="A" ? resolvedExA : resolvedExB) : resolvedEx;

  // Resolution order for prescribed weight:
  //   1. workingWeights[ex.name]  — engine-driven progression from prior sessions
  //   2. startingWeightForLift(ex.name, bodyweight) — BW% floor for main lifts
  //      on first-session cold start (only fires for the 5 mains, and only
  //      when bodyweight has been captured)
  //   3. ex.weight — the hardcoded SESSIONS default
  const getW=useCallback((ex)=>{
    if (!ex) return null;
    if (workingWeights[ex.name] !== undefined) return workingWeights[ex.name];
    const bwSeeded = startingWeightForLift(ex.name, bodyweight);
    if (bwSeeded !== null) return bwSeeded;
    return ex.weight;
  },[workingWeights, bodyweight]);
  const getR=useCallback((ex)=>ex?(workingReps[ex.name]??ex.reps):null,[workingReps]);

  const onSwap=useCallback((key, newEx)=>{
    setSessionSwaps(prev=>({...prev,[key]:newEx}));
  },[]);

  // Append one set to the draft log. Tolerant of missing draft (mid-session recovery).
  // Phase is derived from the exercise identity — critical for supersets where
  // commitLog fires after phase has already moved, and we need both A and B
  // logged against the correct slot keys.
  const pushSetToDraft = useCallback((ex, rpe) => {
    if (!draftLogRef.current || !ex) return;
    let key = block.id;
    if (isSS) {
      // Match the exercise against the resolved A/B to determine its slot
      const resolvedA = resolveExFn(block.id, "A", block.exA);
      const resolvedB = resolveExFn(block.id, "B", block.exB);
      const derivedPhase = ex.name === resolvedA?.name ? "A"
                         : ex.name === resolvedB?.name ? "B"
                         : phase; // fallback for edge cases
      key = `${block.id}-${derivedPhase}`;
    }
    const swapPick = sessionSwaps[key];
    const swapped  = !!swapPick;
    const fromPool = EXERCISE_POOLS[key] ? key : null;
    const loadType = getLoadType(ex);
    // Mirror getW's resolution order so the LOGGED weight matches what was
    // DISPLAYED to the user. Critical for main lifts on first session — the
    // user sees the BW-seeded weight but if we logged ex.weight (the old
    // hardcoded default) the engine would reason from a phantom number.
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
    // Persist the draft to LS so a force-quit or crash doesn't lose work.
    // LS-only on purpose — blob isn't chatty-enough-reliable for this.
    D.save(activeProfile, draftLogRef.current);
    
    // If this is a bodyweight movement and user hasn't set BW, prompt once per session.
    // The brief delay (~280ms) matches the RPE card's fade-out animation so the
    // BW modal slides up immediately as the RPE card finishes dismissing — feels
    // like a smooth handoff rather than two competing animations or an awkward gap.
    // Tied to RPE animation duration; if that changes, update this to match.
    if (loadType !== "external" && bodyweight === null && !bwPromptedThisSession) {
      setBwPromptedThisSession(true);
      setTimeout(() => setBwEditOpen(true), 280);
    }
  }, [block, isSS, phase, sessionSwaps, workingWeights, workingReps, resolveExFn, activeProfile, bodyweight, bwPromptedThisSession]);

  const commitLog=useCallback((rpe)=>{
    // Use resolved exercises so RPE weight adjustments target the correct name
    const exes = isSS
      ? [resolveExFn(block.id,"A",block.exA), resolveExFn(block.id,"B",block.exB)]
      : [resolveExFn(block.id, null, block.ex)];

    // Record the actual sets performed in the draft log. Per-block weight
    // adjustments via applyRpe used to fire here, but Phase 2 moves all
    // progression decisions to the session-finalise hook (better — engine
    // sees the entire session's performance against prescribed targets,
    // not just one block).
    exes.forEach(ex => pushSetToDraft(ex, rpe));

    // Advance block / set / screen
    if(setNum>=block.sets){
      if(blockIdx<activeSession.blocks.length-1){setBlockIdx(p=>p+1);setSetNum(1);setPhase("A");}
      else setScreen("done");
    }else setSetNum(p=>p+1);
    setRestTrigger({id:Date.now(),duration:block.rest});
    setSsRoundDone(false);
    setAwaitRpe(false);
  },[block,blockIdx,isSS,setNum,activeSession,resolveExFn,pushSetToDraft,setScreen]);

  const handleLog=useCallback(()=>{
    if(isSS){
      if(phase==="A"){
        // Log exercise A as we move into B. Only for finishers — supersets
        // will log both A and B together in commitLog when RPE is submitted.
        if(block.type==="finisher"){
          pushSetToDraft(resolveExFn(block.id,"A",block.exA), null);
        }
        setPhase("B");return;
      }
      setPhase("A");
      if(block.type==="superset"){setSsRoundDone(true);return;}
      // Finisher: log B, then advance silently without RPE
      pushSetToDraft(resolveExFn(block.id,"B",block.exB), null);
      if(setNum>=block.sets){
        if(blockIdx<activeSession.blocks.length-1){setBlockIdx(p=>p+1);setSetNum(1);setPhase("A");}
        else setScreen("done");
      }else setSetNum(p=>p+1);
      setRestTrigger({id:Date.now(),duration:block.rest});
      return;
    }
    setAwaitRpe(true);
  },[block,blockIdx,isSS,phase,setNum,activeSession,resolveExFn,pushSetToDraft,setScreen]);

  // Jump to a specific block in the active session. Used by the session
  // overview sheet when a busy gym means the user needs to do exercises in
  // a different order than prescribed. Resumes setNum from the draft log so
  // a partially-completed block picks up at the right next set.
  const handleJumpToBlock = (targetIdx) => {
    if (typeof targetIdx !== "number" || targetIdx < 0) return;
    if (!activeSession?.blocks?.[targetIdx]) return;
    const targetBlock = activeSession.blocks[targetIdx];
    // Count completed sets across the target block's logged exercises.
    // For supersets we log both sides together, so pairs done = the max
    // sets count across either side (matches resume-draft maths).
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

  const reset=()=>{
    setBlockIdx(0);setSetNum(1);setPhase("A");setReadiness(null);setReadinessReason(null);
    setAwaitRpe(false);setSsRoundDone(false);
    setRestActive(false);setRestRemain(180);setRestTrigger(null);
    setSessionSwaps({});
    setSessionOverviewOpen(false);
    draftLogRef.current = null;
    // If the user explicitly quits, the pending-draft card should go too.
    D.clear(activeProfile);
    setPendingDraft(null);
    setScreen("home");
  };

  useEffect(()=>{
    if(screen==="done"&&activeProfile){
      const newStreak=bumpStreak(activeProfile);
      // Session-finalise orchestration on the done-screen transition: persist
      // the record, run the progression engine, then reflect results in state.
      // Deliberate side-effect pipeline keyed off the screen change. Intentional.
      setStreak(newStreak);
      // Mark today as done in the week strip
      const dw=new Date().getDay();
      const wm=[6,0,1,2,3,4,5];
      const updated=P.markDayDone(activeProfile,wm[dw]);
      setWeekDone(updated);

      // "Back at it" gap — read the newest strength record BEFORE appending
      // today's. A gap > 7 days means this session is a return after time
      // away; the Done screen praises the comeback (consistency-over-time
      // philosophy: coming back IS the win, not an apology owed).
      {
        const prior = H.get(activeProfile)
          .filter(r => r?.date && String(r.session || "").startsWith("strength"))
          .map(r => r.date).sort().pop();
        if (prior) {
          const gap = Math.round((new Date().setHours(0,0,0,0) - new Date(prior).setHours(0,0,0,0)) / 86400000);
          setReturnGapDays(gap > 7 ? gap : null);
        } else {
          setReturnGapDays(null);
        }
      }

      // Finalise the session draft and append to history
      let sessionRecord = null;
      if (draftLogRef.current) {
        sessionRecord = finaliseDraft(draftLogRef.current);
        H.append(activeProfile, sessionRecord);
        // Dual-write to Days. Strength sessions stamp completedType +
        // sessionId so the unified store reflects the live log.
        // scheduledType is the schedule effective on that date — preserves
        // the original plan-of-record even if the user retroactively edits.
        const effective = W.getEffectiveOn(sessionRecord.date);
        const dowMon = (() => {
          const [y, m, d] = sessionRecord.date.split("-").map(Number);
          const js = new Date(y, m - 1, d).getDay();
          return js === 0 ? 6 : js - 1;
        })();
        const scheduledType = effective && effective[dowMon] ? effective[dowMon].type : "strength";
        Days.set(activeProfile, sessionRecord.date, {
          scheduledType,
          completedType: "strength",
          sessionId: sessionRecord.id,
        });
        // Reflect in React state so Performance Lab + the home strip + the
        // "Session complete" card update immediately. weekDone is now the
        // unified Day projection (includes strength), so refresh it here.
        // We deliberately do NOT write the legacy dayDone store — strength
        // completion is history-backed; dayDone is non-strength ticks only.
        setHistory(H.get(activeProfile));
        setWeekDone(Days.projectCurrentWeek(activeProfile).complete);
        draftLogRef.current = null;
      }
      // Completed session — drop the persisted draft.
      D.clear(activeProfile);
      setPendingDraft(null);

      // ─── Phase 2 + 3: progression engine + deload transitions ─────────
      // For every exercise in the just-finished session, compute next
      // prescription (standard / deload / recovery), update lift state +
      // muscle anchors, and write the new working weight back to setWW.
      // Engine is silent — user sees a quietly smarter app.
      if (sessionRecord) {
        try {
          const fullHistory = H.get(activeProfile); // already includes the new record
          let trainingState = TS.get(activeProfile);
          const wwUpdates = {};

          // Phase 3 — was a deload active and should it auto-complete?
          // Auto-completion fires on the first session ≥ 4 days after deload start.
          // The current session being logged IS that crossing-the-threshold session,
          // so we run the standard progression on it (recovery from this point on)
          // rather than treating it as another deload session.
          const wasInDeload = !!trainingState.mesocycle?.activeDeload;
          let justCompletedDeload = false;
          if (wasInDeload && shouldAutoCompleteDeload(trainingState, sessionRecord.date)) {
            trainingState = completeDeload(trainingState);
            TS.replaceState(activeProfile, trainingState);
            justCompletedDeload = true;
            setActiveDeload(null);
            setShowDeloadComplete(true); // one-shot for Done screen
          }

          // After auto-completion, every lift now has inRecoveryUntil > 0.
          // The very session that triggered auto-completion still uses STANDARD
          // accumulation logic (it's the user's first non-deload session) — so
          // we DON'T run recovery prescription on this session. Recovery starts
          // from the NEXT session forward.

          // If still in active deload (didn't cross threshold), this session uses deload prescriptions.
          const stillInDeload = !justCompletedDeload && wasInDeload;

          for (const block of sessionRecord.blocks || []) {
            for (const ex of block.exercises || []) {
              // Reconcile liftState.currentWeight with what was actually
              // performed BEFORE computing the prescription. A stale seed
              // (programme default, or a prior session's adjusted-down weight
              // that the user has since dialled further) otherwise overrides
              // the engine's reasoning basis and "HOLD" prescriptions surface
              // at the old number instead of what the user just lifted.
              const rawLiftState = trainingState.lifts?.[ex.name] || null;
              const liftState    = reconcileLiftStateWithSession(rawLiftState, ex);
              const profile = getLiftProfile(ex.name);
              const anchorMuscle = profile.primaryMuscle;
              const muscleAnchor = anchorMuscle
                ? trainingState.muscleAnchors?.[anchorMuscle] || null
                : null;

              let prescription;
              const context = {
                readiness: sessionRecord.readiness,
                currentWeight: workingWeights[ex.name] ?? ex.sets?.[0]?.weight ?? null,
              };

              if (stillInDeload) {
                // Active deload — flat scaled prescription, no progression decisions
                prescription = computeDeloadPrescription(ex.name, liftState, context);
              } else if (liftState?.inRecoveryUntil > 0 && !justCompletedDeload) {
                // In recovery phase — rebuild from deloaded weight
                prescription = computeRecoveryPrescription(ex.name, liftState, fullHistory, context);
              } else {
                // Standard accumulation (Phase 2)
                prescription = computeNextPrescription({
                  liftName: ex.name,
                  history: fullHistory,
                  liftState,
                  muscleAnchor,
                  context,
                });
              }

              // Update working weights for next session — only when engine
              // returned a numeric weight (BW lifts return null).
              if (prescription.weight !== null && prescription.weight !== undefined) {
                wwUpdates[ex.name] = prescription.weight;
              }

              // Persist updated lift state. During an active deload, we DON'T
              // run the standard updateLiftStateFromSession (which would mutate
              // stallSignal, e1RM, consecutiveHolds) — the deload window is
              // invisible to progression tracking.
              if (stillInDeload && liftState) {
                // Deload session — leave lift state untouched aside from history
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
                TS.updateLift(activeProfile, ex.name, {
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
                // If this session was a recovery session (lift had inRecoveryUntil > 0),
                // decrement the counter so we step toward "back to accumulation."
                const counterAdjusted = (liftState?.inRecoveryUntil > 0 && !justCompletedDeload)
                  ? decrementRecoveryCounter(newLiftState)
                  : newLiftState;
                TS.updateLift(activeProfile, ex.name, counterAdjusted);
              }

              // Update muscle anchor — only for loaded lifts with a known muscle group.
              // Skip during deload (the weights aren't representative of true strength).
              if (anchorMuscle && profile.progressesByLoad && !stillInDeload) {
                const currentAnchor = TS.get(activeProfile).muscleAnchors?.[anchorMuscle] || null;
                const newAnchor = updateMuscleAnchorFromSession(currentAnchor, sessionRecord, ex);
                if (newAnchor) TS.updateMuscleAnchor(activeProfile, anchorMuscle, newAnchor);
              }
            }
          }

          if (Object.keys(wwUpdates).length) {
            setWW(p => ({ ...p, ...wwUpdates }));
          }

          // Phase 3 — refresh the home-screen offer state.
          const finalState = TS.get(activeProfile);
          const finalHistory = H.get(activeProfile);
          setDeloadOffer(shouldOfferDeload(finalState, finalHistory));
          setActiveDeload(finalState?.mesocycle?.activeDeload || null);
        } catch (e) {
          // Engine errors must never block session completion.
          console.error("[forge:progression]", e);
        }
      }
      // ──────────────────────────────────────────────────────────────────

      // ─── Phase 4: silent volume tracking ──────────────────────────────
      // After every session, recompute rolling 7/14/28-day volume aggregates +
      // a 16-week baseline, persist to TS.volume. No UI consumes this yet —
      // it's infrastructure for future Performance Lab visualisations and for
      // Phase 5+ fatigue tuning. Errors silently logged, never blocking.
      if (sessionRecord) {
        try {
          const fullHistory = H.get(activeProfile);
          const aggregates = computeVolumeAggregates(fullHistory);
          TS.updateVolume(activeProfile, aggregates);
        } catch (e) {
          console.error("[forge:volume-tracking]", e);
        }
      }
      // ──────────────────────────────────────────────────────────────────

      // Anonymous completion signal — feeds Vercel Analytics funnel.
      // No PII, no free-text; enum-only dimensions.
      try {
        track("session_complete", {
          session: sessionRecord?.session || "strength",
          readiness: readiness || "normal",
          readinessReason: readinessReason || "unspecified",
          block: String(programmeBlock?.number ?? 1),
        });
      } catch {}

      // Push both meta and the just-finalised record to blob.
      // History push is incremental — only this one record, the server
      // merges with whatever it has. Includes user-state fields so a
      // session-complete push can't wipe a schedule/focus/tick the user
      // changed mid-session.
      blobPush(activeProfile, {
        meta: {
          weights: workingWeights,
          reps: workingReps,
          streak: P.getStreak(activeProfile),
          programmeBlock,
          userWeek: W.getHistory(),
          userFocus: F.get(activeProfile),
          days: Days.getAll(activeProfile),
        },
        history: sessionRecord ? [sessionRecord] : [],
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[screen==="done"]);

  // Mark a non-strength day complete (zone 2, cardio, HIIT, rest). Defaults
  // to today; pass an explicit weekday index (0=Mon..6=Sun, monday-start) to
  // tick a past day from the retro-catch-up picker. Streak only bumps when
  // marking today — backfilling past days shouldn't count toward "today's
  // streak", that's gaming the metric.
  //
  // Guard: only an integer 0–6 counts as a target index. Anything else
  // (including the React SyntheticEvent that arrives when this is wired
  // directly as onClick={onMarkDayDone}) falls through to "today". That
  // exact mistake shipped once — the home Mark complete button passed the
  // click event as idx and weekDone got keyed by "[object Object]".
  // Mark a non-strength day complete. Accepts either:
  //   - a date string ("YYYY-MM-DD") — preferred, cross-week capable
  //   - a weekday idx (0=Mon..6=Sun) — convenience for "today"; resolves to
  //     today's date for that weekday within the current week
  //   - nothing → today
  // Streak only bumps when the resolved date IS today (no gaming the streak
  // by backfilling). Writes to the date-keyed dayDone store; weekDone
  // updates as a derived projection so the home week strip refreshes
  // without separate state plumbing.
  const handleMarkDayDone = useCallback((target)=>{
    if(!activeProfile) return;
    const todayDate = (() => {
      const d = new Date(); d.setHours(0,0,0,0);
      const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
      return `${y}-${m}-${day}`;
    })();
    let dateStr;
    if (typeof target === "string" && /^\d{4}-\d{2}-\d{2}$/.test(target)) {
      dateStr = target;
    } else if (Number.isInteger(target) && target >= 0 && target <= 6) {
      dateStr = dateOfWeekdayIdxInCurrentWeek(target);
    } else {
      dateStr = todayDate;
    }
    // Write the Day entity (now the read source). scheduledType comes from
    // the schedule effective on that date — preserves truthful interpretation
    // even if the user retroactively edits the schedule later. For the
    // non-strength tick path, completedType === scheduledType (the user just
    // confirmed they did the scheduled thing).
    //
    // CRITICAL fallback: W.getEffectiveOn returns null when no schedule edit
    // log exists (i.e., the user has been using the default schedule the
    // whole time — the most common state). Without this fallback, scheduled
    // and completed types both become null, and Days.manualTickDates filters
    // out entries with null completedType — so the retro picker keeps
    // surfacing the same day as "missed" no matter how many times the user
    // taps Mark ✓. (User reported: "missed workout flow keeps bringing up
    // the same cardio days from last week." This was the cause.)
    const dowMon = (() => {
      const [y, m, d] = dateStr.split("-").map(Number);
      const js = new Date(y, m - 1, d).getDay();
      return js === 0 ? 6 : js - 1;
    })();
    const effective = W.getEffectiveOn(dateStr) || WEEK;
    const scheduledType = effective[dowMon]?.type || null;
    Days.set(activeProfile, dateStr, {
      scheduledType,
      completedType: scheduledType,
    });
    // Refresh React state from the unified Day projection.
    const proj = Days.projectCurrentWeek(activeProfile);
    setWeekDone(proj.complete);
    setDayDone(Days.manualTickDates(activeProfile));
    if (dateStr === todayDate) {
      const newStreak = bumpStreak(activeProfile);
      setStreak(newStreak);
    }
    pushNow(activeProfile);
  },[activeProfile]);

  // Mark today's optional cardio bonus complete. Separate store from weekDone;
  // deliberately does NOT bump the streak — bonuses are extras, not adherence.
  const handleMarkBonusDone = useCallback(()=>{
    if(!activeProfile) return;
    // Bonus is an extra mark on today's date; it doesn't change completedType
    // (the user may or may not have done the scheduled training as well).
    const today = (() => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    })();
    // Stamp scheduledType from the effective schedule (or WEEK fallback
    // if no edit log). Without this, bonus-only entries land with null
    // scheduledType — indistinguishable from the buggy null/null Mark ✓
    // writes, forcing the repair migration to guess. Writing scheduledType
    // here gives the repair a clean signal: scheduledType set +
    // completedType null = legit bonus-only, leave alone.
    const dowMon = (() => {
      const [y, m, d] = today.split("-").map(Number);
      const js = new Date(y, m - 1, d).getDay();
      return js === 0 ? 6 : js - 1;
    })();
    const effective = W.getEffectiveOn(today) || WEEK;
    const scheduledType = effective[dowMon]?.type || null;
    Days.set(activeProfile, today, {
      scheduledType,
      marks: { bonus: true },
    });
    // Refresh React state from the unified Day projection.
    setBonusDone(Days.projectCurrentWeek(activeProfile).bonus);
    pushNow(activeProfile);
  },[activeProfile]);

  // Save the user's training focus + re-rotate accessories IMMEDIATELY with the
  // new bias. Keeps block number and startDate (the change is a re-pick, not
  // a new training block); workingWeights carry forward via existing storage,
  // so progressive overload context isn't lost. Closes the picker on save.
  // Thin wrapper over saveFocusCore (lib/profile-actions) — persistence,
  // re-rotation, and the snapshot push live there; this reflects the result
  // into React state and surfaces the rotation summary.
  const handleSaveFocus = (focus) => {
    if (!activeProfile) return;
    const { next, summary } = saveFocusCore(activeProfile, focus);
    setUserFocus(focus);
    setProgrammeBlock(next);
    setRotationSummary(summary);
    setFocusPickerOpen(false);
  };

  if(!mounted) return null;

  // Onboarding — first-time intro, shown before ProfileScreen
  if(screen==="onboarding"){
    return <OnboardingScreen onContinue={()=>{
      LS.set("forge:onboarded", true);
      setScreen("home");
    }}/>;
  }

  if(!activeProfile){
  return (
    <>
      <ProfileScreen existing={P.list()} current={activeProfile} onActivate={activateProfile} onCancel={null} bodyweight={bodyweight} bwEditOpen={bwEditOpen} setBwEditOpen={setBwEditOpen} updateBodyweight={updateBodyweight} userFocus={userFocus} onEditFocus={()=>setFocusPickerOpen(true)}/>
      {/* Modals triggerable from ProfileScreen must mount here too — the
          early return above bypasses the main JSX where these live, so
          without this Fragment, tapping "Edit focus" in Profile sets state
          but the sheet doesn't appear until the user backs out of Profile.
          BodyweightEditModal is fine because it lives inside ProfileScreen. */}
      {focusPickerOpen && (
        <FocusPickerSheet
          current={userFocus}
          onSave={handleSaveFocus}
          onCancel={()=>setFocusPickerOpen(false)}
        />
      )}
      {rotationSummary && <RotationSummaryModal summary={rotationSummary} onContinue={handleRotationContinue}/>}
    </>
  );
  }

const sProps={
  session:activeSession,
  block,blockIdx,totalBlocks:activeSession.blocks.length,setNum,phase,isSS,
  activeEx, resolvedExA, resolvedExB, resolvedEx,
  swapKey,onSwap,
  showVid,setShowVid,getW,getR,editTarget,setEditTarget,
  workingWeights,setWW,workingReps,setWR,
  // History feeds the in-session "Recent" sanity-check sheet so the user
  // can compare today's prescribed weight against their last 3 performances
  // of the active exercise.
  history,
  awaitRpe,ssRoundDone,
  restActive,restRemain,setRestActive,setRestRemain,
  onCommit:commitLog,onLog:handleLog,onQuit:reset,
  // Snapshot the draft log at sheet-open so the overview reads from a stable
  // value (no render-time ref access). Subsequent set logs while the sheet
  // is open don't live-update — user is mid-jump, that's fine.
  onShowOverview: () => {
    setOverviewDraftSnapshot(draftLogRef.current);
    setSessionOverviewOpen(true);
  },
  bodyweight,
  // Phase 3 — when active, SessionScreen renders "deload · day N of M" subtitle below prescribed weight.
  deloadDayTag: activeDeload ? deloadDayLabel(activeDeload) : null,
  };

  // Derive today's session index for HomeScreen
  const dow      = new Date().getDay();
  const weekMap  = [6,0,1,2,3,4,5];
  const todayIdx = weekMap[dow];
  const todaySessionIdx = strengthDaySessions[todayIdx] ?? 0;

  // Pure rotation preview — computes a candidate config without touching
  // state. Used by the preview sheet so users can see the proposed picks
  // (and re-roll if they don't like them) before anything commits. Each call
  // burns one weighted-random draw; rolling again is just calling again.
  // No-op on engine state — programmeBlock.history is unchanged.
  const computeRotationPreview = () => {
    const oldConfig = programmeBlock.config;
    const updatedHistory = pushHistoryBlock(programmeBlock.history, oldConfig);
    const newConfig = rotateAccessories(updatedHistory, { focus: userFocus });
    return {
      oldConfig,
      newConfig,
      updatedHistory,
      changes: rotationDiff(oldConfig, newConfig),
      stimulusDelta: computeRotationStimulusDelta(oldConfig, newConfig),
    };
  };

  // Commit a previously-computed preview. Bumps block number + startDate,
  // persists, and optionally surfaces the existing rotation summary modal.
  const commitRotationPreview = (preview, showSummary = true) => {
    const next = {
      number: programmeBlock.number + 1,
      startDate: new Date().toISOString().slice(0,10),
      config: preview.newConfig,
      history: preview.updatedHistory,
    };
    setProgrammeBlock(next);
    PB.save(next);
    // Push immediately — the previous code only sync'd programmeBlock via
    // the next session-finalise, so users who rotated and then reinstalled
    // before training lost the new rotation. Also covers the case where
    // session-complete fires later with a stale closure over programmeBlock
    // (the closure captures `programmeBlock` from the render where the user
    // rotated; pushing here pins the latest persisted state regardless).
    pushNow(activeProfile);
    if (showSummary) {
      setRotationSummary({
        blockNumber: next.number,
        changes: preview.changes,
        stimulusDelta: preview.stimulusDelta,
      });
    }
    return next;
  };

  // Combined preview + commit for the auto-rotate path (beginSession at
  // ROTATION_AUTO weeks). Auto-rotation skips the preview sheet — it's a
  // programmatic trigger, not a user-initiated choice, so the existing
  // post-rotation summary is enough.
  const rotate = (showSummary = false) => commitRotationPreview(computeRotationPreview(), showSummary);

  // User-initiated rotation: open the preview sheet instead of committing.
  // Was previously committing-then-showing-summary, which surprised users who
  // tapped "Rotate" expecting "show me what I'd get" and got force-committed.
  const handleRotate = () => setRotationPreview(computeRotationPreview());

  // Sheet actions
  const handleRotationReroll = () => setRotationPreview(computeRotationPreview());
  const handleRotationConfirm = () => {
    if (!rotationPreview) return;
    commitRotationPreview(rotationPreview, true);
    setRotationPreview(null);
  };
  const handleRotationCancel = () => setRotationPreview(null);

  // Reset rotation drift to SESSIONS defaults (preserves block number/start).
  // Used by the "Reset accessories" link on home for users who've over-rotated.
  const handleResetProgramme = () => {
    const next = PB.reset();
    setProgrammeBlock(next);
    pushNow(activeProfile);
  };

  const beginSession = () => {
    // Auto-rotate if we're past the threshold. Show summary card;
    // once acknowledged, readiness screen follows.
    const weeks = weeksSince(programmeBlock.startDate);
    if (weeks >= ROTATION_AUTO) {
      rotate(true);
      // The summary modal's continue button transitions to readiness
      setActiveSessionIdx(todaySessionIdx);
      return;
    }
    setActiveSessionIdx(todaySessionIdx);
    setScreen("readiness");
  };

  // After rotation summary acknowledged, advance to readiness
  const handleRotationContinue = () => {
    setRotationSummary(null);
    setScreen("readiness");
  };

  // Readiness screen's "start" initialises the draft log and enters session
  const handleReadinessStart = () => {
    setSessionStartWeights({ ...workingWeights });
    draftLogRef.current = newDraftLog({
      profileName: activeProfile,
      session: ["strength-a","strength-b","strength-c"][activeSessionIdx],
      blockNumber: programmeBlock.number,
      readiness,
      readinessReason,
    });
    setScreen("session");
  };

  // Resume a draft from a previous, interrupted session.
  // Jumps straight into session screen at the furthest block the user reached.
  const handleResumeDraft = () => {
    if (!pendingDraft) return;
    const { draft } = pendingDraft;

    // Rehydrate readiness / session selection from the saved draft so the
    // working-set path resolves correctly.
    const sessionKey = draft.session; // "strength-a" | ...
    const idx = ["strength-a","strength-b","strength-c"].indexOf(sessionKey);
    if (idx === -1) { handleDiscardDraft(); return; }

    // Map back to the live SESSIONS definition. If programme has rotated since
    // the draft was saved, the draft's block ids should still match by id.
    const session = SESSIONS[idx];
    if (!session) { handleDiscardDraft(); return; }

    // Find which block they reached — the highest-indexed block with any sets.
    let resumeBlockIdx = 0;
    let setsOnCurrent  = 0;
    for (let i = 0; i < session.blocks.length; i++) {
      const saved = draft.blocks[session.blocks[i].id];
      if (!saved) continue;
      const setsHere = Object.values(saved.exercises || {})
        .reduce((n, ex) => n + (ex.sets || []).length, 0);
      if (setsHere > 0) {
        resumeBlockIdx = i;
        // For non-superset, sets-per-exercise == setNum-1 completed
        // For superset, we log both A+B together, so pairs == setNum-1
        const block = session.blocks[i];
        const isSS = block.type === "superset" || block.type === "finisher";
        const pairs = Math.max(
          ...Object.values(saved.exercises || {}).map(ex => (ex.sets || []).length)
        );
        setsOnCurrent = isSS ? pairs : pairs; // both resolve the same way here
      }
    }

    // Hydrate React state and re-attach the draft ref
    draftLogRef.current = draft;
    // Resume preserves the session-start snapshot too. Use the current working
    // weights as the best available baseline (we don't store the original
    // pre-session snapshot on the draft); if the user adjusted in the previous
    // run, that adjustment carries forward as "base" for the diff. Acceptable
    // — the resumed user is mid-session, so "what was today's starting weight"
    // is fuzzy anyway.
    setSessionStartWeights({ ...workingWeights });
    setActiveSessionIdx(idx);
    setReadiness(draft.readiness);
    setReadinessReason(draft.readinessReason);
    setBlockIdx(resumeBlockIdx);
    // Resume AT the next set (what they'd have logged next)
    setSetNum(Math.min(setsOnCurrent + 1, session.blocks[resumeBlockIdx].sets));
    setPhase("A");
    setPendingDraft(null);
    setScreen("session");
  };

  const handleDiscardDraft = () => {
    D.clear(activeProfile);
    setPendingDraft(null);
  };

  // Phase 3 — deload accept handler. Snapshots current weights, sets activeDeload,
  // closes the offer card. From the next session forward, prescriptions come back
  // scaled until auto-completion fires.
  const handleAcceptDeload = () => {
    if (!activeProfile || !deloadOffer) return;
    try {
      const ts = TS.get(activeProfile);
      const newState = startDeload(ts, deloadOffer);
      TS.replaceState(activeProfile, newState);
      setActiveDeload(newState.mesocycle.activeDeload);
      setDeloadOffer(null);
      pushNow(activeProfile);
    } catch (e) {
      console.error("[forge:deload-accept]", e);
    }
  };

  // Phase 3 — dismiss handler. Sets the 5-day cooldown so the card hides for a
  // sensible window. If signals persist after cooldown, card re-surfaces.
  const handleDismissDeload = () => {
    if (!activeProfile) return;
    try {
      const ts = TS.get(activeProfile);
      const newState = dismissDeloadOffer(ts);
      TS.replaceState(activeProfile, newState);
      setDeloadOffer(null);
      pushNow(activeProfile);
    } catch (e) {
      console.error("[forge:deload-dismiss]", e);
    }
  };

  // ─── Retrospective logging handlers ────────────────────────────────────────
  // Three handlers: open the picker, pick a date (transitions to retro screen),
  // and finalise — taking the user-filled data and pushing it through the
  // standard newDraftLog → logSet → finaliseDraft → H.append pipeline. The
  // engine block immediately afterwards (Phase 2/3/4) runs unchanged because
  // the session record looks identical to a live one save for `retrospective: true`.
  const handleOpenRetroPicker = () => {
    if (pendingDraft) return; // can't retro-log while a live draft is open
    setRetroPickerOpen(true);
  };

  const handlePickRetroDate = (dateStr) => {
    setRetroDate(dateStr);
    setRetroPickerOpen(false);
    setScreen("retro");
  };

  // Finalise a retrospective session. Called by RetrospectiveSessionSheet
  // with a payload describing what the user filled in. This handler is
  // intentionally chunky — it owns the "make this look identical to a live
  // session record so the engine doesn't need a code path for it" job.
  //
  // INTENTIONALLY a plain arrow function, NOT useCallback. The function lives
  // after the SSR mount guard (`if (!mounted) return null`) earlier in this
  // component, so wrapping it in useCallback creates a hook-ordering violation:
  // the first render (pre-mount) skips this hook entirely, the second render
  // calls it. React detects the mismatch and crashes with Error #310 in prod
  // ("Rendered more hooks than during the previous render"). Plain function
  // closure preserves identical behaviour with zero perf cost — this handler
  // fires once per retrospective submission.
  const handleSubmitRetro = (payload) => {
    if (!activeProfile || !retroDate) return;
    const meta = sessionMetaForDate(retroDate, userWeek);
    if (!meta || meta.type !== "strength") return;

    const sessionDef = SESSIONS[meta.sessionIdx];
    if (!sessionDef) return;

    // Duplicate guard — retro ids are DETERMINISTIC (noon UTC of the date),
    // so a re-log of an already-recorded day would hit H.append's silent
    // dedupe: success toast, no new record, no rhythm bump. Confusing.
    // (Real-world: the week-strip bug used to hide successful retro logs,
    // inviting exactly this double-submit.) Surface it honestly instead.
    const dupeId = `${retroDate}T12:00:00.000Z`;
    if (H.get(activeProfile).some(r => r.id === dupeId)) {
      setRetroToast({
        date: meta.dateLabel,
        sessionName: "Already logged — no changes made",
      });
      setRetroDate(null);
      setScreen("home");
      setTimeout(() => setRetroToast(null), 3000);
      return;
    }

    try {
      // Build a draft, pre-anchored to the selected date so the resulting
      // record's id sorts to the correct chronological position in history.
      const draft = newDraftLog({
        profileName: activeProfile,
        session: `strength-${["a","b","c"][meta.sessionIdx]}`,
        blockNumber: programmeBlock?.number ?? 1,
        readiness: "normal",                  // user skipped readiness for retro
        readinessReason: null,
        mesocyclePhase: activeDeload ? "deload" : "accumulation",
        bodyweight: bodyweight,               // current BW — close enough at 3-day window
        hoursSlept: null,
        daysSinceLast: null,
      });

      // Override id + date to the SELECTED retro date — anchored at noon UTC
      // so it sorts cleanly against live records (which are timestamped at log time).
      draft.id   = `${retroDate}T12:00:00.000Z`;
      draft.date = retroDate;
      draft.dow  = new Date(retroDate + "T12:00:00").getDay();
      draft.startedAt = new Date(retroDate + "T12:00:00").getTime();
      draft.retrospective = true;             // explicit flag — survives finaliseDraft
      draft.loggedAt = new Date().toISOString(); // when the user actually entered it

      // Walk the user's filled-in payload and log each set. Skipped exercises
      // contribute no sets (and therefore no engine signal) — they're just absent.
      for (const exEntry of payload.exercises) {
        if (exEntry.skipped) continue;
        for (let setIdx = 0; setIdx < exEntry.weights.length; setIdx++) {
          const w = exEntry.weights[setIdx];
          const r = exEntry.reps[setIdx];
          if (w === null && (r === null || r === undefined || r === "")) continue;
          logSet(draft, {
            blockId: exEntry.blockId,
            blockType: exEntry.blockType,
            exerciseName: exEntry.name,
            muscle: exEntry.muscle,
            swapped: false,
            fromPool: null,
            loadType: exEntry.loadType,
            bodyweight: bodyweight,
            weight: w,
            reps: r,
            rpe: exEntry.rpe || "normal",     // single RPE applied to all sets
            prescribed: exEntry.prescribed,
            tempo: null,
            blockIntent: exEntry.blockIntent || null,
          });
        }
      }

      const sessionRecord = finaliseDraft(draft);
      // Preserve retro flag through finalise (spread `...rest` in finaliseDraft
      // would have stripped it if newDraftLog hadn't put it on the draft, but
      // since we set it on the draft directly, finaliseDraft preserves it).
      sessionRecord.retrospective = true;

      H.append(activeProfile, sessionRecord);
      // Dual-write to Days. Same shape as the live-session path above.
      {
        const effective = W.getEffectiveOn(sessionRecord.date);
        const [y, m, d] = sessionRecord.date.split("-").map(Number);
        const js = new Date(y, m - 1, d).getDay();
        const dowMon = js === 0 ? 6 : js - 1;
        const scheduledType = effective && effective[dowMon] ? effective[dowMon].type : "strength";
        Days.set(activeProfile, sessionRecord.date, {
          scheduledType,
          completedType: "strength",
          sessionId: sessionRecord.id,
        });
      }
      setHistory(H.get(activeProfile));
      // Refresh the unified Day projection so a retro-logged strength day
      // marks the strip dot in the same tick. No legacy dayDone write —
      // strength completion is history-backed. See the live finalise path
      // for the rationale (mixing the two stores would mean a schedule edit
      // could promote a cardio tick into a phantom strength completion).
      setWeekDone(Days.projectCurrentWeek(activeProfile).complete);

      // ─── Engine block — runs identically to live finalise hook ─────────
      try {
        const fullHistory = H.get(activeProfile);
        let trainingState = TS.get(activeProfile);
        const wwUpdates = {};

        // Phase 3 — auto-completion check still applies if a deload is active
        // and this retro session crosses the threshold. Edge case but correct.
        const wasInDeload = !!trainingState.mesocycle?.activeDeload;
        let justCompletedDeload = false;
        if (wasInDeload && shouldAutoCompleteDeload(trainingState, sessionRecord.date)) {
          trainingState = completeDeload(trainingState);
          TS.replaceState(activeProfile, trainingState);
          justCompletedDeload = true;
          setActiveDeload(null);
        }
        const stillInDeload = !justCompletedDeload && wasInDeload;

        for (const block of sessionRecord.blocks || []) {
          for (const ex of block.exercises || []) {
            // Reconcile before reading — see same comment on the live path.
            const rawLiftState  = trainingState.lifts?.[ex.name] || null;
            const liftState     = reconcileLiftStateWithSession(rawLiftState, ex);
            const profile       = getLiftProfile(ex.name);
            const anchorMuscle  = profile.primaryMuscle;
            const muscleAnchor  = anchorMuscle
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
              TS.updateLift(activeProfile, ex.name, {
                ...liftState,
                history: [...(liftState.history || []), lastHistEntry].slice(-12),
              });
            } else {
              const newLiftState = updateLiftStateFromSession(liftState, sessionRecord, ex, prescription);
              const counterAdjusted = (liftState?.inRecoveryUntil > 0 && !justCompletedDeload)
                ? decrementRecoveryCounter(newLiftState)
                : newLiftState;
              TS.updateLift(activeProfile, ex.name, counterAdjusted);
            }

            if (anchorMuscle && profile.progressesByLoad && !stillInDeload) {
              const currentAnchor = TS.get(activeProfile).muscleAnchors?.[anchorMuscle] || null;
              const newAnchor     = updateMuscleAnchorFromSession(currentAnchor, sessionRecord, ex);
              if (newAnchor) TS.updateMuscleAnchor(activeProfile, anchorMuscle, newAnchor);
            }
          }
        }

        if (Object.keys(wwUpdates).length) {
          setWW(p => ({ ...p, ...wwUpdates }));
        }

        // Phase 3 — refresh offer state
        const finalState   = TS.get(activeProfile);
        const finalHistory = H.get(activeProfile);
        setDeloadOffer(shouldOfferDeload(finalState, finalHistory));
        setActiveDeload(finalState?.mesocycle?.activeDeload || null);

        // Phase 4 — recompute volume aggregates
        const aggregates = computeVolumeAggregates(finalHistory);
        TS.updateVolume(activeProfile, aggregates);
      } catch (e) {
        console.error("[forge:retro-engine]", e);
      }

      // Anonymous completion signal — same path as live session finalise.
      // No PII; enum-only dimensions. retro=1 lets us see post-launch how
      // often this feature is used vs live logging.
      try {
        track("session_complete", {
          session: sessionRecord.session,
          retro: 1,
        });
      } catch {/* analytics never blocks */}

      // Push to blob in background. Same reasoning as the live-finalise
      // path: carry the full user-state so a retro submit doesn't clobber
      // schedule/focus/tick changes that happened on this device.
      blobPush(activeProfile, {
        meta: {
          weights: workingWeights,
          reps: workingReps,
          streak: P.getStreak(activeProfile),
          programmeBlock,
          userWeek: W.getHistory(),
          userFocus: F.get(activeProfile),
          days: Days.getAll(activeProfile),
        },
        history: H.get(activeProfile),
      });

      // Confirm with toast, return to home — DoneScreen would be jarring here
      // (user is rapid-firing through past sessions, not celebrating each one).
      setRetroToast({
        date: meta.dateLabel,
        sessionName: meta.sessionName,
      });
      setRetroDate(null);
      setScreen("home");
      // Auto-dismiss toast after 3s
      setTimeout(() => setRetroToast(null), 3000);
    } catch (e) {
      console.error("[forge:retro-submit]", e);
    }
  };

  const handleCancelRetro = () => {
    setRetroDate(null);
    setScreen("home");
  };

  // ─── Passkey nudge handlers ────────────────────────────────────────────────
  // Both chip and card share the same register flow. The button on either
  // surface calls handleRegisterPasskeyFromHome — which runs the WebAuthn
  // ceremony and, on success, hides the nudge forever for this profile.
  // On cancellation/error, we silently snooze for 7 days. The user can
  // re-attempt by waiting out the snooze or by going to the profile sheet.
  const handleRegisterPasskeyFromHome = async () => {
    if (!activeProfile || pnBusy) return;
    setPnBusy(true);
    setPnError(null);
    try {
      const result = await registerPasskey(activeProfile);
      if (result?.ok) {
        setPnHasPasskey(true);
        setPnStage("hidden");
        setPnSuccessToast(true);
        setTimeout(() => setPnSuccessToast(false), 3000);
      } else if (result === null) {
        // User cancelled the OS prompt — auto-snooze for 7 days.
        // No error message; cancellation isn't a failure.
        PN.snooze(activeProfile);
        setPnStage("hidden");
      } else {
        setPnError("Couldn't register passkey. Try again later.");
        // Don't auto-snooze on error — let the user retry on their own terms.
      }
    } catch (e) {
      console.error("[forge:passkey-register]", e);
      setPnError(e.message || "Passkey setup failed");
    }
    setPnBusy(false);
  };

  const handleSnoozeNudge = () => {
    if (!activeProfile) return;
    PN.snooze(activeProfile);
    setPnStage("hidden");
  };

  const weeksOnBlock = weeksSince(programmeBlock.startDate);

  // Hydrating gate — show "Restoring your training" while we await the blob
  // round-trip on profile activation. Sits ABOVE all screen routing so users
  // see a clear loading state instead of an empty home that fills in 1-2s
  // later. All hooks have already executed before this early return — safe.
  const showHydrating = hydrating && activeProfile && screen !== "onboarding";

  if (showHydrating) {
    return (
      <div style={{background:"transparent",minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px",position:"relative",overflow:"clip"}}>
        <div style={{position:"absolute",top:"30%",left:"50%",transform:"translateX(-50%)",width:400,height:300,background:`radial-gradient(ellipse,${T.sage}1A 0%,transparent 65%)`,pointerEvents:"none"}}/>
        <div style={{position:"relative",textAlign:"center"}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:T.sage,margin:"0 auto 24px",animation:`pulse 1400ms ${T.ease} infinite`}}/>
          <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.18em",textTransform:"uppercase",marginBottom:14}}>
            Restoring
          </div>
          <div style={{fontFamily:T.serif,fontSize:28,fontWeight:300,color:T.text1,lineHeight:1.2,marginBottom:10}}>
            Welcome back, <span style={{fontStyle:"italic",color:T.sage}}>{activeProfile}</span>
          </div>
          <div style={{fontSize:13,color:T.text3,lineHeight:1.55}}>
            Pulling your training history…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{background:"transparent",minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased"}}>
      {screen==="home"        && <HomeScreen rhythm={rhythm} profileName={activeProfile} userWeek={userWeek} strengthDaySessions={strengthDaySessions} onEditWeek={()=>setWeekEditorOpen(true)} onBegin={beginSession} onProfile={()=>router.push("/profile")} weekDone={weekDone} onMarkDayDone={handleMarkDayDone} bonusDone={bonusDone} onMarkBonusDone={handleMarkBonusDone} programmeBlock={programmeBlock} weeksOnBlock={weeksOnBlock} onRotate={handleRotate} onResetProgramme={handleResetProgramme} userFocus={userFocus} onEditFocus={()=>setFocusPickerOpen(true)} onPerformance={handleOpenPerformance} historyCount={history.length} recoveryNudge={recoveryNudge} onDismissRecovery={()=>setRecoveryDismissed(true)} syncState={syncState} pendingDraft={pendingDraft} onResumeDraft={handleResumeDraft} onDiscardDraft={handleDiscardDraft} showBwCard={bwIsStale && !bwCardDismissed} onOpenBwEdit={()=>setBwEditOpen(true)} onDismissBwCard={()=>setBwCardDismissed(true)} deloadOffer={deloadOffer} onAcceptDeload={handleAcceptDeload} onDismissDeload={handleDismissDeload} untickedDays={untickedDays} onOpenRetroPicker={handleOpenRetroPicker} retroToast={retroToast} onDismissRetroToast={()=>setRetroToast(null)} pnStage={pnStage} pnBusy={pnBusy} pnError={pnError} pnSuccessToast={pnSuccessToast} onPnRegister={handleRegisterPasskeyFromHome} onPnSnooze={handleSnoozeNudge} onPnDismissToast={()=>setPnSuccessToast(false)} tonnageMilestone={pendingMilestone} tonnageTotalKg={totalKg} onDismissTonnageMilestone={handleDismissTonnageMilestone}/>}
      {screen==="readiness"   && <ReadinessScreen readiness={readiness} setReadiness={setReadiness} reason={readinessReason} setReason={setReadinessReason} onStart={handleReadinessStart}/>}
      {screen==="session"     && <ErrorBoundary><SessionScreen {...sProps}/></ErrorBoundary>}
      {screen==="done"        && <ErrorBoundary><DoneScreen session={activeSession} profileName={activeProfile} workingWeights={workingWeights} sessionStartWeights={sessionStartWeights} userWeek={userWeek} onHome={()=>{ setShowDeloadComplete(false); setReturnGapDays(null); reset(); }} deloadCompleted={showDeloadComplete} returnGapDays={returnGapDays}/></ErrorBoundary>}
      {screen==="retro"       && retroDate && <ErrorBoundary><RetrospectiveSessionSheet date={retroDate} bodyweight={bodyweight} workingWeights={workingWeights} workingReps={workingReps} userWeek={userWeek} onCancel={handleCancelRetro} onSubmit={handleSubmitRetro}/></ErrorBoundary>}
      {retroPickerOpen        && <RetroPickerSheet untickedDays={untickedDays} pendingDraft={pendingDraft} onPick={handlePickRetroDate} onTickDate={handleMarkDayDone} onClose={()=>setRetroPickerOpen(false)}/>}
      {rotationSummary        && <RotationSummaryModal summary={rotationSummary} onContinue={handleRotationContinue}/>}
      {rotationPreview        && <RotationPreviewSheet preview={rotationPreview} onConfirm={handleRotationConfirm} onReroll={handleRotationReroll} onCancel={handleRotationCancel}/>}
      {showIosInstall         && <IosInstallOverlay onDismiss={()=>{ LS.set("forge:iosInstallDismissed", true); setShowIosInstall(false); }}/>}
      <BodyweightEditModal open={bwEditOpen} onClose={()=>setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight}/>
      {weekEditorOpen && (
        <WeekEditorSheet
          initialWeek={userWeek}
          isCustom={W.get() !== null}
          onSave={handleSaveWeek}
          onReset={handleResetWeek}
          onCancel={()=>setWeekEditorOpen(false)}
        />
      )}
      {focusPickerOpen && (
        <FocusPickerSheet
          current={userFocus}
          onSave={handleSaveFocus}
          onCancel={()=>setFocusPickerOpen(false)}
        />
      )}
      {sessionOverviewOpen && screen === "session" && (
        <SessionOverviewSheet
          session={activeSession}
          currentBlockIdx={blockIdx}
          draftLog={overviewDraftSnapshot}
          onJumpToBlock={handleJumpToBlock}
          onCancel={()=>setSessionOverviewOpen(false)}
        />
      )}
    </div>
  );
}

// TakenNameModal now lives in components/TakenNameModal.jsx (PR3 3c-final).

// ─── Onboarding Screen ────────────────────────────────────────────────────────
// First-time intro. Sets forge:onboarded on continue so returning visitors
// skip straight to ProfileScreen or home. BW is collected after name entry.
function OnboardingScreen({ onContinue }) {
  const { strength: s } = T;

  return (
    <div style={{
      background: "transparent", minHeight: "100vh", maxWidth: 430, margin: "0 auto",
      fontFamily: T.sans, color: T.text1, WebkitFontSmoothing: "antialiased",
      padding: "72px 24px 48px", position: "relative", overflow: "hidden",
      // Centre the editorial column when the viewport is taller than the
      // content (iPad portrait was the catalyst — the old `flex: 1` spacer
      // shoved the "Let's go" button hundreds of pixels below the promises
      // on any screen taller than a phone). On short viewports content just
      // fills naturally; on tall ones the whole column sits in the middle
      // with the glow framing it, which is how the editorial intent reads.
      display: "flex", flexDirection: "column", justifyContent: "center",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "absolute", top: -160, left: "50%", transform: "translateX(-50%)",
        width: 500, height: 440,
        background: `radial-gradient(ellipse, ${s.glow} 0%, transparent 65%)`,
        pointerEvents: "none",
      }}/>

      <Fade d={0}>
        <div style={{
          fontSize: 11, fontWeight: 500, color: T.coral,
          letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 20,
        }}>
          Forge
        </div>
        <div style={{ fontFamily: T.serif, fontSize: 44, fontWeight: 300, lineHeight: 1.1, marginBottom: 16 }}>
          Train with<br/><span style={{ fontStyle: "italic", color: T.coral }}>intention.</span>
        </div>
      </Fade>

      <Fade d={120}>
        <p style={{ fontSize: 15, color: T.text2, lineHeight: 1.65, marginBottom: 28 }}>
          A lean strength tracker. Three sessions a week, the right lifts, and a timer that minds its own business.
        </p>
      </Fade>

      {/* The three promises — feel like editorial callouts rather than feature
          bullets. Strength promise nods to the focus-picker (Forged / Strong /
          Sculpt) since that's now a first-class part of the loop — used to
          just say "the right lifts" but the personalisation deserves a hint. */}
      <Fade d={200}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 32 }}>
          <PromiseLine
            accent={T.coral}
            kicker="Strength"
            body="Three sessions a week, shaped around your training focus. Your weights adapt to how you felt last time."
          />
          <PromiseLine
            accent={T.steel}
            kicker="Conditioning"
            body="Zone 2 and HIIT days baked in. Because a strong heart matters as much as a strong back."
          />
          <PromiseLine
            accent={T.sage}
            kicker="Yours"
            body="No accounts, no email, no bullshit. Your name, a passkey, and you're in."
          />
        </div>
      </Fade>

      <Fade d={320}>
        <button onClick={() => onContinue()} style={{
          width: "100%", padding: "18px 24px",
          background: T.coral, border: "none", borderRadius: T.r.lg, cursor: "pointer",
          fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.bg0,
          boxShadow: `0 12px 40px ${s.glow}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span>Let's go</span>
          <span style={{ fontSize: 18 }}>→</span>
        </button>
      </Fade>
    </div>
  );
}

function PromiseLine({ accent, kicker, body }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <div style={{
        width: 3, alignSelf: "stretch", minHeight: 48,
        borderRadius: 2, background: accent, flexShrink: 0, marginTop: 2,
      }}/>
      <div>
        <div style={{
          fontSize: 10, fontWeight: 500, color: accent,
          letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 5,
        }}>
          {kicker}
        </div>
        <div style={{ fontSize: 14, color: T.text1, lineHeight: 1.55 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

// ─── Profile Screen ────────────────────────────────────────────────────────────
// ProfileScreen now lives in components/ProfileScreen.jsx (PR3 3d-prep).

// ─── Home Screen ───────────────────────────────────────────────────────────────
// HomeScreen now lives in components/HomeScreen.jsx (PR3 3e-prep).
// ─── Session overview sheet ──────────────────────────────────────────────────
// Mid-session escape hatch: list every block in today's session, show which
// is current / done / not started, and let the user jump to any of them.
// Useful when a busy gym means the prescribed order isn't practical — pick
// up the bench you can get to first, come back to squats when the rack frees.
// Auto-flow is unchanged for users who don't open this surface.
function SessionOverviewSheet({ session, currentBlockIdx, draftLog, onJumpToBlock, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "session-overview-title";

  // For each block, derive its state from the draft log. "pairs done" mirrors
  // the resume-draft maths in handleResumeDraft — for non-superset blocks
  // there's one exercise so pairs = its set count; for supersets we log
  // both sides together so pairs = max(setsA, setsB).
  const blockState = session.blocks.map((b, i) => {
    const saved = draftLog?.blocks?.[b.id];
    const pairs = saved?.exercises
      ? Math.max(0, ...Object.values(saved.exercises).map(ex => (ex.sets || []).length))
      : 0;
    const total = b.sets || 0;
    let state = "upcoming";
    if (i === currentBlockIdx) state = "current";
    else if (pairs >= total && total > 0) state = "done";
    else if (pairs > 0) state = "partial";
    // Exercise summary — main blocks have `ex`, others have exA/exB
    const exNames = [b.ex?.name, b.exA?.name, b.exB?.name].filter(Boolean);
    return { i, b, pairs, total, state, exNames };
  });

  const stateStyle = {
    current:  { dot: T.coral, border: T.coral,           label: "Current",   labelColor: T.coral },
    done:     { dot: T.sage,  border: `${T.sage}66`,     label: "Done",      labelColor: T.sage  },
    partial:  { dot: T.gold,  border: `${T.gold}66`,     label: "Partial",   labelColor: T.gold  },
    upcoming: { dot: T.text4, border: T.bg3,             label: "Up next",   labelColor: T.text3 },
  };

  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"90vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          {session.name}
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:24,fontWeight:300,lineHeight:1.2,marginBottom:6}}>
          Pick where to <span style={{color:T.coral,fontStyle:"italic"}}>train next.</span>
        </div>
        <p style={{fontSize:12,color:T.text3,marginBottom:18,lineHeight:1.5}}>
          Auto-advance still happens — this is for when the gym dictates a different order.
        </p>

        <div style={{flex:1,overflowY:"auto",marginRight:-8,paddingRight:8}}>
          {blockState.map(({ i, b, pairs, total, state, exNames }) => {
            const s = stateStyle[state];
            return (
              <button key={b.id} onClick={() => onJumpToBlock(i)}
                disabled={state === "current"}
                aria-current={state === "current" ? "step" : undefined}
                style={{
                  display:"block",width:"100%",textAlign:"left",
                  padding:"12px 14px",marginBottom:8,
                  background: state === "current" ? `${T.coral}10` : T.bg3,
                  border: `1px solid ${s.border}`,borderRadius:T.r.md,
                  cursor: state === "current" ? "default" : "pointer",
                  opacity: state === "current" ? 0.85 : 1,
                  transition:`all 160ms ${T.ease}`,
                }}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:s.dot,display:"inline-block"}} aria-hidden="true"/>
                    <span style={{fontSize:11,fontWeight:500,color:s.labelColor,letterSpacing:"0.08em",textTransform:"uppercase"}}>{s.label}</span>
                  </div>
                  <span style={{fontSize:10,color:T.text4,fontVariantNumeric:"tabular-nums"}}>
                    {pairs}/{total} {b.type === "superset" ? "rounds" : "sets"}
                  </span>
                </div>
                <div style={{fontSize:10,color:T.text4,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:2}}>
                  {b.label}
                </div>
                <div style={{fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.text1,lineHeight:1.3}}>
                  {exNames.join(" + ") || "—"}
                </div>
              </button>
            );
          })}
        </div>

        <button onClick={onCancel}
          style={{marginTop:10,padding:"12px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.md,cursor:"pointer",fontSize:13,color:T.text2,fontFamily:T.sans}}>
          Back to current set
        </button>
      </div>
    </div>
  );
}

// ─── Recent-history sanity-check sheet ──────────────────────────────────────
// In-session helper: shows the last N performances of the active exercise so
// the user can sanity-check the engine's recommended weight against what they
// actually did last time. Read-only; tapping outside / Escape / "Close"
// dismisses. Empty state is handled by hiding the link itself, so this sheet
// renders only when there's at least one prior entry to show.
function RecentHistorySheet({ exerciseName, recent, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "recent-history-title";

  // Editorial relative date — keeps the visual restraint consistent with
  // the rest of the app. Anything > ~3 months falls back to month count.
  const fmt = (dateStr) => {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T12:00:00");
    if (isNaN(d.getTime())) return dateStr;
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.floor((today - d) / 86400000);
    if (diff <= 0) return "today";
    if (diff === 1) return "yesterday";
    if (diff < 7)   return `${diff} days ago`;
    if (diff < 14)  return "1 week ago";
    if (diff < 28)  return `${Math.floor(diff/7)} weeks ago`;
    const months = Math.floor(diff / 30);
    if (months === 1) return "1 month ago";
    return `${months} months ago`;
  };
  // Effort chip colour mirrors the RPE→RIR vocabulary the rest of the app uses.
  const effortColour = (e) => {
    if (!e) return T.text4;
    if (e === "easy")   return T.sage;
    if (e === "normal") return T.gold;
    if (e === "hard")   return T.coral;        // legacy
    if (e === "cooked" || e === "limit") return T.coral;
    return T.text4;
  };

  return (
    <div onKeyDown={onKeyDown} onClick={onCancel}
      style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          Recent history
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.2,marginBottom:14,color:T.text1}}>
          {exerciseName}
        </div>

        <div style={{flex:1,overflowY:"auto",marginRight:-8,paddingRight:8}}>
          {recent.map((r, i) => {
            const w  = r.topSet?.weight;
            const wr = w == null ? null : Number.isInteger(w) ? `${w}` : `${w}`;
            const reps = r.topSet?.reps;
            const summary = r.allEqual
              ? `${r.sets.length}×${reps ?? "?"}${w == null ? "" : ` @ ${wr} kg`}`
              : `top: ${wr ?? "?"}${w == null ? "" : " kg"} × ${reps ?? "?"}`;
            return (
              <div key={r.date + "_" + i}
                style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:i<recent.length-1?`1px solid ${T.bg3}`:"none"}}>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <span style={{fontSize:11,color:T.text3,letterSpacing:"0.06em",textTransform:"uppercase"}}>{fmt(r.date)}</span>
                  <span style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text1}}>{summary}</span>
                </div>
                {r.effort && (
                  <span aria-label={`Effort: ${r.effort}`}
                    style={{padding:"4px 9px",borderRadius:T.r.sm,border:`1px solid ${effortColour(r.effort)}55`,fontSize:10,fontWeight:500,color:effortColour(r.effort),letterSpacing:"0.06em",textTransform:"uppercase"}}>
                    {r.effort}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <button onClick={onCancel}
          style={{marginTop:14,padding:"12px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.md,cursor:"pointer",fontSize:13,color:T.text2,fontFamily:T.sans}}>
          Close
        </button>
      </div>
    </div>
  );
}

function ReadinessScreen({readiness,setReadiness,reason,setReason,onStart}){
  const opts=[
    {id:"fresh", icon:"○",label:"Fresh", sub:"Full programme. Push today.",       color:T.sage},
    {id:"normal",icon:"◐",label:"Normal",sub:"Standard session.",                  color:T.gold},
    {id:"cooked",icon:"●",label:"Cooked",sub:"Deload weights · trimmed volume.",   color:T.rose},
  ];
  // Short, enum-only reasons. Fed into session record so patterns can surface.
  // Only surfaces when readiness is "cooked" — the one state where context
  // is actually load-bearing for future pattern detection. Keeps the rest of
  // the flow friction-free.
  const reasons = [
    {id:"slept_badly", label:"Slept badly"},
    {id:"stressed",    label:"Stressed"},
    {id:"recovering",  label:"Still recovering"},
    {id:"sore",        label:"Sore"},
    {id:"other",       label:"Something else"},
  ];
  return (
    <div style={{minHeight:"100vh",padding:"72px 24px 0"}}>
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:34,fontWeight:300,lineHeight:1.2,marginBottom:8}}>
          How are you<br/><span style={{fontStyle:"italic",color:T.coral}}>feeling today?</span>
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:40,lineHeight:1.6}}>We'll shape the session around you.</p>
      </Fade>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {opts.map((o,i)=>(
          <Fade key={o.id} d={80+i*50}>
            <div onClick={()=>{ setReadiness(o.id); if (o.id !== "cooked") setReason(null); }} style={{padding:"18px 20px",borderRadius:T.r.lg,cursor:"pointer",background:readiness===o.id?`${o.color}12`:T.bg2,border:`1px solid ${readiness===o.id?o.color+"55":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 200ms ${T.ease}`}}>
              <div style={{display:"flex",alignItems:"center",gap:16}}>
                <span style={{fontSize:20,color:o.color,opacity:0.8}}>{o.icon}</span>
                <div>
                  <div style={{fontFamily:T.serif,fontSize:20,fontWeight:400}}>{o.label}</div>
                  <div style={{fontSize:12,color:T.text3,marginTop:2}}>{o.sub}</div>
                </div>
              </div>
              <div style={{width:20,height:20,borderRadius:"50%",background:readiness===o.id?o.color:"transparent",border:`1.5px solid ${readiness===o.id?o.color:T.bg4}`,display:"flex",alignItems:"center",justifyContent:"center",transition:`all 180ms ${T.ease}`}}>
                {readiness===o.id&&<span style={{fontSize:10,color:T.bg0}}>✓</span>}
              </div>
            </div>
          </Fade>
        ))}
      </div>

      {/* Optional "why?" — only surfaces when user picked Cooked.
          Fresh/Normal sessions skip this to keep the flow friction-free.
          Still skippable even when shown. */}
      {readiness === "cooked" && (
        <Fade d={0}>
          <div style={{marginTop:28}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10,display:"flex",alignItems:"baseline",justifyContent:"space-between"}}>
              <span>What's going on?</span>
              <span style={{fontSize:10,fontFamily:T.serif,fontStyle:"italic",color:T.text4,textTransform:"none",letterSpacing:0}}>optional</span>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {reasons.map(r => {
                const sel = reason === r.id;
                return (
                  <div key={r.id} onClick={()=>setReason(sel ? null : r.id)}
                    style={{padding:"8px 14px",borderRadius:T.r.pill,cursor:"pointer",background:sel?`${T.rose}18`:T.bg2,border:`1px solid ${sel?T.rose+"55":T.bg3}`,fontSize:13,fontFamily:T.serif,fontWeight:300,color:sel?T.text1:T.text2,transition:`all 180ms ${T.ease}`}}>
                    {r.label}
                  </div>
                );
              })}
            </div>
          </div>
        </Fade>
      )}

      <Fade d={280}>
        <button onClick={readiness?onStart:undefined} style={{marginTop:28,width:"100%",padding:"18px 24px",background:readiness?T.coral:T.bg2,border:`1px solid ${readiness?T.coral:T.bg3}`,borderRadius:T.r.lg,cursor:readiness?"pointer":"default",fontFamily:T.serif,fontSize:20,fontWeight:400,color:readiness?T.bg0:T.text4,transition:`all 220ms ${T.ease}`,boxShadow:readiness?`0 12px 40px ${T.strength.glow}`:"none"}}>
          Start session →
        </button>
      </Fade>
    </div>
  );
}

// ─── RPE Card ─────────────────���────────────────────────────────────────────────
// Per-set effort picker. Three-point scale: easy / normal / cooked.
// Maps to RIR via rpeToRir in storage.js: easy=3, normal=2, cooked=0.
// The legacy hard/limit scale is only kept as a read-time alias inside
// rpeToRir for v1 records — it must NOT appear in any UI.
function RpeCard({onPick,label="How was that set?"}){
  const opts=[
    {id:"easy",  icon:"😮‍💨",label:"Easy",  sub:"More in the tank",color:T.sage},
    {id:"normal",icon:"😤", label:"Normal",sub:"Working effort",   color:T.gold},
    {id:"cooked",icon:"🔥", label:"Cooked",sub:"Max effort",       color:T.rose},
  ];
  return (
    <div style={{margin:"14px 20px 0",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,padding:"16px 18px",animation:`fadeSlide 240ms ${T.ease}`}}>
      <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>{label}</div>
      <div style={{display:"flex",gap:8}}>
        {opts.map(o=>(
          <div key={o.id} onClick={()=>onPick(o.id)} style={{flex:1,padding:"12px 6px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.md,cursor:"pointer",textAlign:"center",transition:`all 180ms ${T.ease}`}}>
            <div style={{fontSize:20,marginBottom:4}}>{o.icon}</div>
            <div style={{fontFamily:T.serif,fontSize:15,fontWeight:400,color:T.text1}}>{o.label}</div>
            <div style={{fontSize:10,color:T.text3,marginTop:2,lineHeight:1.3}}>{o.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Rest progress line ──────────────────────────────────────────────────────
// Thin bone-coloured strip under the rest timer that drains in sync with the
// remaining seconds. Visually unobtrusive — dim track + slightly brighter
// fill — but gives the user a continuous "you're partway through" cue
// between the once-per-second text ticks. CSS transition does the smoothing
// so the line slides continuously even though `remain` only updates per
// integer second.
function RestProgressLine({ active, remain, total }) {
  if (!active || !total || total <= 0) return null;
  const pct = Math.max(0, Math.min(1, remain / total)) * 100;
  return (
    <div style={{marginTop:8,height:1,width:"100%",background:`${T.text2}22`,borderRadius:999,overflow:"hidden"}}>
      <div style={{height:"100%",width:`${pct}%`,background:T.text2,opacity:0.7,transition:"width 1000ms linear"}}/>
    </div>
  );
}

// ─── Session ──────────────────────────────────────────────────────────────────
function SessionScreen({session,block,blockIdx,totalBlocks,setNum,phase,isSS,activeEx,resolvedExA,resolvedExB,resolvedEx,swapKey,onSwap,showVid,setShowVid,getW,getR,editTarget,setEditTarget,workingWeights,setWW,workingReps,setWR,history=[],awaitRpe,ssRoundDone,restActive,restRemain,setRestActive,setRestRemain,onCommit,onLog,onQuit,onShowOverview,bodyweight,deloadDayTag=null}){
  const {strength:s}=T;
  const [swapEx,setSwapEx]=useState(null);
  const partnerEx=isSS?(phase==="A"?resolvedExB:resolvedExA):null;
  const vidEx    =isSS?(phase==="A"?resolvedExA:resolvedExB):resolvedEx;
  const progress =((blockIdx+(setNum-1)/block.sets)/totalBlocks)*100;
  const nameFz   =Math.min(38,Math.max(24,300/(activeEx?.name?.length||10)));
  const typeLabel={main:"Main lift",superset:"Superset",finisher:"Finisher"}[block.type];
  const currentW =getW(activeEx);
  // Recent-history sanity-check ribbon. Pulls the user's last 3 sessions
  // where activeEx was logged, opens a bottom sheet on tap. The link only
  // shows when there's at least one prior performance to display.
  const [historyOpen,setHistoryOpen]=useState(false);
  const recent = useMemo(
    () => recentForExercise(history, activeEx?.name, 3),
    [history, activeEx?.name]
  );
  const showRestHint=!isSS;
  const restMins =Math.floor(restRemain/60),restSecs=restRemain%60;
  const restStr  =`${restMins}:${String(restSecs).padStart(2,"0")}`;
  const blocking =awaitRpe||ssRoundDone;
  
  // Load type handling for bodyweight movements
  const loadType = getLoadType(activeEx);
  const showWeightPicker = loadType !== "bodyweight";
  const weightLabel = loadType === "loaded_bodyweight" || loadType === "loaded_bw" ? "+ kg"
                    : loadType === "assisted_bodyweight" ? "− kg"
                    : "kg";
  const loadTypeSubtitle = loadType === "bodyweight" ? "Bodyweight"
                         : loadType === "loaded_bodyweight" || loadType === "loaded_bw" ? "Added load"
                         : loadType === "assisted_bodyweight" ? "Band assist"
                         : null;
  // Caption telling the user what the entered weight represents. Resolves
  // the per-dumbbell-vs-total ambiguity that's been ambiguous in the UI so
  // far. Drives off the programme.js loadType vocabulary plus the
  // storage.js loadType vocabulary (both can appear via getLoadType).
  const weightCaption = WEIGHT_CAPTIONS[loadType] || null;

  return (
    <div style={{minHeight:"100vh",position:"relative",overflow:"clip",paddingBottom:40}}>
      <div style={{position:"absolute",top:-80,right:-80,width:340,height:320,background:`radial-gradient(circle,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      <div style={{height:1,background:T.bg3}}>
        <div style={{height:"100%",width:`${progress}%`,background:T.coral,transition:`width 600ms ${T.ease}`}}/>
      </div>
      <div style={{padding:"16px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <button onClick={onQuit} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans}}>← Quit</button>
        <button onClick={onShowOverview} aria-label="Open session overview"
          style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"right",display:"flex",flexDirection:"column",alignItems:"flex-end"}}>
          <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.1em",textTransform:"uppercase",display:"flex",alignItems:"center",gap:6}}>
            {session.name}
            <span style={{fontSize:9,opacity:0.7}}>▾</span>
          </div>
          <div style={{fontSize:10,color:T.text3,fontStyle:"italic",fontFamily:T.serif,marginTop:1}}>{block.label}</div>
        </button>
      </div>
      <div style={{padding:"14px 20px 0",display:"flex",gap:8,flexWrap:"wrap"}}>
        <Tag color={block.type==="main"?T.coral:block.type==="superset"?T.sage:T.gold}>{typeLabel}</Tag>
        {isSS&&<Tag color={T.steel}>Exercise {phase}</Tag>}
      </div>
      <div style={{padding:"14px 20px 0"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
          <div onClick={activeEx?.vid ? ()=>setShowVid(true) : undefined}
            style={{cursor:activeEx?.vid?"pointer":"default",flex:1,userSelect:"none"}}>
            <div style={{fontFamily:T.serif,fontSize:nameFz,fontWeight:300,lineHeight:1.1}}>{activeEx?.name}</div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginTop:8}}>
              {activeEx?.vid && (
                <span style={{fontSize:11,color:T.coral,fontWeight:500}}>▶ Watch demo</span>
              )}
              <span style={{fontSize:11,color:T.text3}}>{activeEx?.muscle}</span>
            </div>
          </div>
          <button
            onClick={()=>setSwapEx({block,phase})}
            style={{marginTop:4,flexShrink:0,background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.md,padding:"8px 12px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,transition:`all 180ms ${T.ease}`}}
          >
            <span style={{fontSize:14}}>⇄</span>
            <span style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.08em",textTransform:"uppercase"}}>Swap</span>
          </button>
        </div>
      </div>
      <div style={{padding:"22px 20px 0"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase"}}>Set {setNum} of {block.sets}</div>
          {loadTypeSubtitle && (
            <span style={{fontSize:10,color:T.sage,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>{loadTypeSubtitle}</span>
          )}
          {recent.length > 0 && (
            <button onClick={()=>setHistoryOpen(true)}
              aria-label={`Recent history for ${activeEx?.name}`}
              style={{marginLeft:"auto",padding:"3px 8px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,cursor:"pointer",fontSize:10,color:T.text3,fontFamily:T.sans,letterSpacing:"0.06em",textTransform:"uppercase"}}>
              Recent ↗
            </button>
          )}
        </div>
        {showWeightPicker && currentW!==null&&(
          <>
            <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:4,cursor:"pointer",userSelect:"none"}} onClick={()=>{ if(activeEx?.name) setEditTarget({exName:activeEx.name,currentKg:currentW,currentReps:getR(activeEx),loadType}); }}>
              <span style={{fontFamily:T.serif,fontSize:80,fontWeight:300,color:T.text1,lineHeight:1,letterSpacing:"-0.02em"}}>{currentW}</span>
              <span style={{fontFamily:T.serif,fontSize:22,fontWeight:300,color:T.text3,marginBottom:8}}>{weightLabel}</span>
              <span style={{fontSize:11,color:T.text3,marginBottom:10,marginLeft:4}}>↕</span>
            </div>
            {weightCaption && (
              <div style={{fontSize:11,color:T.text4,fontStyle:"italic",fontFamily:T.serif,marginBottom:4}}>{weightCaption}</div>
            )}
          </>
        )}
        {/* "reps" label is wrong for timed exercises (e.g. L-Sit Hold,
            prescribed as "20s"). Read the ORIGINAL prescribed value (not
            getR, which folds in any drum override that may have stamped
            an integer over the string). If timed, render "Xs · hold"
            instead of "X reps". The drum overlay also knows from this
            (target.timed) so its unit switches to seconds. */}
        {(() => {
          const timed = parseTimedReps(activeEx?.reps);
          const displayVal = getR(activeEx);
          return (
            <div style={{display:"flex",alignItems:"baseline",gap:6,cursor:"pointer",userSelect:"none"}} onClick={()=>{ if(activeEx?.name) setEditTarget({exName:activeEx.name,currentKg:showWeightPicker?currentW:null,currentReps:displayVal,loadType,timed:!!timed}); }}>
              <span style={{fontFamily:T.serif,fontSize:48,fontWeight:400,color:T.coral,lineHeight:1,fontStyle:"italic"}}>{timed ? `${typeof displayVal === "number" ? displayVal : timed.seconds}s` : displayVal}</span>
              <span style={{fontSize:14,color:T.text3,marginBottom:4}}>{timed ? "hold" : "reps"}</span>
              <span style={{fontSize:11,color:T.text3,marginBottom:6,marginLeft:4}}>↕</span>
            </div>
          );
        })()}
        {/* Phase 3 — quiet "deload · day N of M" subtitle in muted gold.
            Only renders during an active deload window. */}
        {deloadDayTag && (
          <div style={{marginTop:8,fontSize:11,fontWeight:500,color:`${T.gold}99`,letterSpacing:"0.08em",fontStyle:"italic",fontFamily:T.serif}}>
            {deloadDayTag}
          </div>
        )}
      </div>
      <div style={{padding:"16px 20px 0",display:"flex",gap:6}}>
        {Array.from({length:block.sets}).map((_,i)=>(
          <div key={i} style={{flex:1,height:3,borderRadius:2,background:i<setNum-1?T.coral:T.bg3,transition:`background 300ms ${T.ease}`}}/>
        ))}
      </div>
      {/* RPE pick = the set-confirm moment. haptic.commit on submission gives
          it weight — same gesture that ends every set on every platform. */}
      {awaitRpe&&<RpeCard onPick={(r)=>{haptic.commit();onCommit(r);}} label="How was that set?"/>}
      {ssRoundDone&&<RpeCard onPick={(r)=>{haptic.commit();onCommit(r);}} label={`Round ${setNum} of ${block.sets} — rate the effort`}/>}
      {!blocking&&(
        <>
          {showRestHint&&(
            <div style={{padding:"12px 20px 0"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontSize:12,color:restActive?T.coral:T.text4,fontStyle:"italic",fontFamily:T.serif,transition:`color 300ms ${T.ease}`}}>
                  {restActive?`Resting — ${restStr}`:`~${Math.round(block.rest/60)} min rest`}
                </span>
                <button onClick={()=>{if(restActive){setRestActive(false);setRestRemain(block.rest);}else{setRestRemain(block.rest);setRestActive(true);}}}
                  style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,padding:"4px 10px",cursor:"pointer",fontSize:11,color:restActive?T.coral:T.text3,transition:`all 180ms ${T.ease}`}}>
                  {restActive?"Skip":"Start timer"}
                </button>
              </div>
              <RestProgressLine active={restActive} remain={restRemain} total={block.rest} />
            </div>
          )}
          {isSS&&phase==="A"&&(
            restActive
              ?(
                <div style={{padding:"12px 20px 0"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontSize:12,color:T.coral,fontStyle:"italic",fontFamily:T.serif}}>Resting — {restStr}</span>
                    <button onClick={()=>{setRestActive(false);setRestRemain(block.rest);}} style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,padding:"4px 10px",cursor:"pointer",fontSize:11,color:T.coral}}>Skip</button>
                  </div>
                  <RestProgressLine active={restActive} remain={restRemain} total={block.rest} />
                </div>
              ):(
                <div style={{padding:"8px 20px 0",fontSize:12,color:T.text3,fontStyle:"italic",fontFamily:T.serif}}>
                  Straight into B — no rest between exercises
                </div>
              )
          )}
          <button onClick={()=>{haptic.tap();onLog();}} style={{margin:"12px 20px 0",width:"calc(100% - 40px)",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",boxShadow:`0 8px 28px ${s.glow}`}}>
            <span style={{fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0}}>
              {isSS?(phase==="A"?"Log A — into B":"Log B — round done"):"Log set"}
            </span>
            <span style={{fontSize:18,color:T.bg0}}>+</span>
          </button>
        </>
      )}
      {isSS&&!blocking&&(
        <Card style={{margin:"14px 20px 0",padding:"14px 18px"}}>
          <div style={{fontSize:10,fontWeight:500,color:T.text4,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>
            {phase==="A"?"Immediately after →":"Just completed ✓"}
          </div>
          <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:phase==="A"?T.text2:T.text4,lineHeight:1.15}}>{partnerEx?.name}</div>
          <div style={{fontSize:12,color:T.text4,marginTop:4}}>
            {partnerEx?.weight!==null&&getW(partnerEx)?`${getW(partnerEx)} kg  ·  `:""}{getR(partnerEx)} reps
          </div>
        </Card>
      )}
      {editTarget&&<DrumEditOverlay target={editTarget} workingWeights={workingWeights} setWW={setWW} workingReps={workingReps} setWR={setWR} block={block} onClose={()=>setEditTarget(null)}/>}
      {swapEx&&<SwapOverlay activeEx={activeEx} swapKey={swapKey} onSwap={onSwap} onClose={()=>setSwapEx(null)}/>}
      {showVid&&vidEx&&(
        <div onClick={()=>setShowVid(false)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.78)",backdropFilter:"blur(8px) saturate(115%)",WebkitBackdropFilter:"blur(8px) saturate(115%)",overscrollBehavior:"contain",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:24,width:"100%",maxWidth:430,borderTop:`1px solid ${T.coral}33`,animation:`slideUp 280ms ${T.ease}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{vidEx.name}</div>
                <div style={{fontSize:12,color:T.text3,marginTop:4}}>{vidEx.muscle}</div>
              </div>
              <button onClick={()=>setShowVid(false)} style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
            </div>
            <VideoEmbed vid={vidEx.vid} name={vidEx.name}/>
          </div>
        </div>
      )}
      {historyOpen && (
        <RecentHistorySheet
          exerciseName={activeEx?.name}
          recent={recent}
          onCancel={()=>setHistoryOpen(false)}
        />
      )}
    </div>
  );
}


// ─── Video Embed ───────────────────────────────────────────────────────────────
// Handles embedding disabled / private videos gracefully.
// If the iframe fails to load (e.g. embedding disabled), shows a direct YouTube link.
function VideoEmbed({vid,name}){
  const [failed,setFailed]=useState(false);
  if(!vid||failed){
    return(
      <div style={{width:"100%",aspectRatio:"16/9",background:T.bg3,borderRadius:T.r.md,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10}}>
        <span style={{fontSize:13,color:T.text3,fontStyle:"italic",fontFamily:T.serif}}>
          {!vid?"No demo video linked yet":"Video unavailable here"}
        </span>
        <a
          href={vid
            ? `https://www.youtube.com/watch?v=${vid}`
            : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} form`)}`}
          target="_blank" rel="noopener noreferrer"
          style={{fontSize:12,color:T.coral,fontWeight:500,textDecoration:"none"}}>
          {vid?"Watch on YouTube ↗":"Search YouTube ↗"}
        </a>
      </div>
    );
  }
  return(
    <iframe
      key={vid}
      src={`https://www.youtube.com/embed/${vid}?autoplay=0&modestbranding=1&rel=0`}
      style={{width:"100%",aspectRatio:"16/9",border:"none",borderRadius:T.r.md,background:T.bg0,display:"block"}}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      onError={()=>setFailed(true)}
    />
  );
}

// ─── Swap Overlay ────────────────────────────────────────────────────────────

function SwapOverlay({activeEx,swapKey,onSwap,onClose}){
  const [travel,setTravel]=useState(false);
  const options=(SWAP_DB[activeEx?.name]||[]).filter(o=>!travel||["Bodyweight","Dumbbell","Band"].includes(o.eq));

  const applySwap=(option)=>{
    // Inherit reps/weight from current slot — same movement pattern, same stimulus level.
    // User can fine-tune with the drum editor after swapping.
    onSwap(swapKey, {
      name:   option.name,
      muscle: option.muscle,
      reps:   activeEx?.reps   ?? 10,
      weight: activeEx?.weight ?? null,
      vid:    option.vid ?? null,
    });
    onClose();
  };
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "swap-overlay-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px 36px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
          <div>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>Swap exercise</div>
            <div id={titleId} style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text2,fontStyle:"italic"}}>{activeEx?.name}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,margin:"14px 0",padding:"10px 14px",background:T.bg3,borderRadius:T.r.md,cursor:"pointer"}} onClick={()=>setTravel(p=>!p)}>
          <div style={{width:32,height:18,borderRadius:9,background:travel?T.coral:T.bg4,position:"relative",transition:`background 200ms ${T.ease}`,flexShrink:0}}>
            <div style={{position:"absolute",top:2,left:travel?14:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:`left 200ms ${T.ease}`}}/>
          </div>
          <div>
            <div style={{fontSize:13,color:T.text1,fontWeight:500}}>Travel mode</div>
            <div style={{fontSize:11,color:T.text3,marginTop:1}}>Bodyweight, dumbbell & band only</div>
          </div>
        </div>
        {options.length===0&&(
          <div style={{padding:"20px 0",fontSize:13,color:T.text3,fontStyle:"italic",fontFamily:T.serif,textAlign:"center"}}>No alternatives for current filter</div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {options.map((o,i)=>(
            <div key={i} onClick={()=>applySwap(o)} style={{padding:"14px 16px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.md,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
              <div>
                <span style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,display:"block"}}>{o.name}</span>
                <span style={{fontSize:11,color:T.text3,marginTop:2,display:"block"}}>{o.muscle}</span>
              </div>
              <span style={{fontSize:10,fontWeight:500,color:EQ_COLOUR[o.eq]||T.text3,background:`${EQ_COLOUR[o.eq]||T.bg4}18`,border:`1px solid ${EQ_COLOUR[o.eq]||T.bg4}44`,borderRadius:T.r.pill,padding:"3px 10px",letterSpacing:"0.06em",textTransform:"uppercase",flexShrink:0,marginLeft:12}}>{o.eq}</span>
            </div>
          ))}
        </div>
        <div style={{marginTop:16,fontSize:11,color:T.text4,fontStyle:"italic",fontFamily:T.serif,textAlign:"center"}}>Tap an exercise to swap for this set</div>
      </div>
    </div>
  );
}

// ─── Rotation Summary Modal ───────────────────���───────────────────────────────
// Shown when auto-rotation fires. Non-dismissible — you acknowledge, you continue.
// ─── Week editor sheet ────────────────────────────────────────────────────────
// Lets users customise their training week (e.g. "no gym Monday — shift the
// strength days back to Thu/Fri/Sat"). Persists via W.save(); the engine reads
// the new week and reflows home / retro / done screens. Validation is advisory
// only — we surface a banner for "no strength days" / "missing sessions" but
// don't block saving (some users may intentionally run a 4-strength week or
// take a week off).
const WEEK_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_DAY_TYPES = [
  { type: "strength", label: "Strength" },
  { type: "zone2",    label: "Zone 2" },
  { type: "cardio",   label: "Cardio" },
  { type: "hiit",     label: "HIIT" },
  { type: "rest",     label: "Rest" },
];
// ─── Focus picker sheet ──────────────────────────────────────────────────────
// Lets users tune the accessory bias (Forged / Strong / Sculpt). Tap a focus
// FocusPickerSheet now lives in components/FocusPickerSheet.jsx (PR3 3d-route).

function WeekEditorSheet({ initialWeek, isCustom, onSave, onReset, onCancel }) {
  // Local draft — only commits on Save. Holds the full {s, label, type} shape;
  // the W.save validator will re-derive s/label from type on persist.
  const [draft, setDraft] = useState(() =>
    initialWeek.map((d, i) => ({
      s:     d.s     || ["M","T","W","T","F","S","S"][i],
      label: d.label || (WEEK_DAY_TYPES.find(t => t.type === d.type)?.label || "—"),
      type:  d.type,
    })),
  );
  const setDayType = (i, type) => {
    setDraft(prev => prev.map((d, j) => j === i
      ? { ...d, type, label: WEEK_DAY_TYPES.find(t => t.type === type)?.label || d.label }
      : d,
    ));
  };
  const strengthCount = draft.filter(d => d.type === "strength").length;
  const warning =
    strengthCount === 0 ? "No strength days — your programme won't progress." :
    strengthCount < 3   ? `Only ${strengthCount} strength day${strengthCount===1?"":"s"} — sessions B/C won't be reached.` :
    strengthCount > 3   ? `${strengthCount} strength days — A/B/C will cycle to fill (4th = A again).` :
    null;
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "week-editor-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"90vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          Weekly schedule
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.15,marginBottom:6}}>
          Shape your week.
        </div>
        <p style={{fontSize:13,color:T.text3,marginBottom:18,lineHeight:1.5}}>
          Pick what each day is. Strength days map to sessions A → B → C in order.
        </p>

        <div style={{flex:1,overflowY:"auto",marginRight:-8,paddingRight:8}}>
          {draft.map((d, i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:i<6?`1px solid ${T.bg3}`:"none"}}>
              <div style={{width:42,fontSize:12,fontWeight:500,color:T.text2,letterSpacing:"0.06em",textTransform:"uppercase"}}>
                {WEEK_DAY_LABELS[i]}
              </div>
              <div style={{flex:1,display:"flex",flexWrap:"wrap",gap:4}}>
                {WEEK_DAY_TYPES.map(opt => {
                  const active = d.type === opt.type;
                  const a = T[opt.type] || T.rest;
                  return (
                    <button key={opt.type} onClick={()=>setDayType(i, opt.type)}
                      style={{padding:"5px 9px",background:active?a.main:T.bg3,border:`1px solid ${active?a.main:T.bg4}`,borderRadius:T.r.sm,cursor:"pointer",fontSize:11,fontWeight:500,color:active?T.bg0:T.text2,fontFamily:T.sans,transition:`all 160ms ${T.ease}`}}>
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {warning && (
          <div style={{marginTop:14,padding:"10px 12px",background:`${T.gold}14`,border:`1px solid ${T.gold}44`,borderRadius:T.r.sm,fontSize:12,color:T.text2,lineHeight:1.5}}>
            {warning}
          </div>
        )}

        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button onClick={onCancel} style={{flex:1,padding:"14px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",fontSize:13,color:T.text2,fontFamily:T.sans}}>
            Cancel
          </button>
          <button onClick={()=>onSave(draft)} style={{flex:2,padding:"14px",background:T.gold,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.bg0}}>
            Save week
          </button>
        </div>
        {isCustom && (
          <button onClick={onReset} style={{marginTop:10,padding:"6px",background:"none",border:"none",cursor:"pointer",fontSize:11,color:T.text4,textDecoration:"underline",textUnderlineOffset:3,fontFamily:T.sans,alignSelf:"center"}}>
            Reset to default week (Mon/Wed/Fri strength)
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Rotation preview sheet (pre-commit) ────────────────────────────────────
// Surfaces the candidate rotation before anything saves. Three actions:
//   Confirm    — commit the preview, bump block, persist, show summary.
//   Roll again — recompute the candidate (fresh weighted-random draw).
//   Cancel     — drop the preview, no engine state change. Same as never
//                tapping rotate. Escape / backdrop tap also cancel.
//
// Re-rolls are unlimited — the engine is biased-probabilistic, not
// authoritative; the trainer is the user. The button hierarchy still nudges
// toward confirming the first reasonable preview (Confirm is primary gold,
// Roll again is secondary outlined).
function RotationPreviewSheet({ preview, onConfirm, onReroll, onCancel }) {
  const { gold } = T;
  const { changes = [], stimulusDelta = [] } = preview || {};
  const count = changes.length;
  const topDeltas = stimulusDelta.slice(0, 4);
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "rotation-preview-title";

  return (
    <div onKeyDown={onKeyDown} onClick={onCancel}
      style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${gold}44`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:gold,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          Rotation preview
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:30,fontWeight:300,lineHeight:1.15,marginBottom:8,color:T.text1}}>
          New picks<br/><span style={{color:gold,fontStyle:"italic"}}>for next block.</span>
        </div>
        <p style={{fontSize:13,color:T.text2,marginBottom:topDeltas.length?14:20,lineHeight:1.6}}>
          {count === 0
            ? "Same picks came up this roll. Roll again or confirm to start the block fresh anyway."
            : `${count} ${count === 1 ? "accessory" : "accessories"} would swap. Nothing's saved until you confirm.`}
        </p>

        {topDeltas.length > 0 && (
          <div style={{marginBottom:18}}>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
              Would shift stimulus toward
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {topDeltas.map(({ bucket, delta }) => {
                const positive = delta > 0;
                const colour = MUSCLE_COLOURS[bucket] || MUSCLE_COLOURS.Other;
                return (
                  <div key={bucket} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:T.r.sm,background:T.bg3,border:`1px solid ${colour}66`}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:colour,display:"inline-block"}} aria-hidden="true"/>
                    <span style={{fontSize:11,fontWeight:500,color:positive?colour:T.text3,fontVariantNumeric:"tabular-nums"}}>
                      {positive?"+":""}{delta.toFixed(1)}
                    </span>
                    <span style={{fontSize:11,color:T.text2}}>{bucket}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{flex:1,overflowY:"auto",marginBottom:18,marginRight:-8,paddingRight:8}}>
          {changes.map((c, i) => (
            <div key={c.slot} style={{padding:"12px 0",borderBottom:i<count-1?`1px solid ${T.bg3}`:"none"}}>
              <div style={{fontSize:10,fontWeight:500,color:T.text4,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:4}}>{c.slot}</div>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontFamily:T.serif,fontSize:14,fontWeight:300,color:T.text3,textDecoration:"line-through",textDecorationColor:T.text4}}>{c.from}</span>
                <span style={{fontSize:12,color:gold}}>→</span>
                <span style={{fontFamily:T.serif,fontSize:15,fontWeight:400,color:T.text1}}>{c.to}</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <button onClick={onConfirm}
            style={{width:"100%",padding:"16px 24px",background:gold,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:18,fontWeight:400,color:T.bg0,boxShadow:`0 12px 36px ${gold}33`}}>
            Confirm rotation
          </button>
          <div style={{display:"flex",gap:10}}>
            <button onClick={onReroll}
              style={{flex:1,padding:"12px",background:"none",border:`1px solid ${gold}66`,borderRadius:T.r.md,cursor:"pointer",fontFamily:T.sans,fontSize:13,fontWeight:500,color:gold}}>
              ↻ Roll again
            </button>
            <button onClick={onCancel}
              style={{flex:1,padding:"12px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.md,cursor:"pointer",fontFamily:T.sans,fontSize:13,color:T.text3}}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RotationSummaryModal({summary,onContinue}){
  const {gold}=T;
  const count = summary.changes.length;
  // Top 4 by magnitude — enough to tell the story, not enough to overwhelm.
  const topDeltas = (summary.stimulusDelta || []).slice(0, 4);
  // Auto-rotation summary is non-dismissible (user must Continue) — no onClose
  // wired to the a11y hook; Escape is intentionally inert here.
  const { containerRef, onKeyDown } = useModalA11y(null);
  const titleId = "rotation-summary-title";
  return (
    <div onKeyDown={onKeyDown} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.86)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${gold}44`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:gold,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          New block · {summary.blockNumber}
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:30,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
          Your programme<br/><span style={{color:gold,fontStyle:"italic"}}>has rotated.</span>
        </div>
        <p style={{fontSize:13,color:T.text2,marginBottom:topDeltas.length?14:20,lineHeight:1.6}}>
          {count} {count===1?"accessory":"accessories"} swapped to keep the stimulus fresh. Main lifts stay the same — progressive overload continues.
        </p>
        {topDeltas.length > 0 && (
          <div style={{marginBottom:20}}>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
              This block · muscle stimulus
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {topDeltas.map(({bucket, delta}) => {
                const positive = delta > 0;
                const colour = MUSCLE_COLOURS[bucket] || MUSCLE_COLOURS.Other;
                return (
                  <div key={bucket} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:T.r.sm,background:T.bg3,border:`1px solid ${colour}66`}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:colour,display:"inline-block"}} aria-hidden="true"/>
                    <span style={{fontSize:11,fontWeight:500,color:positive?colour:T.text3,fontVariantNumeric:"tabular-nums"}}>
                      {positive?"+":""}{delta.toFixed(1)}
                    </span>
                    <span style={{fontSize:11,color:T.text2}}>{bucket}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div style={{flex:1,overflowY:"auto",marginBottom:20,marginRight:-8,paddingRight:8}}>
          {count===0 && (
            <div style={{padding:"20px 0",fontSize:13,color:T.text3,fontStyle:"italic",fontFamily:T.serif,textAlign:"center"}}>
              Rotation ran — same picks held. Rare but possible.
            </div>
          )}
          {summary.changes.map((c,i)=>(
            <div key={i} style={{padding:"12px 0",borderBottom:i<count-1?`1px solid ${T.bg3}`:"none"}}>
              <div style={{fontSize:10,fontWeight:500,color:T.text4,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:4}}>{c.slot}</div>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontFamily:T.serif,fontSize:14,fontWeight:300,color:T.text3,textDecoration:"line-through",textDecorationColor:T.text4}}>{c.from}</span>
                <span style={{fontSize:12,color:gold}}>→</span>
                <span style={{fontFamily:T.serif,fontSize:15,fontWeight:400,color:T.text1}}>{c.to}</span>
              </div>
            </div>
          ))}
        </div>
        <button onClick={onContinue} style={{width:"100%",padding:"16px 24px",background:gold,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:19,fontWeight:400,color:T.bg0,boxShadow:`0 12px 36px ${gold}33`}}>
          Continue to readiness →
        </button>
      </div>
    </div>
  );
}

// ─── Drum Edit ───────────────��─────────────────────────────────────────────────
function DrumEditOverlay({target,workingWeights,setWW,workingReps,setWR,block,onClose}){
  const ex=block.type==="main"?block.ex:(target.exName===block.exA?.name?block.exA:block.exB);
  const initKg  =workingWeights[target.exName]??ex?.weight??0;
  const rawReps =workingReps[target.exName]??ex?.reps;
  // Timed exercises (L-Sit Hold prescribed "20s") seed from the parsed
  // seconds, not a default 8/20. Without this the drum opens at "8 reps"
  // for a 20-second hold, the user confirms, and the prescription is
  // silently stamped over with an integer that's then treated as reps
  // everywhere downstream. target.timed is set by the session-screen
  // dispatcher when the prescribed value parses as a duration.
  const timedSeed = target.timed ? parseTimedReps(ex?.reps)?.seconds : null;
  const initReps = typeof rawReps==="string"
    ? (timedSeed ?? 8)
    : (rawReps ?? timedSeed ?? 8);
  const [kg,setKg]    =useState(initKg);
  const [reps,setReps]=useState(initReps);
  const hasWeight=ex?.weight!==null&&ex?.weight!==undefined;
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "drum-edit-title";
  // Step size honours real-world implement increments: dumbbells come in
  // whole-kg jumps (rarely 0.5kg, never 1.25), barbells take 1.25kg micro-
  // plates, cables move in fixed-stack increments (usually 2.5kg). Default
  // 1.25 stays for unknown / explicitly micro-loadable lifts.
  const lt = getLoadType(ex);
  const weightStep = weightStepForLoadType(lt);
  return (
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div><div id={titleId} style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{target.exName}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:4}}>Scroll to adjust</div></div>
          <button onClick={onClose} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
        </div>
        <div style={{display:"flex",gap:16,justifyContent:hasWeight?"space-between":"center"}}>
          {hasWeight&&<ScrollDrum value={kg} onChange={setKg} step={weightStep} min={0} max={400} label={lt==="per_db"?"kg / db":"kg"}/>}
          <ScrollDrum value={reps} onChange={setReps} step={target.timed?5:1} min={target.timed?5:1} max={target.timed?180:30} integer label={target.timed?"sec":"reps"} unit={target.timed?"sec":undefined}/>
        </div>
        <button onClick={()=>{
          if(hasWeight) setWW(p=>({...p,[target.exName]:kg}));
          setWR(p=>({...p,[target.exName]:reps}));
          onClose();
        }} style={{marginTop:24,width:"100%",padding:"16px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:18,fontWeight:400,color:T.bg0,boxShadow:`0 8px 28px ${T.strength.glow}`}}>
          Confirm →
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// RETROSPECTIVE LOGGING — picker bottom sheet + single-screen entry form
// ═════════════════════════════════════════════════════════════════════════════
//
// Two components handle the retro flow. The picker is a small bottom sheet
// listing the last 3 calendar days; only missed strength days are tappable.
// The session sheet is a full screen showing every exercise on one page —
// optimised for memory recall, not workout pacing. No timers, no readiness
// modal, single RPE per exercise. Engine treats the resulting record exactly
// like a live one.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Retro Picker Sheet ────────────────────────────────────────────────────────
// Exported for direct component testing (tests/components/RetroPickerSheet.test.jsx).
// Still rendered only via the in-file mount at <RetroPickerSheet ... /> below.
// Reflective catch-up — voice is "be honest," not "tick everything off."
// The list shows the recent days that don't have a record yet, ordered
// newest-first. Each row has one tap: strength → log via retro sheet,
// non-strength → "Yes" confirms you did it (writes dayDone). Confirmed
// rows fade out in place. No count badge, no auto-close celebration, no
// "back to it" closure beat — those rewarded clearing the list, which is
// the speedrun/streak-gaming antipattern we explicitly want to avoid.
// The user reads, decides per day, closes when they're done.
export function RetroPickerSheet({untickedDays=[], pendingDraft, onPick, onTickDate, onClose}){
  const draftBlocks = !!pendingDraft;
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "retro-picker-title";

  // Local view-state: track which rows have been dismissed in-place during
  // this sheet session. The parent list refreshes on close via the dayDone
  // state in ForgeApp — for the duration of this open, the in-place fade
  // is just visual continuity.
  const [dismissed, setDismissed] = useState(() => new Set());
  const visible = untickedDays.filter(r => !dismissed.has(r.date));

  const dismissRow = (dateStr) => setDismissed(prev => {
    const next = new Set(prev);
    next.add(dateStr);
    return next;
  });

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.sage}28`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
          <div>
            <div id={titleId} style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>Recent days</div>
            <div style={{fontSize:12,color:T.text3,marginTop:4,lineHeight:1.5,maxWidth:"calc(100% - 8px)"}}>
              {draftBlocks
                ? "Finish your live session first"
                : "Log what you actually trained. Leave the rest."}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13,flexShrink:0}}>✕</button>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {visible.length === 0 && (
            // Two empty states, deliberately different:
            //   - dismissed.size > 0: the user just cleared the list by
            //     hand. A small celebratory beat — sage tick, italic
            //     "Well kept." Acknowledges the discipline of honest
            //     logging, not the act of clearing the list. No auto-
            //     close; the user lingers as long as they want.
            //   - dismissed.size === 0: opened to an already-empty list.
            //     Neutral "Nothing pending." No reward for showing up to
            //     a blank surface.
            dismissed.size > 0 ? (
              <div style={{padding:"22px 4px 6px",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
                <span style={{fontSize:18,color:T.sage,lineHeight:1}}>✓</span>
                <span style={{fontSize:14,color:T.sage,fontStyle:"italic",fontFamily:T.serif,letterSpacing:"0.02em"}}>Well kept.</span>
              </div>
            ) : (
              <div style={{padding:"16px 4px 4px",fontSize:12,color:T.text3,fontStyle:"italic",fontFamily:T.serif,textAlign:"center",lineHeight:1.5}}>
                Nothing pending.
              </div>
            )
          )}
          {visible.map((row) => {
            const isLog = row.action === "log";
            const colour = isLog ? T.coral : T.sage;
            const onTap = draftBlocks ? undefined : (isLog
              ? () => onPick?.(row.date)
              : () => { onTickDate?.(row.date); dismissRow(row.date); }
            );
            return (
              <div key={row.date}
                onClick={onTap}
                style={{
                  padding:"14px 16px",
                  background: draftBlocks ? T.bg3 : `${colour}0A`,
                  border: `1px solid ${draftBlocks ? T.bg4 : colour+"33"}`,
                  borderRadius: T.r.md,
                  cursor: draftBlocks ? "default" : "pointer",
                  display:"flex",alignItems:"center",justifyContent:"space-between",
                  opacity: draftBlocks ? 0.5 : 1,
                  animation: `fadeSlide 220ms ${T.ease}`,
                  transition: `all 180ms ${T.ease}`,
                }}>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <div style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text1,lineHeight:1.2}}>
                    {row.dateLabel}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{display:"inline-block",width:5,height:5,borderRadius:"50%",background:colour}}/>
                    <span style={{fontSize:11,color:T.text3,letterSpacing:"0.04em"}}>
                      {row.sessionName}
                    </span>
                  </div>
                </div>
                {!draftBlocks && (isLog
                  ? <span style={{fontSize:13,fontWeight:500,color:T.coral,letterSpacing:"0.04em"}}>Log →</span>
                  : <span style={{fontSize:13,fontWeight:500,color:T.sage,letterSpacing:"0.04em"}}>Yes — done</span>
                )}
              </div>
            );
          })}
        </div>

        <div style={{marginTop:16,fontSize:11,color:T.text4,fontStyle:"italic",fontFamily:T.serif,textAlign:"center",lineHeight:1.5}}>
          Only the last week. Anything older is archaeology.
        </div>
      </div>
    </div>
  );
}

// ─── Retrospective Session Sheet ───────────────────────────────────────────────
// Full-screen single-page form. Pre-populated from the programme rotation for
// the selected date. Auto-fill across cells in a row; tap any cell to override
// via the existing ScrollDrum overlay. Skip toggle per exercise. One RPE
// applied to all sets in an exercise.
function RetrospectiveSessionSheet({date, bodyweight, workingWeights, workingReps, userWeek=WEEK, onCancel, onSubmit}){
  const meta = useMemo(() => sessionMetaForDate(date, userWeek), [date, userWeek]);
  const sessionDef = meta?.type === "strength" ? SESSIONS[meta.sessionIdx] : null;

  // Flatten blocks into a single exercise list, but keep a back-reference to
  // the source block so we can preserve block type/intent in the session record.
  // Supersets and finishers contribute both exA + exB as independent rows in
  // retro mode (no superset visual grouping — keeping the form simple).
  const exerciseRows = useMemo(() => {
    if (!sessionDef) return [];
    const rows = [];
    for (const block of sessionDef.blocks) {
      if (block.type === "main") {
        rows.push({ ...block.ex, blockId: block.id, blockType: block.type, sets: block.sets });
      } else {
        // superset / finisher — both exercises
        if (block.exA) rows.push({ ...block.exA, blockId: block.id, blockType: block.type, sets: block.sets });
        if (block.exB) rows.push({ ...block.exB, blockId: block.id, blockType: block.type, sets: block.sets });
      }
    }
    return rows;
  }, [sessionDef]);

  // Per-exercise state. Initialised from prescribed weight/reps with all cells
  // pre-filled. weightEdited / repsEdited tracks per-cell user overrides so the
  // first-cell auto-fill only propagates to cells the user hasn't touched.
  const [entries, setEntries] = useState(() => exerciseRows.map(ex => {
    const setCount = ex.sets || 3;
    // Same resolution order as the live session's getW: working → BW-seeded → SESSIONS default.
    const baseWeight = workingWeights[ex.name]
      ?? startingWeightForLift(ex.name, bodyweight)
      ?? ex.weight
      ?? null;
    const baseReps   = workingReps[ex.name] ?? ex.reps ?? null;
    const lt = getLoadType(ex);
    return {
      name: ex.name,
      muscle: ex.muscle,
      blockId: ex.blockId,
      blockType: ex.blockType,
      blockIntent: null,
      loadType: lt,
      sets: setCount,
      weights: Array(setCount).fill(baseWeight),
      reps:    Array(setCount).fill(baseReps),
      weightEdited: Array(setCount).fill(false),
      repsEdited:   Array(setCount).fill(false),
      rpe: "normal",
      skipped: false,
      prescribed: { sets: setCount, reps: baseReps, weight: baseWeight, rir: null },
      vid: ex.vid,
    };
  }));

  // Inline cell editor — { exIdx, cellIdx, kind: "weight"|"reps" }
  const [editor, setEditor] = useState(null);

  const updateCell = useCallback((exIdx, cellIdx, kind, value) => {
    setEntries(prev => prev.map((entry, i) => {
      if (i !== exIdx) return entry;
      const arr = kind === "weight" ? [...entry.weights] : [...entry.reps];
      const editedArr = kind === "weight" ? [...entry.weightEdited] : [...entry.repsEdited];

      arr[cellIdx] = value;
      editedArr[cellIdx] = true;

      // Auto-fill: changing the first cell propagates to all subsequent cells
      // that haven't been individually touched. Subsequent cell edits just
      // mark themselves as edited and don't propagate.
      if (cellIdx === 0) {
        for (let j = 1; j < arr.length; j++) {
          if (!editedArr[j]) arr[j] = value;
        }
      }

      return {
        ...entry,
        ...(kind === "weight" ? { weights: arr, weightEdited: editedArr } : { reps: arr, repsEdited: editedArr }),
      };
    }));
  }, []);

  const toggleSkip = useCallback((exIdx) => {
    setEntries(prev => prev.map((entry, i) => i === exIdx ? { ...entry, skipped: !entry.skipped } : entry));
  }, []);

  const setRpe = useCallback((exIdx, rpe) => {
    setEntries(prev => prev.map((entry, i) => i === exIdx ? { ...entry, rpe } : entry));
  }, []);

  const allSkipped = entries.every(e => e.skipped);

  if (!meta || meta.type !== "strength" || !sessionDef) {
    return (
      <div style={{padding:"72px 24px",fontFamily:T.sans,color:T.text2,textAlign:"center"}}>
        <p>Couldn&apos;t resolve the session for that date.</p>
        <button onClick={onCancel} style={{marginTop:20,padding:"12px 20px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.md,color:T.text1,cursor:"pointer"}}>← Back</button>
      </div>
    );
  }

  return (
    <div style={{minHeight:"100vh",position:"relative",overflow:"clip",paddingBottom:120}}>
      {/* Sage ambient — wellness/measurement territory, not training */}
      <div style={{position:"absolute",top:-100,right:-80,width:340,height:300,background:`radial-gradient(circle,${T.sage}1A 0%,transparent 65%)`,pointerEvents:"none"}}/>

      {/* Header */}
      <Fade d={0}>
        <div style={{padding:"20px 20px 0",display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
          <button onClick={onCancel} aria-label="Cancel"
            style={{background:"none",border:"none",padding:"4px 0",cursor:"pointer",fontSize:13,color:T.text3,fontFamily:T.sans,flexShrink:0}}>← Cancel</button>
          <div style={{textAlign:"right",flex:1}}>
            <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,lineHeight:1.15,color:T.text1}}>
              {meta.sessionName} <span style={{color:T.text3,fontStyle:"italic"}}>· {meta.dateLabel}</span>
            </div>
            <div style={{fontSize:11,color:T.sage,fontStyle:"italic",fontFamily:T.serif,marginTop:4}}>
              Logging from memory
            </div>
          </div>
        </div>
      </Fade>

      {/* Hint about auto-fill — small, only relevant on first use */}
      <Fade d={60}>
        <div style={{padding:"16px 20px 0"}}>
          <div style={{fontSize:11,color:T.text3,lineHeight:1.5,fontStyle:"italic",fontFamily:T.serif}}>
            Defaults from the prescribed session. Tap any cell to adjust — the rest auto-fill until you override them. Skip what you didn&apos;t do.
          </div>
        </div>
      </Fade>

      {/* Exercise rows */}
      <div style={{padding:"20px 20px 0",display:"flex",flexDirection:"column",gap:14}}>
        {entries.map((entry, idx) => {
          const isBwOnly      = entry.loadType === "bodyweight";
          const isLoadedBw    = entry.loadType === "loaded_bodyweight";
          const isAssistedBw  = entry.loadType === "assisted_bodyweight";
          const showWeight    = !isBwOnly;
          const weightUnit    = isLoadedBw ? "+ kg" : isAssistedBw ? "− kg" : "kg";

          return (
            <Fade key={entry.name + idx} d={120 + idx * 30}>
              <div style={{
                padding:"16px 18px 18px",
                background: T.bg2,
                border: `1px solid ${T.bg3}`,
                borderRadius: T.r.lg,
                opacity: entry.skipped ? 0.45 : 1,
                transition: `opacity 180ms ${T.ease}`,
              }}>
                {/* Exercise name + skip toggle */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:10}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:T.serif,fontSize:18,fontWeight:300,lineHeight:1.2,color:T.text1}}>
                      {entry.name}
                    </div>
                    <div style={{fontSize:10,color:T.text3,letterSpacing:"0.06em",marginTop:3}}>
                      {entry.sets} × {entry.prescribed.reps} {entry.muscle ? `· ${entry.muscle}` : ""}
                    </div>
                  </div>
                  <button onClick={() => toggleSkip(idx)}
                    style={{flexShrink:0,padding:"6px 12px",background:entry.skipped?T.coral+"22":"transparent",border:`1px solid ${entry.skipped?T.coral+"55":T.bg4}`,borderRadius:T.r.pill,cursor:"pointer",fontFamily:T.sans,fontSize:11,color:entry.skipped?T.coral:T.text3,letterSpacing:"0.04em"}}>
                    {entry.skipped ? "Skipped" : "Skip"}
                  </button>
                </div>

                {!entry.skipped && (
                  <>
                    {/* Set cells — compact horizontal grid */}
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12}}>
                      {Array.from({length: entry.sets}).map((_, cellIdx) => {
                        const value = showWeight ? entry.weights[cellIdx] : entry.reps[cellIdx];
                        const display = value === null || value === undefined ? "—" : (typeof value === "string" ? value : String(value));
                        return (
                          <button key={cellIdx}
                            onClick={() => setEditor({ exIdx: idx, cellIdx, kind: showWeight ? "weight" : "reps" })}
                            style={{
                              flex:1,
                              padding:"10px 4px",
                              background:T.bg3,
                              border:`1px solid ${T.bg4}`,
                              borderRadius:T.r.md,
                              cursor:"pointer",
                              fontFamily:T.serif,
                              fontSize:18,
                              fontWeight:300,
                              color:T.text1,
                              textAlign:"center",
                            }}>
                            {display}
                          </button>
                        );
                      })}
                      <span style={{fontFamily:T.serif,fontSize:11,fontWeight:300,color:T.text3,fontStyle:"italic",marginLeft:6,minWidth:32}}>
                        {showWeight ? weightUnit : "reps"}
                      </span>
                    </div>

                    {/* RPE selector — 3-point */}
                    <div style={{display:"flex",gap:6}}>
                      {[
                        {id:"easy",  label:"Easy"},
                        {id:"normal",label:"Normal"},
                        {id:"cooked",label:"Cooked"},
                      ].map(o => {
                        const sel = entry.rpe === o.id;
                        return (
                          <button key={o.id} onClick={() => setRpe(idx, o.id)}
                            style={{
                              flex:1,
                              padding:"8px 4px",
                              background: sel ? `${T.coral}18` : T.bg3,
                              border: `1px solid ${sel ? T.coral+"55" : T.bg4}`,
                              borderRadius: T.r.sm,
                              cursor:"pointer",
                              fontFamily:T.sans,
                              fontSize:12,
                              fontWeight:500,
                              color: sel ? T.coral : T.text3,
                              letterSpacing:"0.02em",
                            }}>
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </Fade>
          );
        })}
      </div>

      {/* Submit bar — sticky bottom. Sage CTA: this is honest gap-filling,
          not a training action, so semantically aligned with measurement. */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,padding:"16px 20px calc(20px + env(safe-area-inset-bottom))",background:`linear-gradient(to top,${T.bg0} 60%,transparent)`,zIndex:50}}>
        <button
          onClick={() => onSubmit({ exercises: entries })}
          disabled={allSkipped}
          style={{
            width:"100%",
            padding:"16px 24px",
            background: allSkipped ? T.bg3 : T.sage,
            border:"none",
            borderRadius:T.r.lg,
            cursor: allSkipped ? "default" : "pointer",
            fontFamily:T.serif,
            fontSize:18,
            fontWeight:400,
            color: allSkipped ? T.text4 : T.bg0,
            boxShadow: allSkipped ? "none" : `0 8px 28px ${T.sage}26`,
            display:"flex",alignItems:"center",justifyContent:"space-between",
            transition:`all 200ms ${T.ease}`,
          }}>
          <span>{allSkipped ? "Skip everything?" : "Log session"}</span>
          {!allSkipped && <span style={{fontSize:16}}>→</span>}
        </button>
      </div>

      {/* Cell editor — single ScrollDrum bottom sheet */}
      {editor !== null && (() => {
        const entry = entries[editor.exIdx];
        const isWeight = editor.kind === "weight";
        const value = isWeight ? entry.weights[editor.cellIdx] : entry.reps[editor.cellIdx];
        const numericValue = (() => {
          if (typeof value === "number") return value;
          if (typeof value === "string") {
            const m = value.match(/^([0-9]+)/);
            return m ? parseInt(m[1], 10) : 8;
          }
          return isWeight ? 60 : 8;
        })();
        const isLoadedBw    = entry.loadType === "loaded_bodyweight";
        const isAssistedBw  = entry.loadType === "assisted_bodyweight";
        const unit = isWeight ? (isLoadedBw ? "+ kg" : isAssistedBw ? "− kg" : "kg") : "reps";

        return (
          <div onClick={() => setEditor(null)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
                <div>
                  <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,lineHeight:1.1}}>
                    {entry.name}
                  </div>
                  <div style={{fontSize:12,color:T.text3,marginTop:4}}>
                    Set {editor.cellIdx + 1} of {entry.sets}{editor.cellIdx === 0 ? " · auto-fills the rest" : ""}
                  </div>
                </div>
                <button onClick={() => setEditor(null)} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
              </div>

              <div style={{display:"flex",justifyContent:"center",marginBottom:20}}>
                <ScrollDrum
                  value={numericValue}
                  onChange={(v) => updateCell(editor.exIdx, editor.cellIdx, editor.kind, v)}
                  step={isWeight ? weightStepForLoadType(entry.loadType) : 1}
                  min={isWeight ? 0 : 1}
                  max={isWeight ? 400 : 30}
                  integer={!isWeight}
                  unit={unit}
                />
              </div>

              <button onClick={() => setEditor(null)}
                style={{width:"100%",padding:"14px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.bg0,boxShadow:`0 8px 28px ${T.strength.glow}`}}>
                Done
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// BodyweightEditModal now lives in components/BodyweightEditModal.jsx (PR3 3c).

// ─── Done ──────────────────────────────────────────────────────────────────────
const DONE_HEADLINES = [
  ["Solid", "work."],
  ["That's", "a session."],
  ["Job", "done."],
  ["Nothing", "wasted."],
];
const NEXT_DAY_MSG = {
  zone2:  "Zone 2 tomorrow. 60 min, conversational pace.",
  cardio: "Moderate cardio tomorrow. 35 min at ~75%.",
  hiit:   "HIIT tomorrow. 8–10 rounds, all out.",
  rest:   "Rest day tomorrow. You've earned it.",
  strength:"Strength session next. Load up.",
};

function DoneScreen({session,profileName,workingWeights,sessionStartWeights={},userWeek=WEEK,onHome,deloadCompleted=false,returnGapDays=null}){
  // `base` = what the user lifted at SESSION START (snapshotted in
  // sessionStartWeightsRef on handleReadinessStart). Falls back to the
  // current working weight if no snapshot (e.g. very first session) — that
  // produces a no-change rendering, not a misleading "template → current"
  // diff against the SESSIONS template's seeded starting weight.
  const nudges = session.blocks.filter(b=>b.type==="main").map(b=>{
    const current = workingWeights[b.ex.name] ?? b.ex.weight;
    const base    = sessionStartWeights[b.ex.name] ?? current;
    return { ex:b.ex.name, base, current, changed: current !== base };
  });

  // Pick a random headline pair, stable for this render
  const [hi] = useState(()=>DONE_HEADLINES[Math.floor(Math.random()*DONE_HEADLINES.length)]);

  // Derive what's next
  const dow     = new Date().getDay();
  const weekMap = [6,0,1,2,3,4,5];
  const todayIdx= weekMap[dow];
  const nextIdx = (todayIdx+1) % 7;
  const nextType= userWeek[nextIdx]?.type ?? "rest";
  const nextMsg = NEXT_DAY_MSG[nextType] ?? "";

  // Sync status for confirmation line
  const [syncState, setSyncState] = useState(SyncStatus.get());
  useEffect(() => SyncStatus.subscribe(setSyncState), []);

  return (
    <div style={{minHeight:"100vh",padding:"72px 24px 0",position:"relative",overflow:"clip"}}>
      {/* Victory gradient — warm peach wash from top-centre down. A small
          non-patronising triumph beat at the moment the user has just put
          the work in. Two stacked layers: a tight glow above the headline +
          a broader linear wash so the warmth extends down without competing
          with the body copy. */}
      <div style={{position:"absolute",top:-120,left:"50%",transform:"translateX(-50%)",width:540,height:460,background:`radial-gradient(circle,${T.strength.glow} 0%,transparent 60%)`,pointerEvents:"none",opacity:1.15}}/>
      <div style={{position:"absolute",inset:0,background:`linear-gradient(180deg, rgba(224,149,106,0.12) 0%, rgba(224,149,106,0.04) 22%, transparent 45%)`,pointerEvents:"none"}}/>
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:13,fontWeight:300,fontStyle:"italic",color:T.text3,marginBottom:12}}>
          {profileName} · {session.name}
        </div>
        <div style={{fontFamily:T.serif,fontSize:48,fontWeight:300,lineHeight:1.05,marginBottom:8}}>
          {hi[0]}<br/><span style={{color:T.coral,fontStyle:"italic"}}>{hi[1]}</span>
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:32,lineHeight:1.6}}>{nextMsg}</p>
      </Fade>
      {nudges.length > 0 && (
        <Fade d={80}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>Main lifts</div>
        </Fade>
      )}
      {nudges.map((n,i)=>(
        <Fade key={i} d={120+i*60}>
          <Card style={{padding:"16px 20px",marginBottom:10,borderLeft:`2px solid ${n.changed?T.coral:T.bg4}`}}>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>{n.ex}</div>
            <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1}}>
              {n.base} kg{n.changed&&<span style={{color:T.coral}}> → {n.current} kg</span>}
            </div>
            <div style={{fontSize:12,marginTop:6,color:n.changed?T.coral:T.text4,fontStyle:"italic",fontFamily:T.serif}}>
              {n.changed?"Weight updated for next session":"Hold — keep grinding"}
            </div>
          </Card>
        </Fade>
      ))}
      {/* Phase 3 — One-line acknowledgement when this session crossed the
          auto-completion threshold for an active deload. Sage, italic, small. */}
      {deloadCompleted && (
        <Fade d={240}>
          <div style={{marginTop:24,textAlign:"center",fontFamily:T.serif,fontSize:14,fontStyle:"italic",fontWeight:300,color:T.sage,letterSpacing:"0.01em"}}>
            Deload complete. Welcome back.
          </div>
        </Fade>
      )}
      {/* "Back at it" — first strength session after >7 days away. The
          consistency-over-time philosophy, said at the moment it counts:
          coming back IS the win, no apology owed. Suppressed when the gap
          was a completed deload (that line already says welcome back). */}
      {!deloadCompleted && returnGapDays != null && (
        <Fade d={240}>
          <div style={{marginTop:24,textAlign:"center",fontFamily:T.serif,fontSize:14,fontStyle:"italic",fontWeight:300,color:T.sage,letterSpacing:"0.01em"}}>
            Back at it — first one in {returnGapDays} days. Coming back is what counts.
          </div>
        </Fade>
      )}
      <Fade d={260}>
        <button onClick={onHome} style={{marginTop:20,width:"100%",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0,boxShadow:`0 12px 40px ${T.strength.glow}`}}>
          Back to home →
        </button>
      </Fade>

      {/* Sync confirmation line */}
      <Fade d={320}>
        <div style={{marginTop:24,textAlign:"center",fontSize:12,color:syncState.state==="idle"?T.sage:T.gold,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          {syncState.state === "idle" || syncState.state === "pushing" ? (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.sage}}/>
              Synced
            </>
          ) : syncState.state === "pulling" ? (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.steel,animation:"pulse 1s ease-in-out infinite"}}/>
              Syncing...
            </>
          ) : (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.gold}}/>
              Saved locally — will sync when online
            </>
          )}
        </div>
      </Fade>
    </div>
  );
}

// ─── iOS Install Overlay ─────────────────────────────────────────────────────
// Safari on iOS doesn't surface beforeinstallprompt, so we walk the user
// through the native "Add to Home Screen" flow ourselves. Triggered after
// first completed session, dismissable, remembered via localStorage.
function IosInstallOverlay({ onDismiss }) {
  const { containerRef, onKeyDown } = useModalA11y(onDismiss);
  const titleId = "ios-install-title";
  return (
    <div
      onClick={onDismiss}
      onKeyDown={onKeyDown}
      style={{
        position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",zIndex:500,
        backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",
        overscrollBehavior:"contain",
        display:"flex",alignItems:"flex-end",justifyContent:"center",
        animation:`fadeIn 220ms ${T.ease}`,
      }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e => e.stopPropagation()}
        style={{
          background:T.bg2,
          borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,
          outline:"none",
          padding:"24px 24px calc(24px + env(safe-area-inset-bottom))",
          width:"100%",maxWidth:430,
          maxHeight:"92vh",overflowY:"auto",
          borderTop:`1px solid ${T.coral}33`,
          animation:`slideUp 280ms ${T.ease}`,
          position:"relative",
          boxSizing:"border-box",
        }}>
        <button onClick={onDismiss} aria-label="Dismiss"
          style={{position:"absolute",top:14,right:14,background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,width:30,height:30,cursor:"pointer",color:T.text2,fontSize:13,padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingRight:40}}>
          Live on your home screen
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.2,marginBottom:10}}>
          Install <span style={{fontStyle:"italic",color:T.coral}}>Forge</span>
        </div>
        <p style={{fontSize:13,color:T.text2,marginBottom:20,lineHeight:1.6}}>
          Fullscreen. One tap to open. Works offline between sessions.
        </p>

        {/* Three steps — Safari's share flow */}
        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
          <InstallStep n="1">
            <span style={{display:"inline-flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              Tap the share icon <ShareGlyph/>
            </span>
          </InstallStep>
          <InstallStep n="2">
            <span>Scroll and pick <span style={{color:T.text1,fontFamily:T.serif,fontStyle:"italic"}}>Add to Home Screen</span></span>
          </InstallStep>
          <InstallStep n="3">
            <span>Tap <span style={{color:T.text1,fontFamily:T.serif,fontStyle:"italic"}}>Add</span> — done</span>
          </InstallStep>
        </div>

        <button onClick={onDismiss}
          style={{width:"100%",padding:"14px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text2}}>
          Maybe later
        </button>
      </div>
    </div>
  );
}

// SVG glyph approximating the iOS Safari share icon — a square with an
// up-arrow emerging from the top. Inline with the text, coral stroke.
function ShareGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="18" height="22" viewBox="0 0 18 22"
      style={{display:"inline-block",verticalAlign:"-5px",flexShrink:0}}
    >
      {/* Box — lower two thirds */}
      <rect x="2" y="8" width="14" height="12" rx="2" ry="2"
        fill="none" stroke={T.coral} strokeWidth="1.5"/>
      {/* Arrow shaft */}
      <line x1="9" y1="2" x2="9" y2="13"
        stroke={T.coral} strokeWidth="1.5" strokeLinecap="round"/>
      {/* Arrow head */}
      <polyline points="5,6 9,2 13,6"
        fill="none" stroke={T.coral} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function InstallStep({ n, children }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:14}}>
      <div style={{
        flexShrink:0,width:28,height:28,borderRadius:"50%",
        background:`${T.coral}18`,border:`1px solid ${T.coral}44`,
        display:"flex",alignItems:"center",justifyContent:"center",
        fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.coral,
      }}>{n}</div>
      <div style={{flex:1,fontSize:14,color:T.text2,lineHeight:1.5}}>
        {children}
      </div>
    </div>
  );
}

