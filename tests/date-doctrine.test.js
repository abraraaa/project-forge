// tests/date-doctrine.test.js
// ─────────────────────────────────────────────────────────────────────────────
// THE GUARD for a class of bug that has now been fixed three times.
//
// House rule (CLAUDE.md): "third fix in the same territory → down tools and
// name the system." This is that note, written as an enforceable test rather
// than prose, because prose did not stop occurrences two and three — the
// second one landed in the SAME FILE whose comment documented the first.
//
// THE CLASS. `new Date("2026-10-19")` parses as UTC midnight, and
// `.toISOString().slice(0,10)` formats in UTC. Anywhere the app reasons about
// a CALENDAR DAY, that pairing silently shifts the day for any user whose
// offset is negative, and around a DST transition it shifts even for users at
// UTC+0. Symptoms have been: week columns that no longer match their records
// (volume silently vanishing from the histogram), a schedule grid built on
// the wrong Monday, and completions landing on the neighbouring day.
//
// THE CONTRACT. lib/dates.js is the single source for calendar-day maths:
//   parseLocalDate  — "YYYY-MM-DD" → local midnight (NOT UTC midnight)
//   localDateStr    — Date → "YYYY-MM-DD" in LOCAL time
//   mondayOfWeekIso — the local Monday of a week
//   todayLocalIso   — today, locally
// No other module may hand-roll those. lib/dates.js itself is exempt: it is
// where the conversion legitimately happens.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { parseLocalDate, localDateStr, mondayOfWeekIso } from "../lib/dates.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every source file that could reason about a calendar day.
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|jsx)$/.test(entry.name)) out.push(rel);
    }
  };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

// Strip comments: the doctrine is discussed at length in comments (including
// in this repo's own warnings), and a guard that trips on documentation
// teaches people to delete the documentation.
const code = (src) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("the UTC-format escape hatch is closed", () => {
  // `.toISOString().slice(0, 10)` / `.substring(0, 10)` — formatting a
  // calendar day in UTC. This is the half that bit weeklyVolumeByMuscle.
  const UTC_DAY_FORMAT = /toISOString\(\)\s*\.\s*(slice|substring)\(\s*0\s*,\s*10\s*\)/;

  it("no module outside lib/dates.js formats a calendar day via toISOString", () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      if (f === join("lib", "dates.js")) continue;   // the one legitimate home
      const src = code(readFileSync(resolve(root, f), "utf8"));
      if (UTC_DAY_FORMAT.test(src)) offenders.push(f);
    }
    expect(offenders, `use localDateStr() from lib/dates.js instead:\n${offenders.join("\n")}`)
      .toEqual([]);
  });
});

describe("the day-maths helpers are used, not re-derived", () => {
  // A deliberately NARROW positive assertion rather than a broad ban on
  // `new Date(x)`. The first version of this guard banned that shape outright
  // and immediately flagged four legitimate uses (cloning a Date, parsing a
  // full ISO timestamp) — a guard that cries wolf gets deleted by the next
  // person who trips it, taking the real protection with it. The precise
  // half of the class is the FORMAT ban above; this is the companion: the
  // two files that have actually produced this bug must be composing
  // lib/dates.js rather than hand-rolling the Monday shift and the y/m/d
  // formatting.
  const HAND_ROLLED_FORMAT = /String\(\s*\w+\.getMonth\(\)\s*\+\s*1\s*\)\s*\.padStart/;

  for (const f of ["lib/analytics.js", "lib/storage.js"]) {
    it(`${f} composes lib/dates.js instead of re-deriving the format`, () => {
      const src = code(readFileSync(resolve(root, f), "utf8"));
      expect(src, `${f}: use localDateStr() rather than hand-rolling y/m/d`)
        .not.toMatch(HAND_ROLLED_FORMAT);
      expect(src).toMatch(/from "\.\/dates\.js"/);
    });
  }
});

describe("the behaviour the guard protects", () => {
  it("a week scaffold built the local way survives a DST transition", () => {
    // Europe/London clocks went back 2026-10-25. Building columns back from
    // 2026-11-02 with UTC arithmetic emitted 2026-10-18, while records in
    // that week hash to 2026-10-19 — so they matched no column and their
    // volume silently disappeared.
    const todayMon = mondayOfWeekIso(new Date(2026, 10, 2)); // 2 Nov 2026, local
    const columns = [];
    for (let w = 3; w >= 0; w--) {
      const d = parseLocalDate(todayMon);
      d.setDate(d.getDate() - w * 7);
      columns.push(localDateStr(d));
    }
    // Every column must be a Monday that mondayOfWeekIso agrees with —
    // i.e. round-tripping a column through the record-side hash is identity.
    for (const c of columns) {
      expect(mondayOfWeekIso(c), `column ${c} is not its own week's Monday`).toBe(c);
    }
  });

  it("parseLocalDate is genuinely local, not UTC midnight", () => {
    const d = parseLocalDate("2026-07-26");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(26);      // the assertion that fails under UTC parsing west of Greenwich
    expect(localDateStr(d)).toBe("2026-07-26");
  });
});
