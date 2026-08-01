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
export function useFadeIn(d = 0) {
  const [v, setV] = useState(false);
  useEffect(() => { const t = setTimeout(() => setV(true), d); return () => clearTimeout(t); }, [d]);
  return {
    opacity: v ? 1 : 0,
    transform: v ? "translateY(0)" : "translateY(10px)",
    transition: `opacity 260ms ${T.ease} ${d}ms,transform 260ms ${T.ease} ${d}ms`,
  };
}

// Fade — wraps children in the fade-in-on-mount transition.
export function Fade({ children, d = 0 }) {
  const s = useFadeIn(d);
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
