// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/travel.js
// ─────────────────────────────────────────────────────────────────────────────
// Travel mode — the session you can train away from your gym.
//
// The OLD travel mode was a filter inside the swap sheet: per-exercise,
// per-session, reset every time the sheet opened, and it offered NOTHING for
// the main lifts (a heavy-equivalents-only swap list has no bodyweight member,
// so every session's anchor read "no alternatives"). Boss verdict: "does fuck
// all." This replaces it.
//
// THE CLAIM travel mode makes: you are away from the gym and still training.
// It is NOT a rest state — lib/breaks.js already owns that, and its
// "Travelling" reason means resting away. Keep the two apart in copy.
//
// WHAT IT DOES: takes the session the engine already resolved — rotation,
// swaps and focus applied — and converts each slot to a movement that trains
// the same muscles with the assumed kit. The A/B/C shape survives: same
// blocks, same slots, same order, reps translated up because bodyweight
// stimulus arrives later in a set.
//
// ASSUMED KIT (boss ruling, 2026-08-04): a pull-up bar and a block/step are
// assumed. Household items count as kit — a backpack is the travel barbell,
// a towel is both slider and anchor, a table edge is a row, bottles are
// light isolation, a sofa is a bench.
//
// WHAT IT DELIBERATELY DOESN'T DO: feed the progression engine. A travel
// session's loads say nothing about what your barbell prescription should be,
// so the record carries `travel: true` and the engine skips it. Volume still
// counts in the Lab, and the day still ticks — that is the entire point.
// ─────────────────────────────────────────────────────────────────────────────

import { getAnatomy } from "./exercise-anatomy.js";

/**
 * The kit a travel session may assume. Anything outside this list may not
 * appear in a twin — that is the constraint that keeps the mode honest.
 */
export const TRAVEL_KIT = ["pull-up bar", "block or step", "backpack", "towel", "table edge", "bottles", "sofa"];

/**
 * Movements that already need nothing but the assumed kit. They pass through
 * untouched — converting a pull-up into a "travel pull-up" would be theatre.
 * NOTE this is an allow-list, not a `loadType === "bodyweight"` test: TRX Row
 * and Captain's Chair Raise are bodyweight AND gym furniture.
 */
export const TRAVEL_NATIVE = new Set([
  "Pull-Up", "Chin-Up", "Neutral-Grip Pull-Up", "Wide-Grip Pull-Up",
  "Hanging Leg Raise", "Hanging Knee Raise", "Toes-to-Bar", "Windshield Wiper", "L-Sit Hold",
  "Push-Up", "Diamond Push-Up", "Wide Push-Up",
  "Plank", "Side Plank", "Dead Bug", "Hollow Body Hold", "Bird Dog", "Reverse Crunch",
  "Lying Leg Raise", "Bicycle Crunch", "Mountain Climber", "Glute Bridge",
  "Bulgarian Split Squat", "Split Squat", "Step-Up", "Single-Leg Hip Thrust",
  "Single-Leg Calf Raise", "Single-Leg RDL", "Pike Push-Up", "Frog Pump",
  "Air Squat", "Jump Squat", "Broad Jump", "Burpee",
]);

/**
 * The catalogue — every movement travel mode may prescribe, with the display
 * label the session card shows (the app's own vocabulary, not an anatomy key)
 * and the kit to find in the room. Kit surfaces on the card so nobody starts
 * a set before realising they need a chair.
 *
 * @type {Record<string, {muscle: string, kit: string|null}>}
 */
