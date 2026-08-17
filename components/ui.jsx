"use client";

// components/ui.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Shared presentational primitives — Bone & Ember.
// Pure: props + design tokens only, no app state.
//
// Surface doctrine: measured data gets NO containers — numbers sit on the
// ground between hairlines. Only documents and commit actions get surfaces.
// Card is therefore for document-like content (session overviews, notes,
// photographs), not a default wrapper for everything.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { T } from "@/lib/tokens";

// Fade-in-on-mount style hook. `d` is the stagger delay in ms.
// `opaque` keeps the rise but starts at full opacity — for content that must
// be PAINTED, not merely present.
//
// Chromium disqualifies an element from being a Largest Contentful Paint
// candidate if it is transparent when first painted, and never reconsiders it
// once opacity changes. Every Fade renders opacity:0 first, so the entire page
// was ineligible and PageSpeed reported NO_LCP — which in turn errored out
// Total Blocking Time and four other diagnostics that derive from it.
// Measured 2026-08-17: as shipped, zero LCP entries; with fades neutralised,
// LCP fires at 356ms on the masthead h1.
//
// It is not only a metric. The opacity:0 is in the SERVER HTML, so the page
// ships invisible and stays that way until hydration runs the effect.
export function useFadeIn(d = 0, { opaque = false } = {}) {
  const [v, setV] = useState(false);
  useEffect(() => { const t = setTimeout(() => setV(true), d); return () => clearTimeout(t); }, [d]);
  return {
    opacity: opaque ? 1 : (v ? 1 : 0),
    transform: v ? "translateY(0)" : "translateY(10px)",
    transition: `opacity 260ms ${T.ease} ${d}ms,transform 260ms ${T.ease} ${d}ms`,
  };
}

// Fade — wraps children in the fade-in-on-mount transition. Pass `opaque` on
// the one block that carries the page's largest paint.
export function Fade({ children, d = 0, opaque = false }) {
  const s = useFadeIn(d, { opaque });
  return <div style={s}>{children}</div>;
}

// Raised-surface elevation — coated stock on uncoated ground. A bottom-edge
// inset shadow on light, a top-edge inset highlight on dark (light always
// comes from above; the token resolves per mode). This is the ENTIRE
// elevation model: no drop shadows, no bevels, no glass.
export const CARD_SHADOW = "var(--elev)";

// Card — a raised (coated) surface. One radius, 12px. Callers may layer
// their own layout styles; background/elevation belong to the material.
export function Card({ children, style = {} }) {
  return (
    <div style={{ background: T.surface, borderRadius: T.r, boxShadow: CARD_SHADOW, ...style }}>
      {children}
    </div>
  );
}

// MonoNums — digits are mono, no exceptions (audit §10.3): every measured
// value renders in Spline Sans Mono with the surrounding words in the text
// face. This helper applies the mixed-run pattern to data-driven copy
// ("60 min at conversational pace", "8–10 rounds of 20s") where hand-
// splitting spans isn't possible. Number runs include their decimal
// points, ranges (8–10), times (2:00) and multipliers (3×12).
const NUM_RUN = /(\d[\d.,:×–\-]*\d|\d)/g;
export function MonoNums({ children, style = {} }) {
  const text = String(children ?? "");
  const parts = text.split(NUM_RUN);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1
          ? <span key={i} style={{ fontFamily: T.measured, ...style }}>{p}</span>
          : p
      )}
    </>
  );
}

// Tag — a small identifier: a key mark (short bar in the given colour)
// beside sentence-case text. Replaces the pill chip — pills are on the
// never-list; categorical colour reads as a mark, not a costume.
export function Tag({ children, color, style = {} }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 500, color: T.ink2, ...style }}>
      <span aria-hidden="true" style={{ width: 16, height: 4, background: color || T.ink3, flexShrink: 0 }} />
      {children}
    </span>
  );
}
