// The grip rule: a superset or finisher pair holds at most one lift that
// loads the hands (a carry or a hang), so the grip does not give out before
// the target muscle. Day A pairs the lunge with the landmine press and the
// hip extension with the row; stored picks from before that read in place.

import { describe, it, expect } from "vitest";
import {
  SESSIONS, EXERCISE_POOLS, SS_PAIRS, PAIRED_SLOTS, GRIP_LOADED, ENTRY_GRIP,
  gripRuleBreaches, gripAllows, assertGripRule, rotateAccessories,
  readRotationConfig, pruneStaleRotationConfig, applyRotationToSession,
  applyFocusToSession, rotationDiff, FOCUS_OPTIONS, pushHistoryBlock, recentNamesFor,
  STRONG_DROP_BLOCK_IDS, readRotationHistory,
} from "../lib/programme.js";
import { solveRotation, poolFor } from "../lib/rotation-solver.js";

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASSES = ["carry", "hang", "supported", "none"];
const gripOf = (key, ex) => ENTRY_GRIP[ex.name] || EXERCISE_POOLS[key].grip;
const poolNames = (key) => EXERCISE_POOLS[key].pool.map((e) => e.name);
const pick = (slot, name) => ({ ...EXERCISE_POOLS[slot].pool.find((e) => e.name === name) });
const ROWS = poolNames("ass2-B");
const LANDMINES = poolNames("ass1-B");

// Every pair in a composed week holding two carry-or-hang lifts.
function loadedPairs(sessions) {
  const out = [];
  for (const s of sessions) for (const b of s.blocks) {
    if (!b.exA || !b.exB) continue;
    const a = gripOf(`${b.id}-A`, b.exA), z = gripOf(`${b.id}-B`, b.exB);
    if (GRIP_LOADED.has(a) && GRIP_LOADED.has(z)) out.push(`${b.exA.name} + ${b.exB.name}`);
  }
  return out;
}

describe("grip classes", () => {
  it("every slot has one of four classes, and the old labels are gone", () => {
    for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
      expect(CLASSES, key).toContain(slot.grip);
      expect(slot, key).not.toHaveProperty("gripDemand");
    }
    for (const g of Object.values(ENTRY_GRIP)) expect(CLASSES).toContain(g);
  });

  it("the pairs are every superset and finisher block, SS_PAIRS included", () => {
    const blocks = SESSIONS.flatMap((s) => s.blocks.filter((b) => b.type === "superset" || b.type === "finisher"));
    expect(PAIRED_SLOTS.map(([a]) => a.replace(/-A$/, "")).sort()).toEqual(blocks.map((b) => b.id).sort());
    for (const pair of SS_PAIRS) expect(PAIRED_SLOTS).toContainEqual(pair);
    for (const [a, b] of PAIRED_SLOTS) {
      expect(EXERCISE_POOLS[a], a).toBeTruthy();
      expect(EXERCISE_POOLS[b], b).toBeTruthy();
    }
  });
});

