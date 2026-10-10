// ─────────────────────────────────────────────────────────────────────────────
// lib/trainer-ledger.js: one main lift's ledger for the trainer pane, over a
// fixture view in the projection's shape and over the real projection.
//
// Locks in:
//   - rows newest first: the 24-week tier (every counted set, main blocks
//     only), then the 12-month tier (its one top set, tier "top", no volume);
//     sessions on one day ordered by their synthetic ids;
//   - the top-set mark is the e1RM line's pick (first on ties), and the most
//     reps when there is no e1RM to read;
//   - a set the view carries no kg for stays reps only, whatever else rides
//     on it; pure bodyweight shows only added kg; volume never counts a
//     bodyweight movement's kg, and counts both dumbbells;
//   - provenance: the trainer's weight and reps changes for the lift that the
//     client trained at sit on the first session of that date, a reps change
//     giving its prescribed reps; nothing without a plan;
//   - the module imports nothing server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ledgerFor, ledgerKg, ledgerReps, ledgerRepsText, ledgerSetText, ledgerVolumeText, ledgerSetsShown, repCount, ledgerMarkText,
} from "../lib/trainer-ledger.js";
import { mainLiftTrend } from "../lib/analytics.js";
import { projectForTrainer } from "../lib/trainer-view.js";

const SQ = "Barbell Back Squat";
const set = (weight, reps, extra = {}) => ({ weight, reps, rpe: 8, rir: null, loadType: "barbell", ...extra });
const ex = (sets, name = SQ, loadType = "barbell") => ({ name, muscle: "Quads", loadType, sets });
const session = (date, ord, exercises, type = "main") => ({
  id: `${date}T12:00:0${ord}.000Z`, date, session: "strength A", scheduledLetter: "A", readiness: "normal",
  blocks: [{ type, exercises }],
});
const top = (date, weight, reps, name = SQ) => ({
  id: `${date}T12:00:00.000Z`, date, readiness: "normal",
  blocks: [{ type: "main", exercises: [{ name, sets: [{ weight, reps, rpe: 8 }] }, { name: "Barbell Bench Press", sets: [{ weight: 60, reps: 5, rpe: 8 }] }] }],
});

function fixture() {
  return {
    window: { from: "2026-04-20", trendFrom: "2025-10-05", to: "2026-10-05" },
    breaks: [],
    schedule: [],
    sessions: [
      // 100 × 5 (116.7) ties set 3 and beats 105 × 3 (115.5): set 1 is top.
      session("2026-09-01", 0, [ex([set(100, 5), set(105, 3), set(100, 5)])]),
      session("2026-09-20", 0, [ex([set(100, 5)])]),
      session("2026-09-20", 1, [ex([set(102.5, 5), set(102.5, 5), { weight: null, reps: null }])]),
      // Reps only: no kg in the view; a load planted beside it must never show.
      session("2026-10-01", 0, [ex([set(null, 8, { effectiveLoad: 83.7, est1rm: 99.1 }), set(null, 10)])]),
      // The lift as an accessory: not the e1RM line's, not the ledger's.
      session("2026-10-03", 0, [ex([set(70, 10)])], "accessory"),
    ],
    tops: [top("2025-12-01", 90, 5), top("2026-01-10", 95, 5)],
  };
}

