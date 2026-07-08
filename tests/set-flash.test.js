// tests/set-flash.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Honesty rules for the final-set flash (lib/set-flash.js). The lines are
// signed-off copy; these tests lock the rules that keep them TRUE: Easy
// falls back to Normal on short reps (no false promise of weight), bar
// lines never show on bodyweight movements, no repeats until the pool is
// exhausted, and unknown input stays silent.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { FLASH_LINES, pickFlashLine } from "../lib/set-flash.js";

const texts = (level) => FLASH_LINES[level].map((l) => l.text);

describe("the bank", () => {
  it("has all three effort levels, several lines each, no blanks or dupes", () => {
    for (const level of ["easy", "normal", "cooked"]) {
      const t = texts(level);
      expect(t.length).toBeGreaterThanOrEqual(3);
      expect(new Set(t).size).toBe(t.length);
      t.forEach((s) => expect(s.trim().length).toBeGreaterThan(0));
    }
  });

  it("cooked lines never imply an add (the engine holds on cooked)", () => {
    for (const s of texts("cooked")) {
      expect(/heavier|goes up|add/i.test(s)).toBe(false);
    }
  });
});

describe("pickFlashLine", () => {
  it("returns a line from the matching level", () => {
    for (let i = 0; i < 20; i++) {
      expect(texts("easy")).toContain(pickFlashLine("easy"));
      expect(texts("cooked")).toContain(pickFlashLine("cooked"));
    }
  });

  it("easy on short reps speaks in the Normal register instead of promising weight", () => {
    for (let i = 0; i < 20; i++) {
      expect(texts("normal")).toContain(pickFlashLine("easy", { fullReps: false }));
    }
  });

  it("bar lines never show for bodyweight movements", () => {
    const barLines = [...texts("easy"), ...texts("cooked")].filter((t) => /bar/i.test(t));
    expect(barLines.length).toBeGreaterThan(0); // the rule has something to guard
    for (let i = 0; i < 40; i++) {
      expect(barLines).not.toContain(pickFlashLine("easy", { barLoaded: false }));
      expect(barLines).not.toContain(pickFlashLine("cooked", { barLoaded: false }));
    }
  });

  it("avoids repeats until the pool is exhausted, then reuses rather than going silent", () => {
    const used = new Set(texts("normal").slice(0, 3));
    const remaining = texts("normal")[3];
    for (let i = 0; i < 10; i++) {
      expect(pickFlashLine("normal", { used })).toBe(remaining);
    }
    const allUsed = new Set(texts("normal"));
    expect(texts("normal")).toContain(pickFlashLine("normal", { used: allUsed }));
  });

  it("unknown effort stays silent", () => {
    expect(pickFlashLine("limit")).toBeNull();
    expect(pickFlashLine(undefined)).toBeNull();
  });
});
