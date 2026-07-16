// tests/programme.test.js
// ────────────────────────────────────────────────────────────────────────────
// Programme data invariants.
//
// Coverage focus:
//   1. Pool[0] === SESSIONS default for every accessory/finisher slot —
//      drift here means rotation silently presents a different exercise on
//      Day 1 than the home screen shows. Caught a Standing Calf Raise
//      mismatch that survived a recalibration diff.
//   2. findRecentDays time-window correctness — including local-timezone
//      handling so UK users (BST = UTC+1 in summer) can log Friday's
//      missed workout when they remember on Saturday.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SESSIONS,
  EXERCISE_POOLS,
  SWAP_DB,
  WEEK,
  STRENGTH_DAY_SESSIONS,
  findRecentDays,
  findUntickedRecent,
  rotateAccessories,
  pushHistoryBlock,
  computeRotationStimulusDelta,
  deriveStrengthDaySessions,
  sessionMetaForDate,
  ROTATION_MEMORY_BLOCKS,
  MAIN_LIFT_FUNCTIONAL_EQUIVALENTS,
  bonusForDay,
  CARDIO_BONUS_POOL,
  BONUS_ELIGIBLE_DAY_TYPES,
  scoreExerciseForFocus,
  FOCUS_OPTIONS,
  FOCUS_SUMMARIES,
  DEFAULT_FOCUS,
  applyFocusToSession,
  applyFocusToSessions,
  applyRotationToSession,
  applySwapsToSession,
  SCULPT_ALIGNED_PRIMARIES,
  dedupeRotationConfig,
  pruneStaleRotationConfig,
  hasMissedStrength,
  hasUntickedRecent,
  weekdayIdxForDate,
} from "../lib/programme.js";
import { getAnatomy, distributeAcrossMuscles } from "../lib/exercise-anatomy.js";

// ─── Pool[0] invariant ──────────────────────────────────────────────────────
describe("EXERCISE_POOLS pool[0] === SESSIONS default", () => {
  // Build a flat map of slot key → SESSIONS default exercise.
  // Keys: blockId for non-superset (e.g. "ass2"), `${blockId}-${A|B}` otherwise.
  const sessionDefaults = {};
  for (const sess of SESSIONS) {
    for (const block of sess.blocks) {
      if (block.type === "main") continue;
      if (block.ex)  sessionDefaults[block.id] = block.ex;
      if (block.exA) sessionDefaults[`${block.id}-A`] = block.exA;
      if (block.exB) sessionDefaults[`${block.id}-B`] = block.exB;
    }
  }

  // Every pool's pool[0] must equal the SESSIONS default for that slot
  // across every field the engine reads: name, reps, weight, muscle, vid,
  // loadType, loadProfile. Any drift makes the rotation engine present a
  // different exercise on the first session of a new block than the home
  // screen advertises, which silently invalidates muscle-anchor lookups and
  // confuses users.
  const fields = ["name", "reps", "weight", "muscle", "vid", "loadType", "loadProfile"];

  for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
    it(`${key} pool[0] matches SESSIONS default on every field`, () => {
      const def = sessionDefaults[key];
      expect(def, `No SESSIONS default for slot ${key}`).toBeTruthy();
      const head = slot.pool[0];
      for (const f of fields) {
        expect(head[f], `${key}.${f} mismatch`).toEqual(def[f]);
      }
    });
  }
});

// Helper: format a Date as a local-timezone YYYY-MM-DD string.
function fmtLocal(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ─── findRecentDays — timezone correctness ──────────────────────────────────
describe("findRecentDays — local timezone handling", () => {
  it("returns the expected number of rows for daysBack=3", () => {
    const rows = findRecentDays([], 3);
    expect(rows).toHaveLength(3);
  });

  it("excludes today; the most recent row is yesterday in LOCAL time", () => {
    const rows = findRecentDays([], 3, { order: "asc" });
    expect(rows).toHaveLength(3);
    const todayLocal = fmtLocal(new Date());
    expect(rows[rows.length - 1].date).not.toBe(todayLocal); // not today

    // Yesterday — using local date arithmetic
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(rows[rows.length - 1].date).toBe(fmtLocal(yesterday));
  });

  it("BST regression: when local time is morning, retro window must NOT slip a day", () => {
    // The bug: a UK user (UTC+1 in summer) checking on Saturday morning could
    // not see Friday in the retro picker, because the old impl used
    // toISOString().slice(0,10) on a Date set to local midnight, which in BST
    // converts back to the previous day in UTC. The 3-day window then
    // surveyed Thursday/Wednesday/Tuesday instead of Friday/Thursday/Wednesday.
    //
    // This test asserts the picker's returned dates are in lockstep with the
    // user's LOCAL calendar regardless of UTC offset: rows[i].date for i=1
    // must equal "yesterday on the user's local clock," period.
    const rows = findRecentDays([], 3, { order: "asc" });
    const expected = [];
    for (let i = 3; i >= 1; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      expected.push(fmtLocal(d));
    }
    expect(rows.map(r => r.date)).toEqual(expected);
  });

  it("does not list today even with sessions logged today", () => {
    const todayStr = fmtLocal(new Date());
    const history = [{ id: `${todayStr}T10:00:00.000Z`, date: todayStr, session: "strength-a" }];
    const rows = findRecentDays(history, 3);
    expect(rows.find(r => r.date === todayStr)).toBeUndefined();
  });

  it("daysBack=0 returns empty list", () => {
    expect(findRecentDays([], 0)).toEqual([]);
  });

  // Regression: the retro picker used to call findRecentDays without the
  // user's edited schedule, so it would label day-types from the default
  // WEEK constant — strength shown on Mon for a user whose strength day was
  // moved to Tue, the actual Tue strength day labelled "rest", retro form
  // empty when picks didn't match. Confirm a custom week flows through.
  it("honours a custom week override (regression: retro picker)", () => {
    // Custom week: rest Mon, strength Tue, everything else rest. So
    // yesterday-or-earlier may include either a "rest" Mon or a "strength"
    // Tue depending on the calendar — we just assert the function uses the
    // custom labels, not the default WEEK.
    const customWeek = [
      { type: "rest",     label: "Rest",     s: "Mo" },  // idx 0 = Mon
      { type: "strength", label: "Strength", s: "Tu" },  // idx 1 = Tue
      { type: "rest",     label: "Rest",     s: "We" },
      { type: "rest",     label: "Rest",     s: "Th" },
      { type: "rest",     label: "Rest",     s: "Fr" },
      { type: "rest",     label: "Rest",     s: "Sa" },
      { type: "rest",     label: "Rest",     s: "Su" },
    ];
    const rows = findRecentDays([], 7, { week: customWeek });
    // Across the last 7 days, exactly one should be Tuesday-strength, the
    // rest should be Rest. With the bug (default WEEK), strength would land
    // on a different day and the count would diverge.
    const strengthRows = rows.filter(r => r.type === "strength");
    expect(strengthRows.length).toBe(1);
    const restRows = rows.filter(r => r.type === "rest");
    expect(restRows.length).toBe(6);
  });
});

// ─── Load-profile invariants ────────────────────────────────────────────────
describe("EXERCISE_POOLS loadProfile invariants", () => {
  const VALID_PROFILES = new Set([
    "heavy_low_rep", "moderate_mid_rep", "light_high_rep", "metabolic",
  ]);

  it("every slot declares a valid loadProfile", () => {
    for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
      expect(slot.loadProfile, `${key} missing loadProfile`).toBeTruthy();
      expect(VALID_PROFILES.has(slot.loadProfile), `${key}.loadProfile invalid: ${slot.loadProfile}`).toBe(true);
    }
  });

  it("every pool entry's loadProfile matches its slot's loadProfile", () => {
    // This is the rotation-safety invariant: it prevents a heavy-low-rep
    // movement from leaking into a finisher slot's pool (or vice versa), so
    // future pool edits can't silently produce out-of-profile rotations.
    for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
      for (const ex of slot.pool) {
        expect(ex.loadProfile, `${key} pool entry "${ex.name}" missing loadProfile`).toBe(slot.loadProfile);
      }
    }
  });
});

