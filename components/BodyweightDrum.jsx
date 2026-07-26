"use client";

// components/BodyweightDrum.jsx
// ─────────────────────────────────────────────────────────────────────────────
// THE ODOMETER (boss, 2026-07-26: "let's run with the odometer, sounds fun").
// Whole kilos on the left drum, a single tenths digit on the right — 0.1 kg
// fidelity without the 1,600-detent wheel a full-range 0.1 step would need.
// Same physical grammar as a beam scale: coarse poise first, then fine.
//
// Why 0.1 matters: a sensible cut runs 0.3–0.5 kg/week — the old half-kilo
// step quantised an entire week's honest progress to "nothing" or "double".
// The journal and chart already carried one decimal; entry was the
// bottleneck.
//
// All maths in integer digit-space (whole×10 + digit) — no floating tenths.
// Legacy half-kilo values decompose exactly (82.5 → 82 + digit 5).
// ─────────────────────────────────────────────────────────────────────────────

import ScrollDrum from "./ScrollDrum";
import { T } from "@/lib/tokens";

/** Pure: kg value → { whole, digit } in digit-space. Exported for tests. */
export function splitKg(value, min = 40, max = 200) {
  const v = Math.min(max + 0.9, Math.max(min, parseFloat(value) || min));
  const whole = Math.min(max, Math.floor(v));
  const digit = Math.max(0, Math.min(9, Math.round((v - whole) * 10)));
  return { whole, digit };
}

/** Pure: digit-space → kg with one exact decimal. Exported for tests. */
export function joinKg(whole, digit) {
  return (whole * 10 + digit) / 10;
}

export default function BodyweightDrum({ value, onChange, min = 40, max = 200 }) {
  const { whole, digit } = splitKg(value, min, max);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 2, width: "100%", maxWidth: 260 }}>
        <ScrollDrum value={whole} onChange={(w) => onChange(joinKg(w, digit))} min={min} max={max} step={1} integer unit="" />
        {/* The decimal point sits on the selection band's centreline. */}
        <div aria-hidden style={{ height: 52 * 5, display: "flex", alignItems: "center" }}>
          <span style={{ fontFamily: T.serif, fontSize: 30, fontWeight: 400, color: T.text3 }}>.</span>
        </div>
        <ScrollDrum value={digit} onChange={(d) => onChange(joinKg(whole, d))} min={0} max={9} step={1} unit="" />
      </div>
      <div style={{ fontFamily: T.serif, fontSize: 12, fontWeight: 300, color: T.text3, marginTop: 2, fontStyle: "italic" }}>kg</div>
    </div>
  );
}
