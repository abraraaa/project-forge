"use client";

// /diag-field — stationary-field prototype instrument (Phase 3 experiment).
// ─────────────────────────────────────────────────────────────────────────────
// QUESTION UNDER TEST: can the grain read as a stationary field (panes flow
// over it, the pre-July-3 fixed-overlay feel) WITHOUT position: fixed — so
// the WebKit 301756 slab law (opaque chrome behind status/URL bar) never
// re-engages? Two candidate mechanisms, judged on device:
//
//   HOLD (B/C): the grain element stays static but gains overflow: clip;
//   an inner layer (::before) carries the texture and counter-translates
//   at scroll speed via a scroll-driven animation (compositor-threaded).
//
//   WARNING — the clip is load-bearing, not cosmetic. The obvious version
//   (translate the grain element itself) FAILS by feedback loop: the
//   translated full-height layer overhangs the page bottom, which GROWS
//   the document's scrollable range, which shrinks scroll progress per
//   pixel, which changes the translation — measured in Chromium as
//   docScrollHeight 3408 → 5526 during one scroll and a field that
//   drifts ~46% behind. A scroll-driven animation must never change the
//   scroll range that drives it; clipping the moving layer inside a
//   static parent is what guarantees that.
//
//   FIXED-BG (E): background-attachment: fixed — no animation at all, the
//   background paints viewport-relative. Historically broken on iOS Safari
//   (treated as scroll); included because the 27 engine should get to say
//   so itself rather than us trusting folklore.
//
// MATHS for HOLD: the inner layer is 100% of the grain (= page height H),
// so translateY(100%) = H. Scroll range = H − viewport, so
//   to { transform: translateY(calc(100% − 100Xvh)) }
// over scroll(root)'s full default range counter-translates 1:1 — exact at
// both ends, linear (hence exact) between. Which viewport unit matches
// Safari's real range while the URL bar collapses is measured, not
// assumed — that's the lvh/dvh pair.
//
// Numeric HUD (screenshots must carry numbers): drift = innerTranslateY −
// scrollY. 0 = held. Judge chrome slabs with the HUD hidden.
//
// CHARTER: instrument only. No production surface changes ride here. If a
// variant passes on device, rollout is a separate reviewed change and this
// route is deleted (diag-chin style); if all fail, glow-drift parallax
// remains the depth treatment and this deletes with a parked.md verdict.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { T } from "@/lib/tokens";

const VARIANTS = [
  { id: "control", label: "A · control (scrolls with content)" },
  { id: "hold-lvh", label: "B · hold — clipped inner translate, lvh" },
  { id: "hold-dvh", label: "C · hold — clipped inner translate, dvh" },
  { id: "fixed-bg", label: "E · background-attachment: fixed (no animation)" },
];
const ALL_CLASSES = ["diag-hold-lvh", "diag-hold-dvh", "diag-fixed-bg"];

// animation shorthand FIRST, animation-timeline after — the shorthand
// resets animation-timeline (lesson already paid for in globals.css).
const DIAG_CSS = `
.forge-grain.diag-hold-lvh, .forge-grain.diag-hold-dvh {
  overflow: clip;                 /* the loop-breaker — see header comment */
  background-image: none !important;
}
.forge-grain.diag-hold-lvh::before, .forge-grain.diag-hold-dvh::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: var(--diag-grain-img);
  background-repeat: repeat;
  background-size: 192px 192px;
}
@supports (animation-timeline: scroll(root)) {
  .forge-grain.diag-hold-lvh::before {
    animation: diagFieldHoldLvh linear both;
    animation-timeline: scroll(root);
  }
  .forge-grain.diag-hold-dvh::before {
    animation: diagFieldHoldDvh linear both;
    animation-timeline: scroll(root);
  }
  @keyframes diagFieldHoldLvh {
    from { transform: translateY(0); }
    to   { transform: translateY(calc(100% - 100lvh)); }
  }
  @keyframes diagFieldHoldDvh {
    from { transform: translateY(0); }
    to   { transform: translateY(calc(100% - 100dvh)); }
  }
}
.forge-grain.diag-fixed-bg {
  background-attachment: fixed;
}
`;

const noopSubscribe = () => () => {};

