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

  // Text scale (light to dark)
  text1: "#EDEBE7",
  text2: "#A09890",
  text3: "#6B6560",
  text4: "#403C38",

  // Accent palette
  coral: "#E0956A",
  sage: "#8BB09A",
  gold: "#C4A882",
  steel: "#A5B8D0",
  rose: "#C9A0B8",

  // Session type themes (main color, dim background, glow)
  strength: { main: "#E0956A", dim: "rgba(224,149,106,0.10)", glow: "rgba(224,149,106,0.18)" },
  zone2:    { main: "#A5B8D0", dim: "rgba(165,184,208,0.10)", glow: "rgba(165,184,208,0.14)" },
  hiit:     { main: "#C9A0B8", dim: "rgba(201,160,184,0.10)", glow: "rgba(201,160,184,0.16)" },
  cardio:   { main: "#A5B8D0", dim: "rgba(165,184,208,0.09)", glow: "rgba(165,184,208,0.12)" },
  rest:     { main: "#6B6560", dim: "rgba(107,101,96,0.08)",  glow: "rgba(107,101,96,0.10)" },

  // Typography
  serif: "var(--font-fraunces), serif",
  sans: "var(--font-dm-sans), sans-serif",

  // Border radii
  r: { sm: 8, md: 14, lg: 20, xl: 28, pill: 999 },

  // Animation easing
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
};

// Muscle group colours for analytics
export const MUSCLE_COLOURS = {
  Chest: "#E0956A",
  Back: "#8BB09A",
  Shoulders: "#A5B8D0",
  Legs: "#C4A882",
  Biceps: "#C9A0B8",
  Triceps: "#D4A574",
  Core: "#A09890",
  Other: "#6B6560",
};
