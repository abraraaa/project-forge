// @vitest-environment jsdom
// The home strip reads the day resolver's status: a strength day made up
// later in the week (decision 2) and a day inside a breather draw
// differently from a plain miss.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { WEEK } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); }); // Fri 25 Sep
afterEach(() => { cleanup(); vi.useRealTimers(); });

const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
const rec = (date, letter) => ({ id: `${date}T10:00:00.000Z`, date, session: `strength_${letter}`, scheduledLetter: letter.toUpperCase() });

function renderWeek({ history = [], breaks = [] }) {
  const ctx = makeDayContext({ todayIso: "2026-09-25", history, breaks, weekFor: () => MWF });
  const week = resolveRange(ctx, "2026-09-21", "2026-09-27");
  render(
    <HomeScreen
      rhythm={{ completed: 0, expected: 0, ratio: 0 }}
      profileName="t"
      userWeek={week.map((d) => d.shown)}
      strengthDaySessions={sessionsFrom(week)}
      weekDone={Object.fromEntries(week.map((d, i) => [i, d.done]).filter(([, v]) => v))}
      dayStates={week.map((d) => ({ status: d.status, coveredBy: d.coveredBy }))}
    />,
  );
}

describe("home strip — covered and resting days", () => {
  it("a missed Wednesday made up on Tuesday gets a muted tick and says so (decision 2)", () => {
    renderWeek({ history: [rec("2026-09-21", "a"), rec("2026-09-22", "b")] });
    const wed = screen.getByRole("button", { name: "Wednesday, made up" });
    fireEvent.click(wed);
    expect(screen.getByText("Made up on Tue.")).toBeTruthy();
  });

  it("an unmade miss is neither done nor made up", () => {
    renderWeek({ history: [rec("2026-09-21", "a")] });
    expect(screen.getByRole("button", { name: "Wednesday" })).toBeTruthy();
  });

  it("days inside a breather are labelled resting", () => {
    renderWeek({ breaks: [{ id: "b", start: "2026-09-26", endedAt: null }] });
    expect(screen.getByRole("button", { name: "Saturday, resting" })).toBeTruthy();
  });
});
