// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// sync-cards — the sync status readout and the "Sync now" row, at the surface.
//
// Locks in the J1 resting state (a 401 from /api/sync, SyncStatus
// "needsAuth"):
//   - The card names it honestly — "On this device only" — and paints it
//     steel (T.under), never a heat colour. Nothing is lost; it is not an
//     alarm.
//   - With a passkey on file, tapping Sync now IS the ceremony: it runs
//     authenticatePasskey(profile) (the tap carries the transient user
//     activation WebAuthn needs), then a FULL backgroundSync — the device
//     may be days stale and needs the pull, not just a push.
//   - A cancelled prompt (null) is an answer: no sync runs, the row rests.
//   - Without a passkey, or outside the resting state, the tap is a plain
//     push and no ceremony is offered.
//
// The WebAuthn ceremony and the two sync entry points are mocked; SyncStatus
// is the real one (reset to idle after each test).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({ authenticatePasskey: vi.fn(async () => null) }));
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal()),
  backgroundSync: vi.fn(async () => ({ source: "remote", changed: false })),
  pushNow: vi.fn(async () => true),
}));

import { SyncStatusCard, SyncNowRow } from "../../components/sync-cards.jsx";
import { SyncStatus, backgroundSync, pushNow } from "@/lib/storage";
import { authenticatePasskey } from "@/lib/webauthn";
import { T } from "@/lib/tokens";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  SyncStatus._set({ state: "idle", lastSync: null, error: null });
});

// The status dot is the only 8px circle in the card.
const dotOf = (container) =>
  [...container.querySelectorAll("div")].find((d) => d.style.width === "8px");

// The row's busy flag clears in a finally; wait for it so no state update
// lands after cleanup.
const settled = () => waitFor(() => expect(screen.queryByText("Syncing now…")).toBeNull());

describe("SyncStatusCard: the resting state is named honestly, not as an alarm", () => {
  it("reads 'On this device only' and points at the passkey when there is one", () => {
    SyncStatus._set({ state: "needsAuth", error: null });
    render(<SyncStatusCard profile="sam" hasPasskey />);
    expect(screen.getByText("On this device only")).toBeTruthy();
    expect(screen.getByText("Confirm it's you below to resume")).toBeTruthy();
    // Not the failure readout.
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("offers adding a passkey when there is none", () => {
    SyncStatus._set({ state: "needsAuth", error: null });
    render(<SyncStatusCard profile="sam" hasPasskey={false} />);
    expect(screen.getByText("On this device only")).toBeTruthy();
    expect(screen.getByText("Add a passkey to carry it across devices")).toBeTruthy();
  });

  it("paints the dot steel (T.under), never a heat colour", () => {
    SyncStatus._set({ state: "needsAuth", error: null });
    const { container } = render(<SyncStatusCard profile="sam" hasPasskey />);
    const dot = dotOf(container);
    expect(dot).toBeTruthy();
    expect(dot.style.background).toBe(T.under);
    for (const h of [...T.heat, T.heatOver]) expect(dot.style.background).not.toBe(h);
  });

  it("follows SyncStatus live: idle → needsAuth relabels the card", async () => {
    render(<SyncStatusCard profile="sam" hasPasskey />);
    expect(screen.getByText("Synced")).toBeTruthy();
    SyncStatus._set({ state: "needsAuth", error: null });
    expect(await screen.findByText("On this device only")).toBeTruthy();
  });
});

describe("SyncNowRow: in the resting state with a passkey, Sync now runs the ceremony", () => {
  it("offers the ceremony in the subtitle", () => {
    SyncStatus._set({ state: "needsAuth", error: null });
    render(<SyncNowRow profile="sam" hasPasskey />);
    expect(screen.getByText("Tap to confirm it's you and resume")).toBeTruthy();
  });

  it("a cancelled prompt (null) is an answer: nothing syncs", async () => {
    authenticatePasskey.mockResolvedValueOnce(null);
    SyncStatus._set({ state: "needsAuth", error: null });
    render(<SyncNowRow profile="sam" hasPasskey />);
    fireEvent.click(screen.getByText("Sync now"));
    await waitFor(() => expect(authenticatePasskey).toHaveBeenCalledWith("sam"));
    await settled();
    expect(backgroundSync).not.toHaveBeenCalled();
    expect(pushNow).not.toHaveBeenCalled();
  });

  it("a completed ceremony is followed by a FULL sync (the pull), not a bare push", async () => {
    authenticatePasskey.mockResolvedValueOnce({ token: "t" });
    SyncStatus._set({ state: "needsAuth", error: null });
    render(<SyncNowRow profile="sam" hasPasskey />);
    fireEvent.click(screen.getByText("Sync now"));
    await waitFor(() => expect(backgroundSync).toHaveBeenCalledTimes(1));
    await settled();
    expect(authenticatePasskey).toHaveBeenCalledWith("sam");
    expect(backgroundSync.mock.calls[0][0]).toBe("sam");
    expect(authenticatePasskey.mock.invocationCallOrder[0])
      .toBeLessThan(backgroundSync.mock.invocationCallOrder[0]);
    expect(pushNow).not.toHaveBeenCalled();
  });
});

describe("SyncNowRow: no ceremony without both the resting state and a passkey", () => {
  it("resting state but no passkey: a plain push, no prompt", async () => {
    SyncStatus._set({ state: "needsAuth", error: null });
    render(<SyncNowRow profile="sam" hasPasskey={false} />);
    fireEvent.click(screen.getByText("Sync now"));
    await waitFor(() => expect(pushNow).toHaveBeenCalledWith("sam"));
    await settled();
    expect(authenticatePasskey).not.toHaveBeenCalled();
    expect(backgroundSync).not.toHaveBeenCalled();
  });

  it("passkey on file but not resting: a plain push, no prompt", async () => {
    render(<SyncNowRow profile="sam" hasPasskey />);
    fireEvent.click(screen.getByText("Sync now"));
    await waitFor(() => expect(pushNow).toHaveBeenCalledWith("sam"));
    await settled();
    expect(authenticatePasskey).not.toHaveBeenCalled();
    expect(backgroundSync).not.toHaveBeenCalled();
  });
});
