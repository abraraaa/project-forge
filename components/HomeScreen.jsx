"use client";

// components/HomeScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The home screen — Bone & Ember. Pure presentation + local UI state: every
// mutation and navigation goes through props (onBegin, onMarkDayDone,
// onProfile, …) — the block contains no storage primitives, so ForgeApp
// keeps sole ownership of app-state writes.
//
// Surface grammar on this screen: the day is the noun that matters (Bodoni,
// 46px), its identity carries the day key as a hairline under the name and
// as ticks on the week strip. Numbers sit on the ground between hairlines
// (readiness/stats row, tonnage wave, session list). Only documents (the
// prompt cards) and commit actions (Begin) get surfaces.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useRef } from "react";
import { T, DISPLAY, heatForRpe, heatMarkHeight } from "@/lib/tokens";
import { Fade, Card, Tag, MonoNums } from "@/components/ui";
import Glyph from "@/components/Glyph";
import { useModalA11y } from "@/lib/a11y";
import { DAY_CONFIG, DAY_NAMES, bonusForDay, ROTATION_AUTO, ROTATION_OPTIONAL, SESSIONS, applyFocusToSession, applyRotationToSession } from "@/lib/programme";
import { deloadCardCopy } from "@/lib/progression";
import { formatTonnage, weeklyTonnage } from "@/lib/analytics";

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

// The planned proximity-to-failure per block type — main lifts and
// accessories are prescribed around rpe 8, finishers run closer to the
// ceiling. Drives the heat mark on the session preview rows (colour +
// height + the printed number: the redundancy law).
const BLOCK_RPE = { main: 8, superset: 8, finisher: 9 };

// Shared quiet text-button style (links, dismissals).
const linkBtn = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  fontFamily: T.text, fontSize: 13, color: T.ink3,
  display: "inline-flex", alignItems: "center", gap: 5,
};

