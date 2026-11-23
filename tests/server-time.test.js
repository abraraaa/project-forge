// lib/server-time.js against the expressions the server used before it, over
// a sweep of instants: every hour (and a millisecond either side) across the
// 2026 and 2027 Europe/London clock changes, every month end 2026–2028,
// 29 February 2028, and the UTC and London midnights of each swept day. Each
// helper must give the old result for every input in the sweep.
import { describe, it, expect } from "vitest";
import {
  durationMs, durationSeconds, isoInstant, msAfter, msBefore, readInstantMs, wholeDaysBetweenMs, slides,
  dayIn, utcDay, utcWeekday, addDays, daysBetween, trainerDay,
} from "@/lib/server-time";
import { addDaysIso, daysBetween as localDaysBetween } from "@/lib/dates";

const LONDON = "Europe/London";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UTC_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });

/** The trainer's today as the server read it before Temporal: the oracle for trainerDay. */
function trainerToday(raw, now = Date.now()) {
  const utc = UTC_FORMAT.format(new Date(now));
  if (typeof raw !== "string" || !ISO.test(raw) || addDaysIso(raw, 0) !== raw) return utc;
  const d = localDaysBetween(utc, raw);
  return d !== null && Math.abs(d) <= 1 ? raw : utc;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The sweep, as epoch milliseconds, built with Date.UTC only. */
function sweep() {
  const out = new Set();
  const around = (ms) => { out.add(ms - 1); out.add(ms); out.add(ms + 1); };
  // Clock changes: last Sunday of March and October, 01:00 UTC; two days either side.
  for (const [y, m, d] of [[2026, 2, 29], [2026, 9, 25], [2027, 2, 28], [2027, 9, 31]]) {
    const start = Date.UTC(y, m, d - 2);
    for (let h = 0; h <= 5 * 24; h++) around(start + h * HOUR);
  }
  // Every month end 2026–2028 (year ends included): 20:00 on the last day to 04:00 on the first.
  for (let y = 2026; y <= 2028; y++) {
    for (let m = 0; m < 12; m++) {
      const first = Date.UTC(y, m + 1, 1);
      for (let h = -4; h <= 4; h++) around(first + h * HOUR);
    }
  }
  // 29 February 2028, hour by hour, and the days either side.
  for (let h = -24; h <= 48; h++) around(Date.UTC(2028, 1, 29) + h * HOUR);
  // The UTC midnight and both possible London midnights (23:00 UTC in summer) of every swept day.
  for (const ms of [...out]) {
    const midnight = Math.floor(ms / DAY) * DAY;
    around(midnight);
    around(midnight - HOUR);
    around(midnight + DAY - HOUR);
  }
  return [...out].sort((a, b) => a - b);
}

const INSTANTS = sweep();
const SHIFTS = [-400, -365, -168, -35, -28, -8, -7, -6, -2, -1, 0, 1, 2, 6, 7, 8, 28, 35, 168, 365, 400];
const ZONES = ["UTC", "Europe/London", "America/Los_Angeles", "Pacific/Auckland"];

/** Run `fn` with the process in `zone`; the old local-day helpers read it. */
function inZone(zone, fn) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
}

/** Every distinct date the sweep touches, in UTC and in London. */
const DAYS = [...new Set(INSTANTS.flatMap((ms) => [
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(ms)),
  new Intl.DateTimeFormat("en-CA", { timeZone: LONDON }).format(new Date(ms)),
]))].sort();

/** Collects every mismatch so a failure names its inputs. */
function diff(cases, oldFn, newFn) {
  const bad = [];
  for (const c of cases) {
    const was = oldFn(...c);
    const now = newFn(...c);
    if (!Object.is(was, now)) bad.push({ in: c, was, now });
    if (bad.length >= 10) break;
  }
  return bad;
}

describe("the sweep", () => {
  it("covers what it claims", () => {
    expect(INSTANTS.length).toBeGreaterThan(2000);
    for (const iso of ["2026-03-29T00:59:59.999Z", "2026-10-25T01:00:00.000Z", "2027-03-28T01:00:00.001Z", "2027-10-31T00:00:00.000Z",
      "2026-12-31T23:59:59.999Z", "2028-01-01T00:00:00.000Z", "2028-02-29T12:00:00.000Z", "2028-02-29T23:00:00.000Z", "2026-06-30T23:00:00.000Z"]) {
      expect(INSTANTS).toContain(Date.parse(iso));
    }
    expect(DAYS).toContain("2028-02-29");
    expect(DAYS).toContain("2027-12-31");
  });
});

