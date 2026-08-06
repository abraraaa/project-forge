// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/exercise-videos.js
// ─────────────────────────────────────────────────────────────────────────────
// The curated demo-footage layer. Wins over any vid a programme.js entry
// carries (the library's video index claims these first, and the in-session
// player resolves through resolveVid) — so one file is where footage
// curation happens, instead of edits scattered across 400 pool entries.
//
// EVERY id here is VERIFIED: read mechanically from the boss's curated
// playlist (scripts/verify-videos.mjs --playlist, 58/58 resolved via oEmbed,
// all Rogue Fitness "Movement Demo" clips, 2026-08-06) or reused from
// footage the app already served. Nothing lands here on a model's say-so —
// the 2026-08-06 sourcing batch fabricated 24 of 32 fresh ids, and that gate
// is why none of them shipped.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, string>} */
export const EXTRA_VIDEOS = {
  // ── Same-movement reuse of footage already served (2026-08-06) ────────────
  "Floor Press": "uUGDRwge4F8",       // DB Floor Press
  "Sliding Leg Curl": "lLUniqm00KM",  // Slider Leg Curl

  // Calisthenicmovement, oEmbed-verified ("The Perfect Push Up | Do it
  // right!") — the one fresh id from the failed sourcing batch that was both
  // real and on the preferred-producer list.
  "Push-Up": "IODxDxX7oi4",

  // ── Rogue Fitness, from the curated playlist (2026-08-06) ─────────────────
  // Gaps filled:
  "Burpee": "SxDmxON_pZk",                    // "Movement Demo - Burpees"
  "Chair Dip": "uZm3RYM25TI",                 // "Movement Demo - Dips Off Bench"
  "Good Morning": "fJA39ZOVaEQ",              // "How To Do Banded Good Mornings" — banded, same hinge pattern
  // Upgrades of existing footage:
  "Bench Dips": "uZm3RYM25TI",                // "Movement Demo - Dips Off Bench"
  "Weighted Dips": "UZ_kEpmACZ4",             // "Movement Demo - Weighted Dips"
  "Tricep Dips": "KnFJ-Dhl6KU",               // "Movement Demo - Bodyweight Dips"
  "Hammer Curl": "vU32_jJCZbA",               // "Movement Demo - Double Hammer Curls"
  "Skullcrusher": "4n058b7uke0",              // "Movement Demo - Double Skull Crushers (Bench)"
  "Lateral Raise": "vXkm-7qLjYc",             // "Movement Demo - Lateral Raises"
  "Band Pull-Apart": "smSSXITNpCI",           // "How To Do Band Pull Aparts"
  "Resistance Band Pushdown": "qjPN6ElNqpc",  // "How To Do Banded Tricep Pushdowns"
  "Belt Squat": "4uZ5tq8uFV8",                // "Movement Demo - Rhino Belt Squat"
  "Hex Bar Deadlift": "mluyMgI8QKw",          // "Movement Demo - High Handle Trap Bar Deadlift"
  "Front Squat": "CE0uSrr4SYQ",               // "Movement Demo - The Front Squat" (swap-only name — no library page, in-session only)
  "Hang Power Clean": "22XonEeuRjk",          // "Movement Demo - Hang Power Clean"
  "Barbell Overhead Press": "VF-YjKlhph0",    // "Movement Demo - The Shoulder Press"
  "Split Squat": "I1aqLTfvxR8",               // "Movement Demo - Static Lunges"
  "DB Walking Lunge": "sXTcmJ_CIQM",          // "Movement Demo - Farmer's Carry Walking Lunge"
  "45-Degree Hip Extension": "tIxtyWW0vF4",   // "Movement Demo - Weighted Back Extensions"
};

/**
 * The one read path for demo footage: the curated layer first, then whatever
 * the programme entry carries.
 * @param {string|null|undefined} name
 * @param {string|null|undefined} [fallback]
 * @returns {string|null}
 */
export function resolveVid(name, fallback = null) {
  return (name && EXTRA_VIDEOS[name]) || fallback || null;
}
