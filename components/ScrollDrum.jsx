"use client";

// components/ScrollDrum.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS-style scroll-snap picker drum — Bone & Ember. Depth comes from TONAL
// FALLOFF and TYPE SCALE, zero blur: values fade and shrink toward the rim
// (CSS view-timeline, .drum-item in globals.css), so the drum reads as
// curved with no glass cylinder. Digits are measured values → mono. The
// selection band is a recessed well between two hairlines.
//
// Exports:
//   default ScrollDrum — one wheel (reps, seconds, whole values).
//   SplitWeightDrum    — the split drum: integer and decimal wheels scroll
//     independently; decimal steps derive per-lift from the equipment
//     increment (leg press: .0 only; lateral raise: .0/.25/.5/.75), so
//     neither wheel is ever a 1,600-detent scroll.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useEffect, useCallback } from "react";
import { T } from "@/lib/tokens";
import { haptic } from "@/lib/a11y";

const ITEM_H = 52, VISIBLE = 5, HALF = Math.floor(VISIBLE / 2);

// One wheel over an explicit value list. Internal — the exports below
// compose it. Behaviour (snap maths, settle haptic, programmatic scroll
// guard, scroll-anchoring opt-out) is preserved from the original drum.
function Wheel({ values, value, onChange, fmt = (v) => String(v), eq = (a, b) => a === b, width = "100%" }) {
  const selectedIdx = Math.max(0, values.findIndex(v => eq(v, value)));
  const ref = useRef(null);
  const scrolling = useRef(false);
  const timer = useRef(null);
  useEffect(() => {
    if (!ref.current || scrolling.current) return;
    const raf = requestAnimationFrame(() => { if (ref.current) ref.current.scrollTop = selectedIdx * ITEM_H; });
    return () => cancelAnimationFrame(raf);
  }, [selectedIdx]);
  const moved = useRef(false);
  const onScroll = useCallback(() => {
    if (!ref.current) return;
    scrolling.current = true;
    const frac = ref.current.scrollTop / ITEM_H;
    const idx = Math.min(Math.round(frac), values.length - 1);
    const next = values[Math.max(0, idx)];
    if (next !== undefined && !eq(next, value)) { onChange(next); moved.current = true; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      scrolling.current = false;
      // Settle beat only when the flick actually landed somewhere new.
      if (moved.current) { moved.current = false; haptic.settle(); }
    }, 150);
  }, [values, value, onChange, eq]);
  return (
    <div style={{ position: "relative", height: ITEM_H * VISIBLE, width, overflow: "hidden" }}>
      {/* Selection band — a recessed well between two hairlines. No lips,
          no glow: the hairlines and the item falloff carry the depth. */}
      <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: ITEM_H, transform: "translateY(-50%)", background: T.well, borderTop: `1px solid ${T.rule}`, borderBottom: `1px solid ${T.rule}`, pointerEvents: "none", zIndex: 0 }} />
      {/* overflowAnchor none: Safari 27 ships scroll anchoring, and the
          drum positions its scroller programmatically — the browser's
          anchoring must not fight the snap maths. */}
      <div ref={ref} onScroll={onScroll} style={{ position: "relative", zIndex: 1, height: "100%", overflowY: "scroll", overflowAnchor: "none", scrollSnapType: "y mandatory", scrollbarWidth: "none", paddingTop: ITEM_H * HALF, paddingBottom: ITEM_H * HALF, boxSizing: "content-box" }}>
        <style>{`*::-webkit-scrollbar{display:none}`}</style>
        {values.map((v, i) => (
          <div key={i} onClick={() => onChange(v)} style={{ height: ITEM_H, scrollSnapAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <span className="drum-item" style={{ fontFamily: T.measured, fontSize: 30, fontWeight: 400, letterSpacing: "-0.03em", color: T.ink, userSelect: "none" }}>{fmt(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function wheelLabel(text) {
  return text ? <div style={{ fontSize: 12, fontWeight: 500, color: T.ink3, marginBottom: 8 }}>{text}</div> : null;
}

export default function ScrollDrum({ value, onChange, step = 1.25, min = 0, max = 500, integer = false, label = "", unit = null }) {
  const values = useMemo(() => {
    const arr = [];
    if (integer) { for (let v = Math.max(min, 1); v <= max; v++) arr.push(v); }
    else { const s = Math.round((max - min) / step); for (let i = 0; i <= s; i++) arr.push(Math.round((min + i * step) * 100) / 100); }
    return arr;
  }, [min, max, step, integer]);
  const current = parseFloat(value) || 0;
  const fmt = (v) => {
    if (integer) return String(Math.round(v));
    const n = Math.round(v * 100) / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
      {wheelLabel(label)}
      <Wheel values={values} value={current} onChange={onChange} fmt={fmt}
        eq={(a, b) => Math.abs(a - b) < (integer ? 0.5 : step * 0.5)} />
      <div style={{ fontSize: 12, color: T.ink3, marginTop: 8 }}>{unit ?? (integer ? "reps" : "kg")}</div>
    </div>
  );
}

// Decimal options an equipment increment actually offers. The wheel shows
// only reachable fractions — 0.25 plates give four detents, a 5 kg stack
// gives one. (Integers stay a free wheel either way, so any whole number
// composes with any listed fraction.)
export function decimalsForStep(step) {
  if (!Number.isFinite(step) || step >= 1 && Number.isInteger(step)) return [0];
  const frac = Math.round((step % 1) * 100) / 100;
  if (frac === 0) return [0];
  if (frac === 0.5) return [0, 0.5];
  return [0, 0.25, 0.5, 0.75];
}

// The split drum. `value` is a plain kg number; the wheels decompose and
// recompose it (integer part + fractional part), all in exact hundredths.
export function SplitWeightDrum({ value, onChange, step = 1.25, min = 0, max = 400, label = "kg" }) {
  const decs = useMemo(() => decimalsForStep(step), [step]);
  const v = Math.min(max, Math.max(min, parseFloat(value) || 0));
  const whole = Math.floor(v);
  // Snap the fractional part to the nearest offered decimal.
  const rawFrac = Math.round((v - whole) * 100) / 100;
  const frac = decs.reduce((best, d) => Math.abs(d - rawFrac) < Math.abs(best - rawFrac) ? d : best, decs[0]);

  const ints = useMemo(() => {
    const arr = [];
    for (let i = Math.floor(min); i <= Math.floor(max); i++) arr.push(i);
    return arr;
  }, [min, max]);

  const fmtDec = (d) => d === 0 ? ".0" : `.${String(d).split(".")[1]}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1.4 }}>
      {wheelLabel(label)}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 2, width: "100%" }}>
        <Wheel values={ints} value={whole} onChange={(w) => onChange(Math.round((w + frac) * 100) / 100)} width="58%" />
        {decs.length > 1 ? (
          <Wheel values={decs} value={frac} onChange={(d) => onChange(Math.round((whole + d) * 100) / 100)} fmt={fmtDec} width="42%" />
        ) : (
          /* Single-detent equipment (5 kg stacks, whole-kg dumbbells):
             no decimal wheel to spin — print the fixed .0 on the band. */
          <div aria-hidden style={{ width: "42%", height: ITEM_H * VISIBLE, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: T.measured, fontSize: 30, fontWeight: 400, color: T.ink3 }}>.0</span>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: T.ink3, marginTop: 8 }}>
        steps of <span style={{ fontFamily: T.measured }}>{step}</span>
      </div>
    </div>
  );
}
