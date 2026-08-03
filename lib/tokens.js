// @ts-check
// lib/tokens.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared design tokens for Heatwayve — the "Bone & Ember" system.
// Single source of truth — import into any component that needs styling.
//
// The system in one breath: ink on uncoated bone. One thermal ramp carries
// all intensity; colour only ever means something; softness lives in tone,
// light, timing and space — never in radius or blur.
//
// MODE CONTRACT (light is the identity; dark is a derived mode):
// every colour here resolves through a CSS custom property declared in
// app/globals.css. Only four things flip between modes — ground, raised
// surface, ink, and the ramp's direction (the ramp always runs AWAY from
// the ground: darker on bone, brighter on ash). Everything else is shared,
// which is what stops dark mode becoming a second design to maintain.
//
// REDUNDANCY LAW (why the ramp is safe to love): L* is monotonic in both
// modes (greyscale- and CVD-safe); every heat mark also encodes magnitude
// in height; the number is always printed; beyond-limit is hatched, never
// just hotter. Kill the colour and nothing is lost.
//
// THE NEVER-LIST (the template test, enforced): no all-caps letterspaced
// microlabels · no italic-serif mood fragments · no pills · no glass or
// backdrop-filter · no grain overlays over content · no bevels or glows ·
// display face never below 28px · mono never on words · max one heat
// accent system per screen, day key as the only second colour · animation
// on transform/opacity/colour only.
// ─────────────────────────────────────────────────────────────────────────────

export const T = {
  // ── Grounds & ink (mode-resolved) ─────────────────────────────────────────
  ground:  "var(--ground)",    // bone F2E9E3 · ash 1A1512
  surface: "var(--surface)",   // raised, coated: FBF6F2 · 241D19
  ink:     "var(--ink)",       // 241C19 · F2E9E3
  ink2:    "var(--ink-2)",     // secondary 6A5B54 · B5A79E
  ink3:    "var(--ink-3)",     // tertiary / captions 9C8B83 · 857870
  rule:    "var(--rule)",      // hairline E0D2C9 · rgba(bone,.1)
  ruleFaint: "var(--rule-faint)", // sub-hairline between rows

  // ── The thermal ramp — one scale for all intensity ────────────────────────
  // fresh → easy → working → hard → cooked. Ink density is intensity on
  // bone; emission is intensity on ash. Index with T.heat[n] or use the
  // named steps. Beyond-MRV is `heatOver` and is ALWAYS hatched (see
  // hatchOver()) — never just a hotter colour.
  heat: [
    "var(--heat-0)", // fresh    E3CFC6 · 6E625C
    "var(--heat-1)", // easy     D3A492 · 9C6A56
    "var(--heat-2)", // working  C07B63 · BE7E62
    "var(--heat-3)", // hard     A65340 · D69A7A
    "var(--heat-4)", // cooked   82301F · EBBEA0
  ],
  heatOver: "var(--heat-over)", // 5A1C12 · F6DCC4 — hatched, never plain

  // The under-dosed outsider (volume below MEV) — the only non-thermal
  // data colour.
  under: "var(--under)", // steel 6F8189 · 8FA6B5

  // The appearance switch's lit glyphs — warm oxide sun, slate moon.
  // State colour (it names the chosen mode), not data.
  sun:  "var(--sun)",  // A65340 · BE7E62
  moon: "var(--moon)", // 4E6674 · 9FB8C6

  // ── Day keys — categorical, costume-only ──────────────────────────────────
  // Effort is ordinal → the ramp. Day type is categorical → the key.
  // Keys colour ONLY session identifiers: the hairline under the day name,
  // progress ticks, the rest ring. Never data, never buttons, never grounds.
  // One token per day type, resolving to a light/dark pair — hue constant,
  // lightness running away from the ground.
  dayKey: {
    strength: "var(--key-strength)", // oxide  A65340 · D69A7A
    zone2:    "var(--key-cardio)",   // slate  4E6674 · 9FB8C6
    cardio:   "var(--key-cardio)",
    hiit:     "var(--key-hiit)",     // dusk violet 5F5070 · B3A3CC
    rest:     "var(--ink-3)",        // rest carries no key — quietest day
  },

  // ── Commit actions ────────────────────────────────────────────────────────
  // The one coloured surface: commit actions (Begin, Log set, Confirm).
  // Oxide on bone, warm ember on ash; ink flips to stay legible.
  commit:    "var(--commit)",
  commitInk: "var(--commit-ink)",

  // ── Type — two families and an instrument ─────────────────────────────────
  // display: Bodoni Moda, corrected cut — ALWAYS via the DISPLAY style
  //   object below (opsz 11 · kern normal · +0.004em). Nouns that matter —
  //   the day, the lift, the muscle. 28px minimum, mixed case, roman.
  //   400 default; 500 reserved for ceremony (PR cards, deload headers).
  // text: Familjen Grotesk — every word of interface. Sentence case,
  //   never all-caps.
  // measured: Spline Sans Mono — measured values ONLY. If it isn't a
  //   number, it isn't mono.
  display:  "var(--font-bodoni), serif",
  text:     "var(--font-familjen), sans-serif",
  measured: "var(--font-spline), monospace",

  // ── Geometry ──────────────────────────────────────────────────────────────
  // Radius scales with height (§12.1): 12px for anything ≥44px tall, 8px
  // for compact controls ≤36px (tag-chips, reason pickers), 2px for data
  // marks and swatches. Never radius = height/2 — no pills, anywhere.
  r: 12,
  rSm: 8,
  rMark: 2,

  // ── Elevation — the entire model ──────────────────────────────────────────
  // Raised surfaces carry a bottom-edge inset shadow on light and a
  // top-edge inset highlight on dark: light always comes from above.
  // `elev` for quiet surfaces, `elevStrong` for commit CTAs. No other
  // box-shadows on permanent surfaces.
  elev:       "var(--elev)",
  elevStrong: "var(--elev-strong)",

  // Vellum — sheets, toasts, the timer pill ONLY (never cards, rows, the
  // drum or the icon): a 94% tint of the raised surface + a soft cast
  // shadow. No backdrop-filter anywhere.
  vellum:       "var(--vellum)",
  vellumShadow: "0 -10px 24px -14px rgba(36,28,25,0.35)",

  // Scrim dim behind sheets (paint lives on a ::before in globals.css —
  // exported here for the rare inline case).
  scrim: "var(--scrim)",

  // Recessed well — the RPE track's unfilled bed, drum troughs. Slightly
  // below the ground; the one "inset" tone.
  well: "var(--well)",

  // Pressed-surface tint for quiet touchables.
  press: "var(--press)",

  // ── Motion — where the sensation lives ────────────────────────────────────
  // give:    every pressable yields — scale 0.99 in 90ms, returns over 380ms
  // settle:  logged sets land with a 2px overshoot, 480ms
  // bloom:   committed effort travels the ramp over 900ms — heat arrives,
  //          never switches
  // breathe: rest ring ±3.5% scale on a 5.4s cycle — felt, not seen
  // surface: detail data fades/slides in on engagement
  // transform · opacity · colour only — never box-shadow, never layout.
  ease:     "cubic-bezier(0.22, 1, 0.36, 1)",
  tGive:    "380ms",
  tSettle:  "480ms",
  tBloom:   "900ms",
  tBreathe: "5.4s",
};

