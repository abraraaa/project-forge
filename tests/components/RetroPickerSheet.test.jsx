// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// RetroPickerSheet contract tests, updated for the date-keyed catch-up model.
//
//   1. Parent supplies `untickedDays` — a pre-computed list of action rows
//      (date/dateLabel/type/sessionName/action). The picker is now a pure
//      view over that list; no internal findRecentDays call, no internal
//      week-of-current-week math, no past-week guard.
//
//   2. Mark ✓ tap calls onTickDate with the row's ISO DATE STRING. The
//      old contract passed a weekday index (0..6); switching the store
//      to date-keyed makes the index obsolete and lets cross-week
//      back-marking just work.
//
//   3. Strength rows have action: "log" and fire onPick(date). Non-strength
//      rows have action: "tick" and fire onTickDate(date).
//
//   4. The picker auto-celebrates + closes when the visible list clears.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RetroPickerSheet } from "../../components/ForgeApp.jsx";

afterEach(() => {
  cleanup();
});

const z2Row = (date) => ({
  date,
  dateLabel: `Day ${date}`,
  type: "z2",
  sessionName: "Z2 — 60 min",
  action: "tick",
});
const strengthRow = (date) => ({
  date,
  dateLabel: `Day ${date}`,
  type: "strength",
  sessionName: "Strength A",
  action: "log",
});

describe("RetroPickerSheet — date-keyed catch-up", () => {
  it("renders one row per untickedDays entry", () => {
    render(
      <RetroPickerSheet
        untickedDays={[strengthRow("2026-06-13"), z2Row("2026-06-12")]}
        pendingDraft={null}
        onPick={() => {}}
        onTickDate={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("2 unmarked days")).toBeTruthy();
    expect(screen.getByText("Strength A")).toBeTruthy();
    expect(screen.getByText("Z2 — 60 min")).toBeTruthy();
  });

  it("Mark ✓ tap calls onTickDate with the row's ISO DATE STRING", () => {
    // Old contract passed a weekday index (0..6). The new store is date-keyed
    // so the picker fires the actual date, which works cross-week without
    // any current-week-only fragility.
    const onTickDate = vi.fn();
    render(
      <RetroPickerSheet
        untickedDays={[z2Row("2026-06-12")]}
        pendingDraft={null}
        onPick={() => {}}
        onTickDate={onTickDate}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByText("Mark ✓"));
    expect(onTickDate).toHaveBeenCalledTimes(1);
    expect(onTickDate.mock.calls[0][0]).toBe("2026-06-12");
  });

  it("strength row tap calls onPick with the row's ISO DATE STRING", () => {
    const onPick = vi.fn();
    render(
      <RetroPickerSheet
        untickedDays={[strengthRow("2026-06-13")]}
        pendingDraft={null}
        onPick={onPick}
        onTickDate={() => {}}
        onClose={() => {}}
      />
    );
    // The arrow is the affordance on a "log" row
    fireEvent.click(screen.getByText("→"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toBe("2026-06-13");
  });

  it("dismisses a row in place when Mark ✓ is tapped (instant feel)", () => {
    render(
      <RetroPickerSheet
        untickedDays={[z2Row("2026-06-12"), strengthRow("2026-06-13")]}
        pendingDraft={null}
        onPick={() => {}}
        onTickDate={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("2 unmarked days")).toBeTruthy();
    fireEvent.click(screen.getByText("Mark ✓"));
    // Visible state immediately reflects 1 row, even before the parent rerender
    expect(screen.getByText("1 unmarked day")).toBeTruthy();
  });

  it("disables rows when pendingDraft is present", () => {
    const onTickDate = vi.fn();
    render(
      <RetroPickerSheet
        untickedDays={[z2Row("2026-06-12")]}
        pendingDraft={{ draft: {}, ageMs: 1000, setCount: 1 }}
        onPick={() => {}}
        onTickDate={onTickDate}
        onClose={() => {}}
      />
    );
    // No tappable affordance rendered when a draft is in progress
    expect(screen.queryByText("Mark ✓")).toBeNull();
    expect(screen.getByText("Finish your live session first")).toBeTruthy();
  });
});
