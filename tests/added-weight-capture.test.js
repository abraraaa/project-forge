// Bodyweight lifts accept added weight. Both surfaces must derive that from
// acceptsAddedWeight, never from the programme's static weight. The two
// surfaces (the weight card and the drum) are rendered in
// tests/components/SessionScreen.surface.test.jsx.

import { describe, it, expect } from "vitest";
import { acceptsAddedWeight, acceptsOptionalWeight } from "../lib/lift-translations.js";
import { SESSIONS, EXERCISE_POOLS } from "../lib/programme.js";

describe("acceptsAddedWeight", () => {
  it("is false only for pure bodyweight", () => {
    expect(acceptsAddedWeight("bodyweight")).toBe(false);
  });

  it("is true for every loadable bodyweight variant", () => {
    // Load type says loadable; the programme still carries weight:null.
    for (const lt of ["loaded_bodyweight", "assisted_bodyweight", "loaded_bw"]) {
      expect(acceptsAddedWeight(lt), lt).toBe(true);
    }
  });

  it("is true for ordinary loaded lifts", () => {
    for (const lt of ["per_db", "total", "cable", "machine", "barbell"]) {
      expect(acceptsAddedWeight(lt), lt).toBe(true);
    }
  });
});

// Pure bodyweight lifts take an OPTIONAL added load (a vest) into their own
// store; lifts where the weight is inherent take it through W. Never both.
describe("acceptsOptionalWeight", () => {
  const others = ["loaded_bodyweight", "assisted_bodyweight", "loaded_bw", "per_db", "total", "cable", "machine", "barbell", "external", null, undefined];

  it("is true only for pure bodyweight", () => {
    expect(acceptsOptionalWeight("bodyweight")).toBe(true);
  });

  it("is false for everything else", () => {
    for (const lt of others) expect(acceptsOptionalWeight(lt), String(lt)).toBe(false);
  });

  it("the two never both hold", () => {
    for (const lt of ["bodyweight", ...others]) {
      expect(acceptsAddedWeight(lt) && acceptsOptionalWeight(lt), String(lt)).toBe(false);
    }
  });
});

describe("the data shape that made this easy to miss", () => {
  const all = [
    ...Object.values(SESSIONS).flatMap((s) => s.blocks || []).flatMap((b) => [b.ex, b.exA, b.exB]),
    ...Object.values(EXERCISE_POOLS).flat(),
  ].filter(Boolean);

  it("loadable bodyweight lifts exist that carry no prescribed weight", () => {
    const nullWeighted = all.filter(
      (e) => acceptsAddedWeight(e.loadType) && (e.weight === null || e.weight === undefined)
        && String(e.loadType || "").includes("bodyweight"),
    );
    expect(nullWeighted.length).toBeGreaterThan(0);
    for (const e of nullWeighted) expect(acceptsAddedWeight(e.loadType), e.name).toBe(true);
  });

  it("no lift is marked pure bodyweight while prescribing a load", () => {
    const contradictions = all
      .filter((e) => e.loadType === "bodyweight" && typeof e.weight === "number" && e.weight > 0)
      .map((e) => `${e.name} (${e.weight}kg)`);
    expect(contradictions, `pure bodyweight with a prescribed load: ${contradictions.join(", ")}`).toEqual([]);
  });
});