// The corrected Bodoni cut, frozen. Spread into any display-type style:
//   style={{...DISPLAY, fontSize: 46}}
// Never set the display family without these — the free optical axis is
// what made the t unreadable. 500 is ceremony-only (pass fontWeight after
// the spread).
/** @type {import("react").CSSProperties} */
export const DISPLAY = {
  fontFamily: "var(--font-bodoni), serif",
  fontOpticalSizing: "none",
  fontVariationSettings: "'opsz' 11",
  fontKerning: "normal",
  letterSpacing: "0.004em",
  fontWeight: 400,
  lineHeight: 0.98,
};

// Literal ramp hexes, both modes — for the rare place CSS variables can't
// reach: canvas share cards, SVG gradient stops that interpolate in JS,
// the OG image. UI colour should resolve through T.heat[] instead.
export const RAMP_HEX = {
  light: ["#E3CFC6", "#D3A492", "#C07B63", "#A65340", "#82301F"],
  dark:  ["#6E625C", "#9C6A56", "#BE7E62", "#D69A7A", "#EBBEA0"],
  overLight: "#5A1C12",
  overDark:  "#F6DCC4",
};

// Ground/ink literal pairs for the same canvas/OG cases.
export const MODE_HEX = {
  light: { ground: "#F2E9E3", surface: "#FBF6F2", ink: "#241C19", ink2: "#6A5B54", ink3: "#9C8B83", rule: "#E0D2C9" },
  dark:  { ground: "#1A1512", surface: "#241D19", ink: "#F2E9E3", ink2: "#B5A79E", ink3: "#857870", rule: "rgba(242,233,227,0.1)" },
};