export default function DiagFieldPage() {
  const [variant, setVariant] = useState("control");
  const [hud, setHud] = useState(true);
  // One-shot environment read, hydration-safe: server snapshot is null
  // (unknown), client snapshot is the real engine answer.
  const supported = useSyncExternalStore(
    noopSubscribe,
    () => CSS.supports("animation-timeline: scroll(root)"),
    () => null,
  );
  const hudRef = useRef(null);

  // Drive the REAL production grain layer (mounted by the shell) so the
  // test exercises the exact element, blend mode, and stacking context
  // that would ship — not a replica. The texture data-URI is copied off
  // the element into a custom prop so the hold variants' ::before can
  // paint the identical tile.
  useEffect(() => {
    const grain = document.querySelector(".forge-grain");
    if (!grain) return;
    if (!grain.style.getPropertyValue("--diag-grain-img")) {
      grain.style.setProperty("--diag-grain-img", getComputedStyle(grain).backgroundImage);
    }
    grain.classList.remove(...ALL_CLASSES);
    if (variant === "hold-lvh") grain.classList.add("diag-hold-lvh");
    if (variant === "hold-dvh") grain.classList.add("diag-hold-dvh");
    if (variant === "fixed-bg") grain.classList.add("diag-fixed-bg");
    return () => grain.classList.remove(...ALL_CLASSES);
  }, [variant]);

  // Numeric readout — rAF loop writing straight to the DOM node (no React
  // state at scroll frequency). drift = innerTranslateY − scrollY; 0 = held.
  useEffect(() => {
    if (!hud) return;
    let raf;
    const tick = () => {
      const grain = document.querySelector(".forge-grain");
      const el = hudRef.current;
      if (grain && el) {
        const y = window.scrollY;
        const m = getComputedStyle(grain, "::before").transform;
        const ty = m && m.startsWith("matrix(") ? parseFloat(m.split(",")[5]) : null;
        const drift = ty === null ? null : ty - y;
        el.textContent =
          `scrollY ${y.toFixed(0)} · innerTY ${ty === null ? "—" : ty.toFixed(1)}` +
          ` · drift ${drift === null ? "—" : drift.toFixed(1)}px` +
          (drift !== null && Math.abs(drift) < 1 ? " · HELD" : "") +
          ` · docH ${document.scrollingElement.scrollHeight}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hud]);

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", padding: "24px 20px 80px", fontFamily: T.sans, color: T.text1 }}>
      <style>{DIAG_CSS}</style>

      <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: T.text3, marginBottom: 6 }}>
        diag · stationary field
      </div>
      <h1 style={{ fontFamily: T.serif, fontSize: 24, fontWeight: 300, marginBottom: 8 }}>
        Does the grain hold still?
      </h1>
      <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.55, marginBottom: 8 }}>
        Pick a variant, scroll hard (flick + slow drag), watch the texture in the gutters
        between cards. Stationary = the field holds while panes flow over it. Then check the
        chrome: any opaque slab behind the status bar or URL bar fails that variant outright.
        Also watch the very BOTTOM of the page on B/C — the clipped layer must never reveal a
        texture edge or a bare band.
      </p>
      <p style={{ fontSize: 12, color: supported === false ? T.rose : T.text3, marginBottom: 16 }}>
        {supported === null ? "…" : supported
          ? "scroll-driven animations supported on this engine ✓"
          : "animation-timeline UNSUPPORTED here — B/C will behave like A"}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {VARIANTS.map((v) => (
          <button key={v.id} onClick={() => setVariant(v.id)}
            style={{ padding: "12px 14px", textAlign: "left", background: variant === v.id ? `${T.gold}14` : T.bg2, border: `1px solid ${variant === v.id ? T.gold : T.bg3}`, borderRadius: 10, color: variant === v.id ? T.gold : T.text2, fontSize: 13, cursor: "pointer" }}>
            {v.label}
          </button>
        ))}
        <button onClick={() => setHud((h) => !h)}
          style={{ padding: "10px 14px", textAlign: "left", background: T.bg2, border: `1px solid ${T.bg3}`, borderRadius: 10, color: T.text3, fontSize: 12, cursor: "pointer" }}>
          {hud ? "Hide" : "Show"} numeric HUD (hide before judging chrome slabs)
        </button>
      </div>

      {hud && (
        <div ref={hudRef}
          style={{ position: "sticky", top: "calc(env(safe-area-inset-top, 0px) + 44px)", zIndex: 5, padding: "8px 12px", background: "rgba(19,17,16,0.9)", border: `1px solid ${T.bg3}`, borderRadius: 8, fontSize: 12, fontVariantNumeric: "tabular-nums", color: T.gold, marginBottom: 16 }}>
          …
        </div>
      )}

      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} className="forge-glass"
          style={{ margin: "22px 0", padding: "20px 18px", borderRadius: 14, border: `1px solid ${T.bg3}` }}>
          <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: T.text3, marginBottom: 6 }}>
            pane {i + 1} of 14
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 19, fontWeight: 300, marginBottom: 6 }}>
            A pane flowing over the field
          </div>
          <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.55 }}>
            Watch the grain in the gutter above and below this card while scrolling. If the
            variant holds, the texture stays put and this pane slides across it — depth without
            a fixed element.
          </p>
        </div>
      ))}

      <p style={{ fontSize: 12, color: T.text3, lineHeight: 1.5 }}>
        End of run. Verdicts per variant: field held / drifted (the drift number), slab yes/no
        (browser top + bottom, PWA), pop-in or tone shift during scroll, texture edge at page
        bottom. Record in the session, not here — this page deletes once the question is
        answered.
      </p>
    </div>
  );
}