describe("durations", () => {
  it("are the literals they replace", () => {
    expect(durationMs({ days: 1 })).toBe(86_400_000);
    expect(durationMs({ days: 7 })).toBe(7 * 86400000);
    expect(durationMs({ days: 14 })).toBe(14 * 86400000);
    expect(durationMs({ days: 30 })).toBe(30 * 86400000);
    expect(durationMs({ days: 90 })).toBe(90 * 86400000);
    expect(durationMs({ days: 168 })).toBe(168 * 86_400_000);
    expect(durationMs({ hours: 1 })).toBe(60 * 60 * 1000);
    expect(durationMs({ minutes: 15 })).toBe(15 * 60 * 1000);
    expect(durationMs({ minutes: 2 })).toBe(120000);
    expect(durationSeconds({ days: 7 })).toBe(7 * 86400);
    expect(durationSeconds({ days: 14 })).toBe(14 * 86400);
    expect(durationSeconds({ days: 30 })).toBe(30 * 86400);
  });
});

describe("instants", () => {
  const EXTREMES = [0, -1, 1, 8.64e15, -8.64e15, Date.UTC(-1, 0, 1), Date.UTC(10000, 0, 1), Date.UTC(999, 11, 31, 23, 59, 59, 999)];

  it("isoInstant is toISOString", () => {
    expect(diff([...INSTANTS, ...EXTREMES].map((ms) => [ms]), (ms) => new Date(ms).toISOString(), isoInstant)).toEqual([]);
  });

  it("isoInstant defaults to Date.now()", () => {
    const before = Date.now();
    const at = Date.parse(isoInstant());
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  const BY = [0, 1, 60_000, 120000, 15 * 60 * 1000, 3_600_000, 86_400_000, 7 * 86400000, 14 * 86400000, 30 * 86400000, 90 * 86400000, 168 * 86_400_000];
  const pairs = INSTANTS.flatMap((ms) => BY.map((by) => [ms, by]));

  it("msAfter is ms + by", () => {
    expect(diff(pairs, (ms, by) => ms + by, msAfter)).toEqual([]);
  });

  it("msBefore is ms - by", () => {
    expect(diff(pairs, (ms, by) => ms - by, msBefore)).toEqual([]);
  });

  it("readInstantMs is new Date(v).getTime()", () => {
    const vals = [...INSTANTS.map((ms) => new Date(ms).toISOString()), ...INSTANTS.slice(0, 50), 0, null, undefined, "", "garbage",
      "2026-03-29", "2026-03-29T01:30:00", "2026-03-29T01:30:00+01:00", new Date(Date.UTC(2026, 9, 25))];
    expect(diff(vals.map((v) => [v]), (v) => new Date(v).getTime(), readInstantMs)).toEqual([]);
  });

  it("wholeDaysBetweenMs is Math.floor((to - from) / 86_400_000)", () => {
    const offs = [0, 1, DAY - 1, DAY, DAY + 1, 23 * HOUR, 25 * HOUR, 7 * DAY - 1, 30 * DAY + 1, 400 * DAY];
    const cases = INSTANTS.flatMap((to) => offs.flatMap((o) => [[to - o, to], [to + o, to]]));
    expect(diff(cases, (from, to) => Math.floor((to - from) / 86_400_000), wholeDaysBetweenMs)).toEqual([]);
  });
});

describe("slides", () => {
  const old = (data, now, { rotateAfterMs, capMs }) => {
    const age = now - new Date(data.createdAt || 0).getTime();
    const authAge = now - new Date(data.authAt || data.createdAt || 0).getTime();
    const withinCap = Number.isFinite(authAge) && authAge < capMs;
    return (!Number.isFinite(age) || age > rotateAfterMs) && withinCap;
  };
  const WINDOWS = [
    { rotateAfterMs: 86400000, capMs: 90 * 86400000 },
    { rotateAfterMs: 86400000, capMs: 30 * 86400000 },
  ];
  const AGES = [0, 1, DAY - 1, DAY, DAY + 1, 14 * DAY, 30 * DAY - 1, 30 * DAY, 30 * DAY + 1, 90 * DAY - 1, 90 * DAY, 90 * DAY + 1, -DAY];

  it("is the old rotation test for every token shape", () => {
    const cases = [];
    for (const now of INSTANTS.filter((_, i) => i % 7 === 0)) {
      const stamps = [undefined, null, "", "garbage", "2026-03-29", ...AGES.map((a) => new Date(now - a).toISOString())];
      for (const createdAt of stamps) {
        for (const authAt of stamps) {
          for (const w of WINDOWS) cases.push([{ createdAt, authAt }, now, w]);
        }
      }
    }
    expect(cases.length).toBeGreaterThan(100_000);
    expect(diff(cases, old, slides)).toEqual([]);
  });
});

describe("days", () => {
  const utcFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });

  it("utcDay is the en-CA UTC format and trainerDay's fallback", () => {
    expect(diff(INSTANTS.map((ms) => [ms]), (ms) => utcFormat.format(new Date(ms)), utcDay)).toEqual([]);
    expect(diff(INSTANTS.map((ms) => [ms]), (ms) => trainerDay(null, ms), utcDay)).toEqual([]);
  });

  for (const zone of ZONES) {
    it(`dayIn is the en-CA format in ${zone}`, () => {
      const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone });
      expect(diff(INSTANTS.map((ms) => [ms, zone]), (ms) => f.format(new Date(ms)), dayIn)).toEqual([]);
    });
  }

  it("a zone's day turns at its local midnight on both sides of a clock change", () => {
    expect(dayIn(Date.parse("2026-03-28T23:59:59.999Z"), LONDON)).toBe("2026-03-28");
    expect(dayIn(Date.parse("2026-03-29T00:00:00.000Z"), LONDON)).toBe("2026-03-29");
    expect(dayIn(Date.parse("2026-10-24T22:59:59.999Z"), LONDON)).toBe("2026-10-24");
    expect(dayIn(Date.parse("2026-10-24T23:00:00.000Z"), LONDON)).toBe("2026-10-25");
  });

  it("utcWeekday is getUTCDay, ISO numbered", () => {
    expect(diff(INSTANTS.map((ms) => [ms]), (ms) => ((new Date(ms).getUTCDay() + 6) % 7) + 1, utcWeekday)).toEqual([]);
    expect(diff(INSTANTS.map((ms) => [ms]), (ms) => new Date(ms).getUTCDay() === 0, (ms) => utcWeekday(ms) === 7)).toEqual([]);
  });

  for (const zone of ZONES) {
    it(`addDays is addDaysIso for every real date (process in ${zone})`, () => {
      const cases = DAYS.flatMap((d) => SHIFTS.map((n) => [d, n]));
      expect(inZone(zone, () => diff(cases, addDaysIso, addDays))).toEqual([]);
    });

    it(`daysBetween is lib/dates daysBetween for every real date (process in ${zone})`, () => {
      const cases = DAYS.flatMap((a) => DAYS.filter((_, i) => i % 5 === 0).map((b) => [a, b]));
      expect(inZone(zone, () => diff(cases, localDaysBetween, daysBetween))).toEqual([]);
    });
  }

  it("addDays and daysBetween refuse what addDaysIso refuses", () => {
    for (const bad of [null, undefined, "", "2026-2-01", "2026-02-1", "20260201", "2026-02-01T00:00", 20260201]) {
      expect(addDaysIso(/** @type {any} */ (bad), 1)).toBe(null);
      expect(addDays(bad, 1)).toBe(null);
      expect(daysBetween(bad, "2026-02-01")).toBe(null);
      expect(daysBetween("2026-02-01", bad)).toBe(null);
    }
    expect(addDaysIso("2026-02-01", NaN)).toBe(null);
    expect(addDays("2026-02-01", NaN)).toBe(null);
  });

  it("trainerDay is trainerToday for every device date", () => {
    const cases = [];
    for (const now of INSTANTS) {
      const utc = utcFormat.format(new Date(now));
      const raws = [null, undefined, 42, "", "today", "2026-2-1", "2026-02-30", "2027-02-29", "2028-02-29", "0026-01-01",
        dayIn(now, LONDON), dayIn(now, "Asia/Tokyo"), dayIn(now, "America/Los_Angeles"), ...[-3, -2, -1, 0, 1, 2, 3].map((n) => addDaysIso(utc, n))];
      for (const raw of raws) cases.push([raw, now]);
    }
    for (const zone of ZONES) expect(inZone(zone, () => diff(cases, trainerToday, trainerDay))).toEqual([]);
  });

  it("trainerDay takes the device's date within a day of the server's UTC date, else the UTC date", () => {
    const now = Date.parse("2026-10-03T23:30:00Z");
    expect(trainerDay("2026-10-04", now)).toBe("2026-10-04");
    expect(trainerDay("2026-10-02", now)).toBe("2026-10-02");
    expect(trainerDay("2026-10-05", now)).toBe("2026-10-03");
    expect(trainerDay("2026-02-31", now)).toBe("2026-10-03");
    expect(trainerDay("2026-10-03T00:00", now)).toBe("2026-10-03");
    expect(trainerDay(undefined, now)).toBe("2026-10-03");
  });
});
