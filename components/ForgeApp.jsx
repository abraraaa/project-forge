"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  WEEK, SESSIONS, deriveStrengthDaySessions,
  EXERCISE_POOLS, rotateAccessories, rotationDiff, pushHistoryBlock, computeRotationStimulusDelta,
  dedupeRotationConfig,
  ROTATION_OPTIONAL, ROTATION_AUTO, ROTATION_FORCED,
  DAY_CONFIG, DAY_NAMES, SWAP_DB, EQ_COLOUR,
  bonusForDay,
  FOCUS_OPTIONS, DEFAULT_FOCUS, FOCUS_SUMMARIES, applyFocusToSession, applyRotationToSession, applySwapsToSession,
  // Retrospective logging helpers (compute past-date programme metadata + missing-day detection)
  sessionMetaForDate, findRecentDays, hasMissedStrength, findUntickedRecent, weekdayIdxForDate,
} from "@/lib/programme";
import {
  LS, P, PB, W, F, H, BW, PN, bumpStreak,
  computeRhythm, detectRecoveryPattern,
  blobPush, flushPendingPushes, getLocalProfile, backgroundSync, SyncStatus,
  enableAutoSync, disableAutoSync,
  checkProfileExists, claimProfile, blobDelete,
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
  registerPasskey, authenticatePasskey, hasPasskey,
} from "@/lib/webauthn";
import { track } from "@vercel/analytics";
import {
  computeVolumeAggregates, recentForExercise,
  totalTonnage, pendingTonnageMilestone, formatTonnage,
} from "@/lib/analytics";
import { useModalA11y } from "@/lib/a11y";
import PerformanceLab from "@/components/PerformanceLab";
import ErrorBoundary from "@/components/ErrorBoundary";

// ─── Fade hook ─────────────────────────────────────────────────────────────────
function useFadeIn(d=0){
  const [v,setV]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>setV(true),d);return()=>clearTimeout(t);},[d]);
  return{opacity:v?1:0,transform:v?"translateY(0)":"translateY(10px)",
         transition:`opacity 260ms ${T.ease} ${d}ms,transform 260ms ${T.ease} ${d}ms`};
}