describe("ledgerFor", () => {
  it("orders rows newest first: the detail tier, then the top-set tier", () => {
    const rows = ledgerFor(fixture(), SQ);
    expect(rows.map((r) => [r.date, r.tier])).toEqual([
      ["2026-10-01", "session"],
      ["2026-09-20", "session"],
      ["2026-09-20", "session"],
      ["2026-09-01", "session"],
      ["2026-01-10", "top"],
      ["2025-12-01", "top"],
    ]);
    // Same day: the later synthetic id first.
    expect(rows[1].key).toBe("2026-09-20T12:00:01.000Z");
    expect(rows[2].key).toBe("2026-09-20T12:00:00.000Z");
  });

  it("keeps every counted set of the detail tier, numbered as logged; an untouched set is not one", () => {
    const rows = ledgerFor(fixture(), SQ);
    expect(rows[3].sets.map((s) => [s.n, s.kg, s.reps])).toEqual([[1, 100, 5], [2, 105, 3], [3, 100, 5]]);
    expect(rows[1].sets).toHaveLength(2);
  });

  it("marks the e1RM line's top set, first on ties, and the most reps when there is no e1RM", () => {
    const v = fixture();
    const rows = ledgerFor(v, SQ);
    expect(rows[3].sets.map((s) => s.top)).toEqual([true, false, false]);
    expect(rows[3].best).toBe(rows[3].sets[0]);
    expect(rows[1].sets.map((s) => s.top)).toEqual([true, false]);
    expect(rows[0].sets.map((s) => s.top)).toEqual([false, true]);
    expect(rows[0].best?.reps).toBe(10);
    // The line's own pick for every loaded session.
    for (const rec of v.sessions) {
      const point = mainLiftTrend([rec], { includeCooked: true })[SQ]?.[0];
      if (!point) continue;
      const row = rows.find((r) => r.key === rec.id);
      expect([row?.best?.kg, row?.best?.reps]).toEqual([point.topSet.weight, point.topSet.reps]);
    }
  });

  it("the top-set tier is one marked set per session, with no volume", () => {
    const rows = ledgerFor(fixture(), SQ).filter((r) => r.tier === "top");
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].top).toBe(true);
      expect(r.volume).toBeNull();
    }
    expect(rows.map((r) => ledgerSetText(r.best))).toEqual(["95 × 5", "90 × 5"]);
  });

  it("a set with no kg in the view stays reps only: no planted load, no derived kg", () => {
    const [row] = ledgerFor(fixture(), SQ);
    expect(row.sets.map((s) => s.kg)).toEqual([null, null]);
    expect(row.sets.map(ledgerSetText)).toEqual(["8 reps", "10 reps"]);
    expect(row.volume).toEqual({ kg: null, reps: 18 });
    expect(ledgerVolumeText(row.volume)).toBe("18 reps in all");
    expect(JSON.stringify(row)).not.toContain("83.7");
    expect(JSON.stringify(row)).not.toContain("99.1");
  });

  it("through the real projection, a reps-only set and a pure bodyweight set carry no load from bodyweight", () => {
    const date = "2026-09-29";
    const data = {
      meta: { bodyweight: { kg: 83.7 } },
      history: [{
        v: 2, id: `${date}T07:00:00.000Z`, date, readiness: "normal", session: "strength A", scheduledLetter: "A",
        blocks: [{ id: "main", type: "main", exercises: [
          { name: SQ, muscle: "Quads", loadType: "barbell", sets: [{ weight: null, reps: 8, loadType: "barbell", effectiveLoad: 83.7, est1rm: 105.6, volume: 669.6 }] },
          { name: "Pull-Up", muscle: "Back", loadType: "bodyweight", sets: [{ weight: 83.7, reps: 9, loadType: "bodyweight", effectiveLoad: 83.7 }] },
        ] }],
      }],
    };
    const v = projectForTrainer(data, { todayIso: "2026-10-05" });
    const sq = ledgerFor(v, SQ);
    const pu = ledgerFor(v, "Pull-Up");
    expect(sq[0].sets.map(ledgerSetText)).toEqual(["8 reps"]);
    expect(pu[0].sets.map(ledgerSetText)).toEqual(["9 reps"]);
    expect(pu[0].volume).toEqual({ kg: null, reps: 9 });
    expect(JSON.stringify([sq, pu])).not.toContain("83.7");
  });

  it("pure bodyweight shows only added kg; volume skips a bodyweight movement's kg and counts both dumbbells", () => {
    const v = {
      sessions: [
        session("2026-09-01", 0, [ex([set(0, 12, { loadType: "bodyweight" }), set(10, 8, { loadType: "bodyweight" })], "Dip", "bodyweight")]),
        session("2026-09-02", 0, [ex([set(15, 6, { loadType: "loaded_bodyweight" })], "Weighted Chin-Up", "loaded_bodyweight")]),
        session("2026-09-03", 0, [ex([set(20, 10, { loadType: "per_db" })], "Dumbbell Press", "per_db")]),
      ],
      tops: [],
    };
    const dip = ledgerFor(v, "Dip")[0];
    expect(dip.sets.map((s) => [ledgerKg(s), ledgerSetText(s)])).toEqual([["", "12 reps"], ["+10", "+10 × 8"]]);
    expect(dip.volume).toEqual({ kg: null, reps: 20 });
    expect(ledgerFor(v, "Weighted Chin-Up")[0].volume).toEqual({ kg: null, reps: 6 });
    expect(ledgerFor(v, "Dumbbell Press")[0].volume).toEqual({ kg: 400, reps: 10 });
    expect(ledgerVolumeText({ kg: 400, reps: 10 })).toBe("400 kg");
  });

  it("volume over a loaded session is kg × reps", () => {
    const rows = ledgerFor(fixture(), SQ);
    expect(rows[3].volume).toEqual({ kg: 1315, reps: 13 });
  });

  it("puts the trainer's trained-at changes for the lift on the first session of their date", () => {
    const v = /** @type {any} */ (fixture());
    v.plan = {
      changes: [
        { id: "c2", kind: "reps", target: SQ, after: 5, status: "trained_yours", date: "2026-09-20", at: Date.UTC(2026, 8, 19, 9) },
        { id: "c1", kind: "weight", target: SQ, after: 102.5, status: "trained_yours", date: "2026-09-20", at: Date.UTC(2026, 8, 18, 9) },
        { id: "c3", kind: "weight", target: SQ, after: 110, status: "waiting", date: null, at: Date.UTC(2026, 9, 4, 9) },
        { id: "c4", kind: "weight", target: "Barbell Bench Press", after: 62.5, status: "trained_yours", date: "2026-09-20", at: 1 },
        { id: "c5", kind: "mainLift", target: "squat", after: SQ, status: "trained_yours", date: "2026-09-20", at: 2 },
        { id: "c6", kind: "weight", target: SQ, after: 120, status: "trained_yours", date: "2026-08-01", at: 3 },
      ],
    };
    const rows = ledgerFor(v, SQ);
    const first = rows.find((r) => r.key === "2026-09-20T12:00:00.000Z");
    const second = rows.find((r) => r.key === "2026-09-20T12:00:01.000Z");
    expect(first?.changes).toEqual([
      { kind: "weight", after: 102.5, at: Date.UTC(2026, 8, 18, 9) },
      { kind: "reps", after: 5, at: Date.UTC(2026, 8, 19, 9) },
    ]);
    expect(first?.prescribed).toBe(5);
    expect(second?.changes).toEqual([]);
    expect(second?.prescribed).toBeNull();
    expect(rows.flatMap((r) => r.changes)).toHaveLength(2);
  });

  it("a read-only view (no plan) carries no provenance and no prescription", () => {
    for (const r of ledgerFor(fixture(), SQ)) {
      expect(r.changes).toEqual([]);
      expect(r.prescribed).toBeNull();
    }
  });

  it("a session the trainer logged with the client reads Coached; nothing else does, and it never attaches as a change", () => {
    const v = /** @type {any} */ (fixture());
    v.sessions[1].coached = true;
    // A plan session change (kind "session") is not a trained-at weight or reps change.
    v.plan = { changes: [{ id: "s1", kind: "session", target: "2026-09-20:A", status: "kept", date: "2026-09-20", at: 1 }] };
    const rows = ledgerFor(v, SQ);
    expect(rows.map((r) => [r.key, r.coached])).toEqual([
      ["2026-10-01T12:00:00.000Z", false], ["2026-09-20T12:00:01.000Z", false], ["2026-09-20T12:00:00.000Z", true],
      ["2026-09-01T12:00:00.000Z", false], ["2026-01-10T12:00:00.000Z", false], ["2025-12-01T12:00:00.000Z", false],
    ]);
    expect(rows.map(ledgerMarkText)).toEqual(["", "", "Coached", "", "", ""]);
    expect(rows.flatMap((r) => r.changes)).toEqual([]);
    // A top row never carries it, even if a view sent one.
    v.tops[0].coached = true;
    expect(ledgerFor(v, SQ).filter((r) => r.tier === "top").map((r) => r.coached)).toEqual([false, false]);
  });

  it("through the real projection: a kept trainer session reads Coached, and the row holds no name or account", () => {
    const date = "2026-09-29";
    const rec = (id, extra = {}) => ({ v: 2, id, date, readiness: "normal", session: "strength A", scheduledLetter: "A",
      blocks: [{ id: "main", type: "main", exercises: [{ name: SQ, muscle: "Quads", loadType: "barbell", sets: [set(100, 5)] }] }], ...extra });
    const v = projectForTrainer({ history: [rec(`${date}T07:00:00.000Z`, { loggedBy: { name: "Sam", accountId: "hwa_samsamsam" } }),
      rec(`${date}T18:00:00.000Z`)] }, { todayIso: "2026-10-05" });
    const rows = ledgerFor(v, SQ);
    expect(rows.map(ledgerMarkText)).toEqual(["", "Coached"]);
    expect(JSON.stringify(rows)).not.toMatch(/Sam|hwa_|loggedBy/);
  });

  it("an empty or foreign view gives no rows", () => {
    expect(ledgerFor(null, SQ)).toEqual([]);
    expect(ledgerFor({}, SQ)).toEqual([]);
    expect(ledgerFor(fixture(), "Nothing Like It")).toEqual([]);
  });
});

