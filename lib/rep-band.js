// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/rep-band.js
// The rep counts the drum guides toward. Sets taken close to failure build
// muscle across roughly 6–30 reps (Schoenfeld et al. 2017, low- vs high-load
// meta-analysis), so a choice inside that band is a preference, not an
// error; the programme's own range for the slot is the recommendation.

export const EFFECTIVE_REP_BAND = { min: 6, max: 30 };

/**
 * The programme's recommended reps for a template value: "12-15" → 12..15,
 * 8 or "8/leg" → 8..8. Timed ("20s") and unparseable values → null.
 * @param {number|string|null|undefined} reps
 * @returns {{min: number, max: number} | null}
 */
export function recommendedReps(reps) {
  if (typeof reps === "number") return reps > 0 ? { min: reps, max: reps } : null;
  if (typeof reps !== "string" || /s$/.test(reps.trim())) return null;
  const m = reps.match(/^\s*(\d+)\s*(?:[-–]\s*(\d+))?/);
  if (!m) return null;
  const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
  return a > 0 ? { min: Math.min(a, b), max: Math.max(a, b) } : null;
}
