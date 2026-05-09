"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  WEEK, STRENGTH_DAY_SESSIONS, SESSIONS,
  EXERCISE_POOLS, rotateAccessories, rotationDiff,
  ROTATION_OPTIONAL, ROTATION_AUTO, ROTATION_FORCED,
  DAY_CONFIG, DAY_NAMES, SWAP_DB, EQ_COLOUR,
  // Retrospective logging helpers (compute past-date programme metadata + missing-day detection)
  sessionMetaForDate, findRecentDays, hasMissedStrength,
} from "@/lib/programme";
import {
  LS, P, PB, H, BW, PN, bumpStreak,
  computeRhythm, detectRecoveryPattern,
  blobPush, flushPendingPushes, getLocalProfile, backgroundSync, SyncStatus,
  enableAutoSync, disableAutoSync,
  checkProfileExists, claimProfile, blobDelete,
  roundPlate, applyRpe, weeksSince, weekKey,
  newDraftLog, logSet, finaliseDraft, scaleForReadiness, D, TS,
  inferLoadType, LOAD_TYPES,
} from "@/lib/storage";
import { T } from "@/lib/tokens";
import {
  computeNextPrescription,
  updateLiftStateFromSession,
  updateMuscleAnchorFromSession,
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
import { getLiftProfile } from "@/lib/lift-translations";
import {
  isWebAuthnSupported, isPlatformAuthenticatorAvailable,
  registerPasskey, authenticatePasskey, hasPasskey,
} from "@/lib/webauthn";
import { track } from "@vercel/analytics";
import { computeVolumeAggregates } from "@/lib/analytics";
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

// ─── ScrollDrum ────────────────────────────────────────────────────────────────
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
  useEffect(()=>{
    if(!ref.current||scrolling.current) return;
    const raf=requestAnimationFrame(()=>{ if(ref.current) ref.current.scrollTop=selectedIdx*ITEM_H; });
    return()=>cancelAnimationFrame(raf);
  },[selectedIdx]);
  const onScroll=useCallback(()=>{
    if(!ref.current) return;
    scrolling.current=true;
    const idx=Math.min(Math.round(ref.current.scrollTop/ITEM_H),values.length-1);
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
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1}}>
      {label&&<div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>{label}</div>}
      <div style={{position:"relative",height:ITEM_H*VISIBLE,width:"100%",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"50%",left:0,right:0,height:ITEM_H,transform:"translateY(-50%)",background:`${T.coral}14`,borderTop:`1px solid ${T.coral}33`,borderBottom:`1px solid ${T.coral}33`,pointerEvents:"none",zIndex:1,borderRadius:T.r.sm}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to bottom,${T.bg2} 30%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to top,${T.bg2} 30%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div ref={ref} onScroll={onScroll} style={{height:"100%",overflowY:"scroll",scrollSnapType:"y mandatory",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",paddingTop:ITEM_H*half,paddingBottom:ITEM_H*half,boxSizing:"content-box"}}>
          <style>{`*::-webkit-scrollbar{display:none}`}</style>
          {values.map((v,i)=>{
            const sel=i===selectedIdx;
            return(
              <div key={i} onClick={()=>onChange(v)} style={{height:ITEM_H,scrollSnapAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                <span style={{fontFamily:T.serif,fontSize:sel?30:20,fontWeight:sel?400:300,color:sel?T.text1:T.text4,transition:`all 140ms ${T.ease}`,userSelect:"none"}}>{fmt(v)}</span>
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

  useEffect(() => SyncStatus.subscribe(setStatus), []);

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
    const diff = Date.now() - ts;
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
  useEffect(()=>setMounted(true),[]);

  const [activeProfile,setActiveProfileState]=useState(()=>typeof window!=="undefined"?P.getActive():null);
  const [showProfiles,setShowProfiles]=useState(false);
  const [streak,setStreak]=useState(0); // retained for compat — now derived from history, see useMemo below
  const [screen,setScreen]=useState(()=>{
    if (typeof window === "undefined") return "home";
    return LS.get("forge:onboarded", false) ? "home" : "onboarding";
  });
  const [activeSessionIdx,setActiveSessionIdx]=useState(0);
  const [sessionSwaps,setSessionSwaps]=useState({});
  const [programmeBlock,setProgrammeBlock]=useState(()=>PB.get());
  const [weekDone,setWeekDone]=useState({});
  const [blockIdx,setBlockIdx]=useState(0);
  const [setNum,setSetNum]=useState(1);
  const [phase,setPhase]=useState("A");
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
  // Shown when auto-rotation fires — acknowledge before starting session
  const [rotationSummary,setRotationSummary]=useState(null);
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

  // Retro discoverability — only surface the "Log past session" link on home
  // when there's actually something to fill. If the user trained every strength
  // day in the last 3, the link stays hidden and home stays calm. Recomputed
  // automatically as history grows.
  const hasRetroGaps = useMemo(() => hasMissedStrength(history, 3), [history]);

  // Seed on profile change: instant load from localStorage, background sync from blob
  useEffect(()=>{
    if(!activeProfile) return;
    
    // INSTANT: Load from localStorage (0ms, works offline)
    const local = getLocalProfile(activeProfile);
    setWWState(local.meta.weights || {});
    setWRState(local.meta.reps || {});
    setStreak(local.meta.streak?.count || 0);
    setProgrammeBlock(local.meta.programmeBlock || PB.get());
    setWeekDone(P.getWeekDone(activeProfile));
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

    // BACKGROUND: Sync from blob, update state if remote has newer data
    const onSyncUpdate = ({ meta, history: remoteHistory }) => {
      // Blob had newer data — update React state silently
      if (meta.weights) setWWState(meta.weights);
      if (meta.reps) setWRState(meta.reps);
      if (meta.streak?.count) setStreak(meta.streak.count);
      if (meta.programmeBlock) setProgrammeBlock(meta.programmeBlock);
      if (remoteHistory?.length) setHistory(remoteHistory);
    };
    
    backgroundSync(activeProfile, { onUpdate: onSyncUpdate });
    
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

    return () => disableAutoSync();
  },[activeProfile]);

  // Rest timer tick
  useEffect(()=>{
    if(!restActive) return;
    if(restRemain<=0){
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

  // Scale session by readiness (cooked = 85% weight on mains, -1 set supersets, no finishers)
  const rawSession = SESSIONS[activeSessionIdx];
  const activeSession = useMemo(
    () => scaleForReadiness(rawSession, readiness),
    [rawSession, readiness]
  );
  const block    = activeSession.blocks[blockIdx];
  const isSS     = block.type==="superset"||block.type==="finisher";
  const swapKey  = isSS ? `${block.id}-${phase}` : block.id;

  // Single source of truth for exercise resolution:
  // manual in-session swap → rotation config → programme default
  const resolveExFn = useCallback((blockId, ph, defaultEx) => {
    const key = ph ? `${blockId}-${ph}` : blockId;
    return sessionSwaps[key] ?? programmeBlock.config[key] ?? defaultEx;
  }, [sessionSwaps, programmeBlock]);

  // Pre-resolve both sides of the current block so SessionScreen
  // never needs to touch block.exA/exB directly
  const resolvedExA = isSS ? resolveExFn(block.id, "A", block.exA) : null;
  const resolvedExB = isSS ? resolveExFn(block.id, "B", block.exB) : null;
  const resolvedEx  = !isSS ? resolveExFn(block.id, null, block.ex) : null;
  const activeEx    = isSS ? (phase==="A" ? resolvedExA : resolvedExB) : resolvedEx;

  const getW=useCallback((ex)=>ex?(workingWeights[ex.name]??ex.weight):null,[workingWeights]);
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
    logSet(draftLogRef.current, {
      blockId: block.id,
      blockType: block.type,
      exerciseName: ex.name,
      muscle: ex.muscle,
      swapped,
      fromPool,
      loadType,
      bodyweight: bodyweight,
      weight: workingWeights[ex.name] ?? ex.weight,
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

  const reset=()=>{
    setBlockIdx(0);setSetNum(1);setPhase("A");setReadiness(null);setReadinessReason(null);
    setAwaitRpe(false);setSsRoundDone(false);
    setRestActive(false);setRestRemain(180);setRestTrigger(null);
    setSessionSwaps({});
    draftLogRef.current = null;
    // If the user explicitly quits, the pending-draft card should go too.
    D.clear(activeProfile);
    setPendingDraft(null);
    setScreen("home");
  };

  useEffect(()=>{
    if(screen==="done"&&activeProfile){
      const newStreak=bumpStreak(activeProfile);
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
        // Reflect in React state so Performance Lab updates immediately
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
              const liftState = trainingState.lifts?.[ex.name] || null;
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

  // Mark a non-strength day complete (zone 2, cardio, HIIT, rest)
  const handleMarkDayDone = useCallback(()=>{
    if(!activeProfile) return;
    const dw=new Date().getDay();
    const wm=[6,0,1,2,3,4,5];
    const idx=wm[dw];
    const updated=P.markDayDone(activeProfile,idx);
    setWeekDone(updated);
    const newStreak=bumpStreak(activeProfile);
    setStreak(newStreak);
  },[activeProfile]);

  if(!mounted) return null;

  // Onboarding — first-time intro, shown before ProfileScreen
  if(screen==="onboarding"){
    return <OnboardingScreen onContinue={()=>{
      LS.set("forge:onboarded", true);
      setScreen("home");
    }}/>;
  }

  if(!activeProfile||showProfiles){
  return <ProfileScreen existing={P.list()} current={activeProfile} onActivate={activateProfile} onCancel={showProfiles?()=>setShowProfiles(false):null} bodyweight={bodyweight} bwEditOpen={bwEditOpen} setBwEditOpen={setBwEditOpen} updateBodyweight={updateBodyweight}/>;
  }

const sProps={
  session:activeSession,
  block,blockIdx,totalBlocks:activeSession.blocks.length,setNum,phase,isSS,
  activeEx, resolvedExA, resolvedExB, resolvedEx,
  swapKey,onSwap,
  showVid,setShowVid,getW,getR,editTarget,setEditTarget,
  workingWeights,setWW,workingReps,setWR,
  awaitRpe,ssRoundDone,
  restActive,restRemain,setRestActive,setRestRemain,
  onCommit:commitLog,onLog:handleLog,onQuit:reset,
  bodyweight,
  // Phase 3 — when active, SessionScreen renders "deload · day N of M" subtitle below prescribed weight.
  deloadDayTag: activeDeload ? deloadDayLabel(activeDeload) : null,
  };

  // Derive today's session index for HomeScreen
  const dow      = new Date().getDay();
  const weekMap  = [6,0,1,2,3,4,5];
  const todayIdx = weekMap[dow];
  const todaySessionIdx = STRENGTH_DAY_SESSIONS[todayIdx] ?? 0;

  // Actually rotate. Returns the new block so we can compute the diff.
  const rotate = (showSummary = false) => {
    const oldConfig = programmeBlock.config;
    const history = {};
    Object.entries(oldConfig).forEach(([k,ex])=>{ history[k]=ex.name; });
    const newConfig = rotateAccessories(history);
    const next = {
      number: programmeBlock.number + 1,
      startDate: new Date().toISOString().slice(0,10),
      config: newConfig,
      history,
    };
    setProgrammeBlock(next);
    PB.save(next);
    if (showSummary) {
      const changes = rotationDiff(oldConfig, newConfig);
      setRotationSummary({ blockNumber: next.number, changes });
    }
    return next;
  };

  const handleRotate = () => rotate(true);

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
    const meta = sessionMetaForDate(retroDate);
    if (!meta || meta.type !== "strength") return;

    const sessionDef = SESSIONS[meta.sessionIdx];
    if (!sessionDef) return;

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
            const liftState     = trainingState.lifts?.[ex.name] || null;
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

  return (
    <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased"}}>
      {screen==="home"        && <HomeScreen rhythm={rhythm} profileName={activeProfile} onBegin={beginSession} onProfile={()=>setShowProfiles(true)} weekDone={weekDone} onMarkDayDone={handleMarkDayDone} programmeBlock={programmeBlock} weeksOnBlock={weeksOnBlock} onRotate={handleRotate} onPerformance={()=>setScreen("performance")} historyCount={history.length} recoveryNudge={recoveryNudge} onDismissRecovery={()=>setRecoveryDismissed(true)} syncState={syncState} pendingDraft={pendingDraft} onResumeDraft={handleResumeDraft} onDiscardDraft={handleDiscardDraft} showBwCard={bwIsStale && !bwCardDismissed} onOpenBwEdit={()=>setBwEditOpen(true)} onDismissBwCard={()=>setBwCardDismissed(true)} deloadOffer={deloadOffer} onAcceptDeload={handleAcceptDeload} onDismissDeload={handleDismissDeload} hasRetroGaps={hasRetroGaps} onOpenRetroPicker={handleOpenRetroPicker} retroToast={retroToast} onDismissRetroToast={()=>setRetroToast(null)} pnStage={pnStage} pnBusy={pnBusy} pnError={pnError} pnSuccessToast={pnSuccessToast} onPnRegister={handleRegisterPasskeyFromHome} onPnSnooze={handleSnoozeNudge} onPnDismissToast={()=>setPnSuccessToast(false)}/>}
      {screen==="readiness"   && <ReadinessScreen readiness={readiness} setReadiness={setReadiness} reason={readinessReason} setReason={setReadinessReason} onStart={handleReadinessStart}/>}
      {screen==="session"     && <ErrorBoundary><SessionScreen {...sProps}/></ErrorBoundary>}
      {screen==="done"        && <ErrorBoundary><DoneScreen session={activeSession} profileName={activeProfile} workingWeights={workingWeights} onHome={()=>{ setShowDeloadComplete(false); reset(); }} deloadCompleted={showDeloadComplete}/></ErrorBoundary>}
      {screen==="performance" && <ErrorBoundary><PerformanceLab history={history} onBack={()=>setScreen("home")}/></ErrorBoundary>}
      {screen==="retro"       && retroDate && <ErrorBoundary><RetrospectiveSessionSheet date={retroDate} bodyweight={bodyweight} workingWeights={workingWeights} workingReps={workingReps} onCancel={handleCancelRetro} onSubmit={handleSubmitRetro}/></ErrorBoundary>}
      {retroPickerOpen        && <RetroPickerSheet history={history} pendingDraft={pendingDraft} onPick={handlePickRetroDate} onClose={()=>setRetroPickerOpen(false)}/>}
      {rotationSummary        && <RotationSummaryModal summary={rotationSummary} onContinue={handleRotationContinue}/>}
      {showIosInstall         && <IosInstallOverlay onDismiss={()=>{ LS.set("forge:iosInstallDismissed", true); setShowIosInstall(false); }}/>}
      <BodyweightEditModal open={bwEditOpen} onClose={()=>setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight}/>
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
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.coral}33`,animation:`slideUp 260ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box",position:"relative"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:14,right:14,background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,width:30,height:30,cursor:"pointer",color:T.text2,fontSize:13,padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingRight:40}}>
          Is this you?
        </div>
        <div style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.2,marginBottom:12}}>
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
      display: "flex", flexDirection: "column",
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

      {/* The three promises — feel like editorial callouts rather than feature bullets */}
      <Fade d={200}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 32 }}>
          <PromiseLine
            accent={T.coral}
            kicker="Strength"
            body="Three sessions a week. Squat, hinge, push, pull. Your weights adapt to how you felt last time."
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

      <div style={{ flex: 1 }}/>

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
function ProfileScreen({existing,current,onActivate,onCancel,bodyweight=null,bwEditOpen=false,setBwEditOpen,updateBodyweight}){
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
function HomeScreen({rhythm,profileName,onBegin,onProfile,weekDone={},onMarkDayDone,programmeBlock,weeksOnBlock,onRotate,onPerformance,historyCount=0,recoveryNudge=null,onDismissRecovery,syncState="idle",pendingDraft=null,onResumeDraft,onDiscardDraft,showBwCard=false,onOpenBwEdit,onDismissBwCard,deloadOffer=null,onAcceptDeload,onDismissDeload,hasRetroGaps=false,onOpenRetroPicker,retroToast=null,onDismissRetroToast,pnStage="hidden",pnBusy=false,pnError=null,pnSuccessToast=false,onPnRegister,onPnSnooze,onPnDismissToast}){
  const dow      = new Date().getDay(); // 0=Sun
  const weekMap  = [6,0,1,2,3,4,5];    // JS day → WEEK index (Mon=0 … Sun=6)
  const todayIdx = weekMap[dow];

  const [viewIdx, setViewIdx] = useState(todayIdx);

  const viewDay        = WEEK[viewIdx];
  const cfg            = DAY_CONFIG[viewDay.type] || DAY_CONFIG.rest;
  const accent         = T[viewDay.type] || T.rest;
  const isViewingToday = viewIdx === todayIdx;

  // Resolve which session to preview for the viewed day (null for non-strength days)
  const viewSessionIdx = STRENGTH_DAY_SESSIONS[viewIdx];
  const viewSession    = viewSessionIdx !== undefined ? SESSIONS[viewSessionIdx] : null;

  // Dynamic headline/sub for strength days
  const headline2 = viewSession ? viewSession.subtitle : cfg.headline[1];
  const subText   = viewSession ? viewSession.subtitle : cfg.sub;

  // Negative diff = earlier this week, positive = later this week
  const diffDays = viewIdx - todayIdx;

  const dayLabel = diffDays === 0
    ? "Today"
    : diffDays === 1
    ? "Tomorrow"
    : diffDays === -1
    ? "Yesterday"
    : DAY_NAMES[viewIdx];

  // Actual date of the viewed day
  const viewDate = new Date(Date.now() + diffDays * 86400000);

  return (
    <div style={{minHeight:"100vh",paddingBottom:48,position:"relative",overflow:"hidden"}}>
      {/* Ambient glow — colour transitions with the viewed day */}
      <div style={{
        position:"absolute",top:-180,left:"50%",transform:"translateX(-50%)",
        width:600,height:500,
        background:`radial-gradient(ellipse,${accent.glow} 0%,transparent 65%)`,
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
          {WEEK.map((d,i)=>{
            const a       = T[d.type];
            const isToday = i === todayIdx;
            const isView  = i === viewIdx;
            const isDone  = weekDone[i];
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
              <span style={{color:accent.main,fontStyle:"italic",transition:`color 300ms ${T.ease}`}}>
                {headline2}
              </span>
            )}
          </div>
          <div style={{fontSize:14,color:T.text2,marginTop:10,lineHeight:1.5}}>
            {viewSession ? viewSession.subtitle : cfg.sub}
          </div>
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
            <button onClick={onMarkDayDone} style={{
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

      {/* Retrospective logging link — only surfaces when there's a missed
          strength day in the last 3. Calm by design: no card, no chrome,
          just an inline link tinted sage so it reads as a non-action utility
          rather than competing with the day's "begin session" CTA. */}
      {hasRetroGaps && !pendingDraft && onOpenRetroPicker && (
        <Fade d={190}>
          <div style={{margin:"18px 24px 0",display:"flex",justifyContent:"center"}}>
            <button onClick={onOpenRetroPicker}
              style={{background:"none",border:"none",padding:"6px 4px",cursor:"pointer",fontFamily:T.sans,fontSize:13,color:T.sage,letterSpacing:"0.01em"}}>
              Missed a session? <span style={{fontStyle:"italic",fontFamily:T.serif,marginLeft:2}}>Log it</span> →
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
                  Your body has adapted. New exercises, same muscle targets.
                </div>
              </div>
              <button onClick={onRotate} style={{flexShrink:0,marginTop:2,padding:"10px 16px",background:T.gold,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0}}>
                Rotate →
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

// ─── RPE Card ──────────────────────────────────────────────────────────────────
function RpeCard({onPick,label="How was that set?"}){
  const opts=[
    {id:"easy", icon:"😮‍💨",label:"Easy", sub:"More in the tank",color:T.sage},
    {id:"hard", icon:"😤", label:"Hard", sub:"Close to limit",   color:T.gold},
    {id:"limit",icon:"🔥", label:"Limit",sub:"Max effort",       color:T.rose},
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

// ─── Session ──────────────────────────────────────────────────────────────────
function SessionScreen({session,block,blockIdx,totalBlocks,setNum,phase,isSS,activeEx,resolvedExA,resolvedExB,resolvedEx,swapKey,onSwap,showVid,setShowVid,getW,getR,editTarget,setEditTarget,workingWeights,setWW,workingReps,setWR,awaitRpe,ssRoundDone,restActive,restRemain,setRestActive,setRestRemain,onCommit,onLog,onQuit,bodyweight,deloadDayTag=null}){
  const {strength:s}=T;
  const [swapEx,setSwapEx]=useState(null);
  const partnerEx=isSS?(phase==="A"?resolvedExB:resolvedExA):null;
  const vidEx    =isSS?(phase==="A"?resolvedExA:resolvedExB):resolvedEx;
  const progress =((blockIdx+(setNum-1)/block.sets)/totalBlocks)*100;
  const nameFz   =Math.min(38,Math.max(24,300/(activeEx?.name?.length||10)));
  const typeLabel={main:"Main lift",superset:"Superset",finisher:"Finisher"}[block.type];
  const currentW =getW(activeEx);
  const showRestHint=!isSS;
  const restMins =Math.floor(restRemain/60),restSecs=restRemain%60;
  const restStr  =`${restMins}:${String(restSecs).padStart(2,"0")}`;
  const blocking =awaitRpe||ssRoundDone;
  
  // Load type handling for bodyweight movements
  const loadType = getLoadType(activeEx);
  const showWeightPicker = loadType !== "bodyweight";
  const weightLabel = loadType === "loaded_bodyweight" ? "+ kg"
                    : loadType === "assisted_bodyweight" ? "− kg"
                    : "kg";
  const loadTypeSubtitle = loadType === "bodyweight" ? "Bodyweight"
                         : loadType === "loaded_bodyweight" ? "Added load"
                         : loadType === "assisted_bodyweight" ? "Band assist"
                         : null;

  return (
    <div style={{minHeight:"100vh",position:"relative",overflow:"hidden",paddingBottom:40}}>
      <div style={{position:"absolute",top:-80,right:-80,width:340,height:320,background:`radial-gradient(circle,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      <div style={{height:1,background:T.bg3}}>
        <div style={{height:"100%",width:`${progress}%`,background:T.coral,transition:`width 600ms ${T.ease}`}}/>
      </div>
      <div style={{padding:"16px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <button onClick={onQuit} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans}}>← Quit</button>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.1em",textTransform:"uppercase"}}>{session.name}</div>
          <div style={{fontSize:10,color:T.text3,fontStyle:"italic",fontFamily:T.serif,marginTop:1}}>{block.label}</div>
        </div>
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
        </div>
        {showWeightPicker && currentW!==null&&(
          <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:4,cursor:"pointer",userSelect:"none"}} onClick={()=>{ if(activeEx?.name) setEditTarget({exName:activeEx.name,currentKg:currentW,currentReps:getR(activeEx),loadType}); }}>
            <span style={{fontFamily:T.serif,fontSize:80,fontWeight:300,color:T.text1,lineHeight:1,letterSpacing:"-0.02em"}}>{currentW}</span>
            <span style={{fontFamily:T.serif,fontSize:22,fontWeight:300,color:T.text3,marginBottom:8}}>{weightLabel}</span>
            <span style={{fontSize:11,color:T.text3,marginBottom:10,marginLeft:4}}>↕</span>
          </div>
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
            <div style={{padding:"12px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontSize:12,color:restActive?T.coral:T.text4,fontStyle:"italic",fontFamily:T.serif,transition:`color 300ms ${T.ease}`}}>
                {restActive?`Resting — ${restStr}`:`~${Math.round(block.rest/60)} min rest`}
              </span>
              <button onClick={()=>{if(restActive){setRestActive(false);setRestRemain(block.rest);}else{setRestRemain(block.rest);setRestActive(true);}}}
                style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,padding:"4px 10px",cursor:"pointer",fontSize:11,color:restActive?T.coral:T.text3,transition:`all 180ms ${T.ease}`}}>
                {restActive?"Skip":"Start timer"}
              </button>
            </div>
          )}
          {isSS&&phase==="A"&&(
            restActive
              ?(
                <div style={{padding:"12px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:12,color:T.coral,fontStyle:"italic",fontFamily:T.serif}}>Resting — {restStr}</span>
                  <button onClick={()=>{setRestActive(false);setRestRemain(block.rest);}} style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,padding:"4px 10px",cursor:"pointer",fontSize:11,color:T.coral}}>Skip</button>
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
        {vid&&(
          <a href={`https://www.youtube.com/watch?v=${vid}`} target="_blank" rel="noopener noreferrer"
            style={{fontSize:12,color:T.coral,fontWeight:500,textDecoration:"none"}}>
            Watch on YouTube ↗
          </a>
        )}
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
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px 36px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
          <div>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>Swap exercise</div>
            <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text2,fontStyle:"italic"}}>{activeEx?.name}</div>
          </div>
          <button onClick={onClose} style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
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
function RotationSummaryModal({summary,onContinue}){
  const {gold}=T;
  const count = summary.changes.length;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.94)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${gold}44`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
        <div style={{fontSize:10,fontWeight:500,color:gold,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          New block · {summary.blockNumber}
        </div>
        <div style={{fontFamily:T.serif,fontSize:30,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
          Your programme<br/><span style={{color:gold,fontStyle:"italic"}}>has rotated.</span>
        </div>
        <p style={{fontSize:13,color:T.text2,marginBottom:20,lineHeight:1.6}}>
          {count} {count===1?"accessory":"accessories"} swapped to keep the stimulus fresh. Main lifts stay the same — progressive overload continues.
        </p>
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
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div><div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{target.exName}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:4}}>Scroll to adjust</div></div>
          <button onClick={onClose} style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
        </div>
        <div style={{display:"flex",gap:16,justifyContent:hasWeight?"space-between":"center"}}>
          {hasWeight&&<ScrollDrum value={kg} onChange={setKg} step={1.25} min={0} max={400} label="kg"/>}
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
function RetroPickerSheet({history, pendingDraft, onPick, onClose}){
  const rows = useMemo(() => findRecentDays(history, 3), [history]);
  const draftBlocks = !!pendingDraft;

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.sage}28`,animation:`slideUp 260ms ${T.ease}`}}>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
          <div>
            <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>Recent days</div>
            <div style={{fontSize:12,color:T.text3,marginTop:4,lineHeight:1.5}}>
              {draftBlocks ? "Finish your live session first" : "Tap a missed strength day to log it"}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13,flexShrink:0}}>✕</button>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {rows.map((row) => {
            const isStrength    = row.type === "strength";
            const tappable      = isStrength && !row.logged && !draftBlocks;
            const accentColor   = isStrength ? (row.logged ? T.text4 : T.coral) : T.text4;
            const opacity       = draftBlocks ? 0.4 : (row.logged || !isStrength ? 0.55 : 1);

            return (
              <div key={row.date}
                onClick={tappable ? () => onPick(row.date) : undefined}
                style={{
                  padding:"14px 16px",
                  background: tappable ? `${T.coral}0A` : T.bg3,
                  border: `1px solid ${tappable ? T.coral+"33" : T.bg4}`,
                  borderRadius: T.r.md,
                  cursor: tappable ? "pointer" : "default",
                  display:"flex",alignItems:"center",justifyContent:"space-between",
                  opacity,
                  transition: `all 180ms ${T.ease}`,
                }}>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <div style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text1,lineHeight:1.2}}>
                    {row.dateLabel}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{display:"inline-block",width:5,height:5,borderRadius:"50%",background:accentColor}}/>
                    <span style={{fontSize:11,color:T.text3,letterSpacing:"0.04em"}}>
                      {row.sessionName}
                      {row.logged && " · logged"}
                    </span>
                  </div>
                </div>
                {tappable && <span style={{fontSize:18,color:T.coral}}>→</span>}
                {!isStrength && <span style={{fontSize:10,color:T.text4,fontStyle:"italic",fontFamily:T.serif}}>{row.type === "rest" ? "rest" : "non-strength"}</span>}
                {row.logged && <span style={{fontSize:11,color:T.sage,fontWeight:500,letterSpacing:"0.06em",textTransform:"uppercase"}}>✓</span>}
              </div>
            );
          })}
        </div>

        <div style={{marginTop:16,fontSize:11,color:T.text4,fontStyle:"italic",fontFamily:T.serif,textAlign:"center",lineHeight:1.5}}>
          Only the last 3 days. Anything older is archaeology.
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
function RetrospectiveSessionSheet({date, bodyweight, workingWeights, workingReps, onCancel, onSubmit}){
  const meta = useMemo(() => sessionMetaForDate(date), [date]);
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
    const baseWeight = workingWeights[ex.name] ?? ex.weight ?? null;
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
                  step={isWeight ? 1.25 : 1}
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

  // Update local state when modal opens with new value
  useEffect(()=>{
    if(open) setKg(currentKg || 75);
  },[open, currentKg]);

  if(!open) return null;

  // First-time entry vs update — first time gets a one-line context, updates
  // get the tighter "Scroll to adjust" subtitle that mirrors DrumEditOverlay.
  // Same editorial family, different density to match the moment.
  const isFirstTime = currentKg === null || currentKg === undefined;

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.sage}28`,animation:`slideUp 260ms ${T.ease}`}}>

        {/* Header — tightened to match DrumEditOverlay pattern. ✕ close
            sits top-right rather than a separate Cancel button at the bottom. */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div>
            <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>Bodyweight</div>
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

function DoneScreen({session,profileName,workingWeights,onHome,deloadCompleted=false}){
  const nudges = session.blocks.filter(b=>b.type==="main").map(b=>{
    const base    = b.ex.weight;
    const current = workingWeights[b.ex.name] ?? base;
    return { ex:b.ex.name, base, current, changed:current!==base };
  });

  // Pick a random headline pair, stable for this render
  const [hi] = useState(()=>DONE_HEADLINES[Math.floor(Math.random()*DONE_HEADLINES.length)]);

  // Derive what's next
  const dow     = new Date().getDay();
  const weekMap = [6,0,1,2,3,4,5];
  const todayIdx= weekMap[dow];
  const nextIdx = (todayIdx+1) % 7;
  const nextType= WEEK[nextIdx]?.type ?? "rest";
  const nextMsg = NEXT_DAY_MSG[nextType] ?? "";

  // Sync status for confirmation line
  const [syncState, setSyncState] = useState(SyncStatus.get());
  useEffect(() => SyncStatus.subscribe(setSyncState), []);

  return (
    <div style={{minHeight:"100vh",padding:"72px 24px 0",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-120,left:"50%",transform:"translateX(-50%)",width:420,height:380,background:`radial-gradient(circle,${T.strength.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
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
  return (
    <div
      onClick={onDismiss}
      style={{
        position:"fixed",inset:0,background:"rgba(10,9,8,0.90)",zIndex:500,
        display:"flex",alignItems:"flex-end",justifyContent:"center",
        animation:`fadeIn 220ms ${T.ease}`,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background:T.bg2,
          borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,
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
        <div style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.2,marginBottom:10}}>
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
  // If someone's going above the expected 3x/week, show "12+" rather than capping
  const over = completed > expected;
  const primary = over ? `${expected}+` : `${completed}`;
  const secondary = over ? "of 12 · strong" : `of ${expected}`;
  return (
    <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.pill,padding:"8px 16px",display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontFamily:T.serif,fontSize:22,fontWeight:400,color:T.gold,lineHeight:1}}>{primary}</span>
      <div style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",lineHeight:1.5}}>{secondary}<br/>this month</div>
    </div>
  );
}
