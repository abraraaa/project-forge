// tests/dates.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The one home for local-timezone calendar math. The bug class this replaces
// is invisible in the CI timezone (UTC), where local == UTC — so the load-
// bearing assertions run the module under NON-UTC timezones in a subprocess.
// Under the old `new Date(str)` / `.toISOString()` implementations these
// cross-TZ checks would disagree with each other and with the local calendar;
// the shared helpers are TZ-independent by construction.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { localDateStr, todayLocalIso, parseLocalDate, mondayOfWeekIso, addDaysIso, daysBetween, mondayIndex, jsDow } from "../lib/dates.js";

const DATES_PATH = resolve(process.cwd(), "lib/dates.js");

describe("dates — in-process", () => {
  it("localDateStr formats a Date's LOCAL calendar day", () => {
    expect(localDateStr(new Date(2026, 6, 5))).toBe("2026-07-05"); // month is 0-based
  });

  it("parseLocalDate round-trips through localDateStr", () => {
    expect(localDateStr(parseLocalDate("2026-07-15"))).toBe("2026-07-15");
    expect(parseLocalDate("2026-13-99")).not.toBeNull(); // JS Date rolls over — still a Date
    expect(parseLocalDate("nope")).toBeNull();
    expect(parseLocalDate("2026-7-1")).toBeNull(); // must be zero-padded ISO
  });

  it("mondayOfWeekIso anchors to the local Monday (accepts Date or string)", () => {
    expect(mondayOfWeekIso("2026-07-13")).toBe("2026-07-13"); // Monday → itself
    expect(mondayOfWeekIso("2026-07-15")).toBe("2026-07-13"); // Wednesday → Monday
    expect(mondayOfWeekIso("2026-07-19")).toBe("2026-07-13"); // Sunday → this week's Monday
    expect(mondayOfWeekIso("2026-07-20")).toBe("2026-07-20"); // next Monday
    expect(mondayOfWeekIso(new Date(2026, 6, 15))).toBe("2026-07-13");
    expect(mondayOfWeekIso("garbage")).toBeNull();
  });

  it("todayLocalIso is a well-formed ISO date", () => {
    expect(todayLocalIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("addDaysIso walks calendar days both directions, across month and year ends", () => {
    expect(addDaysIso("2026-08-04", 1)).toBe("2026-08-05");
    expect(addDaysIso("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2026-08-04", 0)).toBe("2026-08-04");
    expect(addDaysIso(new Date(2026, 7, 4), 1)).toBe("2026-08-05"); // Date input
    expect(addDaysIso("garbage", 1)).toBeNull();
    expect(addDaysIso("2026-08-04", NaN)).toBeNull();
  });

  it("daysBetween is signed whole calendar days, null on malformed input", () => {
    expect(daysBetween("2026-08-01", "2026-08-04")).toBe(3);
    expect(daysBetween("2026-08-04", "2026-08-01")).toBe(-3);
    expect(daysBetween("2026-08-04", "2026-08-04")).toBe(0);
    expect(daysBetween("2026-07-31", new Date(2026, 7, 1))).toBe(1); // mixed input
    expect(daysBetween("junk", "2026-08-04")).toBeNull();
  });

  it("mondayIndex IS the retired [6,0,1,2,3,4,5] week map: 0=Mon..6=Sun", () => {
    expect(mondayIndex("2026-08-03")).toBe(0); // a Monday
    expect(mondayIndex("2026-08-05")).toBe(2); // Wednesday
    expect(mondayIndex("2026-08-09")).toBe(6); // Sunday
    expect(mondayIndex(new Date(2026, 7, 9))).toBe(6);
    expect(mondayIndex("nope")).toBeNull();
  });

  it("jsDow keeps the record schema's native Sun=0 convention, defaulting to today", () => {
    expect(jsDow("2026-08-09")).toBe(0); // Sunday
    expect(jsDow("2026-08-03")).toBe(1); // Monday
    expect(jsDow()).toBe(new Date().getDay());
    expect(jsDow("nope")).toBeNull();
  });
});

// Run the pure functions under several timezones and assert the calendar-date
// answers are identical everywhere. This is the regression lock: the previous
// UTC-based implementations produced DIFFERENT results per timezone (a Monday
// bucketed into the prior week, a Wednesday session dated Tuesday, etc).
describe("dates — timezone independence (subprocess)", () => {
  const TZS = ["UTC", "Europe/London", "America/New_York", "Pacific/Auckland", "Pacific/Kiritimati"]; // UTC-4 … UTC+14, with DST
  const probe = (tz) => {
    const src = `
      import { mondayOfWeekIso, localDateStr, parseLocalDate, addDaysIso, daysBetween, mondayIndex } from ${JSON.stringify(DATES_PATH)};
      const out = {
        wedMon: mondayOfWeekIso("2026-07-15"),
        sunMon: mondayOfWeekIso("2026-07-19"),
        monMon: mondayOfWeekIso("2026-07-13"),
        roundtrip: localDateStr(parseLocalDate("2026-07-15")),
        // London falls back 2026-10-25, New York 2026-11-01: a walk across
        // either must still land 7 calendar days on, and count back as 7.
        dstWalk: addDaysIso("2026-10-22", 7),
        dstBack: daysBetween("2026-10-29", "2026-11-05"),
        monIdx: mondayIndex("2026-08-03"),
      };
      process.stdout.write(JSON.stringify(out));
    `;
    const raw = execFileSync(process.execPath, ["--input-type=module", "-e", src], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });
    return JSON.parse(raw);
  };

  it("every timezone agrees on the local Monday and the round-trip", () => {
    const results = TZS.map(probe);
    const expected = {
      wedMon: "2026-07-13", sunMon: "2026-07-13", monMon: "2026-07-13", roundtrip: "2026-07-15",
      dstWalk: "2026-10-29", dstBack: 7, monIdx: 0,
    };
    for (let i = 0; i < TZS.length; i++) {
      expect(results[i], `timezone ${TZS[i]}`).toEqual(expected);
    }
  });

  it("captureZone reports the RUNTIME's zone and offset, not a constant", () => {
    // The whole point of the stamp is that it varies with where the user is.
    // A capture that returned the same thing everywhere would look correct in
    // CI (UTC) and be worthless in the field, so assert it actually moves.
    const zoneProbe = (tz) => {
      const src = `
        import { captureZone } from ${JSON.stringify(DATES_PATH)};
        process.stdout.write(JSON.stringify(captureZone()));
      `;
      return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", src], {
        env: { ...process.env, TZ: tz }, encoding: "utf8",
      }));
    };
    expect(zoneProbe("UTC")).toMatchObject({ zone: "UTC", offset: 0 });
    expect(zoneProbe("Pacific/Auckland").zone).toBe("Pacific/Auckland");
    expect(zoneProbe("America/New_York").zone).toBe("America/New_York");
    // Offsets are signed the way offsets are WRITTEN (+13:00), not the way
    // getTimezoneOffset returns them. Auckland is ahead of UTC, New York behind.
    expect(zoneProbe("Pacific/Auckland").offset).toBeGreaterThan(0);
    expect(zoneProbe("America/New_York").offset).toBeLessThan(0);
  });
});

describe("captureZone — degrades, never throws", () => {
  it("returns nulls rather than throwing when Intl is unavailable", async () => {
    // A locked-down or exotic runtime must never cost someone a logged
    // session. Null is a usable answer; an exception mid-finalise is not.
    const realIntl = globalThis.Intl;
    // @ts-expect-error — deliberately removing a global for the test
    delete globalThis.Intl;
    try {
      const { captureZone } = await import("../lib/dates.js");
      const out = captureZone();
      expect(out.zone).toBeNull();
      expect(typeof out.offset).toBe("number"); // offset survives without Intl
    } finally {
      globalThis.Intl = realIntl;
    }
  });
});
