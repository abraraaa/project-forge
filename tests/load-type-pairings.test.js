// tests/load-type-pairings.test.js
// ────────────────────────────────────────────────────────────────────────────
// One exercise, one load type — whichever door it comes through.
//
// loadType is not cosmetic. computeEffectiveLoad turns "bodyweight" into the
// user's ENTIRE bodyweight, and analytics doubles "per_db". So a mispaired
// entry doesn't render slightly wrong — it manufactures tonnage that was
// never lifted, or halves work that was.
//
// This has now drifted twice (audit #58: swapped exercises inheriting the
// slot's type; 2026-08-13: bands typed bodyweight, a single-bell goblet squat
// typed per_db, and `raise` sweeping every loaded raise into bodyweight). The
// third fix in one territory is a contract, not another patch — so these are
// invariants over the whole library rather than spot checks.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { SESSIONS, EXERCISE_POOLS, SWAP_DB } from "../lib/programme.js";
import { getLoadType, swapLoadType, getLiftProfile, weightStepForLoadType, snapToImplement } from "../lib/lift-translations.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeEffectiveLoad } from "../lib/storage.js";

const BW_FAMILY = new Set(["bodyweight", "loaded_bodyweight", "assisted_bodyweight"]);

// Every exercise the programme can put in front of a user, with the type it
// would actually be logged under.
function everyExercise() {
  const out = [];
  for (const s of SESSIONS) {
    for (const b of s.blocks || []) {
      for (const ex of [b.ex, b.exA, b.exB]) {
        if (ex?.name) out.push({ name: ex.name, type: getLoadType(ex), src: `SESSIONS/${s.name}` });
      }
    }
  }
  for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
    for (const p of slot.pool || []) {
      if (p?.name) out.push({ name: p.name, type: getLoadType(p), src: `POOL:${key}` });
    }
  }
  for (const [host, alts] of Object.entries(SWAP_DB)) {
    for (const a of alts || []) {
      if (a?.name) out.push({ name: a.name, type: swapLoadType(a), src: `SWAP:${host}` });
    }
  }
  return out;
}

const ALL = everyExercise();

