"use client";

// components/PerformanceLab.jsx — Bone & Ember.
// The Lab is dense but loosened: muscles grouped by training day rather
// than ruled into a spreadsheet; every row carries sparkline + band bar +
// number (the redundancy law — colour, form, and the printed figure all
// agree); the recommendation rides a vellum sheet at the foot of the
// volume section. Measured data sits on the ground between hairlines —
// no cards, no glass.

import { useMemo, useState, useEffect } from "react";
import {
  mainLiftTrend, weeklyVolumeByMuscle, weeklyRhythm,
  readinessBreakdown, sessionCount, detectPlateaus,
} from "@/lib/analytics";
import { auditHistoryVolume, AUDIT_MUSCLE_ORDER, VOLUME_TARGETS } from "@/lib/volume-audit";
import Glyph from "@/components/Glyph";
import { W } from "@/lib/storage";
import { WEEK } from "@/lib/programme";
import { T, DISPLAY, HATCH } from "@/lib/tokens";
import { haptic } from "@/lib/a11y";
import GlossarySheet, { GlossaryTrigger } from "@/components/GlossarySheet";
import { renderShareCard, shareCanvas } from "@/lib/share-card";

// Training-day grouping for the volume list — the Lab reads like the week
// trains: push, pull, legs, trunk. (Display grouping only; the audit
// engine stays granular and judges every muscle alone.)
const DAY_GROUPS = [
  { label: "Push", muscles: ["Chest", "Front Delts", "Side Delts", "Triceps"] },
  { label: "Pull", muscles: ["Lats", "Upper Back", "Rear Delts", "Traps", "Biceps", "Forearms", "Erectors"] },
  { label: "Legs", muscles: ["Quads", "Glutes", "Hamstrings", "Calves"] },
  { label: "Trunk", muscles: ["Core"] },
];

// Band status → colour. Under-MEV is the one non-thermal data colour
// (steel — the under-dosed outsider); everything trained maps onto the
// ramp; beyond-MRV is hatched, never just hotter.
const BAND_COLOUR = {
  under_mev:  T.under,
  low:        T.heat[1],
  optimal:    T.heat[2],
  over_mrv:   T.heat[4],
  untargeted: T.ink3,
};
const BAND_LABEL = {
  under_mev:  "under MEV",
  low:        "in productive band",
  optimal:    "in sweet spot",
  over_mrv:   "over MRV",
  untargeted: "untargeted",
};

const linkBtn = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  fontFamily: T.text, fontSize: 13, color: T.ink3,
  display: "inline-flex", alignItems: "center", gap: 5,
};

