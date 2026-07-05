"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  WEEK, SESSIONS, deriveStrengthDaySessions,
  rotateAccessories, rotationDiff, pushHistoryBlock, computeRotationStimulusDelta,
  dedupeRotationConfig,
  ROTATION_AUTO, DEFAULT_FOCUS, // Retrospective logging helpers (compute past-date programme metadata + missing-day detection)
  sessionMetaForDate, findUntickedRecent, } from "@/lib/programme";
import {
  SessionIntent,
  LS, P, PB, W, F, H, BW, PN, Days, bumpStreak,
  computeRhythm, detectRecoveryPattern,
  blobPush, flushPendingPushes, getLocalProfile, backgroundSync, SyncStatus,
  enableAutoSync, disableAutoSync, pushNow, weeksSince, dateOfWeekdayIdxInCurrentWeek,
  newDraftLog, logSet, finaliseDraft, D, TS,
  startingWeightForLift,
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
} from "@/lib/progression";
import { getLiftProfile, sanitiseWorkingWeights, getLoadType, weightStepForLoadType } from "@/lib/lift-translations";
import {
  isPlatformAuthenticatorAvailable,
  registerPasskey, hasPasskey,
} from "@/lib/webauthn";
import { track } from "@vercel/analytics";
import {
  computeVolumeAggregates, totalTonnage, pendingTonnageMilestone, } from "@/lib/analytics";
import { useModalA11y, haptic } from "@/lib/a11y";
import { withNavTransition } from "@/lib/nav-transitions";
import ErrorBoundary from "@/components/ErrorBoundary";
import { Fade } from "@/components/ui";
import ScrollDrum from "@/components/ScrollDrum";
import BodyweightEditModal from "@/components/BodyweightEditModal";
import ProfileScreen from "@/components/ProfileScreen";
import FocusPickerSheet from "@/components/FocusPickerSheet";
import HomeScreen from "@/components/HomeScreen";
import { activateProfileCore, saveFocusCore, takePendingRotationSummary } from "@/lib/profile-actions";


// getLoadType / weightStepForLoadType / parseTimedReps / WEIGHT_CAPTIONS now
// live in lib/lift-translations.js (PR3 3e-prep — shared by ForgeApp's
// finalise logger, the retro sheet, and components/SessionScreen.jsx).

// ScrollDrum now lives in components/ScrollDrum.jsx (PR3 3c).

// SyncStatusCard + SyncNowRow now live in components/sync-cards.jsx (PR3 3c).

