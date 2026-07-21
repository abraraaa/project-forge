"use client";

// components/HomeScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The home screen, extracted verbatim from ForgeApp.jsx (PR3 3e-prep —
// decomposition before the Home/Session route split). Pure presentation +
// local UI state: every mutation and navigation goes through props (onBegin,
// onMarkDayDone, onProfile, …) — the block contains no storage primitives,
// so ForgeApp keeps sole ownership of app-state writes.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";
import { T } from "@/lib/tokens";
import { Fade, Card, Tag } from "@/components/ui";
import { useModalA11y, useGrainTouch } from "@/lib/a11y";
import { DAY_CONFIG, DAY_NAMES, bonusForDay, ROTATION_AUTO, ROTATION_OPTIONAL, SESSIONS, applyFocusToSession, applyRotationToSession } from "@/lib/programme";
import { deloadCardCopy } from "@/lib/progression";
import { formatTonnage } from "@/lib/analytics";

// Human-readable "X ago" — tuned for < 12h windows (draft expiry cutoff).
// Moved with HomeScreen (its only caller) from ForgeApp module scope.
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

export default
function HomeScreen({rhythm,profileName,userWeek,strengthDaySessions,onEditWeek,onBegin,onProfile,weekDone={},onMarkDayDone,bonusDone={},onMarkBonusDone,programmeBlock,weeksOnBlock,onRotate,onResetProgramme,userFocus="Forged",onEditFocus,onPerformance,onLockerRoom,historyCount=0,recoveryNudge=null,onDismissRecovery,syncState="idle",pendingDraft=null,onResumeDraft,onDiscardDraft,showBwCard=false,onOpenBwEdit,onDismissBwCard,deloadOffer=null,onAcceptDeload,onDismissDeload,untickedDays=[],onOpenRetroPicker,retroToast=null,onDismissRetroToast,pnStage="hidden",pnBusy=false,pnError=null,pnSuccessToast=false,onPnRegister,onPnSnooze,onPnDismissToast,tonnageMilestone=null,tonnageTotalKg=0,onDismissTonnageMilestone,resting=false,absenceNudge=null,onOpenBreather,onDismissAbsenceNudge}){
  // Grain-under-finger (tactility batch 3) — Home until device-verified.
  // One hook instance; handlers read e.currentTarget so the same spread
  // works on every card. The print survives the tap-triggered re-render
  // because it's a data attribute + commit-on-tap (see useGrainTouch).
  const grain = useGrainTouch();
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
  //
  // strength + hiit `top` moved from -120 → 0 so the rim's gradient is fully
  // transparent at content y=0 (status bar adjacency). Without that, the rim
  // painted warm tint right at the top edge while the system status bar
  // rendered neutral dark, creating the seam we'd been masking with overlays.
  // Fixing the source instead.
  const dayRim = ({
    strength: { top: 0,     right: -80,    width: 360, height: 320 },
    zone2:    { bottom: 24, left: -80,  width: 420, height: 360 },
    hiit:     { top: 0,     left: -80,     width: 320, height: 280 },
    cardio:   { top: "30%", right: -120,  width: 360, height: 320 },
    rest:     { top: "40%", left: "20%",  width: 280, height: 240 },
  })[viewDay.type] || { top: -120, right: -80, width: 360, height: 320 };

  return (
    <div style={{minHeight:"100vh",paddingBottom:48,position:"relative",overflow:"clip"}}>
      {/* Primary ambient glow — top-centre, day-typed. The dominant signal.
          top:0 (was -180) keeps the gradient's bright centre at content
          y≈250 instead of y≈70, which leaves the topmost ~80px of content
          at native body bg #131110. That's what the system status bar
          renders, so there's no longer a perceived seam between the
          status-bar zone and content's top edge — the original "black
          hole" complaint, resolved at the source rather than via overlay.
          forge-glow-anchor (globals.css) drifts this layer down at a
          fraction of scroll speed via a scroll-driven animation, so the
          glass cards slide THROUGH the colour field as the page scrolls —
          the backdrop-filter tint shifts and the surfaces read as depth.
          Only this dominant layer drifts: the rim glows below are tied to
          page geometry (zone2/focus rims are bottom-anchored, where a
          downward drift would push them out of view at page end). */}
      <div className="forge-glow-anchor" style={{
        position:"absolute",top:0,left:"50%",transform:"translateX(-50%)",
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
          it never competes with the day-type signal above. bottom:24 (was
          -100), deliberately: a bottom-anchored glow box that crosses the
          document end gets cut mid-gradient at the page edge and reads as a
          hard warm "chin" against the chrome zone below (found on device —
          gold on every screen, since this is focus- not day-accent). Same
          constraint applies to the zone2 dayRim above. */}
      <div style={{
        position:"absolute",bottom:24,right:-60,
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
            <StreakBadge rhythm={rhythm} resting={resting}/>
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
              <span style={{marginLeft:2}}>→</span>
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
            // Done = any completion on that date — strength session or
            // manual non-strength tick. Sourced from the Day entity via
            // Days.projectCurrentWeek; isn't affected by schedule edits.
            const isDone  = !!weekDone[i];
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

      {/* Day headline — driven by viewIdx. className="home-headline" hooks
          the scroll-timeline compression in globals.css: gentle scale +
          opacity dim over the first 180px of scroll, so the hero feels
          like something you're moving past, not stranded above content. */}
      <Fade d={100}>
        <div className="home-headline" style={{padding:"28px 24px 0"}}>
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
                <span style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:accent.main,fontStyle:"italic"}}>Session complete. You&apos;ll feel that tomorrow.</span>
              </div>
            ) : isViewingToday ? (
              <button {...grain} className={`${grain.className} forge-press`} onClick={onBegin} style={{
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
          {/* Same accent top-rim as the strength session card — every day
              type's card leads with its own colour, not just strength. */}
          <Card style={{margin:"24px 24px 0",padding:0,overflow:"hidden"}}>
            <div style={{height:2,background:`linear-gradient(90deg,${accent.main},${accent.main}00)`,transition:`background 400ms ${T.ease}`}}/>
            <div style={{padding:"20px 22px 24px"}}>
              <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:16}}>
                {viewDay.type==="rest" ? "Recovery notes" : "Session notes"}
              </div>
              {cfg.tips.map((tip,i)=>(
                <div key={i} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"8px 0",borderBottom:i<cfg.tips.length-1?`1px solid ${T.bg3}`:"none"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:accent.main,flexShrink:0,marginTop:5,transition:`background 300ms ${T.ease}`}}/>
                  <span style={{fontSize:13,color:T.text2,lineHeight:1.5}}>{tip}</span>
                </div>
              ))}
            </div>
          </Card>
        </Fade>
      )}
      {!cfg.canBegin && isViewingToday && (
        <Fade d={220}>
          {weekDone[todayIdx] ? (
            <div style={{margin:"12px 24px 0",padding:"16px 20px",background:`${accent.main}10`,border:`1px solid ${accent.main}40`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:18,color:accent.main}}>✓</span>
              <span style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:accent.main,fontStyle:"italic"}}>Done. Rhythm kept.</span>
            </div>
          ) : (
            <button className="forge-press" onClick={()=>onMarkDayDone(viewDateStr)} style={{
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
          {/* Accent top-rim, matching the day cards above. */}
          <Card style={{margin:"16px 24px 0",padding:0,overflow:"hidden"}}>
            <div style={{height:2,background:`linear-gradient(90deg,${accent.main},${accent.main}00)`,transition:`background 400ms ${T.ease}`}}/>
            <div style={{padding:"18px 20px 20px"}}>
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
                <button className="forge-press" onClick={()=>onMarkBonusDone(viewDateStr)} aria-label="Mark bonus complete" style={{
                  width:"100%",padding:"12px 16px",background:"transparent",
                  border:`1px solid ${accent.main}66`,borderRadius:T.r.md,cursor:"pointer",
                  display:"flex",alignItems:"center",justifyContent:"space-between",
                }}>
                  <span style={{fontSize:14,fontWeight:500,color:accent.main}}>Mark bonus done</span>
                  <span style={{fontSize:14,color:accent.main}}>+</span>
                </button>
              )}
            </div>
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
              <button className="forge-press" onClick={onResumeDraft}
                style={{flex:1,padding:"12px 16px",background:T.coral,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.bg0}}>
                Resume →
              </button>
              <button className="forge-press" onClick={onDiscardDraft}
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
          <div {...grain} className={`${grain.className} forge-press`} onClick={onOpenBwEdit}
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
                <button className="forge-press" onClick={onAcceptDeload}
                  style={{flex:1,padding:"12px 16px",background:T.coral,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0}}>
                  Run the deload →
                </button>
                <button className="forge-press" onClick={onDismissDeload}
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
          <button className="forge-press" onClick={onDismissTonnageMilestone}
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

      {/* Absence nudge — slides in when a breather-worthy gap is detected
          (ForgeApp derives it from lib/absence.js). Leads with the welcome,
          not "you're quitting": "here for a session" is answered by the
          Begin button above; this offers the breather door. Suppressed while
          already resting. Copy signed off 2026-07-06. */}
      {absenceNudge && onOpenBreather && (
        <Fade d={185}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.gold}0E`,border:`1px solid ${T.gold}38`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:7}}>
                  No drama
                </div>
                <p style={{fontSize:14,color:T.text1,lineHeight:1.55,margin:0}}>
                  {absenceNudge.days} days off. Here for a session, or need a breather? No wrong answer.
                </p>
              </div>
              <button onClick={onDismissAbsenceNudge} aria-label="Dismiss"
                style={{flexShrink:0,background:"none",border:"none",padding:"4px 8px",cursor:"pointer",fontSize:14,color:T.text3,fontFamily:T.sans}}>✕</button>
            </div>
            <button className="forge-press" onClick={onOpenBreather}
              style={{marginTop:14,padding:"9px 16px",background:"none",border:`1px solid ${T.gold}66`,borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.gold}}>
              Take a breather
            </button>
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
              style={{width:"100%",padding:"12px 16px",background:T.coral,border:"none",borderRadius:T.r.md,cursor:pnBusy?"default":"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0,opacity:pnBusy?0.6:1}}>
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

      {/* Rotation nudge — surfaces at ROTATION_OPTIONAL weeks on a block */}
      {weeksOnBlock >= ROTATION_OPTIONAL && (
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
              <button className="forge-press" onClick={handleRotateTap} style={{flexShrink:0,marginTop:2,padding:"10px 16px",background:T.gold,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0}}>
                {offerRotationChoice ? "Choose →" : "Rotate →"}
              </button>
            </div>
          </div>
        </Fade>
      )}

      {/* Performance Lab entry — always visible, becomes active once data exists */}
      <Fade d={260}>
        {/* forge-raised: the bevel material (device-judged B2, 2026-07-13).
            Its background/border ARE the material — the old inline bg2 +
            border are removed, and the old `transition: all` went with them
            (it would tween box-shadow, the exact jiggle B1 was rejected
            for; forge-press owns the motion). */}
        <div {...grain} className={`${grain.className} forge-press forge-raised`} onClick={onPerformance}
          style={{margin:"20px 24px 0",padding:"18px 20px",borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
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

        {/* Locker Room — the body surface (Lab = what you lift; Locker Room =
            what it's doing to you). Chart is ungated; photos live behind the
            "Show photos" door on the page itself. COPY: draft, intimacy pass
            pending. */}
        <div {...grain} className={`${grain.className} forge-press forge-raised`} onClick={onLockerRoom}
          style={{margin:"12px 24px 0",padding:"14px 20px",borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:3}}>
              Locker room
            </div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.5,fontFamily:T.serif,fontStyle:"italic"}}>
              Bodyweight · progress photos, kept private
            </div>
          </div>
          <div style={{flexShrink:0,width:34,height:34,borderRadius:"50%",background:T.bg3,border:`1px solid ${T.bg4}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontSize:14,color:T.text3}}>→</span>
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

function RotationChoiceModal({ weeksOnBlock, currentFocus, onRefresh, onChangeFocus, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "rotation-choice-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground" style={{background:T.bg2,padding:"28px 24px 32px",width:"100%",borderTop:`1px solid ${T.gold}44`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
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
          <div style={{fontSize:12,color:T.text2,lineHeight:1.5}}>Switch to a different goal (Forged / Strong / Sculpt). Accessories re-rotate with the new bias.</div>
        </button>

        <button onClick={onCancel}
          style={{marginTop:16,padding:"10px",background:"none",border:"none",cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans,alignSelf:"center"}}>
          Not now
        </button>
      </div>
    </div>
  );
}

function StreakBadge({rhythm, resting=false}){
  // Resting: a breather is active, so the rhythm pauses rather than showing
  // a number that would only tick down. Calm dot + "Resting", no ratio.
  if (resting) {
    return (
      <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.pill,padding:"8px 16px",display:"flex",alignItems:"center",gap:9}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:T.sage,display:"inline-block",flexShrink:0}}/>
        <div style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",lineHeight:1.5}}>Resting<br/>on a breather</div>
      </div>
    );
  }
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
  const secondary = over ? `of ${expected} · strong` : `of ${expected}`;
  return (
    <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.pill,padding:"8px 16px",display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontFamily:T.serif,fontSize:22,fontWeight:400,color:T.gold,lineHeight:1}}>{primary}</span>
      <div style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",lineHeight:1.5}}>{secondary}<br/>past {window} days</div>
    </div>
  );
}
