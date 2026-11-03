// Band lifts are swaps, not pool lifts (2026-11-03): a band's kg is nominal,
// so the slot goes to a cable or dumbbell lift that can be loaded to failure
// in range, and a band lift, wherever it is offered, progresses by reps and
// never takes an anchor start.
import { describe, it, expect } from "vitest";
import { EXERCISE_POOLS, SESSIONS, SWAP_DB } from "../lib/programme.js";
import { getLiftProfile } from "../lib/lift-translations.js";

const BAND = /\bband(ed)?\b/i;
const bandSwaps = [...new Set(Object.values(SWAP_DB).flat().filter((o) => o.eq === "Band").map((o) => o.name))];

describe("band lifts", () => {
  it("no pool and no session template holds one", () => {
    const pooled = Object.entries(EXERCISE_POOLS).flatMap(([slot, p]) => p.pool.filter((e) => BAND.test(e.name)).map((e) => `${slot}: ${e.name}`));
    const templated = SESSIONS.flatMap((s) => s.blocks.flatMap((b) => [b.ex, b.exA, b.exB].filter((e) => e && BAND.test(e.name)).map((e) => `${s.name}: ${e.name}`)));
    expect([...pooled, ...templated]).toEqual([]);
  });

  it("the four that left the pools are still offered as swaps", () => {
    for (const name of ["Band Lateral Raise", "Band Pull-Apart", "Banded Hip Thrust", "Resistance Band Face Pull"]) expect(bandSwaps, name).toContain(name);
  });

  it("every band swap progresses by reps and never reads an anchor", () => {
    expect(bandSwaps.length).toBeGreaterThan(8);
    for (const name of [...bandSwaps, "Band Face Pull"]) {
      const p = getLiftProfile(name);
      expect(p.progressesByLoad, name).toBe(false);
      expect(p.factor, name).toBe(0);
    }
  });
});
