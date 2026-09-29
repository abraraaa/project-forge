// tests/timed-holds.test.js
// ────────────────────────────────────────────────────────────────────────────
// Isometric holds are prescribed in seconds wherever the programme can reach
// them — template, rotation pools, swap substitutes, travel twins — and a
// swap never hands a hold the slot's rep count (or a rep movement a hold's
// seconds).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  SESSIONS, EXERCISE_POOLS, SWAP_DB,
  applySwapsToSession, applyRotationToSession, applyFocusToSession,
  timedTargetFor, isTimedReps,
} from "../lib/programme.js";
import { deriveTravelSession, TRAVEL_MOVES } from "../lib/travel.js";
import { parseTimedReps, getLoadType, getLiftProfile, swapLoadType } from "../lib/lift-translations.js";

const HOLD_RE = /\b(hold|plank|wall sit|l-sit|dead hang|bar hang|carry)\b/i;

/** Every programme entry that names a movement, with where it lives. */
const entries = [];
for (const s of SESSIONS) {
  for (const b of s.blocks || []) {
    for (const k of ["ex", "exA", "exB"]) if (b[k]) entries.push({ where: `SESSIONS ${s.name} ${b.id}.${k}`, ex: b[k] });
  }
}
for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
  for (const ex of slot.pool) entries.push({ where: `EXERCISE_POOLS ${key}`, ex });
}
for (const [key, alts] of Object.entries(SWAP_DB)) {
  for (const ex of alts) entries.push({ where: `SWAP_DB[${key}]`, ex });
}
const reachable = [...new Set(entries.map((e) => e.ex.name))];

/** The swap record exactly as the in-session swap sheet builds it. */
const swapRecord = (option, slotEx) => ({
  name: option.name, muscle: option.muscle,
  reps: slotEx?.reps ?? 10,
  weight: swapLoadType(option) === getLoadType(slotEx) ? (slotEx?.weight ?? null) : null,
  vid: option.vid ?? null, loadType: swapLoadType(option),
});

describe("every hold carries a timed target in the data", () => {
  const holds = entries.filter((e) => HOLD_RE.test(e.ex.name));

  it("the census finds the holds we know about", () => {
    const names = new Set(holds.map((e) => e.ex.name));
    for (const n of ["L-Sit Hold", "Wall Sit", "Plank", "Side Plank", "Hollow Body Hold"]) expect(names.has(n)).toBe(true);
  });

  it.each(holds.map((e) => [e.ex.name, e.where, e.ex]))("%s at %s is timed", (_n, _w, ex) => {
    expect(parseTimedReps(ex.reps)).not.toBeNull();
  });

  it("one answer per hold across every entry that names it", () => {
    for (const e of holds) expect(e.ex.reps).toBe(timedTargetFor(e.ex.name));
  });

  it("L-Sit Hold stays 20s", () => {
    expect(EXERCISE_POOLS["afin-A"].pool.find((e) => e.name === "L-Sit Hold").reps).toBe("20s");
    expect(timedTargetFor("L-Sit Hold")).toBe("20s");
  });

  it("isTimedReps agrees with parseTimedReps", () => {
    for (const r of ["20s", "45 sec", "1m", "2 minutes", 12, "12", "8/leg", "6-8", "30s/side", null]) {
      expect(isTimedReps(r)).toBe(parseTimedReps(r) !== null);
    }
  });

  it("every hold classifies as a pure-bodyweight progression", () => {
    const names = new Set([...holds.map((e) => e.ex.name), "Bar Hang"]);
    for (const n of names) {
      expect(getLiftProfile(n).category).toBe("bw_progression");
      expect(getLoadType({ name: n })).toBe("bodyweight");
    }
  });
});

