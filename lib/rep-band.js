// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/rep-band.js
// The rep counts the drum guides toward. Muscle size responds to loads from
// about 30% to 100% of 1RM when sets are hard, and heavier loads build more
// strength (ACSM 2026 position stand, Currier et al., Med Sci Sports Exerc
// 58(4):851-872). So a low count is heavy work, not an error, and only a
// count past 30 reads as off; the programme's own range for the slot is the
// recommendation. The floor of 3 is where a trainer's rep change is flagged.

export const EFFECTIVE_REP_BAND = { min: 3, max: 30 };

/**
 * The drum's tone for a rep count: "rec" inside the programme's range for
 * the slot, "out" past the band's top, otherwise none. Low counts are never
 * dimmed: a short set logs fine and should look it.
 * @param {number} v
 * @param {{min: number, max: number} | null} rec
 * @returns {"rec" | "out" | null}
 */
export function repTone(v, rec) {
  if (rec && v >= rec.min && v <= rec.max) return "rec";
  return v > EFFECTIVE_REP_BAND.max ? "out" : null;
}

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