export const TRAVEL_MOVES = {
  "Bulgarian Split Squat":   { muscle: "Quads & Glutes",  kit: "block · backpack to load" },
  "Step-Up":                 { muscle: "Quads",           kit: "block · backpack" },
  "Walking Lunge":           { muscle: "Quads & Glutes",  kit: "backpack optional" },
  "Reverse Lunge":           { muscle: "Quads & Glutes",  kit: "backpack optional" },
  "Single-Leg Hip Thrust":   { muscle: "Glutes",          kit: "sofa or block" },
  "Glute Bridge":            { muscle: "Glutes",          kit: null },
  "Sliding Leg Curl":        { muscle: "Hamstrings",      kit: "towel on smooth floor" },
  "Single-Leg RDL":          { muscle: "Posterior chain", kit: "backpack" },
  "Single-Leg Calf Raise":   { muscle: "Calves",          kit: "block edge" },
  "Deficit Push-Up":         { muscle: "Chest",           kit: "two blocks or books" },
  "Decline Push-Up":         { muscle: "Upper chest",     kit: "sofa or block for feet" },
  "Sliding Fly":             { muscle: "Chest",           kit: "towel on smooth floor" },
  "Pull-Up":                 { muscle: "Lats",            kit: "bar" },
  "Inverted Row":            { muscle: "Upper back",      kit: "table edge" },
  "Backpack Shrug":          { muscle: "Traps",           kit: "loaded backpack" },
  "Pike Push-Up":            { muscle: "Shoulders",       kit: "block to progress" },
  "Bottle Lateral Raise":    { muscle: "Side delts",      kit: "two filled bottles" },
  "Towel Face Pull":         { muscle: "Rear delts",      kit: "towel · door anchor" },
  "Backpack Curl":           { muscle: "Biceps",          kit: "loaded backpack" },
  "Chin-Up":                 { muscle: "Biceps & lats",   kit: "bar" },
  "Chair Dip":               { muscle: "Triceps",         kit: "chair or sofa edge" },
  "Bodyweight Skullcrusher": { muscle: "Triceps",         kit: "table edge" },
  "Diamond Push-Up":         { muscle: "Triceps",         kit: null },
  "Bar Hang":                { muscle: "Forearms",        kit: "bar" },
  "Hollow Body Hold":        { muscle: "Core",            kit: null },
  "Plank":                   { muscle: "Core",            kit: null },
  "Broad Jump":              { muscle: "Power",           kit: null },
};

/**
 * Explicit equivalences for every slot the A/B/C template serves by default.
 * Keyed by the movement being replaced; the value names a TRAVEL_MOVES entry.
 *
 * @type {Record<string, string>}
 */
export const TRAVEL_TWINS = {
  // ── Day A · Squat & Push ────────────────────────────────────────────────
  "Barbell Back Squat":         "Bulgarian Split Squat",
  "Barbell Bench Press":        "Deficit Push-Up",
  "Barbell Reverse Lunge":      "Reverse Lunge",
  "Chest-Supported DB Row":     "Inverted Row",
  "Barbell Hip Thrust":         "Single-Leg Hip Thrust",
  "Landmine Press":             "Pike Push-Up",
  "Standing Calf Raise":        "Single-Leg Calf Raise",

  // ── Day B · Hinge & Pull ────────────────────────────────────────────────
  // The hinge is the hardest honest conversion: nothing bodyweight loads a
  // deadlift pattern. Single-leg RDL keeps the hip hinge and the hamstring
  // stretch; the day's curl slot carries the rest of the posterior work.
  "Hex Bar Deadlift":           "Single-Leg RDL",
  "Barbell Overhead Press":     "Pike Push-Up",
  "Leg Press":                  "Step-Up",
  "Machine Hamstring Curl":     "Sliding Leg Curl",
  "Tricep Pushdown":            "Chair Dip",
  "Lateral Raise":              "Bottle Lateral Raise",

  // ── Day C · Power & Volume ──────────────────────────────────────────────
  // Power survives unloaded — it just stops being a barbell. Low-rep and
  // explosive, never a conditioning circuit.
  "Power Clean":                "Broad Jump",
  "DB Walking Lunge":           "Walking Lunge",
  "Cable Lateral Raise":        "Bottle Lateral Raise",
  "Incline DB Press":           "Decline Push-Up",
  "Seated Cable Row":           "Inverted Row",
  "DB Curl":                    "Backpack Curl",
  "Skullcrusher":               "Bodyweight Skullcrusher",
  "Face Pull":                  "Towel Face Pull",
  "Low-to-High Cable Crossover":"Sliding Fly",
};

