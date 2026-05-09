"use client";

import { useMemo, useState } from "react";
import {
  mainLiftTrend, weeklyVolume, consistencyGrid,
  readinessBreakdown, sessionCount, detectPlateaus,
} from "@/lib/analytics";
import { T, MUSCLE_COLOURS } from "@/lib/tokens";

// ─── Main export ──────────────────────────────────────────────────────────────
export default function PerformanceLab({ history, onBack }) {
  const trends  = useMemo(() => mainLiftTrend(history),   [history]);
  const volume  = useMemo(() => weeklyVolume(history),    [history]);
  const grid    = useMemo(() => consistencyGrid(history, 12), [history]);
  const readiness = useMemo(() => readinessBreakdown(history), [history]);
  const counts    = useMemo(() => sessionCount(history),       [history]);
  const plateaus  = useMemo(() => detectPlateaus(history),     [history]);

  const mainLifts = Object.keys(trends);
  const [selectedLift, setSelectedLift] = useState(null);
  // Default to first lift once data arrives
  const activeLift = selectedLift || mainLifts[0] || null;

  const isEmpty = counts.total === 0;

  return (
    <div style={{minHeight:"100vh", paddingBottom:48, position:"relative", overflow:"hidden"}}>
      {/* Header — ambient glow */}
      <div style={{position:"absolute", top:-180, left:"50%", transform:"translateX(-50%)", width:600, height:500, background:`radial-gradient(ellipse, rgba(196,168,130,0.10) 0%, transparent 65%)`, pointerEvents:"none"}}/>

      <div style={{padding:"52px 24px 0", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <button onClick={onBack} style={{background:"none", border:"none", padding:0, cursor:"pointer", fontSize:12, color:T.text3, fontFamily:T.sans}}>
          ← Home
        </button>
      </div>

      <div style={{padding:"32px 24px 0"}}>
        <div style={{fontSize:11, fontWeight:500, color:T.text3, letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:10}}>
          Performance lab
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

          {/* Weekly volume */}
          <Card title="Weekly volume" subtitle="Sets per muscle group · last 8 weeks">
            <VolumeChart weeks={volume.slice(-8)} />
            <VolumeLegend data={volume.slice(-8)} />
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
function Card({ title, subtitle, children }) {
  return (
    <div style={{margin:"24px 24px 0", background:T.bg2, border:`1px solid ${T.bg3}`, borderRadius:T.r.lg, overflow:"hidden"}}>
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

// ─── Volume chart (stacked bars per week) ────────────────────────────────────
function VolumeChart({ weeks }) {
  const W = 320, H = 160, PAD_X = 8, PAD_Y = 16;
  if (!weeks || weeks.length === 0) {
    return <div style={{padding:"28px 0", fontSize:13, color:T.text3, fontFamily:T.serif, fontStyle:"italic", textAlign:"center"}}>No weeks to show</div>;
  }

  // Build totals per muscle per week, then find max stack for y-scale
  const muscles = new Set();
  weeks.forEach(w => Object.keys(w.byMuscle).forEach(m => muscles.add(m)));
  const orderedMuscles = Array.from(muscles);

  const weekTotals = weeks.map(w =>
    orderedMuscles.reduce((sum, m) => sum + (w.byMuscle[m]?.sets || 0), 0)
  );
  const maxTotal = Math.max(...weekTotals, 1);

  const barWidth = (W - 2*PAD_X) / weeks.length - 4;
  const chartH = H - 2*PAD_Y;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%", height:"auto", display:"block"}}>
      {weeks.map((w, wi) => {
        let yOffset = H - PAD_Y;
        const x = PAD_X + wi * ((W - 2*PAD_X) / weeks.length) + 2;
        return (
          <g key={wi}>
            {orderedMuscles.map((m, mi) => {
              const sets = w.byMuscle[m]?.sets || 0;
              if (!sets) return null;
              const h = (sets / maxTotal) * chartH;
              yOffset -= h;
              const colour = MUSCLE_COLOURS[m] || T.text3;
              return (
                <rect key={m} x={x} y={yOffset} width={barWidth} height={h}
                  fill={colour} fillOpacity="0.85"
                  rx={mi === 0 ? 2 : 0}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function VolumeLegend({ data }) {
  const muscles = new Set();
  (data || []).forEach(w => Object.keys(w.byMuscle).forEach(m => muscles.add(m)));
  const list = Array.from(muscles);
  if (list.length === 0) return null;
  return (
    <div style={{display:"flex", flexWrap:"wrap", gap:"6px 12px", marginTop:12}}>
      {list.map(m => (
        <div key={m} style={{display:"flex", alignItems:"center", gap:6}}>
          <div style={{width:8, height:8, borderRadius:2, background: MUSCLE_COLOURS[m] || T.text3}}/>
          <span style={{fontSize:10, color:T.text3, fontWeight:500}}>{m}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Consistency grid (GitHub-style heatmap) ─────────────────────────────────
function ConsistencyGrid({ grid }) {
  const CELL = 14, GAP = 3;
  if (!grid || grid.length === 0) return null;
  const W = grid.length * (CELL + GAP);
  const H = 7 * (CELL + GAP);
  return (
    <div style={{display:"flex", gap:6, alignItems:"flex-start"}}>
      {/* Day labels */}
      <div style={{display:"flex", flexDirection:"column", gap:GAP, paddingTop:2}}>
        {["M","T","W","T","F","S","S"].map((d,i) => (
          <div key={i} style={{height:CELL, display:"flex", alignItems:"center", fontSize:9, color:T.text4, fontWeight:500}}>{d}</div>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%", height:"auto", display:"block"}}>
        {grid.map((col, ci) => (
          col.days.map((day, di) => {
            const fill = day.trained
              ? (day.cooked ? T.rose : T.sage)
              : T.bg3;
            return (
              <rect key={`${ci}-${di}`}
                x={ci * (CELL + GAP)} y={di * (CELL + GAP)}
                width={CELL} height={CELL} rx={3}
                fill={fill}
                fillOpacity={day.trained ? (day.cooked ? 0.9 : 1) : 1}
              />
            );
          })
        ))}
      </svg>
    </div>
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
