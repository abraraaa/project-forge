// Bodyweight lifts accept added weight. Both surfaces must derive that from
// acceptsAddedWeight, never from the programme's static weight.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { acceptsAddedWeight } from "../lib/lift-translations.js";
import { SESSIONS, EXERCISE_POOLS } from "../lib/programme.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(root, "components/SessionScreen.jsx"), "utf8");

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

describe("the two surfaces cannot drift apart again", () => {
  it("both the picker and the drum derive from the shared predicate", () => {
    expect(screen).toContain("const showWeightPicker = acceptsAddedWeight(loadType)");
    expect(screen).toContain("const hasWeight=acceptsAddedWeight(");
  });

  it("the drum never asks the programme's static weight again", () => {
    expect(screen).not.toContain("ex?.weight!==null&&ex?.weight!==undefined");
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
