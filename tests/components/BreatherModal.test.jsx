// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// BreatherModal — the declare-a-pause sheet.
//
// Flagged for coverage by CLAUDE.md's own incident log: this is the component
// that cost an afternoon to the drag-to-dismiss / safe-area-chin fight, and
// its dismissal contract is the SETTLEMENT of that fight. There is
// deliberately no drag (a transform composites the sheet on iOS Safari and
// clips the safe-area zone). Dismissal is tap-outside / Escape / "Not now" —
// three paths, all pinned here, because losing one would quietly strand a
// user in a modal on the platform that started the whole saga.
//
// Also pins the reason contract: optional, toggleable, and passed to
// onConfirm as an id (or null) — never a label.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import BreatherModal from "../../components/BreatherModal.jsx";
import { REASONS } from "../../lib/breaks.js";

afterEach(cleanup);

describe("renders the permission-voiced sheet", () => {
  it("shows the headline, every reason chip, and both actions", () => {
    render(<BreatherModal onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Voice matters here — "rest is a training variable, not a lapse" is the
    // whole point of the feature (lib/breaks.js doctrine).
    expect(screen.getByText(/Rest is a training variable, not a lapse/)).toBeTruthy();
    for (const r of REASONS) {
      expect(screen.getByRole("button", { name: r.label }), r.label).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Breathe easy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });
});

describe("the reason is OPTIONAL and toggleable", () => {
  it("confirms with null when no reason is chosen", () => {
    const onConfirm = vi.fn();
    render(<BreatherModal onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Breathe easy" }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("passes the reason ID, not its label", () => {
    const onConfirm = vi.fn();
    render(<BreatherModal onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Injured or ill" }));
    fireEvent.click(screen.getByRole("button", { name: "Breathe easy" }));
    expect(onConfirm).toHaveBeenCalledWith("injured");
  });

  it("tapping the selected reason again clears it (back to null)", () => {
    const onConfirm = vi.fn();
    render(<BreatherModal onConfirm={onConfirm} onCancel={() => {}} />);
    const chip = screen.getByRole("button", { name: "Travelling" });
    fireEvent.click(chip);   // select
    fireEvent.click(chip);   // deselect
    fireEvent.click(screen.getByRole("button", { name: "Breathe easy" }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("choosing a second reason replaces the first — single-select", () => {
    const onConfirm = vi.fn();
    render(<BreatherModal onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Busy stretch" }));
    fireEvent.click(screen.getByRole("button", { name: "Resting up" }));
    fireEvent.click(screen.getByRole("button", { name: "Breathe easy" }));
    expect(onConfirm).toHaveBeenCalledWith("resting");
  });
});

describe("all three dismissal paths — the settlement of the chin saga", () => {
  it('"Not now" cancels without confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<BreatherModal onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels (via the shared modal-a11y hook)", () => {
    const onCancel = vi.fn();
    render(<BreatherModal onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("tapping the scrim cancels, but tapping the sheet body does NOT", () => {
    const onCancel = vi.fn();
    const { container } = render(<BreatherModal onConfirm={() => {}} onCancel={onCancel} />);
    const scrim = container.querySelector(".forge-scrim");

    // Body clicks must stop propagation — otherwise choosing a reason would
    // dismiss the sheet under your finger.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(scrim);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("the no-drag settlement holds", () => {
  it("a drag gesture does NOT transform the sheet", () => {
    // The reason is a platform bug, not a preference: a transform composites
    // the sheet on iOS Safari, and a composited fixed/bottom element CLIPS
    // the safe-area zone — reopening the exact chin band that seamless sheets
    // exist to avoid (reproduced 2026-07-07, cost an afternoon).
    //
    // Actually PERFORM the gesture rather than asserting an empty style
    // property, which any component that never drags would pass for free.
    // If drag-to-dismiss is ever reintroduced, this fires touchmove and
    // catches the transform it would set — making the return a deliberate
    // decision that revisits the finding, not an accident.
    const onCancel = vi.fn();
    render(<BreatherModal onConfirm={() => {}} onCancel={onCancel} />);
    const dialog = screen.getByRole("dialog");

    const touch = (y) => ({ touches: [{ clientX: 100, clientY: y }], changedTouches: [{ clientX: 100, clientY: y }] });
    fireEvent.touchStart(dialog, touch(200));
    fireEvent.touchMove(dialog, touch(320));   // a firm downward drag
    expect(dialog.style.transform || "").toBe("");

    fireEvent.touchEnd(dialog, touch(420));    // release well past any threshold
    expect(dialog.style.transform || "").toBe("");
    // ...and a drag must not dismiss either — that is what "Not now",
    // Escape and the scrim are for.
    expect(onCancel).not.toHaveBeenCalled();
  });
});
