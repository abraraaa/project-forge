// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// lib/a11y.js modal hooks — the mechanics behind the house modal doctrine.
// useModalA11y backs 13 shipped sheets; useInlineModalA11y backs the
// conditionally-rendered ones (ProfileScreen's wipe-confirm / passkey sheets).
// A regression here degrades keyboard + screen-reader access across the whole
// sheet family at once, silently — exactly the kind of thing string-matching
// source could never catch. So: mount, press keys, assert focus.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useModalA11y, useInlineModalA11y } from "../lib/a11y.js";

afterEach(cleanup);

// A minimal sheet that wires the hook exactly as the real components do.
function Sheet({ onClose }) {
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  return (
    <div ref={containerRef} role="dialog" tabIndex={-1} onKeyDown={onKeyDown}>
      <button>first</button>
      <button>middle</button>
      <button>last</button>
    </div>
  );
}

function InlineHost() {
  const [open, setOpen] = useState(false);
  const { containerRef, onKeyDown } = useInlineModalA11y(open, () => setOpen(false));
  return (
    <div>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <div ref={containerRef} role="dialog" tabIndex={-1} onKeyDown={onKeyDown}>
          <button>inline-only</button>
        </div>
      )}
    </div>
  );
}

describe("useModalA11y — Escape closes", () => {
  it("calls onClose when Escape is pressed inside the dialog", () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose for other keys", () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "a" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("useModalA11y — focus trap wraps Tab", () => {
  it("Tab off the last focusable wraps to the first", () => {
    render(<Sheet onClose={() => {}} />);
    const [first, , last] = screen.getAllByRole("button");
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("Shift+Tab off the first (or the container) wraps to the last", () => {
    render(<Sheet onClose={() => {}} />);
    const buttons = screen.getAllByRole("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    first.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("useModalA11y — focus save/restore", () => {
  it("moves focus into the dialog on mount and restores it on unmount", async () => {
    // A trigger element that holds focus before the sheet opens.
    render(<button>trigger</button>);
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Mount the sheet — focus should move to the dialog container (after the
    // hook's 0ms timeout, hence the act+timer flush).
    const { unmount } = render(<Sheet onClose={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    // Unmount — focus returns to the trigger that opened it.
    unmount();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("useInlineModalA11y — keys on isOpen, not mount", () => {
  it("Escape closes the conditionally-rendered inline modal", () => {
    render(<InlineHost />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
