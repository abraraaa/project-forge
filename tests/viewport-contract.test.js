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
const GRANDFATHERED_TOP = {
  "components/HomeScreen.jsx": true,
  "components/PerformanceLab.jsx": true,
  "app/library/page.jsx": true,
  "app/library/[slug]/page.jsx": true,
  "app/diag-vt/page.jsx": true,
  "app/layout.jsx": true, // the shell's own wiring — legitimate forever
};

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
      !GRANDFATHERED_TOP[rel.replace(/\\/g, "/")],
    );
    expect(offenders, `only .forge-page/layout may pad the status bar: ${offenders.join(", ")}`).toEqual([]);
  });
});