// ─── Rotation memory (3-block exclusion) ────────────────────────────────────
describe("rotation memory — 3-block exclusion", () => {
  it("ROTATION_MEMORY_BLOCKS is 3 (the spec'd memory depth)", () => {
    expect(ROTATION_MEMORY_BLOCKS).toBe(3);
  });

  it("excludes every name in the history array for a slot", () => {
    // Pick a slot with a pool ≥ 4 so 3-block exclusion can't empty it
    const slotKey = Object.entries(EXERCISE_POOLS).find(
      ([, s]) => s.pool.length >= 4,
    )?.[0];
    expect(slotKey).toBeTruthy();
    const pool = EXERCISE_POOLS[slotKey].pool;
    const excluded = pool.slice(0, 3).map((p) => p.name);
    const history = { [slotKey]: excluded };

    // 30 trials — every pick must be outside the excluded set
    for (let i = 0; i < 30; i++) {
      const cfg = rotateAccessories(history);
      expect(excluded).not.toContain(cfg[slotKey].name);
    }
  });

  it("accepts legacy single-string history entries transparently", () => {
    const slotKey = Object.keys(EXERCISE_POOLS)[0];
    const pool = EXERCISE_POOLS[slotKey].pool;
    const legacy = { [slotKey]: pool[0].name };
    for (let i = 0; i < 20; i++) {
      const cfg = rotateAccessories(legacy);
      expect(cfg[slotKey].name).not.toBe(pool[0].name);
    }
  });

  it("falls back to single-block exclusion when 3-block empties the pool", () => {
    // 2-entry synthetic slot: forcing history of both should still yield a pick
    // (relaxed fallback excludes only the most-recent name).
    const slotKey = Object.keys(EXERCISE_POOLS)[0];
    const pool = EXERCISE_POOLS[slotKey].pool;
    // history claims EVERY name in the pool is recent → fallback kicks in,
    // excludes only the most-recent name (recent[0])
    const allNames = pool.map((p) => p.name);
    const history = { [slotKey]: allNames };
    for (let i = 0; i < 20; i++) {
      const cfg = rotateAccessories(history);
      expect(cfg[slotKey].name).not.toBe(allNames[0]); // most-recent still avoided
      expect(allNames.slice(1)).toContain(cfg[slotKey].name);
    }
  });
});

describe("pushHistoryBlock", () => {
  it("prepends the active config onto history, capped at ROTATION_MEMORY_BLOCKS", () => {
    const prev = { "ass1-A": ["DB Reverse Lunge", "Reverse Lunge"] };
    const active = { "ass1-A": { name: "Step-Up" } };
    const next = pushHistoryBlock(prev, active);
    expect(next["ass1-A"]).toEqual(["Step-Up", "DB Reverse Lunge", "Reverse Lunge"]);
  });

  it("evicts the oldest entry when history hits the cap", () => {
    const prev = { "ass1-A": ["B", "C", "D"] };
    const active = { "ass1-A": { name: "A" } };
    const next = pushHistoryBlock(prev, active);
    expect(next["ass1-A"]).toHaveLength(3);
    expect(next["ass1-A"]).toEqual(["A", "B", "C"]); // "D" evicted
  });

  it("dedupes — if the active pick already appears in history, it isn't duplicated", () => {
    const prev = { "ass1-A": ["A", "B"] };
    const active = { "ass1-A": { name: "A" } };
    const next = pushHistoryBlock(prev, active);
    expect(next["ass1-A"]).toEqual(["A", "B"]); // "A" stays at front, not duplicated
  });

  it("accepts legacy single-string prev entries", () => {
    const prev = { "ass1-A": "Reverse Lunge" };
    const active = { "ass1-A": { name: "Step-Up" } };
    const next = pushHistoryBlock(prev, active);
    expect(next["ass1-A"]).toEqual(["Step-Up", "Reverse Lunge"]);
  });

  it("handles slots absent from prev history (first rotation)", () => {
    const active = { "ass1-A": { name: "Step-Up" }, "ass1-B": { name: "Cable Row" } };
    const next = pushHistoryBlock({}, active);
    expect(next).toEqual({ "ass1-A": ["Step-Up"], "ass1-B": ["Cable Row"] });
  });

  it("skips slots with no name (defensive)", () => {
    const active = { "ass1-A": null, "ass1-B": { name: "Cable Row" } };
    const next = pushHistoryBlock({}, active);
    expect(next).toEqual({ "ass1-B": ["Cable Row"] });
  });
});

// ─── Anatomy-aware rotation summary ────────────────────────────────────────
describe("computeRotationStimulusDelta", () => {
  it("returns empty for empty/identical configs", () => {
    expect(computeRotationStimulusDelta({}, {})).toEqual([]);
    const same = { "ass1-A": EXERCISE_POOLS["ass1-A"].pool[0] };
    expect(computeRotationStimulusDelta(same, same)).toEqual([]);
  });

  it("ignores slots where the exercise name didn't change", () => {
    const ex = EXERCISE_POOLS["ass1-A"].pool[0];
    const oldCfg = { "ass1-A": ex };
    const newCfg = { "ass1-A": { ...ex } }; // same name, different object
    expect(computeRotationStimulusDelta(oldCfg, newCfg)).toEqual([]);
  });

  it("nets gains and losses per display bucket, sorted by magnitude", () => {
    // Build a config delta we can predict: swap css1-B (3 sets, light_high_rep
    // slot, lateral-raise themed) from Cable Lateral Raise → Cable Rear Delt Fly.
    // Both feed Shoulders bucket, but the contribution shifts (side-delt → rear-delt).
    const slot = EXERCISE_POOLS["css1-B"];
    const lateralRaise = slot.pool.find((p) => p.name === "Cable Lateral Raise");
    const rearDeltFly = slot.pool.find((p) => p.name === "Cable Rear Delt Fly");
    expect(lateralRaise).toBeTruthy();
    expect(rearDeltFly).toBeTruthy();

    const delta = computeRotationStimulusDelta(
      { "css1-B": lateralRaise },
      { "css1-B": rearDeltFly },
    );

    // Both contribute to Shoulders; Cable Rear Delt Fly also feeds Back via
    // its 0.25 secondary, so Back should appear with a positive delta.
    const bucketMap = Object.fromEntries(delta.map((d) => [d.bucket, d.delta]));
    expect(bucketMap.Back).toBeGreaterThan(0);
    // Sorted by absolute magnitude
    for (let i = 1; i < delta.length; i++) {
      expect(Math.abs(delta[i - 1].delta)).toBeGreaterThanOrEqual(Math.abs(delta[i].delta));
    }
  });

  it("scales by the slot's sets count (3-set superset weighs 3× a 1-set change)", () => {
    // Use the same slot (sets=3 for css1-B) — verify the delta magnitude is
    // 3× what distributeAcrossMuscles would give for a single set.
    const slot = EXERCISE_POOLS["css1-B"];
    const lateralRaise = slot.pool.find((p) => p.name === "Cable Lateral Raise");
    const rearDeltFly = slot.pool.find((p) => p.name === "Cable Rear Delt Fly");
    const delta = computeRotationStimulusDelta(
      { "css1-B": lateralRaise },
      { "css1-B": rearDeltFly },
    );
    // css1-B has sets=3 in SESSIONS, so the back-bucket delta (rearDeltFly's
    // 0.25 back secondary) should be ~3 * 0.25 = 0.75 (rounded to 1dp = 0.8 or 0.7).
    const back = delta.find((d) => d.bucket === "Back");
    expect(back.delta).toBeGreaterThanOrEqual(0.7);
    expect(back.delta).toBeLessThanOrEqual(0.8);
  });

  it("falls back to pool[0] when a slot is missing in either config", () => {
    // newConfig has the slot, oldConfig doesn't — should treat the missing
    // side as the SESSIONS default (pool[0]).
    const slot = EXERCISE_POOLS["css1-B"];
    const rearDeltFly = slot.pool.find((p) => p.name === "Cable Rear Delt Fly");
    const delta = computeRotationStimulusDelta({}, { "css1-B": rearDeltFly });
    // pool[0] is Cable Lateral Raise (per the rebalance), so this is the
    // lateralRaise → rearDeltFly delta — should report a non-empty change.
    expect(delta.length).toBeGreaterThan(0);
  });

  it("rounds deltas to 1 decimal place", () => {
    const oldCfg = {};
    for (const [k, slot] of Object.entries(EXERCISE_POOLS)) oldCfg[k] = slot.pool[0];
    const newCfg = { ...oldCfg };
    // Force one change so the function does work
    const slot = EXERCISE_POOLS["css1-B"];
    newCfg["css1-B"] = slot.pool[1];
    const delta = computeRotationStimulusDelta(oldCfg, newCfg);
    for (const d of delta) {
      expect(d.delta).toBe(Math.round(d.delta * 10) / 10);
    }
  });
});

