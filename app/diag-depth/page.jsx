"use client";

// /diag-depth — bevel smoothness A/B (round 2 of the dimensionality verdict).
// ─────────────────────────────────────────────────────────────────────────────
// Round 1 verdict (device, 2026-07-13): B (bevel-only) wins; C's drop
// shadow and D's standing deboss read "jiggly/choppy/unstable" — both dead.
// But "even B could be smoother." Diagnosis: the prototype TWEENED
// box-shadow on press (repaints every frame on iOS). Round 2 A/Bs the fix:
//
//   B1 — bevel as judged in round 1: box-shadow tweened over 160ms.
//   B2 — production candidate (.forge-raised .forge-press): the shadow
//        state swaps INSTANTLY at pointerdown; all perceived motion comes
//        from the compositor-only scale/filter tween. Real buttons don't
//        tween when they seat — they seat crisply while the finger moves.
//
// If B2 feels right, it's already the shipped class — the rollout is just
// wiring it onto surfaces. CHARTER: instrument deletes after this verdict.
// ─────────────────────────────────────────────────────────────────────────────

import { T } from "@/lib/tokens";

const DIAG_CSS = `
/* B1 — round-1 behaviour, kept only for comparison: tweened shadows. */
.dd-b1 {
  background: linear-gradient(150deg, #201d1b, #171514);
  border: none;
  box-shadow: inset 1px 1px 0 rgba(242, 231, 215, 0.055),
              inset -1px -1px 0 rgba(0, 0, 0, 0.35);
  transition: box-shadow 160ms ease, background 160ms ease, transform 160ms ease;
  cursor: pointer;
}
.dd-b1:active {
  transform: scale(0.985);
  background: #151312;
  box-shadow: inset 2px 2px 6px rgba(0, 0, 0, 0.55),
              inset -1px -1px 2px rgba(242, 231, 215, 0.035);
}
`;

function Sample({ label, note, className }) {
  return (
    <div style={{ marginBottom: 30 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: T.text3, marginBottom: 10 }}>
        {label} <span style={{ color: T.text4, textTransform: "none", letterSpacing: 0 }}>· {note}</span>
      </div>
      <div className={className} style={{ padding: "18px 20px", borderRadius: 14, cursor: "pointer" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: T.text3, marginBottom: 6 }}>
          sample card
        </div>
        <div style={{ fontFamily: T.serif, fontSize: 19, fontWeight: 300, marginBottom: 6, color: T.text1 }}>
          Press and hold me
        </div>
        <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.5, margin: 0 }}>
          Tap fast, tap slow, drag your thumb across — judge the seating, not just the look.
        </p>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button className={className}
          style={{ flex: 1, padding: "13px 16px", borderRadius: 12, color: T.text1, fontFamily: T.sans, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
          Secondary action
        </button>
        <div className={className}
          style={{ flex: 1, padding: "13px 16px", borderRadius: 12, textAlign: "center", fontVariantNumeric: "tabular-nums", color: T.gold, fontSize: 15 }}>
          12 <span style={{ fontSize: 11, color: T.text3 }}>/wk</span>
        </div>
      </div>
    </div>
  );
}

export default function DiagDepthPage() {
  return (
    <div style={{ maxWidth: 430, margin: "0 auto", padding: "24px 20px 80px", fontFamily: T.sans, color: T.text1 }}>
      <style>{DIAG_CSS}</style>
      <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: T.text3, marginBottom: 6 }}>
        diag · depth · round 2
      </div>
      <h1 style={{ fontFamily: T.serif, fontSize: 24, fontWeight: 300, marginBottom: 8 }}>
        Smoother, or seated?
      </h1>
      <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.55, marginBottom: 22 }}>
        B won round 1; C and D are dead. This round A/Bs the smoothness fix: B1 tweens the
        shadows (what you judged "could be smoother"); B2 seats them instantly and lets the
        scale carry the motion — B2 is the literal production class, so what you feel is what
        ships.
      </p>

      <Sample label="B1" note="round-1 bevel — shadows tweened (160ms)" className="dd-b1" />
      <Sample label="B2" note="production candidate — instant seat + compositor scale" className="forge-raised forge-press" />

      <p style={{ fontSize: 12, color: T.text3, lineHeight: 1.5 }}>
        Verdict wanted: B1 or B2 (or neither). On B2's yes: rollout is wiring
        `forge-raised` onto the dark interactive cards — which surfaces get it is your call,
        made on device. This page deletes after the verdict.
      </p>
    </div>
  );
}
