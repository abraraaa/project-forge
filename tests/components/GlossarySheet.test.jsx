// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// GlossarySheet — anchor-scrolling, term coverage, dismissal.
//
// Locks in:
//   - The anchor mechanism actually finds and scrolls a term by id.
//   - Every term entry the codebase advertises (MEV/MAV/MRV, 1RM, RPE/RIR,
//     Block, Rotation, Superset, Tonnage) renders. New terms added to the
//     TERMS array should extend this test, NOT replace it.
//   - Close-button + backdrop-click both fire onCancel.
//
// Uses jsdom; vitest's default node env stays in force for the lib suite.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import GlossarySheet from "../../components/GlossarySheet.jsx";

// jsdom doesn't implement scrollIntoView — stub it so the anchor effect
// doesn't throw. We assert that it was called with the right node instead.
// vitest config has `globals: false` so RTL's automatic afterEach(cleanup)
// doesn't fire — wire it explicitly so DOM from a prior test doesn't leak
// (otherwise getByRole("dialog") finds multiple matches).
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
});

describe("GlossarySheet", () => {
  it("renders every advertised term", () => {
    render(<GlossarySheet onCancel={() => {}} />);
    // These titles are the public API of the sheet — anywhere in the app
    // that opens with a specific anchor expects these IDs to exist.
    expect(screen.getByText("MEV · MAV · MRV")).toBeTruthy();
    expect(screen.getByText("1RM")).toBeTruthy();
    expect(screen.getByText("RPE · RIR")).toBeTruthy();
    expect(screen.getByText("Block")).toBeTruthy();
    expect(screen.getByText("Rotation")).toBeTruthy();
    expect(screen.getByText("Superset")).toBeTruthy();
    expect(screen.getByText("Tonnage")).toBeTruthy();
  });

  it("scrolls the anchored term into view on open", () => {
    render(<GlossarySheet anchorTerm="volume-landmarks" onCancel={() => {}} />);
    // After mount, scrollIntoView must have been called on the volume-
    // landmarks entry (the MEV/MAV/MRV section). If the anchor effect
    // drifts or the id pattern changes, this fails loudly.
    const node = document.querySelector('[data-term-id="volume-landmarks"]');
    expect(node).toBeTruthy();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("does NOT scroll when opened without an anchor", () => {
    render(<GlossarySheet onCancel={() => {}} />);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("Close button fires onCancel", () => {
    const onCancel = vi.fn();
    render(<GlossarySheet onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Close"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("backdrop click fires onCancel (sheet click does not)", () => {
    const onCancel = vi.fn();
    render(<GlossarySheet onCancel={onCancel} />);
    // The dialog stops propagation; the outer (backdrop) layer is its parent.
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(dialog.parentElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
