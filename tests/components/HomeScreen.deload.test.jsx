// @vitest-environment jsdom
// Home during a deload: the session list shows the deload weight the card
// will open with. None of it without one.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { WEEK, SESSIONS } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");

// Mon 21 – Sun 27 Sep 2026; today Fri 25, the deload accepted Wed 23.
function props(deload) {
  const ctx = makeDayContext({ todayIso: "2026-09-25", weekFor: () => MWF });
  const week = resolveRange(ctx, "2026-09-21", "2026-09-27");
  const strengthDaySessions = sessionsFrom(week);
  const main = SESSIONS[strengthDaySessions[4]].blocks.find((b) => b.type === "main").ex.name;
  return {
    main,
    rhythm: { completed: 0, expected: 0, ratio: 0 },
    profileName: "t",
    userWeek: week.map((d) => d.shown),
    strengthDaySessions,
    dayStates: week.map((d) => ({ status: d.status, coveredBy: d.coveredBy })),
    workingWeights: { [main]: 100 },
    liftStates: { [main]: { currentWeight: 100, history: [], currentRepRange: { reps: 5, sets: 3, baseReps: 5 } } },
    activeDeload: deload
      ? { startedAt: new Date(2026, 8, 23, 8, 0).toISOString(), plannedDays: 5, preDeloadWeights: { [main]: 100 } }
      : null,
  };
}

const flat = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const rowOf = (name) => flat(screen.getByText(name).parentElement.textContent);

describe("Home inside a deload", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); });

  it("today's card shows the deload weight", () => {
    const { main, ...p } = props(true);
    render(<HomeScreen {...p} />);
    expect(rowOf(main)).toContain("at 65 kg");
  });
});

describe("Home with no deload", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); });

  it("shows W and never mentions a deload", () => {
    const { main, ...p } = props(false);
    const { container } = render(<HomeScreen {...p} />);
    expect(container.textContent.toLowerCase()).not.toContain("deload");
    expect(container.innerHTML.toLowerCase()).not.toContain("deload");
    expect(rowOf(main)).toContain("at 100 kg");
  });
});
