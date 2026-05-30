#!/usr/bin/env node
// scripts/volume-audit.mjs
// ────────────────────────────────────────────────────────────────────────────
// Print the weekly weighted-set volume the live programme delivers per muscle,
// banded against MEV/MAV/MRV. Run: `npm run audit:volume`.
// ────────────────────────────────────────────────────────────────────────────

import { auditVolume } from "../lib/volume-audit.js";

const BAND_LABEL = {
  under_mev: "⚠ under MEV",
  low: "· below MAV",
  optimal: "✓ optimal",
  over_mrv: "⚠ over MRV",
  untargeted: "  (no target)",
};

const { perMuscle, flags } = auditVolume();

const col = (s, w) => String(s).padEnd(w);
const num = (s, w) => String(s).padStart(w);

console.log("\nWeekly volume audit — default programme (A + B + C, 3 days/week)\n");
console.log(
  col("Muscle", 14) + num("Sets", 6) + "   " +
  num("MEV", 4) + num("MAV", 5) + num("MRV", 5) + "   Band",
);
console.log("─".repeat(58));

for (const [muscle, r] of Object.entries(perMuscle)) {
  const t = r.target
    ? num(r.target.mev, 4) + num(r.target.mav, 5) + num(r.target.mrv, 5)
    : num("-", 4) + num("-", 5) + num("-", 5);
  console.log(col(muscle, 14) + num(r.sets, 6) + "   " + t + "   " + (BAND_LABEL[r.status] || r.status));
}

console.log("\nFlags (actionable extremes):");
if (flags.length === 0) {
  console.log("  none — every targeted muscle is within MEV..MRV.");
} else {
  for (const f of flags) {
    const dir = f.status === "over_mrv"
      ? `${f.sets} > MRV ${f.target.mrv}`
      : `${f.sets} < MEV ${f.target.mev}`;
    console.log(`  ${BAND_LABEL[f.status].trim()}  ${col(f.muscle, 12)} ${dir}`);
  }
}
console.log("");