describe("ledger formatting", () => {
  it("prints reps as logged, sets as kg × reps, and top or all sets per row", () => {
    expect(ledgerReps(5)).toBe("5");
    expect(ledgerReps("8/leg")).toBe("8/leg");
    expect(ledgerReps(null)).toBe("");
    expect(ledgerSetText({ n: 1, kg: 100, added: false, reps: null, rpe: null, rir: null, top: false })).toBe("100 × –");
    expect(repCount("45s")).toBe(45);
    expect(repCount("AMRAP")).toBe(0);
    const row = ledgerFor(fixture(), SQ)[3];
    expect(ledgerSetsShown(row, "top")).toEqual([row.sets[0]]);
    expect(ledgerSetsShown(row, "all")).toBe(row.sets);
    expect(ledgerVolumeText(null)).toBe("");
    expect(ledgerVolumeText({ kg: null, reps: 1 })).toBe("1 rep in all");
    expect(ledgerSetText({ n: 1, kg: null, added: false, reps: "8/leg", rpe: null, rir: null, top: false })).toBe("8/leg");
  });

  it("reps as words: a number takes 'reps', a string prints as is", () => {
    expect(ledgerRepsText(5)).toBe("5 reps");
    expect(ledgerRepsText(1)).toBe("1 rep");
    expect(ledgerRepsText("8/leg")).toBe("8/leg");
    expect(ledgerRepsText("45s")).toBe("45s");
    expect(ledgerRepsText("10")).toBe("10");
    expect(ledgerRepsText(null)).toBe("");
    expect(ledgerRepsText(undefined)).toBe("");
    expect(ledgerSetText({ n: 1, kg: null, added: false, reps: "45s", rpe: null, rir: null, top: false })).toBe("45s");
    expect(ledgerSetText({ n: 1, kg: null, added: false, reps: 1, rpe: null, rir: null, top: false })).toBe("1 rep");
  });

  it("imports nothing server-side", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../lib/trainer-ledger.js"), "utf8");
    const specs = [...src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specs.sort()).toEqual(["./analytics.js", "./counted-set.js", "./lift-translations.js"]);
    expect(src).not.toMatch(/storage|mcp-server|\/db|\/net|fetch\(/);
  });
});
