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
// design call (internal notes, "In-session RIR threshold hints").
// ─────────────────────────────────────────────────────────────────────────────

import { EXERCISE_ANATOMY } from "./exercise-anatomy.js";
import { getLiftProfile, STEP_SIZES } from "./lift-translations.js";
import { SWAP_DB, SESSIONS, EXERCISE_POOLS } from "./programme.js";
import { EXTRA_VIDEOS, DEAD_UNTIL_REPLACED } from "./exercise-videos.js";

/**
 * When the catalogue or the data behind it last changed — the sitemap's
 * lastmod for every library URL.
 *
 * A DELIBERATE constant rather than build time: a redeploy that changed no
 * exercise data would otherwise claim every one of the 168 pages was revised,
 * which is the freshness equivalent of keyword stuffing. Retrieval systems
 * weight recency, so the signal is only worth having if it's true.
 *
 * BUMP THIS when EXERCISE_ANATOMY, EXERCISE_TEMPO or SWAP_DB gain or change
 * entries. Last: 2026-08-12, 28 verified video replacements clearing the
 * remaining orphan list (lib/exercise-videos.js).
 */
export const LIBRARY_REVISED = "2026-08-12";

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

// name → YouTube id, harvested from everywhere the app already stores demo
// footage: the SESSIONS template, the rotation pools, and the swap lists.
// The ids existed all along — the library just never joined them (noticed by
// the boss 2026-08-05; an omission, not doctrine). First writer wins, with
// the template and pools ahead of swap alternatives: an exercise's own slot
// entry is its canonical demo.
function buildVideoIndex() {
  /** @type {Record<string, string>} */
  const vids = {};
  const claim = (name, vid) => {
    if (!name || vids[name]) return;
    if (DEAD_UNTIL_REPLACED.has(name) && !EXTRA_VIDEOS[name]) return;   // known-bad, no replacement yet
    if (typeof vid === "string" && /^[\w-]{11}$/.test(vid)) vids[name] = vid;
  };
  // Curated additions first — they exist precisely because no programme
  // entry can carry these names.
  for (const [name, vid] of Object.entries(EXTRA_VIDEOS)) claim(name, vid);
  for (const s of SESSIONS) {
    for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) claim(ex?.name, ex?.vid);
  }
  for (const slot of Object.values(EXERCISE_POOLS)) {
    for (const p of slot.pool || []) claim(p.name, p.vid);
  }
  for (const alts of Object.values(SWAP_DB)) {
    for (const a of alts) claim(a.name, a.vid);
  }
  return vids;
}
const VIDEO_INDEX = buildVideoIndex();

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
      vid: VIDEO_INDEX[name] || null,
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

// ─── Per-muscle view: every movement that trains it, ranked by how much ─────
// The library answers "what does this exercise train". This answers the
// question people actually ask — "what trains my rear delts, and what trains
// them MOST" — and it is the one question the literature cannot answer for
// you, because the answer lives in our weighted contribution table.
//
// Contribution is 1.0 for a primary and the anatomy weight for a secondary,
// which is exactly what the volume audit apportions. So the ranking a reader
// sees IS the ranking the engine credits.

export function muscleSlug(muscle) {
  return slugify(muscle);
}

// Every muscle any catalogued movement touches, primary or secondary.
export function allTrainedMuscles() {
  const seen = new Set();
  for (const e of LIBRARY) {
    seen.add(e.primary);
    for (const s of e.secondary) seen.add(s.muscle);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// Movements that train `muscle`, heaviest contribution first. Ties break on
// name so the order is stable between builds.
export function contributorsFor(muscle) {
  const out = [];
  for (const e of LIBRARY) {
    const share = e.primary === muscle
      ? 1
      : (e.secondary.find((s) => s.muscle === muscle)?.weight ?? 0);
    if (share > 0) out.push({ entry: e, share, isPrimary: e.primary === muscle });
  }
  return out.sort((a, b) => b.share - a.share || a.entry.name.localeCompare(b.entry.name));
}

export function getMuscleBySlug(slug) {
  return allTrainedMuscles().find((m) => muscleSlug(m) === slug) || null;
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
  return `${entry.name}: what it actually trains — ${trains} — with the honest per-muscle volume weights Heatwayve computes with.`;
}
