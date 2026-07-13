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
  auditHistoryVolume,
  VOLUME_TARGETS,
} from "../lib/volume-audit.js";
import { SESSIONS, EXERCISE_POOLS } from "../lib/programme.js";
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
      // mev-0 muscles (Core, Traps, Erectors — indirect-volume, never nag a
      // shortfall) read "low" at zero, not "under_mev"
      const mevZero = ["Core", "Traps", "Erectors"];
      expect(perMuscle[m].status).toBe(mevZero.includes(m) ? "low" : "under_mev");
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

// ─── auditHistoryVolume (live training audit) ───────────────────────────────
describe("auditHistoryVolume", () => {
  // Helper: build a history record at a date with one named exercise + N sets
  function rec(date, exercises) {
    return { date, blocks: [{ exercises }] };
  }
  function setN(n, { weight = 50, reps = 5 } = {}) {
    return Array.from({ length: n }, () => ({ weight, reps }));
  }
  const NOW = new Date("2026-05-31T12:00:00Z");

  it("returns zero / empty for an empty history", () => {
    const a = auditHistoryVolume([], { weeks: 4, now: NOW });
    expect(a.sessionsAnalysed).toBe(0);
    expect(a.weeksAnalysed).toBe(4);
    for (const m of Object.keys(VOLUME_TARGETS)) {
      expect(a.perMuscle[m].sets).toBe(0);
    }
  });

  it("counts only sessions inside the trailing window", () => {
    const inside = "2026-05-25"; // 6 days before NOW
    const outside = "2026-04-01"; // way before
    const history = [
      rec(inside,  [{ name: "Barbell Back Squat", muscle: "Quadriceps", sets: setN(3) }]),
      rec(outside, [{ name: "Barbell Back Squat", muscle: "Quadriceps", sets: setN(3) }]),
    ];
    const a = auditHistoryVolume(history, { weeks: 4, now: NOW });
    expect(a.sessionsAnalysed).toBe(1);
  });

  it("averages cumulative-window sets across the requested weeks", () => {
    // 1 session, 3 squat sets, audited over a 4-week window
    // → 3/4 = 0.75 sets/wk for Quads from the primary, rounded to 0.8
    const history = [
      rec("2026-05-25", [{ name: "Barbell Back Squat", muscle: "Quadriceps", sets: setN(3) }]),
    ];
    const a = auditHistoryVolume(history, { weeks: 4, now: NOW });
    expect(a.perMuscle.Quads.sets).toBeCloseTo(0.8, 1);
  });

  it("distributes sets across primary + secondary muscles via anatomy", () => {
    // Squat anatomy: Quads primary 1.0, Glutes 0.5, Hams 0.25, Core 0.3, Calves 0.15
    const history = [
      rec("2026-05-25", [{ name: "Barbell Back Squat", muscle: "Quadriceps", sets: setN(4) }]),
    ];
    const a = auditHistoryVolume(history, { weeks: 4, now: NOW });
    expect(a.perMuscle.Quads.sets).toBeGreaterThan(0);
    expect(a.perMuscle.Glutes.sets).toBeGreaterThan(0);
    expect(a.perMuscle.Hamstrings.sets).toBeGreaterThan(0);
    expect(a.perMuscle.Quads.sets).toBeGreaterThan(a.perMuscle.Glutes.sets);
  });

  it("ignores sets where weight is null AND reps absent (matches chart counting)", () => {
    const history = [
      rec("2026-05-25", [{
        name: "Hanging Leg Raise", muscle: "Core",
        sets: [{ weight: null }, { weight: null, reps: 10 }, { weight: 5, reps: 8 }],
      }]),
    ];
    const a = auditHistoryVolume(history, { weeks: 4, now: NOW });
    // Only 2 of the 3 sets qualify (one is null/no-reps)
    expect(a.perMuscle.Core.sets).toBeGreaterThan(0);
    expect(a.perMuscle.Core.sets).toBeLessThan(2);
  });

  it("flags under_mev and over_mrv on the actual training", () => {
    // 4 weeks of nothing but heavy squats → Quads through the roof, everything else zero
    const history = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(NOW);
      d.setDate(d.getDate() - i * 2);
      history.push(rec(d.toISOString().slice(0, 10), [
        { name: "Barbell Back Squat", muscle: "Quadriceps", sets: setN(10) },
      ]));
    }
    const a = auditHistoryVolume(history, { weeks: 4, now: NOW });
    // Quads getting massive volume — definitely not under MEV (would actually
    // be over MRV here, which is its own flag; we just confirm it's NOT below).
    expect(a.perMuscle.Quads.status).not.toBe("under_mev");
    const underNames = a.flags.filter((f) => f.status === "under_mev").map((f) => f.muscle);
    expect(underNames).toContain("Chest");
    // Back split (stage 3): the untrained pull volume now flags on the
    // banded halves rather than the retired Back key.
    expect(underNames).toContain("Lats");
    expect(underNames).toContain("Upper Back");
  });

  it("respects custom weeks parameter", () => {
    const history = [
      rec("2026-05-25", [{ name: "Barbell Back Squat", muscle: "Quadriceps", sets: setN(8) }]),
    ];
    // Same cumulative volume → smaller window = higher per-week average
    const a4 = auditHistoryVolume(history, { weeks: 4, now: NOW });
    const a1 = auditHistoryVolume(history, { weeks: 1, now: NOW });
    expect(a1.perMuscle.Quads.sets).toBeGreaterThan(a4.perMuscle.Quads.sets);
    expect(a1.weeksAnalysed).toBe(1);
    expect(a4.weeksAnalysed).toBe(4);
  });

  it("guards against missing dates / malformed records", () => {
    const a = auditHistoryVolume([
      null,
      {},
      { date: "2026-05-25" }, // no blocks
      { date: "2026-05-25", blocks: [{}] }, // no exercises
    ], { weeks: 4, now: NOW });
    // null + {} are skipped (no date); the 2 dated-but-empty records count
    // as "sessions in window" even though they contribute zero volume.
    expect(a.sessionsAnalysed).toBe(2);
    expect(a.perMuscle.Quads.sets).toBe(0);
  });
});

