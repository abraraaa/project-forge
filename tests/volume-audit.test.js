// tests/volume-audit.test.js
// ────────────────────────────────────────────────────────────────────────────
// Correctness of the weekly-volume audit helper. Tests exercise the TOOL with
// synthetic programmes (so they stay green when the real programme is rebalanced)
// plus one light integration pass over the live SESSIONS, and a lockstep
// invariant tying VOLUME_TARGETS to the granular MUSCLES vocabulary.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  computeWeeklyVolume,
  classifyVolume,
  auditVolume,
  VOLUME_TARGETS,
} from "../lib/volume-audit.js";
import { MUSCLES } from "../lib/exercise-anatomy.js";

// Names chosen so they resolve to NO anatomy entry and NO movement pattern —
// distributeAcrossMuscles then falls back to the supplied `muscle`, isolating
// the set-counting logic from the curated anatomy dataset.
const synthetic = [
  {
    name: "Fixture",
    blocks: [
      { id: "m", type: "main", sets: 3, ex: { name: "ZZZ1", muscle: "Quads" } },
      {
        id: "s",
        type: "superset",
        sets: 2,
        exA: { name: "ZZZ2", muscle: "Biceps" },
        exB: { name: "ZZZ3", muscle: "Triceps" },
      },
    ],
  },
];

describe("computeWeeklyVolume", () => {
  it("counts a main block's sets once, on its fallback muscle", () => {
    const v = computeWeeklyVolume([{ blocks: [synthetic[0].blocks[0]] }]);
    expect(v).toEqual({ Quads: 3 });
  });

  it("counts BOTH superset exercises at the block's set count", () => {
    const v = computeWeeklyVolume([{ blocks: [synthetic[0].blocks[1]] }]);
    expect(v).toEqual({ Biceps: 2, Triceps: 2 });
  });

  it("aggregates across blocks and sessions", () => {
    expect(computeWeeklyVolume(synthetic)).toEqual({ Quads: 3, Biceps: 2, Triceps: 2 });
  });

  it("skips blocks with zero/absent sets", () => {
    const v = computeWeeklyVolume([
      { blocks: [{ id: "x", sets: 0, ex: { name: "ZZZ1", muscle: "Quads" } }] },
    ]);
    expect(v).toEqual({});
  });

  it("is empty for an empty/garbage programme", () => {
    expect(computeWeeklyVolume([])).toEqual({});
    expect(computeWeeklyVolume([{}])).toEqual({});
  });

  it("defaults to the live SESSIONS when called with no argument", () => {
    // `sessions = SESSIONS` default — calling bare audits the real programme.
    expect(Object.keys(computeWeeklyVolume()).length).toBeGreaterThan(0);
  });
});

describe("classifyVolume", () => {
  const t = { mev: 6, mav: 12, mrv: 16 };
  it("bands by landmark with inclusive MAV/MRV optimal window", () => {
    expect(classifyVolume(3, t)).toBe("under_mev");
    expect(classifyVolume(5.9, t)).toBe("under_mev");
    expect(classifyVolume(6, t)).toBe("low"); // == MEV is productive, not under
    expect(classifyVolume(11.9, t)).toBe("low");
    expect(classifyVolume(12, t)).toBe("optimal"); // == MAV
    expect(classifyVolume(16, t)).toBe("optimal"); // == MRV
    expect(classifyVolume(16.1, t)).toBe("over_mrv");
  });
  it("returns untargeted when no landmark is given", () => {
    expect(classifyVolume(10, null)).toBe("untargeted");
  });
});

describe("auditVolume", () => {
  it("flags only the actionable extremes (under MEV / over MRV)", () => {
    // ZZZ-Calves: 2 sets (under MEV 6); ZZZ-Quads: 30 sets (over MRV 22)
    const prog = [
      {
        blocks: [
          { id: "a", sets: 2, ex: { name: "ZZZ_C", muscle: "Calves" } },
          { id: "b", sets: 30, ex: { name: "ZZZ_Q", muscle: "Quads" } },
          { id: "c", sets: 10, ex: { name: "ZZZ_B", muscle: "Biceps" } }, // low, not flagged
        ],
      },
    ];
    const { perMuscle, flags } = auditVolume(prog);
    expect(perMuscle.Calves.status).toBe("under_mev");
    expect(perMuscle.Quads.status).toBe("over_mrv");
    expect(perMuscle.Biceps.status).toBe("low");
    const flagged = flags.map((f) => f.muscle);
    // under_mev + over_mrv are flagged; the "low" Biceps is not. (Untouched
    // muscles zero-fill to under_mev too — correct for a real full-week audit.)
    expect(flagged).toContain("Calves");
    expect(flagged).toContain("Quads");
    expect(flagged).not.toContain("Biceps");
    expect(flags.every((f) => f.status === "under_mev" || f.status === "over_mrv")).toBe(true);
  });

  it("reports a row for every targeted muscle even at zero volume", () => {
    const { perMuscle } = auditVolume([]);
    for (const m of Object.keys(VOLUME_TARGETS)) {
      expect(perMuscle[m]).toBeDefined();
      expect(perMuscle[m].sets).toBe(0);
      // Core has MEV 0, so zero volume is "low", not "under_mev"
      expect(perMuscle[m].status).toBe(m === "Core" ? "low" : "under_mev");
    }
  });
});

describe("integration — live SESSIONS", () => {
  it("produces a well-formed audit for the real programme", () => {
    const { perMuscle, flags } = auditVolume();
    for (const m of Object.keys(VOLUME_TARGETS)) {
      expect(typeof perMuscle[m].sets).toBe("number");
      expect(perMuscle[m].sets).toBeGreaterThanOrEqual(0);
      expect(typeof perMuscle[m].status).toBe("string");
    }
    expect(Array.isArray(flags)).toBe(true);
  });
});

describe("invariant — targets stay in lockstep with MUSCLES", () => {
  it("every VOLUME_TARGETS key is a valid granular muscle", () => {
    const valid = new Set(Object.values(MUSCLES));
    for (const m of Object.keys(VOLUME_TARGETS)) {
      expect(valid.has(m), `${m} is not a MUSCLES value`).toBe(true);
    }
  });
});
