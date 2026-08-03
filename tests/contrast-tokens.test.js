// tests/contrast-tokens.test.js
// ─────────────────────────────────────────────────────────────────────────────
// §13 of the design pack: contrast floors, measured — not assumed. These
// parse the literal hexes out of globals.css and recompute the ratios, so a
// palette tune can never silently sink a floor. Invariants, not snapshots:
//   · text inks clear 4.5:1 on both grounds (ink-3 is exempt — non-text
//     by ruling, held to the 3:1 glyph floor instead)
//   · the on-heat ink clears 4.5:1 at every ramp stop it is assigned to,
//     except the licensed dark stops 0–1, which still clear the 3:1 floor
//   · the ramp's L* stays strictly monotonic in both modes (redundancy law)
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(root, "app/globals.css"), "utf8");

// ── Token extraction ─────────────────────────────────────────────────────────
// Light tokens live in :root, dark in the prefers-color-scheme block; the
// dark block redeclares only what flips, so dark falls back to light.
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
const lightSrc = css.slice(0, darkStart);
const darkSrc = css.slice(darkStart, css.indexOf("}", css.indexOf("--elev", darkStart)));

function tokens(src) {
  const out = {};
  for (const m of src.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6}|var\(--[a-z0-9-]+\))\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}
const light = tokens(lightSrc);
const dark = { ...light, ...tokens(darkSrc) };
const resolveTok = (t, k) => {
  let v = t[k];
  while (v && v.startsWith("var(")) v = t[v.slice(6, -1)];
  return v;
};

// ── WCAG maths ───────────────────────────────────────────────────────────────
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const lstar = (hex) => {
  const y = lum(hex);
  return y <= 216 / 24389 ? y * (24389 / 27) : Math.cbrt(y) * 116 - 16;
};

const STOPS = ["heat-0", "heat-1", "heat-2", "heat-3", "heat-4", "heat-over"];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s mode", (mode, t) => {
  const g = (k) => resolveTok(t, k);

  it("declares every token the contract needs", () => {
    for (const k of ["ground", "surface", "ink", "ink-2", "ink-3", "commit", "commit-ink", ...STOPS, "on-heat-0", "on-heat-1", "on-heat-2", "on-heat-3", "on-heat-4", "on-heat-over"]) {
      expect(g(k), k).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("text inks clear 4.5:1 on ground and raised surface", () => {
    for (const ink of ["ink", "ink-2"]) {
      for (const bg of ["ground", "surface"]) {
        expect(contrast(g(ink), g(bg)), `${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("ink-3 clears the 3:1 glyph floor (non-text by ruling — never sentences)", () => {
    expect(contrast(g("ink-3"), g("ground"))).toBeGreaterThanOrEqual(3);
    expect(contrast(g("ink-3"), g("surface"))).toBeGreaterThanOrEqual(3);
  });

  it("the lit switch glyphs clear the glyph floor on their selected cell", () => {
    expect(contrast(g("sun"), g("surface"))).toBeGreaterThanOrEqual(3);
    expect(contrast(g("moon"), g("surface"))).toBeGreaterThanOrEqual(3);
  });

  it("the commit label clears 4.5:1 on the commit surface", () => {
    expect(contrast(g("commit-ink"), g("commit"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the on-heat ink holds its floor at every ramp stop", () => {
    // Dark stops 0–1 are licensed at the 3:1 mark floor (§13 — the number
    // and RIR words always print beside the fill); everything else is a
    // label and must clear 4.5:1.
    for (let i = 0; i < STOPS.length; i++) {
      const stop = STOPS[i];
      const onKey = stop === "heat-over" ? "on-heat-over" : `on-heat-${i}`;
      const floor = mode === "dark" && i <= 1 ? 3 : 4.5;
      expect(contrast(g(onKey), g(stop)), `${onKey} on ${stop}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it("ramp L* is strictly monotonic, running away from the ground", () => {
    const ls = STOPS.map((k) => lstar(g(k)));
    for (let i = 1; i < ls.length; i++) {
      if (mode === "light") expect(ls[i], `${STOPS[i]} vs ${STOPS[i - 1]}`).toBeLessThan(ls[i - 1]);
      else expect(ls[i], `${STOPS[i]} vs ${STOPS[i - 1]}`).toBeGreaterThan(ls[i - 1]);
    }
  });
});
