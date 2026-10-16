// @vitest-environment jsdom
// The home day card: what the viewed day offers (Begin, Mark complete, notes),
// the unfinished-session card, and the one re-anchoring clock the header and
// the week strip share across midnight (#55).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Profiler } from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { WEEK, SESSIONS, EXERCISE_POOLS } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");

// Mon 21 – Sun 27 Sep 2026, resolved the way ForgeApp resolves it.
function weekProps(weekTypes = MWF) {
  const ctx = makeDayContext({ todayIso: "2026-09-25", weekFor: () => weekTypes });
  const week = resolveRange(ctx, "2026-09-21", "2026-09-27");
  return {
    rhythm: { completed: 0, expected: 0, ratio: 0 },
    profileName: "t",
    userWeek: week.map((d) => d.shown),
    strengthDaySessions: sessionsFrom(week),
    dayStates: week.map((d) => ({ status: d.status, coveredBy: d.coveredBy })),
  };
}

const home = (props = {}, weekTypes) => <HomeScreen {...weekProps(weekTypes)} {...props} />;

describe("home day card — what the viewed day offers", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); }); // Fri 25 Sep

  it("a strength day today shows the session stats, and Begin fires once", () => {
    const onBegin = vi.fn();
    const props = weekProps();
    render(<HomeScreen {...props} onBegin={onBegin} />);
    const blocks = screen.getByText("blocks");
    expect(blocks.previousSibling.textContent).toBe(String(SESSIONS[props.strengthDaySessions[4]].blocks.length));
    fireEvent.click(screen.getByText("Begin"));
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it("today's session already done shows the completion line instead of Begin", () => {
    render(home({ weekDone: { 4: true } }));
    expect(screen.getByText(/^Session complete\./)).toBeTruthy();
    expect(screen.queryByText("Begin")).toBeNull();
  });

  it("tapping another day shows its notes, with nothing to begin", () => {
    render(home());
    fireEvent.click(screen.getByRole("button", { name: "Saturday" }));
    expect(screen.getByText("Session notes")).toBeTruthy();
    expect(screen.queryByText("Begin")).toBeNull();
    expect(screen.queryByText("Mark complete")).toBeNull();
  });

  it("a non-strength day today is marked complete against today's local date", () => {
    const onMarkDayDone = vi.fn();
    render(home({ onMarkDayDone }, wk("strength", "rest", "strength", "rest", "cardio", "strength", "rest")));
    expect(screen.queryByText("Begin")).toBeNull();
    fireEvent.click(screen.getByText("Mark complete"));
    expect(onMarkDayDone).toHaveBeenCalledTimes(1);
    expect(onMarkDayDone).toHaveBeenCalledWith("2026-09-25");
  });

  it("an unfinished session offers Resume and Discard, each wired to its own callback", () => {
    const onResumeDraft = vi.fn();
    const onDiscardDraft = vi.fn();
    render(home({ pendingDraft: { setCount: 3, ageMs: 20 * 60_000 }, onResumeDraft, onDiscardDraft }));
    expect(screen.getByText("Pick up where you left off.")).toBeTruthy();
    expect(screen.getByText(/sets logged · 20 min ago/)).toBeTruthy();
    fireEvent.click(screen.getByText("Resume"));
    expect(onResumeDraft).toHaveBeenCalledTimes(1);
    expect(onDiscardDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Discard"));
    expect(onDiscardDraft).toHaveBeenCalledTimes(1);
  });
});

// #55: the header date and the strip's "(today)" read ONE anchor, which moves
// only when the calendar day changes (minute tick / focus / visibility).
describe("home clock — header and strip roll over together (#55)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] }); });

  it("past midnight both stay on Friday until the re-anchor tick, then both move to Saturday", () => {
    vi.setSystemTime(new Date(2026, 8, 25, 23, 59, 30)); // Fri 25 Sep, 30s to midnight
    const { rerender } = render(home());
    expect(screen.getByText("25 September 2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Friday (today)" })).toBeTruthy();

    // 00:00:10 — past midnight, before the 60s tick. A re-render must not
    // let the header read the wall clock on its own.
    act(() => { vi.advanceTimersByTime(40_000); });
    rerender(home({ profileName: "u" }));
    expect(screen.getByText("25 September 2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Friday (today)" })).toBeTruthy();

    // 00:00:40 — the tick has re-anchored.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText("26 September 2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Saturday (today)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Friday (today)" })).toBeNull();
  });

  it("same-day ticks keep the anchor, so the screen does not re-commit every minute", () => {
    vi.setSystemTime(new Date(2026, 8, 25, 9, 0));
    let commits = 0;
    render(<Profiler id="home" onRender={() => { commits += 1; }}>{home()}</Profiler>);
    act(() => { vi.advanceTimersByTime(1_000); }); // let the fade-ins settle
    const settled = commits;
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(commits).toBe(settled);
  });
});

// The day card prints what the session will open with: the live rep target
// and working weight, not the programme template.
describe("home day card — rows read the live prescription", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); }); // Fri 25 Sep

  const rowFor = (name) => screen.getByText(name).nextSibling.textContent;

  // Today's session is A (Back Squat 3 × 5 from 55 kg in the template).
  it("a stored target and working weight print as the session shows them", () => {
    render(home({ workingReps: { "Barbell Back Squat": 7 }, workingWeights: { "Barbell Back Squat": 162.5 } }));
    expect(rowFor("Barbell Back Squat")).toBe("3 × 7 at 162.5 kg");
    expect(document.body.textContent).not.toMatch(/× 5 from 55 kg/);
  });

  it("a lift with no working weight prints from its planned start, not the template", () => {
    render(home({ bodyweight: 80 }));
    expect(rowFor("Barbell Bench Press")).toBe("3 × 5 from 52.5 kg");
  });

  it("a target the session would repair prints repaired", () => {
    render(home({ workingReps: { "Barbell Back Squat": 3 }, workingWeights: { "Barbell Back Squat": 140 } }));
    expect(rowFor("Barbell Back Squat")).toBe("3 × 5 at 140 kg");
  });

  it("a pure bodyweight lift prints no weight, even beside a loaded partner", () => {
    render(home({ workingWeights: { "Landmine Press": 30 } }));
    expect(rowFor("45-Degree Hip Extension ↔ Landmine Press")).toBe("3 × 15");
  });

  it("a per-dumbbell row prints its per-side target and the dumbbell weight", () => {
    render(home({ workingWeights: { "DB Reverse Lunge": 18 } }));
    expect(rowFor("DB Reverse Lunge ↔ Chest-Supported DB Row")).toBe("3 × 8/leg at 18 kg");
  });

  it("a timed hold prints seconds and no weight", () => {
    const hold = EXERCISE_POOLS["afin-A"].pool.find((ex) => ex.name === "L-Sit Hold");
    render(home({ programmeBlock: { config: { "afin-A": hold } } }));
    expect(rowFor("L-Sit Hold ↔ Standing Calf Raise")).toBe("4 × 20s");
  });
});
