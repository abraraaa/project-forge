// @vitest-environment jsdom
// A power lift is planned at RPE 7: it adds only at RIR 3, so the target the
// screens print is the effort at which it moves. Home's row and the session's
// effort panel both open there.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { SessionScreen } from "../../components/SessionScreen.jsx";
import { WEEK, SESSIONS } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const flat = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

function homeOn(dayIdx) {
  const ctx = makeDayContext({ todayIso: DAYS[dayIdx], weekFor: () => MWF });
  const week = resolveRange(ctx, DAYS[0], DAYS[6]);
  const strengthDaySessions = sessionsFrom(week);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${DAYS[dayIdx]}T09:00:00`));
  render(<HomeScreen rhythm={{ completed: 0, expected: 0, ratio: 0 }} profileName="t"
    userWeek={week.map((d) => d.shown)} strengthDaySessions={strengthDaySessions}
    dayStates={week.map((d) => ({ status: d.status, coveredBy: d.coveredBy }))}
    workingWeights={{}} liftStates={{}} activeDeload={null} />);
  return SESSIONS[strengthDaySessions[dayIdx]];
}

const rowOf = (name) => flat(screen.getByText(name).parentElement.parentElement.textContent);

describe("Home prints a power lift's target at RPE 7", () => {
  it("the power day's main lift reads rpe 7; a strength main lift still reads rpe 8", () => {
    const sessions = homeOn(0);
    const seen = {};
    for (const day of ["Monday", "Wednesday", "Friday"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${day}`) }));
      const main = SESSIONS.flatMap((x) => x.blocks).filter((b) => b.type === "main").map((b) => b.ex.name)
        .find((n) => screen.queryByText(n));
      seen[main] = rowOf(main);
    }
    void sessions;
    expect(seen["Power Clean"], JSON.stringify(seen)).toMatch(/rpe 7$/);
    const others = Object.keys(seen).filter((n) => n !== "Power Clean");
    expect(others.length).toBeGreaterThan(0);
    for (const n of others) expect(seen[n], n).toMatch(/rpe 8$/);
  });
});

describe("finishers are planned at RPE 8, where the engine adds", () => {
  it("every finisher row on Home reads rpe 8", () => {
    homeOn(0);
    for (const day of ["Monday", "Wednesday", "Friday"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${day}`) }));
      const rows = screen.queryAllByText((_, el) => !!el && el.tagName === "DIV" && / ↔ /.test(el.textContent) && el.children.length === 0);
      const finisher = SESSIONS.flatMap((x) => x.blocks).filter((b) => b.type === "finisher")
        .map((b) => `${b.exA.name} ↔ ${b.exB.name}`).find((n) => rows.some((r) => r.textContent === n));
      expect(finisher, day).toBeTruthy();
      expect(rowOf(finisher), day).toMatch(/rpe 8$/);
    }
  });
  it("plannedRpe says 8 for a finisher", async () => {
    const { plannedRpe } = await import("../../lib/lift-translations.js");
    expect(plannedRpe("finisher", "Face Pull")).toBe(8);
  });
});

describe("the session's effort panel opens at the target", () => {
  const base = (ex) => {
    const block = { id: "main", type: "main", label: "Main lift", sets: 4, rest: 120, ex };
    return {
      session: { name: "Strength C", blocks: [block] }, block, blockIdx: 0, totalBlocks: 2,
      setNum: 1, phase: "A", isSS: false,
      activeEx: ex, resolvedExA: null, resolvedExB: null, resolvedEx: ex,
      swapKey: block.id, onSwap: () => {},
      showVid: false, setShowVid: () => {}, getW: (e) => e?.weight ?? null, getR: (e) => e?.reps ?? null,
      editTarget: null, setEditTarget: () => {},
      planWeights: {}, setPlanWeights: () => {}, planReps: {}, setPlanReps: () => {},
      history: [], loggedSets: [], awaitRpe: true, ssRoundDone: false,
      restActive: false, restRemain: 90, setRestActive: () => {}, setRestRemain: () => {},
      onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {},
      bodyweight: 80, canReach: false, reachStep: 2.5, reachArmed: false,
      onTakeReach: () => {}, onDeclineReach: () => {}, nextExName: null, onNext: () => {},
    };
  };
  it("Power Clean opens at 7", () => {
    render(<SessionScreen {...base({ name: "Power Clean", muscle: "Full body", reps: 3, weight: 60, loadType: "barbell" })} />);
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("7");
  });
  it("a squat still opens at 8", () => {
    render(<SessionScreen {...base({ name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "barbell" })} />);
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("8");
  });
});