// ─── Root ──────────────────────────────────────────────────────────────────────
export default function ForgeApp(){
  // The old `if (!mounted) return null` SSR guard is retired (instant home
  // hydration): returning null on first client render collapsed the page to
  // zero height at the exact moment the browser applies scroll restoration
  // on back-navigation, losing the user's position (measured 300 → 0).
  // State initializers read LS lazily (same storage-as-store pattern as
  // SessionHost/ProfileView), so the first client render IS the full home.
  // The server renders the empty-LS branches; React 19 recovers the
  // client/server divergence — the same trade the /profile and /session
  // hosts have shipped with, console-clean in Chromium.

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
    // Splash ONLY when LS is genuinely empty for a signed-in profile (the
    // cross-context case the splash exists for: PWA and Safari are separate
    // sandboxes, so a returning user on a new surface needs the blob pull
    // before home has anything truthful to show). When LS already has
    // history, home renders instantly at full height from local data and
    // the sync refreshes silently — this is what keeps back-navigation
    // scroll restoration working (instant home hydration).
    const p = P.getActive();
    return p !== null && H.get(p).length === 0;
  });
  const [streak,setStreak]=useState(0); // retained for compat — now derived from history, see useMemo below
  const [screen,setScreenRaw]=useState(()=>{
    if (typeof window === "undefined") return "home";
    return LS.get("forge:onboarded", false) ? "home" : "onboarding";
  });
  // Screen swap as a typed React transition (PR3 3f). The <ViewTransition>
  // boundary in app/layout.jsx animates any transition that updates its
  // subtree — this in-shell swap and route navigations flow through the
  // SAME boundary and CSS, so the motion vocabulary can't fork. The old
  // hand-rolled document.startViewTransition + flushSync wrapper is retired:
  // flushSync forced sync commits (bypassing concurrent rendering), and the
  // browser API call is now React's job.
  //
  // Direction: forward (slide up) for any destination, "nav-back" (old
  // slides down) when returning to home — every in-shell screen exits to
  // home, so "next === home" cleanly captures the back direction without a
  // history stack. On runtimes without View Transitions (jsdom, older
  // Safari) the transition commits without animating; reduced-motion users
  // get the instant swap via the CSS layer.
  const setScreen = useCallback((next) => {
    withNavTransition(() => setScreenRaw(next), next === "home" ? "nav-back" : null);
  }, []);
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
  // Session overview — lets users jump between blocks when gym constraints
  // dictate a different order than the prescribed flow. Auto-advance still
  // happens; this is the escape hatch.
  const [workingWeights,setWWState]=useState({});
  const [workingReps,setWRState]=useState({});
  // Append-only session log built during an active session
  // Snapshot of workingWeights at SESSION START. State (not ref) because the
  // DoneScreen consumes it during render. Set in handleReadinessStart /
  // handleResumeDraft. Without this, the Done summary compared the user's
  // current (post-progression) weight against the static SESSIONS template
  // default — so a user training at 100kg Bench for weeks saw "50 → 100kg"
  // every session ("base" = template default 50kg). Now base = what the
  // user lifted at the start of this session; if the engine bumped weight
  // after the session, the diff is real.
  // Snapshot of the in-progress draft log, captured when the overview sheet
  // opens. State (not ref) for the same render-time-readability reason — the
  // sheet displays "sets done per block" at open time; subsequent set-logs
  // while the sheet is open don't need to live-update (user is mid-jump).
  // Shown when auto-rotation fires — acknowledge before starting session
  const [rotationSummary,setRotationSummary]=useState(null);
  // Preview-before-commit for user-initiated rotation. Holds the candidate
  // computed by computeRotationPreview(); null = sheet closed. Re-rolling
  // replaces the candidate; confirm commits it; cancel drops it (engine
  // state stays untouched because computeRotationPreview never mutates).
  const [rotationPreview,setRotationPreview]=useState(null);
  // Full session history — lazy-hydrated from localStorage (instant home),
  // merged/refreshed from blob by the sync effect.
  const [history,setHistory]=useState(()=>{
    if (typeof window === "undefined") return [];
    const p = P.getActive();
    return p ? H.get(p) : [];
  });
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

  // Phase 3 — Deload state. Driven by training-state mesocycle subtree.
  //   activeDeload: when set, every prescribed weight is deloaded + carries the day-N tag.
  //   deloadOffer: signal object when an offer should surface on home; null when not.
  //   showDeloadComplete: one-shot flag for "Deload complete. Welcome back." on Done screen.
  const [activeDeload,setActiveDeload]=useState(null); // { startedAt, plannedDays, ... } | null
  const [deloadOffer,setDeloadOffer]=useState(null);   // signal object | null
  // One-shot for the Done screen's "Back at it" praise: days since the
  // PREVIOUS strength session, computed in the done effect BEFORE the new
  // record is appended (afterwards the newest record is today's and the gap
  // is always 0). null = no praise (regular cadence or first-ever session).

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

  // Session derivation chain + set-logging + finalise pipeline moved to
  // components/SessionHost.jsx (PR3 3e-route).

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
    // Auto-rotate if we're past the threshold: show the summary card first;
    // its continue button performs the /session handoff.
    const weeks = weeksSince(programmeBlock.startDate);
    if (weeks >= ROTATION_AUTO) {
      rotate(true);
      return;
    }
    startSessionRoute();
  };

  // One-shot intent handoff to the /session route (PR3 3e-route). The route
  // hydrates everything else from LS — see components/SessionHost.jsx.
  const startSessionRoute = () => {
    SessionIntent.stash(activeProfile, { sessionIdx: todaySessionIdx });
    router.push("/session");
  };

  // After rotation summary acknowledged, hand off to the session route
  const handleRotationContinue = () => {
    setRotationSummary(null);
    startSessionRoute();
  };

  // Resume a draft from a previous, interrupted session.
  // Jumps straight into session screen at the furthest block the user reached.
  // Resume a draft from a previous, interrupted session — the /session route
  // reconstructs position from the persisted draft itself.
  const handleResumeDraft = () => {
    if (!pendingDraft) return;
    SessionIntent.stash(activeProfile, { resume: true });
    router.push("/session");
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
  // after the state initializers have hydrated from LS earlier in this
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
        // top: 100 (was -160): the substrate-edge rule. The shell clips at
        // its top edge (overflow: clip), which in the PWA sits exactly at
        // the safe-area line — a glow that is bright at the shell top gets
        // hard-cut against the flat status-bar strip (seen on device on
        // every non-home screen). Keeping the first ~100px at substrate
        // darkness lets strip and content read as one field; same geometry
        // the HomeScreen glows have used since the "black hole" fix.
        position: "absolute", top: 100, left: "50%", transform: "translateX(-50%)",
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

// ─── Session flow ──────────────────────────────────────────────────────────────
// ReadinessScreen / SessionScreen / DoneScreen + session satellites now live
// in components/SessionScreen.jsx (PR3 3e-prep).

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
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
      className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
    <div onKeyDown={onKeyDown} className="forge-scrim forge-scrim-deep" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
          <div onClick={() => setEditor(null)} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
      className="forge-scrim forge-scrim-plain" style={{
        zIndex:500,
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