describe("a swap keeps the units of what was swapped in", () => {
  // Every (slot exercise → hold option) pair the swap sheet can offer, with
  // the slot's real reps wherever the slot is in the programme.
  const pairs = [];
  for (const e of entries.filter((x) => !x.where.startsWith("SWAP_DB"))) {
    for (const option of SWAP_DB[e.ex.name] || []) pairs.push([e.ex, option]);
  }
  const holdPairs = pairs.filter(([, o]) => timedTargetFor(o.name));

  it("there are hold swaps to check", () => {
    expect(holdPairs.length).toBeGreaterThan(0);
  });

  it.each(holdPairs.map(([ex, o]) => [o.name, ex.name, ex, o]))("%s over %s is timed", (_o, _s, ex, option) => {
    const session = { blocks: [{ id: "s1", type: "superset", sets: 3, exA: ex }] };
    const out = applySwapsToSession(session, { "s1-A": swapRecord(option, ex) });
    expect(out.blocks[0].exA.name).toBe(option.name);
    expect(out.blocks[0].exA.reps).toBe(timedTargetFor(option.name));
    expect(getLoadType(out.blocks[0].exA)).toBe("bodyweight");
  });

  it("Wall Sit over the template's 10-rep Leg Press is a 45s hold", () => {
    const idx = SESSIONS.findIndex((s) => s.blocks.some((b) => b.exA?.name === "Leg Press"));
    const block = SESSIONS[idx].blocks.find((b) => b.exA?.name === "Leg Press");
    const option = SWAP_DB["Leg Press"].find((o) => o.name === "Wall Sit");
    const out = applySwapsToSession(SESSIONS[idx], { [`${block.id}-A`]: swapRecord(option, block.exA) });
    const ex = out.blocks.find((b) => b.id === block.id).exA;
    expect(ex.reps).toBe("45s");
    expect(parseTimedReps(ex.reps)).toEqual({ seconds: 45 });
  });

  it("a rep movement swapped over a hold takes its own count, not the hold's seconds", () => {
    const lsit = EXERCISE_POOLS["afin-A"].pool.find((e) => e.name === "L-Sit Hold");
    const option = SWAP_DB["L-Sit Hold"].find((o) => o.name === "Hanging Knee Raise");
    const session = { blocks: [{ id: "afin", type: "finisher", sets: 2, exA: lsit }] };
    const out = applySwapsToSession(session, { "afin-A": swapRecord(option, lsit) });
    expect(out.blocks[0].exA.reps).toBe(12);
  });

  it("a rep-for-rep swap is untouched", () => {
    const ex = { name: "Leg Press", reps: 10, weight: 90, loadType: "machine" };
    const option = SWAP_DB["Leg Press"].find((o) => o.name === "Goblet Squat");
    const out = applySwapsToSession({ blocks: [{ id: "s1", type: "superset", sets: 3, exA: ex }] }, { "s1-A": swapRecord(option, ex) });
    expect(out.blocks[0].exA.reps).toBe(10);
  });
});

describe("nothing downstream of the swap clobbers the seconds", () => {
  const idx = SESSIONS.findIndex((s) => s.blocks.some((b) => b.exA?.name === "Leg Press"));
  const block = SESSIONS[idx].blocks.find((b) => b.exA?.name === "Leg Press");
  const option = SWAP_DB["Leg Press"].find((o) => o.name === "Wall Sit");
  const swapped = applySwapsToSession(
    applyRotationToSession(SESSIONS[idx], {}),
    { [`${block.id}-A`]: swapRecord(option, block.exA) },
  );
  const wallSit = (s) => s.blocks.find((b) => b.id === block.id).exA;

  it("Strong leaves a hold's seconds alone; the partner still shifts", () => {
    // Synthetic block id: bss1-A itself is replaced outright under Strong
    // (STRONG_SLOT_SUBSTITUTIONS), which is a different rule.
    const session = { blocks: [{ id: "x1", type: "superset", sets: 3, exA: wallSit(swapped), exB: { name: "Lat Pulldown", reps: 12, weight: 50 } }] };
    const strong = applyFocusToSession(session, "Strong", {}).blocks[0];
    expect(strong.exA.reps).toBe("45s");
    expect(strong.exA.weight).toBe(wallSit(swapped).weight);
    expect(strong.exB.reps).toBe("6-8");
  });

  it("travel keeps a Wall Sit as a timed Wall Sit", () => {
    const ex = wallSit(deriveTravelSession(swapped));
    expect(ex.name).toBe("Wall Sit");
    expect(ex.reps).toBe("45s");
    expect(ex.loadType).toBe("bodyweight");
  });

  it("travel never pairs a hold with reps or a rep movement with seconds", () => {
    const moves = new Set(Object.keys(TRAVEL_MOVES));
    for (const name of reachable) {
      for (const type of ["main", "superset", "finisher"]) {
        const reps = timedTargetFor(name) ?? 12;
        const out = deriveTravelSession({ blocks: [{ id: "t", type, sets: 3, exA: { name, reps } }] }).blocks[0].exA;
        const outIsHold = timedTargetFor(out.name) !== null || isTimedReps(TRAVEL_MOVES[out.name]?.reps);
        expect([name, type, out.name, isTimedReps(out.reps)]).toEqual([name, type, out.name, outIsHold]);
        if (out.travelFrom) expect(moves.has(out.name)).toBe(true);
      }
    }
  });
});
