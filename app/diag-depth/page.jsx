"use client";

// /diag-depth — tactful-neumorphism instrument (Phase 3, dimensionality).
// ─────────────────────────────────────────────────────────────────────────────
// QUESTION UNDER TEST: does a dark-field bevel vocabulary add real depth on
// the actual OLED, over the actual grain — or does it read as smudge?
//
// The premise: classic neumorphism needs a mid-tone field (both shadows
// visible). On Forge's near-black field, extrusion is carried almost
// entirely by the TOP-EDGE LIGHT BEVEL (warm hairline where light catches)
// plus a soft shade beneath; big dark drop-shadows mostly vanish into the
// field. The pressed state INVERTS to debossed (inset shadows — the
// surface gives), composing with the existing press-scale + grain print.
//
// Variants:
//   A control    — current card treatment (flat 1px border).
//   B bevel      — extruded: inset top highlight + inset bottom shade only.
//   C bevel+lift — B plus a soft drop shadow (the "lifted" read).
//   D debossed   — the pressed state, standing, for side-by-side judgement.
// Every sample is tappable: press-and-hold shows the live inversion
// (raised → debossed) with the transition we'd actually ship.
//
// Judged on device: does B/C read as material depth over grain; does the
// inversion feel like GIVE under the finger; any banding/smudge on OLED;
// glass sheets are OUT OF SCOPE (their grammar is settled).
//
// CHARTER: instrument only, deletes after the verdict (diag-chin style).
// No production surface changes ride here.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { T } from "@/lib/tokens";

const DIAG_CSS = `
.dd-raised-b {
  background: linear-gradient(150deg, #201d1b, #171514);
  box-shadow: inset 1px 1px 0 rgba(242, 231, 215, 0.055),
              inset -1px -1px 0 rgba(0, 0, 0, 0.35);
  border: none;
}
.dd-raised-c {
  background: linear-gradient(150deg, #201d1b, #171514);
  box-shadow: inset 1px 1px 0 rgba(242, 231, 215, 0.055),
              inset -1px -1px 0 rgba(0, 0, 0, 0.35),
              5px 7px 16px rgba(0, 0, 0, 0.45),
              -3px -3px 10px rgba(255, 244, 230, 0.012);
  border: none;
}
.dd-debossed {
  background: #151312;
  box-shadow: inset 2px 2px 6px rgba(0, 0, 0, 0.55),
              inset -1px -1px 2px rgba(242, 231, 215, 0.035);
  border: none;
}
/* Press inversion — transition kept small-area and brief; production would
   crossfade pre-rendered layers instead of animating box-shadow. */
.dd-pressable { transition: box-shadow 160ms ease, background 160ms ease, transform 160ms ease; cursor: pointer; }
.dd-pressable:active { transform: scale(0.985); }
.dd-raised-b:active, .dd-raised-c:active {
  background: #151312;
  box-shadow: inset 2px 2px 6px rgba(0, 0, 0, 0.55),
              inset -1px -1px 2px rgba(242, 231, 215, 0.035);
}
`;

function Sample({ variant, cls, note }) {
  return (
    <div style={{ marginBottom: 30 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: T.text3, marginBottom: 10 }}>
        {variant} <span style={{ color: T.text4, textTransform: "none", letterSpacing: 0 }}>· {note}</span>
      </div>
      <div className={`${cls} dd-pressable`}
        style={{ padding: "18px 20px", borderRadius: 14, ...(cls ? {} : { background: T.bg2, border: `1px solid ${T.bg3}` }) }}>
        <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: T.text3, marginBottom: 6 }}>
          sample card
        </div>
        <div style={{ fontFamily: T.serif, fontSize: 19, fontWeight: 300, marginBottom: 6, color: T.text1 }}>
          Press and hold me
        </div>
        <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.5, margin: 0 }}>
          Watch the surface give — raised inverts to debossed under the finger.
        </p>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button className={`${cls} dd-pressable`}
          style={{ flex: 1, padding: "13px 16px", borderRadius: 12, color: T.text1, fontFamily: T.sans, fontSize: 13, fontWeight: 500, ...(cls ? {} : { background: T.bg2, border: `1px solid ${T.bg3}` }) }}>
          Secondary action
        </button>
        <div className={cls || undefined}
          style={{ flex: 1, padding: "13px 16px", borderRadius: 12, textAlign: "center", fontVariantNumeric: "tabular-nums", color: T.gold, fontSize: 15, ...(cls ? {} : { background: T.bg2, border: `1px solid ${T.bg3}` }) }}>
          12 <span style={{ fontSize: 11, color: T.text3 }}>/wk</span>
        </div>
      </div>
    </div>
  );
}

export default function DiagDepthPage() {
  const [gutter, setGutter] = useState(false);
  return (
    <div style={{ maxWidth: 430, margin: "0 auto", padding: "24px 20px 80px", fontFamily: T.sans, color: T.text1 }}>
      <style>{DIAG_CSS}</style>
      <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: T.text3, marginBottom: 6 }}>
        diag · depth
      </div>
      <h1 style={{ fontFamily: T.serif, fontSize: 24, fontWeight: 300, marginBottom: 8 }}>
        Does the field extrude?
      </h1>
      <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.55, marginBottom: 8 }}>
        Four treatments over the real grain. Judge on device: does B/C read as material depth
        (not smudge), does the press inversion feel like give, any OLED banding in the bevel
        hairlines. Sheets are out of scope — their grammar is settled.
      </p>
      <button onClick={() => setGutter((g) => !g)}
        style={{ padding: "10px 14px", marginBottom: 22, textAlign: "left", background: T.bg2, border: `1px solid ${T.bg3}`, borderRadius: 10, color: T.text3, fontSize: 12, cursor: "pointer" }}>
        {gutter ? "Narrow" : "Widen"} gutters (more grain visible between samples)
      </button>

      <div style={{ display: "flex", flexDirection: "column", gap: gutter ? 26 : 0 }}>
        <Sample variant="A" cls="" note="control — current flat border" />
        <Sample variant="B" cls="dd-raised-b" note="bevel only — extruded from the field" />
        <Sample variant="C" cls="dd-raised-c" note="bevel + soft lift" />
        <Sample variant="D" cls="dd-debossed" note="debossed — the pressed state, standing" />
      </div>

      <p style={{ fontSize: 12, color: T.text3, lineHeight: 1.5 }}>
        Verdicts wanted per variant: depth yes/no · smudge/banding · press-give feel ·
        which surfaces deserve it (cards? buttons? stat tiles?). This page deletes once
        answered.
      </p>
    </div>
  );
}