// ─── focus-aware audit (PR-D) ───────────────────────────────────────────────
describe("computeWeeklyVolume / auditVolume — focus parameter", () => {
  // Build a default config = pool[0] of every slot. Real-world equivalent of
  // a freshly-started block with no rotations applied yet.
  const defaultConfig = {};
  for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
    defaultConfig[key] = slot.pool[0];
  }

  it("Forged returns identical volume to omitted-focus call", () => {
    const a = computeWeeklyVolume(SESSIONS);
    const b = computeWeeklyVolume(SESSIONS, { focus: "Forged" });
    expect(b).toEqual(a);
  });

  it("Strong reduces total accessory volume — Biceps + Triceps drop under MEV", () => {
    const baseAudit   = auditVolume(SESSIONS, { focus: "Forged" });
    const strongAudit = auditVolume(SESSIONS, { focus: "Strong" });
    // Glutes drop (Hip Thrust gone via ass2)
    expect(strongAudit.perMuscle.Glutes.sets).toBeLessThan(baseAudit.perMuscle.Glutes.sets);
    // Biceps + Triceps drop substantially (css3 = DB Curl + Skullcrusher dropped)
    expect(strongAudit.perMuscle.Biceps.sets).toBeLessThan(baseAudit.perMuscle.Biceps.sets);
    expect(strongAudit.perMuscle.Triceps.sets).toBeLessThan(baseAudit.perMuscle.Triceps.sets);
    // The trade-off the user explicitly accepts: arm volume goes under MEV
    const armFlags = strongAudit.flags.filter(f => f.muscle === "Biceps" || f.muscle === "Triceps");
    expect(armFlags.length).toBe(2);
    expect(armFlags.every(f => f.status === "under_mev")).toBe(true);
  });

  it("Sculpt with default config raises visible-muscle volume above baseline", () => {
    const baseAudit   = auditVolume(SESSIONS, { focus: "Forged" });
    const sculptAudit = auditVolume(SESSIONS, { focus: "Sculpt", config: defaultConfig });
    // Aligned primaries should all increase: chest, front+side delts, biceps, triceps, glutes
    expect(sculptAudit.perMuscle.Chest.sets).toBeGreaterThan(baseAudit.perMuscle.Chest.sets);
    expect(sculptAudit.perMuscle["Front Delts"].sets).toBeGreaterThan(baseAudit.perMuscle["Front Delts"].sets);
    expect(sculptAudit.perMuscle["Side Delts"].sets).toBeGreaterThan(baseAudit.perMuscle["Side Delts"].sets);
    expect(sculptAudit.perMuscle.Biceps.sets).toBeGreaterThan(baseAudit.perMuscle.Biceps.sets);
    expect(sculptAudit.perMuscle.Triceps.sets).toBeGreaterThan(baseAudit.perMuscle.Triceps.sets);
    expect(sculptAudit.perMuscle.Glutes.sets).toBeGreaterThan(baseAudit.perMuscle.Glutes.sets);
  });

  it("Sculpt keeps the programme inside MEV..MRV (no new flags introduced)", () => {
    const sculptAudit = auditVolume(SESSIONS, { focus: "Sculpt", config: defaultConfig });
    expect(sculptAudit.flags).toEqual([]);
  });

  it("Sculpt with empty config = no slots aligned = no bumps = Forged-equivalent", () => {
    const a = computeWeeklyVolume(SESSIONS, { focus: "Forged" });
    const b = computeWeeklyVolume(SESSIONS, { focus: "Sculpt", config: {} });
    expect(b).toEqual(a);
  });
});

