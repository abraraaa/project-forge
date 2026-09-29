// @vitest-environment jsdom
// The home passkey nudge: the card shows the consent line under its button;
// the chip opens the card rather than registering directly.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { WEEK } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";
import { CONSENT_COPY } from "../../lib/consent.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 25, 9, 0)); });

const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
function weekProps() {
  const ctx = makeDayContext({ todayIso: "2026-09-25", weekFor: () => MWF });
  const week = resolveRange(ctx, "2026-09-21", "2026-09-27");
  return {
    rhythm: { completed: 0, expected: 0, ratio: 0 },
    profileName: "t",
    userWeek: week.map((d) => d.shown),
    strengthDaySessions: sessionsFrom(week),
    dayStates: week.map((d) => ({ status: d.status, coveredBy: d.coveredBy })),
  };
}
const home = (props = {}) => <HomeScreen {...weekProps()} {...props} />;
const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("home passkey nudge — consent", () => {
  it("the card shows the line under its button, which points at it", () => {
    render(home({ pnStage: "card", onPnRegister: vi.fn() }));
    const btn = screen.getByRole("button", { name: /Set up passkey/ });
    const line = screen.getByText(CONSENT_COPY.line);
    expect(follows(btn, line)).toBe(true);
    expect(document.getElementById(btn.getAttribute("aria-describedby"))).toBe(line);
    expect(screen.getByRole("link", { name: /Full details on how we keep/ }).getAttribute("href")).toBe("/privacy");
  });

  it("the chip opens the card and never registers directly", () => {
    const onPnRegister = vi.fn();
    render(home({ pnStage: "chip", onPnRegister }));
    expect(screen.queryByText(CONSENT_COPY.line)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Secure your name across devices/ }));
    const line = screen.getByText(CONSENT_COPY.line);
    expect(line.closest('[tabindex="-1"]').contains(document.activeElement)).toBe(true);
    expect(onPnRegister).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Set up passkey/ }));
    expect(onPnRegister).toHaveBeenCalledTimes(1);
  });

  it("hidden shows no line", () => {
    render(home({ pnStage: "hidden" }));
    expect(screen.queryByText(CONSENT_COPY.line)).toBeNull();
  });
});
