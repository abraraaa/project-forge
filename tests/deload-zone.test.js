// A deload's window reads on the lifter's own calendar wherever it is read:
// its stored startDate, else the day of startedAt in the zone of their newest
// record, else (no zone anywhere) the reading process's own zone. The server
// runs on UTC.
import { describe, it, expect, vi } from "vitest";
import { runTool } from "../lib/mcp-server.js";
import { projectPlan } from "../lib/trainer-plan.js";
import { startDeload, deloadWindow } from "../lib/progression.js";

/** Run `fn` with the process in `zone`, the clock at `at` when given. */
function inZone(zone, fn, at = null) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  if (at) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(at)); }
  try {
    return fn();
  } finally {
    if (at) vi.useRealTimers();
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
}
const onServer = (fn) => inZone("UTC", fn);

const SQUAT = "Barbell Back Squat";
// Monday 2 November 2026, 08:00 in Auckland (NZDT, +13): Sunday 19:00 UTC.
const AKL = "2026-11-01T19:00:00.000Z";
// Monday 2 November 2026, 20:00 in Los Angeles (PST, -8): Tuesday 04:00 UTC.
const LAX = "2026-11-03T04:00:00.000Z";

const deload = (startedAt, extra = {}) => ({
  startedAt, plannedDays: 7, triggeredBy: "stall_convergence", triggeredLifts: [], preDeloadWeights: { [SQUAT]: 100 }, ...extra,
});
const lifts = { [SQUAT]: { currentWeight: 100, history: [], currentRepRange: { reps: 5, sets: 3, baseReps: 5 } } };
const meta = (activeDeload) => ({ weights: { [SQUAT]: 100 }, reps: {}, trainingState: { lifts, mesocycle: { currentPhase: "deload", activeDeload } } });
/** A session the Friday before, logged in `zone` (offset in minutes east of UTC). */
const rec = (zone, offset, date = "2026-10-30") => ({
  v: 2, id: `${date}T06:00:00.000Z`, date, session: "strength-a", loggedTz: zone, loggedTzOffset: offset, blocks: [],
});
const programme = (asOf, m, history) => onServer(() => runTool("programme", { asOf }, { meta: m, history }).text);
const inDeload = (asOf, m, history) => programme(asOf, m, history).includes("Deload week");
const squatLoad = (asOf, m, history) => onServer(() => runTool("current_loads", { asOf }, { meta: m, history }).text)
  .split("\n").find((l) => l.startsWith(`- ${SQUAT}:`));

