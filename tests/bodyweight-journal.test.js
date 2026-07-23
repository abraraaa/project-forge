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
});
