// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/chart-style.js — the brand, as data, for an AI drawing a chart of
// someone's training. Values mirror app/globals.css (tests/chart-style.test.js
// fails on drift); the rules are the design doc's data-mark rules.

/** [light, dark] per token. */
export const PALETTE = {
  ground: ["#F2E9E3", "#1A1512"],
  surface: ["#FBF6F2", "#241D19"],
  ink: ["#241C19", "#F2E9E3"],
  ink2: ["#6A5B54", "#B5A79E"],
  ink3: ["#8F7D74", "#857870"],
  rule: ["#E0D2C9", "rgba(242, 233, 227, 0.1)"],
  heat0: ["#E3CFC6", "#6E625C"],
  heat1: ["#D3A492", "#9C6A56"],
  heat2: ["#C07B63", "#BE7E62"],
  heat3: ["#A65340", "#D69A7A"],
  heat4: ["#82301F", "#EBBEA0"],
  heatOver: ["#5A1C12", "#F6DCC4"],
  under: ["#6F8189", "#8FA6B5"],
};

export const FONTS = {
  display: { family: "Bodoni Moda", fallback: "serif", use: "Titles only, 28px and up. Never for numbers or labels." },
  text: { family: "Familjen Grotesk", fallback: "system-ui, sans-serif", use: "Every word: labels, captions, legends. Sentence case." },
  measured: { family: "Spline Sans Mono", fallback: "ui-monospace, monospace", use: "Measured values only (kg, sets, reps, dates on axes). Never words." },
};

export const RULES = [
  "Ground is the page colour; don't draw charts on white or black.",
  "Lines are ink (ink2 for secondary), 1.5px, round joins. Sparklines: no fill, no axes, no gridlines.",
  "Heat means EFFORT or LOAD, climbing heat0 → heat4. Never use heat for decoration or for categories.",
  "A single-series trend may run as a gradient heat1 → heat2 → heat3, left to right. One accent system per chart.",
  "Weekly volume: draw MEV / MAV / MRV as horizontal bands — below MEV in 'under' (steel), MEV→MAV heat1 faint, MAV→MRV heat2 faint. Past MRV is HATCHED in heatOver, never just a hotter colour.",
  "Always print the number; colour only supports it. Kill the colour and nothing should be lost.",
  "The current week is unfinished: draw it as a faint 'so far' point (ink3 at 0.45 opacity), off the line, never as a fall. The line ends at the last finished week, and a change against last week is not stated as a drop until the week ends.",
  "No glows, shadows, bevels, 3D, pies or donuts. No all-caps letterspaced labels.",
  "Light is the default. In dark mode use the dark values as given — never brighten them.",
];

// ─── The unfinished week ─────────────────────────────────────────────────────
// One rule for every weekly series an app chart draws (Home's tonnage line,
// the Lab's volume sparklines): the last value is the week so far.

/** How the week so far is drawn: ink3 at this opacity, labelled. */
export const SO_FAR = { opacity: 0.45, label: "so far" };

/**
 * A weekly series, oldest first, with its last value the current week:
 * the finished weeks the line draws, and the week so far as its own point.
 * @param {number[]} series
 * @returns {{ done: number[], soFar: number|null }}
 */
export function splitWeekSoFar(series) {
  const v = Array.isArray(series) ? series : [];
  return v.length ? { done: v.slice(0, -1), soFar: v[v.length - 1] } : { done: [], soFar: null };
}

/**
 * The week so far against last week, as a chart may state it: the
 * difference when it is not a drop, else null (the week has not ended).
 * @param {number[]} series
 * @returns {number|null}
 */
export function weekSoFarDelta(series) {
  const v = Array.isArray(series) ? series : [];
  if (v.length < 2) return null;
  const d = Math.round(v[v.length - 1] - v[v.length - 2]);
  return d < 0 ? null : d;
}

export function chartStyleText() {
  const pal = Object.entries(PALETTE).map(([k, [l, d]]) => `- ${k}: ${l} (dark ${d})`).join("\n");
  const fonts = Object.values(FONTS).map((f) => `- ${f.family} (fallback ${f.fallback}) — ${f.use}`).join("\n");
  return [
    "# Heatwayve chart style",
    "Use this when you draw anything from the user's training, so it looks like Heatwayve. Fonts are on Google Fonts; use the fallback where you can't load them.",
    "", "## Palette (light, dark)", pal,
    "", "## Type", fonts,
    "", "## Rules", ...RULES.map((r) => `- ${r}`),
  ].join("\n");
}