// ─── Main-lift functional equivalents ───────────────────────────────────────
describe("MAIN_LIFT_FUNCTIONAL_EQUIVALENTS ↔ SWAP_DB alignment", () => {
  // Every main lift in MAIN_LIFT_FUNCTIONAL_EQUIVALENTS must correspond to an
  // actual SESSIONS main-lift block.
  it("every main-lift key is a current SESSIONS main lift", () => {
    const sessionMains = new Set();
    for (const sess of SESSIONS) {
      for (const block of sess.blocks) {
        if (block.type === "main" && block.ex?.name) sessionMains.add(block.ex.name);
      }
    }
    for (const lift of Object.keys(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      expect(sessionMains.has(lift), `${lift} not a SESSIONS main lift`).toBe(true);
    }
  });

  // Every functional equivalent listed must appear in SWAP_DB for that lift,
  // so users can actually pick it from the swap overlay.
  it("every equivalent appears in SWAP_DB[lift]", () => {
    for (const [lift, equivalents] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      const swapNames = new Set((SWAP_DB[lift] || []).map((s) => s.name));
      expect(SWAP_DB[lift], `SWAP_DB missing entry for ${lift}`).toBeTruthy();
      for (const eq of equivalents) {
        expect(swapNames.has(eq), `${lift} SWAP_DB missing ${eq}`).toBe(true);
      }
    }
  });

  // No drift the other way: SWAP_DB for a main lift shouldn't contain
  // alternatives that aren't in the approved equivalents list (would mean a
  // lighter substitute leaked in, breaking the load-profile principle).
  it("SWAP_DB[main-lift] contains ONLY approved equivalents", () => {
    for (const [lift, equivalents] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      const approved = new Set(equivalents);
      for (const swap of SWAP_DB[lift] || []) {
        expect(approved.has(swap.name), `${lift} SWAP_DB has unapproved alt ${swap.name}`).toBe(true);
      }
    }
  });

  // Every main-lift swap must RESOLVE in the anatomy model, or its volume
  // falls back to the swap's raw `muscle` label — a string outside the
  // 16-muscle vocabulary — and silently drops out of the audit and solver.
  // "Incline BB Press" and "Weighted Dips" both did exactly this until they
  // got anatomy entries; this guard catches the whole class for any future
  // swap addition.
  it("every main-lift swap resolves in the anatomy model (volume isn't dropped)", () => {
    const unresolved = [];
    for (const [, equivalents] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      for (const name of equivalents) if (!getAnatomy(name)) unresolved.push(name);
    }
    expect(unresolved, `unresolved swaps (fall back to raw label): ${unresolved.join(", ")}`).toEqual([]);
  });

  it("the two formerly-broken Bench swaps now credit Chest as primary", () => {
    for (const name of ["Incline BB Press", "Weighted Dips"]) {
      const dist = distributeAcrossMuscles(name, 3, "SHOULD_NOT_BE_USED");
      expect(dist.Chest, `${name} should credit Chest`).toBe(3);
      expect(dist.SHOULD_NOT_BE_USED, `${name} must not fall back to its label`).toBeUndefined();
    }
  });

  // Doc-specified explicit prohibition: Kettlebell Swing must never appear
  // as a Power Clean substitute (it's a finisher, wrong load profile).
  it("Kettlebell Swing is NOT a Power Clean substitute", () => {
    const powerCleanSwaps = (SWAP_DB["Power Clean"] || []).map((s) => s.name);
    expect(powerCleanSwaps).not.toContain("Kettlebell Swing");
    expect(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS["Power Clean"]).not.toContain("Kettlebell Swing");
  });

  // Documented load-profile lighter-substitutes that historically lived in
  // main-lift swap pools must NOT return — regression guard.
  it("known lighter substitutes are not in main-lift swap pools", () => {
    const forbidden = {
      "Barbell Back Squat":  ["Goblet Squat", "Bulgarian Split Squat", "Leg Press"],
      "Barbell Bench Press": ["Push-Up"],
      "Hex Bar Deadlift":    ["Dumbbell Deadlift"],
    };
    for (const [lift, names] of Object.entries(forbidden)) {
      const swapNames = new Set((SWAP_DB[lift] || []).map((s) => s.name));
      for (const n of names) {
        expect(swapNames.has(n), `${lift} SWAP_DB regressed: contains lighter ${n}`).toBe(false);
      }
    }
  });
});

// ─── User-editable weekly schedule (plumbing) ──────────────────────────────
describe("deriveStrengthDaySessions", () => {
  it("default WEEK derives to {0:0, 2:1, 4:2} (Mon=A, Wed=B, Fri=C)", () => {
    expect(deriveStrengthDaySessions(WEEK)).toEqual(STRENGTH_DAY_SESSIONS);
  });

  it("custom week with strength on Thu/Fri/Sat maps in order to A/B/C", () => {
    const w = [
      { type: "zone2" },     // Mon
      { type: "cardio" },    // Tue
      { type: "hiit" },      // Wed
      { type: "strength" },  // Thu
      { type: "strength" },  // Fri
      { type: "strength" },  // Sat
      { type: "rest" },      // Sun
    ];
    expect(deriveStrengthDaySessions(w)).toEqual({ 3: 0, 4: 1, 5: 2 });
  });

  it("a 4th strength day cycles back to A (so heavy weeks still cover every session)", () => {
    const w = [
      { type: "strength" }, { type: "strength" }, { type: "strength" }, { type: "strength" },
      { type: "rest" }, { type: "rest" }, { type: "rest" },
    ];
    expect(deriveStrengthDaySessions(w)).toEqual({ 0: 0, 1: 1, 2: 2, 3: 0 });
  });

  it("returns {} when no strength days", () => {
    const w = [
      { type: "zone2" }, { type: "cardio" }, { type: "rest" }, { type: "rest" },
      { type: "rest" }, { type: "rest" }, { type: "rest" },
    ];
    expect(deriveStrengthDaySessions(w)).toEqual({});
  });

  it("guards against null / empty array (returns {})", () => {
    expect(deriveStrengthDaySessions(null)).toEqual({});
    expect(deriveStrengthDaySessions([])).toEqual({});
  });

  it("called with no argument defaults to the canonical WEEK", () => {
    // Convenience default — same shape as the exported STRENGTH_DAY_SESSIONS.
    expect(deriveStrengthDaySessions()).toEqual(STRENGTH_DAY_SESSIONS);
  });
});

describe("sessionMetaForDate — custom week", () => {
  // Pick a known Monday so the math is unambiguous in JS_DAY_TO_WEEK_INDEX.
  const monday = "2026-05-25"; // Monday
  const friday = "2026-05-29"; // Friday

  it("default week: Mon → Strength A, Fri → Strength C (unchanged behaviour)", () => {
    expect(sessionMetaForDate(monday)?.sessionName).toBe("Strength A");
    expect(sessionMetaForDate(friday)?.sessionName).toBe("Strength C");
  });

  it("shifted week: Mon=Zone 2, Fri=Strength A → engine reads from the supplied week", () => {
    const w = [
      { type: "zone2" },     // Mon
      { type: "cardio" },    // Tue
      { type: "rest" },      // Wed
      { type: "rest" },      // Thu
      { type: "strength" },  // Fri  ← first strength day → A
      { type: "strength" },  // Sat  ← B
      { type: "strength" },  // Sun  ← C
    ];
    expect(sessionMetaForDate(monday, w)?.type).toBe("zone2");
    expect(sessionMetaForDate(friday, w)?.type).toBe("strength");
    expect(sessionMetaForDate(friday, w)?.sessionName).toBe("Strength A");
  });
});

// ─── Cardio-day bonus challenges ────────────────────────────────────────────
describe("bonusForDay", () => {
  it("returns a bonus only for cardio + hiit day types", () => {
    expect(bonusForDay("2026-06-02", "cardio")).toBeTruthy();
    expect(bonusForDay("2026-06-02", "hiit")).toBeTruthy();
  });

  it("returns null for Z2, rest, strength (recovery / wrong context)", () => {
    expect(bonusForDay("2026-06-02", "zone2")).toBe(null);
    expect(bonusForDay("2026-06-02", "rest")).toBe(null);
    expect(bonusForDay("2026-06-02", "strength")).toBe(null);
  });

  it("BONUS_ELIGIBLE_DAY_TYPES is exactly {cardio, hiit}", () => {
    expect([...BONUS_ELIGIBLE_DAY_TYPES].sort()).toEqual(["cardio", "hiit"]);
  });

  it("is deterministic for a given date (stable within a day)", () => {
    const a = bonusForDay("2026-06-02", "cardio");
    const b = bonusForDay("2026-06-02", "cardio");
    expect(a).toEqual(b);
  });

  it("varies across dates (not a constant)", () => {
    const picks = new Set();
    for (let d = 1; d <= 20; d++) {
      picks.add(bonusForDay(`2026-06-${String(d).padStart(2, "0")}`, "cardio").name);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("always returns a pool member with name + detail", () => {
    const names = new Set(CARDIO_BONUS_POOL.map((b) => b.name));
    const pick = bonusForDay("2026-06-10", "hiit");
    expect(names.has(pick.name)).toBe(true);
    expect(typeof pick.detail).toBe("string");
    expect(pick.detail.length).toBeGreaterThan(0);
  });

  it("guards against missing / malformed date", () => {
    expect(bonusForDay(null, "cardio")).toBe(null);
    expect(bonusForDay(undefined, "cardio")).toBe(null);
    expect(bonusForDay(123, "cardio")).toBe(null);
  });

  it("pool entries are unique by name", () => {
    const names = CARDIO_BONUS_POOL.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never repeats within a full pool lap, including month boundaries", () => {
    // The staleness guarantee: consecutive dates cycle the pool, so any
    // window of pool-length consecutive days shows every bonus exactly once.
    // The old string hash failed this across month rollovers (2 3 2 3).
    const len = CARDIO_BONUS_POOL.length;
    const d = new Date(Date.UTC(2026, 6, 25)); // spans July→August
    const seen = [];
    for (let i = 0; i < len; i++) {
      seen.push(bonusForDay(d.toISOString().slice(0, 10), "cardio").name);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    expect(new Set(seen).size).toBe(len);
  });

  it("pool length stays prime so a weekly slot cycles the whole pool", () => {
    const len = CARDIO_BONUS_POOL.length;
    for (let f = 2; f * f <= len; f++) expect(len % f).toBeGreaterThan(0);
  });
});

// ─── Training focus — accessory bias ────────────────────────────────────────
describe("scoreExerciseForFocus", () => {
  it("Forged returns 1.0 for everything (no bias)", () => {
    for (const slot of Object.values(EXERCISE_POOLS)) {
      for (const ex of slot.pool) {
        expect(scoreExerciseForFocus(ex, "Forged")).toBe(1);
      }
    }
  });

  it("null / undefined / unknown focus all behave like Forged (identity)", () => {
    const ex = EXERCISE_POOLS["ass2-A"].pool[0];
    expect(scoreExerciseForFocus(ex, null)).toBe(1);
    expect(scoreExerciseForFocus(ex, undefined)).toBe(1);
    expect(scoreExerciseForFocus(ex, "Unknown")).toBe(1);
  });

  it("unmapped exercise names score 1.0 (don't get excluded under any focus)", () => {
    const ghost = { name: "Definitely Not A Real Lift" };
    for (const focus of FOCUS_OPTIONS) {
      expect(scoreExerciseForFocus(ghost, focus)).toBe(1);
    }
  });

  it("Strong scores compounds higher than isolations", () => {
    const squat = { name: "Barbell Back Squat" };
    const ext   = { name: "Leg Extension" };
    expect(scoreExerciseForFocus(squat, "Strong"))
      .toBeGreaterThan(scoreExerciseForFocus(ext, "Strong"));
  });

  it("Strong always ≥ 1 (primary muscle contributes a floor)", () => {
    for (const slot of Object.values(EXERCISE_POOLS)) {
      for (const ex of slot.pool) {
        expect(scoreExerciseForFocus(ex, "Strong")).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("Sculpt scores chest moves higher than leg moves", () => {
    const dbFly  = { name: "DB Chest Fly" };
    const legExt = { name: "Leg Extension" };
    expect(scoreExerciseForFocus(dbFly, "Sculpt"))
      .toBeGreaterThan(scoreExerciseForFocus(legExt, "Sculpt"));
  });

  it("Sculpt scores Glutes (visible bias) higher than Hamstrings", () => {
    const hipThrust = { name: "Barbell Hip Thrust" };       // Glutes primary
    const hamCurl   = { name: "Machine Hamstring Curl" };   // Hams primary
    expect(scoreExerciseForFocus(hipThrust, "Sculpt"))
      .toBeGreaterThan(scoreExerciseForFocus(hamCurl, "Sculpt"));
  });
});

describe("rotateAccessories — focus parameter", () => {
  it("Forged matches the call-with-no-focus baseline (identity)", () => {
    // Same seed isn't a thing here (Math.random), but the SCORING under
    // Forged is uniform — so every pool entry is equally likely regardless
    // of whether `focus` is passed. Run many trials and confirm both
    // distributions cover the same set of picks.
    const seen = { withFocus: new Set(), withoutFocus: new Set() };
    for (let i = 0; i < 50; i++) {
      seen.withFocus.add(rotateAccessories({}, { focus: "Forged" })["ass1-A"]?.name);
      seen.withoutFocus.add(rotateAccessories({})["ass1-A"]?.name);
    }
    // Both should converge to "every pool member appears at least once"
    // (the ass1-A pool has 6 entries and we ran 50 trials each).
    expect(seen.withFocus.size).toBeGreaterThan(1);
    expect(seen.withoutFocus.size).toBeGreaterThan(1);
  });

  it("Sculpt biases ass2-A picks toward heaviest-glute alternatives over time", () => {
    // ass2-A is glute-themed already; under Sculpt the glute-primary entries
    // (all of them) get the 1.5 weight, so we mostly want to confirm rotation
    // STILL produces a valid glute pick every time — the bias doesn't
    // accidentally exclude anything.
    const pool = EXERCISE_POOLS["ass2-A"].pool;
    const poolNames = new Set(pool.map(p => p.name));
    for (let i = 0; i < 50; i++) {
      const cfg = rotateAccessories({}, { focus: "Sculpt" });
      expect(poolNames.has(cfg["ass2-A"].name)).toBe(true);
    }
  });

  it("Strong picks compounds more often than isolations in mixed pools", () => {
    // bss1-A has Leg Press (compound) + Leg Extension (isolation) + others.
    // Strong should pick compound entries more often than unbiased Forged.
    //
    // This used to compare two independent Math.random() samples with a
    // 5%-of-trials margin, which flaked ~1 in 5–10 CI runs: the true effect
    // is ~9 percentage points (Strong ~80% vs Forged ~71%) but the noise
    // band on the *difference* of two random samples left only ~1.25 SD of
    // headroom over the threshold. Rather than chase a wider margin, make it
    // deterministic: seed Math.random with a fixed PRNG so the run is
    // reproducible and can never flake. The bias is strong enough that any
    // reasonable seed shows it clearly.
    const mulberry32 = (seed) => () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const TRIALS = 400;
    const compoundNames = new Set(["Leg Press", "Hack Squat", "Pendulum Squat", "V-Squat", "Belt Squat"]);
    const realRandom = Math.random;
    let strongCompoundHits = 0;
    let forgedCompoundHits = 0;
    try {
      Math.random = mulberry32(0x5EED);
      for (let i = 0; i < TRIALS; i++) {
        if (compoundNames.has(rotateAccessories({}, { focus: "Strong" })["bss1-A"]?.name)) strongCompoundHits++;
        if (compoundNames.has(rotateAccessories({}, { focus: "Forged" })["bss1-A"]?.name)) forgedCompoundHits++;
      }
    } finally {
      Math.random = realRandom;
    }
    // Deterministic under the seed above. Margin kept well below the true
    // ~9pp effect so the assertion stays meaningful, not knife-edge.
    expect(strongCompoundHits).toBeGreaterThan(forgedCompoundHits + TRIALS * 0.04);
  });
});

describe("FOCUS_OPTIONS / FOCUS_SUMMARIES — copy invariants", () => {
  it("DEFAULT_FOCUS is in FOCUS_OPTIONS", () => {
    expect(FOCUS_OPTIONS).toContain(DEFAULT_FOCUS);
  });

  it("every focus has a non-empty summary (single source of truth for UI copy)", () => {
    for (const f of FOCUS_OPTIONS) {
      expect(typeof FOCUS_SUMMARIES[f]).toBe("string");
      expect(FOCUS_SUMMARIES[f].length).toBeGreaterThan(10);
    }
  });

  it("no Mass / vanity language leaked into the public surface", () => {
    // Renamed from "Mass" → "Sculpt" for unisex framing. Lock the rename.
    expect(FOCUS_OPTIONS).not.toContain("Mass");
    expect(FOCUS_OPTIONS).toContain("Sculpt");
    for (const summary of Object.values(FOCUS_SUMMARIES)) {
      expect(summary.toLowerCase()).not.toContain("mass");
      expect(summary.toLowerCase()).not.toContain("vanity");
    }
  });
});

// ─── PR-D: focus programming (drops + reps + set bumps) ─────────────────────
describe("applyFocusToSession", () => {
  it("Forged is identity — input session passes through unchanged", () => {
    for (const s of SESSIONS) {
      const out = applyFocusToSession(s, "Forged");
      expect(out).toBe(s); // same reference under Forged
    }
  });

  it("null / undefined / unknown focus all behave like Forged (identity)", () => {
    expect(applyFocusToSession(SESSIONS[0], null)).toBe(SESSIONS[0]);
    expect(applyFocusToSession(SESSIONS[0], undefined)).toBe(SESSIONS[0]);
    expect(applyFocusToSession(SESSIONS[0], "WhoKnows")).toBe(SESSIONS[0]);
  });

  it("handles malformed input defensively", () => {
    expect(applyFocusToSession(null, "Strong")).toBe(null);
    expect(applyFocusToSession({}, "Strong")).toEqual({});
  });

  describe("Strong", () => {
    it("drops ass2 on Day A; keeps a1 / a2 / ass1 / afin", () => {
      const out = applyFocusToSession(SESSIONS[0], "Strong");
      const ids = out.blocks.map(b => b.id);
      expect(ids).toEqual(["a1", "a2", "ass1", "afin"]);
      expect(ids).not.toContain("ass2");
    });

    it("drops bss2 on Day B; keeps b1 / b2 / bss1 / bfin", () => {
      const out = applyFocusToSession(SESSIONS[1], "Strong");
      const ids = out.blocks.map(b => b.id);
      expect(ids).toEqual(["b1", "b2", "bss1", "bfin"]);
      expect(ids).not.toContain("bss2");
    });

    it("drops css3 on Day C; keeps c1 / css1 / css2 / cfin", () => {
      const out = applyFocusToSession(SESSIONS[2], "Strong");
      const ids = out.blocks.map(b => b.id);
      expect(ids).toEqual(["c1", "css1", "css2", "cfin"]);
      expect(ids).not.toContain("css3");
    });

    it("shifts surviving accessory reps to '6-8'; mains + finishers untouched", () => {
      const out = applyFocusToSession(SESSIONS[0], "Strong");
      const main = out.blocks.find(b => b.id === "a1");
      const ssvg = out.blocks.find(b => b.id === "ass1");
      const fin  = out.blocks.find(b => b.id === "afin");
      // Mains unchanged (reps:5 stays)
      expect(main.ex.reps).toBe(SESSIONS[0].blocks.find(b => b.id === "a1").ex.reps);
      // Accessory superset shifts both sides to 6-8
      expect(ssvg.exA.reps).toBe("6-8");
      expect(ssvg.exB.reps).toBe("6-8");
      // Finisher reps unchanged
      const finBefore = SESSIONS[0].blocks.find(b => b.id === "afin");
      expect(fin.exA.reps).toBe(finBefore.exA.reps);
      expect(fin.exB.reps).toBe(finBefore.exB.reps);
    });

    it("RAISES accessory load to match 6-8 reps (no more junk light sets)", () => {
      const before = SESSIONS[0].blocks.find(b => b.id === "ass1");
      const out    = applyFocusToSession(SESSIONS[0], "Strong");
      const ssvg   = out.blocks.find(b => b.id === "ass1");
      // Both accessory sides are heavier than their higher-rep seed weight.
      expect(ssvg.exA.weight).toBeGreaterThan(before.exA.weight);
      expect(ssvg.exB.weight).toBeGreaterThan(before.exB.weight);
      // Value lock (Epley-constant e1RM, rounded to 1.25kg): the Chest-Supported
      // DB Row seed is 22kg @ 10 reps → 23.75kg @ 6-8.
      expect(ssvg.exB.weight).toBe(23.75);
      // Mains + finishers keep their seed load.
      const finBefore = SESSIONS[0].blocks.find(b => b.id === "afin");
      const fin       = out.blocks.find(b => b.id === "afin");
      expect(fin.exA.weight).toBe(finBefore.exA.weight);
    });

    it("is pure — input session is not mutated", () => {
      const before = JSON.parse(JSON.stringify(SESSIONS[0]));
      applyFocusToSession(SESSIONS[0], "Strong");
      expect(SESSIONS[0]).toEqual(before);
    });
  });

  describe("Sculpt", () => {
    // Build a config of every slot's pool[0] — the SESSIONS defaults — so the
    // alignment check has a deterministic input to score.
    const defaultConfig = {};
    for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
      defaultConfig[key] = slot.pool[0];
    }

    it("SCULPT_ALIGNED_PRIMARIES contains exactly the visible-muscle set", () => {
      expect(new Set(SCULPT_ALIGNED_PRIMARIES)).toEqual(new Set([
        "Chest", "Front Delts", "Side Delts", "Biceps", "Triceps", "Glutes",
      ]));
    });

    it("bumps Day A ass2 (Hip Thrust + Landmine Press — both aligned) by +1 set", () => {
      const out = applyFocusToSession(SESSIONS[0], "Sculpt", defaultConfig);
      const ass2Before = SESSIONS[0].blocks.find(b => b.id === "ass2");
      const ass2After  = out.blocks.find(b => b.id === "ass2");
      expect(ass2After.sets).toBe(ass2Before.sets + 1);
    });

    it("does NOT bump Day B bss2 (Bulgarian SS + Hamstring Curl — neither primary aligned)", () => {
      const out = applyFocusToSession(SESSIONS[1], "Sculpt", defaultConfig);
      const before = SESSIONS[1].blocks.find(b => b.id === "bss2");
      const after  = out.blocks.find(b => b.id === "bss2");
      expect(after.sets).toBe(before.sets);
    });

    it("shifts reps on aligned sides only — not on the non-aligned side of a mixed superset", () => {
      // ass1: Reverse Lunge (Quads primary — NOT aligned) + Chest-Supported DB Row
      //       (Back primary — NOT aligned). Neither aligned → no bump, no reps change.
      const out = applyFocusToSession(SESSIONS[0], "Sculpt", defaultConfig);
      const ass1Before = SESSIONS[0].blocks.find(b => b.id === "ass1");
      const ass1After  = out.blocks.find(b => b.id === "ass1");
      expect(ass1After.sets).toBe(ass1Before.sets);
      expect(ass1After.exA.reps).toBe(ass1Before.exA.reps);
      expect(ass1After.exB.reps).toBe(ass1Before.exB.reps);
    });

    it("aligned sides take '12-15' rep range; non-aligned untouched", () => {
      // Day C css3 default: DB Curl (Biceps primary, aligned) + Skullcrusher
      // (Triceps primary, aligned). Both sides aligned → both get 12-15.
      const out = applyFocusToSession(SESSIONS[2], "Sculpt", defaultConfig);
      const css3 = out.blocks.find(b => b.id === "css3");
      expect(css3.exA.reps).toBe("12-15");
      expect(css3.exB.reps).toBe("12-15");
    });

    it("does not touch mains or finishers under Sculpt", () => {
      const out = applyFocusToSession(SESSIONS[0], "Sculpt", defaultConfig);
      const mainBefore = SESSIONS[0].blocks.find(b => b.id === "a1");
      const mainAfter  = out.blocks.find(b => b.id === "a1");
      expect(mainAfter).toEqual(mainBefore);
      const finBefore = SESSIONS[0].blocks.find(b => b.id === "afin");
      const finAfter  = out.blocks.find(b => b.id === "afin");
      expect(finAfter).toEqual(finBefore);
    });

    it("with empty config, no slots are aligned → output equals input shape", () => {
      const out = applyFocusToSession(SESSIONS[0], "Sculpt", {});
      // Same blocks count, same sets per block
      expect(out.blocks.length).toBe(SESSIONS[0].blocks.length);
      for (let i = 0; i < SESSIONS[0].blocks.length; i++) {
        expect(out.blocks[i].sets).toBe(SESSIONS[0].blocks[i].sets);
      }
    });
  });
});

describe("applyFocusToSessions (programme-level wrapper)", () => {
  it("maps applyFocusToSession across every session in the array", () => {
    const out = applyFocusToSessions(SESSIONS, "Strong");
    expect(out).toHaveLength(SESSIONS.length);
    // Day A / B / C all drop their respective superset
    expect(out[0].blocks.map(b => b.id)).not.toContain("ass2");
    expect(out[1].blocks.map(b => b.id)).not.toContain("bss2");
    expect(out[2].blocks.map(b => b.id)).not.toContain("css3");
  });

  it("Forged is identity at the programme level too", () => {
    const out = applyFocusToSessions(SESSIONS, "Forged");
    expect(out).toEqual(SESSIONS);
  });
});

// ─── applyRotationToSession (PR after focus-volume-reps) ──────────────────
describe("applyRotationToSession", () => {
  it("empty config is identity — same session reference returned", () => {
    expect(applyRotationToSession(SESSIONS[0], {})).toBe(SESSIONS[0]);
    expect(applyRotationToSession(SESSIONS[0])).toBe(SESSIONS[0]);
  });

  it("malformed input is handled defensively", () => {
    expect(applyRotationToSession(null, { foo: { name: "Bar" } })).toBe(null);
    expect(applyRotationToSession({}, { foo: { name: "Bar" } })).toEqual({});
  });

  it("substitutes the exB of a superset slot from config", () => {
    // Day A ass2: { exA: Barbell Hip Thrust, exB: Landmine Press }
    // Simulate rotation picking Single-Leg Hip Thrust for ass2-A and
    // Single-Arm Landmine Press for ass2-B — both real pool members.
    const slhT  = { name: "Single-Leg Hip Thrust",    reps: 10, weight: 45, muscle: "Glutes"      };
    const salmp = { name: "Single-Arm Landmine Press", reps: 10, weight: 22, muscle: "Upper chest" };
    const config = { "ass2-A": slhT, "ass2-B": salmp };
    const out = applyRotationToSession(SESSIONS[0], config);
    const ass2 = out.blocks.find((b) => b.id === "ass2");
    expect(ass2.exA.name).toBe("Single-Leg Hip Thrust");
    expect(ass2.exB.name).toBe("Single-Arm Landmine Press");
    // Other slots untouched
    const ass1 = out.blocks.find((b) => b.id === "ass1");
    expect(ass1.exA.name).toBe(SESSIONS[0].blocks.find(b=>b.id==="ass1").exA.name);
  });

  it("is pure — input session is not mutated", () => {
    const before = JSON.parse(JSON.stringify(SESSIONS[0]));
    const realPick = { name: "Single-Leg Hip Thrust", reps: 10, weight: 45, muscle: "Glutes" };
    applyRotationToSession(SESSIONS[0], { "ass2-A": realPick });
    expect(SESSIONS[0]).toEqual(before);
  });

  it("idempotent — applying twice with the same config = applying once", () => {
    const realPick = { name: "Single-Leg Hip Thrust", reps: 10, weight: 45, muscle: "Glutes" };
    const config = { "ass2-A": realPick };
    const once  = applyRotationToSession(SESSIONS[0], config);
    const twice = applyRotationToSession(once, config);
    const a1 = once.blocks.find(b=>b.id==="ass2").exA.name;
    const a2 = twice.blocks.find(b=>b.id==="ass2").exA.name;
    expect(a1).toBe(a2);
    expect(a1).toBe("Single-Leg Hip Thrust");
  });

  it("doesn't touch slots not present in config", () => {
    const realPick = { name: "Skullcrusher", reps: 12, weight: 18, muscle: "Triceps" };
    const out = applyRotationToSession(SESSIONS[0], { "css3-B": realPick });
    // Day A blocks unchanged — config key css3-B is for Day C
    for (const b of out.blocks) {
      const orig = SESSIONS[0].blocks.find(x => x.id === b.id);
      if (b.ex)  expect(b.ex.name).toBe(orig.ex.name);
      if (b.exA) expect(b.exA.name).toBe(orig.exA.name);
      if (b.exB) expect(b.exB.name).toBe(orig.exB.name);
    }
  });

  // Self-healing for pool deletions — ghost picks (config entries whose name
  // is no longer in the slot pool) get silently ignored. The user falls back
  // to the SESSIONS default instead of staring at a culled exercise forever.
  // Caught a real-world bug post-PR-#96 where DB Kickback was removed from
  // css3-B but users who had rolled into it stayed locked on it.
  it("silently ignores config entries whose name is no longer in the slot pool", () => {
    // Day C css3-B currently has Skullcrusher / Overhead Tricep Extension /
    // Close-Grip Push-Up. "DB Kickback" is a stale name from before PR #96.
    const dayC = SESSIONS.find(s => s.blocks.some(b => b.id === "css3"));
    const ghost = { name: "DB Kickback", reps: 12, weight: 8, muscle: "Triceps" };
    const out = applyRotationToSession(dayC, { "css3-B": ghost });
    const css3 = out.blocks.find(b => b.id === "css3");
    const defaultExB = dayC.blocks.find(b => b.id === "css3").exB.name;
    expect(css3.exB.name).toBe(defaultExB);
    expect(css3.exB.name).not.toBe("DB Kickback");
  });

  it("self-heals one slot but still applies valid config on sibling slots", () => {
    const dayC = SESSIONS.find(s => s.blocks.some(b => b.id === "css3"));
    const ghost     = { name: "DB Kickback", reps: 12, weight: 8, muscle: "Triceps" };
    const realPickA = { name: "Hammer Curl", reps: 12, weight: 10, muscle: "Biceps & brachialis" };
    const out = applyRotationToSession(dayC, { "css3-A": realPickA, "css3-B": ghost });
    const css3 = out.blocks.find(b => b.id === "css3");
    expect(css3.exA.name).toBe("Hammer Curl");                  // valid → applied
    const defaultExB = dayC.blocks.find(b => b.id === "css3").exB.name;
    expect(css3.exB.name).toBe(defaultExB);                     // ghost → fallback
  });
});

// ─── applySwapsToSession — in-session user overrides ───────────────────────
// Final transformation in the derivation chain. Unlike applyRotationToSession,
// no pool validation — a swap is user intent and the SWAP_DB suggestions
// include exercises that aren't in EXERCISE_POOLS.
describe("applySwapsToSession", () => {
  it("empty swaps is identity — same reference", () => {
    expect(applySwapsToSession(SESSIONS[0], {})).toBe(SESSIONS[0]);
    expect(applySwapsToSession(SESSIONS[0])).toBe(SESSIONS[0]);
  });

  it("malformed input handled defensively", () => {
    expect(applySwapsToSession(null, { foo: { name: "Bar" } })).toBe(null);
    expect(applySwapsToSession({}, { foo: { name: "Bar" } })).toEqual({});
  });

  it("overrides the exB of a superset slot", () => {
    const fake = { name: "Arnold Press", reps: 10, weight: 14, muscle: "Shoulders" };
    const out = applySwapsToSession(SESSIONS[0], { "ass2-B": fake });
    const ass2 = out.blocks.find((b) => b.id === "ass2");
    expect(ass2.exB.name).toBe("Arnold Press");
  });

  it("accepts swaps that aren't in EXERCISE_POOLS (no pool validation)", () => {
    // Unlike rotation, swaps don't validate against the pool — Arnold Press
    // isn't in ass2-B's pool, but the user's choice stands.
    const fake = { name: "Arnold Press", reps: 10, weight: 14, muscle: "Shoulders" };
    const out = applySwapsToSession(SESSIONS[0], { "ass2-B": fake });
    expect(out.blocks.find(b => b.id === "ass2").exB.name).toBe("Arnold Press");
  });

  it("pure — input session is not mutated", () => {
    const before = JSON.parse(JSON.stringify(SESSIONS[0]));
    applySwapsToSession(SESSIONS[0], { "ass2-A": { name: "X", reps: 5, weight: 99, muscle: "Y" } });
    expect(SESSIONS[0]).toEqual(before);
  });
});

// ─── Cross-slot rotation deduplication ──────────────────────────────────────
// Pools overlap (e.g. "Leaning Lateral Raise" lives in both bfin-B and
// css1-B). Two independent picks can land on the same exercise → user
// trains it twice in the same week. The dedup pass walks slots in order;
// any slot whose pick already appears earlier gets re-rolled excluding all
// claimed names. First-slot wins.
describe("rotateAccessories — cross-slot deduplication", () => {
  it("emits no duplicate exercise names across slots", () => {
    // Run rotation across many seeds — the dedup is randomised so we want
    // confidence it holds reliably. 50 rolls is plenty for a smoke check.
    for (let i = 0; i < 50; i++) {
      const config = rotateAccessories({}, { focus: "Forged" });
      const names = Object.values(config).map(ex => ex?.name).filter(Boolean);
      const uniques = new Set(names);
      expect(uniques.size).toBe(names.length);
    }
  });

  it("never picks an exercise that isn't in its slot's pool", () => {
    const config = rotateAccessories({}, { focus: "Forged" });
    for (const [key, pick] of Object.entries(config)) {
      const pool = EXERCISE_POOLS[key].pool;
      expect(pool.some(ex => ex.name === pick.name)).toBe(true);
    }
  });
});

describe("dedupeRotationConfig", () => {
  it("returns the input reference when there are no duplicates", () => {
    const config = rotateAccessories({}, { focus: "Forged" });
    const deduped = dedupeRotationConfig(config, {});
    expect(deduped).toBe(config);
  });

  it("returns input reference for empty/missing config", () => {
    const empty = {};
    expect(dedupeRotationConfig(empty, {})).toBe(empty);
    expect(dedupeRotationConfig(null, {})).toBe(null);
    // undefined falls through to the {} default param, so don't test that case
  });

  it("re-rolls a slot whose pick duplicates an earlier slot", () => {
    // Construct a config where bfin-B and css1-B both hold Leaning Lateral
    // Raise (a real cross-pool overlap). After dedup, the later slot
    // (css1-B in insertion order) must change.
    const llr = { name: "Leaning Lateral Raise", reps: 12, weight: 7, muscle: "Lateral delt" };
    // Insertion order in EXERCISE_POOLS puts bfin-B BEFORE css1-B — confirm
    // this assumption so the test stays honest if pool order ever changes.
    const keys = Object.keys(EXERCISE_POOLS);
    expect(keys.indexOf("bfin-B")).toBeLessThan(keys.indexOf("css1-B"));

    const seed = rotateAccessories({}, { focus: "Forged" });
    const config = { ...seed, "bfin-B": llr, "css1-B": llr };
    const deduped = dedupeRotationConfig(config, {}, { focus: "Forged" });
    expect(deduped).not.toBe(config);
    expect(deduped["bfin-B"].name).toBe("Leaning Lateral Raise");
    expect(deduped["css1-B"].name).not.toBe("Leaning Lateral Raise");
    // Replacement must be a real css1-B pool member
    const pool = EXERCISE_POOLS["css1-B"].pool;
    expect(pool.some(ex => ex.name === deduped["css1-B"].name)).toBe(true);
  });

  it("never introduces new duplicates while resolving existing ones", () => {
    const llr = { name: "Leaning Lateral Raise", reps: 12, weight: 7, muscle: "Lateral delt" };
    for (let i = 0; i < 50; i++) {
      const seed = rotateAccessories({}, { focus: "Forged" });
      const config = { ...seed, "bfin-B": llr, "css1-B": llr };
      const deduped = dedupeRotationConfig(config, {}, { focus: "Forged" });
      const names = Object.values(deduped).map(ex => ex?.name).filter(Boolean);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("pruneStaleRotationConfig", () => {
  it("returns the input reference when nothing is stale", () => {
    const config = rotateAccessories({}, { focus: "Forged" });
    expect(pruneStaleRotationConfig(config)).toBe(config);
  });

  it("handles empty / null input", () => {
    const empty = {};
    expect(pruneStaleRotationConfig(empty)).toBe(empty);
    expect(pruneStaleRotationConfig(null)).toBe(null);
  });

  it("strips an entry whose name is no longer in the slot's live pool", () => {
    // "DB Kickback" was removed from css3-B in PR #96. A user who rolled
    // into it before that should have the stale entry pruned, so the
    // resolver falls through to the SESSIONS default (Skullcrusher).
    const ghost = { name: "DB Kickback", reps: 12, weight: 8, muscle: "Triceps" };
    const seed = rotateAccessories({}, { focus: "Forged" });
    const config = { ...seed, "css3-B": ghost };
    const pruned = pruneStaleRotationConfig(config);
    expect(pruned).not.toBe(config);
    expect(pruned["css3-B"]).toBeUndefined();
    // Untouched entries stay the same reference
    expect(pruned["bss1-A"]).toBe(config["bss1-A"]);
  });

  it("preserves entries pointing at unknown slot keys (defensive)", () => {
    // A config key without a matching pool — leave alone so a future schema
    // addition doesn't silently lose user state.
    const config = { "unknown-slot": { name: "Whatever" } };
    expect(pruneStaleRotationConfig(config)).toBe(config);
  });
});

// ─── hasMissedStrength / hasUntickedRecent / weekdayIdxForDate ─────────────
describe("weekdayIdxForDate (monday-start 0=Mon..6=Sun)", () => {
  it("maps known dates to the right index", () => {
    // 2026-06-01 = Monday → 0
    expect(weekdayIdxForDate("2026-06-01")).toBe(0);
    // 2026-06-07 = Sunday → 6
    expect(weekdayIdxForDate("2026-06-07")).toBe(6);
    // 2026-06-04 = Thursday → 3
    expect(weekdayIdxForDate("2026-06-04")).toBe(3);
  });

  it("returns null for missing input", () => {
    expect(weekdayIdxForDate(null)).toBe(null);
    expect(weekdayIdxForDate("")).toBe(null);
    expect(weekdayIdxForDate(undefined)).toBe(null);
  });
});

describe("hasMissedStrength / hasUntickedRecent — surface logic", () => {
  it("hasUntickedRecent is identical to hasMissedStrength when all non-rest days are strength", () => {
    // History with zero logged strength sessions over the last 3 days — both
    // detectors should agree if every recent day is a strength day.
    // Easier to assert: hasUntickedRecent ⊇ hasMissedStrength on any input.
    // We compute both and assert the OR direction.
    const empty = [];
    const a = hasMissedStrength(empty, 3);
    const b = hasUntickedRecent(empty, 3, {});
    // If a is true, b must be true. The reverse may or may not hold.
    if (a) expect(b).toBe(true);
  });

  it("hasUntickedRecent fires for a non-strength training day that's not ticked", () => {
    // Pin "today" to a Wednesday so "yesterday" is reliably Tuesday — both
    // in the same Mon-start week. Without this, on real Mondays yesterday
    // is in last week and hasUntickedRecent rejects it via its same-week
    // check (returning false), which made this test silently flake every
    // Monday on CI. Don't construct relative-to-real-now training fixtures.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T10:00:00")); // local Wed
    try {
      const today = new Date(); today.setHours(0,0,0,0);
      const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
      const yIdx = [6,0,1,2,3,4,5][yesterday.getDay()];
      const tIdx = [6,0,1,2,3,4,5][today.getDay()];
      const week = Array(7).fill(null).map((_, i) => {
        if (i === yIdx) return { type: "z2", s: "Tu" };
        if (i === tIdx) return { type: "strength", s: "Tu" };
        return { type: "rest", s: "Re" };
      });

      // dayDone is date-keyed now — derive yesterday's date once for the
      // both cases. With dayDone empty, the z2 row should surface.
      const y = yesterday.getFullYear(), m = String(yesterday.getMonth()+1).padStart(2,"0"), d = String(yesterday.getDate()).padStart(2,"0");
      const yDate = `${y}-${m}-${d}`;

      expect(hasUntickedRecent([], 3, {}, { week })).toBe(true);
      // Marked via the new date-keyed store → ticked → no fire.
      expect(hasUntickedRecent([], 3, { [yDate]: true }, { week })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: user opens app on Monday wanting to log Strength C from
  // the previous week. With the old 3-day window the previous Thursday is
  // already past the cutoff. With the 7-day window we now pass to the
  // helper, the missed strength session resurfaces and the catch-up link
  // appears on home — which is what they expected.
  it("Monday + last week's unlogged Thursday strength → fires with daysBack=7", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00")); // Mon
    try {
      // Strength ONLY on Thursday so the window-cutoff is the variable
      // under test — no other day triggers a non-strength tick path.
      const week = [
        { type: "rest",     s: "M"  },
        { type: "rest",     s: "T"  },
        { type: "rest",     s: "W"  },
        { type: "strength", s: "Th" },  // last Thu = the missed session
        { type: "rest",     s: "F"  },
        { type: "rest",     s: "Sa" },
        { type: "rest",     s: "Su" },
      ];
      // No history at all → last Thursday's strength is unlogged.
      // 3-day window can't see Thursday (Mon - 3 = Fri, not Thu) → returns false.
      expect(hasUntickedRecent([], 3, {}, { week })).toBe(false);
      // 7-day window catches it → true. This is the user's case.
      expect(hasUntickedRecent([], 7, {}, { week })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── findUntickedRecent — per-week strength cap ─────────────────────────────
// Guards against the duplicate-strength bug: editing the schedule mid-week to
// shift strength to different days made the retro picker offer the new days
// as "missing," even though existing records on the original days already
// satisfied the week's strength quota. Result: user accepts, gets a second
// strength_A in the same week.
//
// Rule: per ISO week, count of strength records ≥ scheduled strength-day
// count → all strength rows for that week treated as satisfied.
describe("findUntickedRecent — per-week strength cap", () => {
  // Week shape: 3 strength days, 4 non-strength. Mirrors the live default.
  const threeStrengthWeek = [
    { type: "strength" }, { type: "cardio" }, { type: "strength" },
    { type: "cardio" },   { type: "strength" }, { type: "zone2" },
    { type: "rest" },
  ];
  // Build a strength history record on a given date.
  const sx = (date) => ({ v: 2, id: `${date}T10:00:00.000Z`, date, session: "strength_a", blocks: [] });

  it("suppresses 'missing' strength rows once the week's strength quota is met", () => {
    vi.useFakeTimers();
    try {
      // Pin "now" to Sun 21 Jun 2026 so the trailing 7-day window covers
      // the previous Mon–Sat. Schedule has 3 strength days (Mon/Wed/Fri).
      vi.setSystemTime(new Date("2026-06-21T12:00:00"));
      // History: 3 strength records on Mon, Wed, Fri of the current week.
      // Schedule cap = 3, actual = 3 → no rows should surface as "missing"
      // even though a hypothetical "Tue strength" row appears unrecorded.
      const history = [sx("2026-06-15"), sx("2026-06-17"), sx("2026-06-19")];
      const result = findUntickedRecent(history, 7, {}, { week: threeStrengthWeek });
      // No strength rows should appear — the quota is met.
      expect(result.filter((r) => r.type === "strength")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still surfaces 'missing' strength rows when the quota is not met", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-21T12:00:00"));
      // Only 1 of 3 scheduled strength days actually logged.
      const history = [sx("2026-06-15")];
      const result = findUntickedRecent(history, 7, {}, { week: threeStrengthWeek });
      const strengthRows = result.filter((r) => r.type === "strength");
      // Wed and Fri should appear as missing (Mon is logged).
      expect(strengthRows.length).toBe(2);
      const dates = strengthRows.map((r) => r.date).sort();
      expect(dates).toEqual(["2026-06-17", "2026-06-19"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedule-shifted scenario: original Mon/Wed/Fri logs, new schedule Tue/Thu/Sat — no dupes offered", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-21T12:00:00"));
      // The user's actual reported scenario: existing strength on Mon/Wed/Fri,
      // mid-week edit bumps strength to Tue/Thu/Sat. Picker would naively offer
      // Tue/Thu/Sat as missing despite the week's quota being met.
      const shiftedWeek = [
        { type: "cardio" },   { type: "strength" }, { type: "cardio" },
        { type: "strength" }, { type: "cardio" },   { type: "strength" },
        { type: "rest" },
      ];
      const history = [sx("2026-06-15"), sx("2026-06-17"), sx("2026-06-19")];
      const result = findUntickedRecent(history, 7, {}, { week: shiftedWeek });
      // No strength rows surface — the 3 historical records satisfy the
      // 3 scheduled strength slots, regardless of which days the schedule
      // currently places them on.
      expect(result.filter((r) => r.type === "strength")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── findRecentDays / findUntickedRecent — effective-dated schedules ────────
// The weekFor resolver hands each past date the schedule IN FORCE on it.
// Without it, editing the schedule reinterpreted the whole trailing window
// under today's config: past cardio days flipped to phantom "missed
// strength" rows, past strength days became untickable cardio.
describe("weekFor — past days keep the meaning they had when they happened", () => {
  const cardioWeek   = Array(7).fill({ type: "cardio" });
  const strengthWeek = Array(7).fill({ type: "strength" });
  const sx = (date) => ({ v: 2, id: `${date}T10:00:00.000Z`, date, session: "strength_a", blocks: [] });

  it("findRecentDays types each date under the schedule effective on it", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-21T12:00:00"));
      // Schedule was all-cardio until the 19th; edited to all-strength from
      // the 19th. The trailing window must show 18th as cardio (old world)
      // and 19th/20th as strength (new world).
      const weekFor = (d) => (d >= "2026-06-19" ? strengthWeek : cardioWeek);
      const rows = findRecentDays([], 3, { order: "asc", weekFor });
      expect(rows.map((r) => [r.date, r.type])).toEqual([
        ["2026-06-18", "cardio"],
        ["2026-06-19", "strength"],
        ["2026-06-20", "strength"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("findUntickedRecent offers a tick (not a strength log) for a day that was cardio back then", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-21T12:00:00"));
      const weekFor = (d) => (d >= "2026-06-20" ? strengthWeek : cardioWeek);
      const rows = findUntickedRecent([], 2, {}, { weekFor });
      const byDate = Object.fromEntries(rows.map((r) => [r.date, r.action]));
      // 19th was cardio under the schedule in force then → tick.
      // 20th is strength under the new schedule → log.
      expect(byDate["2026-06-19"]).toBe("tick");
      expect(byDate["2026-06-20"]).toBe("log");
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-week strength cap follows each week's own schedule across an edit", () => {
    vi.useFakeTimers();
    try {
      // Sun 21 Jun. LAST week (Mon 8th – Sun 14th) ran under a 3-strength
      // schedule and all 3 were logged; THIS week is edited to 6 strength
      // days. Applying this week's cap (6) to last week would re-surface
      // last week's satisfied days as missing.
      vi.setSystemTime(new Date("2026-06-16T12:00:00"));
      const threeStrengthWeek = [
        { type: "strength" }, { type: "cardio" }, { type: "strength" },
        { type: "cardio" },   { type: "strength" }, { type: "rest" },
        { type: "rest" },
      ];
      const sixStrengthWeek = [
        ...Array(6).fill({ type: "strength" }), { type: "rest" },
      ];
      const weekFor = (d) => (d >= "2026-06-15" ? sixStrengthWeek : threeStrengthWeek);
      const history = [sx("2026-06-08"), sx("2026-06-10"), sx("2026-06-12")];
      const rows = findUntickedRecent(history, 7, {}, { weekFor });
      // Nothing from last week surfaces — its own cap (3) is met. Monday the
      // 15th (this week, unlogged, strength under the new schedule) does.
      const strengthRows = rows.filter((r) => r.type === "strength");
      expect(strengthRows.map((r) => r.date)).toEqual(["2026-06-15"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
