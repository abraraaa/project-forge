// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// ErrorBoundary — the app's last line of defence, and a data-safety contract.
//
// The behaviour that matters, and why each is here rather than trusted:
//   · a throwing child is caught and replaced by the fallback (the whole job)
//   · "Try again" clears the error so a transient fault can recover in place
//   · "Clear cache" is GATED behind a confirm AND preserves every
//     forge:<profile>:* store — audit #11: this used to be
//     localStorage.clear(), destroying the ONLY copy of unpushed training
//     data while the button promised safety. That regression must never
//     return, so it is pinned by behaviour, not by comment.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ErrorBoundary from "../../components/ErrorBoundary.jsx";

// A child that throws on demand. Toggle via the module-level flag so the same
// component can render fine, then throw on a re-render.
let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error("boom");
  return <div>recovered child</div>;
}

beforeEach(() => {
  shouldThrow = true;
  // React logs caught errors to console.error; silence the expected noise so
  // the test output stays honest about REAL failures.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("catches and renders the fallback", () => {
  it("replaces a throwing subtree with the recovery screen", () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByText("Something broke")).toBeTruthy();
    // The reassurance copy is load-bearing — it's the promise the Clear-cache
    // behaviour below must actually keep.
    expect(screen.getByText(/Your data's saved/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear cache" })).toBeTruthy();
  });

  it("renders children untouched when nothing throws", () => {
    shouldThrow = false;
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByText("recovered child")).toBeTruthy();
    expect(screen.queryByText("Something broke")).toBeNull();
  });
});

describe('"Try again" clears the error state', () => {
  it("re-renders the children, so a transient fault recovers in place", () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByText("Something broke")).toBeTruthy();
    // The fault was transient — the next render will succeed.
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("recovered child")).toBeTruthy();
    expect(screen.queryByText("Something broke")).toBeNull();
  });
});

describe('"Clear cache" is the audit #11 data-safety contract', () => {
  beforeEach(() => {
    // Seed the store: device-level keys (disposable) + profile data (SACRED,
    // possibly the only copy if sync never ran).
    window.localStorage.setItem("forge:onboarded", "1");
    window.localStorage.setItem("forge:weekConfig", "{}");
    window.localStorage.setItem("forge:tonnageMilestoneSeen", "1");
    window.localStorage.setItem("forge:sarah:weights", JSON.stringify({ Squat: 100 }));
    window.localStorage.setItem("forge:sarah:history", JSON.stringify([{ id: "x" }]));
    window.localStorage.setItem("forge:sarah:bodyweightLog", JSON.stringify([80]));
  });

  it("does nothing at all if the user declines the confirm", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { reload }, writable: true });

    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));

    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("forge:onboarded")).toBe("1");   // untouched
  });

  it("clears ONLY device keys and NEVER a forge:<profile>:* store", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { reload }, writable: true });

    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));

    // The handler dynamically imports lib/storage for a best-effort flush,
    // then clears + reloads in a .finally — let the microtasks drain.
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    // Device-level caches: gone.
    expect(window.localStorage.getItem("forge:onboarded")).toBeNull();
    expect(window.localStorage.getItem("forge:weekConfig")).toBeNull();
    expect(window.localStorage.getItem("forge:tonnageMilestoneSeen")).toBeNull();

    // Profile data: SURVIVES. This is the whole point of the audit #11 fix —
    // the button that promises "your data is kept" must actually keep it.
    expect(window.localStorage.getItem("forge:sarah:weights")).toBe(JSON.stringify({ Squat: 100 }));
    expect(window.localStorage.getItem("forge:sarah:history")).toBe(JSON.stringify([{ id: "x" }]));
    expect(window.localStorage.getItem("forge:sarah:bodyweightLog")).toBe(JSON.stringify([80]));
  });
});
