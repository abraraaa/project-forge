// Main-lift choice. The five anchor slots are the one place the template was
// not negotiable. Any chosen main must still be heavy_low_rep — a lighter
// movement in the anchor slot silently un-programmes the user and the Lab
// cannot say why. That is enforced, not trusted.

import { describe, it, expect } from "vitest";
import {
  SESSIONS, SWAP_DB, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS,
  mainLiftOptions, isValidMainLiftChoice, applyMainLiftsToSession,
} from "../lib/programme.js";

const mainBlocks = SESSIONS.flatMap((s) => (s.blocks || []).filter((b) => b.type === "main"));
const sessionWith = (name) => SESSIONS.find((s) =>
  (s.blocks || []).some((b) => b.type === "main" && b.ex?.name === name));
// Sessions carry TWO main blocks, so select by movement, not by type alone.
const mainNamed = (session, name) =>
  session.blocks.find((b) => b.type === "main" && b.ex?.name === name);

describe("the equivalents table is intact", () => {
  it("every canonical main in the programme has options", () => {
    for (const b of mainBlocks) {
      expect(mainLiftOptions(b.ex.name).length, b.ex.name).toBeGreaterThan(1);
    }
  });

  it("every alternative has a swap entry to merge from", () => {
    const missing = [];
    for (const [main, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      for (const a of alts) {
        if (!(SWAP_DB[main] || []).some((o) => o.name === a)) missing.push(`${main} -> ${a}`);
      }
    }
    expect(missing, `no swap entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("offers the programme's own lift first", () => {
    for (const b of mainBlocks) expect(mainLiftOptions(b.ex.name)[0]).toBe(b.ex.name);
  });
});

describe("the heavy_low_rep floor", () => {
  it("every main block is heavy_low_rep to begin with", () => {
    for (const b of mainBlocks) expect(b.ex.loadProfile, b.ex.name).toBe("heavy_low_rep");
  });

  it("stays heavy_low_rep after ANY listed choice is applied", () => {
    // The constraint the note called out as worth enforcing rather than
    // trusting. Alternatives carry no loadProfile of their own, so this is
    // really asserting the merge does not drop the slot's.
    const offenders = [];
    for (const [main, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      const session = sessionWith(main);
      if (!session) continue;
      for (const alt of alts) {
        const out = applyMainLiftsToSession(session, { [main]: alt });
        const block = mainNamed(out, alt);
        if (block?.ex?.loadProfile !== "heavy_low_rep") {
          offenders.push(`${main} -> ${alt}: ${block?.ex?.loadProfile}`);
        }
      }
    }
    expect(offenders, `anchor slot lost its load profile: ${offenders.join(" | ")}`).toEqual([]);
  });
});

describe("only listed equivalents are accepted", () => {
  it("accepts the canonical and its own alternatives", () => {
    expect(isValidMainLiftChoice("Barbell Back Squat", "Barbell Back Squat")).toBe(true);
    expect(isValidMainLiftChoice("Barbell Back Squat", "Front Squat")).toBe(true);
  });

  it("SWAP_DB currently offers exactly the equivalents — so the guard is the\n     thing standing between a widened swap list and the anchor slot", () => {
    // applyMainLiftsToSession also requires a SWAP_DB entry, which today makes
    // isValidMainLiftChoice redundant. That is a property of the DATA, not the
    // design: add one accessory-style option to a main's swap list without
    // adding it to the equivalents, and the guard becomes the only floor.
    for (const [main, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      const wider = (SWAP_DB[main] || []).map((o) => o.name).filter((n) => !alts.includes(n));
      expect(wider, `${main}: swap options beyond the equivalents — the guard now matters`).toEqual([]);
    }
  });

  it("rejects an unlisted movement, and another main's alternative", () => {
    expect(isValidMainLiftChoice("Barbell Back Squat", "Leg Extension")).toBe(false);
    expect(isValidMainLiftChoice("Barbell Back Squat", "Sumo Deadlift")).toBe(false);
  });

  it("applying an invalid choice is a no-op, not a corruption", () => {
    const session = sessionWith("Barbell Back Squat");
    const out = applyMainLiftsToSession(session, { "Barbell Back Squat": "Leg Extension" });
    expect(mainNamed(out, "Barbell Back Squat")).toBeTruthy();
  });
});

describe("applying a choice", () => {
  it("replaces the movement and clears the inherited bar weight", () => {
    // mergeSwap nulls weight when the option carries no loadType — the new
    // movement's load is not the old one's, and the first set corrects it.
    const session = sessionWith("Barbell Bench Press");
    const out = applyMainLiftsToSession(session, { "Barbell Bench Press": "Weighted Dips" });
    const ex = mainNamed(out, "Weighted Dips")?.ex;
    expect(ex?.name).toBe("Weighted Dips");
    expect(ex.weight).toBeNull();
  });

  it("leaves accessories and block structure alone", () => {
    const session = sessionWith("Barbell Back Squat");
    const out = applyMainLiftsToSession(session, { "Barbell Back Squat": "Front Squat" });
    expect(out.blocks.length).toBe(session.blocks.length);
    expect(out.blocks.map((b) => b.type)).toEqual(session.blocks.map((b) => b.type));
  });

  it("is a no-op with no choices", () => {
    const session = sessionWith("Barbell Back Squat");
    expect(applyMainLiftsToSession(session, {})).toBe(session);
    expect(applyMainLiftsToSession(session)).toBe(session);
  });
});
