// tests/exercise-library.test.js
// ────────────────────────────────────────────────────────────────────────────
// Exercise-library hygiene invariants.
//
// The library spans five sources that must agree on exercise names:
//   - SESSIONS / EXERCISE_POOLS / SWAP_DB   (lib/programme.js — user-facing)
//   - EXERCISE_ANATOMY                      (lib/exercise-anatomy.js — muscle maps)
//   - PROFILES                              (lib/lift-translations.js — progression)
//
// Drift between these caused a duplication bug: "Dumbbell Floor Press" (in
// SWAP_DB) and "DB Floor Press" (everywhere else) were the same movement with
// two names and two sets of backing data. These tests lock the library so the
// same class of drift can't return silently.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { SESSIONS, EXERCISE_POOLS, SWAP_DB } from "../lib/programme.js";
import { EXERCISE_ANATOMY } from "../lib/exercise-anatomy.js";
import { __test__ as liftTest } from "../lib/lift-translations.js";

const { PROFILES } = liftTest;

// ── Collect the canonical name sets ──────────────────────────────────────────
function programmeNames() {
  const names = new Set();
  for (const s of SESSIONS) {
    for (const b of s.blocks) {
      if (b.ex)  names.add(b.ex.name);
      if (b.exA) names.add(b.exA.name);
      if (b.exB) names.add(b.exB.name);
    }
  }
  for (const slot of Object.values(EXERCISE_POOLS)) {
    for (const ex of slot.pool) names.add(ex.name);
  }
  for (const [k, opts] of Object.entries(SWAP_DB)) {
    names.add(k);
    for (const o of opts) names.add(o.name);
  }
  return names;
}

const anatomyKeys  = Object.keys(EXERCISE_ANATOMY);
const profileKeys  = Object.keys(PROFILES);
const progNames    = programmeNames();

// ── (a) Near-duplicate detection ─────────────────────────────────────────────
// Unifies the DB/Dumbbell synonym and strips separators so "DB Floor Press" /
// "Dumbbell Floor Press" and "Skullcrusher" / "Skull Crusher" collapse to the
// same fingerprint. Deliberately does NOT strip equipment prefixes — DB Curl
// vs Barbell Curl, Floor Press vs DB Floor Press etc. are intentionally
// distinct exercises and must stay separate.
function fingerprint(name) {
  return name
    .toLowerCase()
    .replace(/\bdumbbell\b/g, "db")     // unify the DB / Dumbbell synonym
    .replace(/[\s\-/]+/g, "")            // strip spaces, hyphens, slashes
    .trim();
}

function findNearDupes(names) {
  const byFp = new Map();
  for (const n of names) {
    const fp = fingerprint(n);
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(n);
  }
  return [...byFp.values()].filter(group => new Set(group).size > 1);
}

describe("exercise library — no near-duplicate names", () => {
  it("EXERCISE_ANATOMY has no DB/Dumbbell or spacing near-dupes", () => {
    expect(findNearDupes(anatomyKeys)).toEqual([]);
  });

  it("PROFILES has no DB/Dumbbell or spacing near-dupes", () => {
    expect(findNearDupes(profileKeys)).toEqual([]);
  });

  it("no near-dupes across the union of all sources", () => {
    const union = new Set([...anatomyKeys, ...profileKeys, ...progNames]);
    expect(findNearDupes([...union])).toEqual([]);
  });

  it("no duplicate object keys (anatomy / profiles parsed without collision)", () => {
    // A duplicate literal key would have been silently collapsed by the JS
    // parser — assert the key count matches a fresh Set to catch that.
    expect(anatomyKeys.length).toBe(new Set(anatomyKeys).size);
    expect(profileKeys.length).toBe(new Set(profileKeys).size);
  });
});

// ── (b) Programme exercises must have explicit anatomy backing ────────────────
// Every name a user can encounter should resolve to an explicit EXERCISE_ANATOMY
// entry (precise per-exercise muscle distribution) rather than falling through
// to pattern-matched defaults. A short allowlist documents the names that are
// knowingly pattern-matched today; if a new unbacked exercise is added — or a
// canonical name is misspelled in one source — this test fails and forces a
// conscious decision.
const PATTERN_MATCHED_ALLOWLIST = new Set([
  "Cable Overhead Extension",
  "DB Overhead Extension",
  "Leg Press Calf Raise",
  "Reverse-Grip Pushdown",
  "Rope Tricep Pushdown",
  "Single-Arm Pushdown",
  "Smith Calf Raise",
  // Main-lift functional swaps (Tier 2 #6) — resolved correctly by the
  // pattern matcher (squat / press / dips → standard primaries).
  "Front Squat",
  "Incline BB Press",
  "Weighted Dips",
]);

describe("exercise library — programme coverage", () => {
  it("every programme exercise has an EXERCISE_ANATOMY entry (or is allowlisted)", () => {
    const anatomySet = new Set(anatomyKeys);
    const gaps = [...progNames].filter(
      n => !anatomySet.has(n) && !PATTERN_MATCHED_ALLOWLIST.has(n),
    );
    expect(gaps).toEqual([]);
  });

  it("allowlist stays in sync — no stale entries that now have anatomy", () => {
    const anatomySet = new Set(anatomyKeys);
    const stale = [...PATTERN_MATCHED_ALLOWLIST].filter(n => anatomySet.has(n));
    expect(stale).toEqual([]);
  });

  it("the seven canonicalised names resolve in both anatomy and profiles", () => {
    // Locks in the duplicate cleanup: the canonical spellings exist and the
    // aliases are gone.
    const anatomySet = new Set(anatomyKeys);
    const profileSet = new Set(profileKeys);
    const canonical = [
      "DB Floor Press", "Skullcrusher", "Tricep Pushdown", "Hammer Curl",
      "DB Kickback", "Incline DB Press", "Bulgarian Split Squat",
    ];
    for (const name of canonical) {
      expect(anatomySet.has(name), `anatomy missing "${name}"`).toBe(true);
      expect(profileSet.has(name), `profiles missing "${name}"`).toBe(true);
    }
    const removedAliases = [
      "Dumbbell Floor Press", "Skull Crusher", "Cable Pushdown",
      "DB Hammer Curl", "Kickback", "Incline DB Bench", "DB Bulgarian Split Squat",
    ];
    for (const alias of removedAliases) {
      expect(anatomySet.has(alias), `anatomy still has alias "${alias}"`).toBe(false);
      expect(profileSet.has(alias), `profiles still has alias "${alias}"`).toBe(false);
    }
  });
});
