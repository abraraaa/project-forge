"use client";

// components/ui.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Shared presentational primitives, extracted from ForgeApp.jsx during the
// PR3 real-routes migration (stage 3b — decomposition prerequisite). These are
// pure: props + design tokens only, no app state. Lifting them here lets the
// screens that are about to become their own route files (Profile, Home,
// Session) import them instead of depending on the monolith's internal scope.
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

// boxShadow gives cards a quiet sense of resting ON the backdrop rather than
// being painted into it: a 1px inset top highlight (light catching the top
// edge) + two soft ambient drops (a tight contact shadow and a wider, very
// faint lift). Warm-black tints keep it inside the Portra palette — no cool
// Material-grey elevation. Callers can override via style.boxShadow.
export const CARD_SHADOW = "inset 0 1px 0 rgba(237,235,231,0.04), 0 1px 2px rgba(10,9,8,0.28), 0 10px 28px -16px rgba(10,9,8,0.5)";

// Card — elevated surface. Extracted verbatim from ForgeApp to preserve
// appearance exactly (no glass/opacity change folded in during the move).
export function Card({ children, style = {} }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.bg3}`, borderRadius: T.r.lg, boxShadow: CARD_SHADOW, ...style }}>
      {children}
    </div>
  );
}

// Tag — small pill label tinted by `color`.
export function Tag({ children, color, style = {} }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", fontSize: 10, fontWeight: 500, color, background: `${color}12`, border: `1px solid ${color}33`, borderRadius: T.r.pill, padding: "4px 12px", letterSpacing: "0.08em", ...style }}>
      {children}
    </span>
  );
}
