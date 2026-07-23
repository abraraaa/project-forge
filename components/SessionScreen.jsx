"use client";

// components/SessionScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The strength-session flow, extracted verbatim from ForgeApp.jsx (PR3
// 3e-prep): ReadinessScreen → SessionScreen → DoneScreen, plus the
// session-only satellites (SessionOverviewSheet, RecentHistorySheet, RpeCard,
// RestProgressLine, VideoEmbed, SwapOverlay, DrumEditOverlay). All state and
// mutations stay in ForgeApp and arrive via props — this module renders the
// flow, it does not own it. That boundary is what the upcoming /session
// route will move, one concern at a time.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo } from "react";
import { T } from "@/lib/tokens";
import { Fade, Card, Tag } from "@/components/ui";
import { useModalA11y, haptic } from "@/lib/a11y";
import ScrollDrum from "@/components/ScrollDrum";
import { WEEK, SWAP_DB, EQ_COLOUR } from "@/lib/programme";
import { SyncStatus } from "@/lib/storage";
import { recentForExercise } from "@/lib/analytics";
import { getLoadType, swapLoadType, weightStepForLoadType, parseTimedReps, WEIGHT_CAPTIONS } from "@/lib/lift-translations";
import { getTempo, decodeTempo } from "@/lib/exercise-tempo";