// Repeating-hatch background for beyond-MRV marks — pairs with heatOver.
// Direction/spacing fixed so every hatched mark reads as the same material.
export const HATCH = {
  light: "repeating-linear-gradient(45deg, rgba(242,233,227,0.4) 0 2px, transparent 2px 6px)",
  dark:  "repeating-linear-gradient(45deg, rgba(26,21,18,0.45) 0 2px, transparent 2px 6px)",
  // Mode-resolved via --hatch-line in globals.css:
  auto:  "repeating-linear-gradient(45deg, var(--hatch-line) 0 2px, transparent 2px 6px)",
};

// ── Heat grammar helpers ─────────────────────────────────────────────────────
// The RPE track runs 6 → 10 with ramp stops pinned at the integers
// (6=fresh … 10=cooked). Every heat mark derived from an effort therefore
// samples the same scale the user dragged. Redundancy law: pair the colour
// with heatMarkHeight() AND print the number — colour alone carries nothing.

/** @param {number} rpe */
export function heatIndexForRpe(rpe) {
  return Math.max(0, Math.min(4, Math.round(rpe - 6)));
}

/** @param {number} rpe */
export function heatForRpe(rpe) {
  return T.heat[heatIndexForRpe(rpe)];
}

// Ink for anything sitting ON a heat fill (§13) — per-stop aliases set in
// each mode block; the flip point differs per mode (stop 3 light, stop 2
// dark) so no component may choose ink by eye. Heat-carrying fills quantize
// to the bloom stop for exactly this reason.
/** @param {number} rpe */
export function onHeatForRpe(rpe) {
  return `var(--on-heat-${heatIndexForRpe(rpe)})`;
}

// Mark height in px — magnitude encoded in form as well as colour.
// rpe 7 → 5px, 8 → 8px, 9 → 11px, 10 → 14px (floor 3px).
/** @param {number} rpe */
export function heatMarkHeight(rpe) {
  return Math.max(3, Math.round(5 + 3 * (rpe - 7)));
}

// Stored per-set effort → the RPE scale (easy/normal/cooked is the engine's
// vocabulary; hard/limit are read-time legacy aliases that must never
// appear in UI).
/** @param {string|null|undefined} effort */
export function rpeForEffort(effort) {
  switch (effort) {
    case "easy":   return 7;
    case "normal": return 8;
    case "hard":   return 9;    // legacy
    case "cooked": return 9.5;
    case "limit":  return 10;   // legacy
    default:        return 8;
  }
}

// Effort band from continuous RPE — the coarse vocabulary the flash lines
// and readiness override speak. 6–7 = plenty in reserve; 7.5–8.5 = the work
// as written; 9+ = nothing meaningful left. Banding is lossy by design;
// records keep the dragged number (rpeValue below reads it back).
/** @param {number} rpe */
export function effortForRpe(rpe) {
  if (rpe <= 7.25) return "easy";
  if (rpe <= 8.75) return "normal";
  return "cooked";
}

// The one read path for a set's RPE. Records carry number-or-string by era:
// numeric sets pass through exactly as dragged; enum-era sets fall back to
// the representative value above. Never reconstruct elsewhere.
/** @param {number|string|null|undefined} rpe */
export function rpeValue(rpe) {
  if (typeof rpe === "number" && Number.isFinite(rpe)) return rpe;
  if (typeof rpe === "string" && rpe) return rpeForEffort(rpe);
  return null;
}

// Muscle bucket keys for analytics — 9 display buckets that match what
// normaliseMuscle in lib/analytics.js emits (and its mirror _normaliseMuscle
// in lib/storage.js). The invariant test in tests/analytics.test.js asserts
// every value the normaliser can return has a key here — drift in this map
// should be caught by that test.
//
// Bone & Ember note: categorical per-muscle colour is retired from the UI —
// charts now colour by band status on the thermal ramp (see PerformanceLab).
// The values here are a luminance-ordered warm-neutral family kept unique
// (test invariant) for any surface that still needs a stable per-bucket
// tint (share cards, legacy chips).
export const MUSCLE_COLOURS = {
  // Lower body
  Quads:      "#8A7466",
  Glutes:     "#7A655A",
  Hamstrings: "#6A574E",
  Calves:     "#9A8375",

  // Upper body
  Chest:     "#A65341",
  Back:      "#5A6B66",
  Shoulders: "#6F8189",
  Arms:      "#8D6E76",
  Core:      "#9C8B83",

  // Fallback for unknown muscles
  Other:     "#B5A79E",
};