describe("a deload stored before startDate, read on the server in the zone of the lifter's newest session", () => {
  it("Auckland, accepted 08:00 Monday local: the MCP programme's window runs Monday to Sunday", () => {
    const m = meta(deload(AKL));
    const history = [rec("Pacific/Auckland", 780)];
    expect(inDeload("2026-11-01", m, history)).toBe(false);
    expect(inDeload("2026-11-02", m, history)).toBe(true);
    expect(inDeload("2026-11-08", m, history)).toBe(true);
    expect(inDeload("2026-11-09", m, history)).toBe(false);
    expect(squatLoad("2026-11-01", m, history)).toBe(`- ${SQUAT}: 100 kg`);
    expect(squatLoad("2026-11-02", m, history)).toBe(`- ${SQUAT}: 65 kg`);
  });

  it("Los Angeles, accepted 20:00 Monday local: the MCP programme's window runs Monday to Sunday", () => {
    const m = meta(deload(LAX));
    const history = [rec("America/Los_Angeles", -480)];
    expect(inDeload("2026-11-01", m, history)).toBe(false);
    expect(inDeload("2026-11-02", m, history)).toBe(true);
    expect(inDeload("2026-11-08", m, history)).toBe(true);
    expect(inDeload("2026-11-09", m, history)).toBe(false);
    expect(squatLoad("2026-11-02", m, history)).toBe(`- ${SQUAT}: 65 kg`);
    expect(squatLoad("2026-11-09", m, history)).toBe(`- ${SQUAT}: 100 kg`);
  });

  it("the trainer plan reads the same window and names the same last day", () => {
    const plan = (todayIso, startedAt, history) => onServer(() => projectPlan({ meta: meta(deload(startedAt)), history }, { todayIso }));
    const akl = [rec("Pacific/Auckland", 780)];
    expect(plan("2026-11-01", AKL, akl).deload.active).toBe(false);
    expect(plan("2026-11-02", AKL, akl).deload).toEqual({ active: true, until: "2026-11-09" });
    const lax = [rec("America/Los_Angeles", -480)];
    expect(plan("2026-11-02", LAX, lax).deload).toEqual({ active: true, until: "2026-11-09" });
    expect(plan("2026-11-09", LAX, lax).deload.active).toBe(false);
  });

  it("the newest session's zone wins", () => {
    const m = meta(deload(AKL));
    const history = [rec("Pacific/Auckland", 780, "2026-10-28"), rec("UTC", 0, "2026-10-30")];
    expect(inDeload("2026-11-01", m, history)).toBe(true);
    expect(inDeload("2026-11-01", m, [...history].reverse())).toBe(true);
  });

  it("a session with only its offset, or a zone the runtime doesn't know, reads by its offset", () => {
    const m = meta(deload(AKL));
    for (const history of [[rec(null, 780)], [rec("Mars/Olympus_Mons", 780)]]) {
      expect(inDeload("2026-11-01", m, history)).toBe(false);
      expect(inDeload("2026-11-02", m, history)).toBe(true);
    }
  });

  it("with no zone on any session, the window reads as before: the server's own day", () => {
    const m = meta(deload(AKL));
    for (const history of [[], [rec(null, null)], [rec(undefined, undefined)]]) {
      expect(inDeload("2026-11-01", m, history)).toBe(true);
      expect(inDeload("2026-11-08", m, history)).toBe(false);
    }
  });

  it("nothing is written back: the stored deload is left as it was", () => {
    const m = meta(deload(AKL));
    const before = JSON.stringify(m);
    programme("2026-11-02", m, [rec("Pacific/Auckland", 780)]);
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe("a deload accepted from now on", () => {
  const signal = { type: "stall_convergence", lifts: [SQUAT] };
  const accept = (zone, at) => inZone(zone, () => startDeload({ lifts, mesocycle: { deloadSignals: {} } }, signal), at);

  it("carries the lifter's own start date beside the instant", () => {
    const akl = accept("Pacific/Auckland", AKL).mesocycle.activeDeload;
    expect(akl).toMatchObject({ startedAt: AKL, startDate: "2026-11-02", plannedDays: 7 });
    const lax = accept("America/Los_Angeles", LAX).mesocycle.activeDeload;
    expect(lax).toMatchObject({ startedAt: LAX, startDate: "2026-11-02", plannedDays: 7 });
  });

  it("the server reads its window from startDate, with or without a zone on any session", () => {
    const m = { ...meta(null), trainingState: accept("Pacific/Auckland", AKL) };
    for (const history of [[], [rec("UTC", 0)]]) {
      expect(inDeload("2026-11-01", m, history)).toBe(false);
      expect(inDeload("2026-11-02", m, history)).toBe(true);
      expect(inDeload("2026-11-09", m, history)).toBe(false);
    }
  });
});

describe("deloadWindow", () => {
  it("without startDate, the day of startedAt in the process's zone, as before", () => {
    expect(inZone("Pacific/Auckland", () => deloadWindow(deload(AKL)))).toEqual({ start: "2026-11-02", end: "2026-11-09", days: 7 });
    expect(inZone("UTC", () => deloadWindow(deload(AKL)))).toEqual({ start: "2026-11-01", end: "2026-11-08", days: 7 });
    expect(inZone("America/Los_Angeles", () => deloadWindow(deload(LAX)))).toEqual({ start: "2026-11-02", end: "2026-11-09", days: 7 });
  });

  it("with startDate, that day in any zone; a malformed one is ignored", () => {
    for (const zone of ["UTC", "Pacific/Auckland", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      expect(inZone(zone, () => deloadWindow(deload(AKL, { startDate: "2026-11-02" })))).toEqual({ start: "2026-11-02", end: "2026-11-09", days: 7 });
    }
    expect(inZone("UTC", () => deloadWindow(deload(AKL, { startDate: "2 Nov" })))).toEqual({ start: "2026-11-01", end: "2026-11-08", days: 7 });
    expect(inZone("UTC", () => deloadWindow({ startDate: "2026-11-02", plannedDays: 7 }))).toBe(null);
  });
});