// ─── Session overview sheet ──────────────────────────────────────────────────
// Mid-session escape hatch: list every block in today's session, show which
// is current / done / not started, and let the user jump to any of them.
// Useful when a busy gym means the prescribed order isn't practical — pick
// up the bench you can get to first, come back to squats when the rack frees.
// Auto-flow is unchanged for users who don't open this surface.
export function SessionOverviewSheet({ session, currentBlockIdx, draftLog, onJumpToBlock, onCancel }) {
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
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground" style={{background:T.bg2,padding:"28px 24px 32px",width:"100%",borderTop:`1px solid ${T.bg3}`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"90vh",display:"flex",flexDirection:"column",outline:"none"}}>
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

// Level dots — the text glyphs (U+25CB/25D0/25CF) render at different sizes
// per font, so readiness/effort dots are DRAWN: same box, three fills.
function LevelDot({fill,color,size=15}){
  return <span aria-hidden="true" style={{width:size,height:size,borderRadius:"50%",display:"inline-block",flexShrink:0,boxSizing:"border-box",border:`2px solid ${color}`,background:fill==="full"?color:fill==="half"?`linear-gradient(90deg, ${color} 50%, transparent 50%)`:"transparent"}}/>;
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
    const diff = Math.floor((today.getTime() - d.getTime()) / 86400000);
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
      className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground" style={{background:T.bg2,padding:"28px 24px 32px",width:"100%",borderTop:`1px solid ${T.bg3}`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
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

export function ReadinessScreen({readiness,setReadiness,reason,setReason,onStart}){
  const opts=[
    {id:"fresh", fill:"none",label:"Fresh", sub:"Full programme. The good kind of heavy.", color:T.sage},
    {id:"normal",fill:"half",label:"Normal",sub:"The work, as written.",              color:T.gold},
    {id:"cooked",fill:"full",label:"Cooked",sub:"Deload weights · trimmed volume.",   color:T.rose},
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
    <div style={{maxWidth:430,margin:"0 auto",padding:"72px 24px 0"}}>
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:34,fontWeight:300,lineHeight:1.2,marginBottom:8}}>
          How are you<br/><span style={{fontStyle:"italic",color:T.coral}}>feeling today?</span>
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:40,lineHeight:1.6}}>We'll shape the session around you.</p>
      </Fade>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {opts.map((o,i)=>(
          <Fade key={o.id} d={80+i*50}>
            <div className="forge-press" onClick={()=>{ haptic.toggle(); setReadiness(o.id); if (o.id !== "cooked") setReason(null); }} style={{padding:"18px 20px",borderRadius:T.r.lg,cursor:"pointer",background:readiness===o.id?`${o.color}12`:T.bg2,border:`1px solid ${readiness===o.id?o.color+"55":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 200ms ${T.ease}`}}>
              <div style={{display:"flex",alignItems:"center",gap:16}}>
                <LevelDot fill={o.fill} color={o.color} size={16}/>
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
                  <div key={r.id} className="forge-press" onClick={()=>{haptic.toggle();setReason(sel ? null : r.id);}}
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
        <button className={readiness?"forge-press":undefined} onClick={readiness?onStart:undefined} style={{marginTop:28,width:"100%",padding:"18px 24px",background:readiness?T.coral:T.bg2,border:`1px solid ${readiness?T.coral:T.bg3}`,borderRadius:T.r.lg,cursor:readiness?"pointer":"default",fontFamily:T.serif,fontSize:20,fontWeight:400,color:readiness?T.bg0:T.text4,transition:`all 220ms ${T.ease}`,boxShadow:readiness?`0 12px 40px ${T.strength.glow}`:"none"}}>
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
function RpeCard({onPick,label="How did that one move?"}){
  const opts=[
    {id:"easy",  fill:"none", label:"Easy",  sub:"More in the tank",color:T.sage},
    {id:"normal",fill:"half", label:"Normal",sub:"Working effort",   color:T.gold},
    {id:"cooked",fill:"full", label:"Cooked",sub:"Nothing left",     color:T.rose},
  ];
  return (
    <div style={{margin:"14px 20px 0",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,padding:"16px 18px",animation:`fadeSlide 240ms ${T.ease}`}}>
      <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>{label}</div>
      <div style={{display:"flex",gap:8}}>
        {opts.map(o=>(
          <div key={o.id} className="forge-press" onClick={()=>onPick(o.id)} style={{flex:1,padding:"12px 6px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.md,cursor:"pointer",textAlign:"center",transition:`all 180ms ${T.ease}`}}>
            <div style={{marginBottom:6,display:"flex",justifyContent:"center"}}><LevelDot fill={o.fill} color={o.color}/></div>
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
export function SessionScreen({session,block,blockIdx,totalBlocks,setNum,phase,isSS,activeEx,resolvedExA,resolvedExB,resolvedEx,swapKey,onSwap,showVid,setShowVid,getW,getR,editTarget,setEditTarget,workingWeights,setWW,workingReps,setWR,history=[],awaitRpe,ssRoundDone,restActive,restRemain,setRestActive,setRestRemain,onCommit,onLog,onQuit,onShowOverview,bodyweight,deloadDayTag=null}){
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
  // Tempo discovery — a quiet chip beside the muscle tag, expanding to the
  // decoded prescription. Data from lib/exercise-tempo.js (sourced +
  // reviewed, honestly labelled); only renders where a rep tempo exists
  // (isometric holds already show "Xs · hold" and need no second voice).
  const [tempoOpen,setTempoOpen]=useState(false);
  const tempoEntry=useMemo(()=>getTempo(activeEx?.name),[activeEx?.name]);
  // Collapse the explainer when the exercise changes — render-time reset
  // (the documented adjust-state-on-prop-change pattern), not an effect.
  const [tempoFor,setTempoFor]=useState(activeEx?.name);
  if(tempoFor!==activeEx?.name){ setTempoFor(activeEx?.name); setTempoOpen(false); }
  const tempoPhrase=tempoEntry?.tempo
    ? decodeTempo(tempoEntry.tempo).filter(seg=>seg.n!=="0").map(seg=>seg.n==="X"?seg.label:`${seg.n}s ${seg.label}`).join(" · ")
    : null;
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
    /* Three-zone column: identity (top, natural height) — numbers (upper-
       middle) — actions (pinned to the thumb, bottom). Same type scale as
       before; only the space is redistributed.

       Height: .forge-fill — the shell (.forge-page, globals.css) owns all
       viewport and safe-area accounting; this screen only declares the
       fill shape. The previous calc(100dvh − inset) lived here because the
       screen was doing the shell's maths itself and got it wrong once
       already (Log button below the fold, 2026-07-09). Short viewports
       (split-screen, flip covers) degrade to scroll via the fill class's
       no-shrink basis. The bottom padding is home-indicator CLEARANCE for
       the pinned actions, not height maths. */
    /* overflowX clip: the key light overhangs the right edge (right:-60,
       house pattern, same as Home's rims) and must not cause sideways
       scroll. Vertically nothing overflows any more — the glow lives
       fully inside the frame (see the seamless-frame note below). */
    <div className="forge-fill" style={{maxWidth:430,margin:"0 auto",position:"relative",overflowX:"clip",display:"flex",flexDirection:"column",paddingBottom:"calc(24px + env(safe-area-inset-bottom,0px))",width:"100%"}}>
      {/* Seamless frame v2 (boss redirect, 2026-07-24): same rule Home's
          rim glows learned — a glow box that crosses a container edge gets
          cut mid-gradient and reads as a hard line against the chrome zone.
          So the key light lives INSIDE the frame: transparent by 65% with
          the default farthest-corner sizing, the gradient self-extinguishes
          before the box's edge midpoints, and the page's top/bottom margins
          are pure #1D1A19 by construction — which is exactly what Safari's
          split, the PWA status-bar extension, and iOS 26's scroll-edge
          plate all sample and paint. No collar overlays (v1's collars made
          their own remnant edge up top and washed the footer CTA's glow). */}
      <div style={{position:"absolute",top:16,right:-60,width:340,height:380,background:`radial-gradient(ellipse,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      {/* Progress: inset + rounded (the old full-bleed 1px track read as a
          hard line across every mode's frame — the boss's 'fine line'). */}
      <div style={{margin:"10px 20px 0",height:3,borderRadius:2,background:`${T.bg3}55`,overflow:"hidden",position:"relative"}}>
        <div style={{height:"100%",width:`${progress}%`,borderRadius:2,background:T.coral,transition:`width 600ms ${T.ease}`}}/>
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
              {tempoEntry?.tempo && (
                <button
                  onClick={(e)=>{e.stopPropagation();setTempoOpen(o=>!o);}}
                  aria-expanded={tempoOpen}
                  aria-label={`Tempo ${tempoEntry.tempo} — tap to ${tempoOpen?"hide":"explain"}`}
                  style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:11,color:tempoOpen?T.gold:T.text3,fontFamily:T.sans,fontVariantNumeric:"tabular-nums",letterSpacing:"0.08em",transition:`color 180ms ${T.ease}`}}
                >
                  ◔ {tempoEntry.tempo}
                </button>
              )}
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
        {tempoEntry?.tempo && tempoOpen && (
          <Fade>
            <div style={{marginTop:12,padding:"12px 14px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.md}}>
              <div style={{fontSize:12,fontWeight:500,color:T.text1,letterSpacing:"0.02em"}}>{tempoPhrase}</div>
              <div style={{fontSize:12,color:T.text3,fontStyle:"italic",fontFamily:T.serif,marginTop:6,lineHeight:1.5}}>{tempoEntry.principle}</div>
            </div>
          </Fade>
        )}
      </div>
      {/* Capped spacer — numbers hold the upper-middle rather than drifting
          to dead-centre on tall screens; the uncapped spacer below absorbs
          the rest and does the thumb-pinning. */}
      <div style={{flex:1,minHeight:16,maxHeight:96}}/>
      <div style={{padding:"0 20px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase"}}>Set {setNum} of {block.sets}</div>
          {loadTypeSubtitle && (
            <span style={{fontSize:10,color:T.sage,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>{loadTypeSubtitle}</span>
          )}
          {recent.length > 0 && (
            <button onClick={()=>setHistoryOpen(true)}
              aria-label={`Recent history for ${activeEx?.name}`}
              style={{marginLeft:"auto",padding:"3px 8px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,cursor:"pointer",fontSize:10,color:T.text3,fontFamily:T.sans,letterSpacing:"0.06em",textTransform:"uppercase"}}>
              Recent →
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
      <div style={{flex:1,minHeight:16}}/>
      {/* RPE pick = the set-confirm moment. haptic.commit on submission gives
          it weight — same gesture that ends every set on every platform. */}
      {awaitRpe&&<RpeCard onPick={(r)=>{haptic.commit();onCommit(r);}}/>}
      {ssRoundDone&&<RpeCard onPick={(r)=>{haptic.commit();onCommit(r);}} label={`Round ${setNum} of ${block.sets} — rate the effort`}/>}
      {!blocking&&(
        <>
          {showRestHint&&(
            <div style={{padding:"12px 20px 0"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontSize:12,color:restActive?T.coral:T.text4,fontStyle:"italic",fontFamily:T.serif,transition:`color 300ms ${T.ease}`}}>
                  {restActive?`Resting — ${restStr}`:`~${Math.round(block.rest/60)} min. Catch your breath.`}
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
          {/* Superset awareness reads BEFORE the action it explains — the
              partner card sits above Log, and Log stays last, closest to
              the thumb. */}
          {isSS&&(
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
          <button className="forge-press" onClick={()=>{haptic.tap();onLog();}} style={{margin:"12px 20px 0",width:"calc(100% - 40px)",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",boxShadow:`0 8px 28px ${s.glow}`}}>
            <span style={{fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0}}>
              {isSS?(phase==="A"?"Log A — into B":"Log B — round done"):"Log set"}
            </span>
            <span style={{fontSize:18,color:T.bg0}}>+</span>
          </button>
        </>
      )}
      {editTarget&&<DrumEditOverlay target={editTarget} workingWeights={workingWeights} setWW={setWW} workingReps={workingReps} setWR={setWR} block={block} onClose={()=>setEditTarget(null)}/>}
      {swapEx&&<SwapOverlay activeEx={activeEx} swapKey={swapKey} onSwap={onSwap} onClose={()=>setSwapEx(null)}/>}
      {showVid&&vidEx&&(
        <div onClick={()=>setShowVid(false)} className="forge-scrim forge-scrim-video" style={{overscrollBehavior:"contain",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} className="forge-sheet-ground" style={{background:T.bg2,padding:24,width:"100%",borderTop:`1px solid ${T.coral}33`,animation:`slideUp 280ms ${T.ease}`}}>
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
          {vid?"Watch on YouTube ↗︎":"Search YouTube ↗︎"}
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
    // Inherit reps from the current slot — same movement pattern, same
    // stimulus level. loadType is resolved HERE, at selection (audit #58):
    // before this, the swap inherited the original slot's type via spread
    // and volume math double/half-counted. The weight prefill only carries
    // over when the load semantics match — a 35kg machine number is
    // meaningless prefill for a bodyweight swap (re-seeds instead).
    const loadType = swapLoadType(option);
    const sameLoadMaths = loadType === getLoadType(activeEx);
    onSwap(swapKey, {
      name:   option.name,
      muscle: option.muscle,
      reps:   activeEx?.reps   ?? 10,
      weight: sameLoadMaths ? (activeEx?.weight ?? null) : null,
      vid:    option.vid ?? null,
      loadType,
    });
    onClose();
  };
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "swap-overlay-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} className="forge-sheet-ground" style={{background:T.bg2,padding:"24px 24px 36px",width:"100%",borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
          <div>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>Swap exercise</div>
            <div id={titleId} style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text2,fontStyle:"italic"}}>{activeEx?.name}</div>
          </div>
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
        {/* House pattern (2026-07-21): actions live on the bottom row, no corner ✕ */}
        <button onClick={onClose} style={{marginTop:14,width:"100%",padding:"14px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:"pointer",fontSize:14,color:T.text2}}>Cancel</button>
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
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} className="forge-sheet-ground" style={{background:T.bg2,padding:"24px 24px 32px",width:"100%",borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div><div id={titleId} style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{target.exName}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:4}}>Scroll to adjust</div></div>
        </div>
        <div style={{display:"flex",gap:16,justifyContent:hasWeight?"space-between":"center"}}>
          {hasWeight&&<ScrollDrum value={kg} onChange={setKg} step={weightStep} min={0} max={400} label={lt==="per_db"?"kg / db":"kg"}/>}
          <ScrollDrum value={reps} onChange={setReps} step={target.timed?5:1} min={target.timed?5:1} max={target.timed?180:30} integer label={target.timed?"sec":"reps"} unit={target.timed?"sec":undefined}/>
        </div>
        {/* House pattern (2026-07-21): Cancel/Confirm on the bottom row, no corner ✕.
            Drum edits are LOCAL state — Cancel is a true discard. */}
        <div style={{display:"flex",gap:10,marginTop:24}}>
        <button onClick={onClose} style={{flex:1,padding:"16px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:"pointer",fontSize:14,color:T.text2}}>Cancel</button>
        <button onClick={()=>{
          if(hasWeight) setWW(p=>({...p,[target.exName]:kg}));
          setWR(p=>({...p,[target.exName]:reps}));
          onClose();
        }} style={{flex:2,padding:"16px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:18,fontWeight:400,color:T.bg0,boxShadow:`0 8px 28px ${T.strength.glow}`}}>
          Confirm →
        </button>
        </div>
      </div>
    </div>
  );
}

// ─── Done ──────────────────────────────────────────────────────────────────────
const DONE_HEADLINES = [
  ["Solid", "work."],
  ["Heavy,", "handled."],
  ["The bar", "moved."],
  ["That's", "a session."],
  ["Job", "done."],
  ["Nothing", "wasted."],
];
const NEXT_DAY_MSG = {
  zone2:  "Zone 2 tomorrow. 60 min, conversational pace.",
  cardio: "Moderate cardio tomorrow. 35 min at ~75%.",
  hiit:   "HIIT tomorrow. 8–10 rounds, all out.",
  rest:   "Rest day tomorrow. That's where you grow.",
  strength:"Strength session next. Load up.",
};

export function DoneScreen({session,profileName,workingWeights,sessionStartWeights={},userWeek=WEEK,onHome,deloadCompleted=false,returnGapDays=null}){
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
    <div style={{maxWidth:430,margin:"0 auto",padding:"72px 24px 0",position:"relative",overflow:"clip"}}>
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
              {n.changed?"Next time, heavier.":"Hold — grind it smooth."}
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
        <button className="forge-press" onClick={onHome} style={{marginTop:20,width:"100%",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0,boxShadow:`0 12px 40px ${T.strength.glow}`}}>
          Home →
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
              Syncing…
            </>
          ) : (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.gold}}/>
              Saved locally · syncs when online
            </>
          )}
        </div>
      </Fade>
    </div>
  );
}
