// @vitest-environment jsdom
// The home header's name is the way into Profile: it says so ("Profile"
// kicker over the name), names itself for assistive tech, and still opens it.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { WEEK } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); });

const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
function weekProps() {
  const ctx = makeDayContext({ todayIso: "2026-09-25", weekFor: () => MWF });
  const week = resolveRange(ctx, "2026-09-21", "2026-09-27");
  return {
    rhythm: { completed: 0, expected: 0, ratio: 0 },
    profileName: "sam",
    userWeek: week.map((d) => d.shown),
    strengthDaySessions: sessionsFrom(week),
    dayStates: week.map((d) => ({ status: d.status, coveredBy: d.coveredBy })),
  };
}
const home = (props = {}) => <HomeScreen {...weekProps()} {...props} />;

describe("home header — the Profile entry", () => {
  it("is labelled Profile and shows the name under a Profile kicker", () => {
    render(home());
    const btn = screen.getByRole("button", { name: "Profile, sam" });
    const kicker = within(btn).getByText("Profile");
    const name = within(btn).getByText("sam");
    expect(kicker.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens Profile on tap", () => {
    const onProfile = vi.fn();
    render(home({ onProfile }));
    fireEvent.click(screen.getByRole("button", { name: /^Profile,/ }));
    expect(onProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps the sync dot beside the name", () => {
    render(home({ syncState: "error" }));
    const name = within(screen.getByRole("button", { name: "Profile, sam" })).getByText("sam");
    expect(name.parentElement.querySelectorAll('span[style*="border-radius: 50%"]')).toHaveLength(1);
  });

  it("a long name ellipsises and the kicker never wraps", () => {
    const long = "a-very-long-name-that-would-otherwise-run-into-the-date-column";
    render(home({ profileName: long }));
    const btn = screen.getByRole("button", { name: `Profile, ${long}` });
    expect(btn.style.minWidth).toBe("0px");
    const name = within(btn).getByText(long);
    expect(name.style.textOverflow).toBe("ellipsis");
    expect(name.style.whiteSpace).toBe("nowrap");
    expect(within(btn).getByText("Profile").style.whiteSpace).toBe("nowrap");
  });
});
