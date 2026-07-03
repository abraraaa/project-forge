// @ts-check
// lib/tokens.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared design tokens for Project Forge.
// Single source of truth — import into any component that needs styling.
// ─────────────────────────────────────────────────────────────────────────────

export const T = {
  // Background scale (dark to light)
  bg0: "#131110",
  bg1: "#1A1714",
  bg2: "#23201B",
  bg3: "#2D2924",
  bg4: "#38342E",

  // Text scale (light to dark). Floor tiers lifted 2026-07-03 after a
  // legibility report on device: over the grain substrate the old values
  // measured 3.3:1 (text3 #6B6560) and 1.7:1 (text4 #403C38) against
  // #131110 — text4 was near-invisible on the week strip and date
  // flourishes. Now ~4.7:1 / ~3.0:1 (small-text AA / large-text floor),
  // same warm-grey family, hierarchy preserved (text2 ≈ 6.6:1).
  text1: "#EDEBE7",
  text2: "#A09890",
  text3: "#857D75",
  text4: "#66605A",

  // Accent palette
  coral: "#E0956A",
  sage: "#8BB09A",
  gold: "#C4A882",
  steel: "#A5B8D0",
  rose: "#C9A0B8",

  // Session type themes (main color, dim background, glow). User feedback:
  // the day-type animation reads "lovely" on strength↔cardio but appears
  // to skip rest/HIIT — because the transition end-state was so dim those
  // destinations were near-invisible, not because the animation didn't fire.
  // Bumped HIIT and rest glow up to register as genuine destinations.
  // Rest is still the quietest day-type — just no longer to the point of
  // looking broken.
  strength: { main: "#E0956A", dim: "rgba(224,149,106,0.10)", glow: "rgba(224,149,106,0.18)" },
  zone2:    { main: "#A5B8D0", dim: "rgba(165,184,208,0.10)", glow: "rgba(165,184,208,0.16)" },
  hiit:     { main: "#C9A0B8", dim: "rgba(201,160,184,0.12)", glow: "rgba(201,160,184,0.22)" },
  cardio:   { main: "#A5B8D0", dim: "rgba(165,184,208,0.09)", glow: "rgba(165,184,208,0.14)" },
  rest:     { main: "#6B6560", dim: "rgba(107,101,96,0.10)",  glow: "rgba(107,101,96,0.18)" },

  // Focus accents — per-user identity colour. Forms a secondary rim glow on
  // the home backdrop + colours the italic accent in the home headline.
  // Quiet by design so the day-type accent stays the dominant signal; this
  // is a "you-are-here" layer, not a competing voice.
  //   Forged — gold (the existing default brand accent)
  //   Strong — deeper coral / amber. Heavier, more intense.
  //   Sculpt — soft mauve-rose. Refined, considered.
  focusAccent: {
    Forged: { main: "#C4A882", dim: "rgba(196,168,130,0.10)", glow: "rgba(196,168,130,0.16)" },
    Strong: { main: "#D4754A", dim: "rgba(212,117,74,0.12)",  glow: "rgba(212,117,74,0.20)"  },
    Sculpt: { main: "#C99BB1", dim: "rgba(201,155,177,0.10)", glow: "rgba(201,155,177,0.18)" },
  },

  // Typography
  serif: "var(--font-fraunces), serif",
  sans: "var(--font-dm-sans), sans-serif",

  // Border radii
  r: { sm: 8, md: 14, lg: 20, xl: 28, pill: 999 },

  // Animation easing
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
};

// Muscle group colours for analytics — 9 display buckets that match what
// normaliseMuscle in lib/analytics.js emits (and its mirror _normaliseMuscle
// in lib/storage.js). Lower body splits into Quads / Glutes / Hamstrings /
// Calves; upper-arm muscles merge into "Arms". The invariant test in
// tests/analytics.test.js asserts every value the normaliser can return
// has a key here — drift in this map should be caught by that test.
//
// Palette discipline: leg muscles share a warm-earth family with luminance
// variation for visual stacking. Upper body keeps the original chart accent
// assignments — Chest (coral), Back (sage), Shoulders (steel), Arms (rose),
// Core (warm grey).
export const MUSCLE_COLOURS = {
  // Lower body — warm earth family
  Quads:      "#C4A882",
  Glutes:     "#B8956A",
  Hamstrings: "#9C7B5A",
  Calves:     "#D4B898",

  // Upper body
  Chest:     "#E0956A",
  Back:      "#8BB09A",
  Shoulders: "#A5B8D0",
  Arms:      "#C9A0B8",
  Core:      "#A09890",

  // Fallback for unknown muscles
  Other:     "#6B6560",
};
