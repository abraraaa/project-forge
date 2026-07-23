// @vitest-environment jsdom
// tests/bodyweight-journal.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The bodyweight journal (boss, 2026-07-24: "I thought we'd agreed to log
// bodyweight — there's no other way for this feature to work"). Before this,
// BW.set overwrote a single {kg, updatedAt} and the scale moment left no
// trail — the Locker Room chart could only see session-start snapshots and
// photo tags. Locks: every BW.set journals under the LOCAL calendar day,
// last write per day wins, the journal syncs (meta field + per-date merge),
// and the chart treats the journal as its highest-precedence source.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BW, getLocalProfile } from "../lib/storage.js";
import { mergeBwLog, mergeMeta } from "../lib/sync-merge.js";
import { PROFILE_SUFFIXES } from "../lib/store-health.js";
import { todayLocalIso } from "../lib/dates.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("BW.set journals the scale moment", () => {
  beforeEach(() => localStorage.clear());

  it("stamps today's LOCAL calendar day; last write of the day wins", () => {
    BW.set("p", 82.44);
    BW.set("p", 82.9);
    const log = BW.getLogRaw("p");
    const today = todayLocalIso();
    expect(Object.keys(log)).toEqual([today]);
    expect(log[today].kg).toBe(82.9);
    expect(typeof log[today].updatedAt).toBe("string");
  });

  it("journal entries accrue per day and ride the sync meta payload", () => {
    BW.saveLogRaw("p", { "2026-07-20": { kg: 81, updatedAt: "2026-07-20T08:00:00.000Z" } });
    BW.set("p", 82);
    const log = BW.getLogRaw("p");
    expect(Object.keys(log).length).toBe(2);
    expect(getLocalProfile("p").meta.bodyweightLog).toEqual(log);
  });

  it("BW.clear removes the journal too (no orphan store)", () => {
    BW.set("p", 80);
    BW.clear("p");
    expect(BW.getLogRaw("p")).toEqual({});
  });

  it("the journal suffix is registered — wipe + /diag-sync can see it", () => {
    expect(PROFILE_SUFFIXES.has("bodyweightLog")).toBe(true);
  });
});

describe("mergeBwLog — per-date, newer updatedAt wins", () => {
  const a = { "2026-07-20": { kg: 81, updatedAt: "2026-07-20T08:00:00.000Z" } };
  const b = {
    "2026-07-20": { kg: 81.5, updatedAt: "2026-07-20T21:00:00.000Z" },
    "2026-07-21": { kg: 81.2, updatedAt: "2026-07-21T08:00:00.000Z" },
  };

  it("unions dates and resolves same-day conflicts by updatedAt", () => {
    const out = mergeBwLog(a, b);
    expect(out["2026-07-20"].kg).toBe(81.5); // evening reading wins
    expect(out["2026-07-21"].kg).toBe(81.2);
    expect(mergeBwLog(b, a)["2026-07-20"].kg).toBe(81.5); // symmetric
  });

  it("is idempotent and garbage-tolerant (the change-detection contract)", () => {
    expect(mergeBwLog(b, b)).toEqual(b);
    expect(mergeBwLog(null, b)).toEqual(b);
    expect(mergeBwLog(b, [])).toEqual(b);
    expect(mergeBwLog(undefined, undefined)).toEqual({});
  });

  it("mergeMeta carries the journal (client AND server share this merge)", () => {
    const merged = mergeMeta({ bodyweightLog: a }, { bodyweightLog: b });
    expect(merged.bodyweightLog["2026-07-20"].kg).toBe(81.5);
    expect(Object.keys(merged.bodyweightLog).length).toBe(2);
  });
});

describe("Locker Room chart sources (code shape)", () => {
  const src = readFileSync(resolve(root, "app/locker-room/page.jsx"), "utf8");

  it("the journal is a chart source and wins overlaps (applied last)", () => {
    expect(src).toContain("BW.getLogRaw(profile)");
    const series = src.slice(src.indexOf("const bwSeries"), src.indexOf("const bwChart"));
    expect(series.indexOf("bodyweightAt")).toBeLessThan(series.indexOf("BW.getLogRaw"));
  });

  it("one logged weight renders a visible reading, not placeholder copy", () => {
    expect(src).toMatch(/bwSeries\.length === 1/);
    expect(src).toMatch(/bwSeries\.length === 0/);
  });

  it("the line carries its numbers (boss, 2026-07-26): reading + delta, values on the points, dates at the ends", () => {
    // current reading + signed delta since the first point
    expect(src).toContain("{last.kg} kg");
    expect(src).toMatch(/kg since \{fmtD\(first\.date\)\}/);
    // values ON the points while few enough to read; endpoints beyond that
    expect(src).toMatch(/n <= 6 \? pts : \[pts\[0\], pts\[n - 1\]\]/);
    // dates anchor the ends
    expect(src).toContain("{fmtD(first.date)}");
    expect(src).toContain("{fmtD(last.date)}");
    // dates doctrine: parsed locally, never new Date(iso)
    expect(src).toContain("parseLocalDate(iso)");
  });
});

describe("the odometer (boss, 2026-07-26) — 0.1 kg entry without the 1,600-detent wheel", () => {
  it("splitKg/joinKg round-trip exactly in digit-space (no floating tenths)", async () => {
    const { splitKg, joinKg } = await import("../components/BodyweightDrum.jsx");
    expect(splitKg(82.5)).toEqual({ whole: 82, digit: 5 });   // legacy half-kilo decomposes exactly
    expect(splitKg(84.6)).toEqual({ whole: 84, digit: 6 });   // float 0.599… rounds true
    expect(splitKg(75)).toEqual({ whole: 75, digit: 0 });
    expect(joinKg(82, 5)).toBe(82.5);
    expect(joinKg(84, 6)).toBe(84.6);
    for (let w = 40; w <= 200; w += 7) for (let d = 0; d <= 9; d++) {
      const v = joinKg(w, d);
      expect(splitKg(v)).toEqual({ whole: w, digit: d });     // exhaustive-ish round-trip
    }
    expect(splitKg(30)).toEqual({ whole: 40, digit: 0 });     // clamps to floor
    expect(splitKg("garbage")).toEqual({ whole: 40, digit: 0 });
  });
  it("all three bodyweight entry sites run the odometer; no half-kilo drums remain", () => {
    for (const rel of ["components/BodyweightEditModal.jsx", "components/ProfileScreen.jsx", "app/locker-room/page.jsx"]) {
      const s = readFileSync(resolve(root, rel), "utf8");
      expect(s, rel).toContain("<BodyweightDrum");
      expect(s, rel).not.toMatch(/ScrollDrum[^>]*step=\{0\.5\}/);
    }
  });
});
