// components/Glyph.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The glyph set — every symbol drawn, never a system default (Bone & Ember
// audit §10.5). One stroke grammar, derived from the open-aperture mark:
// 3px round-cap strokes on a 24px artboard (scaling linearly — stroke
// width is in viewBox units, so a 16px render carries a proportional 2px
// stroke), open joins, no filled shapes, ink colour by default. Accent
// glyphs may take the screen's day key via `color`.
//
// No "use client": a pure function component with no hooks, usable from
// server components (library pages) and client components alike.
//
// Inline use: the svg is inline-block with a slight negative vertical
// align so it sits on the text baseline — `<Glyph name="arrowRight"/>`
// works mid-sentence. Decorative by default (aria-hidden); pass a `label`
// when the glyph is the only content of a control.
// ─────────────────────────────────────────────────────────────────────────────

// The reference stroke is the audit's check: M6 16 L13 23 L26 8 on a 32
// artboard — normalised here to 24.
const PATHS = {
  check:       ["M4.5 12.5 L10 18 L19.5 6.5"],
  cross:       ["M6.5 6.5 L17.5 17.5", "M17.5 6.5 L6.5 17.5"],
  arrowRight:  ["M4.5 12 L19.5 12", "M14 6.5 L19.5 12 L14 17.5"],
  arrowLeft:   ["M19.5 12 L4.5 12", "M10 6.5 L4.5 12 L10 17.5"],
  arrowUpRight:["M7.5 16.5 L16.5 7.5", "M9.5 7.5 L16.5 7.5 L16.5 14.5"],
  plus:        ["M12 5 L12 19", "M5 12 L19 12"],
  minus:       ["M5 12 L19 12"],
  chevronDown: ["M6 9.5 L12 15.5 L18 9.5"],
  chevronUp:   ["M6 14.5 L12 8.5 L18 14.5"],
  // Two open arrows passing — the swap. Offset lanes keep the joins open.
  swap:        ["M5 8.5 L17 8.5", "M13.5 4.5 L17 8.5 L13.5 12.5", "M19 15.5 L7 15.5", "M10.5 11.5 L7 15.5 L10.5 19.5"],
  // The i: a round-cap dot (zero-length stroke) over a stem. The dot is a
  // stroke artefact, not a filled shape — the grammar holds.
  info:        ["M12 7 L12 7.01", "M12 11 L12 17.5"],
  // Refresh: an open arc breaking at the top-right — the aperture again —
  // with the arrowhead landing on the break.
  refresh:     ["M18.5 13.5 A 6.8 6.8 0 1 1 16.6 7.2", "M17 3.5 L17 7.7 L12.8 7.7"],
};

export const GLYPH_NAMES = Object.keys(PATHS);

export default function Glyph({ name, size = 14, color = "currentColor", label = null, style = {} }) {
  const paths = PATHS[name];
  if (!paths) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      style={{ display: "inline-block", verticalAlign: "-0.125em", flexShrink: 0, ...style }}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
