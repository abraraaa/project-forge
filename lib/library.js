// @ts-check
// lib/library.js
// ─────────────────────────────────────────────────────────────────────────────
// The public exercise library (/library) — the last item of the organic-SEO
// pass. Pure catalogue builder: joins the three sources that already agree on
// exercise names (enforced by tests/exercise-library.test.js) into one
// render-ready entry per exercise:
//
//   EXERCISE_ANATOMY  (lib/exercise-anatomy.js)  → weighted muscle contributions
//   getLiftProfile    (lib/lift-translations.js) → progression category
//   SWAP_DB           (lib/programme.js)         → functional alternatives
//
// The weighted-contribution data is the differentiated content here — most
// exercise references say "squats train legs"; ours says exactly how much of
// each muscle's working volume a set counts for, with the same numbers the
// app's volume audit runs on. Pages are generated from THIS data so they can
// never drift from what Forge actually computes.
//
// Deliberately NOT surfaced: per-category RIR thresholds — whether exposing
// the engine's add-weight mechanism suits the product voice is a parked
// design call (docs/parked.md, "In-session RIR threshold hints").
// ─────────────────────────────────────────────────────────────────────────────

import { EXERCISE_ANATOMY } from "./exercise-anatomy.js";
import { getLiftProfile, STEP_SIZES } from "./lift-translations.js";
import { SWAP_DB } from "./programme.js";

// URL slug from an exercise name: lowercase, alphanumerics only, hyphens
// between runs. "Chest-Supported DB Row" → "chest-supported-db-row".
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Editorial copy per progression category — how Forge moves the exercise
// forward. kg steps come straight from STEP_SIZES so the text can never
// drift from the engine.
const CATEGORY_COPY = {
  lower_compound: {
    label: "Lower-body compound",
    progression: `Progresses by load: +${STEP_SIZES.lower_compound}kg the session after you earn it. The engine watches your reps and how hard the top set felt before adding.`,
  },
  upper_push: {
    label: "Upper-body push",
    progression: `Progresses by load: +${STEP_SIZES.upper_push}kg increments — upper-body pressing moves in smaller steps than squats and hinges because the muscles driving it are smaller.`,
  },
  upper_pull: {
    label: "Upper-body pull",
    progression: `Progresses by load: +${STEP_SIZES.upper_pull}kg increments, earned session by session from your rep quality.`,
  },
  power: {
    label: "Power movement",
    progression: `Progresses by load in +${STEP_SIZES.power}kg steps, but the bar has to move fast — power work is never ground out, so the engine is stricter about when it adds.`,
  },
  accessory_compound: {
    label: "Accessory compound",
    progression: `Progresses by load in +${STEP_SIZES.accessory_compound}kg steps. Accessories build the muscle that keeps the main lifts moving.`,
  },
  accessory_arm: {
    label: "Arm accessory",
    progression: `Progresses by load in +${STEP_SIZES.accessory_arm}kg steps — small muscles, small increments, long patience.`,
  },
  accessory_isolation: {
    label: "Isolation",
    progression: `Progresses by load in +${STEP_SIZES.accessory_isolation}kg steps. Isolation work is where the honest-volume ledger pays off — compounds alone don't cover it.`,
  },
  bw_progression: {
    label: "Bodyweight progression",
    progression: "Progresses by reps, not weight — you earn harder sets, longer holds, or extra reps rather than plates.",
  },
};

// One catalogue entry per hand-tuned anatomy exercise. EXERCISE_ANATOMY is
// the canonical set: it's the hand-curated data that makes these pages worth
// indexing (pattern-inferred anatomy would be thin content).
function buildLibrary() {
  const entries = Object.keys(EXERCISE_ANATOMY).map((name) => {
    const anatomy = EXERCISE_ANATOMY[name];
    const profile = getLiftProfile(name);
    const category = CATEGORY_COPY[profile.category] || CATEGORY_COPY.accessory_isolation;
    // Secondary contributions, heaviest first.
    const secondary = Object.entries(anatomy.secondary || {})
      .map(([muscle, weight]) => ({ muscle, weight }))
      .sort((a, b) => b.weight - a.weight);
    return {
      name,
      slug: slugify(name),
      primary: anatomy.primary,
      secondary,
      categoryLabel: category.label,
      progression: category.progression,
      progressesByLoad: profile.progressesByLoad !== false,
      swaps: (SWAP_DB[name] || []).map((s) => ({
        name: s.name,
        equipment: s.eq,
        // Internal link only where the target has its own page.
        slug: EXERCISE_ANATOMY[s.name] ? slugify(s.name) : null,
      })),
    };
  });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export const LIBRARY = buildLibrary();

const BY_SLUG = new Map(LIBRARY.map((e) => [e.slug, e]));

export function getExercise(slug) {
  return BY_SLUG.get(slug) || null;
}

// Index grouping: primary muscle → entries, ordered by group size so the
// deepest sections lead.
export function libraryByMuscle() {
  const groups = new Map();
  for (const e of LIBRARY) {
    if (!groups.has(e.primary)) groups.set(e.primary, []);
    groups.get(e.primary).push(e);
  }
  return Array.from(groups.entries())
    .map(([muscle, exercises]) => ({ muscle, exercises }))
    .sort((a, b) => b.exercises.length - a.exercises.length || a.muscle.localeCompare(b.muscle));
}

// Meta description for a single exercise page — built from the same data the
// page renders, capped for SERP display.
export function exerciseDescription(entry) {
  const secondaries = entry.secondary.slice(0, 2).map((s) => s.muscle.toLowerCase());
  const trains = secondaries.length
    ? `${entry.primary} first, then ${secondaries.join(" and ")}`
    : `${entry.primary}, focused and direct`;
  return `${entry.name}: what it actually trains — ${trains} — with the honest per-muscle volume weights Forge computes with.`;
}
