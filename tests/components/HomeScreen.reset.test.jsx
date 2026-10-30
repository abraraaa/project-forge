// @vitest-environment jsdom
// Home's "Reset accessories to defaults" link is offered only when a reset
// would change the week. A reset that has to re-plan (Strong with Romanian
// Deadlift leaves the template under MEV on Quads) lands on a seeded week,
// and a block holding that week is where a reset lands, not drift.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { WEEK } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";
import { P, PB, F } from "../../lib/storage.js";
import { resetProgrammeCore, saveMainLiftCore } from "../../lib/profile-actions.js";
import { solveRotation } from "../../lib/rotation-solver.js";

const HINGE = "Hex Bar Deadlift";
const RDL = "Romanian Deadlift";
const SQUAT = "Barbell Back Squat";
const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 29, 9, 0));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  localStorage.clear(); P.add("sam"); P.setActive("sam");
  F.save("sam", "Strong"); P.setMainLift("sam", HINGE, RDL);
});

const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
function weekProps() {
  const ctx = makeDayContext({ todayIso: "2026-10-29", weekFor: () => MWF });
  const week = resolveRange(ctx, "2026-10-26", "2026-11-01");
  return {
    rhythm: { completed: 0, expected: 0, ratio: 0 },
    profileName: "sam",
    userWeek: week.map((d) => d.shown),
    strengthDaySessions: sessionsFrom(week),
    dayStates: week.map((d) => ({ status: d.status, coveredBy: d.coveredBy })),
  };
}
// Home as ForgeApp hands it the stored block, focus and main lifts.
const home = () => (
  <HomeScreen {...weekProps()} programmeBlock={PB.get()} userFocus={F.get("sam")} mainLifts={P.getMainLifts("sam")} />
);
const resetLink = () => screen.queryByRole("button", { name: "Reset accessories to defaults" });
// The solve behind the link runs off the first paint (an idle callback, a
// timeout here); let it land before reading the screen.
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));
const rotatedBlock = () => PB.save({
  number: 4, startDate: "2026-10-26", history: {},
  config: solveRotation({ history: {}, focus: "Strong", mainLifts: { [HINGE]: RDL }, rng: mulberry(7) }).config,
});

describe("the reset accessories link", () => {
  it("a rotated week offers it", async () => {
    rotatedBlock();
    render(home());
    await settled();
    expect(resetLink()).toBeTruthy();
  });

  it("after a reset that re-planned, it is gone", async () => {
    rotatedBlock();
    const { next, summary } = resetProgrammeCore("sam");
    expect(summary?.reason).toBe("reset");
    expect(Object.keys(next.config).length).toBeGreaterThan(0);
    render(home());
    await settled();
    expect(resetLink()).toBeNull();
  });

  it("that week under the default hinge is drift: a reset there lands on the template", async () => {
    rotatedBlock();
    resetProgrammeCore("sam");
    P.setMainLift("sam", HINGE, null);
    render(home());
    await settled();
    expect(resetLink()).toBeTruthy();
  });

  it("a main lift chosen and set back to its default leaves it gone", async () => {
    P.saveMainLiftsRaw("sam", {}, {});
    PB.save({ number: 4, startDate: "2026-10-26", config: {}, history: {} });
    expect(saveMainLiftCore("sam", HINGE, RDL).summary?.report.outOfBand).toEqual([]);
    const week = PB.get().config;
    saveMainLiftCore("sam", SQUAT, "Front Squat");
    saveMainLiftCore("sam", SQUAT, null);
    expect(P.getMainLifts("sam")).toEqual({ [HINGE]: RDL, [SQUAT]: SQUAT });
    expect(PB.get().config).toEqual(week);
    render(home());
    await settled();
    expect(resetLink()).toBeNull();
  });

  it("the plain template offers nothing to reset", async () => {
    PB.save({ number: 4, startDate: "2026-10-26", config: {}, history: {} });
    render(home());
    await settled();
    expect(resetLink()).toBeNull();
  });
});
