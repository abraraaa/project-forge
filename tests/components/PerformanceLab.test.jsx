// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// PerformanceLab — empty state + glossary trigger smoke tests.
//
// Mounting the full lab with a populated history requires fabricating a
// realistic v2 session record (hard to keep in sync with storage shape).
// These tests stay focused on the two surfaces that have been touched a lot
// and where wiring errors would silently break the screen:
//
//   1. Empty history → EmptyState renders, none of the data cards do. Used
//      to catch regressions where a chart tries to render against zero data
//      and throws (which then blanks the whole tab via ErrorBoundary).
//   2. Tapping the ⓘ next to the header opens GlossarySheet. Locks in the
//      anchor/trigger pattern the rest of the app uses.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PerformanceLab from "../../components/PerformanceLab.jsx";

afterEach(() => {
  cleanup();
});

describe("PerformanceLab — empty state", () => {
  it("renders the editorial empty state when history is []", () => {
    render(<PerformanceLab history={[]} onBack={() => {}} />);
    // Empty-state copy lives at PerformanceLab.jsx:125 — change copy, change test.
    expect(screen.getByText(/Nothing to show/i)).toBeTruthy();
    // The first-session prompt is the only call-to-action in the empty
    // state; if it's missing, EmptyState wasn't rendered.
    expect(screen.getByText(/Complete your first session/i)).toBeTruthy();
  });

  it("renders the lab header even when empty (the page isn't blank)", () => {
    render(<PerformanceLab history={[]} onBack={() => {}} />);
    expect(screen.getByText(/Performance lab/i)).toBeTruthy();
    // The italic flourish — visible regardless of data state
    expect(screen.getByText(/progress\./i)).toBeTruthy();
  });

  it("Back link fires onBack", () => {
    let backCalls = 0;
    render(<PerformanceLab history={[]} onBack={() => { backCalls++; }} />);
    fireEvent.click(screen.getByText(/← Home/));
    expect(backCalls).toBe(1);
  });
});

describe("PerformanceLab — glossary trigger", () => {
  it("ⓘ next to the header opens the glossary sheet", () => {
    render(<PerformanceLab history={[]} onBack={() => {}} />);
    // Pre-tap: only the trigger should exist, no dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    // The trigger is a button with aria-label="Open glossary".
    fireEvent.click(screen.getByLabelText("Open glossary"));
    // Post-tap: GlossarySheet's dialog mounts. Caught a real bug where the
    // header trigger passed no anchorTerm → onOpen(null) → state stayed
    // null → sheet never opened.
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Sheet's uppercase eyebrow label, unique within the lab when open.
    expect(screen.getByText("Glossary")).toBeTruthy();
  });
});