// Human-readable "X ago" — tuned for < 12h windows (draft expiry cutoff).
function formatAgo(ms) {
  if (!ms || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return "a while ago";
}

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

// ─── loadType → caption ──────────────────────────────────────────────────────
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

// ─── ScrollDrum ────────────────────────────────────────────────────────────────
// Native scroll-snap picker. Designed to feel like a weighted physical drum:
// items magnify + brighten as they approach the centre band, dim and shrink
// as they fall away. Cubic-bezier easing on every item transition adds the
// "settle" beat after a flick stops. Tap-to-jump still works for fine control.
function ScrollDrum({value,onChange,step=1.25,min=0,max=500,integer=false,label="",unit=null}){
  const ITEM_H=52,VISIBLE=5,half=Math.floor(VISIBLE/2);
  const values=useMemo(()=>{
    const arr=[];
    if(integer){for(let v=Math.max(min,1);v<=max;v++) arr.push(v);}
    else{const s=Math.round((max-min)/step);for(let i=0;i<=s;i++) arr.push(Math.round((min+i*step)*100)/100);}
    return arr;
  },[min,max,step,integer]);
  const current=parseFloat(value)||0;
  const selectedIdx=Math.max(0,values.findIndex(v=>Math.abs(v-current)<step*0.5));
  const ref=useRef(null);
  const scrolling=useRef(false);
  const timer=useRef(null);
  // Track the live scroll offset so the magnification can smoothly follow a
  // flick (not just snap targets). visibleIdx is a fractional index that
  // tracks the centre of the viewport during scroll; items compute their
  // distance from it for opacity/scale ramps.
  const [visibleIdx,setVisibleIdx]=useState(selectedIdx);
  useEffect(()=>{
    if(!ref.current||scrolling.current) return;
    const raf=requestAnimationFrame(()=>{ if(ref.current) ref.current.scrollTop=selectedIdx*ITEM_H; });
    setVisibleIdx(selectedIdx);
    return()=>cancelAnimationFrame(raf);
  },[selectedIdx]);
  const onScroll=useCallback(()=>{
    if(!ref.current) return;
    scrolling.current=true;
    const frac=ref.current.scrollTop/ITEM_H;
    setVisibleIdx(frac);
    const idx=Math.min(Math.round(frac),values.length-1);
    const next=values[Math.max(0,idx)];
    if(next!==undefined&&Math.abs(next-current)>(integer?0.1:0.01)) onChange(next);
    clearTimeout(timer.current);
    timer.current=setTimeout(()=>{scrolling.current=false;},150);
  },[values,current,onChange,integer]);
  const fmt=(v)=>{
    if(integer) return String(Math.round(v));
    const n=Math.round(v*100)/100;
    return Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,"").replace(/\.$/,"");
  };
  // Inertia easing — cubic-bezier matches T.ease but with a softer overshoot
  // so the magnify-on-arrival reads as a "settle" rather than a hard snap.
  const drumEase = `cubic-bezier(0.18, 0.95, 0.30, 1.05)`;
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1}}>
      {label&&<div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>{label}</div>}
      <div style={{position:"relative",height:ITEM_H*VISIBLE,width:"100%",overflow:"hidden"}}>
        {/* Selected-row band — soft inner shadow + warm tint give the picker
            a "pressed window" depth. Coral lip at top/bottom keeps the focus
            ring while the inner-shadow + rounded corners read as recessed. */}
        <div style={{position:"absolute",top:"50%",left:0,right:0,height:ITEM_H,transform:"translateY(-50%)",background:`${T.coral}18`,borderTop:`1px solid ${T.coral}40`,borderBottom:`1px solid ${T.coral}40`,boxShadow:`inset 0 6px 14px -10px ${T.coral}66, inset 0 -6px 14px -10px ${T.coral}66`,pointerEvents:"none",zIndex:1,borderRadius:T.r.sm}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to bottom,${T.bg2} 24%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to top,${T.bg2} 24%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div ref={ref} onScroll={onScroll} style={{height:"100%",overflowY:"scroll",scrollSnapType:"y mandatory",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",paddingTop:ITEM_H*half,paddingBottom:ITEM_H*half,boxSizing:"content-box"}}>
          <style>{`*::-webkit-scrollbar{display:none}`}</style>
          {values.map((v,i)=>{
            // Continuous distance from the live viewport centre. While
            // settled, this equals integer distance from selectedIdx; mid-
            // scroll it ramps smoothly so the drum reads as a single piece
            // of material rolling past, not 5 discrete snap-stops.
            const dist=Math.abs(i-visibleIdx);
            const clamped=Math.min(dist,2.2);
            // Selected → 1.0 / 30px. ±1 row → ~0.86 / ~25px. ±2 row → ~0.7 / ~19px.
            const scale=Math.max(0.66,1-clamped*0.16);
            const fontSize=Math.round(30-clamped*5.5);
            const opacity=Math.max(0.28,1-clamped*0.36);
            const colour=dist<0.6?T.text1:dist<1.4?T.text2:T.text4;
            const weight=dist<0.6?400:300;
            const textShadow=dist<0.4?`0 1px 14px ${T.coral}26`:"none";
            return(
              <div key={i} onClick={()=>onChange(v)} style={{height:ITEM_H,scrollSnapAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                <span style={{fontFamily:T.serif,fontSize,fontWeight:weight,color:colour,opacity,transform:`scale(${scale})`,textShadow,transition:`font-size 220ms ${drumEase}, color 200ms ${drumEase}, opacity 200ms ${drumEase}, transform 220ms ${drumEase}, text-shadow 240ms ${drumEase}`,userSelect:"none",willChange:"transform"}}>{fmt(v)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{fontFamily:T.serif,fontSize:12,fontWeight:300,color:T.text3,marginTop:8,fontStyle:"italic"}}>{unit ?? (integer?"reps":"kg")}</div>
    </div>
  );
}

// ─── Sync Status Card ──────────────────────────────────────────────────────────
function SyncStatusCard({ profile }) {
  const [status, setStatus] = useState(SyncStatus.get());
  const [retrying, setRetrying] = useState(false);
  // Snapshot of "now" for the relative-time label. Refreshed whenever sync
  // status changes (the only moment the label needs to move), so render stays
  // pure — no Date.now() read mid-render.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => SyncStatus.subscribe(s => { setStatus(s); setNow(Date.now()); }), []);

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    await backgroundSync(profile, {
      onUpdate: () => {}, // State is handled by the parent component
    });
    setRetrying(false);
  };

  const formatTime = (ts) => {
    if (!ts) return "never";
    const diff = now - ts;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  const stateLabel = {
    idle: "Synced",
    pulling: "Syncing...",
    pushing: "Saving...",
    error: "Offline",
  };

  const stateColour = {
    idle: T.sage,
    pulling: T.steel,
    pushing: T.steel,
    error: T.coral,
  };

  return (
    <div style={{
      marginTop: 16,
      padding: "14px 18px",
      background: T.bg2,
      border: `1px solid ${T.bg3}`,
      borderRadius: T.r.lg,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: stateColour[status.state],
          animation: status.state === "pulling" || status.state === "pushing" ? "pulse 1s ease-in-out infinite" : "none",
        }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: T.text1 }}>
            {stateLabel[status.state]}
          </div>
          {status.lastSync && status.state === "idle" && (
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
              Last sync: {formatTime(status.lastSync)}
            </div>
          )}
          {status.error && (
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
              Will retry when online
            </div>
          )}
        </div>
      </div>
      {status.state === "error" && (
        <button
          onClick={handleRetry}
          disabled={retrying}
          style={{
            padding: "8px 14px",
            background: T.bg3,
            border: `1px solid ${T.bg4}`,
            borderRadius: T.r.md,
            fontSize: 12,
            fontWeight: 500,
            color: T.text2,
            cursor: retrying ? "default" : "pointer",
            opacity: retrying ? 0.6 : 1,
          }}
        >
          {retrying ? "..." : "Retry"}
        </button>
      )}
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────────────
export default function ForgeApp(){
  const [mounted,setMounted]=useState(false);
  // Canonical SSR client-mount guard: fires once, no cascade. Intentional.
  useEffect(()=>setMounted(true),[]);

  const [activeProfile,setActiveProfileState]=useState(()=>typeof window!=="undefined"?P.getActive():null);
  const [showProfiles,setShowProfiles]=useState(false);

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
  const [screen,setScreen]=useState(()=>{
    if (typeof window === "undefined") return "home";
    return LS.get("forge:onboarded", false) ? "home" : "onboarding";
  });
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

  // Week-strip "done" from history. weekDone covers manual ticks for
  // non-strength days; this complement covers strength days where the user
  // has a logged session — including retro logs. Without it, the schedule
  // dots don't update when a missed session is logged via the retro picker.
  // Map<monday-start weekday idx, true> for the current week.
  const historyWeekDone = useMemo(() => {
    const map = {};
    if (!history || history.length === 0) return map;
    const today = new Date();
    today.setHours(0,0,0,0);
    const dow = today.getDay();
    const monShift = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(today);
    monday.setDate(monday.getDate() + monShift);
    const isoDate = (d) => {
      const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
      return `${y}-${m}-${day}`;
    };
    const datesByIdx = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(d.getDate() + i);
      datesByIdx[isoDate(d)] = i;
    }
    for (const rec of history) {
      if (!rec?.date) continue;
      if (!rec.session || !String(rec.session).startsWith("strength")) continue;
      const idx = datesByIdx[rec.date];
      if (idx !== undefined) map[idx] = true;
    }
    return map;
  }, [history]);

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
  };
  const handleResetWeek = () => {
    W.reset();
    setUserWeek(WEEK);
    setWeekEditorOpen(false);
  };

  // Seed on profile change: instant load from localStorage, background sync from blob
  useEffect(()=>{
    if(!activeProfile) return;
    
    // INSTANT: Load from localStorage (0ms, works offline)
    const local = getLocalProfile(activeProfile);
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
    // dayDone tracks non-strength manual ticks (cardio/Z2/HIIT Mark ✓).
    // Strength completion is history-backed — not mirrored here, because
    // doing so would let a schedule edit (cardio → strength on a date that
    // had a cardio tick) silently transmute into "strength completed."
    // Two stores, two events; never conflated.
    setDayDone(P.getDayDone(activeProfile));
    setWeekDone(P.getWeekDone(activeProfile));
    setBonusDone(P.getBonusDone(activeProfile));
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

    // Enable auto-sync on visibility change and online events
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
      try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(200); } catch {}
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
  }, [activeProfile]);

  // Reusable sync update handler — called when backgroundSync finds newer blob data.
  // Silently updates React state so the UI reflects the freshest data.
  const handleSyncUpdate = useCallback(({ meta, history: remoteHistory }) => {
    if (meta?.weights) setWWState(meta.weights);
    if (meta?.reps) setWRState(meta.reps);
    if (meta?.streak?.count) setStreak(meta.streak.count);
    if (meta?.programmeBlock) setProgrammeBlock(meta.programmeBlock);
    if (remoteHistory?.length) setHistory(remoteHistory);
  }, []);

  // Open Performance Lab — triggers background sync first to hydrate from blob
  // if localStorage is stale (e.g. switching from PWA to Safari on same device).
  // Navigation happens immediately; sync runs in background and updates state
  // silently if newer data is found.
  const handleOpenPerformance = useCallback(() => {
    setScreen("performance");
    if (activeProfile) {
      backgroundSync(activeProfile, { onUpdate: handleSyncUpdate });
    }
  }, [activeProfile, handleSyncUpdate]);

  const activateProfile = async (name, { claim = false } = {}) => {
    const trimmed = String(name).trim();
    if (!trimmed) return { ok: false, reason: "empty" };

    // Claim path: first-time signup for a new name.
    // The claim endpoint is atomic — if someone else grabbed the name
    // between the availability check and now, we'll get 409 here.
    if (claim) {
      const result = await claimProfile(trimmed, trimmed);
      if (result.taken) return { ok: false, reason: "taken" };
      if (!result.ok)   return { ok: false, reason: "network" };
    }

    P.add(trimmed);
    P.setActive(trimmed);
    setActiveProfileState(trimmed);
    setShowProfiles(false);
    return { ok: true };
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
  },[block,blockIdx,isSS,setNum,activeSession,resolveExFn,pushSetToDraft]);

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
  },[block,blockIdx,isSS,phase,setNum,activeSession,resolveExFn,pushSetToDraft]);

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

      // Finalise the session draft and append to history
      let sessionRecord = null;
      if (draftLogRef.current) {
        sessionRecord = finaliseDraft(draftLogRef.current);
        H.append(activeProfile, sessionRecord);
        // Reflect in React state so Performance Lab updates immediately.
        // NOTE: we deliberately do NOT write to dayDone here — strength
        // completion is history-backed. Conflating the two stores would
        // mean a cardio→strength schedule edit promotes the cardio tick
        // into a "strength completed" mark, which corrupts the user's
        // training record. dayDone is for non-strength manual ticks only.
        setHistory(H.get(activeProfile));
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
      // merges with whatever it has.
      blobPush(activeProfile, {
        meta: {
          weights: workingWeights,
          reps: workingReps,
          streak: P.getStreak(activeProfile),
          programmeBlock,
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
    const updatedDayDone = P.markDateDone(activeProfile, dateStr);
    setDayDone(updatedDayDone);
    setWeekDone(P.getWeekDone(activeProfile));
    if (dateStr === todayDate) {
      const newStreak = bumpStreak(activeProfile);
      setStreak(newStreak);
    }
  },[activeProfile]);

  // Mark today's optional cardio bonus complete. Separate store from weekDone;
  // deliberately does NOT bump the streak — bonuses are extras, not adherence.
  const handleMarkBonusDone = useCallback(()=>{
    if(!activeProfile) return;
    const dw=new Date().getDay();
    const wm=[6,0,1,2,3,4,5];
    const idx=wm[dw];
    setBonusDone(P.markBonusDone(activeProfile,idx));
  },[activeProfile]);

  // Save the user's training focus + re-rotate accessories IMMEDIATELY with the
  // new bias. Keeps block number and startDate (the change is a re-pick, not
  // a new training block); workingWeights carry forward via existing storage,
  // so progressive overload context isn't lost. Closes the picker on save.
  const handleSaveFocus = (focus) => {
    if (!activeProfile) return;
    F.save(activeProfile, focus);
    setUserFocus(focus);
    // Re-rotate within the same block, keep history as-is so future blocks
    // still benefit from the 3-block exclusion memory.
    const oldConfig = programmeBlock.config;
    const newConfig = rotateAccessories(programmeBlock.history, { focus });
    const next = { ...programmeBlock, config: newConfig };
    setProgrammeBlock(next);
    PB.save(next);
    // Surface what changed so the user can see the bias kicked in.
    const changes = rotationDiff(oldConfig, newConfig);
    const stimulusDelta = computeRotationStimulusDelta(oldConfig, newConfig);
    setRotationSummary({ blockNumber: programmeBlock.number, changes, stimulusDelta });
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

  if(!activeProfile||showProfiles){
  return (
    <>
      <ProfileScreen existing={P.list()} current={activeProfile} onActivate={activateProfile} onCancel={showProfiles?()=>setShowProfiles(false):null} bodyweight={bodyweight} bwEditOpen={bwEditOpen} setBwEditOpen={setBwEditOpen} updateBodyweight={updateBodyweight} userFocus={userFocus} onEditFocus={()=>setFocusPickerOpen(true)}/>
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
      setHistory(H.get(activeProfile));
      // No dayDone write here — strength completion is history-backed.
      // See the live finalise path for the rationale (mixing the two
      // stores would mean a schedule edit could promote a cardio tick
      // into a phantom strength completion).

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

      // Push to blob in background
      blobPush(activeProfile, {
        meta: { weights: workingWeights, reps: workingReps },
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
      <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px",position:"relative",overflow:"hidden"}}>
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
    <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased"}}>
      {screen==="home"        && <HomeScreen rhythm={rhythm} profileName={activeProfile} userWeek={userWeek} strengthDaySessions={strengthDaySessions} onEditWeek={()=>setWeekEditorOpen(true)} onBegin={beginSession} onProfile={()=>setShowProfiles(true)} weekDone={weekDone} onMarkDayDone={handleMarkDayDone} bonusDone={bonusDone} onMarkBonusDone={handleMarkBonusDone} programmeBlock={programmeBlock} weeksOnBlock={weeksOnBlock} onRotate={handleRotate} onResetProgramme={handleResetProgramme} userFocus={userFocus} onEditFocus={()=>setFocusPickerOpen(true)} onPerformance={handleOpenPerformance} historyCount={history.length} recoveryNudge={recoveryNudge} onDismissRecovery={()=>setRecoveryDismissed(true)} syncState={syncState} pendingDraft={pendingDraft} onResumeDraft={handleResumeDraft} onDiscardDraft={handleDiscardDraft} showBwCard={bwIsStale && !bwCardDismissed} onOpenBwEdit={()=>setBwEditOpen(true)} onDismissBwCard={()=>setBwCardDismissed(true)} deloadOffer={deloadOffer} onAcceptDeload={handleAcceptDeload} onDismissDeload={handleDismissDeload} untickedDays={untickedDays} onOpenRetroPicker={handleOpenRetroPicker} retroToast={retroToast} onDismissRetroToast={()=>setRetroToast(null)} pnStage={pnStage} pnBusy={pnBusy} pnError={pnError} pnSuccessToast={pnSuccessToast} onPnRegister={handleRegisterPasskeyFromHome} onPnSnooze={handleSnoozeNudge} onPnDismissToast={()=>setPnSuccessToast(false)} tonnageMilestone={pendingMilestone} tonnageTotalKg={totalKg} onDismissTonnageMilestone={handleDismissTonnageMilestone} historyWeekDone={historyWeekDone}/>}
      {screen==="readiness"   && <ReadinessScreen readiness={readiness} setReadiness={setReadiness} reason={readinessReason} setReason={setReadinessReason} onStart={handleReadinessStart}/>}
      {screen==="session"     && <ErrorBoundary><SessionScreen {...sProps}/></ErrorBoundary>}
      {screen==="done"        && <ErrorBoundary><DoneScreen session={activeSession} profileName={activeProfile} workingWeights={workingWeights} sessionStartWeights={sessionStartWeights} userWeek={userWeek} onHome={()=>{ setShowDeloadComplete(false); reset(); }} deloadCompleted={showDeloadComplete}/></ErrorBoundary>}
      {screen==="performance" && <ErrorBoundary><PerformanceLab history={history} onBack={()=>setScreen("home")}/></ErrorBoundary>}
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

// ─── Taken Name Modal ──────────────────────────────────────────────────────────
// Shows when user tries to claim a name that exists — offers passkey sign-in if available
function TakenNameModal({ name, webAuthnSupported, onClose, onActivate, passkeyBusy, setPasskeyBusy, passkeyError, setPasskeyError }) {
  const [hasProfilePasskey, setHasProfilePasskey] = useState(null); // null = checking
  const [authSuccess, setAuthSuccess] = useState(false);

  // Check if this profile has a passkey
  useEffect(() => {
    hasPasskey(name).then(setHasProfilePasskey);
  }, [name]);

  const handlePasskeySignIn = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await authenticatePasskey(name);
      if (result?.verified) {
        setAuthSuccess(true);
        // Add profile locally and activate, then call onActivate to update React state
        P.add(name);
        P.setActive(name);
        // Give user a moment to see success state, then activate properly
        setTimeout(() => {
          onActivate(name, { claim: false });
        }, 800);
      } else {
        setPasskeyError("Authentication cancelled");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey authentication failed");
    }
    setPasskeyBusy(false);
  };

  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "taken-name-title";

  if (authSuccess) {
    return (
      <div style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{background:T.bg2,borderRadius:T.r.xl,padding:"40px 32px",textAlign:"center"}}>
          <div style={{fontSize:48,marginBottom:16}}>✓</div>
          <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,color:T.text1}}>
            Welcome back, {name}
          </div>
          <p style={{fontSize:13,color:T.text3,marginTop:8}}>Loading your data...</p>
        </div>
      </div>
    );
  }

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.coral}33`,animation:`slideUp 260ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box",position:"relative",outline:"none"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:14,right:14,background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,width:30,height:30,cursor:"pointer",color:T.text2,fontSize:13,padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingRight:40}}>
          Is this you?
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.2,marginBottom:12}}>
          {hasProfilePasskey === null ? "Checking..." : hasProfilePasskey ? "Sign in with passkey" : "Signing in on a new device"}
        </div>

        {/* If profile has passkey and WebAuthn is supported, show sign-in option */}
        {webAuthnSupported && hasProfilePasskey && (
          <>
            <p style={{fontSize:13,color:T.text2,marginBottom:22,lineHeight:1.6}}>
              <span style={{color:T.text1}}>{name}</span> is secured with a passkey. Use Face ID, Touch ID, or your device PIN to sign in.
            </p>

            {passkeyError && (
              <div style={{marginBottom:16,padding:"10px 14px",borderRadius:T.r.md,background:`${T.rose}14`,fontSize:12,color:T.rose}}>
                {passkeyError}
              </div>
            )}

            <button
              onClick={handlePasskeySignIn}
              disabled={passkeyBusy}
              style={{
                width:"100%",
                padding:"16px",
                background:T.coral,
                border:"none",
                borderRadius:T.r.lg,
                fontSize:16,
                fontWeight:500,
                color:T.bg0,
                cursor:passkeyBusy?"default":"pointer",
                opacity:passkeyBusy?0.6:1,
                marginBottom:16,
              }}
            >
              {passkeyBusy ? "Verifying..." : "Sign in with passkey"}
            </button>

            <p style={{fontSize:11,color:T.text4,textAlign:"center",lineHeight:1.5}}>
              Lost access to your passkey? Contact support to recover your account.
            </p>
          </>
        )}

        {/* Fallback: no passkey or WebAuthn not supported */}
        {(!webAuthnSupported || hasProfilePasskey === false) && hasProfilePasskey !== null && (
          <>
            <p style={{fontSize:13,color:T.text2,marginBottom:22,lineHeight:1.6}}>
              <span style={{color:T.text1}}>{name}</span> is claimed but doesn&apos;t have a passkey set up. You&apos;ll need to wipe it from the original device to reclaim it here.
            </p>

            <div style={{padding:"14px 16px",borderRadius:T.r.md,background:`${T.gold}0E`,border:`1px solid ${T.gold}33`,marginBottom:22}}>
              <div style={{fontSize:10,fontWeight:500,color:T.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                What to do
              </div>
              <p style={{fontSize:13,color:T.text1,lineHeight:1.55}}>
                On your old device: tap your name → <span style={{fontStyle:"italic",fontFamily:T.serif}}>Full wipe</span>. That releases the name so you can claim it here.
              </p>
            </div>

            <button onClick={onClose} style={{width:"100%",padding:"14px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text2}}>
              Got it
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Onboarding Screen ────────────────────────────────────────────────────────
// First-time intro. Sets forge:onboarded on continue so returning visitors
// skip straight to ProfileScreen or home. BW is collected after name entry.
function OnboardingScreen({ onContinue }) {
  const { strength: s } = T;

  return (
    <div style={{
      background: T.bg0, minHeight: "100vh", maxWidth: 430, margin: "0 auto",
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
function ProfileScreen({existing,current,onActivate,onCancel,bodyweight=null,bwEditOpen=false,setBwEditOpen,updateBodyweight,userFocus="Forged",onEditFocus}){
  const [name,setName]=useState("");
  const [confirmWipe,setConfirmWipe]=useState(null);
  const [showTakenHelp,setShowTakenHelp]=useState(false);
  // availability: "idle" | "checking" | "available" | "taken" | "network-err"
  const [availability,setAvailability]=useState("idle");
  const [submitting,setSubmitting]=useState(false);
  const [submitError,setSubmitError]=useState(null);
  const checkTimerRef = useRef(null);
  const latestQueryRef = useRef("");
  const {strength:s}=T;

  // Post-claim BW step (only for new users with no existing profiles)
  const [showBwStep, setShowBwStep] = useState(false);
  const [pendingBw, setPendingBw] = useState(75);
  const [claimedName, setClaimedName] = useState(null);

  // Onboarding passkey step — sits between name claim and BW step.
  // Only renders if WebAuthn is supported (capability gate). Skipping or
  // failing the ceremony falls through to the BW step — onboarding never
  // breaks. The flag is one-shot; once dismissed (accept or skip), we move on.
  const [showPasskeyStep, setShowPasskeyStep] = useState(false);
  const [onboardingPasskeyBusy, setOnboardingPasskeyBusy] = useState(false);
  const [onboardingPasskeyError, setOnboardingPasskeyError] = useState(null);

  // Passkey state
  const [webAuthnSupported, setWebAuthnSupported] = useState(false);
  const [showPasskeySetup, setShowPasskeySetup] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState(null);
  const [profileHasPasskey, setProfileHasPasskey] = useState({});
  const [authToken, setAuthToken] = useState(null); // For authenticated destructive ops
  const [needsPasskeyAuth, setNeedsPasskeyAuth] = useState(null); // Profile name requiring auth

  // Check WebAuthn support on mount
  useEffect(() => {
    isPlatformAuthenticatorAvailable().then(setWebAuthnSupported);
  }, []);

  // Check if each profile has a passkey (only on mount, not when state changes)
  // Using a ref to track which profiles we've already checked
  const checkedProfilesRef = useRef(new Set());
  useEffect(() => {
    // Check all existing profiles we haven't checked yet
    existing.forEach(async (profile) => {
      if (checkedProfilesRef.current.has(profile)) return;
      checkedProfilesRef.current.add(profile);
      const has = await hasPasskey(profile);
      // Only update if not already true (preserves local registration state)
      setProfileHasPasskey(prev => prev[profile] === true ? prev : { ...prev, [profile]: has });
    });
    // Also explicitly check current profile if not checked
    if (current && !checkedProfilesRef.current.has(current)) {
      checkedProfilesRef.current.add(current);
      hasPasskey(current).then(has => {
        setProfileHasPasskey(prev => prev[current] === true ? prev : { ...prev, [current]: has });
      });
    }
  }, [existing, current]);

  // Expanded wipe: opts.cloud === true also nukes cloud data via DELETE /api/sync.
  // opts.cloud === false only clears local storage (fast, offline-safe).
  const [wipeBusy,setWipeBusy]=useState(false);
  const [wipeError,setWipeError]=useState(null);
  const wipeProfile=async (n,{cloud=false}={})=>{
    setWipeError(null);
    setWipeBusy(true);
    if (cloud) {
      const result = await blobDelete(n, { authToken });
      if (!result.ok) {
        setWipeBusy(false);
        if (result.requiresAuth) {
          setConfirmWipe(null);
          setNeedsPasskeyAuth(n);
          return;
        }
        setWipeError(result.error || "Couldn't reach the cloud. Try again?");
        return;
      }
    }
    // Local cleanup always runs regardless of cloud branch
    ["weights","reps","streak","history","pendingPushes"].forEach(k=>localStorage.removeItem(`forge:${n}:${k}`));
    const updated=P.list().filter(p=>p!==n);
    LS.set("forge:profiles",updated);
    if(P.getActive()===n){ LS.set("forge:active",null); }
    setWipeBusy(false);
    setConfirmWipe(null);
    setAuthToken(null);
    window.location.reload();
  };

  // Handle passkey authentication for destructive ops
  const handlePasskeyAuth = async () => {
    if (!needsPasskeyAuth) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await authenticatePasskey(needsPasskeyAuth);
      if (result?.verified && result?.authToken) {
        setAuthToken(result.authToken);
        setNeedsPasskeyAuth(null);
        // Now retry the wipe with the token
        setConfirmWipe(needsPasskeyAuth);
      } else {
        setPasskeyError("Authentication cancelled or failed");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey authentication failed");
    }
    setPasskeyBusy(false);
  };

  // Register a passkey for the current profile
  const handleRegisterPasskey = async () => {
    if (!current) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await registerPasskey(current);
      if (result?.ok) {
        // Update local state immediately - don't wait for async check
        setProfileHasPasskey(prev => ({ ...prev, [current]: true }));
        setShowPasskeySetup(false);
        setPasskeyError(null);
      } else if (result === null) {
        // User cancelled - not an error, just close
        setPasskeyError(null);
      } else {
        setPasskeyError("Setup cancelled");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey setup failed");
    }
    setPasskeyBusy(false);
  };

  // Debounced availability check as user types
  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) {
      // Reset status while the debounced network check is pending — driving UI
      // state off an async external (name-availability) check. Intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAvailability("idle");
      clearTimeout(checkTimerRef.current);
      return;
    }
    // If it's an existing local profile, it's "ours" — treat as available
    if (existing.some(e => e.toLowerCase() === trimmed.toLowerCase())) {
      setAvailability("available");
      return;
    }
    setAvailability("checking");
    clearTimeout(checkTimerRef.current);
    latestQueryRef.current = trimmed;
    checkTimerRef.current = setTimeout(async () => {
      const res = await checkProfileExists(trimmed);
      // Guard against stale responses — user may have typed more since
      if (latestQueryRef.current !== trimmed) return;
      if (res === null) setAvailability("network-err");
      else if (res.exists) setAvailability("taken");
      else setAvailability("available");
    }, 400);
    return () => clearTimeout(checkTimerRef.current);
  }, [name, existing]);

  const canSubmit = name.trim().length >= 2 && (availability === "available" || availability === "network-err") && !submitting;

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    // If it's an existing local profile, just activate — don't try to claim again
    const isLocalProfile = existing.some(e => e.toLowerCase() === trimmed.toLowerCase());
    const result = await onActivate(trimmed, { claim: !isLocalProfile });
    setSubmitting(false);
    if (!result?.ok) {
      if (result?.reason === "taken") {
        setAvailability("taken");
        setSubmitError("Someone just claimed that name. Try another.");
      } else {
        setSubmitError("Network hiccup. Try again?");
      }
    } else {
      // Success! For first-time users (no existing profiles), enter onboarding
      // sequence: passkey step (if supported) → BW step → home.
      // We always set claimedName so subsequent steps know which profile to
      // attach data to. The capability gate keeps unsupported devices on the
      // direct claim → BW path.
      if (existing.length === 0 && !isLocalProfile) {
        setClaimedName(trimmed);
        if (webAuthnSupported) {
          setShowPasskeyStep(true);
        } else {
          setShowBwStep(true);
        }
      }
    }
  };

  // Visual state for availability pip
  const availabilityPip = () => {
    if (availability === "checking")     return { colour: T.text3, icon: "…",  label: "checking" };
    if (availability === "available")    return { colour: T.sage,  icon: "✓",  label: existing.some(e=>e.toLowerCase()===name.trim().toLowerCase()) ? "on this device" : "available" };
    if (availability === "taken")        return { colour: T.rose,  icon: "✕",  label: "taken" };
    if (availability === "network-err")  return { colour: T.gold,  icon: "?",  label: "offline — try anyway" };
    return null;
  };
  const pip = availabilityPip();

  // Post-claim passkey step (first-time onboarding only). Sits between name
  // claim and BW step. Three exit paths all fall through to BW:
  //   1. User accepts and ceremony succeeds — passkey registered, advance
  //   2. User accepts but ceremony fails/cancels — log error, advance silently
  //   3. User taps "Later" — advance, no error
  // The home-screen chip will surface tomorrow if (1) didn't happen.
  if (showPasskeyStep) {
    const advanceToBw = () => {
      setShowPasskeyStep(false);
      setShowBwStep(true);
    };

    const handlePasskeyAccept = async () => {
      if (!claimedName || onboardingPasskeyBusy) return;
      setOnboardingPasskeyBusy(true);
      setOnboardingPasskeyError(null);
      try {
        const result = await registerPasskey(claimedName);
        if (result?.ok) {
          // Mark this profile as having a passkey in the local cache so the
          // existing ProfileScreen card respects it on later visits.
          setProfileHasPasskey(prev => ({ ...prev, [claimedName]: true }));
          advanceToBw();
        } else {
          // Cancellation or non-ok result — surface a soft message and let
          // them retry or skip. Don't auto-advance, give them control.
          setOnboardingPasskeyError(result === null ? null : "Setup didn't complete. Try again or skip for now.");
        }
      } catch (e) {
        console.error("[forge:onboarding-passkey]", e);
        setOnboardingPasskeyError(e.message || "Couldn't set up. Try again or skip.");
      }
      setOnboardingPasskeyBusy(false);
    };

    const handlePasskeyLater = () => {
      advanceToBw();
    };

    return (
      <div style={{
        background: T.bg0, minHeight: "100vh", maxWidth: 430, margin: "0 auto",
        fontFamily: T.sans, color: T.text1, WebkitFontSmoothing: "antialiased",
        padding: "72px 24px 48px", position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        {/* Sage ambient — wellness/security territory */}
        <div style={{position:"absolute",top:-160,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${T.sage}26 0%,transparent 65%)`,pointerEvents:"none"}}/>

        <Fade d={0}>
          <div style={{
            fontSize: 11, fontWeight: 500, color: T.sage,
            letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 20,
          }}>
            Secure across devices
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 36, fontWeight: 300, lineHeight: 1.15, marginBottom: 16 }}>
            Add a <span style={{fontStyle:"italic",color:T.sage}}>passkey</span>?
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 12 }}>
            Without one, your data lives only on this device — clearing your browser would lose everything.
          </p>
          <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 32 }}>
            With one, your name is yours across phone, laptop, anywhere. Face ID, Touch ID, or your device PIN.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", flexDirection:"column", gap: 12, minHeight: 80 }}>
            {onboardingPasskeyError && (
              <div style={{padding:"10px 14px",borderRadius:T.r.sm,background:`${T.rose}14`,fontSize:12,color:T.rose,maxWidth:320,textAlign:"center",lineHeight:1.5}}>
                {onboardingPasskeyError}
              </div>
            )}
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={handlePasskeyAccept} disabled={onboardingPasskeyBusy} style={{
              width: "100%", padding: "18px 24px",
              background: T.sage, border: "none", borderRadius: T.r.lg,
              cursor: onboardingPasskeyBusy ? "default" : "pointer",
              fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.bg0,
              boxShadow: `0 12px 40px ${T.sage}33`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              opacity: onboardingPasskeyBusy ? 0.6 : 1,
            }}>
              <span>{onboardingPasskeyBusy ? "Setting up…" : "Add passkey"}</span>
              {!onboardingPasskeyBusy && <span style={{ fontSize: 18 }}>→</span>}
            </button>
            <button onClick={handlePasskeyLater} disabled={onboardingPasskeyBusy} style={{
              width: "100%", padding: "14px 24px",
              background: "transparent", border: "none", cursor: onboardingPasskeyBusy ? "default" : "pointer",
              fontFamily: T.sans, fontSize: 14, fontWeight: 400, color: T.text3,
            }}>
              Later
            </button>
          </div>
        </Fade>
      </div>
    );
  }

  // Post-claim BW step for first-time users
  if (showBwStep) {
    const handleBwSave = () => {
      if (claimedName && updateBodyweight) {
        updateBodyweight(pendingBw);
      }
      setShowBwStep(false);
    };
    const handleBwSkip = () => {
      setShowBwStep(false);
    };

    return (
      <div style={{
        background: T.bg0, minHeight: "100vh", maxWidth: 430, margin: "0 auto",
        fontFamily: T.sans, color: T.text1, WebkitFontSmoothing: "antialiased",
        padding: "72px 24px 48px", position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        {/* Sage-tinted ambient glow — wellness territory, not training */}
        <div style={{position:"absolute",top:-160,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${T.sage}26 0%,transparent 65%)`,pointerEvents:"none"}}/>

        <Fade d={0}>
          <div style={{
            fontSize: 11, fontWeight: 500, color: T.sage,
            letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 20,
          }}>
            Bodyweight
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 36, fontWeight: 300, lineHeight: 1.15, marginBottom: 16 }}>
            What do you weigh?
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 32 }}>
            Optional — but it lets us track bodyweight movements (pull-ups, dips, planks) properly.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 280 }}>
            <ScrollDrum
              value={pendingBw}
              onChange={setPendingBw}
              min={40}
              max={200}
              step={0.5}
              unit="kg"
            />
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={handleBwSave} style={{
              width: "100%", padding: "18px 24px",
              background: T.sage, border: "none", borderRadius: T.r.lg, cursor: "pointer",
              fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.bg0,
              boxShadow: `0 12px 40px ${T.sage}33`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span>Save & continue</span>
              <span style={{ fontSize: 18 }}>→</span>
            </button>
            <button onClick={handleBwSkip} style={{
              width: "100%", padding: "14px 24px",
              background: "transparent", border: "none", cursor: "pointer",
              fontFamily: T.sans, fontSize: 14, fontWeight: 400, color: T.text3,
            }}>
              Skip
            </button>
          </div>
        </Fade>
      </div>
    );
  }

  return (
    <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-160,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      {onCancel&&<button onClick={onCancel} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans,marginBottom:32,display:"block"}}>← Back</button>}
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:36,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
          {current?"Switch profile":"Who's training?"}
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:36,lineHeight:1.6}}>
          {current?"Pick a profile or add someone new.":"Pick a name. It travels with you across devices."}
        </p>
      </Fade>
      {existing.length>0&&(
        <Fade d={60}>
          <div style={{marginBottom:28}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>On this device</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {existing.map(n=>(
                <div key={n} style={{padding:"16px 20px",borderRadius:T.r.lg,background:n===current?`${T.coral}12`:T.bg2,border:`1px solid ${n===current?T.coral+"44":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
                  <span onClick={()=>onActivate(n)} style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1,cursor:"pointer",flex:1}}>{n}</span>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    {n===current&&<span style={{fontSize:11,color:T.coral,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Active</span>}
                    <button onClick={()=>setConfirmWipe(n)} style={{background:"none",border:"none",padding:"2px 6px",cursor:"pointer",fontSize:11,color:T.text4,fontFamily:T.sans}} title="Wipe progress">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Fade>
      )}
      <Fade d={120}>
        <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
          {existing.length > 0 ? "Add new" : "Pick your name"}
        </div>
        <div style={{position:"relative"}}>
          <div style={{display:"flex",gap:10}}>
            <div style={{flex:1,position:"relative"}}>
              <input value={name} onChange={e=>{setName(e.target.value); setSubmitError(null);}}
                onKeyDown={e=>{if(e.key==="Enter"&&canSubmit) handleSubmit();}}
                placeholder="Your name"
                autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck="false"
                style={{width:"100%",background:T.bg2,border:`1px solid ${availability==="taken"?T.rose+"55":availability==="available"?T.sage+"55":T.bg3}`,borderRadius:T.r.md,padding:"14px 48px 14px 16px",fontFamily:T.serif,fontSize:18,fontWeight:300,color:T.text1,outline:"none",caretColor:T.coral,transition:`border 180ms ${T.ease}`}}
              />
              {pip && (
                <div style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:6,pointerEvents:"none"}}>
                  <span style={{fontSize:14,color:pip.colour,fontWeight:500}}>{pip.icon}</span>
                </div>
              )}
            </div>
            <button onClick={handleSubmit} disabled={!canSubmit}
              style={{padding:"14px 20px",background:canSubmit?T.coral:T.bg3,border:"none",borderRadius:T.r.md,cursor:canSubmit?"pointer":"default",fontFamily:T.serif,fontSize:18,fontWeight:400,color:canSubmit?T.bg0:T.text4,transition:`all 200ms ${T.ease}`}}>
              {submitting ? "…" : "→"}
            </button>
          </div>
          {/* Subscript — availability status or helper text */}
          <div style={{marginTop:10,minHeight:16,fontSize:11,fontFamily:T.sans,color:pip?.colour || T.text3,display:"flex",alignItems:"center",gap:6,transition:`color 180ms ${T.ease}`}}>
            {submitError ? (
              <span style={{color:T.rose}}>{submitError}</span>
            ) : pip ? (
              <span>{pip.label === "available" && "Available · this will be your username"}
                    {pip.label === "on this device" && "Welcome back"}
                    {pip.label === "taken" && "Already taken on Forge"}
                    {pip.label === "checking" && "Checking…"}
                    {pip.label === "offline — try anyway" && "Couldn't check online — you can still proceed"}
              </span>
            ) : (
              <span style={{color:T.text4}}>2+ characters. Case doesn't matter.</span>
            )}
          </div>

          {/* Taken → escape hatch. Cross-device sign-in lives here once
              pairing ships. For now, surfaces an honest explainer. */}
          {availability === "taken" && (
            <button
              type="button"
              onClick={() => setShowTakenHelp(true)}
              style={{
                marginTop:12,background:"none",border:"none",padding:0,
                cursor:"pointer",fontFamily:T.sans,fontSize:12,
                color:T.coral,textAlign:"left",letterSpacing:"0.02em",
              }}>
              That's me →
            </button>
          )}
        </div>
      </Fade>

      {/* Tone-of-voice card — sets expectations on data + PII */}
      <Fade d={180}>
        <div style={{marginTop:36,padding:"18px 20px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg}}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
            No email. No phone.
          </div>
          <div style={{fontFamily:T.serif,fontSize:19,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:6}}>
            We don&apos;t want your <span style={{fontStyle:"italic",color:T.coral}}>starsign</span> either.
          </div>
          <p style={{fontSize:13,color:T.text3,lineHeight:1.6}}>
            Forge keeps your data yours. A name is all we need — it syncs your streak and weights across your devices. Nothing more.
          </p>
        </div>
      </Fade>

      {/* Sync status card — shows cloud connection state */}
      {current && (
        <Fade d={240}>
          <SyncStatusCard profile={current} />
        </Fade>
      )}

      {/* Bodyweight row — tappable to edit */}
      {current && setBwEditOpen && (
        <Fade d={260}>
          <div onClick={()=>setBwEditOpen(true)}
            style={{marginTop:16,padding:"14px 18px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Bodyweight</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>
                {bodyweight ? (
                  (() => {
                    const bwData = BW.get(current);
                    const daysAgo = bwData?.ageMs ? Math.floor(bwData.ageMs / 86400000) : null;
                    const agoStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : daysAgo !== null ? `${daysAgo} days ago` : "";
                    return `${bodyweight} kg${agoStr ? ` · updated ${agoStr}` : ""}`;
                  })()
                ) : "Not set — add one ↗"}
              </div>
            </div>
            <span style={{fontSize:14,color:T.text3}}>↗</span>
          </div>
        </Fade>
      )}

      {/* Training focus row — tappable to open the focus picker. Biases
          accessory rotation toward the chosen goal. Default = Forged (balanced). */}
      {current && onEditFocus && (
        <Fade d={270}>
          <div onClick={onEditFocus}
            style={{marginTop:12,padding:"14px 18px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Training focus</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>
                {userFocus} · {FOCUS_SUMMARIES[userFocus] || FOCUS_SUMMARIES.Forged}
              </div>
            </div>
            <span style={{fontSize:14,color:T.text3}}>↗</span>
          </div>
        </Fade>
      )}

      {/* Passkey setup card — only show if WebAuthn is supported and profile doesn't have one */}
      {current && webAuthnSupported && !profileHasPasskey[current] && (
        <Fade d={280}>
          <div style={{marginTop:16,padding:"18px 20px",background:T.bg2,border:`1px solid ${T.sage}33`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
                  Secure your profile
                </div>
                <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:6}}>
                  Add a passkey
                </div>
                <p style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Use Face ID, Touch ID, or your device PIN to protect your data and sign in on other devices.
                </p>
              </div>
              <button
                onClick={handleRegisterPasskey}
                disabled={passkeyBusy}
                style={{
                  padding:"10px 16px",
                  background:T.sage,
                  border:"none",
                  borderRadius:T.r.md,
                  fontSize:13,
                  fontWeight:500,
                  color:T.bg0,
                  cursor:passkeyBusy?"default":"pointer",
                  opacity:passkeyBusy?0.6:1,
                  whiteSpace:"nowrap",
                }}
              >
                {passkeyBusy ? "..." : "Set up"}
              </button>
            </div>
            {passkeyError && (
              <div style={{marginTop:12,padding:"8px 12px",borderRadius:T.r.sm,background:`${T.rose}14`,fontSize:11,color:T.rose}}>
                {passkeyError}
              </div>
            )}
          </div>
        </Fade>
      )}

      {/* Passkey enabled badge */}
      {current && profileHasPasskey[current] && (
        <Fade d={280}>
          <div style={{marginTop:16,padding:"14px 18px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:T.sage}}/>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Passkey enabled</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>Your profile is secured with biometric auth</div>
            </div>
          </div>
        </Fade>
      )}

      {/* Passkey auth required modal */}
      {needsPasskeyAuth && (
        <div onClick={()=>setNeedsPasskeyAuth(null)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:T.r.xl,padding:"32px 28px",width:"90%",maxWidth:340,textAlign:"center"}}>
            <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
              Authentication required
            </div>
            <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.25,marginBottom:12}}>
              Verify it&apos;s you
            </div>
            <p style={{fontSize:13,color:T.text2,marginBottom:24,lineHeight:1.55}}>
              This profile has a passkey. Use Face ID, Touch ID, or your device PIN to continue.
            </p>
            {passkeyError && (
              <div style={{marginBottom:16,padding:"10px 14px",borderRadius:T.r.md,background:`${T.rose}14`,fontSize:12,color:T.rose}}>
                {passkeyError}
              </div>
            )}
            <button
              onClick={handlePasskeyAuth}
              disabled={passkeyBusy}
              style={{
                width:"100%",
                padding:"16px",
                background:T.coral,
                border:"none",
                borderRadius:T.r.lg,
                fontSize:16,
                fontWeight:500,
                color:T.bg0,
                cursor:passkeyBusy?"default":"pointer",
                opacity:passkeyBusy?0.6:1,
                marginBottom:12,
              }}
            >
              {passkeyBusy ? "Verifying..." : "Authenticate"}
            </button>
            <button
              onClick={()=>{setNeedsPasskeyAuth(null);setPasskeyError(null);}}
              style={{background:"none",border:"none",padding:"8px",fontSize:13,color:T.text3,cursor:"pointer"}}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmWipe&&(
        <div onClick={()=>!wipeBusy&&setConfirmWipe(null)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.rose}33`,animation:`slideUp 240ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box"}}>
            <div style={{fontFamily:T.serif,fontSize:24,fontWeight:300,lineHeight:1.2,marginBottom:8}}>
              Wipe <span style={{color:T.rose,fontStyle:"italic"}}>{confirmWipe}</span>?
            </div>
            <p style={{fontSize:13,color:T.text2,marginBottom:24,lineHeight:1.6}}>
              Choose how far this goes. Local keeps your data in the cloud — you can reclaim the name by typing it again. Full wipe releases the name and deletes everything.
            </p>

            {wipeError && (
              <div style={{padding:"10px 14px",marginBottom:16,borderRadius:T.r.md,background:`${T.rose}14`,border:`1px solid ${T.rose}44`,fontSize:12,color:T.rose,lineHeight:1.5}}>
                {wipeError}
              </div>
            )}

            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:12}}>
              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:false})}
                style={{padding:"16px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1}}>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.text1,lineHeight:1.3,marginBottom:3}}>
                  Remove from this device
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Cloud data stays. Reclaim the name any time.
                </div>
              </button>

              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:true})}
                style={{padding:"16px",background:`${T.rose}18`,border:`1px solid ${T.rose}55`,borderRadius:T.r.lg,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1}}>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.rose,lineHeight:1.3,marginBottom:3}}>
                  {wipeBusy ? "Wiping…" : "Full wipe — cloud & device"}
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Deletes all weights, history, and the name claim. Can't be undone.
                </div>
              </button>
            </div>

            <button
              disabled={wipeBusy}
              onClick={()=>setConfirmWipe(null)}
              style={{width:"100%",padding:"12px",background:"none",border:"none",cursor:wipeBusy?"default":"pointer",fontFamily:T.sans,fontSize:13,color:T.text3}}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Taken name → passkey sign-in or fallback explainer */}
      {showTakenHelp && (
        <TakenNameModal
          name={name.trim()}
          webAuthnSupported={webAuthnSupported}
          onClose={() => setShowTakenHelp(false)}
          onActivate={onActivate}
          passkeyBusy={passkeyBusy}
          setPasskeyBusy={setPasskeyBusy}
          passkeyError={passkeyError}
          setPasskeyError={setPasskeyError}
        />
      )}

      {/* Bodyweight edit modal — rendered here so it works within ProfileScreen's early return */}
      <BodyweightEditModal open={bwEditOpen} onClose={()=>setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight}/>
    </div>
  );
}

// ─── Home ──────────────────────────────────��──────────────────────────────────
function HomeScreen({rhythm,profileName,userWeek,strengthDaySessions,onEditWeek,onBegin,onProfile,weekDone={},onMarkDayDone,bonusDone={},onMarkBonusDone,programmeBlock,weeksOnBlock,onRotate,onResetProgramme,userFocus="Forged",onEditFocus,onPerformance,historyCount=0,recoveryNudge=null,onDismissRecovery,syncState="idle",pendingDraft=null,onResumeDraft,onDiscardDraft,showBwCard=false,onOpenBwEdit,onDismissBwCard,deloadOffer=null,onAcceptDeload,onDismissDeload,untickedDays=[],onOpenRetroPicker,retroToast=null,onDismissRetroToast,pnStage="hidden",pnBusy=false,pnError=null,pnSuccessToast=false,onPnRegister,onPnSnooze,onPnDismissToast,tonnageMilestone=null,tonnageTotalKg=0,onDismissTonnageMilestone,historyWeekDone={}}){
  // Two-tap reset confirmation: first tap arms, second tap commits, 5s timeout disarms.
  const [resetArmed, setResetArmed] = useState(false);
  const resetTimerRef = useRef(null);
  const hasRotationDrift = Object.keys(programmeBlock?.config || {}).length > 0;
  const handleResetTap = () => {
    if (!resetArmed) {
      setResetArmed(true);
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setResetArmed(false), 5000);
      return;
    }
    clearTimeout(resetTimerRef.current);
    setResetArmed(false);
    onResetProgramme?.();
  };
  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  // Rotation choice modal — at ROTATION_AUTO weeks the rotate prompt
  // becomes a fork: refresh exercises within the current focus, or change
  // focus (which itself re-rotates). Pre-AUTO weeks, tap → straight rotate.
  const [rotateChoiceOpen, setRotateChoiceOpen] = useState(false);
  const offerRotationChoice = weeksOnBlock >= ROTATION_AUTO;
  const handleRotateTap = () => {
    if (offerRotationChoice && onEditFocus) {
      setRotateChoiceOpen(true);
    } else {
      onRotate?.();
    }
  };

  // Anchor "now" once at mount so render stays pure (no clock read mid-render)
  // and the day-of-week / viewed-date maths derive from a single consistent point.
  const [nowMs]  = useState(() => Date.now());
  const dow      = new Date(nowMs).getDay(); // 0=Sun
  const weekMap  = [6,0,1,2,3,4,5];    // JS day → WEEK index (Mon=0 … Sun=6)
  const todayIdx = weekMap[dow];

  const [viewIdx, setViewIdx] = useState(todayIdx);

  const viewDay        = userWeek[viewIdx];
  const cfg            = DAY_CONFIG[viewDay.type] || DAY_CONFIG.rest;
  const accent         = T[viewDay.type] || T.rest;
  const isViewingToday = viewIdx === todayIdx;

  // Optional cardio-day bonus for the VIEWED day. bonusForDay returns null for
  // ineligible day types (everything except cardio/hiit), so this is the only
  // guard needed. Local date string (not toISOString — avoids the UTC day-shift).
  const _vd = new Date(nowMs);
  _vd.setDate(_vd.getDate() + (viewIdx - todayIdx));
  const viewDateStr = `${_vd.getFullYear()}-${String(_vd.getMonth()+1).padStart(2,"0")}-${String(_vd.getDate()).padStart(2,"0")}`;
  const dayBonus   = bonusForDay(viewDateStr, viewDay.type);

  // Resolve which session to preview for the viewed day (null for non-strength days)
  const viewSessionIdx = strengthDaySessions[viewIdx];
  // Apply training-focus programming so the upcoming-session preview shows
  // the user's real plan: Strong's dropped superset doesn't appear, Sculpt's
  // bumped sets surface here, etc.
  const rawViewSession = viewSessionIdx !== undefined ? SESSIONS[viewSessionIdx] : null;
  // Chain rotation → focus so the home preview shows the user's actual
  // accessories (not the template defaults). Was the source of "rotation
  // happened but home still shows Skullcrusher" — preview was reading
  // straight from SESSIONS without consulting programmeBlock.config.
  const rotatedViewSession = rawViewSession ? applyRotationToSession(rawViewSession, programmeBlock?.config) : null;
  const viewSession    = rotatedViewSession ? applyFocusToSession(rotatedViewSession, userFocus, programmeBlock?.config) : null;

  // Dynamic headline/sub. On strength days, headline2 IS viewSession.subtitle
  // (e.g. "Squat & Push"), and surfacing it AGAIN as the small descriptor
  // below was visible-on-screen duplication. Instead, fill that slot with
  // useful state — the user's focus + how long they've been on this block.
  // "Block N" was internal jargon ("what's a block?"); time-since-rotation
  // is the intuitive read. Editorial copy:
  //   week 0 (fresh rotation):  "Forged · fresh block"
  //   week 1+:                  "Forged · N week(s) in"
  // Non-strength days keep their existing cfg.sub modality detail.
  const headline2 = viewSession ? viewSession.subtitle : cfg.headline[1];
  const blockTenureCopy = weeksOnBlock >= 1
    ? `${weeksOnBlock} week${weeksOnBlock === 1 ? "" : "s"} in`
    : "fresh block";
  const subText   = viewSession
    ? `${userFocus} · ${blockTenureCopy}`
    : cfg.sub;

  // Negative diff = earlier this week, positive = later this week
  const diffDays = viewIdx - todayIdx;

  const dayLabel = diffDays === 0
    ? "Today"
    : diffDays === 1
    ? "Tomorrow"
    : diffDays === -1
    ? "Yesterday"
    : DAY_NAMES[viewIdx];

  // Actual date of the viewed day (from the mount-time anchor above)
  const viewDate = new Date(nowMs + diffDays * 86400000);

  // Focus accent (per-user identity). Forms a secondary rim glow + colours
  // the italic flourish on the headline. Quiet by design — never competes
  // with the day-type accent, just layers a "you-are-here" hint underneath.
  const focusAccent = T.focusAccent[userFocus] || T.focusAccent.Forged;

  // Per-day rim position for the secondary glow. Each day type's secondary
  // sits in a different corner to give the backdrop a sense of movement and
  // depth as the user scrubs through the week — strength leads from top-right
  // (intense), Z2 drifts from bottom-left (settled), HIIT counterbalances top-
  // left (sharp), cardio sits mid-right (sustained), rest near-invisible.
  const dayRim = ({
    strength: { top: -120, right: -80,    width: 360, height: 320 },
    zone2:    { bottom: -120, left: -80,  width: 420, height: 360 },
    hiit:     { top: -120, left: -80,     width: 320, height: 280 },
    cardio:   { top: "30%", right: -120,  width: 360, height: 320 },
    rest:     { top: "40%", left: "20%",  width: 280, height: 240 },
  })[viewDay.type] || { top: -120, right: -80, width: 360, height: 320 };

  return (
    <div style={{minHeight:"100vh",paddingBottom:48,position:"relative",overflow:"hidden"}}>
      {/* Primary ambient glow — top-centre, day-typed. The dominant signal. */}
      <div style={{
        position:"absolute",top:-180,left:"50%",transform:"translateX(-50%)",
        width:600,height:500,
        background:`radial-gradient(ellipse,${accent.glow} 0%,transparent 65%)`,
        pointerEvents:"none",
        transition:`background 400ms ${T.ease}`,
      }}/>
      {/* Per-day rim glow — gives the backdrop dimensional depth without
          adding chrome. Position varies by day; colour matches the day's
          accent at lower intensity so it reads as "second light source"
          not "second voice". */}
      <div style={{
        position:"absolute",...dayRim,
        background:`radial-gradient(circle,${accent.glow} 0%,transparent 70%)`,
        opacity:0.55,
        pointerEvents:"none",
        transition:`all 500ms ${T.ease}`,
      }}/>
      {/* Focus-accent rim glow — quiet "you-are-here" layer in the user's
          chosen identity colour. Bottom-right by convention; opacity low so
          it never competes with the day-type signal above. */}
      <div style={{
        position:"absolute",bottom:-100,right:-60,
        width:340,height:280,
        background:`radial-gradient(ellipse,${focusAccent.glow} 0%,transparent 70%)`,
        opacity:0.7,
        pointerEvents:"none",
        transition:`background 400ms ${T.ease}`,
      }}/>

      {/* Header */}
      <Fade d={0}>
        <div style={{padding:"52px 24px 0",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontFamily:T.serif,fontSize:13,fontWeight:300,color:T.text2,fontStyle:"italic"}}>
              {new Date().toLocaleDateString("en-GB",{weekday:"long"})}
            </div>
            <div style={{fontFamily:T.serif,fontSize:28,fontWeight:400,lineHeight:1.15,marginTop:2}}>
              {new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
            <StreakBadge rhythm={rhythm}/>
            <button onClick={onProfile} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:11,color:T.text3,fontFamily:T.sans,fontWeight:500,display:"flex",alignItems:"center",gap:6}}>
              {profileName}
              {syncState === "pulling" || syncState === "pushing" ? (
                <span style={{
                  width:6,height:6,borderRadius:"50%",
                  background:T.sage,
                  animation:"pulse 1s ease-in-out infinite",
                }}/>
              ) : syncState === "error" ? (
                <span style={{width:6,height:6,borderRadius:"50%",background:T.coral,opacity:0.6}}/>
              ) : null}
              <span style={{marginLeft:2}}>↗</span>
            </button>
          </div>
        </div>
      </Fade>

      {/* Week strip — tappable */}
      <Fade d={60}>
        <div style={{padding:"28px 24px 0",display:"flex",gap:8}}>
          {userWeek.map((d,i)=>{
            const a       = T[d.type];
            const isToday = i === todayIdx;
            const isView  = i === viewIdx;
            // Done = manually ticked (non-strength) OR a strength session
            // was logged for this date (live or retro). Without the
            // history side, retro-logged sessions never marked the dot.
            const isDone  = !!(weekDone[i] || historyWeekDone[i]);
            return (
              <div key={i} onClick={()=>setViewIdx(i)}
                style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6,cursor:"pointer"}}>
                <div style={{
                  width:34,height:34,borderRadius:"50%",
                  background: isToday ? a.main : isDone ? `${a.main}28` : isView ? `${a.main}20` : T.bg2,
                  border:`${isView && !isToday ? "2px" : "1px"} solid ${isToday || isView || isDone ? a.main : T.bg3}`,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  boxShadow: isToday ? `0 0 20px ${a.glow}` : isView ? `0 0 10px ${a.glow}` : "none",
                  transition:`all 200ms ${T.ease}`,
                }}>
                  {isDone && !isToday
                    ? <span style={{fontSize:14,color:a.main,lineHeight:1}}>✓</span>
                    : <span style={{fontSize:12,fontWeight:500,color:isToday?T.bg0:isView?a.main:T.text3,transition:`color 200ms ${T.ease}`}}>{d.s}</span>
                  }
                </div>
                <span style={{
                  fontSize:8,fontWeight:500,
                  color: isToday ? a.main : isDone ? a.main : isView ? a.main : T.text4,
                  letterSpacing:"0.06em",textTransform:"uppercase",
                  transition:`color 200ms ${T.ease}`,
                }}>{d.label}</span>
              </div>
            );
          })}
        </div>
        {onEditWeek && (
          <div style={{display:"flex",justifyContent:"center",marginTop:8}}>
            <button onClick={onEditWeek} style={{padding:"4px 8px",background:"none",border:"none",cursor:"pointer",fontSize:10,color:T.sage,fontFamily:T.sans,letterSpacing:"0.06em",textTransform:"uppercase"}}>
              Edit week →
            </button>
          </div>
        )}
      </Fade>

      {/* Day headline — driven by viewIdx */}
      <Fade d={100}>
        <div style={{padding:"28px 24px 0"}}>
          {/* "Today" / "Tomorrow" / day-name label row */}
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{
              fontSize:11,fontWeight:500,letterSpacing:"0.12em",textTransform:"uppercase",
              color: isViewingToday ? T.text3 : accent.main,
              transition:`color 300ms ${T.ease}`,
            }}>
              {dayLabel}
            </div>
            {!isViewingToday && (
              <span style={{fontSize:10,color:T.text4,fontFamily:T.serif,fontStyle:"italic"}}>
                {viewDate.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}
              </span>
            )}
          </div>
          <div style={{fontFamily:T.serif,fontSize:42,fontWeight:300,lineHeight:1.1}}>
            {cfg.headline[0]}<br/>
            {headline2 && (
              // Italic flourish takes the user's focus-accent colour, giving
              // a quiet identity signal in the editorial typography itself —
              // Sculpt's mauve, Strong's deeper coral, Forged's gold. The day-
              // type accent remains the dominant visual via the rim glows.
              <span style={{color:focusAccent.main,fontStyle:"italic",transition:`color 300ms ${T.ease}`}}>
                {headline2}
              </span>
            )}
          </div>
          {/* Render the smaller descriptor only when it adds info beyond
              the headline. On strength days, headline2 IS viewSession.subtitle
              (e.g. "Squat & Push"), so showing it again here is duplicative
              clutter — the small line is intentionally suppressed. On non-
              strength days, cfg.sub carries the modality detail
              ("60 min at conversational pace…") which is distinct. */}
          {subText && subText !== headline2 && (
            <div style={{fontSize:14,color:T.text2,marginTop:10,lineHeight:1.5}}>
              {subText}
            </div>
          )}
        </div>
      </Fade>

      {/* Strength day — session card + CTA */}
      {cfg.canBegin && viewSession && (
        <>
          <Fade d={160}>
            <Card style={{margin:"24px 24px 0",padding:0,overflow:"hidden"}}>
              <div style={{height:2,background:`linear-gradient(90deg,${accent.main},${accent.main}00)`,transition:`background 400ms ${T.ease}`}}/>
              <div style={{padding:"20px 22px 24px"}}>
                <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:16}}>Session overview</div>
                {/* Stats row — derived from session */}
                {(()=>{
                  const supersets = viewSession.blocks.filter(b=>b.type==="superset").length;
                  return (
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",paddingBottom:18,marginBottom:18,borderBottom:`1px solid ${T.bg3}`}}>
                      {[[String(viewSession.blocks.length),"Blocks"],["~65 min","Duration"],[String(supersets),"Supersets"]].map(([v,l])=>(
                        <div key={l}>
                          <div style={{fontFamily:T.serif,fontSize:24,fontWeight:400,lineHeight:1}}>{v}</div>
                          <div style={{fontSize:11,color:T.text3,marginTop:4}}>{l}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {/* Exercise list — derived from session blocks */}
                {viewSession.blocks.map((b,i,arr)=>{
                  const tag   = b.type==="main" ? "Main" : b.type==="superset" ? "Superset" : "Finisher";
                  const color = tag==="Main" ? T.coral : tag==="Superset" ? T.sage : T.gold;
                  const name  = b.type==="main"
                    ? b.ex.name
                    : `${(b.exA||b.ex).name} ↔ ${(b.exB||b.ex).name}`;
                  const sets  = b.type==="main"
                    ? `${b.sets}×${b.ex.reps}`
                    : `${b.sets}×${b.exA?.reps||b.exB?.reps}`;
                  return (
                    <div key={b.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:i<arr.length-1?`1px solid ${T.bg3}`:"none"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:color,flexShrink:0}}/>
                        <span style={{fontSize:13,color:T.text1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</span>
                      </div>
                      <span style={{fontFamily:T.serif,fontSize:13,color:T.text3,fontStyle:"italic",flexShrink:0,marginLeft:12}}>{sets}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </Fade>
          <Fade d={220}>
            {isViewingToday && weekDone[todayIdx] ? (
              <div style={{margin:"16px 24px 0",padding:"16px 20px",background:`${accent.main}10`,border:`1px solid ${accent.main}40`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:18,color:accent.main}}>✓</span>
                <span style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:accent.main,fontStyle:"italic"}}>Session complete. See you next time.</span>
              </div>
            ) : isViewingToday ? (
              <button onClick={onBegin} style={{
                margin:"16px 24px 0",width:"calc(100% - 48px)",
                padding:"18px 24px",background:accent.main,border:"none",
                borderRadius:T.r.lg,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"space-between",
                boxShadow:`0 12px 40px ${accent.glow}`,
              }}>
                <span style={{fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0}}>Begin session</span>
                <span style={{fontSize:18,color:T.bg0}}>→</span>
              </button>
            ) : (
              <div style={{
                margin:"16px 24px 0",padding:"16px 20px",
                background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,
                display:"flex",alignItems:"center",justifyContent:"space-between",
                gap:12,
              }}>
                <span style={{fontFamily:T.serif,fontSize:15,fontWeight:300,color:T.text3,fontStyle:"italic"}}>
                  {diffDays > 0 ? "Upcoming" : "Past session"}
                </span>
                <Tag color={accent.main}>{viewDate.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}</Tag>
              </div>
            )}
          </Fade>
        </>
      )}

      {/* Non-strength day — tips card + mark complete */}
      {!cfg.canBegin && cfg.tips && (
        <Fade d={160}>
          <Card style={{margin:"24px 24px 0",padding:"20px 22px 24px"}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:16}}>
              {viewDay.type==="rest" ? "Recovery notes" : "Session notes"}
            </div>
            {cfg.tips.map((tip,i)=>(
              <div key={i} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"8px 0",borderBottom:i<cfg.tips.length-1?`1px solid ${T.bg3}`:"none"}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:accent.main,flexShrink:0,marginTop:5,transition:`background 300ms ${T.ease}`}}/>
                <span style={{fontSize:13,color:T.text2,lineHeight:1.5}}>{tip}</span>
              </div>
            ))}
          </Card>
        </Fade>
      )}
      {!cfg.canBegin && isViewingToday && (
        <Fade d={220}>
          {weekDone[todayIdx] ? (
            <div style={{margin:"12px 24px 0",padding:"16px 20px",background:`${accent.main}10`,border:`1px solid ${accent.main}40`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:18,color:accent.main}}>✓</span>
              <span style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:accent.main,fontStyle:"italic"}}>Done. Streak maintained.</span>
            </div>
          ) : (
            <button onClick={()=>onMarkDayDone()} style={{
              margin:"12px 24px 0",width:"calc(100% - 48px)",
              padding:"16px 20px",background:"transparent",
              border:`1px solid ${accent.main}`,borderRadius:T.r.lg,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"space-between",
            }}>
              <span style={{fontFamily:T.serif,fontSize:18,fontWeight:300,color:accent.main}}>Mark complete</span>
              <span style={{fontSize:16,color:accent.main}}>✓</span>
            </button>
          )}
        </Fade>
      )}

      {/* Today's bonus — optional capacity finisher on cardio/HIIT days only.
          Clearly framed as a bonus, never homework. Completion is tracked in a
          separate store with zero streak impact. */}
      {dayBonus && isViewingToday && (
        <Fade d={260}>
          <Card style={{margin:"16px 24px 0",padding:"18px 20px 20px"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:500,color:accent.main,letterSpacing:"0.12em",textTransform:"uppercase"}}>
                Today&apos;s bonus · optional
              </div>
              <div style={{fontSize:10,color:T.text4,letterSpacing:"0.06em",textTransform:"uppercase"}}>~5 min</div>
            </div>
            <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1,lineHeight:1.2,marginBottom:4}}>
              {dayBonus.name}
            </div>
            <div style={{fontSize:13,color:T.text2,lineHeight:1.5,marginBottom:16}}>
              {dayBonus.detail}
            </div>
            {bonusDone[todayIdx] ? (
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16,color:accent.main}}>✓</span>
                <span style={{fontFamily:T.serif,fontSize:15,fontWeight:300,color:accent.main,fontStyle:"italic"}}>Bonus banked. Animal.</span>
              </div>
            ) : (
              <button onClick={onMarkBonusDone} aria-label="Mark bonus complete" style={{
                width:"100%",padding:"12px 16px",background:"transparent",
                border:`1px solid ${accent.main}66`,borderRadius:T.r.md,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"space-between",
              }}>
                <span style={{fontSize:14,fontWeight:500,color:accent.main}}>Mark bonus done</span>
                <span style={{fontSize:14,color:accent.main}}>+</span>
              </button>
            )}
          </Card>
        </Fade>
      )}

      {/* Pick up where you left off — an interrupted session from within the
          last 12 hours. Coral-tinted; the session is top-priority if it exists. */}
      {pendingDraft && (
        <Fade d={160}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.coral}0E`,border:`1px solid ${T.coral}40`,borderRadius:T.r.lg,boxShadow:`0 8px 28px ${T.coral}10`}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:14}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                  Unfinished session
                </div>
                <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1,lineHeight:1.25}}>
                  Pick up where you<br/><span style={{fontStyle:"italic",color:T.coral}}>left off.</span>
                </div>
                <div style={{fontSize:12,color:T.text3,marginTop:8,lineHeight:1.5}}>
                  {pendingDraft.setCount} {pendingDraft.setCount === 1 ? "set" : "sets"} logged · {formatAgo(pendingDraft.ageMs)}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={onResumeDraft}
                style={{flex:1,padding:"12px 16px",background:T.coral,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.bg0}}>
                Resume →
              </button>
              <button onClick={onDiscardDraft}
                style={{padding:"12px 16px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.md,cursor:"pointer",fontFamily:T.sans,fontSize:13,fontWeight:500,color:T.text3}}>
                Discard
              </button>
            </div>
          </div>
        </Fade>
      )}

      {/* BW re-prompt card — surfaces when bodyweight is stale (>14 days or never set) */}
      {showBwCard && (
        <Fade d={180}>
          <div onClick={onOpenBwEdit}
            style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.sage}0E`,border:`1px solid ${T.sage}40`,borderRadius:T.r.lg,cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                  Bodyweight
                </div>
                <div style={{fontFamily:T.serif,fontSize:18,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:4}}>
                  How much do you weigh today?
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Tap to update — keeps loaded pull-ups and dips honest.
                </div>
              </div>
              <button onClick={(e)=>{e.stopPropagation();onDismissBwCard();}} aria-label="Dismiss"
                style={{flexShrink:0,background:"none",border:"none",padding:"4px 8px",cursor:"pointer",fontSize:14,color:T.text3,fontFamily:T.sans}}>✕</button>
            </div>
          </div>
        </Fade>
      )}

      {/* Phase 3 — Deload offer card. Sage-tinted, surfaces only when signals
          warrant (stall convergence, deep stall, cooked accumulation, regression).
          Cooldowns prevent re-surfacing immediately after dismiss or completion. */}
      {deloadOffer && (() => {
        const copy = deloadCardCopy(deloadOffer);
        if (!copy) return null;
        return (
          <Fade d={170}>
            <div style={{margin:"20px 24px 0",padding:"20px 22px",background:`${T.sage}0E`,border:`1px solid ${T.sage}40`,borderRadius:T.r.lg,boxShadow:`0 8px 28px ${T.sage}10`}}>
              <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>
                {copy.kicker}
              </div>
              <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1,lineHeight:1.25,marginBottom:8}}>
                {copy.headline}
              </div>
              <div style={{fontSize:13,color:T.text2,lineHeight:1.55,marginBottom:18}}>
                {copy.body}
              </div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={onAcceptDeload}
                  style={{flex:1,padding:"12px 16px",background:T.sage,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0}}>
                  Run the deload →
                </button>
                <button onClick={onDismissDeload}
                  style={{flexShrink:0,padding:"12px 16px",background:"transparent",border:`1px solid ${T.bg3}`,borderRadius:T.r.md,cursor:"pointer",fontFamily:T.sans,fontSize:13,color:T.text3}}>
                  Not yet
                </button>
              </div>
            </div>
          </Fade>
        );
      })()}

      {/* Lifetime-tonnage milestone — surfaces ONCE when the user crosses a
          new threshold (1t, 5t, 10t, 25t…). Tap-anywhere dismisses; the new
          ceiling persists so it doesn't reappear. Editorial restraint — it's
          a small celebration beat, not a permanent counter. */}
      {tonnageMilestone && (
        <Fade d={200}>
          <button onClick={onDismissTonnageMilestone}
            aria-label={`Milestone: ${formatTonnage(tonnageMilestone)} moved — tap to dismiss`}
            style={{display:"block",width:"calc(100% - 48px)",margin:"20px 24px 0",padding:"16px 20px",background:`${T.gold}0F`,border:`1px solid ${T.gold}3A`,borderRadius:T.r.lg,textAlign:"left",cursor:"pointer",fontFamily:"inherit"}}>
            <div style={{fontSize:11,fontWeight:500,color:T.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
              Milestone · {formatTonnage(tonnageMilestone)}
            </div>
            <div style={{fontFamily:T.serif,fontSize:18,fontWeight:300,color:T.text1,lineHeight:1.4}}>
              You&apos;ve moved <span style={{color:T.gold,fontStyle:"italic"}}>{formatTonnage(tonnageTotalKg)}</span> since you started with Forge.
            </div>
          </button>
        </Fade>
      )}

      {/* Honest recovery nudge — surfaces when the last 2 sessions were cooked.
          Non-pushy. Dismisses in-memory for this session. */}
      {recoveryNudge && (
        <Fade d={180}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.sage}0E`,border:`1px solid ${T.sage}35`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                  A gentle nudge
                </div>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text1,lineHeight:1.45,fontStyle:"italic"}}>
                  {recoveryNudge.message}
                </div>
              </div>
              <button onClick={onDismissRecovery} aria-label="Dismiss"
                style={{flexShrink:0,background:"none",border:"none",padding:"4px 8px",cursor:"pointer",fontSize:14,color:T.text3,fontFamily:T.sans}}>✕</button>
            </div>
          </div>
        </Fade>
      )}

      {/* Retrospective logging link — surfaces whenever the schedule has
          an unmarked recent training day. Calm by design: no card, no
          chrome, just an inline link tinted sage so it reads as a non-
          action utility rather than competing with the day's "begin
          session" CTA.
          //
          // !pendingDraft removed as a gate (was silently hiding the link
          // for any user with a paused/half-started session). The link is
          // informational and orthogonal to the resume-draft card — both
          // can render. Inside the picker, pendingDraft still disables
          // tappability with explicit "Finish your live session first"
          // copy, so a user with an active draft sees the unmarked days
          // and understands why they can't log them yet. */}
      {untickedDays.length > 0 && onOpenRetroPicker && (
        <Fade d={190}>
          <div style={{margin:"18px 24px 0",display:"flex",justifyContent:"center"}}>
            <button onClick={onOpenRetroPicker}
              style={{background:"none",border:"none",padding:"6px 4px",cursor:"pointer",fontFamily:T.sans,fontSize:13,color:T.sage,letterSpacing:"0.01em"}}>
              <span style={{fontStyle:"italic",fontFamily:T.serif}}>Anything missed?</span> →
            </button>
          </div>
        </Fade>
      )}

      {/* Passkey nudge — chip phase (days 0-3). Subtle inline link with a tiny
          dismiss ✕. Tone: discoverability cue. The chip presumes the user
          might not know what a passkey is or why it matters — vague-but-curious
          benefit framing ("across devices") is fine because the card phase is
          where consequences get spelled out. */}
      {pnStage === "chip" && (
        <Fade d={195}>
          <div style={{margin:"14px 24px 0",display:"flex",justifyContent:"center",alignItems:"center",gap:8}}>
            <button onClick={onPnRegister} disabled={pnBusy}
              style={{background:"none",border:"none",padding:"6px 4px",cursor:pnBusy?"default":"pointer",fontFamily:T.sans,fontSize:13,color:T.sage,letterSpacing:"0.01em",opacity:pnBusy?0.6:1}}>
              {pnBusy
                ? <span style={{fontStyle:"italic",fontFamily:T.serif}}>Setting up…</span>
                : <>Secure your name <span style={{fontStyle:"italic",fontFamily:T.serif}}>across devices</span> →</>}
            </button>
            {!pnBusy && (
              <button onClick={onPnSnooze} aria-label="Dismiss for a week"
                style={{background:"none",border:"none",padding:"4px 6px",cursor:"pointer",fontSize:11,color:T.text4,fontFamily:T.sans}}>✕</button>
            )}
          </div>
          {pnError && (
            <div style={{margin:"8px 24px 0",padding:"8px 14px",borderRadius:T.r.sm,background:`${T.rose}14`,fontSize:11,color:T.rose,textAlign:"center"}}>
              {pnError}
            </div>
          )}
        </Fade>
      )}

      {/* Passkey nudge — card phase (days 4+). Same scope as the chip but the
          consequence becomes explicit. "Lives only on this device" is the
          honest framing — calling it "data loss" would be true but
          melodramatic. The 7-day snooze stays so users who keep dismissing
          aren't trapped in a loop they can't escape. */}
      {pnStage === "card" && (
        <Fade d={200}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.sage}0E`,border:`1px solid ${T.sage}40`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,marginBottom:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                  Secure across devices
                </div>
                <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:6}}>
                  Add a passkey
                </div>
                <p style={{fontSize:13,color:T.text2,lineHeight:1.55,margin:0}}>
                  Without one, your data lives only on this device. Face ID, Touch ID, or your device PIN — takes a second.
                </p>
              </div>
              <button onClick={onPnSnooze} aria-label="Dismiss"
                style={{flexShrink:0,background:"none",border:"none",padding:"4px 8px",cursor:"pointer",fontSize:14,color:T.text3,fontFamily:T.sans}}>✕</button>
            </div>
            <button onClick={onPnRegister} disabled={pnBusy}
              style={{width:"100%",padding:"12px 16px",background:T.sage,border:"none",borderRadius:T.r.md,cursor:pnBusy?"default":"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0,opacity:pnBusy?0.6:1}}>
              {pnBusy ? "Setting up…" : "Set up passkey →"}
            </button>
            {pnError && (
              <div style={{marginTop:10,padding:"8px 12px",borderRadius:T.r.sm,background:`${T.rose}14`,fontSize:11,color:T.rose}}>
                {pnError}
              </div>
            )}
          </div>
        </Fade>
      )}

      {/* Passkey success toast — same pattern as retro toast. Sage, 3s auto-dismiss. */}
      {pnSuccessToast && (
        <div style={{position:"fixed",top:"calc(20px + env(safe-area-inset-top))",left:"50%",transform:"translateX(-50%)",zIndex:300,maxWidth:"calc(100% - 48px)",pointerEvents:"auto"}}>
          <div onClick={onPnDismissToast}
            style={{background:T.bg2,border:`1px solid ${T.sage}55`,borderRadius:T.r.lg,padding:"12px 18px",boxShadow:`0 12px 40px rgba(0,0,0,0.5), 0 0 24px ${T.sage}20`,cursor:"pointer",animation:`toastIn 280ms ${T.ease}`,display:"flex",alignItems:"center",gap:10}}>
            <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.sage,flexShrink:0}}/>
            <span style={{fontSize:13,color:T.text1}}>
              Passkey added. <span style={{fontStyle:"italic",fontFamily:T.serif}}>Your name's secure now.</span>
            </span>
          </div>
        </div>
      )}

      {/* Retro completion toast — sage, 3s auto-dismiss. Sits at the top of
          the home screen because by the time it shows we're already back here. */}
      {retroToast && (
        <div style={{position:"fixed",top:"calc(20px + env(safe-area-inset-top))",left:"50%",transform:"translateX(-50%)",zIndex:300,maxWidth:"calc(100% - 48px)",pointerEvents:"auto"}}>
          <div onClick={onDismissRetroToast}
            style={{background:T.bg2,border:`1px solid ${T.sage}55`,borderRadius:T.r.lg,padding:"12px 18px",boxShadow:`0 12px 40px rgba(0,0,0,0.5), 0 0 24px ${T.sage}20`,cursor:"pointer",animation:`toastIn 280ms ${T.ease}`,display:"flex",alignItems:"center",gap:10}}>
            <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.sage,flexShrink:0}}/>
            <span style={{fontSize:13,color:T.text1}}>
              Logged <span style={{fontStyle:"italic",fontFamily:T.serif}}>{retroToast.sessionName}</span> for {retroToast.date}
            </span>
          </div>
        </div>
      )}

      {/* Rotation nudge — surfaces after 4 weeks on a block */}
      {weeksOnBlock >= 4 && (
        <Fade d={200}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.gold}10`,border:`1px solid ${T.gold}40`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.gold,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>
                  Block {programmeBlock?.number} · {weeksOnBlock} weeks
                </div>
                <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,lineHeight:1.3,marginBottom:4}}>
                  Time to rotate accessories
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  {offerRotationChoice
                    ? "You've earned a re-think. Refresh exercises, or change your focus altogether."
                    : "Your body has adapted. New exercises, same muscle targets."}
                </div>
              </div>
              <button onClick={handleRotateTap} style={{flexShrink:0,marginTop:2,padding:"10px 16px",background:T.gold,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0}}>
                {offerRotationChoice ? "Choose →" : "Rotate →"}
              </button>
            </div>
          </div>
        </Fade>
      )}

      {/* Performance Lab entry — always visible, becomes active once data exists */}
      <Fade d={260}>
        <div onClick={onPerformance}
          style={{margin:"20px 24px 0",padding:"18px 20px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,transition:`all 200ms ${T.ease}`}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>
              Performance lab
            </div>
            <div style={{fontFamily:T.serif,fontSize:19,fontWeight:300,color:T.text1,lineHeight:1.3,marginBottom:3}}>
              {historyCount === 0
                ? "Your progress, visualised"
                : `${historyCount} session${historyCount===1?"":"s"} logged`}
            </div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.5,fontFamily:T.serif,fontStyle:"italic"}}>
              {historyCount === 0
                ? "Complete a session to light it up"
                : "1RM trends · weekly volume · consistency"}
            </div>
          </div>
          <div style={{flexShrink:0,width:40,height:40,borderRadius:"50%",background:historyCount > 0 ? `${T.gold}18` : T.bg3,border:`1px solid ${historyCount > 0 ? T.gold+"55" : T.bg4}`,display:"flex",alignItems:"center",justifyContent:"center",transition:`all 200ms ${T.ease}`}}>
            <span style={{fontSize:16,color:historyCount > 0 ? T.gold : T.text3}}>→</span>
          </div>
        </div>
      </Fade>

      {/* Reset accessories — quiet escape hatch for over-rotated users. Lives
          below the Performance Lab card now so it doesn't compete for attention
          with the day's session card. Only surfaces when there's actual
          rotation drift to undo. Two-tap confirm inline, no modal, 5s
          auto-disarm. */}
      {hasRotationDrift && (
        <div style={{margin:"16px 24px 0",textAlign:"center"}}>
          <button
            onClick={handleResetTap}
            style={{padding:"6px 10px",background:"none",border:"none",cursor:"pointer",fontSize:11,color:resetArmed?T.rose:T.text4,textDecoration:"underline",textUnderlineOffset:3,fontFamily:T.sans}}>
            {resetArmed ? "Tap again to reset accessories to defaults" : "Reset accessories to defaults"}
          </button>
        </div>
      )}

      {rotateChoiceOpen && (
        <RotationChoiceModal
          weeksOnBlock={weeksOnBlock}
          currentFocus={userFocus}
          onRefresh={() => { setRotateChoiceOpen(false); onRotate?.(); }}
          onChangeFocus={() => { setRotateChoiceOpen(false); onEditFocus?.(); }}
          onCancel={() => setRotateChoiceOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Rotation choice modal ─────────────────────────────────────────────────
// Shown when the user taps "Choose →" on the rotate card at ≥ ROTATION_AUTO
// weeks. Two paths: refresh the accessory picks within the current focus,
// or change focus altogether (which re-rotates automatically as a side
// effect of the focus-save handler). Pre-AUTO weeks, the rotate card calls
// onRotate directly and this modal never opens.
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
    <div onKeyDown={onKeyDown} onClick={onCancel} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
      style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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

function RotationChoiceModal({ weeksOnBlock, currentFocus, onRefresh, onChangeFocus, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "rotation-choice-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.gold}44`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:T.gold,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          {weeksOnBlock} weeks on this block
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.15,marginBottom:6}}>
          Time to rotate.<br/><span style={{color:T.gold,fontStyle:"italic"}}>What do you want to do?</span>
        </div>
        <p style={{fontSize:13,color:T.text3,marginBottom:18,lineHeight:1.5}}>
          You&apos;re on <strong style={{color:T.text2}}>{currentFocus}</strong>. Refresh the accessory picks within it, or rethink the whole focus.
        </p>

        <button onClick={onRefresh}
          style={{padding:"16px 18px",background:`${T.gold}14`,border:`1px solid ${T.gold}`,borderRadius:T.r.md,cursor:"pointer",textAlign:"left",marginBottom:10,transition:`all 160ms ${T.ease}`}}>
          <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.gold,marginBottom:4}}>1. Refresh exercises</div>
          <div style={{fontSize:12,color:T.text2,lineHeight:1.5}}>New picks within your current focus. Same muscle targets, fresh stimulus.</div>
        </button>

        <button onClick={onChangeFocus}
          style={{padding:"16px 18px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.md,cursor:"pointer",textAlign:"left",transition:`all 160ms ${T.ease}`}}>
          <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,marginBottom:4}}>2. Change focus</div>
          <div style={{fontSize:12,color:T.text2,lineHeight:1.5}}>Switch to a different goal — Forged / Strong / Sculpt. Accessories re-rotate with the new bias.</div>
        </button>

        <button onClick={onCancel}
          style={{marginTop:16,padding:"10px",background:"none",border:"none",cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans,alignSelf:"center"}}>
          Not now
        </button>
      </div>
    </div>
  );
}

// ─── Readiness ─────────────────────────────────────────────────────────────────
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
    <div style={{minHeight:"100vh",position:"relative",overflow:"hidden",paddingBottom:40}}>
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
        <div style={{display:"flex",alignItems:"baseline",gap:6,cursor:"pointer",userSelect:"none"}} onClick={()=>{ if(activeEx?.name) setEditTarget({exName:activeEx.name,currentKg:showWeightPicker?currentW:null,currentReps:getR(activeEx),loadType}); }}>
          <span style={{fontFamily:T.serif,fontSize:48,fontWeight:400,color:T.coral,lineHeight:1,fontStyle:"italic"}}>{getR(activeEx)}</span>
          <span style={{fontSize:14,color:T.text3,marginBottom:4}}>reps</span>
          <span style={{fontSize:11,color:T.text3,marginBottom:6,marginLeft:4}}>↕</span>
        </div>
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
      {awaitRpe&&<RpeCard onPick={onCommit} label="How was that set?"/>}
      {ssRoundDone&&<RpeCard onPick={onCommit} label={`Round ${setNum} of ${block.sets} — rate the effort`}/>}
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
          <button onClick={onLog} style={{margin:"12px 20px 0",width:"calc(100% - 40px)",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",boxShadow:`0 8px 28px ${s.glow}`}}>
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
        <div onClick={()=>setShowVid(false)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
// pill to preview its summary, then Save to apply. Save triggers an immediate
// re-rotation with the new bias — the rotation-summary modal that follows
// shows the user exactly what shifted in their accessories.
function FocusPickerSheet({ current, onSave, onCancel }) {
  const [draft, setDraft] = useState(current || DEFAULT_FOCUS);
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "focus-picker-title";
  const changed = draft !== current;
  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"90vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          Training focus
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.15,marginBottom:6,color:T.text1}}>
          What are you training for?
        </div>
        <p style={{fontSize:13,color:T.text3,marginBottom:18,lineHeight:1.5}}>
          Every focus still trains your whole body — this just biases <em>which alternatives</em> rotation favours within each accessory slot. Main lifts never change.
        </p>

        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
          {FOCUS_OPTIONS.map(f => {
            const active = draft === f;
            return (
              <button key={f} onClick={()=>setDraft(f)}
                aria-pressed={active}
                style={{padding:"14px 16px",background:active?`${T.gold}14`:T.bg3,border:`1px solid ${active?T.gold:T.bg4}`,borderRadius:T.r.md,cursor:"pointer",textAlign:"left",transition:`all 160ms ${T.ease}`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontFamily:T.serif,fontSize:18,fontWeight:300,color:active?T.gold:T.text1,fontStyle:active?"italic":"normal"}}>{f}</span>
                  {active && <span style={{fontSize:13,color:T.gold}}>✓</span>}
                </div>
                <div style={{fontSize:12,color:T.text2,lineHeight:1.5}}>{FOCUS_SUMMARIES[f]}</div>
              </button>
            );
          })}
        </div>

        {changed && (
          <div style={{marginBottom:14,padding:"10px 12px",background:`${T.gold}10`,border:`1px solid ${T.gold}33`,borderRadius:T.r.sm,fontSize:12,color:T.text2,lineHeight:1.5}}>
            Saving will re-rotate your accessories now to reflect the new focus.
          </div>
        )}

        <div style={{display:"flex",gap:8}}>
          <button onClick={onCancel}
            style={{flex:1,padding:"14px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",fontSize:13,color:T.text2,fontFamily:T.sans}}>
            Cancel
          </button>
          <button onClick={()=>onSave(draft)} disabled={!changed}
            style={{flex:2,padding:"14px",background:changed?T.gold:T.bg3,border:"none",borderRadius:T.r.lg,cursor:changed?"pointer":"default",fontFamily:T.serif,fontSize:16,fontWeight:400,color:changed?T.bg0:T.text3,opacity:changed?1:0.6}}>
            Save focus
          </button>
        </div>
      </div>
    </div>
  );
}

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
    <div onKeyDown={onKeyDown} onClick={onCancel} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
      style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
    <div onKeyDown={onKeyDown} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.94)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
  const initReps=typeof rawReps==="string"?8:(rawReps??8);
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
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div><div id={titleId} style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{target.exName}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:4}}>Scroll to adjust</div></div>
          <button onClick={onClose} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
        </div>
        <div style={{display:"flex",gap:16,justifyContent:hasWeight?"space-between":"center"}}>
          {hasWeight&&<ScrollDrum value={kg} onChange={setKg} step={weightStep} min={0} max={400} label={lt==="per_db"?"kg / db":"kg"}/>}
          <ScrollDrum value={reps} onChange={setReps} step={1} min={1} max={30} integer label="reps"/>
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
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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
    <div style={{minHeight:"100vh",position:"relative",overflow:"hidden",paddingBottom:120}}>
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
          <div onClick={() => setEditor(null)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
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

// ─── Bodyweight Edit Modal ─────────────────────────────────────────────────────
// Reusable bottom-sheet modal for editing bodyweight. Triggered from:
// - Home screen BW re-prompt card
// - Profile settings BW row
// - Post-session BW prompt after logging bodyweight movements
function BodyweightEditModal({open,onClose,currentKg,onSave}){
  const [kg,setKg]=useState(currentKg || 75);

  // Reset the input to the latest value each time the modal opens. Done as a
  // render-phase adjustment (tracking the previous `open`) rather than an
  // effect — React applies the setState before paint, no extra render, and it
  // sidesteps the cascading-render trap of syncing props to state in an effect.
  const [wasOpen,setWasOpen]=useState(open);
  if(open!==wasOpen){
    setWasOpen(open);
    if(open) setKg(currentKg || 75);
  }

  if(!open) return null;

  // First-time entry vs update — first time gets a one-line context, updates
  // get the tighter "Scroll to adjust" subtitle that mirrors DrumEditOverlay.
  // Same editorial family, different density to match the moment.
  const isFirstTime = currentKg === null || currentKg === undefined;

  return <BodyweightEditModalInner kg={kg} setKg={setKg} onClose={onClose} onSave={onSave} isFirstTime={isFirstTime}/>;
}

function BodyweightEditModalInner({kg, setKg, onClose, onSave, isFirstTime}){
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "bw-edit-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.sage}28`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>

        {/* Header — tightened to match DrumEditOverlay pattern. ✕ close
            sits top-right rather than a separate Cancel button at the bottom. */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div>
            <div id={titleId} style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>Bodyweight</div>
            <div style={{fontSize:12,color:T.text3,marginTop:4,lineHeight:1.5,maxWidth:280}}>
              {isFirstTime
                ? "Used for loaded pull-ups, dips, and other weighted bodyweight movements."
                : "Scroll to adjust"}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13,flexShrink:0}}>✕</button>
        </div>

        <div style={{display:"flex",justifyContent:"center",marginBottom:24}}>
          <ScrollDrum value={kg} onChange={setKg} step={0.5} min={40} max={200} unit="kg"/>
        </div>

        {/* Single sage CTA — semantically aligned (BW is a passive measurement,
            not a training action; coral is reserved for training-action surfaces). */}
        <button onClick={()=>{onSave(kg);onClose();}} style={{width:"100%",padding:"16px",background:T.sage,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:18,fontWeight:400,color:T.bg0,boxShadow:`0 8px 28px ${T.sage}26`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>Confirm</span>
          <span style={{fontSize:16}}>→</span>
        </button>
      </div>
    </div>
  );
}

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

function DoneScreen({session,profileName,workingWeights,sessionStartWeights={},userWeek=WEEK,onHome,deloadCompleted=false}){
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
    <div style={{minHeight:"100vh",padding:"72px 24px 0",position:"relative",overflow:"hidden"}}>
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
        position:"fixed",inset:0,background:"rgba(10,9,8,0.90)",zIndex:500,
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

// ─── Shared ──────────────────────────────────────────────────────────��─────────
function Fade({children,d=0}){const s=useFadeIn(d);return <div style={s}>{children}</div>;}
function Card({children,style={}}){return <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,...style}}>{children}</div>;}
function Tag({children,color,style={}}){return <span style={{display:"inline-flex",alignItems:"center",fontSize:10,fontWeight:500,color,background:`${color}12`,border:`1px solid ${color}33`,borderRadius:T.r.pill,padding:"4px 12px",letterSpacing:"0.08em",...style}}>{children}</span>;}
function StreakBadge({rhythm}){
  const completed = rhythm?.completed || 0;
  const expected  = rhythm?.expected  || 12;
  // Window is a rolling 28-day count of strength sessions — labelled
  // honestly. Used to say "this month", but a rolling window doesn't reset
  // on the 1st, so users counting "since the month started" saw a mismatch
  // (e.g. 5 strength sessions in June so far, badge says 6 because a late-
  // May session is still inside the 28-day window).
  const window  = rhythm?.window || 28;
  const over = completed > expected;
  const primary = over ? `${expected}+` : `${completed}`;
  const secondary = over ? "of 12 · strong" : `of ${expected}`;
  return (
    <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.pill,padding:"8px 16px",display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontFamily:T.serif,fontSize:22,fontWeight:400,color:T.gold,lineHeight:1}}>{primary}</span>
      <div style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",lineHeight:1.5}}>{secondary}<br/>past {window} days</div>
    </div>
  );
}