// ─── auditHistoryVolume — recency-aware window (trailing complete weeks) ──────
// The audit is deliberately recency-scoped: it assesses the trailing N COMPLETE
// weeks (Monday-aligned), EXCLUDING the in-progress current week, so a genuinely
// skipped recent week registers instead of being smoothed away by a long
// average. now is pinned so week math is deterministic.
describe("auditHistoryVolume — recency window (2-week rolling + away)", () => {
  // Fixed "now" so the 14-day window math is deterministic. Session dates are
  // chosen by day-offset from now (rolling window), so no weekday dependency.
  const now = new Date("2026-06-29T12:00:00Z");

  // History-log-shaped session: blocks[].exercises[].sets[]. ZZZ* names fall
  // back to the given muscle (no anatomy entry), isolating set-counting.
  const sess = (date, muscle, exName, numSets) => ({
    date,
    blocks: [{ exercises: [{ name: exName, muscle, sets: Array.from({ length: numSets }, () => ({ weight: 100, reps: 5 })) }] }],
  });

  it("defaults to a 2-week window", () => {
    const a = auditHistoryVolume([], { now });
    expect(a.weeksAnalysed).toBe(2);
    expect(a.away).toBe(true);
  });

  it("away=true when history exists but nothing falls in the trailing 2 weeks", () => {
    // 2026-05-30 is ~30 days before now — outside a 14-day window.
    const a = auditHistoryVolume([sess("2026-05-30", "Quads", "ZZZ1", 16)], { weeks: 2, now });
    expect(a.sessionsAnalysed).toBe(0);
    expect(a.away).toBe(true);
  });

  it("a recent session registers (away=false) and averages over the window span", () => {
    // 2026-06-26 is 3 days before now — inside the 14-day window.
    const a = auditHistoryVolume([sess("2026-06-26", "Quads", "ZZZ1", 16)], { weeks: 2, now });
    expect(a.away).toBe(false);
    expect(a.sessionsAnalysed).toBe(1);
    expect(a.perMuscle.Quads.sets).toBe(8); // 16 sets / 2-week span
  });

  it("a skipped week within the window halves the average vs training both (recency, not smoothing)", () => {
    // Both weeks trained (3 and 10 days ago, both inside 14-day window).
    const both = auditHistoryVolume(
      [sess("2026-06-26", "Quads", "ZZZ1", 16), sess("2026-06-19", "Quads", "ZZZ1", 16)],
      { weeks: 2, now },
    );
    const one = auditHistoryVolume([sess("2026-06-26", "Quads", "ZZZ1", 16)], { weeks: 2, now });
    expect(both.perMuscle.Quads.sets).toBe(16); // 32 / 2
    expect(one.perMuscle.Quads.sets).toBe(8);   // 16 / 2 — the skipped week counts as zero
    expect(one.perMuscle.Quads.sets).toBeLessThan(both.perMuscle.Quads.sets);
  });
});