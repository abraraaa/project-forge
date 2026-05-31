// tests/rpe-rir.test.js
// ────────────────────────────────────────────────────────────────────────────
// Boundary + regression tests for the per-set effort mapping. A typo or new
// scale-label that isn't handled drops the set's RIR to null downstream —
// progression then can't fire the ADD signal, so a user training "hard" sees
// the engine just hold. That's the class of bug the "100kg @ hard suggested
// >100kg" reconciliation fix addressed; this test locks the contract.
//
// Contract:
//   - rpeToRir(known)   → fixed RIR (easy=3, normal=2, hard=1, cooked=0, limit=0)
//   - rpeToRir(null/"") → null (legitimate "no RPE")
//   - rpeToRir(other)   → null + console.warn (so typos surface)
//   - rirToRpe is the inverse for the user-facing 3-point scale
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rpeToRir, rirToRpe } from "../lib/storage.js";

describe("rpeToRir — known UI scale (easy / normal / cooked)", () => {
  it("easy → 3 RIR", () => expect(rpeToRir("easy")).toBe(3));
  it("normal → 2 RIR", () => expect(rpeToRir("normal")).toBe(2));
  it("cooked → 0 RIR", () => expect(rpeToRir("cooked")).toBe(0));
});

describe("rpeToRir — legacy scale (hard / limit) — present-day v1 records", () => {
  it("hard → 1 RIR", () => expect(rpeToRir("hard")).toBe(1));
  it("limit → 0 RIR (legacy alias for cooked)", () => expect(rpeToRir("limit")).toBe(0));
});

describe("rpeToRir — legitimate 'no RPE' inputs (silent null)", () => {
  let warn;
  beforeEach(() => {
    vi.restoreAllMocks();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([null, undefined, ""])("%p → null without warning", (input) => {
    expect(rpeToRir(input)).toBe(null);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("rpeToRir — unknown inputs (null + console.warn for dev visibility)", () => {
  let warn;
  beforeEach(() => {
    vi.restoreAllMocks();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    // Casing drift — common typo class. Code base uses lowercase.
    "Easy", "NORMAL", "Cooked",
    // Whitespace — easy to fat-finger in URL params or migrated data.
    " easy", "easy ", " normal ",
    // Future / unhandled scale labels.
    "moderate", "max", "rpe7", "rpe10",
    // Non-string types coerced to a string in JS.
    "0", "true",
  ])("%p → null AND console.warn", (input) => {
    expect(rpeToRir(input)).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("unrecognised");
  });

  it("numeric input → null AND warn (RPE is a string scale, not a number)", () => {
    // A loose caller passing numeric RPE (common bug across teams who confuse
    // RPE-the-1-to-10-scale with our 3-point label scale) should be flagged.
    expect(rpeToRir(7)).toBe(null);
    expect(warn).toHaveBeenCalled();
  });
});

describe("rirToRpe — inverse mapping back to UI labels", () => {
  it("0 → cooked", () => expect(rirToRpe(0)).toBe("cooked"));
  it("1 → hard (surfaces only on v1 migration)", () => expect(rirToRpe(1)).toBe("hard"));
  it("2 → normal", () => expect(rirToRpe(2)).toBe("normal"));
  it("3 → easy", () => expect(rirToRpe(3)).toBe("easy"));
  it("higher RIRs collapse to easy (>= 3)", () => {
    expect(rirToRpe(4)).toBe("easy");
    expect(rirToRpe(10)).toBe("easy");
  });
  it("fractional values band sensibly", () => {
    expect(rirToRpe(2.5)).toBe("normal");
    expect(rirToRpe(1.5)).toBe("hard");
    expect(rirToRpe(0.5)).toBe("cooked");
  });
  it("null / undefined return null", () => {
    expect(rirToRpe(null)).toBe(null);
    expect(rirToRpe(undefined)).toBe(null);
  });
});

describe("rpe ↔ rir round-trip for the live UI scale", () => {
  // The 3 labels users actually log MUST round-trip through both functions
  // without drift. (limit/hard are legacy reads only, so they round-trip to
  // their canonical RIR sibling rather than the legacy label.)
  it.each([
    ["easy", "easy"],
    ["normal", "normal"],
    ["cooked", "cooked"],
  ])("%s → rir → %s", (rpe, expected) => {
    expect(rirToRpe(rpeToRir(rpe))).toBe(expected);
  });
});