describe("the rule over every pair", () => {
  it("no pair holds two carry-or-hang slots", () => {
    for (const [a, b] of PAIRED_SLOTS) {
      const loaded = [a, b].filter((k) => GRIP_LOADED.has(EXERCISE_POOLS[k].grip));
      expect(loaded.length, `${a} + ${b}`).toBeLessThanOrEqual(1);
    }
    expect(gripRuleBreaches()).toEqual([]);
    expect(() => assertGripRule()).not.toThrow();
  });

  it("Day B and Day C pass as they are", () => {
    const classes = Object.fromEntries(PAIRED_SLOTS.map(([a, b]) => [a.replace(/-A$/, ""), `${EXERCISE_POOLS[a].grip}/${EXERCISE_POOLS[b].grip}`]));
    expect(classes).toEqual({
      ass1: "carry/supported", ass2: "supported/hang", afin: "hang/none",
      bss1: "none/hang", bss2: "carry/none", bfin: "supported/supported",
      css1: "carry/supported", css2: "supported/hang", css3: "hang/none", cfin: "hang/supported",
    });
  });

  it("the old Day A pools break it: the lunges beside the rows", () => {
    const old = { ...EXERCISE_POOLS, "ass1-B": EXERCISE_POOLS["ass2-B"], "ass2-B": EXERCISE_POOLS["ass1-B"] };
    expect(gripRuleBreaches(old)).toEqual([["ass1-A", "ass1-B"]]);
  });

  it("a carry-or-hang lift in a lighter slot counts: two of them across a pair break it", () => {
    // The single-leg RDL's dumbbells in ass2-A, beside a curl in a row slot
    // classed supported: neither slot is carry-or-hang, both lifts are.
    const pools = {
      ...EXERCISE_POOLS,
      "ass2-B": { ...EXERCISE_POOLS["ass2-B"], grip: "supported", pool: [EXERCISE_POOLS["css3-A"].pool[0]] },
    };
    ENTRY_GRIP[pools["ass2-B"].pool[0].name] = "hang";
    try {
      expect(gripRuleBreaches(pools)).toEqual([["ass2-A", "ass2-B"]]);
    } finally {
      delete ENTRY_GRIP[pools["ass2-B"].pool[0].name];
    }
  });

  it("the single-leg RDL is never handed out beside the rows", () => {
    const rdl = pick("ass2-A", "Single-Leg RDL");
    expect(ENTRY_GRIP[rdl.name]).toBe("carry");
    expect(gripAllows("ass2-A", rdl)).toBe(false);
    expect(gripAllows("ass2-A", pick("ass2-A", "Barbell Glute Bridge"))).toBe(true);
    for (const focus of FOCUS_OPTIONS) expect(poolFor("ass2-A", EXERCISE_POOLS["ass2-A"], focus).map((e) => e.name)).not.toContain(rdl.name);
    // Still a pool lift: a stored pick of it reads as before.
    expect(poolNames("ass2-A")).toContain(rdl.name);
  });
});

describe("rotation never emits a pair of carry-or-hang lifts", () => {
  it("the solver, every focus", () => {
    const seen = new Set();
    for (const focus of FOCUS_OPTIONS) {
      for (let i = 0; i < 12; i++) {
        const { config } = solveRotation({ focus, rng: seeded(700 + i) });
        seen.add(config["ass2-A"]?.name);
        const week = SESSIONS.map((s) => applyFocusToSession(applyRotationToSession(s, config), focus, config));
        expect(loadedPairs(week), `${focus} ${700 + i}`).toEqual([]);
        for (const [key, ex] of Object.entries(config)) expect(gripAllows(key, ex), `${focus} ${key} ${ex.name}`).toBe(true);
      }
    }
    expect(seen.has("Single-Leg RDL")).toBe(false);
  });

  it("rotateAccessories", () => {
    for (let i = 0; i < 60; i++) {
      const config = rotateAccessories({});
      expect(loadedPairs(SESSIONS.map((s) => applyRotationToSession(s, config)))).toEqual([]);
      expect(config["ass2-A"].name).not.toBe("Single-Leg RDL");
    }
  });

  it("a pool edit that pairs two carry-or-hang slots throws rather than rotate", () => {
    const slot = EXERCISE_POOLS["ass1-B"];
    const was = slot.grip;
    slot.grip = "hang";
    try {
      expect(() => solveRotation({ rng: seeded(1) })).toThrow(/Grip rule: ass1-A \+ ass1-B/);
      expect(() => rotateAccessories({})).toThrow(/Grip rule/);
    } finally {
      slot.grip = was;
    }
  });
});

