"use client";

import { useMemo, useState } from "react";
import {
  mainLiftTrend, weeklyVolumeByMuscle, consistencyGrid,
  readinessBreakdown, sessionCount, detectPlateaus,
} from "@/lib/analytics";
import { auditHistoryVolume, AUDIT_MUSCLE_ORDER } from "@/lib/volume-audit";
import { T } from "@/lib/tokens";
import GlossarySheet, { GlossaryTrigger } from "@/components/GlossarySheet";

// ─── Main export ──────────────────────────────────────────────────────────────
export default function PerformanceLab({ history, onBack }) {
  const trends  = useMemo(() => mainLiftTrend(history),   [history]);
  const grid    = useMemo(() => consistencyGrid(history, 12), [history]);
  const readiness = useMemo(() => readinessBreakdown(history), [history]);
  const counts    = useMemo(() => sessionCount(history),       [history]);
  const plateaus  = useMemo(() => detectPlateaus(history),     [history]);
  const volumeAudit  = useMemo(() => auditHistoryVolume(history, { weeks: 2 }), [history]);
  const volumeTrend  = useMemo(() => weeklyVolumeByMuscle(history, { weeks: 8 }), [history]);

  const mainLifts = Object.keys(trends);
  const [selectedLift, setSelectedLift] = useState(null);
  // Default to first lift once data arrives
  const activeLift = selectedLift || mainLifts[0] || null;

  // Glossary sheet — opened by ⓘ triggers throughout the lab. `glossaryAnchor`
  // = null  → sheet closed; "" → open, no scroll anchor; term-id → scroll to it.
  // openGlossary normalises null/undefined to "" so a trigger with no
  // anchorTerm (e.g. the header ⓘ) still opens the sheet. Without that
  // coercion the default `= ""` only handled `undefined` and a `null`
  // anchorTerm from GlossaryTrigger silently no-op'd.
  const [glossaryAnchor, setGlossaryAnchor] = useState(null);
  const openGlossary = (anchor) => setGlossaryAnchor(anchor ?? "");
  const closeGlossary = () => setGlossaryAnchor(null);

  const isEmpty = counts.total === 0;

  return (
    <div style={{minHeight:"100vh", paddingBottom:48, position:"relative", overflow:"hidden"}}>
      {/* Header — ambient glow. top:0 (was -180) keeps the gradient's
          bright centre at content y≈250 instead of y≈70 so the topmost
          ~80px stays at native body bg #131110, matching the system
          status bar zone above it cleanly. Same fix as the HomeScreen
          primary glow — see components/ForgeApp.jsx for full rationale. */}
      <div style={{position:"absolute", top:0, left:"50%", transform:"translateX(-50%)", width:600, height:500, background:`radial-gradient(ellipse, rgba(196,168,130,0.10) 0%, transparent 65%)`, pointerEvents:"none"}}/>

      <div style={{padding:"52px 24px 0", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <button onClick={onBack} style={{background:"none", border:"none", padding:0, cursor:"pointer", fontSize:12, color:T.text3, fontFamily:T.sans}}>
          ← Home
        </button>
      </div>

      <div style={{padding:"32px 24px 0"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
          <div style={{fontSize:11, fontWeight:500, color:T.text3, letterSpacing:"0.12em", textTransform:"uppercase"}}>
            Performance lab
          </div>
          <GlossaryTrigger onOpen={openGlossary} label="Open glossary"/>
        </div>
        <div style={{fontFamily:T.serif, fontSize:42, fontWeight:300, lineHeight:1.1}}>
          Your<br/><span style={{color:T.gold, fontStyle:"italic"}}>progress.</span>
        </div>
        <div style={{fontSize:14, color:T.text2, marginTop:10, lineHeight:1.5}}>
          {isEmpty
            ? "Complete your first session to start seeing the signal."
            : `${counts.total} session${counts.total===1?"":"s"} · ${counts.last7} this week · ${counts.last30} this month`
          }
        </div>
      </div>

      {isEmpty && <EmptyState />}

      {!isEmpty && (
        <>
          {/* Plateau callout (only if we detect one) */}
          {plateaus.length > 0 && (
            <div style={{margin:"24px 24px 0", padding:"14px 18px", borderRadius:T.r.md, background:`${T.rose}12`, border:`1px solid ${T.rose}33`}}>
              <div style={{fontSize:10, fontWeight:500, color:T.rose, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6}}>Stall detected</div>
              <div style={{fontSize:13, color:T.text1, lineHeight:1.5}}>
                Your <span style={{fontFamily:T.serif, fontStyle:"italic"}}>{plateaus[0].lift}</span> has held at {plateaus[0].weight}kg for {plateaus[0].sessions} sessions. Consider a deload week or a rep-range shift.
              </div>
            </div>
          )}

          {/* 1RM trend */}
          {activeLift && (
            <Card title="Estimated 1RM" subtitle={activeLift}>
              {mainLifts.length > 1 && (
                <LiftSelector lifts={mainLifts} active={activeLift} onSelect={setSelectedLift}/>
              )}
              <LineChart series={trends[activeLift]} />
            </Card>
          )}

          {/* Per-muscle volume landscape — merges the old "Weekly volume"
              stacked-bar chart and "Volume vs landmarks" status card into one
              row-per-muscle view. Each row shows the 8-week sparkline + the
              recent (trailing 2 complete weeks) sets/wk classified against
              MEV/MAV/MRV bands. Sorted by deviation severity so the actionable
              muscles surface first (under MEV, then over MRV, then in-band). */}
          <Card
            title="Volume per muscle"
            subtitle={<>Last 8 weeks · sets/wk vs MEV/MAV/MRV<GlossaryTrigger anchorTerm="volume-landmarks" onOpen={openGlossary} label="Explain MEV / MAV / MRV"/></>}
          >
            <VolumeLandscape trend={volumeTrend} audit={volumeAudit} totalSessions={counts.total} />
          </Card>

          {/* Consistency heatmap */}
          <Card title="Consistency" subtitle="Last 12 weeks">
            <ConsistencyGrid grid={grid} />
          </Card>

          {/* Readiness breakdown */}
          <Card title="How you've shown up" subtitle="Readiness across all sessions">
            <ReadinessBar readiness={readiness} />
          </Card>
        </>
      )}

      {glossaryAnchor !== null && (
        <GlossarySheet anchorTerm={glossaryAnchor || null} onCancel={closeGlossary}/>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div style={{margin:"40px 24px 0", padding:"40px 24px", background:T.bg2, border:`1px solid ${T.bg3}`, borderRadius:T.r.lg, textAlign:"center"}}>
      <div style={{fontFamily:T.serif, fontSize:22, fontWeight:300, fontStyle:"italic", color:T.text2, marginBottom:12, lineHeight:1.3}}>
        Nothing to show<br/>yet.
      </div>
      <p style={{fontSize:13, color:T.text3, lineHeight:1.6, maxWidth:280, margin:"0 auto"}}>
        Your first session plots your estimated 1RM. After a few weeks we'll surface trends, volume, and stalls worth knowing about.
      </p>
    </div>
  );
}

// ─── Card wrapper ─────────────────────────────────────────────────────────────
// Cards rest *on* the backdrop — inset 1px top highlight (light catching
// the upper edge), a tight contact shadow, and a wider very-faint lift.
// Warm-black tints stay inside the Portra palette; no cool Material-grey
// elevation. Same shape as the ForgeApp Card lift.
const LAB_CARD_SHADOW = "inset 0 1px 0 rgba(237,235,231,0.04), 0 1px 2px rgba(10,9,8,0.28), 0 10px 28px -16px rgba(10,9,8,0.5)";
function Card({ title, subtitle, children }) {
  return (
    <div className="lab-card" style={{margin:"24px 24px 0", background:T.bg2, border:`1px solid ${T.bg3}`, borderRadius:T.r.lg, overflow:"hidden", boxShadow:LAB_CARD_SHADOW}}>
      <div style={{padding:"18px 20px 14px", borderBottom:`1px solid ${T.bg3}`}}>
        <div style={{fontSize:10, fontWeight:500, color:T.text3, letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4}}>{title}</div>
        {subtitle && <div style={{fontFamily:T.serif, fontSize:15, fontWeight:300, color:T.text2, fontStyle:"italic"}}>{subtitle}</div>}
      </div>
      <div style={{padding:"18px 20px 20px"}}>
        {children}
      </div>
    </div>
  );
}

// ─── Lift selector (pill row) ────────────────────────────────────────────────
function LiftSelector({ lifts, active, onSelect }) {
  return (
    <div style={{display:"flex", gap:6, overflowX:"auto", marginBottom:16, paddingBottom:4, scrollbarWidth:"none"}}>
      <style>{`div[data-lift-selector]::-webkit-scrollbar{display:none}`}</style>
      <div data-lift-selector style={{display:"flex", gap:6}}>
        {lifts.map(lift => {
          const on = lift === active;
          return (
            <button key={lift} onClick={() => onSelect(lift)}
              style={{padding:"6px 12px", background: on ? T.coral : T.bg3, border:`1px solid ${on ? T.coral : T.bg4}`, borderRadius:T.r.pill, cursor:"pointer", fontSize:11, fontWeight:500, color: on ? T.bg0 : T.text2, whiteSpace:"nowrap", fontFamily:T.sans, transition:`all 180ms ${T.ease}`}}>
              {lift}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Line chart (1RM trend) ──────────────────────────────────────────────────
// Hand-rolled SVG. No tooltips — tap a point to see the value (future).
function LineChart({ series }) {
  const W = 320, H = 140, PAD_X = 12, PAD_Y = 20;
  if (!series || series.length === 0) {
    return <div style={{padding:"28px 0", fontSize:13, color:T.text3, fontFamily:T.serif, fontStyle:"italic", textAlign:"center"}}>No data yet</div>;
  }
  // Single data point: show a dot + number, no line
  if (series.length === 1) {
    const p = series[0];
    return (
      <div style={{textAlign:"center", padding:"20px 0"}}>
        <div style={{fontFamily:T.serif, fontSize:48, fontWeight:300, color:T.coral, lineHeight:1}}>{p.est1RM}<span style={{fontSize:20, color:T.text3, marginLeft:4}}>kg</span></div>
        <div style={{fontSize:11, color:T.text3, marginTop:6, fontStyle:"italic", fontFamily:T.serif}}>{p.date} · top set {p.topSet.weight}kg × {p.topSet.reps}</div>
        <div style={{fontSize:11, color:T.text4, marginTop:8}}>Log another session to see the trend</div>
      </div>
    );
  }

  const values = series.map(p => p.est1RM);
  const minV = Math.min(...values), maxV = Math.max(...values);
  // Give the chart some vertical breathing room
  const rangeV = maxV - minV || 1;
  const yMin = minV - rangeV * 0.2;
  const yMax = maxV + rangeV * 0.2;

  const xAt = (i) => PAD_X + (W - 2*PAD_X) * (i / (series.length - 1));
  const yAt = (v) => PAD_Y + (H - 2*PAD_Y) * (1 - (v - yMin) / (yMax - yMin));

  const pathD = series.map((p, i) => `${i===0 ? "M" : "L"} ${xAt(i)} ${yAt(p.est1RM)}`).join(" ");
  // Area fill under the line for premium feel
  const areaD = `${pathD} L ${xAt(series.length-1)} ${H-PAD_Y} L ${xAt(0)} ${H-PAD_Y} Z`;

  const latest  = series[series.length-1];
  const first   = series[0];
  const delta   = latest.est1RM - first.est1RM;
  const pctDelta= first.est1RM > 0 ? (delta / first.est1RM) * 100 : 0;

  return (
    <div>
      <div style={{display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:10}}>
        <div>
          <span style={{fontFamily:T.serif, fontSize:32, fontWeight:300, color:T.text1}}>{latest.est1RM}</span>
          <span style={{fontSize:13, color:T.text3, marginLeft:4}}>kg</span>
        </div>
        <div style={{fontSize:11, color: delta >= 0 ? T.sage : T.rose, fontFamily:T.serif, fontStyle:"italic"}}>
          {delta >= 0 ? "+" : ""}{delta.toFixed(1)}kg  ·  {pctDelta >= 0 ? "+" : ""}{pctDelta.toFixed(1)}%
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%", height:"auto", display:"block"}}>
        <defs>
          <linearGradient id="fillCoral" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={T.coral} stopOpacity="0.24"/>
            <stop offset="100%" stopColor={T.coral} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#fillCoral)" />
        <path d={pathD} stroke={T.coral} strokeWidth="1.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
        {series.map((p, i) => (
          <circle key={i} cx={xAt(i)} cy={yAt(p.est1RM)} r={i === series.length-1 ? 4 : 2.5}
            fill={p.cooked ? T.rose : T.coral}
            stroke={T.bg2} strokeWidth="1.5"/>
        ))}
      </svg>
      <div style={{display:"flex", justifyContent:"space-between", marginTop:6, fontSize:10, color:T.text4, fontFamily:T.sans}}>
        <span>{first.date.slice(5).replace("-","/")}</span>
        <span>{latest.date.slice(5).replace("-","/")}</span>
      </div>
    </div>
  );
}

// ─── Volume landscape (per-muscle row with sparkline + MEV/MAV/MRV band) ───
// Replaces the stacked-bar Weekly Volume chart and the Volume vs Landmarks
// status card. The old stacked bars rendered four leg muscles in the same
// warm-earth palette — unreadable at small heights — and didn't tell you the
// only thing you actually want to know: am I training each muscle in its
// productive band, and is the trend up or down.
//
// Each row = one muscle. Left: name + current sets/wk + band label. Right:
// 8-week sparkline with MEV/MAV/MRV bands rendered behind the line. Sorted
// by deviation severity so under-MEV muscles surface first.
//
// Vocabulary: granular (13 muscles via lib/volume-audit.js#AUDIT_MUSCLE_ORDER)
// — Front/Side/Rear delts split, Biceps/Triceps split. The audit landmarks
// only make sense at that resolution.
const BAND_COLOUR = {
  under_mev:  T.rose,   // alarm: not driving growth, raise it
  low:        T.gold,   // productive but room to add (MEV..MAV)
  optimal:    T.sage,   // sweet spot (MAV..MRV)
  over_mrv:   T.coral,  // recovery cost (above MRV)
  untargeted: T.text4,  // tracked, no landmark (e.g. Forearms)
};
const BAND_LABEL = {
  under_mev:  "under MEV",
  low:        "in productive band",
  optimal:    "in sweet spot",
  over_mrv:   "over MRV",
  untargeted: "untargeted",
};
// Sort order for muscle rows — actionable first, then sweet spot, then
// background (untargeted). Within each tier, AUDIT_MUSCLE_ORDER preserves
// the editorial muscle ordering (legs → torso → arms → core).
const SEVERITY = { under_mev: 0, over_mrv: 1, low: 2, optimal: 3, untargeted: 4 };

function VolumeLandscape({ trend, audit, totalSessions = 0 }) {
  // New user — not enough logged history anywhere yet. Gate on TOTAL sessions
  // (not the window count, which is now recency-scoped). Encourage logging
  // rather than render a wall of "under MEV" alarms for someone just starting.
  if (!audit || totalSessions < 4) {
    return (
      <div style={{padding:"14px 0 2px", fontSize:13, color:T.text3, fontStyle:"italic", fontFamily:T.serif, lineHeight:1.5}}>
        A few more logged sessions and this card will start flagging the muscles below MEV or above MRV.
      </div>
    );
  }

  // "Away" — the user HAS a training history, but the recent window (trailing
  // 2 complete weeks) is empty. Don't guilt them with a wall of red. Forge's
  // philosophy, stated plainly: consistency over time is what builds — a
  // lighter stretch is part of training, not a failure.
  if (audit.away) {
    return (
      <div style={{padding:"14px 0 2px"}}>
        <div style={{fontSize:15, color:T.text1, fontFamily:T.serif, fontWeight:300, lineHeight:1.4, marginBottom:8}}>
          A lighter stretch — that&apos;s part of training.
        </div>
        <div style={{fontSize:13, color:T.text3, lineHeight:1.6}}>
          What builds muscle is showing up over time, not any single week. Your
          volume is measured over the last two weeks, so it&apos;ll fill back in
          as you train — no need to chase a perfect week. Pick it up when you&apos;re ready.
        </div>
      </div>
    );
  }

  // Build the union of muscles to render: anything in AUDIT_MUSCLE_ORDER
  // (so missed muscles surface as under-MEV) plus anything trained that
  // doesn't have a landmark (e.g. Forearms).
  const muscles = [
    ...AUDIT_MUSCLE_ORDER,
    ...Object.keys(trend?.byMuscle || {}).filter(m => !AUDIT_MUSCLE_ORDER.includes(m)),
  ];

  const rows = muscles.map(muscle => {
    const a = audit.perMuscle[muscle] || { sets: 0, target: null, status: "untargeted" };
    const series = trend?.byMuscle?.[muscle] || [];
    return { muscle, sets: a.sets, target: a.target, status: a.status, series };
  });
  // Drop rows that have neither a landmark nor any trained sets — nothing
  // useful to say about them.
  const visible = rows.filter(r => r.target || r.sets > 0 || r.series.some(v => v > 0));
  visible.sort((a, b) => {
    const sa = SEVERITY[a.status] ?? 99;
    const sb = SEVERITY[b.status] ?? 99;
    return sa - sb;
  });

  return (
    <div style={{padding:"2px 0 0"}}>
      {visible.map(row => <MuscleRow key={row.muscle} {...row} />)}
      <div style={{marginTop:14,fontSize:11,color:T.text4,lineHeight:1.5}}>
        Sparklines = last 8 weeks · band &amp; sets/wk = last {audit.weeksAnalysed} complete weeks · {audit.sessionsAnalysed} session{audit.sessionsAnalysed===1?"":"s"}
      </div>
      <div style={{marginTop:8,fontSize:11,color:T.text3,fontStyle:"italic",fontFamily:T.serif,lineHeight:1.55}}>
        Measured recent, not lifetime — because consistency over time builds where single big weeks don&apos;t.
      </div>
    </div>
  );
}

function MuscleRow({ muscle, sets, target, status, series }) {
  const colour = BAND_COLOUR[status] || T.text4;
  const bandLabel = BAND_LABEL[status] || "";
  // Right side: sparkline. Reference bands (MEV/MAV/MRV) drawn behind the
  // line in low-opacity tints so eye picks up "you're below the floor" or
  // "you're over the ceiling" without needing tick labels.
  return (
    <div style={{
      display:"grid",
      gridTemplateColumns:"minmax(0, 1fr) 140px",
      alignItems:"center",
      gap:14,
      padding:"12px 0",
      borderTop:`1px solid ${T.bg3}`,
    }}>
      <div style={{minWidth:0}}>
        <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:3}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:colour,display:"inline-block",flexShrink:0}} aria-hidden="true"/>
          <span style={{fontSize:13,fontWeight:500,color:T.text1,letterSpacing:"0.01em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{muscle}</span>
          <span style={{fontSize:12,color:T.text3,fontVariantNumeric:"tabular-nums",marginLeft:"auto",flexShrink:0}}>
            {sets}<span style={{color:T.text4}}> /wk</span>
          </span>
        </div>
        <div style={{fontSize:10,color:colour,letterSpacing:"0.06em",textTransform:"uppercase",fontWeight:500}}>
          {target
            ? `${bandLabel} · MEV ${target.mev} · MRV ${target.mrv}`
            : bandLabel}
        </div>
      </div>
      <Sparkline series={series} target={target} colour={colour} />
    </div>
  );
}

function Sparkline({ series, target, colour }) {
  const W = 140, H = 40, PAD_X = 2, PAD_Y = 4;
  if (!series || series.length === 0) {
    return <div style={{width:W,height:H,opacity:0.3,fontSize:10,color:T.text4,display:"flex",alignItems:"center",justifyContent:"flex-end",fontStyle:"italic",fontFamily:T.serif}}>—</div>;
  }
  // Y scale = max of (series max, MRV * 1.1). Pinning to MRV ensures the
  // bands render at consistent heights across the card (so a muscle near
  // MEV looks "near the floor", not "near the top of its own chart").
  const maxVal = Math.max(...series, target ? target.mrv * 1.1 : 1, 1);
  const xAt = (i) => PAD_X + (W - 2*PAD_X) * (i / Math.max(series.length - 1, 1));
  const yAt = (v) => PAD_Y + (H - 2*PAD_Y) * (1 - v / maxVal);

  // Band rectangles (rendered behind the line)
  const bands = [];
  if (target) {
    // Under-MEV zone (alarm) — from 0 to MEV
    bands.push({ y0: yAt(0), y1: yAt(target.mev), fill: T.rose, opacity: 0.06 });
    // Optimal MAV..MRV zone — the sweet spot
    bands.push({ y0: yAt(target.mav), y1: yAt(target.mrv), fill: T.sage, opacity: 0.07 });
    // Over-MRV zone
    bands.push({ y0: yAt(maxVal), y1: yAt(target.mrv), fill: T.coral, opacity: 0.05 });
  }

  const pathD = series.map((v, i) => `${i===0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`).join(" ");
  const areaD = `${pathD} L ${xAt(series.length-1).toFixed(2)} ${H-PAD_Y} L ${xAt(0).toFixed(2)} ${H-PAD_Y} Z`;
  const last = series[series.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H,display:"block"}} aria-hidden="true">
      {bands.map((b, i) => (
        <rect key={i} x={0} y={Math.min(b.y0, b.y1)} width={W} height={Math.abs(b.y1 - b.y0)} fill={b.fill} fillOpacity={b.opacity}/>
      ))}
      <path d={areaD} fill={colour} fillOpacity="0.10"/>
      <path d={pathD} stroke={colour} strokeWidth="1.25" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={xAt(series.length - 1)} cy={yAt(last)} r={2.4} fill={colour} stroke={T.bg2} strokeWidth="1.2"/>
    </svg>
  );
}

// ─── Consistency grid (GitHub-style heatmap) ─────────────────────────────────
// Day labels live INSIDE the SVG, in the same coordinate system as the cells.
// They used to be a fixed-pixel HTML flex column beside a width-scaled SVG —
// the SVG stretched to the card width so its rows rendered taller than 14px,
// and each successive label drifted further from its row (the reported
// "day lettering doesn't align" bug). Sharing one viewBox means labels and
// cells scale together, so alignment holds at any width.
function ConsistencyGrid({ grid }) {
  const CELL = 14, GAP = 3, LABEL_W = 13;
  if (!grid || grid.length === 0) return null;
  const W = LABEL_W + grid.length * (CELL + GAP) - GAP;
  const H = 7 * (CELL + GAP) - GAP;
  const DAYS = ["M","T","W","T","F","S","S"]; // Monday-start, matches col.days (d=0 is weekStart Monday)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%", height:"auto", display:"block"}}>
      {DAYS.map((d, i) => (
        <text key={i}
          x={0} y={i * (CELL + GAP) + CELL / 2}
          dominantBaseline="central"
          fontSize={9} fontWeight={500} fill={T.text4} fontFamily="inherit"
        >{d}</text>
      ))}
      {grid.map((col, ci) => (
        col.days.map((day, di) => {
          const fill = day.trained
            ? (day.cooked ? T.rose : T.sage)
            : T.bg3;
          return (
            <rect key={`${ci}-${di}`}
              x={LABEL_W + ci * (CELL + GAP)} y={di * (CELL + GAP)}
              width={CELL} height={CELL} rx={3}
              fill={fill}
              fillOpacity={day.trained ? (day.cooked ? 0.9 : 1) : 1}
            />
          );
        })
      ))}
    </svg>
  );
}

// ─── Readiness bar ────────────────────────────────────────────────────────────
function ReadinessBar({ readiness }) {
  const { fresh, normal, cooked, total } = readiness;
  if (!total) return <div style={{fontSize:13, color:T.text3, fontFamily:T.serif, fontStyle:"italic"}}>No data yet</div>;
  const p = (n) => (n / total) * 100;
  return (
    <div>
      <div style={{display:"flex", height:10, borderRadius:T.r.pill, overflow:"hidden", marginBottom:12}}>
        <div style={{width:`${p(fresh)}%`,  background:T.sage}}/>
        <div style={{width:`${p(normal)}%`, background:T.gold}}/>
        <div style={{width:`${p(cooked)}%`, background:T.rose}}/>
      </div>
      <div style={{display:"flex", justifyContent:"space-between", fontSize:11, fontFamily:T.sans}}>
        <div style={{color:T.sage}}>Fresh · {fresh} ({Math.round(p(fresh))}%)</div>
        <div style={{color:T.gold}}>Normal · {normal} ({Math.round(p(normal))}%)</div>
        <div style={{color:T.rose}}>Cooked · {cooked} ({Math.round(p(cooked))}%)</div>
      </div>
    </div>
  );
}
