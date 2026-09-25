// @vitest-environment jsdom
// ConsistencyCells (Performance Lab) on weeklyStrength: each week judged by
// the schedule in force that week, this week's days still to come drawn as
// ahead (not missed), breather days as rest cells, history-only done.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import PerformanceLab from "../../components/PerformanceLab.jsx";
import { W } from "../../lib/storage.js";

const wk = (...types) => types.map((type) => ({ type }));
const THREE = wk("strength", "cardio", "strength", "cardio", "strength", "zone2", "rest");
const TWO = wk("rest", "strength", "rest", "rest", "rest", "strength", "rest");
const rec = (date) => ({ id: `${date}T10:00:00.000`, date, session: "strength-a", readiness: "normal", blocks: [] });

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00")); // Wed
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

const cells = (mondayIso) => [...document.querySelectorAll(`[data-week="${mondayIso}"] [data-cell]`)]
  .map((el) => el.getAttribute("data-cell"));

describe("ConsistencyCells", () => {
  it("per-week quota across a schedule edit, a breather week, and a partial current week", () => {
    W.save(THREE, { effectiveFrom: "2026-01-05" });
    W.save(TWO, { effectiveFrom: "2026-09-14" });
    const breaks = [{ id: "b", start: "2026-09-07", endedAt: "2026-09-14" }];
    // Tue this week trained.
    render(<PerformanceLab history={[rec("2026-08-31"), rec("2026-09-22")]} breaks={breaks} onBack={() => {}} />);

    expect(cells("2026-08-31")).toEqual(["done", "missed", "missed"]);   // three-day week then
    expect(cells("2026-09-07")).toEqual(["resting", "resting", "resting"]); // breather, not zero
    expect(cells("2026-09-14")).toEqual(["missed", "missed"]);           // two-day week from the edit
    expect(cells("2026-09-21")).toEqual(["done", "ahead"]);              // Sat still to come
    // 5 three-day weeks + 2 + 1 due so far; the breather and Sat aren't planned yet.
    expect(screen.getByText(/planned/).textContent).toBe("2 of 18 planned");
    expect(screen.getByLabelText(/2 of 18 planned sessions completed across 8 weeks, 1 still to come this week, 3 set aside for a breather/)).toBeTruthy();
  });
});
