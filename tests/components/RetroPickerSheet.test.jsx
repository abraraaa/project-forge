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
    // Reflective framing — title is descriptive ("Recent days"), no count
    // badge, no "X unmarked" framing that turns the list into a TODO to
    // clear. The session names prove both rows rendered.
    expect(screen.getByText("Recent days")).toBeTruthy();
    expect(screen.getByText("Strength A")).toBeTruthy();
    expect(screen.getByText("Z2 — 60 min")).toBeTruthy();
  });

  it("'Yes, done' tap calls onTickDate with the row's ISO DATE STRING", () => {
    // Confirms honest intent: "yes I did this" → write dayDone[date].
    // Date-keyed so cross-week back-marking works without fragility.
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
    fireEvent.click(screen.getByText("Yes, done"));
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
    // The "Log →" affordance is the action on a "log" row
    fireEvent.click(screen.getByText("Log →"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toBe("2026-06-13");
  });

  it("dismisses a confirmed row in place (instant feel, no full rerender wait)", () => {
    render(
      <RetroPickerSheet
        untickedDays={[z2Row("2026-06-12"), strengthRow("2026-06-13")]}
        pendingDraft={null}
        onPick={() => {}}
        onTickDate={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Z2 — 60 min")).toBeTruthy();
    fireEvent.click(screen.getByText("Yes, done"));
    // Z2 row gone, strength row still there — no auto-close, no "all caught
    // up" celebration. The user closes manually when they're done.
    expect(screen.queryByText("Z2 — 60 min")).toBeNull();
    expect(screen.getByText("Strength A")).toBeTruthy();
  });

  it("celebrates when the user clears the list manually — but does NOT auto-close", () => {
    // Two-tier empty state: clearing by hand earns a quiet "Well kept."
    // beat (acknowledging the discipline of honest logging); opening to
    // an empty list shows neutral "Nothing pending." Auto-close removed
    // either way — the user closes when they're done, not when the
    // screen decides for them. Eliminates the speedrun reward without
    // losing the satisfaction of a job done.
    const onClose = vi.fn();
    render(
      <RetroPickerSheet
        untickedDays={[z2Row("2026-06-12")]}
        pendingDraft={null}
        onPick={() => {}}
        onTickDate={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByText("Yes, done"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Well kept.")).toBeTruthy();
    expect(screen.queryByText("Nothing pending.")).toBeNull();
    expect(screen.queryByText(/back to it/i)).toBeNull();
    expect(screen.queryByText(/all caught up/i)).toBeNull();
  });

  it("shows neutral 'Nothing pending.' when opened with no untickedDays", () => {
    render(
      <RetroPickerSheet
        untickedDays={[]}
        pendingDraft={null}
        onPick={() => {}}
        onTickDate={() => {}}
        onClose={() => {}}
      />
    );
    // No reward for opening to a blank surface — that would celebrate
    // showing up, not doing the work.
    expect(screen.getByText("Nothing pending.")).toBeTruthy();
    expect(screen.queryByText("Well kept.")).toBeNull();
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
    expect(screen.queryByText("Yes, done")).toBeNull();
    expect(screen.getByText("Finish your live session first")).toBeTruthy();
  });
});
