// tests/library.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Invariants for the public exercise library (lib/library.js → /library).
// The pages are generated from this catalogue; these tests lock the joins
// between anatomy, progression profiles, and swaps so a rename in one source
// can't silently produce broken pages or dead internal links.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { LIBRARY, slugify, getExercise, libraryByMuscle, exerciseDescription } from "../lib/library.js";
import { EXERCISE_ANATOMY } from "../lib/exercise-anatomy.js";
import sitemap from "../app/sitemap.js";

describe("library catalogue", () => {
  it("covers every hand-tuned anatomy exercise exactly once", () => {
    expect(LIBRARY.length).toBe(Object.keys(EXERCISE_ANATOMY).length);
    const names = new Set(LIBRARY.map((e) => e.name));
    for (const name of Object.keys(EXERCISE_ANATOMY)) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("slugs are unique, non-empty, and URL-safe", () => {
    const slugs = LIBRARY.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("getExercise resolves every slug back to its entry", () => {
    for (const e of LIBRARY) {
      expect(getExercise(e.slug)?.name).toBe(e.name);
    }
    expect(getExercise("not-a-real-exercise")).toBeNull();
  });

  it("every entry has a primary muscle, category label, and progression copy", () => {
    for (const e of LIBRARY) {
      expect(typeof e.primary).toBe("string");
      expect(e.primary.length).toBeGreaterThan(0);
      expect(e.categoryLabel.length).toBeGreaterThan(0);
      expect(e.progression.length).toBeGreaterThan(0);
    }
  });

  it("secondary contributions are sorted heaviest-first with sane weights", () => {
    for (const e of LIBRARY) {
      for (let i = 0; i < e.secondary.length; i++) {
        const s = e.secondary[i];
        expect(s.weight).toBeGreaterThan(0);
        expect(s.weight).toBeLessThanOrEqual(1);
        if (i > 0) expect(s.weight).toBeLessThanOrEqual(e.secondary[i - 1].weight);
      }
    }
  });

  it("swap internal links only point at slugs that exist in the catalogue", () => {
    for (const e of LIBRARY) {
      for (const s of e.swaps) {
        if (s.slug !== null) {
          expect(getExercise(s.slug)).not.toBeNull();
        }
      }
    }
  });

  it("libraryByMuscle groups every entry and orders groups largest-first", () => {
    const groups = libraryByMuscle();
    const total = groups.reduce((n, g) => n + g.exercises.length, 0);
    expect(total).toBe(LIBRARY.length);
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i].exercises.length).toBeLessThanOrEqual(groups[i - 1].exercises.length);
    }
  });

  it("meta descriptions stay inside SERP display length", () => {
    for (const e of LIBRARY) {
      const d = exerciseDescription(e);
      expect(d.length).toBeGreaterThan(50);
      expect(d.length).toBeLessThanOrEqual(170);
    }
  });

  it("slugify handles punctuation and case", () => {
    expect(slugify("Chest-Supported DB Row")).toBe("chest-supported-db-row");
    expect(slugify("Pull-Up")).toBe("pull-up");
    expect(slugify("  Weird -- Name!! ")).toBe("weird-name");
  });
});

describe("sitemap includes the library", () => {
  it("lists the index and one URL per exercise", () => {
    const urls = sitemap().map((r) => r.url);
    expect(urls).toContain("https://theforged.fit/library");
    for (const e of LIBRARY) {
      expect(urls).toContain(`https://theforged.fit/library/${e.slug}`);
    }
  });
});