describe("Day A: lunge + landmine press, hip extension + row", () => {
  const block = (id) => SESSIONS[0].blocks.find((b) => b.id === id);

  it("the template defaults", () => {
    expect([block("ass1").exA.name, block("ass1").exB.name]).toEqual(["DB Reverse Lunge", "Landmine Press"]);
    expect([block("ass2").exA.name, block("ass2").exB.name]).toEqual(["45-Degree Hip Extension", "Chest-Supported DB Row"]);
  });

  it("the pools moved with their blocks; pool[0] is the default", () => {
    expect(LANDMINES).toEqual(["Landmine Press", "Single-Arm Landmine Press", "Incline Landmine Press", "Landmine Squeeze Press", "Kneeling Landmine Press"]);
    expect(ROWS).toEqual(["Chest-Supported DB Row", "Single-Arm DB Row", "Dumbbell Bent-Over Row", "TRX Row", "Meadows Row", "Incline DB Row", "Seal Row"]);
    expect(EXERCISE_POOLS["ass1-B"]).toMatchObject({ grip: "supported", zone: "rack" });
    expect(EXERCISE_POOLS["ass2-B"]).toMatchObject({ grip: "hang", zone: "db" });
    for (const id of ["ass1", "ass2"]) {
      expect(EXERCISE_POOLS[`${id}-A`].pool[0].name).toBe(block(id).exA.name);
      expect(EXERCISE_POOLS[`${id}-B`].pool[0].name).toBe(block(id).exB.name);
    }
  });
});

describe("stored Day A picks read in place (no write)", () => {
  // The owner's picks, stored before the re-pair.
  const OWNER = Object.freeze({
    "ass1-A": pick("ass1-A", "DB Split Squat"),
    "ass1-B": pick("ass2-B", "Incline DB Row"),
    "ass2-A": pick("ass2-A", "Barbell Glute Bridge"),
    "ass2-B": pick("ass1-B", "Landmine Press"),
  });
  const dayA = (config) => applyRotationToSession(SESSIONS[0], config).blocks
    .filter((b) => b.id === "ass1" || b.id === "ass2").map((b) => `${b.exA.name} ↔ ${b.exB.name}`);

  it("the owner's picks read as DB Split Squat ↔ Landmine Press and Barbell Glute Bridge ↔ Incline DB Row", () => {
    expect(dayA(OWNER)).toEqual(["DB Split Squat ↔ Landmine Press", "Barbell Glute Bridge ↔ Incline DB Row"]);
  });

  it("ass1-B: a row stored there reads as ass2-B's pick", () => {
    const r = readRotationConfig({ "ass1-B": pick("ass2-B", "Seal Row") });
    expect(r["ass2-B"].name).toBe("Seal Row");
    expect(dayA({ "ass1-B": pick("ass2-B", "Seal Row") })).toEqual(["DB Reverse Lunge ↔ Landmine Press", "45-Degree Hip Extension ↔ Seal Row"]);
  });

  it("ass2-B: a landmine press stored there reads as ass1-B's pick", () => {
    const r = readRotationConfig({ "ass2-B": pick("ass1-B", "Kneeling Landmine Press") });
    expect(r["ass1-B"].name).toBe("Kneeling Landmine Press");
    expect(dayA({ "ass2-B": pick("ass1-B", "Kneeling Landmine Press") })).toEqual(["DB Reverse Lunge ↔ Kneeling Landmine Press", "45-Degree Hip Extension ↔ Chest-Supported DB Row"]);
  });

  it("a slot's own valid pick wins over a moved one", () => {
    const config = { "ass1-B": pick("ass1-B", "Incline Landmine Press"), "ass2-B": pick("ass1-B", "Landmine Press") };
    expect(readRotationConfig(config)["ass1-B"].name).toBe("Incline Landmine Press");
  });

  it("unrelated picks are untouched, and a config with nothing to move is returned as is", () => {
    const fresh = { "ass1-B": pick("ass1-B", "Landmine Press"), "ass2-B": pick("ass2-B", "Seal Row"), "bss1-B": pick("bss1-B", "Chin-Up") };
    expect(readRotationConfig(fresh)).toBe(fresh);
    const r = readRotationConfig({ ...OWNER, "bss1-B": fresh["bss1-B"] });
    expect(r["bss1-B"]).toBe(fresh["bss1-B"]);
    expect(r["ass1-A"]).toBe(OWNER["ass1-A"]);
    expect(r["ass2-A"]).toBe(OWNER["ass2-A"]);
  });

  it("read only: the stored config is not mutated, and the prune keeps both picks", () => {
    const stored = structuredClone(OWNER);
    const before = JSON.stringify(stored);
    readRotationConfig(stored);
    applyRotationToSession(SESSIONS[0], stored);
    expect(JSON.stringify(stored)).toBe(before);
    expect(pruneStaleRotationConfig(stored)).toBe(stored);
  });

  it("the next rotation remembers each pick under the slot it was trained in", () => {
    const history = pushHistoryBlock({}, OWNER);
    expect(recentNamesFor(history["ass1-B"])).toEqual(["Landmine Press"]);
    expect(recentNamesFor(history["ass2-B"])).toEqual(["Incline DB Row"]);
    expect(recentNamesFor(history["ass1-A"])).toEqual(["DB Split Squat"]);
    expect(recentNamesFor(history["ass2-A"])).toEqual(["Barbell Glute Bridge"]);
  });

  it("the rotation summary reports each pick under the slot it was trained in", () => {
    const next = { ...OWNER, "ass1-B": pick("ass1-B", "Landmine Press"), "ass2-B": pick("ass2-B", "Incline DB Row") };
    expect(rotationDiff(OWNER, next)).toEqual([]);
  });
});

