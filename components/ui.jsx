"use client";

// components/ui.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Shared presentational primitives — Bone & Ember.
// Pure: props + design tokens only, no app state.
//
// Surface doctrine: measured data gets NO containers — numbers sit on the
// ground between hairlines. Only documents and commit actions get surfaces.
// Card is therefore for document-like content (session overviews, notes,
// photographs, a trainer's client records), not a default wrapper for
// everything.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { T } from "@/lib/tokens";
import { rovingIndex } from "@/lib/a11y";

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
//
// Under prefers-reduced-motion the rise is dropped and only the fade runs.
// Read during render: every consumer mounts client-only (ssr:false shells in
// components/client-shells.jsx), so no server markup can disagree with it.
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useFadeIn(d = 0, { opaque = false } = {}) {
  const [v, setV] = useState(false);
  useEffect(() => { const t = setTimeout(() => setV(true), d); return () => clearTimeout(t); }, [d]);
  if (prefersReducedMotion()) {
    return {
      opacity: opaque ? 1 : (v ? 1 : 0),
      transition: `opacity 260ms ${T.ease} ${d}ms`,
    };
  }
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

// The word "deload" where a kicker carries it: ink, with a 1px underline in
// the day's key so it is not lost in the kicker's ink-2.
export function DeloadWord({ keyColour }) {
  return (
    <span style={{ color: T.ink, textDecorationLine: "underline", textDecorationColor: keyColour, textDecorationThickness: "1px", textUnderlineOffset: "3px" }}>deload</span>
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

// The house buttons, as style objects. Press classes stay at each call site:
// a sheet's controls take none (the safe-area chin, app/globals.css), and
// tests/press-lift.test.js reads the class on the tag. Heights follow the
// radius law in lib/tokens.js: 12 at 44 px and up, 8 at 36.
/** @type {{ commit: import("react").CSSProperties, quiet: import("react").CSSProperties, chip: (on: boolean) => import("react").CSSProperties, text: import("react").CSSProperties, small: import("react").CSSProperties }} */
export const BTN = {
  // The one coloured surface.
  commit: {
    width: "100%", height: 56, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer",
    fontFamily: T.text, fontSize: 17, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong,
  },
  quiet: {
    height: 46, padding: "0 16px", background: T.ground, border: `1px solid ${T.rule}`, borderRadius: T.r,
    cursor: "pointer", fontFamily: T.text, fontSize: 14, fontWeight: 500, color: T.ink,
  },
  // A toggle: raised when on, a hairline when off.
  chip: (on) => ({
    minHeight: 36, padding: "0 12px", borderRadius: T.rSm, cursor: "pointer", fontFamily: T.text, fontSize: 13,
    fontWeight: on ? 500 : 400, color: on ? T.ink : T.ink2, background: on ? T.surface : "transparent",
    border: `1px solid ${on ? "transparent" : T.rule}`, boxShadow: on ? T.elev : "none",
  }),
  // A link; a trailing glyph sits in its gap.
  text: {
    background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink3,
    display: "inline-flex", alignItems: "center", gap: 5,
  },
  // A row's own action, beside its text.
  small: {
    minHeight: 36, padding: "0 12px", background: "none", border: `1px solid ${T.rule}`, borderRadius: T.rSm,
    cursor: "pointer", fontFamily: T.text, fontSize: 13, fontWeight: 400, color: T.ink2, flexShrink: 0,
  },
};

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

// TabStrip — the house tabs, in the Home week strip's grammar: words on the
// ground, an ink underline on the current one, forge-press. One tab stop:
// the current tab; Left and Right step and wrap, Home and End jump, and a
// tab is current as soon as it has focus. Each tab names its panel by
// tabIds; TabPanel hides the others with the hidden attribute, so what they
// hold keeps its state and stays out of reach.
/** @param {string} base @param {string} key */
export const tabIds = (base, key) => ({ tab: `${base}-tab-${key}`, panel: `${base}-panel-${key}` });

/**
 * @param {{ label: string, idBase: string, tabs: Array<{ key: string, label: import("react").ReactNode }>, selected: string, onSelect: (key: string) => void, style?: import("react").CSSProperties }} props
 */
export function TabStrip({ label, idBase, tabs, selected, onSelect, style = {} }) {
  /** @param {import("react").KeyboardEvent<HTMLDivElement>} e */
  const onKeyDown = (e) => {
    const at = tabs.findIndex((t) => t.key === selected);
    const to = rovingIndex(e.key, at < 0 ? 0 : at, tabs.length);
    if (to == null) return;
    e.preventDefault();
    onSelect(tabs[to].key);
    const el = /** @type {HTMLElement | undefined} */ (e.currentTarget.querySelectorAll('[role="tab"]')[to]);
    el?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown}
      style={{ display: "flex", gap: 22, borderBottom: `1px solid ${T.rule}`, ...style }}>
      {tabs.map((t) => {
        const on = t.key === selected;
        const ids = tabIds(idBase, t.key);
        return (
          <button key={t.key} type="button" role="tab" id={ids.tab} aria-controls={ids.panel} aria-selected={on}
            tabIndex={on ? 0 : -1} onClick={() => onSelect(t.key)} className="forge-press"
            style={{ position: "relative", minHeight: 44, padding: "0 0 2px", background: "none", border: "none", cursor: "pointer",
              fontFamily: T.text, fontSize: 14, fontWeight: on ? 500 : 400, color: on ? T.ink : T.ink2, whiteSpace: "nowrap" }}>
            {t.label}
            <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 2, background: on ? T.ink : "transparent", transition: `background 200ms ${T.ease}` }}/>
          </button>
        );
      })}
    </div>
  );
}

// TabPanel — one tab's content. It sets no display of its own: an inline
// display would beat the hidden attribute.
/**
 * @param {{ idBase: string, tabKey: string, selected: boolean, children?: import("react").ReactNode }} props
 */
export function TabPanel({ idBase, tabKey, selected, children }) {
  const ids = tabIds(idBase, tabKey);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} hidden={!selected} tabIndex={0} data-tab-panel={tabKey}
      style={{ outlineOffset: 4 }}>
      {children}
    </div>
  );
}
