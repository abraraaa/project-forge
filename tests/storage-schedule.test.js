// @vitest-environment jsdom
// tests/storage-schedule.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Behaviour tests for the W store — effective-dated schedule edit log.
//
// What this file covers:
//   1. New shape persistence (editedAt + effectiveFrom + week per entry).
//   2. Legacy single-7-day-array shape auto-migrates on read.
//   3. getEffectiveOn picks the latest entry whose effectiveFrom ≤ date.
//   4. Retroactive edits (effectiveFrom in the past) supported.
//   5. Same-day repeat saves collapse to one entry.
//   6. Sync merge unions by editedAt, accepts legacy + new shapes.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { W } from "../lib/storage.js";

function week(...types) {
  if (types.length !== 7) throw new Error("week() needs 7 types");
  return types.map((t) => ({ type: t }));
}

const DEFAULT_WEEK = week("strength", "cardio", "strength", "cardio", "strength", "zone2", "rest");
const ALT_WEEK     = week("cardio", "strength", "cardio", "strength", "cardio", "strength", "rest");

describe("W — schedule edit log", () => {
  it("returns null when nothing is stored", () => {
    expect(W.get()).toBe(null);
    expect(W.getHistory()).toBe(null);
    expect(W.getEffectiveOn("2026-06-15")).toBe(null);
  });

  it("save() persists today's edit and getHistory returns one entry", () => {
    W.save(DEFAULT_WEEK);
    const hist = W.getHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0].effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hist[0].editedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hist[0].week.map((d) => d.type)).toEqual([
      "strength", "cardio", "strength", "cardio", "strength", "zone2", "rest",
    ]);
  });

  it("get() returns today's effective week, normalised with s + label", () => {
    W.save(DEFAULT_WEEK);
    const today = W.get();
    expect(today).toHaveLength(7);
    expect(today[0]).toMatchObject({ type: "strength", s: "M", label: "Strength" });
    expect(today[6]).toMatchObject({ type: "rest", s: "S", label: "Rest" });
  });

  it("retroactive edit: getEffectiveOn picks the edit whose effectiveFrom ≤ date", () => {
    // First edit, effective from a past date.
    W.save(DEFAULT_WEEK, { effectiveFrom: "2026-06-01" });
    // Second edit, effective from a later past date.
    W.save(ALT_WEEK, { effectiveFrom: "2026-06-15" });

    // Date before the first edit — no effective schedule.
    expect(W.getEffectiveOn("2026-05-31")).toBe(null);

    // Between the two — original applies.
    const onJun7 = W.getEffectiveOn("2026-06-07");
    expect(onJun7.map((d) => d.type)).toEqual(DEFAULT_WEEK.map((d) => d.type));

    // After the second edit's effectiveFrom — alternative applies.
    const onJun20 = W.getEffectiveOn("2026-06-20");
    expect(onJun20.map((d) => d.type)).toEqual(ALT_WEEK.map((d) => d.type));
  });

  it("two saves on the same effectiveFrom collapse to one entry (last write wins)", () => {
    W.save(DEFAULT_WEEK, { effectiveFrom: "2026-06-01" });
    W.save(ALT_WEEK,     { effectiveFrom: "2026-06-01" });
    const hist = W.getHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0].week.map((d) => d.type)).toEqual(ALT_WEEK.map((d) => d.type));
  });

  it("rejects invalid week shapes", () => {
    expect(() => W.save([])).toThrow();
    expect(() => W.save([{ type: "invalid" }])).toThrow();
  });

  it("rejects invalid effectiveFrom dates", () => {
    expect(() => W.save(DEFAULT_WEEK, { effectiveFrom: "not-a-date" })).toThrow();
    expect(() => W.save(DEFAULT_WEEK, { effectiveFrom: "2026/06/01" })).toThrow();
  });

  it("reset() wipes the entire log", () => {
    W.save(DEFAULT_WEEK, { effectiveFrom: "2026-06-01" });
    W.save(ALT_WEEK,     { effectiveFrom: "2026-06-15" });
    W.reset();
    expect(W.getHistory()).toBe(null);
    expect(W.get()).toBe(null);
  });
});

describe("W — legacy shape migration", () => {
  it("legacy single-7-day-array reads as one epoch-effective entry", () => {
    // Write the legacy shape directly to localStorage.
    const legacy = [
      { s: "M", label: "Strength", type: "strength" },
      { s: "T", label: "Cardio",   type: "cardio" },
      { s: "W", label: "Strength", type: "strength" },
      { s: "T", label: "Cardio",   type: "cardio" },
      { s: "F", label: "Strength", type: "strength" },
      { s: "S", label: "Zone 2",   type: "zone2" },
      { s: "S", label: "Rest",     type: "rest" },
    ];
    window.localStorage.setItem("forge:weekConfig", JSON.stringify(legacy));

    const hist = W.getHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0].effectiveFrom).toBe("1970-01-01");
    expect(hist[0].editedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(hist[0].week.map((d) => d.type)).toEqual(legacy.map((d) => d.type));

    // Effective on any past or future date — legacy applies everywhere.
    expect(W.getEffectiveOn("2020-01-01").map((d) => d.type))
      .toEqual(legacy.map((d) => d.type));
    expect(W.getEffectiveOn("2030-01-01").map((d) => d.type))
      .toEqual(legacy.map((d) => d.type));
  });

  it("a fresh save after a legacy read appends to the log without losing the epoch entry", () => {
    const legacy = DEFAULT_WEEK.map((d, i) => ({
      s: ["M","T","W","T","F","S","S"][i],
      label: { strength: "Strength", cardio: "Cardio", zone2: "Zone 2", hiit: "HIIT", rest: "Rest" }[d.type],
      type: d.type,
    }));
    window.localStorage.setItem("forge:weekConfig", JSON.stringify(legacy));

    W.save(ALT_WEEK, { effectiveFrom: "2026-06-15" });

    const hist = W.getHistory();
    expect(hist).toHaveLength(2);
    expect(hist[0].effectiveFrom).toBe("1970-01-01");
    expect(hist[1].effectiveFrom).toBe("2026-06-15");
  });

  it("replaceHistory accepts the legacy shape (peer device on old code)", () => {
    const legacy = DEFAULT_WEEK;
    const result = W.replaceHistory(legacy);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].effectiveFrom).toBe("1970-01-01");
  });

  it("replaceHistory accepts the new shape and round-trips it", () => {
    const log = [
      { editedAt: "2026-06-01T10:00:00.000Z", effectiveFrom: "2026-06-01", week: DEFAULT_WEEK },
      { editedAt: "2026-06-15T10:00:00.000Z", effectiveFrom: "2026-06-15", week: ALT_WEEK },
    ];
    const result = W.replaceHistory(log);
    expect(result).toHaveLength(2);
    expect(W.getEffectiveOn("2026-06-20").map((d) => d.type)).toEqual(ALT_WEEK.map((d) => d.type));
  });

  it("replaceHistory ignores garbage input", () => {
    expect(W.replaceHistory(null)).toBe(null);
    expect(W.replaceHistory({ not: "an array" })).toBe(null);
    expect(W.replaceHistory([{ no: "shape" }])).toBe(null);
  });
});