/**
 * Ordered alternates, keyed by the ANATOMY primary of whatever rotation or a
 * swap picked. Two jobs: it answers for movements no explicit twin covers
 * (the pools are deep and grow — a map that only knew the defaults would
 * strand a user mid-trip the first time rotation rolled something new), and
 * it supplies the alternates that keep one session from prescribing the same
 * movement twice.
 *
 * @type {Record<string, string[]>}
 */
export const TRAVEL_FALLBACK_BY_MUSCLE = {
  Quads:         ["Bulgarian Split Squat", "Step-Up", "Walking Lunge", "Reverse Lunge"],
  Glutes:        ["Single-Leg Hip Thrust", "Glute Bridge", "Single-Leg RDL"],
  Hamstrings:    ["Sliding Leg Curl", "Single-Leg RDL"],
  Calves:        ["Single-Leg Calf Raise"],
  Chest:         ["Deficit Push-Up", "Decline Push-Up", "Sliding Fly"],
  Lats:          ["Pull-Up", "Inverted Row"],
  "Upper Back":  ["Inverted Row", "Towel Face Pull"],
  Traps:         ["Backpack Shrug"],
  Erectors:      ["Single-Leg RDL"],
  "Front Delts": ["Pike Push-Up", "Decline Push-Up"],
  "Side Delts":  ["Bottle Lateral Raise"],
  "Rear Delts":  ["Towel Face Pull"],
  Biceps:        ["Backpack Curl", "Chin-Up"],
  Triceps:       ["Chair Dip", "Bodyweight Skullcrusher", "Diamond Push-Up"],
  Forearms:      ["Bar Hang"],
  Core:          ["Hollow Body Hold", "Plank"],
};

// Bodyweight stimulus arrives later in a set than barbell stimulus, so the
// rep target moves with the slot's job rather than staying put. Multiplier
// then clamp: heavy singles-to-fives become a hard 6–10, accessories land
// 10–15, finishers run 12–25. RPE capture is unchanged — the numeric slider
// still means what it means at bodyweight.
const REP_RULES = {
  main:      { scale: 2,    min: 6,  max: 12 },
  superset:  { scale: 1.3,  min: 10, max: 15 },
  finisher:  { scale: 1.25, min: 12, max: 25 },
};

/**
 * Translate a rep prescription, preserving its written shape. Numbers scale;
 * "8/leg" keeps its suffix; timed holds ("20s") pass through — a plank is
 * already a bodyweight prescription and doesn't want inflating.
 *
 * @param {number|string} reps
 * @param {"main"|"superset"|"finisher"|string} blockType
 * @returns {number|string}
 */
export function travelReps(reps, blockType) {
  const rule = REP_RULES[blockType] || REP_RULES.superset;
  const bend = (n) => Math.min(rule.max, Math.max(rule.min, Math.round(n * rule.scale)));

  if (typeof reps === "number" && Number.isFinite(reps)) return bend(reps);
  if (typeof reps !== "string") return reps;
  if (/^\s*\d+(\.\d+)?\s*s\s*$/i.test(reps)) return reps;      // timed hold — leave it
  const m = reps.match(/^\s*(\d+)(\D.*)$/);                     // "8/leg", "10 each"
  if (m) return `${bend(Number(m[1]))}${m[2]}`;
  const plain = Number(reps);
  return Number.isFinite(plain) ? bend(plain) : reps;
}

/**
 * Where MUSCLE alone is ambiguous, the movement PATTERN decides. A barbell
 * row and a lat pulldown are both Lats-primary, but they travel differently:
 * one becomes a table row, the other stays on the bar. Without this layer a
 * rotated row slot converted to a Pull-Up — same muscle, wrong plane, and the
 * session quietly lost its horizontal pull.
 *
 * Consulted after the curated twins and before the muscle fallback, so it
 * only ever decides cases nobody has hand-mapped.
 *
 * @type {Array<[RegExp, string]>}
 */
