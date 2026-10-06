// tests/trainer-news.test.js
// What's new on the trainer side shows for a week from the day it shipped:
// shipped <= today < shipped + 7, by local calendar day.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { TRAINER_NEWS, NEW_DAYS, newFor } from "../lib/trainer-news.js";

const ledger = TRAINER_NEWS.find((n) => n.key === "ledger-export");

describe("TRAINER_NEWS", () => {
  it("carries the ledger export, shipped 2026-10-06", () => {
    expect(ledger).toEqual({ key: "ledger-export", shipped: "2026-10-06", line: "Per-lift ledger and CSV export" });
  });

  it("every entry has a unique key, a local date and a line", () => {
    expect(new Set(TRAINER_NEWS.map((n) => n.key)).size).toBe(TRAINER_NEWS.length);
    for (const n of TRAINER_NEWS) {
      expect(n.shipped).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(n.line.trim()).toBe(n.line);
      expect(n.line).not.toMatch(/!/);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(TRAINER_NEWS)).toBe(true);
    expect(Object.isFrozen(ledger)).toBe(true);
  });
});

describe("newFor", () => {
  it("a week is seven days", () => { expect(NEW_DAYS).toBe(7); });

  it.each([
    ["2026-10-05", false], // the day before
    ["2026-10-06", true],  // the day it shipped
    ["2026-10-07", true],
    ["2026-10-12", true],  // shipped + 6
    ["2026-10-13", false], // shipped + 7
    ["2027-10-06", false], // a year on
  ])("on %s: %s", (today, shown) => {
    expect(newFor(today).some((n) => n.key === "ledger-export")).toBe(shown);
  });

  it("matches nothing on a malformed date", () => {
    for (const bad of ["", "2026-10", "06/10/2026", "not a date"]) expect(newFor(bad)).toEqual([]);
    expect(newFor("2026-10-06", [{ key: "x", shipped: "soon", line: "x" }])).toEqual([]);
  });

  it("newest first when two overlap", () => {
    const news = [
      { key: "a", shipped: "2026-10-01", line: "A" },
      { key: "b", shipped: "2026-10-04", line: "B" },
      { key: "c", shipped: "2026-09-20", line: "C" },
    ];
    expect(newFor("2026-10-05", news).map((n) => n.key)).toEqual(["b", "a"]);
  });

  it("crosses a month and a DST change by calendar day", () => {
    const news = [{ key: "m", shipped: "2026-10-28", line: "M" }];
    expect(newFor("2026-11-03", news).map((n) => n.key)).toEqual(["m"]);
    expect(newFor("2026-11-04", news)).toEqual([]);
  });

  // The boundaries by local calendar day, in zones either side of UTC (the CI
  // zone is UTC, where local and UTC days agree).
  it.each(["Pacific/Auckland", "America/Los_Angeles", "Europe/London"])("same boundaries in %s", (tz) => {
    const script = `import("./lib/trainer-news.js").then(({ newFor }) => {
      console.log(JSON.stringify(["2026-10-05","2026-10-06","2026-10-12","2026-10-13"].map((d) => newFor(d).length > 0)));
    });`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: tz }, cwd: process.cwd(), encoding: "utf8" });
    expect(JSON.parse(out.trim())).toEqual([false, true, true, false]);
  });
});
