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

  // ── Access over aesthetic (boss ruling, 2026-08-06): a real demo beats a
  // blank box. Verified mainstream fallbacks — replace whenever better
  // footage lands in a playlist.
  "Bird Dog": "wiFNA3sqjCA",           // Howcast
  "Dead Bug": "4XLEnwUr1d8",           // Bodybuilding.com
  "Kettlebell Swing": "vdezTMulJ-k",   // CrossFit — "The Kettlebell Swing"
  "Mountain Climber": "nmwgirgXLYM",   // Howcast
  "Walking Lunge": "L8fvypPrzzs",      // CrossFit — "The Walking Lunge"

  // Boss's own finds (2026-08-12), oEmbed-verified 8/8. Replaces the
  // 2026-08-06 census suppressions — DEAD_UNTIL_REPLACED entries removed
  // below for all but Sumo Deadlift (still wrong-movement, still open).
  "Ab Wheel": "_BHKT60P6bc",                  // UCLA Health — "Strengthening the core: Ab Wheel"
  "Lateral Band Walk": "DkaQ1mmfErA",         // Seriously Strong Training
  "Plank": "kL_NJAkCQBg",                     // Calisthenicmovement — "Mastering the Plank"
  "Resistance Band Lateral": "yfNg5sFndbw",   // Men's Health
  "Resistance Band Pull-Down": "X_E7iiSsklI", // OPEX Fitness
  "Resistance Band Row": "j7ABJGauUEk",       // OPEX Fitness
  "Side Plank": "tbWPBOgju9g",                // OPEX Fitness
  "Step-Up": "RRuWVDefORg",                   // OPEX Fitness

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

  // Boss's second playlist batch (2026-08-12), oEmbed-verified 28/28. Clears
  // the last two census suppressions (Wall Sit, Y-T-W Raise), a corrected
  // Sumo Deadlift (this one genuinely IS the sumo pull — the 2026-08-06
  // census id played the SUMO DEADLIFT HIGH PULL, a different lift), and
  // every remaining never-had-footage gap including the household/travel
  // set. DEAD_UNTIL_REPLACED is now empty.
  "Sumo Deadlift": "OKMDYjnK8m8",              // OPEX Fitness — "Sumo Deadlift"
  "Wall Sit": "5lvRUqZIgo0",                   // OPEX Fitness
  "Y-T-W Raise": "9lkmWOPn184",                // LBSU Strength
  "Adductor Stretch Lunge": "zejTuBTEkfY",     // Medibank — "How to do a Side Lunge stretch"
  "Backpack Curl": "dKqtGGScQhQ",              // Nick Bolton — "Backpack bicep curls"
  "Backpack Shrug": "HkVAZUnYGa8",             // Jamie Duffill — "Bag Shrug"
  "Banded Glute Bridge": "-8peiPaQM64",        // Heartmybody Fitness
  "Bar Hang": "4RqNGRVaTUQ",                   // CrossFit Jääkarhu — "Movement: Bar Hang"
  // "Inverted Skullcrusher" — same lift, common alt name (skull crusher
  // pressed from underneath a fixed bar rather than a bench).
  "Bodyweight Skullcrusher": "1lrjpLuXH4w",    // Renaissance Periodization
  "Bottle Lateral Raise": "aSNOlEYSLPg",       // The Fit Chase
  "Broad Jump": "AOkmLTD8J24",                 // Catalyst Athletics
  "Cable Hip Abduction": "vSqhrbzZb7A",        // Glute Lab
  "Copenhagen Plank": "HOmsC6HEiFU",           // Body in Motion
  "Cossack Squat": "dhDjKmTX8tU",              // Functional Bodybuilding
  "Deficit Push-Up": "KadL9HpmWSg",            // TrainFTW
  // "Dumbbell RDL / Romanian Deadlift" — the RDL is the hamstring-hinge
  // variant of this pull; matches the anatomy entry's Hamstrings-primary
  // target more precisely than a from-floor pickup would.
  "Dumbbell Deadlift": "5WxMW-Fu5KU",          // Denvyr | Tall Girl Nutritionist
  "Dumbbell Hang Clean": "hFXPxXkYr_o",        // Wodstar
  "Hip Adduction": "e9AqTFMmP18",              // R Greenwood — "Hip Adductor Machine: Demo"
  "Inverted Row": "9fItzuh9Iok",               // The Active Life
  "Pallof Press": "gHGLwQGvtxg",               // Men's Health
  "Resistance Band Pull-Through": "ZuKowDpVVXM", // Marcus Filly — "Band Pull Through"
  "Side-Lying Adduction": "UW52u8OaWhw",       // Balance In Motion
  "Sliding Fly": "GrSCUXcvLq8",                // CORE PT Fullerton — "Slider Chest Fly"
  "Standing Cable Hip Extension": "m2ShOWIzRhc", // TYTAX
  "Stir the Pot": "Vt9au65_2yk",               // Runna — "Swiss Ball Stir the Pot Tutorial"
  "Towel Face Pull": "VLc-AeQpFZ4",            // HAUS No3 — "Face pull | Towel"
};

// Row Sprint and Shuttle Runs (2026-08-12, same batch) are bonus-pool
// movements, not library entries — their ids live directly on
// CARDIO_BONUS_POOL in lib/programme.js, not here.

/**
 * Names whose programme-entry footage is known bad — dead ids or a
 * wrong-movement demo. Suppressed until verified replacement footage lands;
 * the empty state is the honest fallback rather than a broken or misleading
 * embed. History: the 2026-08-06 census found 10 dead ids (of 160) plus one
 * wrong-movement match (Sumo Deadlift's id played the Sumo Deadlift HIGH
 * PULL — a different lift). All 11 replaced by 2026-08-12 via two rounds of
 * the boss's own verified playlist finds. Empty for now; the mechanism
 * stays live for whatever the next census turns up.
 * @type {Set<string>}
 */
export const DEAD_UNTIL_REPLACED = new Set([]);

/**
 * The one read path for demo footage: the curated layer first, then whatever
 * the programme entry carries — unless the name is suppressed.
 * @param {string|null|undefined} name
 * @param {string|null|undefined} [fallback]
 * @returns {string|null}
 */
export function resolveVid(name, fallback = null) {
  if (name && EXTRA_VIDEOS[name]) return EXTRA_VIDEOS[name];
  if (name && DEAD_UNTIL_REPLACED.has(name)) return null;
  return fallback || null;
}