describe("Day A memory stored before the re-pair reads in place (no write)", () => {
  // Three blocks remembered under the old keys: rows in ass1-B, landmine
  // presses in ass2-B.
  const at = (month) => `2026-${month}-20T08:00:00.000Z`;
  const OLD = Object.freeze({
    "ass1-A": { "DB Split Squat": at("10") },
    "ass1-B": { "Chest-Supported DB Row": at("10"), "Seal Row": at("09"), "Incline DB Row": at("08") },
    "ass2-B": { "Landmine Press": at("10"), "Single-Arm Landmine Press": at("09"), "Incline Landmine Press": at("08") },
  });
  // The same memory under the slots as they are now.
  const NOW = Object.freeze({ ...OLD, "ass1-B": OLD["ass2-B"], "ass2-B": OLD["ass1-B"] });
  const PRESSED = ["Landmine Press", "Single-Arm Landmine Press", "Incline Landmine Press"];
  const ROWED = ["Chest-Supported DB Row", "Seal Row", "Incline DB Row"];

  it("each B slot reads the names its pool holds, from both keys", () => {
    const read = readRotationHistory(OLD);
    expect(recentNamesFor(read["ass1-B"])).toEqual(PRESSED);
    expect(recentNamesFor(read["ass2-B"])).toEqual(ROWED);
    expect(read["ass1-A"]).toBe(OLD["ass1-A"]);
  });

  it("the solver excludes the same names in both slots as it does for the memory filed under them", () => {
    for (const focus of FOCUS_OPTIONS) {
      for (let i = 0; i < 6; i++) {
        const old = solveRotation({ history: OLD, focus, rng: seeded(100 + i) });
        const now = solveRotation({ history: NOW, focus, rng: seeded(100 + i) });
        expect(old.config, `${focus} ${100 + i}`).toEqual(now.config);
        expect(PRESSED, `${focus} ${100 + i}`).not.toContain(old.config["ass1-B"]?.name);
        expect(ROWED, `${focus} ${100 + i}`).not.toContain(old.config["ass2-B"]?.name);
      }
    }
  });

  it("after the first rotation since, each slot remembers its own pool's newest picks", () => {
    // The block just trained held the old-key picks; pushHistoryBlock files
    // them under their slots and keeps two of each old entry beside them.
    const trained = { "ass1-B": pick("ass2-B", "Incline DB Row"), "ass2-B": pick("ass1-B", "Landmine Press") };
    const history = pushHistoryBlock(OLD, trained, "2026-10-28T08:00:00.000Z");
    expect(recentNamesFor(history["ass1-B"])).toEqual(["Landmine Press", "Chest-Supported DB Row", "Seal Row"]);
    const read = readRotationHistory(history);
    expect(recentNamesFor(read["ass1-B"])).toEqual(["Landmine Press", "Single-Arm Landmine Press"]);
    expect(recentNamesFor(read["ass2-B"])).toEqual(["Incline DB Row", "Chest-Supported DB Row", "Seal Row"]);
  });

  it("a memory with nothing to move is returned as is", () => {
    expect(readRotationHistory(NOW)).toBe(NOW);
    const fresh = pushHistoryBlock({}, { "ass1-B": pick("ass1-B", "Landmine Press"), "ass2-B": pick("ass2-B", "Seal Row") });
    expect(readRotationHistory(fresh)).toBe(fresh);
    const empty = {};
    expect(readRotationHistory(empty)).toBe(empty);
  });

  it("the older shapes move the same way, in their stored order", () => {
    const read = readRotationHistory({ "ass1-B": ["Seal Row", "TRX Row"], "ass2-B": "Kneeling Landmine Press" });
    expect(recentNamesFor(read["ass1-B"])).toEqual(["Kneeling Landmine Press"]);
    expect(recentNamesFor(read["ass2-B"])).toEqual(["Seal Row", "TRX Row"]);
  });

  it("read only: neither the read nor a solve rewrites the stored memory", () => {
    const stored = structuredClone(OLD);
    const before = JSON.stringify(stored);
    readRotationHistory(stored);
    solveRotation({ history: stored, rng: seeded(1) });
    expect(JSON.stringify(stored)).toBe(before);
  });
});