export default
function HomeScreen({rhythm,profileName,userWeek,strengthDaySessions,onEditWeek,onBegin,onProfile,weekDone={},onMarkDayDone,bonusDone={},onMarkBonusDone,programmeBlock,weeksOnBlock,onRotate,onResetProgramme,userFocus="Forged",onEditFocus,onPerformance,onLockerRoom,historyCount=0,history=[],recoveryNudge=null,onDismissRecovery,syncState="idle",pendingDraft=null,onResumeDraft,onDiscardDraft,showBwCard=false,onOpenBwEdit,onDismissBwCard,deloadOffer=null,onAcceptDeload,onDismissDeload,untickedDays=[],onOpenRetroPicker,retroToast=null,onDismissRetroToast,pnStage="hidden",pnBusy=false,pnError=null,pnSuccessToast=false,onPnRegister,onPnSnooze,onPnDismissToast,tonnageMilestone=null,tonnageTotalKg=0,onDismissTonnageMilestone,resting=false,absenceNudge=null,onOpenBreather,onDismissAbsenceNudge}){
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
  // The anchor re-arms only when the CALENDAR DAY changes (foreground/focus/
  // minute tick) — same-day events keep the anchor, so renders stay stable.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const reanchor = () => setNowMs((prev) => {
      const now = Date.now();
      return new Date(prev).toDateString() === new Date(now).toDateString() ? prev : now;
    });
    document.addEventListener("visibilitychange", reanchor);
    window.addEventListener("focus", reanchor);
    const id = setInterval(reanchor, 60_000);
    return () => { document.removeEventListener("visibilitychange", reanchor); window.removeEventListener("focus", reanchor); clearInterval(id); };
  }, []);
  const dow      = new Date(nowMs).getDay(); // 0=Sun
  const weekMap  = [6,0,1,2,3,4,5];    // JS day → WEEK index (Mon=0 … Sun=6)
  const todayIdx = weekMap[dow];

  const [viewIdx, setViewIdx] = useState(todayIdx);

  const viewDay        = userWeek[viewIdx];
  const cfg            = DAY_CONFIG[viewDay.type] || DAY_CONFIG.rest;
  const dayKey         = T.dayKey[viewDay.type] || T.dayKey.rest;
  const isViewingToday = viewIdx === todayIdx;

  // Optional cardio-day bonus for the VIEWED day. bonusForDay returns null for
  // ineligible day types, so this is the only guard needed. Local date string
  // (not toISOString — avoids the UTC day-shift).
  const _vd = new Date(nowMs);
  _vd.setDate(_vd.getDate() + (viewIdx - todayIdx));
  const viewDateStr = `${_vd.getFullYear()}-${String(_vd.getMonth()+1).padStart(2,"0")}-${String(_vd.getDate()).padStart(2,"0")}`;
  const dayBonus   = bonusForDay(viewDateStr, viewDay.type);

  // Resolve which session to preview for the viewed day (null for non-strength days)
  const viewSessionIdx = strengthDaySessions[viewIdx];
  const rawViewSession = viewSessionIdx !== undefined ? SESSIONS[viewSessionIdx] : null;
  // Chain rotation → focus so the home preview shows the user's actual
  // accessories (not the template defaults).
  const rotatedViewSession = rawViewSession ? applyRotationToSession(rawViewSession, programmeBlock?.config) : null;
  const viewSession    = rotatedViewSession ? applyFocusToSession(rotatedViewSession, userFocus, programmeBlock?.config) : null;

  // Guidance line under the display name. Strength days lead with the
  // session's own noun; non-strength days keep their modality detail.
  const blockTenureCopy = weeksOnBlock >= 1
    ? `${weeksOnBlock} week${weeksOnBlock === 1 ? "" : "s"} in`
    : "fresh block";
  // Masthead support is exactly ONE sentence (§11.3); focus + block tenure
  // live in the rotation footer, not the masthead.
  const subText = viewSession ? `${viewSession.subtitle}.` : cfg.sub;

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

  // Six-week tonnage wave — the week's work as a line that heats as it
  // climbs. Hidden until any week has logged work (first-run: no fake data).
  const wave = useMemo(() => weeklyTonnage(history, 6), [history]);
  const waveMax = Math.max(...wave.map(w => w.kg), 1);
  const hasWave = wave.some(w => w.kg > 0);

  return (
    <div style={{minHeight:"100vh",paddingBottom:48,position:"relative",overflow:"clip"}}>

      {/* Header — date on the left, identity on the right. Quiet. */}
      <Fade d={0}>
        <div style={{padding:"52px 24px 0",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16}}>
          <div>
            <div style={{fontSize:13,color:T.ink3}}>
              {new Date(nowMs).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}
            </div>
            <StreakLine rhythm={rhythm} resting={resting}/>
          </div>
          <button onClick={onProfile} style={{...linkBtn,fontWeight:500,display:"flex",alignItems:"center",gap:6,paddingTop:1}}>
            {profileName}
            {syncState === "pulling" || syncState === "pushing" ? (
              <span style={{width:6,height:6,borderRadius:"50%",background:T.ink3,animation:"pulse 1s ease-in-out infinite"}}/>
            ) : syncState === "error" ? (
              <span style={{width:6,height:6,borderRadius:"50%",background:T.heat[3],opacity:0.7}}/>
            ) : null}
            <Glyph name="arrowRight" size={12}/>
          </button>
        </div>
      </Fade>

      {/* Week strip — tappable. Day-type keys colour the tick under each
          day (keys on session identifiers only — this is exactly that).
          Done days fill their tick solid with a printed ✓; the viewed day
          carries an ink underline; today's label is full ink. */}
      <Fade d={60}>
        <div style={{padding:"26px 24px 0",display:"flex",gap:6}}>
          {userWeek.map((d,i)=>{
            const key     = T.dayKey[d.type] || T.dayKey.rest;
            const isToday = i === todayIdx;
            const isView  = i === viewIdx;
            const isDone  = !!weekDone[i];
            return (
              <button key={i} onClick={()=>setViewIdx(i)} className="forge-press"
                aria-label={`${DAY_NAMES[i]}${isToday ? " (today)" : ""}${isDone ? ", done" : ""}`}
                aria-current={isView ? "date" : undefined}
                style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:7,cursor:"pointer",background:"none",border:"none",padding:"6px 0 4px"}}>
                {/* Weekday glyph carries the day; the key tick below
                    carries the type — no room for two words per cell. */}
                <span style={{
                  fontSize:12,fontWeight:isToday||isView?600:400,
                  color:isToday?T.ink:isView?T.ink2:T.ink3,
                  transition:`color 200ms ${T.ease}`,lineHeight:1,
                }}>{DAY_NAMES[i].slice(0,3).toLowerCase()}</span>
                <span style={{position:"relative",width:18,height:9,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
                  <span style={{
                    width:18,height:isDone?5:3,
                    background:key,
                    opacity:isDone?1:isToday||isView?0.9:0.45,
                    transition:`all 200ms ${T.ease}`,
                  }}/>
                  {isDone && (
                    <span style={{position:"absolute",top:-11,lineHeight:1}}><Glyph name="check" size={9} color={key}/></span>
                  )}
                </span>
                <span style={{width:18,height:1,background:isView?T.ink:"transparent",transition:`background 200ms ${T.ease}`}}/>
              </button>
            );
          })}
        </div>
        {onEditWeek && (
          <div style={{display:"flex",justifyContent:"center",marginTop:6}}>
            <button onClick={onEditWeek} style={{...linkBtn,fontSize:12,padding:"4px 8px"}}>
              Edit week <Glyph name="arrowRight" size={11}/>
            </button>
          </div>
        )}
      </Fade>

      {/* Day headline — the noun that matters, in the display voice.
          className="home-headline" hooks the scroll-timeline compression in
          globals.css. The day key runs as a hairline under the name. */}
      <Fade d={100}>
        <div className="home-headline" style={{padding:"26px 24px 0",transformOrigin:"left top"}}>
          <div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:8}}>
            <span style={{fontSize:13,color:T.ink3}}>{dayLabel}</span>
            {!isViewingToday && (
              <span style={{fontSize:12,color:T.ink3}}>
                {viewDate.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}
              </span>
            )}
          </div>
          <h1 style={{...DISPLAY,fontSize:46,color:T.ink,margin:0}}>
            {DAY_NAMES[viewIdx]}
          </h1>
          <div aria-hidden="true" style={{width:40,height:3,background:dayKey,marginTop:10,transition:`background 300ms ${T.ease}`}}/>
          {subText && (
            <div style={{fontSize:16,color:T.ink2,marginTop:11,lineHeight:1.45,maxWidth:"32ch"}}>
              <MonoNums>{subText}</MonoNums>
            </div>
          )}
        </div>
      </Fade>

      {/* Strength day — session stats + list, on the ground between
          hairlines. No card: measured data gets no containers. */}
      {cfg.canBegin && viewSession && (
        <>
          <Fade d={160}>
            {(()=>{
              const supersets = viewSession.blocks.filter(b=>b.type==="superset").length;
              return (
                <div style={{margin:"20px 0 0",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,display:"flex"}}>
                  {[[String(viewSession.blocks.length),"blocks"],["~65","minutes"],[String(supersets),"supersets"]].map(([v,l],i)=>(
                    <div key={l} style={{flex:1,padding:i===0?"13px 0 13px 24px":i===2?"13px 24px 13px 18px":"13px 0 13px 18px",borderLeft:i>0?`1px solid ${T.rule}`:"none"}}>
                      <div style={{fontFamily:T.measured,fontSize:26,color:T.ink,letterSpacing:"-0.04em",lineHeight:1}}>{v}</div>
                      <div style={{fontSize:12,color:T.ink3,marginTop:3}}>{l}</div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {/* Session list — every row prints the prescription, the heat
                mark encodes the planned proximity to failure in colour AND
                height, and the number is always printed. */}
            <div style={{padding:"2px 24px 0"}}>
              {viewSession.blocks.map((b)=>{
                const rpe   = BLOCK_RPE[b.type] ?? 8;
                const name  = b.type==="main"
                  ? b.ex.name
                  : `${(b.exA||b.ex).name} ↔ ${(b.exB||b.ex).name}`;
                const reps  = b.type==="main" ? b.ex.reps : (b.exA?.reps||b.exB?.reps);
                const w     = b.type==="main" ? b.ex.weight : (b.exA?.weight ?? b.exB?.weight);
                return (
                  <div key={b.id} style={{display:"flex",alignItems:"center",gap:13,padding:"11px 0",borderBottom:`1px solid ${T.ruleFaint}`}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:16,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</div>
                      <div style={{fontSize:13,color:T.ink3,marginTop:2}}>
                        <span style={{fontFamily:T.measured}}>{b.sets} × {reps}</span>
                        {w != null && <> from <span style={{fontFamily:T.measured}}>{w}</span> kg</>}
                      </div>
                    </div>
                    <span aria-hidden="true" style={{width:24,height:heatMarkHeight(rpe),background:heatForRpe(rpe),borderRadius:T.rMark,flexShrink:0,alignSelf:"center"}}/>
                    <span style={{width:42,textAlign:"right",fontSize:13,color:T.ink2,flexShrink:0}}>rpe <span style={{fontFamily:T.measured}}>{rpe}</span></span>
                  </div>
                );
              })}
            </div>
          </Fade>
          <Fade d={220}>
            {isViewingToday && weekDone[todayIdx] ? (
              <div style={{margin:"14px 24px 0",padding:"14px 0",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",gap:12}}>
                <span aria-hidden="true" style={{width:24,height:heatMarkHeight(8),background:heatForRpe(8),borderRadius:T.rMark,flexShrink:0}}/>
                <span style={{fontSize:15,color:T.ink2}}>Session complete. You&rsquo;ll feel that tomorrow.</span>
              </div>
            ) : isViewingToday ? (
              <button className="forge-press" onClick={onBegin} style={{
                margin:"16px 24px 0",width:"calc(100% - 48px)",
                height:56,background:T.commit,border:"none",
                borderRadius:T.r,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center",
                fontFamily:T.text,fontSize:17,fontWeight:500,color:T.commitInk,
                boxShadow:T.elevStrong,
              }}>
                Begin
              </button>
            ) : (
              <div style={{
                margin:"14px 24px 0",padding:"13px 0",
                borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,
                display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,
              }}>
                <span style={{fontSize:14,color:T.ink3}}>
                  {diffDays > 0 ? "Upcoming" : "Past session"}
                </span>
                <Tag color={dayKey}>{viewDate.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}</Tag>
              </div>
            )}
          </Fade>
        </>
      )}

      {/* Non-strength day — notes on the ground, mark complete as commit */}
      {!cfg.canBegin && cfg.tips && (
        <Fade d={160}>
          <div style={{margin:"20px 24px 0"}}>
            <div style={{fontSize:13,color:T.ink3,paddingBottom:8,borderBottom:`1px solid ${T.rule}`}}>
              {viewDay.type==="rest" ? "Recovery notes" : "Session notes"}
            </div>
            {cfg.tips.map((tip,i)=>(
              <div key={i} style={{padding:"10px 0",borderBottom:i<cfg.tips.length-1?`1px solid ${T.ruleFaint}`:`1px solid ${T.rule}`,fontSize:14,color:T.ink2,lineHeight:1.5}}>
                <MonoNums>{tip}</MonoNums>
              </div>
            ))}
          </div>
        </Fade>
      )}
      {!cfg.canBegin && isViewingToday && (
        <Fade d={220}>
          {weekDone[todayIdx] ? (
            <div style={{margin:"14px 24px 0",padding:"14px 0",display:"flex",alignItems:"center",gap:10}}>
              <Glyph name="check" size={14} color={dayKey}/>
              <span style={{fontSize:15,color:T.ink2}}>Done. Rhythm kept.</span>
            </div>
          ) : (
            <button className="forge-press" onClick={()=>onMarkDayDone(viewDateStr)} style={{
              margin:"16px 24px 0",width:"calc(100% - 48px)",
              height:56,background:T.commit,border:"none",
              borderRadius:T.r,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"0 20px",boxShadow:T.elevStrong,
              fontFamily:T.text,fontSize:17,fontWeight:500,color:T.commitInk,
            }}>
              Mark complete
              <Glyph name="check" size={15}/>
            </button>
          )}
        </Fade>
      )}

      {/* Today's bonus — optional capacity finisher on cardio/HIIT days only. */}
      {dayBonus && isViewingToday && (
        <Fade d={260}>
          <Card style={{margin:"16px 24px 0",padding:"16px 18px 18px"}}>
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:13,color:T.ink3}}>Today&rsquo;s bonus · optional</div>
              <div style={{fontSize:12,color:T.ink3}}>~<span style={{fontFamily:T.measured}}>5</span> min</div>
            </div>
            <div style={{fontSize:17,fontWeight:500,color:T.ink,lineHeight:1.25,marginBottom:4}}>
              {dayBonus.name}
            </div>
            <div style={{fontSize:13,color:T.ink2,lineHeight:1.5,marginBottom:dayBonus.vid?8:14}}>
              <MonoNums>{dayBonus.detail}</MonoNums>
            </div>
            {dayBonus.vid && (
              <a href={`https://www.youtube.com/watch?v=${dayBonus.vid}`} target="_blank" rel="noopener noreferrer"
                style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:T.ink3,textDecoration:"none",marginBottom:14}}>
                Watch demo <Glyph name="arrowRight" size={11}/>
              </a>
            )}
            {bonusDone[todayIdx] ? (
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <Glyph name="check" size={13} color={dayKey}/>
                <span style={{fontSize:14,color:T.ink2}}>Bonus banked. Animal.</span>
              </div>
            ) : (
              <button className="forge-press" onClick={()=>onMarkBonusDone(viewDateStr)} aria-label="Mark bonus complete" style={{
                width:"100%",height:46,background:T.ground,
                border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",
                fontFamily:T.text,fontSize:14,fontWeight:500,color:T.ink,
              }}>
                Mark bonus done
                <Glyph name="plus" size={13} color={T.ink2}/>
              </button>
            )}
          </Card>
        </Fade>
      )}

      {/* Tonnage wave — the week's work, six weeks deep. The stroke heats
          along its own length as it climbs. First-run: hidden until real
          work exists (never simulated data). */}
      {hasWave && (
        <Fade d={240}>
          <div style={{margin:"22px 0 0",padding:"12px 24px 12px",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
              <span style={{fontSize:13,color:T.ink3}}>Tonnage, six weeks</span>
              <span style={{fontFamily:T.measured,fontSize:12,color:T.heat[3]}}>{formatTonnage(wave[wave.length-1].kg)}</span>
            </div>
            <svg width="100%" height="30" viewBox="0 0 342 30" preserveAspectRatio="none" style={{display:"block",overflow:"visible"}} aria-hidden="true">
              <defs>
                <linearGradient id="hwHomeWave" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="var(--heat-0)"/>
                  <stop offset="0.35" stopColor="var(--heat-1)"/>
                  <stop offset="0.65" stopColor="var(--heat-2)"/>
                  <stop offset="1" stopColor="var(--heat-3)"/>
                </linearGradient>
              </defs>
              <path
                d={wave.map((w,i)=>`${i===0?"M":"L"} ${(i*(342/(wave.length-1))).toFixed(1)} ${(27 - 24*(w.kg/waveMax)).toFixed(1)}`).join(" ")}
                fill="none" stroke="url(#hwHomeWave)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                strokeDasharray="400" style={{animation:`hwDraw 1.1s ${T.ease} both`}}/>
              <circle cx="342" cy={(27 - 24*(wave[wave.length-1].kg/waveMax)).toFixed(1)} r="3.2" fill="var(--heat-3)"/>
            </svg>
          </div>
        </Fade>
      )}

      {/* Pick up where you left off — an interrupted session from within the
          last 12 hours. Top priority if it exists. */}
      {pendingDraft && (
        <Fade d={160}>
          <Card style={{margin:"20px 24px 0",padding:"16px 18px 18px"}}>
            <div style={{fontSize:13,color:T.ink3,marginBottom:6}}>Unfinished session</div>
            <div style={{fontSize:17,fontWeight:500,color:T.ink,lineHeight:1.3}}>
              Pick up where you left off.
            </div>
            <div style={{fontSize:13,color:T.ink3,marginTop:6,lineHeight:1.5}}>
              <span style={{fontFamily:T.measured}}>{pendingDraft.setCount}</span> {pendingDraft.setCount === 1 ? "set" : "sets"} logged · {formatAgo(pendingDraft.ageMs)}
            </div>
            <div style={{display:"flex",gap:8,marginTop:14}}>
              <button className="forge-press" onClick={onResumeDraft}
                style={{flex:1,height:48,background:T.ground,border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:15,fontWeight:500,color:T.ink,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                Resume <Glyph name="arrowRight" size={12}/>
              </button>
              <button className="forge-press" onClick={onDiscardDraft}
                style={{height:48,padding:"0 16px",background:T.ground,border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:13,fontWeight:500,color:T.ink2}}>
                Discard
              </button>
            </div>
          </Card>
        </Fade>
      )}

      {/* BW re-prompt card — surfaces when bodyweight is stale (>14 days or never set) */}
      {showBwCard && (
        <Fade d={180}>
          <Card style={{margin:"20px 24px 0",padding:"16px 18px",cursor:"pointer"}}>
            <div onClick={onOpenBwEdit} style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,color:T.ink3,marginBottom:5}}>Bodyweight</div>
                <div style={{fontSize:16,fontWeight:500,color:T.ink,lineHeight:1.35,marginBottom:4}}>
                  How much do you weigh today?
                </div>
                <div style={{fontSize:13,color:T.ink3,lineHeight:1.5}}>
                  Tap to update — keeps loaded pull-ups and dips honest.
                </div>
              </div>
              <button onClick={(e)=>{e.stopPropagation();onDismissBwCard();}} aria-label="Dismiss"
                style={{...linkBtn,flexShrink:0,padding:"4px 8px"}}><Glyph name="cross" size={12}/></button>
            </div>
          </Card>
        </Fade>
      )}

      {/* Deload offer card. Surfaces only when signals warrant. Acknowledgement
          voice — an offer, never an alarm. */}
      {deloadOffer && (() => {
        const copy = deloadCardCopy(deloadOffer);
        if (!copy) return null;
        return (
          <Fade d={170}>
            <Card style={{margin:"20px 24px 0",padding:"18px 20px"}}>
              <div style={{fontSize:13,color:T.ink3,marginBottom:8}}>{copy.kicker}</div>
              <div style={{fontSize:17,fontWeight:500,color:T.ink,lineHeight:1.3,marginBottom:8}}>
                {copy.headline}
              </div>
              <div style={{fontSize:13,color:T.ink2,lineHeight:1.55,marginBottom:16}}>
                {copy.body}
              </div>
              <div style={{display:"flex",gap:10}}>
                <button className="forge-press" onClick={onAcceptDeload}
                  style={{flex:1,height:46,background:T.ground,border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:14,fontWeight:500,color:T.ink,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  Run the deload <Glyph name="arrowRight" size={12}/>
                </button>
                <button className="forge-press" onClick={onDismissDeload}
                  style={{flexShrink:0,height:46,padding:"0 16px",background:T.ground,border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:13,color:T.ink2}}>
                  Not yet
                </button>
              </div>
            </Card>
          </Fade>
        );
      })()}

      {/* Lifetime-tonnage milestone — surfaces ONCE per crossed threshold.
          Tap-anywhere dismisses. A small ceremony beat — display face earns
          its 500 weight here. */}
      {tonnageMilestone && (
        <Fade d={200}>
          <button className="forge-press" onClick={onDismissTonnageMilestone}
            aria-label={`Milestone: ${formatTonnage(tonnageMilestone)} moved — tap to dismiss`}
            style={{display:"block",width:"calc(100% - 48px)",margin:"20px 24px 0",padding:"18px 20px",background:T.surface,border:"none",borderRadius:T.r,boxShadow:T.elev,textAlign:"left",cursor:"pointer",fontFamily:T.text}}>
            <div style={{fontSize:13,color:T.ink3,marginBottom:8}}>
              Milestone · <span style={{fontFamily:T.measured}}>{formatTonnage(tonnageMilestone)}</span>
            </div>
            <div style={{fontFamily:T.measured,fontWeight:300,fontSize:34,letterSpacing:"-0.04em",color:T.ink,lineHeight:1}}>
              {formatTonnage(tonnageTotalKg)}<span style={{fontSize:15,color:T.ink3,letterSpacing:0}}> moved</span>
            </div>
            <div style={{fontSize:13,color:T.ink2,marginTop:9,lineHeight:1.5}}>
              Since you started with Heatwayve. The bar remembers.
            </div>
          </button>
        </Fade>
      )}

      {/* Honest recovery nudge — surfaces when the last 2 sessions were cooked. */}
      {recoveryNudge && (
        <Fade d={180}>
          <Card style={{margin:"20px 24px 0",padding:"16px 18px"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,color:T.ink3,marginBottom:6}}>A gentle nudge</div>
                <div style={{fontSize:14,color:T.ink,lineHeight:1.5}}>
                  {recoveryNudge.message}
                </div>
              </div>
              <button onClick={onDismissRecovery} aria-label="Dismiss"
                style={{...linkBtn,flexShrink:0,padding:"4px 8px"}}><Glyph name="cross" size={12}/></button>
            </div>
          </Card>
        </Fade>
      )}

      {/* Absence nudge — the welcome, not "you're quitting". */}
      {absenceNudge && onOpenBreather && (
        <Fade d={185}>
          <Card style={{margin:"20px 24px 0",padding:"16px 18px"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,color:T.ink3,marginBottom:6}}>No drama</div>
                <p style={{fontSize:14,color:T.ink,lineHeight:1.55,margin:0}}>
                  <span style={{fontFamily:T.measured}}>{absenceNudge.days}</span> days off. Here for a session, or need a breather? No wrong answer.
                </p>
              </div>
              <button onClick={onDismissAbsenceNudge} aria-label="Dismiss"
                style={{...linkBtn,flexShrink:0,padding:"4px 8px"}}><Glyph name="cross" size={12}/></button>
            </div>
            <button className="forge-press" onClick={onOpenBreather}
              style={{marginTop:12,height:42,padding:"0 16px",background:T.ground,border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:14,fontWeight:500,color:T.ink}}>
              Take a breather
            </button>
          </Card>
        </Fade>
      )}

      {/* Retrospective logging link — calm inline utility. */}
      {untickedDays.length > 0 && onOpenRetroPicker && (
        <Fade d={190}>
          <div style={{margin:"18px 24px 0",display:"flex",justifyContent:"center"}}>
            <button onClick={onOpenRetroPicker} style={{...linkBtn,padding:"6px 4px"}}>
              Anything missed? <Glyph name="arrowRight" size={11}/>
            </button>
          </div>
        </Fade>
      )}

      {/* Passkey nudge — chip phase (days 0-3). */}
      {pnStage === "chip" && (
        <Fade d={195}>
          <div style={{margin:"14px 24px 0",display:"flex",justifyContent:"center",alignItems:"center",gap:8}}>
            <button onClick={onPnRegister} disabled={pnBusy}
              style={{...linkBtn,padding:"6px 4px",cursor:pnBusy?"default":"pointer",opacity:pnBusy?0.6:1}}>
              {pnBusy ? "Setting up…" : <>Secure your name across devices <Glyph name="arrowRight" size={11}/></>}
            </button>
            {!pnBusy && (
              <button onClick={onPnSnooze} aria-label="Dismiss for a week"
                style={{...linkBtn,padding:"4px 6px"}}><Glyph name="cross" size={10}/></button>
            )}
          </div>
          {pnError && (
            <div style={{margin:"8px 24px 0",padding:"8px 14px",fontSize:12,color:T.heat[4],textAlign:"center"}}>
              {pnError}
            </div>
          )}
        </Fade>
      )}

      {/* Passkey nudge — card phase (days 4+). Consequence made explicit. */}
      {pnStage === "card" && (
        <Fade d={200}>
          <Card style={{margin:"20px 24px 0",padding:"16px 18px"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,marginBottom:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,color:T.ink3,marginBottom:6}}>Secure across devices</div>
                <div style={{fontSize:16,fontWeight:500,color:T.ink,lineHeight:1.35,marginBottom:6}}>
                  Add a passkey
                </div>
                <p style={{fontSize:13,color:T.ink2,lineHeight:1.55,margin:0}}>
                  Without one, your data lives only on this device. Face ID, Touch ID, or your device PIN — takes a second.
                </p>
              </div>
              <button onClick={onPnSnooze} aria-label="Dismiss"
                style={{...linkBtn,flexShrink:0,padding:"4px 8px"}}><Glyph name="cross" size={12}/></button>
            </div>
            <button onClick={onPnRegister} disabled={pnBusy}
              style={{width:"100%",height:46,background:T.ground,border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:pnBusy?"default":"pointer",fontFamily:T.text,fontSize:14,fontWeight:500,color:T.ink,display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:pnBusy?0.6:1}}>
              {pnBusy ? "Setting up…" : <>Set up passkey <Glyph name="arrowRight" size={12}/></>}
            </button>
            {pnError && (
              <div style={{marginTop:10,fontSize:12,color:T.heat[4]}}>
                {pnError}
              </div>
            )}
          </Card>
        </Fade>
      )}

      {/* Passkey success toast — vellum, 3s auto-dismiss. */}
      {pnSuccessToast && (
        <Toast onClick={onPnDismissToast}>
          Passkey added. Your name&rsquo;s secure now.
        </Toast>
      )}

      {/* Retro completion toast — vellum, 3s auto-dismiss. */}
      {retroToast && (
        <Toast onClick={onDismissRetroToast}>
          Logged {retroToast.sessionName} for {retroToast.date}
        </Toast>
      )}

      {/* Rotation nudge — surfaces at ROTATION_OPTIONAL weeks on a block */}
      {weeksOnBlock >= ROTATION_OPTIONAL && (
        <Fade d={200}>
          <Card style={{margin:"20px 24px 0",padding:"16px 18px"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,color:T.ink3,marginBottom:4}}>
                  Block <span style={{fontFamily:T.measured}}>{programmeBlock?.number}</span> · <span style={{fontFamily:T.measured}}>{weeksOnBlock}</span> weeks
                </div>
                <div style={{fontSize:16,fontWeight:500,color:T.ink,lineHeight:1.3,marginBottom:4}}>
                  Time to rotate accessories
                </div>
                <div style={{fontSize:13,color:T.ink2,lineHeight:1.5}}>
                  {offerRotationChoice
                    ? "You've earned a re-think. Refresh exercises, or change your focus altogether."
                    : "Your body has adapted. New exercises, same muscle targets."}
                </div>
              </div>
              <button className="forge-press" onClick={handleRotateTap} style={{flexShrink:0,marginTop:2,height:42,padding:"0 14px",background:T.ground,border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:14,fontWeight:500,color:T.ink,display:"inline-flex",alignItems:"center",gap:6}}>
                {offerRotationChoice ? "Choose" : "Rotate"} <Glyph name="arrowRight" size={12}/>
              </button>
            </div>
          </Card>
        </Fade>
      )}

      {/* Performance Lab + Locker Room — quiet doors, rows on the ground. */}
      <Fade d={260}>
        <div style={{margin:"24px 24px 0",borderTop:`1px solid ${T.rule}`}}>
          <button className="forge-press" onClick={onPerformance}
            style={{display:"flex",width:"100%",alignItems:"center",gap:12,padding:"14px 0",background:"none",border:"none",borderBottom:`1px solid ${T.ruleFaint}`,cursor:"pointer",textAlign:"left",fontFamily:T.text}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:16,fontWeight:500,color:T.ink,marginBottom:2}}>Performance lab</div>
              <div style={{fontSize:13,color:T.ink3,lineHeight:1.45}}>
                {historyCount === 0
                  ? "Complete a session to light it up"
                  : <><span style={{fontFamily:T.measured}}>{historyCount}</span> session{historyCount===1?"":"s"} · volume vs the bands · 1RM trends</>}
              </div>
            </div>
            <Glyph name="arrowRight" size={14} color={T.ink3} style={{flexShrink:0}}/>
          </button>

          <button className="forge-press" onClick={onLockerRoom}
            style={{display:"flex",width:"100%",alignItems:"center",gap:12,padding:"14px 0",background:"none",border:"none",borderBottom:`1px solid ${T.rule}`,cursor:"pointer",textAlign:"left",fontFamily:T.text}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:16,fontWeight:500,color:T.ink,marginBottom:2}}>Locker room</div>
              <div style={{fontSize:13,color:T.ink3,lineHeight:1.45}}>Bodyweight and photos, yours alone</div>
            </div>
            <Glyph name="arrowRight" size={14} color={T.ink3} style={{flexShrink:0}}/>
          </button>
        </div>
      </Fade>

      {/* Reset accessories — quiet escape hatch for over-rotated users.
          Two-tap confirm inline, no modal, 5s auto-disarm. */}
      {hasRotationDrift && (
        <div style={{margin:"16px 24px 0",textAlign:"center"}}>
          <button
            onClick={handleResetTap}
            style={{...linkBtn,fontSize:12,padding:"6px 10px",color:resetArmed?T.heat[4]:T.ink3,textDecoration:"underline",textUnderlineOffset:3}}>
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

// ─── Toast — vellum, top-anchored ────────────────────────────────────────────
// The one translucent-sheet material, allowed on toasts. Cast shadow flips
// downward for a top-anchored surface.
function Toast({ onClick, children }) {
  return (
    <div style={{position:"fixed",top:"calc(20px + env(safe-area-inset-top))",left:"50%",transform:"translateX(-50%)",zIndex:300,maxWidth:"calc(100% - 48px)",pointerEvents:"auto"}}>
      <div onClick={onClick} className="forge-vellum"
        style={{borderRadius:T.r,padding:"12px 18px",boxShadow:"0 10px 24px -14px rgba(36,28,25,0.35)",cursor:"pointer",animation:`toastIn 280ms ${T.ease}`,fontSize:13,color:T.ink}}>
        {children}
      </div>
    </div>
  );
}

// ─── Rotation choice modal ─────────────────────────────────────────────────
// Two paths: refresh the accessory picks within the current focus, or
// change focus altogether. Vellum sheet; no press visuals on sheet
// controls (settled sheet grammar).
function RotationChoiceModal({ weeksOnBlock, currentFocus, onRefresh, onChangeFocus, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "rotation-choice-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground forge-vellum" style={{padding:"26px 24px 32px",width:"100%",animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:8}}>
          <span style={{fontFamily:T.measured}}>{weeksOnBlock}</span> weeks on this block
        </div>
        <div id={titleId} style={{...DISPLAY,fontSize:30,color:T.ink,marginBottom:8}}>
          Rotation
        </div>
        <p style={{fontSize:13,color:T.ink2,marginBottom:18,lineHeight:1.5}}>
          You&apos;re on <strong style={{fontWeight:600}}>{currentFocus}</strong>. Refresh the accessory picks within it, or rethink the whole focus.
        </p>

        <button onClick={onRefresh}
          style={{padding:"15px 16px",background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.r,cursor:"pointer",textAlign:"left",marginBottom:10,fontFamily:T.text}}>
          <div style={{fontSize:15,fontWeight:500,color:T.ink,marginBottom:4}}>Refresh exercises</div>
          <div style={{fontSize:13,color:T.ink2,lineHeight:1.5}}>New picks within your current focus. Same muscle targets, fresh stimulus.</div>
        </button>

        <button onClick={onChangeFocus}
          style={{padding:"15px 16px",background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.r,cursor:"pointer",textAlign:"left",fontFamily:T.text}}>
          <div style={{fontSize:15,fontWeight:500,color:T.ink,marginBottom:4}}>Change focus</div>
          <div style={{fontSize:13,color:T.ink2,lineHeight:1.5}}>Switch to a different goal (Forged / Strong / Sculpt). Accessories re-rotate with the new bias.</div>
        </button>

        <button onClick={onCancel}
          style={{marginTop:16,padding:"10px",background:"none",border:"none",cursor:"pointer",fontSize:13,color:T.ink3,fontFamily:T.text,alignSelf:"center"}}>
          Not now
        </button>
      </div>
    </div>
  );
}

// ─── Streak line ───────────────────────────────────────────────────────────
// The rhythm read, as a quiet line under the date — mono number, plain
// words. Resting shows the state instead of a count that would only tick
// down.
function StreakLine({rhythm, resting=false}){
  if (resting) {
    return (
      <div style={{fontSize:12,color:T.ink3,marginTop:3}}>Resting — on a breather</div>
    );
  }
  const completed = rhythm?.completed || 0;
  const expected  = rhythm?.expected  || 12;
  // Rolling 28-day count of strength sessions — labelled honestly.
  const window  = rhythm?.window || 28;
  const over = completed > expected;
  return (
    <div style={{fontSize:12,color:T.ink3,marginTop:3}}>
      <span style={{fontFamily:T.measured,color:T.ink2}}>{over ? `${expected}+` : completed}</span> of <span style={{fontFamily:T.measured}}>{expected}</span> sessions, past <span style={{fontFamily:T.measured}}>{window}</span> days{over ? " · strong" : ""}
    </div>
  );
}
