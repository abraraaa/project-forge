// @vitest-environment jsdom
// Home during a deload: the day in view carries the session view's own tag
// (deloadDayLabel), the week strip names the deload days, and the session
// list shows the deload weight the card will open with. None of it without one.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { T } from "../../lib/tokens.js";
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

  it("today's card carries the session view's tag and the deload weight", () => {
    const { main, ...p } = props(true);
    const { container } = render(<HomeScreen {...p} />);
    expect(flat(container.textContent)).toContain("Today · deload, day 3 of 5");
    // The word itself is ink, underlined 1px in the day's key.
    const word = [...container.querySelectorAll("span")].find((s) => s.textContent === "deload");
    expect(word.style).toMatchObject({ color: T.ink, textDecorationLine: "underline", textDecorationColor: T.dayKey.strength, textDecorationThickness: "1px", textUnderlineOffset: "3px" });
    // Numerals in the mono face; one line, no separate tag.
    expect(word.parentElement.querySelectorAll(`span[style*="font-family"]`).length).toBe(2);
    expect(rowOf(main)).toContain("at 65 kg");
  });

  it("the week names the deload days, and a day outside it carries no tag", () => {
    const { main: _main, ...p } = props(true);
    const { container } = render(<HomeScreen {...p} />);
    expect(screen.getByRole("button", { name: "Wednesday, deload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Saturday, deload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Monday" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Monday" }));
    expect(flat(container.textContent)).not.toContain("deload");
    fireEvent.click(screen.getByRole("button", { name: "Wednesday, deload" }));
    expect(flat(container.textContent)).toContain("deload, day 1 of 5");
  });
});

describe("Home with no deload", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); });

  it("shows W and never mentions a deload", () => {
    const { main, ...p } = props(false);
    const { container } = render(<HomeScreen {...p} />);
    expect(container.textContent.toLowerCase()).not.toContain("deload");
    expect(container.innerHTML.toLowerCase()).not.toContain("deload");
    expect(container.innerHTML).not.toContain("underline");
    expect(rowOf(main)).toContain("at 100 kg");
  });
});

describe("decisions sit above Begin", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); });

  it("the Unfinished session card and the deload offer come just under the masthead, before the session and Begin", () => {
    const { main: _main, ...p } = props(false);
    render(<HomeScreen {...p} pendingDraft={{ setCount: 2, ageMs: 60000 }}
      deloadOffer={{ type: "stall_convergence", lifts: ["Barbell Back Squat", "Barbell Bench Press"] }} />);
    const order = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    const headline = screen.getByRole("heading", { level: 1 });
    const unfinished = screen.getByText("Unfinished session");
    const offer = screen.getByText("Run the deload");
    const begin = screen.getByText("Begin");
    expect(order(headline, unfinished)).toBeTruthy();
    expect(order(unfinished, offer)).toBeTruthy();
    expect(order(offer, begin)).toBeTruthy();
  });
});

describe("the deload offer's copy", () => {
  it("opens with the lift name capitalised, and no em dash", async () => {
    const { deloadCardCopy } = await import("../../lib/progression.js");
    const { body } = deloadCardCopy({ type: "stall_convergence", lifts: ["Barbell Back Squat", "Barbell Bench Press"] });
    expect(body.startsWith("Barbell back squat and barbell bench press have both held")).toBe(true);
    expect(body).not.toContain("—");
  });
});

describe("Home for a newcomer and a returner", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); });
  const rec = (date) => ({ v: 2, id: `${date}T10:00:00.000Z`, date, session: "strength-a", blocks: [] });

  it("the first three sessions carry one line on what rpe 8 asks", () => {
    const { main: _m, ...p } = props(false);
    const gloss = "rpe 8 means about two reps left in the tank.";
    const { container, rerender } = render(<HomeScreen {...p} historyCount={2} />);
    expect(flat(container.textContent)).toContain(gloss);
    const line = [...container.querySelectorAll("div")].find((d) => flat(d.textContent) === gloss);
    expect(line.style.color).toBe(T.ink2);
    rerender(<HomeScreen {...p} historyCount={3} />);
    expect(flat(container.textContent)).not.toContain(gloss);
  });

  it("the first strength day after 10 or more days off says how long it has been", () => {
    const { main: _m, ...p } = props(false);
    const { container, rerender } = render(<HomeScreen {...p} history={[rec("2026-09-10")]} historyCount={9} />);
    expect(flat(container.textContent)).toContain("Squat & Push. First one in 15 days.");
    rerender(<HomeScreen {...p} history={[rec("2026-09-16")]} historyCount={9} />);
    expect(flat(container.textContent)).toContain("Squat & Push.");
    expect(flat(container.textContent)).not.toContain("First one in");
  });
});