describe("Strong drops Day A's lunge superset and keeps the row", () => {
  const names = (session) => session.blocks.map((b) => (b.ex ? b.ex.name : `${b.exA.name} ↔ ${b.exB.name}`));

  it("Day A under Strong: squat, bench, hip extension with row, finisher", () => {
    expect([...STRONG_DROP_BLOCK_IDS].sort()).toEqual(["ass1", "bss2", "css3"]);
    expect(names(applyFocusToSession(SESSIONS[0], "Strong"))).toEqual([
      "Barbell Back Squat", "Barbell Bench Press",
      "45-Degree Hip Extension ↔ Chest-Supported DB Row", "Hanging Leg Raise ↔ Standing Calf Raise",
    ]);
  });

  it("the owner's stored picks under Strong", () => {
    const OWNER = {
      "ass1-A": pick("ass1-A", "DB Split Squat"), "ass1-B": pick("ass2-B", "Incline DB Row"),
      "ass2-A": pick("ass2-A", "Barbell Glute Bridge"), "ass2-B": pick("ass1-B", "Landmine Press"),
    };
    const day = applyFocusToSession(applyRotationToSession(SESSIONS[0], OWNER), "Strong", OWNER);
    expect(names(day)).toEqual([
      "Barbell Back Squat", "Barbell Bench Press",
      "Barbell Glute Bridge ↔ Incline DB Row", "Hanging Leg Raise ↔ Standing Calf Raise",
    ]);
  });

  it("the solver hands out no picks for the dropped lunge superset under Strong", () => {
    for (let i = 0; i < 6; i++) {
      const { config } = solveRotation({ focus: "Strong", rng: seeded(900 + i) });
      expect(config).not.toHaveProperty("ass1-A");
      expect(config).not.toHaveProperty("ass1-B");
      expect(config).toHaveProperty("ass2-B");
    }
  });
});
