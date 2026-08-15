"use client";

// components/SessionScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The strength-session flow — Bone & Ember: ReadinessScreen → SessionScreen →
// DoneScreen, plus the session-only satellites (SessionOverviewSheet,
// RecentHistorySheet, RpeTrack, VideoEmbed, SwapOverlay, DrumEditOverlay).
// All state and mutations stay in the host and arrive via props — this
// module renders the flow, it does not own it.
//
// This screen is where the thermal thesis earns its keep: effort is a DRAG
// on a continuous track (one thumb, no aim, heat under the finger), the
// commit button inherits the bloomed colour over 900ms, logged sets carry
// heat marks that encode magnitude in colour AND height with the number
// always printed, and the rest ring breathes. iOS Safari has no Vibration
// API — this motion spec IS the tactility.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { T, DISPLAY, heatForRpe, onHeatForRpe, heatMarkHeight, rpeForEffort, rpeValue } from "@/lib/tokens";
import { Fade, Card, MonoNums } from "@/components/ui";
import Glyph from "@/components/Glyph";
import { useModalA11y, haptic } from "@/lib/a11y";
import { todayLocalIso, daysBetween, mondayIndex } from "@/lib/dates";
import ScrollDrum, { SplitWeightDrum } from "@/components/ScrollDrum";
import { WEEK, SWAP_DB } from "@/lib/programme";
import { SyncStatus } from "@/lib/storage";
import { recentForExercise } from "@/lib/analytics";
import { getLoadType, swapLoadType, weightStepForLoadType, parseTimedReps, WEIGHT_CAPTIONS } from "@/lib/lift-translations";
import { getTempo, decodeTempo } from "@/lib/exercise-tempo";
import { resolveVid } from "@/lib/exercise-videos";


// RIR, in plain words — always printed beside the track (redundancy law:
// the words carry the meaning; the heat is the pleasure layer).
function rirText(rpe) {
  const rir = Math.round((10 - rpe) * 2) / 2;
  if (rir <= 0) return "Nothing left";
  if (rir === 0.5) return "Half a rep in reserve";
  if (rir === 1) return "1 rep in reserve";
  return `${rir % 1 === 0 ? rir : rir} in reserve`;
}

const linkBtn = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  fontFamily: T.text, fontSize: 13, color: T.ink3,
  display: "inline-flex", alignItems: "center", gap: 5,
};

