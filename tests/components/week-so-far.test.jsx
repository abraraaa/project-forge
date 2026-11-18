// @vitest-environment jsdom
// The current week is the week so far (lib/chart-style.js): Home's tonnage
// line and the Lab's volume sparklines draw it as a faint point off the
// line, and never state it as a drop against last week.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import PerformanceLab from "../../components/PerformanceLab.jsx";
import { SO_FAR, splitWeekSoFar, weekSoFarDelta, RULES } from "../../lib/chart-style.js";
import { WEEK } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";

const homeProps = () => {
  const week = resolveRange(makeDayContext({ todayIso: "2026-11-17", weekFor: () => WEEK }), "2026-11-16", "2026-11-22");
  return {
    rhythm: { completed: 0, expected: 0, ratio: 0 }, profileName: "t",
    userWeek: week.map((d) => d.shown), strengthDaySessions: sessionsFrom(week),
    dayStates: week.map((d) => ({ status: d.status, coveredBy: d.coveredBy })),
  };
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

const squat = (date) => ({
  v: 2, id: `${date}T10:00:00.000Z`, date, readiness: "normal", session: "strength-a",
  blocks: [{ id: "a1", type: "main", exercises: [{
    name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell",
    sets: Array.from({ length: 3 }, () => ({ weight: 100, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 100, volume: 500 })),
  }] }],
});

// Today Tuesday 17 November 2026. Last week three sessions; this week one.
const HISTORY = ["2026-10-27", "2026-10-29", "2026-11-03", "2026-11-05", "2026-11-09", "2026-11-11", "2026-11-13", "2026-11-16"].map(squat);

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 17, 9, 0)); });

describe("the shared rule", () => {
  it("splits off the week so far and states no drop", () => {
    expect(splitWeekSoFar([3, 5, 1])).toEqual({ done: [3, 5], soFar: 1 });
    expect(splitWeekSoFar([])).toEqual({ done: [], soFar: null });
    expect(weekSoFarDelta([5, 1])).toBeNull();
    expect(weekSoFarDelta([5, 5])).toBe(0);
    expect(weekSoFarDelta([5, 7])).toBe(2);
    expect(SO_FAR).toEqual({ opacity: 0.45, label: "so far" });
    expect(RULES.some((r) => r.includes("so far"))).toBe(true);
  });
});

describe("the Lab's volume sparklines", () => {
  it("draw the week so far faint and never print a fall against last week", () => {
    const { container } = render(<PerformanceLab history={HISTORY} onBack={() => {}} />);
    expect(container.textContent).not.toMatch(/[−-]\d+(\.\d+)? vs last wk/);
    expect(screen.getAllByText("so far").length).toBeGreaterThan(0);
    const ghosts = container.querySelectorAll("circle[data-so-far]");
    expect(ghosts.length).toBeGreaterThan(0);
    for (const g of ghosts) {
      expect(g.getAttribute("opacity")).toBe("0.45");
      expect(g.getAttribute("fill")).toBe("var(--ink-3)");
    }
  });
});

describe("Home's tonnage line", () => {
  it("ends at the last finished week and draws this week as a faint point labelled so far", () => {
    const { container } = render(<HomeScreen {...homeProps()} history={HISTORY} />);
    expect(container.textContent.replace(/\s+/g, " ")).toMatch(/Tonnage, six weeks\S* ?1[.,]5\S* ?\S* so far/);
    const ghost = container.querySelector("circle[data-so-far]");
    expect(ghost.getAttribute("opacity")).toBe("0.45");
    expect(ghost.getAttribute("fill")).toBe("var(--ink-3)");
    expect(ghost.getAttribute("cx")).toBe("342.0");
    const path = container.querySelector("path[stroke='url(#hwHomeWave)']");
    expect(path.getAttribute("d")).not.toContain("342.0");
  });
});
