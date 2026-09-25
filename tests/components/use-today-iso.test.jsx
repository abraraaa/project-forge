// @vitest-environment jsdom
// useTodayIso — the home week's "today" rolls over with the calendar, not
// with a remount. An app left open over Sun→Mon must read the new week.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useTodayIso } from "../../lib/use-today-iso.js";

function Probe() { return <span data-testid="today">{useTodayIso()}</span>; }

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
});