// ─── RPE track ───────────────────────────────────────────────────────────────
// Drag, not chips. Continuous 6–10 in 0.5 steps. The channel is a bare
// 10px bed (square ends, heat-0 ground, hairline ticks at 7/8/9) inside a
// 44px touch zone; the fill is SOLID in the current bloom stop and stops
// at the thumb — no full-track gradient, no border. Thumb is a 2px ink
// bar; the value prints in mono above (EffortPanel owns that row).
function RpeTrack({ rpe, onChange }) {
  const trackRef = useRef(null);
  const pct = ((rpe - 6) / 4) * 100;

  const setFromClientX = useCallback((clientX) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const next = Math.round((6 + frac * 4) * 2) / 2;
    onChange((prev) => {
      if (next !== prev) haptic.toggle();
      return next;
    });
  }, [onChange]);

  const dragging = useRef(false);
  const onDown = (e) => { dragging.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); setFromClientX(e.clientX); };
  const onMove = (e) => { if (dragging.current) setFromClientX(e.clientX); };
  const onUp   = () => { dragging.current = false; };

  return (
    <div>
      <div
        ref={trackRef}
        role="slider" aria-label="Effort, RPE 6 to 10" tabIndex={0}
        aria-valuemin={6} aria-valuemax={10} aria-valuenow={rpe}
        aria-valuetext={`RPE ${rpe} — ${rirText(rpe)}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft")  { e.preventDefault(); onChange((p) => Math.max(6, p - 0.5)); }
          if (e.key === "ArrowRight") { e.preventDefault(); onChange((p) => Math.min(10, p + 0.5)); }
        }}
        style={{
          position: "relative", height: 44, display: "flex", alignItems: "center",
          touchAction: "none", cursor: "ew-resize",
        }}
      >
        {/* The 10px visual channel inside the 44px touch zone. */}
        <div style={{ position: "relative", width: "100%", height: 10, background: T.heat[0] }}>
          {/* Hairline ticks at 7 / 8 / 9, standing proud of the channel. */}
          {[25, 50, 75].map(x => (
            <div key={x} style={{position:"absolute",left:`${x}%`,top:-2,height:14,width:1,background:T.rule}}/>
          ))}
          {/* Solid fill in the current bloom stop, stopping at the thumb. */}
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0,
            width: `${pct}%`, background: heatForRpe(rpe),
            transition: `width 380ms ${T.ease}, background 900ms ease`,
          }}/>
          {/* Thumb — a 2px ink bar. */}
          <div style={{
            position: "absolute", top: -4, height: 18, width: 2,
            background: T.ink, left: `${pct}%`, transform: "translateX(-50%)",
            transition: `left 380ms ${T.ease}`,
          }}/>
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontFamily:T.measured,fontSize:11,color:T.ink3}}>
        <span>6</span><span>7</span><span>8</span><span>9</span><span>10</span>
      </div>
    </div>
  );
}

// ─── Effort panel — the commit moment ────────────────────────────────────────
// Appears when a set needs rating. The big value blooms along the ramp
// (900ms colour travel, never a switch); the commit button warms to match,
// its ink reading the per-stop alias for its bloom stop (§13).
function EffortPanel({ label = "How hard was that?", onCommit }) {
  const [rpe, setRpe] = useState(8);
  return (
    <div style={{margin:"14px 20px 0",animation:`fadeSlide 240ms ${T.ease}`}}>
      <div style={{fontSize:13,color:T.ink3,marginBottom:10}}>{label}</div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:2}}>
        <div style={{fontSize:14,color:T.ink}}><MonoNums>{rirText(rpe)}</MonoNums></div>
        <div style={{
          fontFamily:T.measured,fontSize:24,lineHeight:1,
          color:heatForRpe(rpe),transition:`color 900ms ease`,
        }}>{rpe % 1 === 0 ? rpe : rpe.toFixed(1)}</div>
      </div>
      <RpeTrack rpe={rpe} onChange={setRpe}/>
      <button
        className="forge-press"
        onClick={() => { haptic.commit(); onCommit(rpe); }}
        style={{
          marginTop:14,width:"100%",height:56,border:"none",borderRadius:T.r,cursor:"pointer",
          display:"flex",alignItems:"center",justifyContent:"center",gap:8,
          fontFamily:T.text,fontSize:17,fontWeight:500,
          // Quantized to the bloom stop (§13) — a continuous gradient
          // crosses the ink flip mid-slide and loses the label. The 900ms
          // colour transition IS the bloom between stops.
          background:heatForRpe(rpe),
          color:onHeatForRpe(rpe),
          boxShadow:T.elevStrong,
          transition:`background 900ms ease, color 900ms ease, transform 380ms ${T.ease}`,
        }}>
        Log at <span style={{fontFamily:T.measured}}>{rpe % 1 === 0 ? rpe : rpe.toFixed(1)}</span>
      </button>
    </div>
  );
}

// ─── Session overview sheet ──────────────────────────────────────────────────
// Mid-session escape hatch: list every block, show which is current / done /
// not started, and let the user jump to any of them. Auto-flow is unchanged
// for users who don't open this surface.
export function SessionOverviewSheet({ session, currentBlockIdx, draftLog, onJumpToBlock, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "session-overview-title";

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
    const exNames = [b.ex?.name, b.exA?.name, b.exB?.name].filter(Boolean);
    return { i, b, pairs, total, state, exNames };
  });

  // Progress is a session identifier → the day key (strength = oxide) may
  // colour it. Done/partial print their state; nothing relies on colour.
  const stateStyle = {
    current:  { mark: T.dayKey.strength, label: "Current" },
    done:     { mark: T.ink2,            label: "Done" },
    partial:  { mark: T.ink3,            label: "Partial" },
    upcoming: { mark: T.rule,            label: "Up next" },
  };

  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground forge-vellum" style={{padding:"26px 24px 32px",width:"100%",animation:`slideUp 280ms ${T.ease}`,maxHeight:"90vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:8}}>
          Session overview
        </div>
        <div id={titleId} style={{...DISPLAY,fontSize:28,color:T.ink,marginBottom:6}}>
          {session.name}
        </div>
        <p style={{fontSize:13,color:T.ink2,marginBottom:16,lineHeight:1.5}}>
          Train in any order — auto-advance still happens; this is for when the gym dictates.
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
                  background:T.surface,
                  border:"none",boxShadow:T.elev,borderRadius:T.r,
                  cursor: state === "current" ? "default" : "pointer",
                  opacity: state === "upcoming" ? 0.92 : 1,
                  fontFamily:T.text,
                }}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
                  <span style={{display:"inline-flex",alignItems:"center",gap:8}}>
                    <span aria-hidden="true" style={{width:16,height:4,background:s.mark,display:"inline-block"}}/>
                    <span style={{fontSize:12,fontWeight:500,color:T.ink2}}>{s.label}</span>
                  </span>
                  <span style={{fontSize:12,color:T.ink3}}>
                    <span style={{fontFamily:T.measured}}>{pairs}/{total}</span> {b.type === "superset" ? "rounds" : "sets"}
                  </span>
                </div>
                <div style={{fontSize:12,color:T.ink3,marginBottom:2}}>
                  {b.label}
                </div>
                <div style={{fontSize:15,fontWeight:500,color:T.ink,lineHeight:1.3}}>
                  {exNames.join(" + ") || "—"}
                </div>
              </button>
            );
          })}
        </div>

        <button onClick={onCancel}
          style={{marginTop:10,padding:"12px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontSize:13,color:T.ink2,fontFamily:T.text}}>
          Back to current set
        </button>
      </div>
    </div>
  );
}

// ─── Recent-history sanity-check sheet ──────────────────────────────────────
// Shows the last N performances of the active exercise. Read-only; renders
// only when there's at least one prior entry.
function RecentHistorySheet({ exerciseName, recent, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "recent-history-title";

  const fmt = (dateStr) => {
    if (!dateStr) return "";
    const diff = daysBetween(dateStr, todayLocalIso());
    if (diff === null) return dateStr;
    if (diff <= 0) return "today";
    if (diff === 1) return "yesterday";
    if (diff < 7)   return `${diff} days ago`;
    if (diff < 14)  return "1 week ago";
    if (diff < 28)  return `${Math.floor(diff/7)} weeks ago`;
    const months = Math.floor(diff / 30);
    if (months === 1) return "1 month ago";
    return `${months} months ago`;
  };

  return (
    <div onKeyDown={onKeyDown} onClick={onCancel}
      className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground forge-vellum" style={{padding:"26px 24px 32px",width:"100%",animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:8}}>
          Recent history
        </div>
        <div id={titleId} style={{...DISPLAY,fontSize:28,color:T.ink,marginBottom:14}}>
          {exerciseName}
        </div>

        <div style={{flex:1,overflowY:"auto",marginRight:-8,paddingRight:8}}>
          {recent.map((r, i) => {
            const w  = r.topSet?.weight;
            const reps = r.topSet?.reps;
            const summary = r.allEqual
              ? `${r.sets.length}×${reps ?? "?"}${w == null ? "" : ` @ ${w} kg`}`
              : `top: ${w ?? "?"}${w == null ? "" : " kg"} × ${reps ?? "?"}`;
            const rpe = rpeValue(r.effort);
            return (
              <div key={r.date + "_" + i}
                style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:i<recent.length-1?`1px solid ${T.ruleFaint}`:"none"}}>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <span style={{fontSize:12,color:T.ink3}}>{fmt(r.date)}</span>
                  <span style={{fontFamily:T.measured,fontSize:15,color:T.ink}}>{summary}</span>
                </div>
                {r.effort != null && rpe != null && (
                  <span aria-label={`Effort: ${typeof r.effort === "number" ? `RPE ${rpe}` : r.effort}`} style={{display:"inline-flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:12,color:T.ink2,fontFamily:typeof r.effort === "number"?T.measured:T.text}}>{typeof r.effort === "number" ? (rpe % 1 === 0 ? rpe : rpe.toFixed(1)) : r.effort}</span>
                    <span aria-hidden="true" style={{width:24,height:heatMarkHeight(rpe),background:heatForRpe(rpe),borderRadius:T.rMark,display:"inline-block"}}/>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <button onClick={onCancel}
          style={{marginTop:14,padding:"12px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontSize:13,color:T.ink2,fontFamily:T.text}}>
          Close
        </button>
      </div>
    </div>
  );
}

export function ReadinessScreen({readiness,setReadiness,reason,setReason,onStart,planDay=null,onHome=null,travel=false,setTravel=null}){
  // Readiness rides the same one-dimensional intensity scale as everything
  // else — fresh sits at the cool end, cooked at the hot end. Colour +
  // mark height + the word: the redundancy law, again.
  const opts=[
    {id:"fresh", rpe:6, label:"Fresh", sub:"Full programme, and a shot at more on your main lift."},
    {id:"normal",rpe:8, label:"Normal",sub:"The work, as written."},
    {id:"cooked",rpe:10,label:"Cooked",sub:"Deload weights · trimmed volume."},
  ];
  // Short, enum-only reasons. Fed into the session record so patterns can
  // surface. Only shown when readiness is "cooked".
  const reasons = [
    {id:"slept_badly", label:"Slept badly"},
    {id:"stressed",    label:"Stressed"},
    {id:"recovering",  label:"Still recovering"},
    {id:"sore",        label:"Sore"},
    {id:"other",       label:"Something else"},
  ];
  return (
    <div style={{maxWidth:430,margin:"0 auto",padding:"52px 24px 48px"}}>
      <Fade d={0}>
        {onHome && (
          <button onClick={onHome} style={{...linkBtn,fontSize:13,color:T.ink2,marginBottom:22,display:"inline-flex",alignItems:"center",gap:6}}>
            <Glyph name="arrowLeft" size={12} color={T.ink3}/> Home
          </button>
        )}
        <div style={{fontSize:13,color:T.ink2,marginBottom:8}}>Session{planDay ? <> · {planDay}</> : null}</div>
        <h1 style={{...DISPLAY,fontSize:38,color:T.ink,marginBottom:10}}>
          Readiness
        </h1>
        <p style={{fontSize:14,color:T.ink2,marginBottom:36,lineHeight:1.6}}>How are you feeling? We&rsquo;ll shape the session around you.</p>
      </Fade>
      {/* §12.3 — selection IS the card. Options are rows between hairlines
          on the ground; only the chosen row lifts to surface (12px, whisper
          shadow, swatch at full strength). One card per screen, and the
          card is the choice you made. */}
      <div style={{display:"flex",flexDirection:"column",borderTop:`1px solid ${T.rule}`}}>
        {opts.map((o,i)=>{
          const sel = readiness===o.id;
          return (
            <Fade key={o.id} d={80+i*50}>
              <button className="forge-press" onClick={()=>{ haptic.toggle(); setReadiness(o.id); if (o.id !== "cooked") setReason(null); }}
                aria-pressed={sel}
                style={{textAlign:"left",
                  padding:sel?"17px 16px":"17px 2px",
                  margin:sel?"0 -14px":0,width:sel?"calc(100% + 28px)":"100%",
                  borderRadius:sel?T.r:0,cursor:"pointer",
                  background:sel?T.surface:"transparent",
                  border:"none",
                  borderBottom:sel?"1px solid transparent":`1px solid ${T.rule}`,
                  boxShadow:sel?T.elev:"none",
                  display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,
                  fontFamily:T.text,transition:`background 200ms ${T.ease}, box-shadow 0s`}}>
                <div style={{display:"flex",alignItems:"center",gap:14}}>
                  <span aria-hidden="true" style={{width:24,height:heatMarkHeight(o.rpe),background:heatForRpe(o.rpe),borderRadius:T.rMark,opacity:sel?1:0.5,transition:`opacity 200ms ${T.ease}`,flexShrink:0}}/>
                  <div>
                    <div style={{fontSize:17,fontWeight:500,color:T.ink}}>{o.label}</div>
                    <div style={{fontSize:13,color:T.ink3,marginTop:2}}><MonoNums>{o.sub}</MonoNums></div>
                  </div>
                </div>
                {/* The check exists only on the chosen row — absence is the
                    affordance, same logic as the disabled commit. */}
                {sel && <Glyph name="check" size={13} color={T.ink}/>}
              </button>
            </Fade>
          );
        })}
      </div>

      {/* Optional "why?" — only surfaces when the user picked Cooked. */}
      {readiness === "cooked" && (
        <Fade d={0}>
          <div style={{marginTop:26}}>
            <div style={{fontSize:13,color:T.ink3,marginBottom:10,display:"flex",alignItems:"baseline",justifyContent:"space-between"}}>
              <span>What&rsquo;s going on?</span>
              <span style={{fontSize:12,color:T.ink3}}>optional</span>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {reasons.map(r => {
                const sel = reason === r.id;
                return (
                  <button key={r.id} className="forge-press" onClick={()=>{haptic.toggle();setReason(sel ? null : r.id);}}
                    aria-pressed={sel}
                    style={{padding:"9px 14px",borderRadius:T.rSm,cursor:"pointer",
                      background:sel?T.surface:"transparent",
                      border:`1px solid ${sel?"transparent":T.rule}`,
                      boxShadow:sel?T.elev:"none",
                      fontSize:13,fontFamily:T.text,fontWeight:sel?500:400,color:sel?T.ink:T.ink2,
                      transition:`background 180ms ${T.ease}`}}>
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Fade>
      )}

      {/* Travel mode — the second question the check-in asks, because it is
          the other thing that reshapes the session. STICKY: a trip lasts
          days, so it stays on until turned off. Same row grammar as the
          readiness options above (§12.3 — selection is the card). */}
      {setTravel && (
        <Fade d={240}>
          <div style={{marginTop:26,borderTop:`1px solid ${T.rule}`}}>
            <button className="forge-press" onClick={()=>{ haptic.toggle(); setTravel(!travel); }}
              aria-pressed={travel}
              style={{textAlign:"left",
                padding:travel?"17px 16px":"17px 2px",
                margin:travel?"0 -14px":0,width:travel?"calc(100% + 28px)":"100%",
                borderRadius:travel?T.r:0,cursor:"pointer",
                background:travel?T.surface:"transparent",
                border:"none",
                borderBottom:travel?"1px solid transparent":`1px solid ${T.rule}`,
                boxShadow:travel?T.elev:"none",
                display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,
                fontFamily:T.text,transition:`background 200ms ${T.ease}, box-shadow 0s`}}>
              <div style={{display:"flex",alignItems:"center",gap:14}}>
                <span aria-hidden="true" style={{width:24,display:"flex",justifyContent:"center",flexShrink:0}}>
                  <Glyph name="plane" size={17} color={travel?T.commit:T.ink3}/>
                </span>
                <div>
                  <div style={{fontSize:17,fontWeight:500,color:T.ink}}>Travel mode</div>
                  <div style={{fontSize:13,color:T.ink3,marginTop:2}}>
                    {travel
                      ? "Same session, bodyweight. On until you turn it off."
                      : "No gym? Train with the room you're in."}
                  </div>
                </div>
              </div>
              {travel && <Glyph name="check" size={13} color={T.ink}/>}
            </button>
          </div>
        </Fade>
      )}

      <Fade d={280}>
        {/* Disabled keeps its shape: ground + hairline + tertiary ink. Heat
            ARRIVES (900ms bloom) when a readiness is chosen — the colour
            arriving is the affordance, not a grey lock lifting. */}
        <button className={readiness?"forge-press":undefined} onClick={readiness?onStart:undefined}
          style={{marginTop:28,width:"100%",height:56,
            background:readiness?T.commit:"transparent",
            border:`1px solid ${readiness?"transparent":T.rule}`,borderRadius:T.r,
            cursor:readiness?"pointer":"default",
            fontFamily:T.text,fontSize:17,fontWeight:500,
            color:readiness?T.commitInk:T.ink3,
            boxShadow:readiness?T.elevStrong:"none",
            transition:`background 900ms ease, color 900ms ease, border-color 300ms ${T.ease}`,
            display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
          Start session <Glyph name="arrowRight" size={13}/>
        </button>
      </Fade>
    </div>
  );
}

// ─── Rest progress line ──────────────────────────────────────────────────────
// Thin strip under the rest row that drains in sync with remaining seconds.
function RestProgressLine({ active, remain, total }) {
  if (!active || !total || total <= 0) return null;
  const pct = Math.max(0, Math.min(1, remain / total)) * 100;
  return (
    <div style={{marginTop:8,height:1,width:"100%",background:T.rule,overflow:"hidden"}}>
      <div style={{height:"100%",width:`${pct}%`,background:T.ink3,transition:"width 1000ms linear"}}/>
    </div>
  );
}

// ─── Session ──────────────────────────────────────────────────────────────────
export function SessionScreen({session,block,blockIdx,totalBlocks,setNum,phase,isSS,activeEx,resolvedExA,resolvedExB,resolvedEx,swapKey,onSwap,showVid,setShowVid,getW,getR,editTarget,setEditTarget,workingWeights,setWW,workingReps,setWR,history=[],loggedSets=[],awaitRpe,ssRoundDone,restActive,restRemain,setRestActive,setRestRemain,onCommit,onLog,onQuit,onShowOverview,bodyweight,canReach=false,reachStep=2.5,reachArmed=false,onTakeReach,onDeclineReach,deloadDayTag=null}){
  const [swapEx,setSwapEx]=useState(null);
  const partnerEx=isSS?(phase==="A"?resolvedExB:resolvedExA):null;
  const vidEx    =isSS?(phase==="A"?resolvedExA:resolvedExB):resolvedEx;
  const progress =((blockIdx+(setNum-1)/block.sets)/totalBlocks)*100;
  // Display face fence: never below 28px. Long names wrap rather than
  // shrinking under the fence.
  const nameFz   =Math.min(42,Math.max(28,340/(activeEx?.name?.length||10)));
  const typeLabel={main:"Main lift",superset:"Superset",finisher:"Finisher"}[block.type];
  const currentW =getW(activeEx);
  const [historyOpen,setHistoryOpen]=useState(false);
  // Tempo discovery — a quiet chip beside the muscle tag, expanding to the
  // decoded prescription. Digits are measured values → mono.
  const [tempoOpen,setTempoOpen]=useState(false);
  const tempoEntry=useMemo(()=>getTempo(activeEx?.name),[activeEx?.name]);
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
  const weightCaption = WEIGHT_CAPTIONS[loadType] || null;
  const weightStep = weightStepForLoadType(loadType);

  // Stepper — the most-touched surface: one-tap plate maths in the lift's
  // real-world increment, drum for bigger jumps (tap the number).
  const nudgeWeight = (dir) => {
    if (!activeEx?.name || currentW == null) return;
    haptic.toggle();
    const next = Math.max(0, Math.round((currentW + dir * weightStep) * 100) / 100);
    setWW(p => ({...p, [activeEx.name]: next}));
  };

  // Last performance of this exercise (for the "this set, last week" cell
  // and the delta line under the weight).
  const last = recent[0] || null;
  const lastW = last?.topSet?.weight ?? null;
  const delta = (lastW != null && currentW != null) ? Math.round((currentW - lastW) * 100) / 100 : null;
  const lastRpe = rpeValue(last?.topSet?.rpe) ?? (last?.effort ? rpeForEffort(last.effort) : null);

  return (
    /* Three-zone column: identity (top) — numbers (upper-middle) — actions
       (pinned to the thumb, bottom). Height: .forge-fill — the shell owns
       all viewport and safe-area accounting. */
    <div className="forge-fill" style={{maxWidth:430,margin:"0 auto",position:"relative",overflowX:"clip",display:"flex",flexDirection:"column",paddingBottom:"calc(16px + env(safe-area-inset-bottom,0px))",width:"100%"}}>
      {/* Session progress — an identifier, so the day key (oxide) may
          colour it. Inset hairline, no glow. */}
      <div style={{margin:"10px 20px 0",height:2,background:T.rule,overflow:"hidden",position:"relative"}}>
        <div style={{height:"100%",width:`${progress}%`,background:T.dayKey.strength,transition:`width 600ms ${T.ease}`}}/>
      </div>
      <div style={{padding:"14px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <button onClick={onQuit} style={{...linkBtn,fontSize:13,color:T.ink2}}><Glyph name="arrowLeft" size={12} color={T.ink3}/> Quit</button>
        <button onClick={onShowOverview} aria-label="Open session overview"
          style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"right",display:"flex",flexDirection:"column",alignItems:"flex-end",fontFamily:T.text}}>
          <div style={{fontSize:13,fontWeight:500,color:T.ink2,display:"flex",alignItems:"center",gap:6}}>
            {session.name}
            <Glyph name="chevronDown" size={10} style={{opacity:0.7}}/>
          </div>
        </button>
      </div>

      <div style={{padding:"18px 20px 0"}}>
        {/* Kicker — the room's live state: set count + slot. Never a sentence. */}
        <div style={{fontSize:13,color:T.ink2,marginBottom:8}}>
          Set <span style={{fontFamily:T.measured}}>{setNum}</span> of <span style={{fontFamily:T.measured}}>{block.sets}</span> · {block.label}{isSS?` ${phase}`:""}
        </div>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
          <div onClick={resolveVid(activeEx?.name, activeEx?.vid) ? ()=>setShowVid(true) : undefined}
            style={{cursor:resolveVid(activeEx?.name, activeEx?.vid)?"pointer":"default",flex:1,userSelect:"none"}}>
            <h1 style={{...DISPLAY,fontSize:nameFz,color:T.ink,margin:0}}>{activeEx?.name}</h1>
            <div style={{display:"flex",alignItems:"center",gap:12,marginTop:9,flexWrap:"wrap"}}>
              {resolveVid(activeEx?.name, activeEx?.vid) && (
                <span style={{fontSize:13,color:T.ink2,fontWeight:500,display:"inline-flex",alignItems:"center",gap:5}}>Watch demo <Glyph name="arrowRight" size={11}/></span>
              )}
              <span style={{fontSize:13,color:T.ink3}}>{activeEx?.muscle}</span>
              {tempoEntry?.tempo && (
                <button
                  onClick={(e)=>{e.stopPropagation();setTempoOpen(o=>!o);}}
                  aria-expanded={tempoOpen}
                  aria-label={`Tempo ${tempoEntry.tempo} — tap to ${tempoOpen?"hide":"explain"}`}
                  style={{...linkBtn,fontFamily:T.measured,fontSize:12,color:tempoOpen?T.ink:T.ink3,transition:`color 180ms ${T.ease}`}}
                >
                  {tempoEntry.tempo}
                </button>
              )}
            </div>
          </div>
          <button
            onClick={()=>setSwapEx({block,phase})}
            style={{marginTop:4,flexShrink:0,background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.r,padding:"9px 12px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,fontFamily:T.text}}
          >
            <Glyph name="swap" size={16} color={T.ink}/>
            <span style={{fontSize:11,fontWeight:500,color:T.ink3}}>Swap</span>
          </button>
        </div>
        {(loadTypeSubtitle || deloadDayTag) && (
          <div style={{fontSize:13,color:T.ink3,marginTop:10}}>
            {loadTypeSubtitle}
            {loadTypeSubtitle && deloadDayTag && " · "}
            {deloadDayTag && <MonoNums>{deloadDayTag}</MonoNums>}
          </div>
        )}
        {/* Travel line — what this slot is standing in for, and what to find
            in the room. Without it the session silently becomes a different
            workout, and the user meets the kit requirement halfway through
            set one. */}
        {activeEx?.travel && (activeEx?.travelFrom || activeEx?.kit) && (
          <div style={{fontSize:13,color:T.ink3,marginTop:8,display:"flex",alignItems:"baseline",gap:7}}>
            <Glyph name="plane" size={12} color={T.ink3}/>
            <span>
              {activeEx.travelFrom ? <>Standing in for {activeEx.travelFrom}</> : "Travel"}
              {activeEx.kit && <> · {activeEx.kit}</>}
            </span>
          </div>
        )}
        {tempoEntry?.tempo && tempoOpen && (
          <Fade>
            <div style={{marginTop:12,padding:"10px 0",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`}}>
              <div style={{fontSize:13,fontWeight:500,color:T.ink}}>{tempoPhrase}</div>
              <div style={{fontSize:13,color:T.ink2,marginTop:5,lineHeight:1.5}}>{tempoEntry.principle}</div>
            </div>
          </Fade>
        )}
      </div>

      {/* Capped spacer — numbers hold the upper-middle. */}
      <div style={{flex:1,minHeight:12,maxHeight:72}}/>

      {/* The working number — mono, light weight, huge. Tap for the drum,
          steppers for plate maths. */}
      <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",padding:"0 20px"}}>
        <div>
          {showWeightPicker && currentW!==null ? (
            <>
              <div style={{display:"flex",alignItems:"baseline",gap:8,cursor:"pointer",userSelect:"none"}}
                onClick={()=>{ if(activeEx?.name) setEditTarget({exName:activeEx.name,currentKg:currentW,currentReps:getR(activeEx),loadType}); }}>
                <span style={{fontFamily:T.measured,fontWeight:300,fontSize:72,lineHeight:0.82,letterSpacing:"-0.055em",color:T.ink}}>{currentW}</span>
                <span style={{fontSize:15,color:T.ink3}}>{weightLabel}</span>
              </div>
              {weightCaption && (
                <div style={{fontSize:12,color:T.ink3,marginTop:8}}>{weightCaption}</div>
              )}
              {delta != null && delta !== 0 && (
                <div style={{fontSize:13,color:T.ink3,marginTop:weightCaption?4:9}}>
                  <span style={{fontFamily:T.measured,color:T.heat[3]}}>{delta>0?"+":""}{delta}</span> on last time
                </div>
              )}
            </>
          ) : showWeightPicker ? (
            /* A LOADED lift whose weight we don't know yet — a swap to
               something never trained, with no anchor history to cold-start
               from. It is not bodyweight and must never say so: this branch
               used to fall through to the "Bodyweight" line below, which is
               how a swapped-in Arnold Press announced itself as a bodyweight
               movement (boss report, 2026-08-13). Offer the drum instead. */
            <div style={{cursor:"pointer",userSelect:"none"}}
              onClick={()=>{ if(activeEx?.name) setEditTarget({exName:activeEx.name,currentKg:null,currentReps:getR(activeEx),loadType}); }}>
              <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                <span style={{fontFamily:T.measured,fontWeight:300,fontSize:72,lineHeight:0.82,letterSpacing:"-0.055em",color:T.ink3}}>&mdash;</span>
                <span style={{fontSize:15,color:T.ink3}}>{weightLabel}</span>
              </div>
              <div style={{fontSize:13,color:T.ink2,marginTop:8}}>New lift &mdash; set your weight</div>
            </div>
          ) : (
            <div style={{fontSize:15,color:T.ink2}}>Bodyweight{bodyweight ? <> · <span style={{fontFamily:T.measured}}>{bodyweight}</span> kg</> : ""}</div>
          )}
        </div>
        {showWeightPicker && currentW!==null && (
          <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:4}}>
            <button aria-label={`Add ${weightStep} kg`} onClick={()=>nudgeWeight(1)} className="forge-press"
              style={{width:46,height:46,background:T.surface,border:"none",borderRadius:T.r,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:T.elev,cursor:"pointer"}}><Glyph name="plus" size={16} color={T.ink2}/></button>
            <button aria-label={`Remove ${weightStep} kg`} onClick={()=>nudgeWeight(-1)} className="forge-press"
              style={{width:46,height:46,background:T.surface,border:"none",borderRadius:T.r,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:T.elev,cursor:"pointer"}}><Glyph name="minus" size={16} color={T.ink2}/></button>
          </div>
        )}
      </div>

      {/* Target + last-time, on the ground between hairlines. The last-time
          value carries the heat of its logged effort. */}
      <div style={{margin:"18px 0 0",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,display:"flex"}}>
        {(() => {
          const timed = parseTimedReps(activeEx?.reps);
          const displayVal = getR(activeEx);
          return (
            <div style={{flex:1,padding:"12px 0 12px 20px",cursor:"pointer",userSelect:"none"}}
              onClick={()=>{ if(activeEx?.name) setEditTarget({exName:activeEx.name,currentKg:showWeightPicker?currentW:null,currentReps:displayVal,loadType,timed:!!timed}); }}>
              <div style={{fontFamily:T.measured,fontSize:22,color:T.ink}}>{timed ? `${typeof displayVal === "number" ? displayVal : timed.seconds}s` : displayVal}</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:3}}>{timed ? "hold" : "reps"}</div>
            </div>
          );
        })()}
        {/* The door to recent history sits ON the cell it expands. It used to
            be a "Recent →" link at the very bottom of the column, where it was
            below the fold on device and needed a scroll to reach — and
            scrolling to reach it then mispositioned the sheet it opened. */}
        <div role={recent.length > 0 ? "button" : undefined}
          tabIndex={recent.length > 0 ? 0 : undefined}
          onClick={recent.length > 0 ? () => setHistoryOpen(true) : undefined}
          onKeyDown={recent.length > 0 ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setHistoryOpen(true); } } : undefined}
          aria-label={recent.length > 0 ? `Recent history for ${activeEx?.name}` : undefined}
          style={{flex:2,padding:"12px 20px 12px 18px",borderLeft:`1px solid ${T.rule}`,cursor:recent.length>0?"pointer":undefined}}>
          <div style={{fontFamily:T.measured,fontSize:22,color:lastRpe!=null?heatForRpe(lastRpe):T.ink3}}>
            {last?.topSet ? `${lastW ?? "—"}${lastW!=null?"":""} × ${last.topSet.reps ?? "—"}${lastRpe!=null?` @ ${lastRpe%1===0?lastRpe:lastRpe.toFixed(1)}`:""}` : "—"}
          </div>
          <div style={{fontSize:12,color:T.ink3,marginTop:3,display:"flex",alignItems:"center",gap:5}}>
            this lift, last time
            {recent.length > 0 && <Glyph name="arrowRight" size={10} color={T.ink3}/>}
          </div>
        </div>
      </div>

      {/* Per-set progress ticks — pulled up under the weight block so the
          middle carries the session's state, not empty ground. Day-key
          coloured: a session identifier, not measured data. */}
      <div style={{padding:"14px 20px 0",display:"flex",gap:6}}>
        {Array.from({length:block.sets}).map((_,i)=>(
          <div key={i} style={{flex:1,height:3,background:i<setNum-1?T.dayKey.strength:T.rule,transition:`background 300ms ${T.ease}`}}/>
        ))}
      </div>

      {/* The session ledger (§12.4) — the middle belongs to logged sets
          accruing as hairline rows, newest on top: 40 kg × 3 at 8.5, digits
          mono, words in the text face, heat mark riding each row. Set one
          simply shows empty ground. */}
      {loggedSets.length > 0 && (
        <div style={{margin:"0 20px"}}>
          {loggedSets.map((s, i) => {
            const rpe = rpeValue(s.rpe);
            return { s, rpe, n: i + 1 };
          }).reverse().map(({ s, rpe, n }, idx) => (
            <div key={n} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderBottom:`1px solid ${T.ruleFaint}`,animation:idx===0?`hwSettle 480ms ${T.ease} both`:undefined}}>
              <span style={{fontSize:13,color:T.ink3}}>Set <span style={{fontFamily:T.measured}}>{n}</span></span>
              <span style={{display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:13,color:T.ink}}>
                  {s.weight!=null && <><span style={{fontFamily:T.measured,fontSize:14}}>{s.weight}</span> kg <span style={{fontFamily:T.measured,fontSize:14}}>×</span> </>}
                  <span style={{fontFamily:T.measured,fontSize:14}}>{s.reps ?? "—"}</span>
                  {rpe!=null && <> at <span style={{fontFamily:T.measured,fontSize:14}}>{rpe%1===0?rpe:rpe.toFixed(1)}</span></>}
                </span>
                {rpe!=null && <span aria-hidden="true" style={{width:24,height:heatMarkHeight(rpe),background:heatForRpe(rpe),borderRadius:T.rMark}}/>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{flex:1,minHeight:12}}/>

      {/* Effort — the commit moment. Drag the track; the button warms. */}
      {awaitRpe&&<EffortPanel onCommit={onCommit}/>}
      {ssRoundDone&&<EffortPanel onCommit={onCommit} label={`Round ${setNum} of ${block.sets} — how hard?`}/>}

      {!blocking&&(
        <>
          {isSS&&phase==="A"&&!restActive&&(
            <div style={{padding:"8px 20px 0",fontSize:13,color:T.ink3}}>
              Straight into B — no rest between exercises
            </div>
          )}
          {isSS&&phase==="A"&&restActive&&(
            <div style={{padding:"12px 20px 0"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontSize:13,color:T.ink2}}>Resting — <span style={{fontFamily:T.measured}}>{restStr}</span></span>
                <button onClick={()=>{setRestActive(false);setRestRemain(block.rest);}} style={{...linkBtn,fontSize:12,padding:"4px 8px"}}>Skip</button>
              </div>
              <RestProgressLine active={restActive} remain={restRemain} total={block.rest} />
            </div>
          )}
          {/* Superset partner reads BEFORE the action it explains. */}
          {isSS&&(
            <Card style={{margin:"14px 20px 0",padding:"13px 16px"}}>
              <div style={{fontSize:12,color:T.ink3,marginBottom:5,display:"flex",alignItems:"center",gap:5}}>
                {phase==="A"?<>Immediately after <Glyph name="arrowRight" size={10}/></>:<>Just completed <Glyph name="check" size={10}/></>}
              </div>
              <div style={{fontSize:17,fontWeight:500,color:phase==="A"?T.ink:T.ink3,lineHeight:1.2}}>{partnerEx?.name}</div>
              <div style={{fontSize:13,color:T.ink3,marginTop:3}}>
                {partnerEx?.weight!==null&&getW(partnerEx)?<><span style={{fontFamily:T.measured}}>{getW(partnerEx)}</span> kg · </>:""}<span style={{fontFamily:T.measured}}>{getR(partnerEx)}</span> reps
              </div>
            </Card>
          )}
          {/* Rest ring + Log — the thumb zone. The ring breathes while
              resting (±3.5%, 5.4s — felt, not seen); tap it to start/skip. */}
          {/* The reach — offered ONCE, on the last set of the headline lift,
              only on a day the user called fresh. Two doors, both optional;
              declining costs nothing and never asks again. Sits above the
              commit button, not below it: below the primary CTA the eye has
              already left, and a nudge nobody reads is worse than none. */}
          {canReach && !reachArmed && (
            <Fade>
              <div style={{margin:"14px 20px 0",paddingTop:12,borderTop:`1px solid ${T.rule}`}}>
                <div style={{fontSize:13,color:T.ink2}}>Last set, and you came in fresh.</div>
                <div style={{display:"flex",gap:8,marginTop:9,flexWrap:"wrap"}}>
                  <button className="forge-press" onClick={()=>{haptic.tap();onTakeReach?.("heavier");}}
                    style={{flex:"1 1 auto",minHeight:42,padding:"0 14px",background:"transparent",
                      border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",
                      fontFamily:T.text,fontSize:14,color:T.ink}}>
                    Take it up <MonoNums>{`+${reachStep}`}</MonoNums> kg
                  </button>
                  <button className="forge-press" onClick={()=>{haptic.tap();onTakeReach?.("bonus");}}
                    style={{flex:"1 1 auto",minHeight:42,padding:"0 14px",background:"transparent",
                      border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",
                      fontFamily:T.text,fontSize:14,color:T.ink}}>
                    One more set
                  </button>
                  <button onClick={()=>{haptic.tap();onDeclineReach?.();}}
                    style={{flexShrink:0,minHeight:42,padding:"0 10px",background:"none",border:"none",
                      cursor:"pointer",fontFamily:T.text,fontSize:13,color:T.ink3}}>
                    Not today
                  </button>
                </div>
                {/* The promise that makes it safe to say yes — and it is a
                    promise the engine actually keeps (lib/progression.js). */}
                <div style={{fontSize:12,color:T.ink3,marginTop:9,lineHeight:1.45}}>
                  Miss it and nothing is lost — a reach never counts against you.
                </div>
              </div>
            </Fade>
          )}
          {reachArmed && (
            <div style={{margin:"14px 20px 0",fontSize:13,color:T.ink3}}>
              Reaching. Nothing to lose.
            </div>
          )}
          <div style={{margin:"12px 20px 0",display:"flex",gap:12,alignItems:"center"}}>
            {showRestHint&&(
              <button
                onClick={()=>{if(restActive){setRestActive(false);setRestRemain(block.rest);}else{setRestRemain(block.rest);setRestActive(true);}}}
                aria-label={restActive?`Resting, ${restStr} left — tap to skip`:"Start rest timer"}
                className={restActive?"hw-breathe":undefined}
                style={{width:58,height:58,flexShrink:0,borderRadius:"50%",
                  border:`1px solid ${restActive?T.dayKey.strength:T.rule}`,
                  background:"transparent",cursor:"pointer",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontFamily:T.measured,fontSize:13,color:restActive?T.ink:T.ink2,
                  transition:`border-color 300ms ${T.ease}, color 300ms ${T.ease}`}}>
                {restActive?restStr:`${Math.round(block.rest/60)}:00`}
              </button>
            )}
            <button className="forge-press" onClick={()=>{haptic.tap();onLog();}}
              style={{flex:1,height:56,background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontFamily:T.text,fontSize:17,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong}}>
              {isSS?(phase==="A"?"Log A — into B":"Log B — round done"):"Log set"}
            </button>
          </div>
          {showRestHint&&restActive&&(
            <div style={{padding:"0 20px"}}>
              <RestProgressLine active={restActive} remain={restRemain} total={block.rest} />
            </div>
          )}
        </>
      )}
      {editTarget&&<DrumEditOverlay target={editTarget} workingWeights={workingWeights} setWW={setWW} workingReps={workingReps} setWR={setWR} block={block} onClose={()=>setEditTarget(null)}/>}
      {swapEx&&<SwapOverlay activeEx={activeEx} swapKey={swapKey} onSwap={onSwap} onClose={()=>setSwapEx(null)}/>}
      {showVid&&vidEx&&(
        <div onClick={()=>setShowVid(false)} className="forge-scrim forge-scrim-video" style={{overscrollBehavior:"contain",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} className="forge-sheet-ground forge-vellum" style={{padding:24,width:"100%",animation:`slideUp 280ms ${T.ease}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{...DISPLAY,fontSize:28,color:T.ink}}>{vidEx.name}</div>
                <div style={{fontSize:13,color:T.ink3,marginTop:5}}>{vidEx.muscle}</div>
              </div>
              <button onClick={()=>setShowVid(false)} aria-label="Close video" style={{background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.rSm,padding:"8px 10px",cursor:"pointer"}}><Glyph name="cross" size={12} color={T.ink2}/></button>
            </div>
            <VideoEmbed vid={resolveVid(vidEx.name, vidEx.vid)} name={vidEx.name}/>
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
function VideoEmbed({vid,name}){
  const [failed,setFailed]=useState(false);
  if(!vid||failed){
    return(
      <div style={{width:"100%",aspectRatio:"16/9",background:T.surface,borderRadius:T.r,boxShadow:T.elev,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10}}>
        <span style={{fontSize:13,color:T.ink2}}>
          {!vid?"No demo video linked yet":"Video unavailable here"}
        </span>
        <a
          href={vid
            ? `https://www.youtube.com/watch?v=${vid}`
            : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} form`)}`}
          target="_blank" rel="noopener noreferrer"
          style={{fontSize:13,color:T.ink,fontWeight:500,textDecoration:"none"}}>
          {vid?"Watch on YouTube":"Search YouTube"} <Glyph name="arrowUpRight" size={11}/>
        </a>
      </div>
    );
  }
  return(
    <iframe
      key={vid}
      src={`https://www.youtube.com/embed/${vid}?autoplay=0&modestbranding=1&rel=0`}
      style={{width:"100%",aspectRatio:"16/9",border:"none",borderRadius:T.r,background:T.ground,display:"block"}}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      onError={()=>setFailed(true)}
    />
  );
}

// ─── Swap Overlay ────────────────────────────────────────────────────────────

function SwapOverlay({activeEx,swapKey,onSwap,onClose}){
  // The travel filter that used to live here is retired (2026-08-04). It was
  // per-exercise and per-open, and every main lift's swap list is
  // heavy-equivalents-only, so the anchor of every session answered "no
  // alternatives for the current filter". Travel is a session-level mode now
  // — see lib/travel.js and the readiness check-in.
  const options=SWAP_DB[activeEx?.name]||[];

  const applySwap=(option)=>{
    // Inherit reps from the current slot — same movement pattern, same
    // stimulus level. loadType is resolved HERE, at selection: the weight
    // prefill only carries over when the load semantics match.
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
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} className="forge-sheet-ground forge-vellum" style={{padding:"24px 24px 36px",width:"100%",animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>
        <div style={{marginBottom:6}}>
          <div style={{fontSize:13,color:T.ink3,marginBottom:6}}>Swap exercise</div>
          <div id={titleId} style={{...DISPLAY,fontSize:28,color:T.ink}}>{activeEx?.name}</div>
        </div>
        {options.length===0&&(
          <div style={{marginTop:14,padding:"20px 0",fontSize:13,color:T.ink3,textAlign:"center"}}>No approved alternatives for this lift</div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {options.map((o,i)=>(
            <button key={i} onClick={()=>applySwap(o)} style={{padding:"13px 16px",background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.r,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",textAlign:"left",fontFamily:T.text}}>
              <span>
                <span style={{fontSize:15,fontWeight:500,color:T.ink,display:"block"}}>{o.name}</span>
                <span style={{fontSize:12,color:T.ink3,marginTop:2,display:"block"}}>{o.muscle}</span>
              </span>
              <span style={{fontSize:12,color:T.ink3,flexShrink:0,marginLeft:12}}>{o.eq}</span>
            </button>
          ))}
        </div>
        <div style={{marginTop:14,fontSize:12,color:T.ink3,textAlign:"center"}}>Tap an exercise to swap for this set</div>
        {/* House pattern: actions live on the bottom row, no corner ✕ */}
        <button onClick={onClose} style={{marginTop:12,width:"100%",padding:"14px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontSize:14,color:T.ink2,fontFamily:T.text}}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Drum Edit ────────────────────────────────────────────────────────────────
// The split drum: integer and decimal wheels scroll independently, decimal
// steps derived per-lift from the equipment increment (leg press: .0 only;
// lateral raise: .0/.25/.5/.75). Depth from tonal falloff + type scale —
// zero blur, no glass cylinder.
function DrumEditOverlay({target,workingWeights,setWW,workingReps,setWR,block,onClose}){
  const ex=block.type==="main"?block.ex:(target.exName===block.exA?.name?block.exA:block.exB);
  const initKg  =workingWeights[target.exName]??ex?.weight??0;
  const rawReps =workingReps[target.exName]??ex?.reps;
  // Timed exercises (prescribed "20s") seed from the parsed seconds.
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
  // whole-kg jumps, barbells take 1.25kg micro-plates, cables move in
  // fixed-stack increments.
  const lt = getLoadType(ex);
  const weightStep = weightStepForLoadType(lt);
  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} className="forge-sheet-ground forge-vellum" style={{padding:"24px 24px 32px",width:"100%",animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>
        <div style={{marginBottom:18}}>
          <div id={titleId} style={{...DISPLAY,fontSize:28,color:T.ink}}>{target.exName}</div>
          <div style={{fontSize:13,color:T.ink3,marginTop:5}}>Scroll to adjust</div>
        </div>
        <div style={{display:"flex",gap:16,justifyContent:hasWeight?"space-between":"center"}}>
          {hasWeight&&<SplitWeightDrum value={kg} onChange={setKg} step={weightStep} min={0} max={400} label={lt==="per_db"?"kg / db":"kg"}/>}
          <ScrollDrum value={reps} onChange={setReps} step={target.timed?5:1} min={target.timed?5:1} max={target.timed?180:30} integer label={target.timed?"sec":"reps"} unit={target.timed?"sec":undefined}/>
        </div>
        {/* House pattern: Cancel/Confirm on the bottom row, no corner ✕.
            Drum edits are LOCAL state — Cancel is a true discard. */}
        <div style={{display:"flex",gap:10,marginTop:24}}>
        <button onClick={onClose} style={{flex:1,padding:"16px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontSize:14,color:T.ink2,fontFamily:T.text}}>Cancel</button>
        <button onClick={()=>{
          if(hasWeight) setWW(p=>({...p,[target.exName]:kg}));
          setWR(p=>({...p,[target.exName]:reps}));
          onClose();
        }} style={{flex:2,padding:"16px",background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:16,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong,display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
          Confirm <Glyph name="arrowRight" size={13}/>
        </button>
        </div>
      </div>
    </div>
  );
}

// ─── Done ──────────────────────────────────────────────────────────────────────
// The done screen is a reward for the person who lingers after "complete" —
// the copy pays the stare, not just the glance. Factual-proud headlines;
// the display face takes its ceremony weight (500) here.
const DONE_HEADLINES = [
  ["Heavy,", "handled."],
  ["The bar", "moved."],
  ["Nothing", "wasted."],
  ["That", "counted."],
  ["Mmm.", "Felt that."],
  ["Gonna feel", "that tomorrow."],
];
// Each type is a pool, picked at random per done-screen so the same "next"
// reads fresh across a block. One charged line paired with one clean/
// specific one per pool.
const NEXT_DAY_MSG = {
  strength: [
    "Strength session next. Come strong.",
    "Strength next. The good kind of heavy.",
    "Strength next. Ready for the squeeze.",
    "Strength next. Grip it and mean it.",
  ],
  zone2: [
    "Zone 2 tomorrow. 60 min, conversational pace.",
    "Zone 2 tomorrow. This is how you learn to last.",
  ],
  cardio: [
    "Moderate cardio tomorrow. 35 min at ~75%.",
    "Cardio tomorrow. Half an hour. Get sweaty.",
  ],
  hiit: [
    "HIIT tomorrow. 8–10 rounds, all out.",
    "HIIT tomorrow. Short, brutal, obscenely satisfying. Over before you hate it.",
  ],
  rest: [
    "Rest day tomorrow. Feed it, sleep on it, come back hungry.",
    "Rest day tomorrow. Do gloriously little.",
  ],
};

export function DoneScreen({session,profileName,workingWeights,sessionStartWeights={},userWeek=WEEK,onHome,deloadCompleted=false,returnGapDays=null}){
  // `base` = what the user lifted at SESSION START (snapshotted at
  // readiness). Falls back to the current working weight if no snapshot.
  const nudges = session.blocks.filter(b=>b.type==="main").map(b=>{
    const current = workingWeights[b.ex.name] ?? b.ex.weight;
    const base    = sessionStartWeights[b.ex.name] ?? current;
    return { ex:b.ex.name, base, current, changed: current !== base };
  });

  // Pick a random headline pair, stable for this render
  const [hi] = useState(()=>DONE_HEADLINES[Math.floor(Math.random()*DONE_HEADLINES.length)]);

  // Derive what's next
  const todayIdx= mondayIndex(new Date());
  const nextIdx = (todayIdx+1) % 7;
  const nextType= userWeek[nextIdx]?.type ?? "rest";
  const [nextMsg] = useState(() => {
    const pool = NEXT_DAY_MSG[nextType] ?? [""];
    return pool[Math.floor(Math.random() * pool.length)];
  });

  // Sync status for confirmation line
  const [syncState, setSyncState] = useState(SyncStatus.get());
  useEffect(() => SyncStatus.subscribe(setSyncState), []);

  return (
    <div style={{maxWidth:430,margin:"0 auto",padding:"72px 24px 48px",position:"relative",overflow:"clip"}}>
      <Fade d={0}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:12}}>
          {profileName} · {session.name}
        </div>
        <h1 style={{...DISPLAY,fontWeight:500,fontSize:46,color:T.ink,marginBottom:12}}>
          {hi[0]}<br/>{hi[1]}
        </h1>
        <p style={{fontSize:14,color:T.ink2,marginBottom:30,lineHeight:1.6}}><MonoNums>{nextMsg}</MonoNums></p>
      </Fade>
      {nudges.length > 0 && (
        <Fade d={80}>
          <div style={{fontSize:13,color:T.ink3,paddingBottom:8,borderBottom:`1px solid ${T.rule}`}}>Main lifts</div>
        </Fade>
      )}
      {nudges.map((n,i)=>(
        <Fade key={i} d={120+i*60}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"13px 0",borderBottom:`1px solid ${T.ruleFaint}`}}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:14,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.ex}</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:3}}>
                {n.changed?"Next time, heavier.":"Hold — grind it smooth."}
              </div>
            </div>
            <div style={{fontFamily:T.measured,fontSize:18,flexShrink:0,color:T.ink}}>
              {n.base}{n.changed&&<span style={{color:T.heat[3]}}> <Glyph name="arrowRight" size={11} color={T.heat[3]}/> {n.current}</span>}<span style={{fontSize:12,color:T.ink3}}> kg</span>
            </div>
          </div>
        </Fade>
      ))}
      {/* One-line acknowledgement when this session crossed the
          auto-completion threshold for an active deload. */}
      {deloadCompleted && (
        <Fade d={240}>
          <div style={{marginTop:24,textAlign:"center",fontSize:14,color:T.ink2}}>
            Deload complete. Welcome back.
          </div>
        </Fade>
      )}
      {/* "Back at it" — first strength session after >7 days away. Coming
          back IS the win, no apology owed. */}
      {!deloadCompleted && returnGapDays != null && (
        <Fade d={240}>
          <div style={{marginTop:24,textAlign:"center",fontSize:14,color:T.ink2}}>
            Back at it — first one in <span style={{fontFamily:T.measured}}>{returnGapDays}</span> days. Coming back is what counts.
          </div>
        </Fade>
      )}
      <Fade d={260}>
        <button className="forge-press" onClick={onHome} style={{marginTop:24,width:"100%",height:56,background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:17,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong,display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
          Home <Glyph name="arrowRight" size={13}/>
        </button>
      </Fade>

      {/* Sync confirmation line */}
      <Fade d={320}>
        <div style={{marginTop:24,textAlign:"center",fontSize:12,color:T.ink3,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          {syncState.state === "idle" || syncState.state === "pushing" ? (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.ink2}}/>
              Synced
            </>
          ) : syncState.state === "pulling" ? (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.ink3,animation:"pulse 1s ease-in-out infinite"}}/>
              Syncing…
            </>
          ) : (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.heat[2]}}/>
              Saved locally · syncs when online
            </>
          )}
        </div>
      </Fade>
    </div>
  );
}
