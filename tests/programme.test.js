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

import { describe, it, expect } from "vitest";
import {
  SESSIONS,
  EXERCISE_POOLS,
  SWAP_DB,
  WEEK,
  STRENGTH_DAY_SESSIONS,
  findRecentDays,
  rotateAccessories,
  pushHistoryBlock,
  computeRotationStimulusDelta,
  deriveStrengthDaySessions,
  sessionMetaForDate,
  ROTATION_MEMORY_BLOCKS,
  MAIN_LIFT_FUNCTIONAL_EQUIVALENTS,
} from "../lib/programme.js";

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