describe("load-type pairings", () => {
  it("no name carrying an implement is logged as bodyweight", () => {
    // You cannot do a "DB", "Cable" or "Band" anything with just your body.
    // This is the class that produced phantom tonnage: a Band Pull-Apart typed
    // bodyweight logged the user's full mass, twenty times a set.
    const IMPLEMENT = /\b(db|dumbbell|barbell|cable|machine|smith|hex|landmine|kettlebell|ez|plate|bottle|backpack|band|banded)\b/i;
    const bad = ALL
      .filter((e) => BW_FAMILY.has(e.type) && IMPLEMENT.test(e.name))
      .map((e) => `${e.name} → ${e.type} (${e.src})`);
    expect([...new Set(bad)], bad.join("; ")).toEqual([]);
  });

  it("single-implement dumbbell moves are never per_db — one bell is not two", () => {
    // per_db doubles the volume maths. A goblet squat is one bell in two
    // hands; doubling it invented half the set.
    const SINGLE = /(goblet|sumo\s*squat|pullover|between)/i;
    const bad = ALL
      .filter((e) => e.type === "per_db" && SINGLE.test(e.name))
      .map((e) => `${e.name} → per_db (${e.src})`);
    expect([...new Set(bad)], bad.join("; ")).toEqual([]);
  });

  it("an assisted movement subtracts the assistance rather than charging full freight", () => {
    const assisted = ALL.filter((e) => /assisted/i.test(e.name));
    expect(assisted.length).toBeGreaterThan(0);
    for (const e of assisted) {
      expect(e.type, `${e.name} (${e.src})`).toBe("assisted_bodyweight");
    }
    // And the maths actually goes the right way.
    expect(computeEffectiveLoad("assisted_bodyweight", 20, 80)).toBe(60);
  });

  it("the same exercise resolves the same way through every door", () => {
    // The audit #58 class: a name that means one thing in a pool and another
    // as a swap option is a bug waiting for a user to find it.
    const byName = new Map();
    for (const e of ALL) {
      if (!byName.has(e.name)) byName.set(e.name, new Map());
      byName.get(e.name).set(e.type, e.src);
    }
    const conflicts = [];
    for (const [name, types] of byName) {
      if (types.size > 1) {
        conflicts.push(`${name}: ${[...types].map(([t, s]) => `${t}(${s})`).join(" vs ")}`);
      }
    }
    expect(conflicts, conflicts.join("; ")).toEqual([]);
  });

  it("every resolved type is one the effective-load maths actually knows", () => {
    const KNOWN = new Set([
      "external", "total", "per_db", "barbell", "machine",
      "bodyweight", "loaded_bodyweight", "assisted_bodyweight",
    ]);
    const unknown = [...new Set(ALL.filter((e) => !KNOWN.has(e.type)).map((e) => `${e.name} → ${e.type}`))];
    expect(unknown, unknown.join("; ")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A loaded lift must never present itself as bodyweight.
//
// Reproduction (boss, 2026-08-13): swap Landmine Press → Arnold Press. The
// swap correctly resolves per_db and correctly refuses to carry 28kg of
// landmine load across — but the user had no working weight for Arnold Press
// and no BW multiplier exists for it, so getW returned null. The session card
// then fell through its `showWeightPicker && currentW !== null` ternary to the
// else branch, which prints the literal word "Bodyweight". A dumbbell press
// announced itself as a bodyweight movement.
//
// The load type was right the whole time. The RENDER was the lie.
// ────────────────────────────────────────────────────────────────────────────
describe("a swapped-in lift arrives with a weight to stand on", () => {
  it("only a known, tiny set of swap options cannot be cold-started", () => {
    // coldStartFromAnchor needs a primary muscle to anchor against. Most
    // loaded swaps have one; these do not, so they arrive weightless and the
    // card shows "New lift — set your weight" rather than a number. That is
    // acceptable (they are nominal-resistance band moves) but it should never
    // grow silently, so the list is pinned.
    const UNSEEDABLE = new Set([
      // Nominal-resistance band moves — no meaningful anchor exists.
      "Resistance Band Crossover",
      "Resistance Band Face Pull",
      // These two are different, and worth fixing rather than accepting: both
      // are genuinely loaded lifts with no lift profile, so they fall through
      // pattern matching without a primary muscle and cannot be cold-started.
      // Filling them needs an anchor and a translation factor, which is a
      // programming call — raised, not guessed. Delete from this list when
      // they get profiles.
      "Weighted Dips",
      "Hang Power Clean",
    ]);
    const orphans = new Set();
    for (const alts of Object.values(SWAP_DB)) {
      for (const a of alts || []) {
        const prof = getLiftProfile(a.name);
        if (prof.progressesByLoad && !prof.primaryMuscle) orphans.add(a.name);
      }
    }
    const unexpected = [...orphans].filter((n) => !UNSEEDABLE.has(n));
    expect(unexpected, unexpected.join(", ")).toEqual([]);
    // And the pin shrinks rather than rots: nothing listed that now anchors.
    const stale = [...UNSEEDABLE].filter((n) => !orphans.has(n));
    expect(stale, stale.join(", ")).toEqual([]);
  });

  it("the card's bodyweight branch is reachable only for bodyweight lifts", () => {
    // Guards the fix structurally: the ternary must test showWeightPicker
    // BEFORE it is allowed to print "Bodyweight".
    const src = readFileSync(resolve(process.cwd(), "components/SessionScreen.jsx"), "utf8");
    const idxNewLift = src.indexOf("New lift &mdash; set your weight");
    const idxBodyweight = src.indexOf(">Bodyweight{bodyweight");
    expect(idxNewLift, "the unknown-weight branch is missing").toBeGreaterThan(-1);
    expect(idxBodyweight, "the bodyweight branch is missing").toBeGreaterThan(-1);
    // The unknown-weight branch must come FIRST, or the bodyweight line
    // catches loaded lifts again.
    expect(idxNewLift).toBeLessThan(idxBodyweight);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Every implement declares its own grid.
//
// weightStepForLoadType is the single source of truth for "which weights
// exist" — the drum steps by it and, since 2026-08-15, the engine snaps
// prescriptions to it. A loadType that isn't listed silently inherits the
// barbell default of 1.25kg, which is a micro-plate: that is how a pin-loaded
// Machine Hamstring Curl came to be prescribed 35.5kg, and how a per_db lift
// came to be prescribed 13.75.
// ────────────────────────────────────────────────────────────────────────────
describe("every load type in the library has a real increment", () => {
  // The grid, stated. A new loadType must be added here deliberately rather
  // than falling through to the default.
  const EXPECTED_STEP = {
    per_db: 1,        // dumbbell racks step in whole kg
    machine: 2.5,     // pin-loaded stack
    cable: 2.5,       // pin-loaded stack
    total: 2.5,       // one implement, loaded like a stack
    barbell: 1.25,    // micro-plates are real here
    external: 1.25,
    bodyweight: 1.25,
    loaded_bodyweight: 1.25,
    assisted_bodyweight: 1.25,
  };

  it("no load type the library actually uses inherits the default by accident", () => {
    const inUse = [...new Set(ALL.map((e) => e.type))];
    const unlisted = inUse.filter((t) => !(t in EXPECTED_STEP));
    expect(unlisted, `unlisted load types: ${unlisted.join(", ")}`).toEqual([]);
  });

  it("each declares the increment its implement can actually express", () => {
    for (const [type, step] of Object.entries(EXPECTED_STEP)) {
      expect(weightStepForLoadType(type), type).toBe(step);
    }
  });

  it("a dumbbell grid can never produce a quarter kilo", () => {
    // The whole point: snapping per_db must land on whole kg from any input.
    for (const raw of [13.75, 18.75, 12.4, 0.3, 47.6]) {
      expect(snapToImplement(raw, "per_db") % 1, `${raw}`).toBe(0);
    }
  });

  it("a pin stack lands on the pin, and a barbell keeps its micro-plates", () => {
    expect(snapToImplement(35.5, "machine")).toBe(35);
    expect(snapToImplement(51.25, "barbell")).toBe(51.25);
  });

  it("an unknown implement is left alone rather than guessed at", () => {
    expect(snapToImplement(13.75, null)).toBe(13.75);
  });
});
