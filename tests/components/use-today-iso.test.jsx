// @vitest-environment jsdom
// useTodayIso — the home week's "today" rolls over with the calendar, not
// with a remount. An app left open over Sun→Mon must read the new week.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useTodayIso, useTodayAnchor } from "../../lib/use-today-iso.js";

function Probe() { return <span data-testid="today">{useTodayIso()}</span>; }
function AnchorProbe() { const { todayIso, nowMs } = useTodayAnchor(); return <span data-testid="anchor">{`${todayIso} ${nowMs}`}</span>; }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 27, 23, 59, 30)); }); // Sun 27 Sep, local
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useTodayIso", () => {
  it("re-anchors past local midnight on the minute tick", () => {
    render(<Probe />);
    expect(screen.getByTestId("today").textContent).toBe("2026-09-27");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("today").textContent).toBe("2026-09-28");
  });

  it("re-anchors on returning to the foreground", () => {
    render(<Probe />);
    vi.setSystemTime(new Date(2026, 8, 28, 7, 0));
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByTestId("today").textContent).toBe("2026-09-28");
  });

  it("the anchor's moment holds through the day and moves with the day", () => {
    const mounted = Date.now();
    render(<AnchorProbe />);
    expect(screen.getByTestId("anchor").textContent).toBe(`2026-09-27 ${mounted}`);
    act(() => { vi.advanceTimersByTime(20_000); window.dispatchEvent(new Event("focus")); }); // 23:59:50, same day
    expect(screen.getByTestId("anchor").textContent).toBe(`2026-09-27 ${mounted}`);
    act(() => { vi.advanceTimersByTime(40_000); }); // the tick at 00:00:30
    expect(screen.getByTestId("anchor").textContent).toBe(`2026-09-28 ${mounted + 60_000}`);
  });
});
