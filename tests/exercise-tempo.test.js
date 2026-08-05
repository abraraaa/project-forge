// tests/exercise-tempo.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Invariants for the tempo dataset (lib/exercise-tempo.js). The data was
// compiled externally via the tempo sourcing prompt (internal notes); these
// tests lock what ingestion validated — full canonical coverage, valid
// notation, honest evidence labels, resolvable citations — so a future
// re-run of the sourcing prompt can't silently regress the joins.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { EXERCISE_TEMPO, TEMPO_SOURCES, getTempo, decodeTempo } from "../lib/exercise-tempo.js";
import { EXERCISE_ANATOMY } from "../lib/exercise-anatomy.js";

const TEMPO_RE = /^[0-9X]-[0-9]-[0-9X]-[0-9]$/;

describe("exercise tempo dataset", () => {
  it("covers every canonical anatomy exercise exactly", () => {
    const canonical = Object.keys(EXERCISE_ANATOMY).sort();
    expect(Object.keys(EXERCISE_TEMPO).sort()).toEqual(canonical);
  });

  it("every tempo is valid E-P1-C-P2 notation or null", () => {
    for (const [name, t] of Object.entries(EXERCISE_TEMPO)) {
      if (t.tempo !== null) {
        expect(t.tempo, name).toMatch(TEMPO_RE);
      }
    }
  });

  it("evidence labels are honest enums; null tempo pairs with 'none'", () => {
    for (const [name, t] of Object.entries(EXERCISE_TEMPO)) {
      expect(["direct", "derived", "none"], name).toContain(t.evidence);
      if (t.tempo === null) {
        // Isometrics: no digits, guidance must live in the note.
        expect(t.evidence, name).toBe("none");
        expect(t.note?.length, name).toBeGreaterThan(0);
      }
    }
  });

  it("every entry has a principle and at least one resolvable source", () => {
    for (const [name, t] of Object.entries(EXERCISE_TEMPO)) {
      expect(t.principle?.length, name).toBeGreaterThan(0);
      expect(t.sources?.length, name).toBeGreaterThan(0);
      for (const s of t.sources) {
        expect(TEMPO_SOURCES[s], `${name} → ${s}`).toBeDefined();
      }
    }
  });

  it("every source carries a full citation, and a URL unless it is a general principle", () => {
    // The library pages render these verbatim and link the URL. A citation
    // truncated to its authors, or one with a dead field, is decoration —
    // the point of a public repo is that the science can be followed.
    for (const [key, src] of Object.entries(TEMPO_SOURCES)) {
      expect(src.cite?.length, key).toBeGreaterThan(40);
      if (src.url === null) continue;   // a stated general principle, not a paper
      expect(src.url, key).toMatch(/^https:\/\//);
      expect(src.cite, key).toMatch(/\d{4}/);            // a year to check it by
    }
  });

  it("getTempo resolves canonical names and rejects unknowns", () => {
    expect(getTempo("Barbell Back Squat")?.tempo).toBe("3-1-1-0");
    expect(getTempo("Not An Exercise")).toBeNull();
  });

  it("decodeTempo labels explosive segments and handles null", () => {
    expect(decodeTempo(null)).toBeNull();
    const segs = decodeTempo("3-1-X-0");
    expect(segs.map((s) => s.n)).toEqual(["3", "1", "X", "0"]);
    expect(segs[2].label).toBe("explode");
    expect(decodeTempo("X-0-X-0")[0].label).toBe("drop fast");
  });
});
