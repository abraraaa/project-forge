// @vitest-environment jsdom
// PerformanceLab — the share glyph inside a lift row, and the all-time
// "Best:" line in the lift drill-down.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("../../lib/share-card.js", () => ({
  renderShareCard: vi.fn(async () => ({})),
  shareCanvas: vi.fn(async () => {}),
}));

import PerformanceLab from "../../components/PerformanceLab.jsx";
import { renderShareCard, shareCanvas } from "../../lib/share-card.js";
import { addDaysIso, todayLocalIso } from "../../lib/dates.js";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const today = todayLocalIso();
const daysAgo = (n) => addDaysIso(today, -n);

function session(date, exercises, readiness = "normal") {
  return { v: 2, id: `${date}T10:00:00.000Z`, date, readiness, session: "strength A",
    blocks: [{ id: "main", type: "main", exercises }] };
}
const squat = (weight, reps) => ({ name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell",
  sets: [{ weight, reps }, { weight, reps }] });

const rowFor = (lift) => screen.getByRole("button", { name: new RegExp(`^${lift}: estimated 1RM`) });
const open = (lift) => fireEvent.click(rowFor(lift));

describe("PerformanceLab — share glyph", () => {
  const history = [session(daysAgo(2), [squat(100, 5)]), session(daysAgo(6), [squat(95, 5)])];

  it("shares without toggling the row", async () => {
    render(<PerformanceLab history={history} onBack={() => {}} />);
    const row = rowFor("Barbell Back Squat");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Share Barbell Back Squat trend" }));
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(renderShareCard).toHaveBeenCalledTimes(1);
    expect(renderShareCard.mock.calls[0][0].lift).toBe("Barbell Back Squat");
    await vi.waitFor(() => expect(shareCanvas).toHaveBeenCalledTimes(1));

    open("Barbell Back Squat");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Share Barbell Back Squat trend" }));
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps Enter and Space on the share glyph away from the row", () => {
    render(<PerformanceLab history={history} onBack={() => {}} />);
    const share = screen.getByRole("button", { name: "Share Barbell Back Squat trend" });
    fireEvent.keyDown(share, { key: "Enter" });
    fireEvent.keyDown(share, { key: " " });
    expect(rowFor("Barbell Back Squat").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("PerformanceLab — personal best line", () => {
  it("shows the max e1RM across all history, older than the trend window included", () => {
    const oldIso = "2025-03-03";
    const history = [
      session(oldIso, [squat(120, 5)]),          // e1RM 140, last year
      session(daysAgo(40), [squat(110, 3)]),
      session(daysAgo(3), [squat(115, 2)]),
    ];
    render(<PerformanceLab history={history} onBack={() => {}} />);
    // Collapsed row: no best line.
    expect(screen.queryByTestId("lift-best")).toBeNull();
    open("Barbell Back Squat");
    const line = screen.getByTestId("lift-best").textContent;
    expect(line).toBe("Best: 120 kg × 5 · 3 Mar 2025");
  });

  it("drops the year this year and marks a best inside the last four weeks quietly", () => {
    const iso = daysAgo(5);
    const history = [session(daysAgo(60), [squat(100, 5)]), session(iso, [squat(110, 5)])];
    render(<PerformanceLab history={history} onBack={() => {}} />);
    open("Barbell Back Squat");
    const line = screen.getByTestId("lift-best").textContent;
    const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" })
      .format(new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
    const year = iso.slice(0, 4) === today.slice(0, 4) ? "" : ` ${iso.slice(0, 4)}`;
    expect(line).toBe(`Best: 110 kg × 5 · ${day}${year} · this block`);
    expect(line).not.toMatch(/!/);
  });

  it("reads a loaded bodyweight best as bodyweight plus the added kg", () => {
    const history = [session(daysAgo(50), [{ name: "Weighted Pull-Up", muscle: "Lats",
      sets: [{ weight: 10, reps: 8 }, { weight: 5, reps: 8 }] }])];
    render(<PerformanceLab history={history} onBack={() => {}} />);
    open("Weighted Pull-Up");
    expect(screen.getByTestId("lift-best").textContent).toMatch(/^Best: bodyweight \+ 10 kg × 8 · /);
  });

  it("reads a pure bodyweight best as reps only", async () => {
    // A pure bodyweight lift has no e1RM, so it never earns a Lab row of
    // its own; the line's reps-only form is checked on the component.
    const { __test__: { BestLine } } = await import("../../components/PerformanceLab.jsx");
    render(<BestLine todayIso={today} best={{ date: daysAgo(40), est1RM: null, weight: null, reps: 20, loadType: "bodyweight" }}/>);
    expect(screen.getByTestId("lift-best").textContent).toMatch(/^Best: 20 reps · /);
  });

  it("prints no best line for a lift with no logged sets", () => {
    const history = [
      session(daysAgo(3), [squat(100, 5), { name: "Romanian Deadlift", muscle: "Hamstrings", loadType: "barbell",
        sets: [{ weight: null, reps: null }] }]),
    ];
    render(<PerformanceLab history={history} onBack={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Romanian Deadlift:/ })).toBeNull();
    open("Barbell Back Squat");
    expect(screen.getAllByTestId("lift-best")).toHaveLength(1);
  });
});