// ─── Main export ──────────────────────────────────────────────────────────────
export default function PerformanceLab({ history, onBack, resting = false }) {
  const trends  = useMemo(() => mainLiftTrend(history),   [history]);
  const rhythmWeeks = useMemo(() => weeklyRhythm(history, 8), [history]);
  // The strip reads against the user's OWN weekly quota (schedule-aware).
  const weeklyQuota = useMemo(() => {
    const week = W.get() || WEEK;
    return Math.max(1, week.filter((d) => d?.type === "strength").length);
  }, []);
  const readiness = useMemo(() => readinessBreakdown(history), [history]);
  const counts    = useMemo(() => sessionCount(history),       [history]);
  const plateaus  = useMemo(() => detectPlateaus(history),     [history]);
  const volumeAudit  = useMemo(() => auditHistoryVolume(history, { weeks: 2 }), [history]);
  const volumeTrend  = useMemo(() => weeklyVolumeByMuscle(history, { weeks: 8 }), [history]);
  const mainLifts = Object.keys(trends);
  // Drill-down tier (§07): the row is the glance; tapping unfolds the
  // full trend chart beneath it. One open at a time.
  const [expandedLift, setExpandedLift] = useState(null);

  // Glossary sheet — opened by ⓘ triggers throughout the lab.
  const [glossaryAnchor, setGlossaryAnchor] = useState(null);
  const openGlossary = (anchor) => setGlossaryAnchor(anchor ?? "");
  const closeGlossary = () => setGlossaryAnchor(null);

  const isEmpty = counts.total === 0;

  // Headline stats + the guidance line, derived from the audit. Honest:
  // states what is, promises nothing the engine won't do.
  const underMuscles = volumeAudit && !volumeAudit.away
    ? AUDIT_MUSCLE_ORDER.filter(m => volumeAudit.perMuscle[m]?.status === "under_mev")
    : [];
  const setsPerWk = volumeAudit
    ? Math.round(Object.values(volumeAudit.perMuscle || {}).reduce((s, m) => s + (m.sets || 0), 0))
    : 0;
  // Band census for the glance strip: judged = every muscle the audit
  // holds against a landmark; in-band = productive (low/optimal).
  const bandCounts = useMemo(() => {
    const out = { judged: 0, inBand: 0, under: 0, over: 0 };
    if (!volumeAudit || volumeAudit.away) return out;
    for (const m of AUDIT_MUSCLE_ORDER) {
      const st = volumeAudit.perMuscle[m]?.status;
      if (!st || st === "untargeted") continue;
      out.judged++;
      if (st === "low" || st === "optimal") out.inBand++;
      else if (st === "under_mev") out.under++;
      else if (st === "over_mrv") out.over++;
    }
    return out;
  }, [volumeAudit]);
  const guidance = isEmpty
    ? "Go train. The numbers follow."
    : volumeAudit?.away
    ? "A lighter stretch. That's part of training."
    : underMuscles.length === 0
    ? "Every muscle is in its productive band. Keep going."
    : underMuscles.length === 1
    ? `${underMuscles[0]} is under minimum. A set or two next week moves it.`
    : `${underMuscles.length} muscles are under minimum. ${underMuscles.slice(0,2).join(" and ")} first.`;

  return (
    <div style={{minHeight:"100vh", maxWidth:430, margin:"0 auto", paddingBottom:48, position:"relative", overflow:"clip"}}>

      {/* Top clearance is self-sufficient: max() guarantees the back nav
          clears the translucent status bar in the installed PWA. */}
      <div style={{padding:"max(52px, calc(env(safe-area-inset-top, 0px) + 12px)) 24px 0", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <button onClick={onBack} style={{...linkBtn,color:T.ink2}}><Glyph name="arrowLeft" size={12} color={T.ink3}/> Home</button>
        {!isEmpty && (
          <span style={{fontSize:12,color:T.ink3}}>
            <span style={{fontFamily:T.measured}}>{counts.last7}</span> this week · <span style={{fontFamily:T.measured}}>{counts.total}</span> logged
          </span>
        )}
      </div>

      <div style={{padding:"28px 24px 0"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
          <span style={{fontSize:13, color:T.ink2}}>Volume · past <span style={{fontFamily:T.measured,fontSize:12}}>28</span> days</span>
          <GlossaryTrigger onOpen={openGlossary} label="Open glossary"/>
        </div>
        <h1 className="home-headline" style={{...DISPLAY, fontSize:45, color:T.ink, margin:0, transformOrigin:"left top"}}>
          The lab
        </h1>
        <div style={{fontSize:15, color:T.ink2, marginTop:10, lineHeight:1.45, maxWidth:"32ch"}}>
          {guidance}
        </div>
      </div>

      {/* §13.3 — the glance strip: one hairline-bounded line, the whole
          Lab in one reading. The tier-one promise, literally. */}
      {!isEmpty && !volumeAudit?.away && (
        <div style={{margin:"16px 0 0",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,padding:"10px 24px",fontSize:13,color:T.ink2,display:"flex",gap:14,flexWrap:"wrap"}}>
          <span><span style={{fontFamily:T.measured}}>{setsPerWk}</span> sets /wk</span>
          <span><span style={{fontFamily:T.measured}}>{bandCounts.inBand}</span> of <span style={{fontFamily:T.measured}}>{bandCounts.judged}</span> in band</span>
          {bandCounts.under > 0 && <span style={{color:T.under}}><span style={{fontFamily:T.measured}}>{bandCounts.under}</span> under</span>}
          {bandCounts.over > 0 && <span><span style={{fontFamily:T.measured}}>{bandCounts.over}</span> over</span>}
        </div>
      )}

      {/* Breather banner — only when a break is DECLARED (resting). */}
      {resting && !isEmpty && (
        <div style={{margin:"18px 24px 0"}}>
          <div style={{fontSize:13,color:T.ink3,marginBottom:4}}>On a breather</div>
          <div style={{fontSize:14,color:T.ink2,lineHeight:1.5}}>
            Your numbers are holding. Come back when it feels right.
          </div>
        </div>
      )}

      {isEmpty && <EmptyState />}

      {!isEmpty && (
        <>
          {/* §13.5 — the Lab is a journal, not one chart: strength first
              (the e1RM numbers are the headline), the rhythm she controls
              second, the volume diagnostics that explain both last. */}
          {mainLifts.length > 0 && (
            <div className="lab-card" style={{margin:"24px 24px 0"}}>
              <div style={{paddingBottom:8,borderBottom:`1px solid ${T.rule}`,fontSize:13,color:T.ink3}}>
                Strength · e1RM vs <span style={{fontFamily:T.measured}}>28</span> days · tap a lift for the full trend
              </div>
              {mainLifts.map(lift => (
                <StrengthRow key={lift} lift={lift} series={trends[lift] || []}
                  expanded={expandedLift === lift}
                  onToggle={() => setExpandedLift(expandedLift === lift ? null : lift)}/>
              ))}
            </div>
          )}

          {/* §13.5 consistency — planned sessions as hairline squares,
              completed filled with the day key; adherence as texture. */}
          <div className="lab-card" style={{margin:"28px 24px 0"}}>
            <ConsistencyCells weeks={rhythmWeeks} quota={weeklyQuota}/>
          </div>

          {/* Volume ledger — muscles grouped by training day, dense rows. */}
          <div className="lab-card">
            <VolumeLandscape trend={volumeTrend} audit={volumeAudit} totalSessions={counts.total} openGlossary={openGlossary} />
          </div>

          {/* Recommendation — the vellum sheet at the foot of the volume
              story. In flow, not fixed: a fixed painted bar at the bottom
              edge re-triggers Safari 26's opaque chrome slabs. */}
          {!volumeAudit?.away && counts.total >= 4 && (
            <div className="forge-vellum lab-card" style={{margin:"14px 24px 0",borderRadius:T.r,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:14}}>
              <span style={{fontSize:13,color:T.ink2,lineHeight:1.4}}>
                {plateaus.length > 0
                  ? <>Your {plateaus[0].lift} has held at <span style={{fontFamily:T.measured}}>{plateaus[0].weight}</span> kg for <span style={{fontFamily:T.measured}}>{plateaus[0].sessions}</span> sessions. A deload or a rep-range shift breaks the pattern.</>
                  : underMuscles.length > 0
                  ? <>{underMuscles[0]} responds fastest to what it isn&rsquo;t getting — one set at a time.</>
                  : <>Volume is landing where it grows. The programme holds.</>}
              </span>
            </div>
          )}

          {/* Readiness breakdown — the one other place the ramp speaks. */}
          <div className="lab-card" style={{margin:"28px 24px 0"}}>
            <div style={{paddingBottom:8,borderBottom:`1px solid ${T.rule}`,fontSize:13,color:T.ink3}}>
              How you&rsquo;ve shown up · readiness across all sessions
            </div>
            <div style={{paddingTop:14}}>
              <ReadinessBar readiness={readiness} />
            </div>
          </div>
        </>
      )}

      {glossaryAnchor !== null && (
        <GlossarySheet anchorTerm={glossaryAnchor || null} onCancel={closeGlossary}/>
      )}

      {!isEmpty && <ScrollCue />}
    </div>
  );
}

// ─── Scroll cue ───────────────────────────────────────────────────────────────
// The explicit "there's more" signal. Fixed at the fold but PAINT-FREE
// (no background), so the Safari chrome sampler ignores it. Fades on
// scroll via the CSS scroll() timeline.
function ScrollCue() {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const update = () => setOverflows(document.documentElement.scrollHeight > window.innerHeight + 24);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  if (!overflows) return null;
  return (
    <div aria-hidden="true" className="lab-scroll-cue-wrap" style={{
      position: "fixed", left: "50%", bottom: "calc(env(safe-area-inset-bottom, 0px) + 22px)",
      transform: "translateX(-50%)", pointerEvents: "none", zIndex: 20,
      opacity: 0.72,
    }}>
      <svg className="lab-scroll-cue" width="26" height="15" viewBox="0 0 26 15" fill="none">
        <path d="M2 2.5 L13 12 L24 2.5" stroke={T.ink3} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

// ─── Empty state — the first-run promise, in the system's own grammar ────────
// Audit §10.7: the empty Lab shows the SHAPE of the finished Lab from day
// one — per-muscle glance rails, grouped by training day, with real
// MEV/MRV landmarks and a hatched continuation drawn in pencil (ink), not
// heat. Nothing simulated: the landmarks are the programme's own targets,
// the counts are honestly zero, the hatch says "this is a sketch".
const INK_HATCH = "repeating-linear-gradient(45deg, var(--ink-3) 0 2px, transparent 2px 6px)";
function EmptyState() {
  const groups = DAY_GROUPS.map(g => ({
    label: g.label,
    rows: g.muscles.filter(m => VOLUME_TARGETS[m]),
  })).filter(g => g.rows.length > 0);
  return (
    <div style={{margin:"32px 0 0"}}>
      <div style={{padding:"0 24px"}}>
        {/* Section header within the page — never the page title (§11.3);
            "The lab" above stays the room. */}
        <div style={{fontSize:13,color:T.ink3,paddingBottom:6,borderBottom:`1px solid ${T.rule}`,marginBottom:10}}>
          Week one
        </div>
        <p style={{fontSize:13, color:T.ink2, lineHeight:1.6, maxWidth:"36ch"}}>
          This is the shape of your Lab. Your first session starts filling
          it in: solid ink for work done, MEV and MRV ticks marking each
          muscle&rsquo;s productive band. The hatch is where it&rsquo;s going.
        </p>
      </div>
      {groups.map(g => (
        <div key={g.label}>
          <div style={{padding:"14px 24px 5px",fontSize:12,color:T.ink3}}>{g.label}</div>
          <div style={{padding:"0 24px"}}>
            {g.rows.map(m => {
              const t = VOLUME_TARGETS[m];
              const barMax = t.mrv * 1.28;
              const displayName = m.replace(" Delts", " delt").replace("Upper Back", "Upper back");
              return (
                <div key={m} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderTop:`1px solid ${T.ruleFaint}`}}
                  aria-label={`${displayName}: no sets yet — MEV ${t.mev}, MRV ${t.mrv}`}>
                  <span style={{width:82,fontSize:15,color:T.ink2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{displayName}</span>
                  <div style={{flex:1,position:"relative",height:8,background:T.well}} aria-hidden="true">
                    <div style={{position:"absolute",left:0,top:0,height:8,width:`${(t.mev / barMax) * 100}%`,backgroundImage:INK_HATCH}}/>
                    <div style={{position:"absolute",left:`${(t.mev / barMax) * 100}%`,top:-3,width:1,height:14,background:T.ink,opacity:0.3}}/>
                    <div style={{position:"absolute",left:`${(t.mrv / barMax) * 100}%`,top:-3,width:1,height:14,background:T.ink,opacity:0.3}}/>
                  </div>
                  <span style={{width:26,textAlign:"right",fontFamily:T.measured,fontSize:13,color:T.ink3}}>0</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div style={{margin:"14px 24px 0",fontSize:12,color:T.ink3,lineHeight:1.5}}>
        Hatched to each muscle&rsquo;s minimum effective volume · ticks at MEV and MRV · real landmarks, no simulated data.
      </div>
    </div>
  );
}

// ─── Ink sparkline — §13.1's data mark: 1.5px ink, no fill, no axes ──────────
function InkSpark({ values, width = 44, height = 12, stroke = 1.5, color = "var(--ink-2)" }) {
  const v = (values || []).filter((x) => Number.isFinite(x));
  if (v.length < 2) return <span style={{width}} aria-hidden="true"/>;
  const max = Math.max(...v), min = Math.min(...v);
  const range = max - min || 1;
  const d = v.map((x, i) =>
    `${i===0?"M":"L"} ${(i * (width / (v.length - 1))).toFixed(1)} ${(height - 2 - (height - 4) * ((x - min) / range)).toFixed(1)}`
  ).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{overflow:"visible",flexShrink:0}} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

// ─── Strength rows — one per main lift on the volume-row template ────────────
// lift · e1RM sparkline · mono current · delta vs 28 days. The old
// one-chart-with-selector died here (§13.5: nothing gets its own card);
// the share card survives per row.
function StrengthRow({ lift, series, expanded = false, onToggle }) {
  const cur = series[series.length - 1];
  if (!cur) return null;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 28);
  const cutIso = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,"0")}-${String(cutoff.getDate()).padStart(2,"0")}`;
  const base = series.find((p) => p.date >= cutIso) || series[0];
  const delta = Math.round((cur.est1RM - base.est1RM) * 10) / 10;
  const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "level";
  return (
    <div className="lab-card" style={{borderTop:`1px solid ${T.ruleFaint}`}}>
    <div role="button" tabIndex={0} onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle?.(); } }}
      className="forge-press forge-tint"
      style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",cursor:"pointer"}}
      aria-expanded={expanded}
      aria-label={`${lift}: estimated 1RM ${cur.est1RM} kg, ${deltaStr === "level" ? "level" : `${deltaStr} kg`} vs 28 days ago. ${expanded ? "Hide" : "Show"} full trend`}>
      <span style={{flex:1,minWidth:0,fontSize:15,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lift}</span>
      <InkSpark values={series.slice(-8).map(p => p.est1RM)}/>
      <span style={{fontFamily:T.measured,fontSize:15,color:T.ink,flexShrink:0}}>{cur.est1RM}<span style={{fontFamily:T.text,fontSize:11,color:T.ink3}}> kg</span></span>
      <span style={{width:58,textAlign:"right",fontSize:11,color:delta > 0 ? T.heat[3] : T.ink3,flexShrink:0}}>
        {delta !== 0 ? <><span style={{fontFamily:T.measured}}>{deltaStr}</span> kg</> : "level"}
      </span>
      <button
        onClick={async ()=>{
          const canvas = await renderShareCard({ lift, series });
          await shareCanvas(canvas, `heatwayve-${lift.toLowerCase().replace(/[^a-z0-9]+/g,"-")}-1rm.png`);
        }}
        style={{background:"none",border:"none",padding:"4px 0 4px 4px",cursor:"pointer",flexShrink:0,display:"inline-flex"}}
        aria-label={`Share ${lift} trend`}>
        <Glyph name="arrowUpRight" size={11} color={T.ink3}/>
      </button>
    </div>
    {/* §07's second tier — surface: detail fades in on engagement,
        progressive disclosure over resizing. */}
    {expanded && (
      <div style={{padding:"4px 0 14px",animation:`fadeSlide 240ms ${T.ease}`}}>
        <LineChart series={series}/>
      </div>
    )}
    </div>
  );
}

// ─── Line chart (1RM trend) ──────────────────────────────────────────────────
// Hand-rolled SVG. The stroke is a heat gradient along its own length —
// the line heats as it climbs. Cooked sessions print hollow points.
function LineChart({ series }) {
  const W = 320, H = 108, PAD_X = 12, PAD_Y = 18;
  if (!series || series.length === 0) {
    return <div style={{padding:"24px 0", fontSize:13, color:T.ink3, textAlign:"center"}}>No data yet</div>;
  }
  // Single data point: show the number, no line.
  if (series.length === 1) {
    const p = series[0];
    return (
      <div style={{textAlign:"center", padding:"18px 0"}}>
        <div style={{fontFamily:T.measured, fontSize:48, fontWeight:300, letterSpacing:"-0.04em", color:T.ink, lineHeight:1}}>{p.est1RM}<span style={{fontSize:18, color:T.ink3, marginLeft:4}}>kg</span></div>
        <div style={{fontSize:12, color:T.ink3, marginTop:8}}>{p.date} · top set <span style={{fontFamily:T.measured}}>{p.topSet.weight}</span> kg × <span style={{fontFamily:T.measured}}>{p.topSet.reps}</span></div>
        <div style={{fontSize:12, color:T.ink3, marginTop:6}}>Log another session to see the trend</div>
      </div>
    );
  }

  const values = series.map(p => p.est1RM);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const rangeV = maxV - minV || 1;
  const yMin = minV - rangeV * 0.2;
  const yMax = maxV + rangeV * 0.2;

  const xAt = (i) => PAD_X + (W - 2*PAD_X) * (i / (series.length - 1));
  const yAt = (v) => PAD_Y + (H - 2*PAD_Y) * (1 - (v - yMin) / (yMax - yMin));

  const pathD = series.map((p, i) => `${i===0 ? "M" : "L"} ${xAt(i)} ${yAt(p.est1RM)}`).join(" ");
  const areaD = `${pathD} L ${xAt(series.length-1)} ${H-PAD_Y} L ${xAt(0)} ${H-PAD_Y} Z`;

  const latest  = series[series.length-1];
  const first   = series[0];
  const delta   = latest.est1RM - first.est1RM;
  const pctDelta= first.est1RM > 0 ? (delta / first.est1RM) * 100 : 0;

  return (
    <div>
      <div style={{display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:10}}>
        <div>
          <span style={{fontFamily:T.measured, fontSize:30, fontWeight:300, letterSpacing:"-0.03em", color:T.ink}}>{latest.est1RM}</span>
          <span style={{fontSize:13, color:T.ink3, marginLeft:4}}>kg</span>
        </div>
        <div style={{fontFamily:T.measured, fontSize:12, color:T.ink2}}>
          {delta >= 0 ? "+" : ""}{delta.toFixed(1)} kg · {pctDelta >= 0 ? "+" : ""}{pctDelta.toFixed(1)}%
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%", height:"auto", display:"block"}}>
        <defs>
          <linearGradient id="hwLabTrend" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--heat-1)"/>
            <stop offset="0.6" stopColor="var(--heat-2)"/>
            <stop offset="1" stopColor="var(--heat-3)"/>
          </linearGradient>
          <linearGradient id="hwLabArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--heat-3)" stopOpacity="0.12"/>
            <stop offset="1" stopColor="var(--heat-3)" stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#hwLabArea)" />
        <path d={pathD} stroke="url(#hwLabTrend)" strokeWidth="1.6" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
        {series.map((p, i) => (
          <circle key={i} cx={xAt(i)} cy={yAt(p.est1RM)} r={i === series.length-1 ? 3.6 : 2.4}
            fill={p.cooked ? "var(--heat-4)" : "var(--heat-2)"}
            stroke="var(--ground)" strokeWidth="1.4"/>
        ))}
      </svg>
      <div style={{display:"flex", justifyContent:"space-between", marginTop:6, fontFamily:T.measured, fontSize:10, color:T.ink3}}>
        <span>{first.date.slice(5).replace("-","/")}</span>
        <span>{latest.date.slice(5).replace("-","/")}</span>
      </div>
    </div>
  );
}

// ─── Consistency — the last 8 weeks as day cells (§13.5) ─────────────────────
// Planned sessions are hairline squares; completed ones fill with the
// strength day key at the mark radius. Adherence reads as texture; the
// streak prints in mono at the right.
function ConsistencyCells({ weeks, quota }) {
  if (!weeks || weeks.length === 0) return null;
  const done = weeks.reduce((n, w) => n + Math.min(w.days, quota), 0);
  const planned = weeks.length * quota;
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",paddingBottom:8,borderBottom:`1px solid ${T.rule}`}}>
        <span style={{fontSize:13,color:T.ink3}}>
          Consistency · last <span style={{fontFamily:T.measured}}>{weeks.length}</span> weeks vs your week
        </span>
        <span style={{fontSize:12,color:T.ink2}}>
          <span style={{fontFamily:T.measured}}>{done}</span> of <span style={{fontFamily:T.measured}}>{planned}</span> planned
        </span>
      </div>
      <div style={{display:"flex",gap:10,paddingTop:12}} aria-label={`${done} of ${planned} planned sessions completed across ${weeks.length} weeks`}>
        {weeks.map((w) => (
          <div key={w.weekStart} style={{display:"flex",gap:3}}>
            {Array.from({ length: quota }, (_, i) => (
              <span key={i} aria-hidden="true" style={{
                width:10,height:10,borderRadius:T.rMark,
                background: i < w.days ? T.dayKey.strength : "transparent",
                boxShadow: i < w.days ? "none" : `inset 0 0 0 1px ${T.rule}`,
              }}/>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Volume landscape — rows grouped by training day ─────────────────────────
function VolumeLandscape({ trend, audit, totalSessions = 0, openGlossary }) {
  // New user — not enough logged history anywhere yet. Encourage logging
  // rather than render a wall of "under MEV" alarms for someone starting.
  if (!audit || totalSessions < 4) {
    return (
      <div style={{margin:"20px 24px 0",fontSize:13, color:T.ink2, lineHeight:1.5}}>
        A few more sessions and every muscle takes its place on these
        rails, held against its own productive band.
      </div>
    );
  }

  const rowFor = (muscle) => {
    const a = audit.perMuscle[muscle] || { sets: 0, target: null, status: "untargeted" };
    const series = trend?.byMuscle?.[muscle] || [];
    return { muscle, sets: a.sets, target: a.target, status: a.status, series };
  };

  // "Away" — the user HAS history but the recent window is empty. The
  // sparklines stay (eight weeks of story is context, not shame); the
  // judgement is suspended.
  if (audit.away) {
    const historical = AUDIT_MUSCLE_ORDER.map(rowFor)
      .filter(r => r.series.some(v => v > 0))
      .sort((a, b) => b.series.reduce((s, v) => s + v, 0) - a.series.reduce((s, v) => s + v, 0));
    // The away beat lives ONCE, in the masthead support line — a callout
    // here repeated it and spent six lines saying so (boss report,
    // 2026-08-04). The muted rows carry the eight-week state on their own.
    return (
      <div style={{margin:"18px 24px 0"}}>
        {historical.map(row => <MuscleRow key={row.muscle} {...row} muted />)}
      </div>
    );
  }

  // Union: everything with a landmark (missed muscles surface as
  // under-MEV) plus anything trained without one.
  const extra = Object.keys(trend?.byMuscle || {}).filter(m => !AUDIT_MUSCLE_ORDER.includes(m));
  const placed = new Set();
  const groups = DAY_GROUPS.map(g => ({
    label: g.label,
    rows: g.muscles.filter(m => AUDIT_MUSCLE_ORDER.includes(m) || extra.includes(m))
      .map(m => { placed.add(m); return rowFor(m); })
      .filter(r => r.target || r.sets > 0 || r.series.some(v => v > 0)),
  })).filter(g => g.rows.length > 0);
  const leftovers = [...AUDIT_MUSCLE_ORDER, ...extra]
    .filter(m => !placed.has(m)).map(rowFor)
    .filter(r => r.target || r.sets > 0 || r.series.some(v => v > 0));
  if (leftovers.length) groups.push({ label: "Other", rows: leftovers });

  return (
    <div style={{margin:"6px 0 0"}}>
      <div style={{padding:"14px 24px 0",display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:13,color:T.ink3}}>
          Sets per week vs MEV/MAV/MRV · last <span style={{fontFamily:T.measured}}>{audit.weeksAnalysed}</span> complete weeks
        </span>
        <GlossaryTrigger anchorTerm="volume-landmarks" onOpen={openGlossary} label="Explain MEV / MAV / MRV"/>
      </div>
      {groups.map(g => {
        const gSets = Math.round(g.rows.reduce((n, r) => n + (r.sets || 0), 0));
        const judged = g.rows.filter(r => r.status && r.status !== "untargeted").length;
        const inBand = g.rows.filter(r => r.status === "low" || r.status === "optimal").length;
        return (
          <div key={g.label}>
            {/* §13.2 — a label that could be data is wasted ink. */}
            <div style={{padding:"12px 24px 5px",display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <span style={{fontSize:12,color:T.ink3}}>{g.label}</span>
              <span style={{fontSize:11,color:T.ink2}}>
                <span style={{fontFamily:T.measured}}>{gSets}</span> sets · <span style={{fontFamily:T.measured}}>{inBand}</span> of <span style={{fontFamily:T.measured}}>{judged}</span> in band
              </span>
            </div>
            <div style={{padding:"0 24px"}}>
              {g.rows.map(row => <MuscleRow key={row.muscle} {...row} />)}
            </div>
          </div>
        );
      })}
      <div style={{margin:"14px 24px 0",fontSize:12,color:T.ink3,lineHeight:1.5}}>
        Sparklines are the last <span style={{fontFamily:T.measured}}>8</span> weeks · ticks mark MEV and MRV · beyond-MRV work is hatched. Read from your recent weeks, not your lifetime average.
      </div>
    </div>
  );
}

// One muscle: name · 6-week micro-wave · band bar (with MEV/MRV ticks and
// hatched overflow) · the number. Colour never carries alone — height,
// position and the printed figure agree with it.
function MuscleRow({ muscle, sets, target, status, series, muted = false }) {
  const colour = muted ? T.ink3 : (BAND_COLOUR[status] || T.ink3);
  const label = muted ? "resting" : (BAND_LABEL[status] || "");
  const displayName = muscle.replace(" Delts", " delt").replace("Upper Back", "Upper back");

  // Band bar scale: 0 → ~1.28×MRV so the MRV tick sits ~78% along and a
  // just-over ramp still fits. No landmark → plain proportional bar.
  const barMax = target ? Math.max(target.mrv * 1.28, sets * 1.05, 1) : Math.max(sets * 1.3, 1);
  const fillPct = Math.min(100, (sets / barMax) * 100);
  const mrvPct = target ? (target.mrv / barMax) * 100 : null;
  const mevPct = target ? (target.mev / barMax) * 100 : null;
  const over = target && sets > target.mrv;
  const solidPct = over ? mrvPct : fillPct;

  // 6-week micro-wave from the 8-week series.
  const wave = (series || []).slice(-6);
  const wMax = Math.max(...wave, 1);
  const waveD = wave.length > 1
    ? wave.map((v, i) => `${i===0?"M":"L"} ${(i * (38 / (wave.length - 1))).toFixed(1)} ${(11 - 9 * (v / wMax)).toFixed(1)}`).join(" ")
    : null;

  // Week-over-week trend for the right column (§13.1: "+2 vs last wk").
  const wkDelta = series && series.length >= 2
    ? Math.round(series[series.length - 1] - series[series.length - 2])
    : null;
  const emptyWithTarget = sets === 0 && target;

  return (
    // Two lines, seven facts, same height the old row spent on three
    // (§13.1). lab-card = the scroll-driven arrival; per-row is finer
    // grained than the old per-card glide.
    <div className="lab-card" style={{padding:"8px 0",borderTop:`1px solid ${T.ruleFaint}`}}
      aria-label={`${displayName}: ${sets} sets per week${target ? `, ${label}, MEV ${target.mev}, MRV ${target.mrv}` : ""}${wkDelta != null ? `, ${wkDelta >= 0 ? "up" : "down"} ${Math.abs(wkDelta)} versus last week` : ""}`}>
      {/* Line one: name · sparkline (ink, no fill, no axes) · mono count.
          Empty rows tell the programme (§13.6): the target, not a zero. */}
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{flex:1,minWidth:0,fontSize:15,color:muted?T.ink2:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{displayName}</span>
        <svg width="44" height="13" viewBox="0 0 44 13" style={{overflow:"visible",flexShrink:0}} aria-hidden="true">
          {waveD && <path d={waveD} fill="none" stroke={muted?T.ink3:"var(--ink-2)"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>}
          {wave.length > 0 && <circle cx="38" cy={(11 - 9 * (wave[wave.length-1] / wMax)).toFixed(1)} r="1.7" fill={muted?T.ink3:"var(--ink-2)"}/>}
        </svg>
        <span style={{minWidth:40,textAlign:"right",fontSize:13,color:T.ink,flexShrink:0}}>
          {emptyWithTarget
            ? <><span style={{fontFamily:T.measured,color:T.ink3}}>0</span><span style={{fontSize:11,color:T.ink3}}> of </span><span style={{fontFamily:T.measured,color:T.ink3}}>{target.mev}</span></>
            : <span style={{fontFamily:T.measured}}>{sets}</span>}
        </span>
      </div>
      {/* Line two: the band rail as built · the trend, in words. */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
        <div style={{flex:1,position:"relative",height:8,background:T.well}} aria-hidden="true">
          {mevPct != null && <div style={{position:"absolute",left:`${mevPct}%`,top:-3,width:1,height:14,background:T.ink,opacity:0.3}}/>}
          {mrvPct != null && <div style={{position:"absolute",left:`${mrvPct}%`,top:-3,width:1,height:14,background:T.ink,opacity:0.3}}/>}
          <div style={{position:"absolute",left:0,top:0,height:8,width:`${solidPct}%`,background:colour}}/>
          {over && (
            <div style={{position:"absolute",left:`${mrvPct}%`,top:0,height:8,width:`${fillPct - mrvPct}%`,backgroundColor:T.heatOver,backgroundImage:HATCH.auto}}/>
          )}
        </div>
        <span style={{minWidth:78,textAlign:"right",fontSize:11,color:T.ink3,flexShrink:0}} aria-hidden="true">
          {wkDelta == null || muted ? "" :
            wkDelta === 0 ? "level vs last wk" :
            <><span style={{fontFamily:T.measured,color:wkDelta>0?T.ink2:T.ink3}}>{wkDelta>0?`+${wkDelta}`:wkDelta}</span> vs last wk</>}
        </span>
      </div>
    </div>
  );
}


// ─── Readiness bar ────────────────────────────────────────────────────────────
// fresh / normal / cooked on the one intensity scale — the ramp's cool,
// middle and hot steps. Numbers always printed.
function ReadinessBar({ readiness }) {
  const { fresh, normal, cooked, total } = readiness;
  if (!total) return <div style={{fontSize:13, color:T.ink2}}>Rate a session and this fills in.</div>;
  const p = (n) => (n / total) * 100;
  return (
    <div>
      <div style={{display:"flex", height:10, overflow:"hidden", marginBottom:12}}>
        <div style={{width:`${p(fresh)}%`,  background:T.heat[0]}}/>
        <div style={{width:`${p(normal)}%`, background:T.heat[2]}}/>
        <div style={{width:`${p(cooked)}%`, background:T.heat[4]}}/>
      </div>
      <div style={{display:"flex", justifyContent:"space-between", fontSize:12, color:T.ink2}}>
        <span>Fresh · <span style={{fontFamily:T.measured}}>{fresh}</span> (<span style={{fontFamily:T.measured}}>{Math.round(p(fresh))}</span>%)</span>
        <span>Normal · <span style={{fontFamily:T.measured}}>{normal}</span> (<span style={{fontFamily:T.measured}}>{Math.round(p(normal))}</span>%)</span>
        <span>Cooked · <span style={{fontFamily:T.measured}}>{cooked}</span> (<span style={{fontFamily:T.measured}}>{Math.round(p(cooked))}</span>%)</span>
      </div>
    </div>
  );
}
