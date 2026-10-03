// components/LiftCharts.jsx — the e1RM line chart and the ink sparkline.
// Presentational only: each takes a series and knows nothing about whose
// it is. Moved from PerformanceLab so another read-only view can draw the
// same marks; the Lab imports them from here.

import { useId } from "react";
import { T } from "@/lib/tokens";

// ─── Ink sparkline — §13.1's data mark: 1.5px ink, no fill, no axes ──────────
export function InkSpark({ values, width = 44, height = 12, stroke = 1.5, color = "var(--ink-2)" }) {
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

// ─── Line chart (1RM trend) ──────────────────────────────────────────────────
// Hand-rolled SVG. The stroke is a heat gradient along its own length —
// the line heats as it climbs. Cooked sessions print hollow points.
export function LineChart({ series }) {
  // Gradient ids are per instance: the trainer view draws several charts at once.
  const uid = useId();
  const trendId = `hwTrend${uid}`, areaId = `hwArea${uid}`;
  const W = 320, H = 108, PAD_X = 12, PAD_Y = 18;
  if (!series || series.length === 0) {
    return <div style={{padding:"24px 0", fontSize:13, color:T.ink3, textAlign:"center"}}>Nothing to chart yet</div>;
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
          <linearGradient id={trendId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--trend-1)"/>
            <stop offset="0.6" stopColor="var(--trend-2)"/>
            <stop offset="1" stopColor="var(--trend-3)"/>
          </linearGradient>
          <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--trend-3)" stopOpacity="0.12"/>
            <stop offset="1" stopColor="var(--trend-3)" stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#${areaId})`} />
        <path d={pathD} stroke={`url(#${trendId})`} strokeWidth="1.6" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
        {series.map((p, i) => (
          <circle key={i} cx={xAt(i)} cy={yAt(p.est1RM)} r={i === series.length-1 ? 3.6 : 2.4}
            fill={p.cooked ? "var(--heat-4)" : "var(--trend-2)"}
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