const TRAVEL_PATTERNS = [
  [/pulldown|pull-?up|chin-?up|pullover/i, "Pull-Up"],
  [/\brow\b/i,                             "Inverted Row"],
  [/\bfly\b|crossover|pec deck/i,          "Sliding Fly"],
  [/shrug/i,                               "Backpack Shrug"],
  [/calf/i,                                "Single-Leg Calf Raise"],
  [/curl/i,                                "Backpack Curl"],
  [/pushdown|skullcrusher|tricep/i,        "Chair Dip"],
];

const patternTwin = (name) => TRAVEL_PATTERNS.find(([re]) => re.test(name))?.[1] || null;

/**
 * The travel twin NAME for one resolved exercise, or null when the movement
 * already travels. Resolution order: native (pass through) → explicit twin →
 * movement pattern → first alternate for the anatomy primary.
 *
 * `claimed` holds the names already prescribed in this session. When the
 * preferred twin is taken, the muscle's remaining alternates are tried in
 * order — training the same movement twice in one session is the exact
 * defect the rotation dedupe exists to prevent, and a fallback map is just
 * as capable of causing it. If every alternate is claimed, the preferred one
 * is returned anyway: a repeat beats an empty slot.
 *
 * @param {{name?: string}|null|undefined} ex
 * @param {Set<string>} [claimed]
 * @returns {string|null}
 */
export function travelTwin(ex, claimed = new Set()) {
  const name = ex?.name;
  if (!name) return null;
  if (TRAVEL_NATIVE.has(name)) return null;

  const primary = getAnatomy(name)?.primary;
  const alternates = (primary && TRAVEL_FALLBACK_BY_MUSCLE[primary]) || [];
  const preferred = TRAVEL_TWINS[name] || patternTwin(name) || alternates[0] || null;
  if (!preferred) return null;
  if (!claimed.has(preferred)) return preferred;
  return alternates.find((alt) => !claimed.has(alt)) || preferred;
}

/**
 * Convert one exercise in place within its slot. Bodyweight throughout, so
 * `weight` is cleared and the drum's load semantics follow `loadType`.
 * `travelFrom` records what the slot was, so the session card can say what
 * it is standing in for rather than silently swapping the workout.
 */
function convert(ex, blockType, claimed) {
  if (!ex) return ex;
  const reps = travelReps(ex.reps, blockType);
  const twinName = travelTwin(ex, claimed);
  if (!twinName) {
    // A native movement keeps its NAME, never its LOAD. Bulgarian Split Squat
    // is prescribed at 18kg of dumbbell in the gym; in a hotel room it is the
    // same movement with a backpack at most, so the gym's number would be a
    // prescription the user cannot fill.
    if (ex.name) claimed.add(ex.name);
    const native = TRAVEL_MOVES[ex.name];
    return {
      ...ex,
      reps,
      weight: null,
      loadType: "bodyweight",
      kit: native?.kit ?? null,
      travel: true,
    };
  }
  claimed.add(twinName);
  const move = TRAVEL_MOVES[twinName] || { muscle: ex.muscle, kit: null };
  return {
    ...ex,
    name: twinName,
    muscle: move.muscle,
    kit: move.kit,
    reps,
    weight: null,
    loadType: "bodyweight",
    vid: null,               // no demo footage for the travel set yet
    travel: true,
    travelFrom: ex.name,
  };
}

/**
 * Derive the travel version of an already-resolved session.
 *
 * Slots in AFTER rotation/swaps/focus and BEFORE readiness scaling: focus has
 * finished choosing what the session is, and a cooked day should still drop
 * its finisher whether or not you are in a hotel. Pure — originals untouched.
 *
 * @template {{blocks?: Array<any>}} S
 * @param {S} session
 * @returns {S}
 */
export function deriveTravelSession(session) {
  if (!session?.blocks) return session;
  // Claims accumulate across the whole session, in block order, so an earlier
  // slot's twin is visible to every later one.
  const claimed = new Set();
  return {
    ...session,
    travel: true,
    blocks: session.blocks.map((b) => ({
      ...b,
      ex:  convert(b.ex,  b.type, claimed),
      exA: convert(b.exA, b.type, claimed),
      exB: convert(b.exB, b.type, claimed),
    })),
  };
}
