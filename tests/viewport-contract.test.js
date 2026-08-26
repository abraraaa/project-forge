// tests/viewport-contract.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The Phase 2 shell contract, ENFORCED (2026-07-23): .forge-page is the only
// element that knows viewport height / safe-area-top / display mode. The
// contract lived only in a globals.css comment and was violated twice
// (#72 SessionScreen, #73b Locker Room — the second by the contract's own
// author). Comments bind nobody; this test does. Screens may not:
//   - own viewport height (minHeight/height in vh/dvh) — maxHeight caps for
//     media elements are fine (fractional constraints, not shell math);
//   - clear the status bar themselves (env(safe-area-inset-top)) — sheet
//     BOTTOM padding via safe-area-inset-bottom stays legal.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const walk = (d) => {
  for (const f of readdirSync(resolve(root, d), { withFileTypes: true })) {
    const rel = join(d, f.name);
    if (f.isDirectory()) walk(rel);
    else if (/\.jsx$/.test(f.name)) files.push(rel);
  }
};
walk("components");
walk("app");

// GRANDFATHERED violations (pre-lock legacy, exact counts): the ratchet.
// These sites predate enforcement and are visually load-bearing until each
// gets its own compliance pass — but the counts may only ever DECREASE.
// Adding a new vh/dvh height or inset-top use anywhere (including +1 in
// these files) fails CI. Shrink opportunistically; delete entries at zero.
const GRANDFATHERED_VH = {
  "components/ErrorBoundary.jsx": 1,
  "components/ForgeApp.jsx": 4,
  "components/HomeScreen.jsx": 1,
  "components/PerformanceLab.jsx": 1,
  "components/ProfileScreen.jsx": 3,
  "components/client-shells.jsx": 1,
  "app/diag-sync/page.jsx": 1,
  "app/diag-vt/page.jsx": 1,
  "app/library/[slug]/page.jsx": 1,
  "app/library/page.jsx": 1,
};
// INSTRUMENTS: not an exemption from the contract — a different activity.
// The ratchet exists to stop SCREENS padding themselves clear of the status
// bar. A diagnostic whose entire job is to MEASURE the inset has to name it,
// and it pads nothing. Kept separate from the grandfather table on purpose:
// that list is frozen legacy that may only shrink, this one is instruments.
const INSTRUMENTS_TOP = {
  "app/diag-safe-area/page.jsx": true,   // reads env() into a hidden probe
};
const GRANDFATHERED_TOP = {
  "components/HomeScreen.jsx": true,
  "components/PerformanceLab.jsx": true,
  "app/library/page.jsx": true,
  "app/library/[slug]/page.jsx": true,
  "app/diag-vt/page.jsx": true,
  "app/layout.jsx": true, // the shell's own wiring — legitimate forever
};

// The ratchet above walks components/ and app/ for .jsx ONLY, so globals.css
// — the one file that actually owns the viewport — has never been scanned by
// the contract policing it. That is how `html, body { height: 100vh }` sat
// ninety lines above `.forge-page`'s ladder, each with its own essay, neither
// citing the other, while three fixes were applied below it and none worked.
//
// Measured on device (installed, iOS 27, cold and warm): innerHeight 812,
// screen 874, vh/lvh 874, svh/dvh 812. vh is the screen. A definite vh height
// on body IS document scroll, before the shell is consulted at all.
describe("globals.css — the viewport is named once, and correctly", () => {
  const css = readFileSync(resolve(root, "app/globals.css"), "utf8");
  // Declarations only — the file is full of prose about these units.
  const decls = css
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

  it("body's height is svh, with vh only as the pre-svh floor", () => {
    expect(decls).toMatch(/html,\s*body\s*\{\s*height:\s*100svh/);
    const bodyVh = decls.match(/html,\s*body\s*\{[^}]*height:\s*100vh/g) || [];
    expect(bodyVh.length, "the vh floor may exist once, inside no @supports").toBeLessThanOrEqual(1);
  });

  it("the shell states an svh rung of its own rather than only inheriting", () => {
    // stretch fills the containing block. If body is ever wrong again, a
    // shell that only says `stretch` inherits the mistake silently.
    expect(decls).toMatch(/\.forge-page\s*\{\s*min-height:\s*100svh/);
  });

  it("no element other than html/body/.forge-page sets a viewport height", () => {
    const offenders = [];
    // [^{}]* on BOTH sides so this matches only innermost blocks — otherwise
    // an @supports prelude is read as the selector of the rule it wraps.
    for (const m of decls.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector, body] = m;
      if (!/(?:^|[^-])height:\s*[^;]*\d(?:s|l|d)?vh/.test(body)) continue;
      const sel = selector.trim().split("\n").pop().trim();
      if (/^(html,\s*body|html|body|\.forge-page)$/.test(sel)) continue;
      offenders.push(`${sel} → ${body.trim().slice(0, 60)}`);
    }
    expect(
      offenders,
      `only the shell may name viewport height: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });
});

describe("viewport contract — the shell owns the viewport (ratcheted)", () => {
  it("no NEW viewport-height ownership; grandfathered counts only shrink", () => {
    const overages = [];
    for (const rel of files) {
      const src = readFileSync(resolve(root, rel), "utf8");
      const n = [...src.matchAll(/(?:minHeight|[^x]height)\s*:\s*["'`][^"'`]*\d(?:d?vh)\b[^"'`]*["'`]/gi)].length;
      const allowed = GRANDFATHERED_VH[rel.replace(/\\/g, "/")] || 0;
      if (n > allowed) overages.push(`${rel}: ${n} vh/dvh heights (allowed ${allowed})`);
    }
    expect(overages, `shell-contract violations (see globals.css .forge-page): ${overages.join(" | ")}`).toEqual([]);
  });

  it("no NEW status-bar self-clearance (env(safe-area-inset-top))", () => {
    const offenders = files.filter((rel) =>
      readFileSync(resolve(root, rel), "utf8").includes("safe-area-inset-top") &&
      !GRANDFATHERED_TOP[rel.replace(/\\/g, "/")] &&
      !INSTRUMENTS_TOP[rel.replace(/\\/g, "/")],
    );
    expect(offenders, `only .forge-page/layout may pad the status bar: ${offenders.join(", ")}`).toEqual([]);
  });
});
