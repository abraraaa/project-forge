// @vitest-environment jsdom
// tests/profile-actions.test.js
// ────────────────────────────────────────────────────────────────────────────
// The pure profile-action cores shared by ForgeApp's in-place gate and the
// /profile route (PR3 3d-route). Claim-path network calls are exercised only
// as far as "claim=false never touches the network" — the claim endpoint has
// its own server-side behaviour.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import {
  activateProfileCore,
  saveFocusCore,
  stashRotationSummary,
  takePendingRotationSummary,
} from "../lib/profile-actions.js";
import { P, PB, F } from "../lib/storage.js";

beforeEach(() => {
  window.localStorage.clear();
});

describe("activateProfileCore", () => {
  it("rejects empty / whitespace-only names without touching storage", async () => {
    expect(await activateProfileCore("")).toEqual({ ok: false, reason: "empty" });
    expect(await activateProfileCore("   ")).toEqual({ ok: false, reason: "empty" });
    expect(P.getActive()).toBeFalsy();
  });

  it("adds + activates a trimmed name (no claim → no network)", async () => {
    const r = await activateProfileCore("  Alice  ");
    expect(r).toEqual({ ok: true, name: "Alice" });
    expect(P.getActive()).toBe("Alice");
    expect(P.list()).toContain("Alice");
  });

  it("switching profiles updates the active pointer", async () => {
    await activateProfileCore("Alice");
    await activateProfileCore("Bob");
    expect(P.getActive()).toBe("Bob");
    expect(P.list()).toEqual(expect.arrayContaining(["Alice", "Bob"]));
  });
});

describe("saveFocusCore", () => {
  it("persists the focus and a re-rotated programme block, returns the summary", () => {
    const before = PB.get();
    const { next, summary } = saveFocusCore("Alice", "Sculpt");
    expect(F.get("Alice")).toBe("Sculpt");
    // Persisted block matches the returned one; block number unchanged
    // (re-pick within the block, not a new block).
    expect(PB.get().config).toEqual(next.config);
    expect(next.number).toBe(before.number);
    expect(summary.blockNumber).toBe(before.number);
    expect(summary).toHaveProperty("changes");
    expect(summary).toHaveProperty("stimulusDelta");
  });
});

describe("rotation-summary one-shot handoff", () => {
  it("take returns the stashed summary once, then null", () => {
    stashRotationSummary("Alice", { blockNumber: 2, changes: [], stimulusDelta: [] });
    expect(takePendingRotationSummary("Alice")).toEqual({ blockNumber: 2, changes: [], stimulusDelta: [] });
    expect(takePendingRotationSummary("Alice")).toBeNull();
  });

  it("is per-profile and null-safe", () => {
    stashRotationSummary("Alice", { blockNumber: 1 });
    expect(takePendingRotationSummary("Bob")).toBeNull();
    expect(takePendingRotationSummary(null)).toBeNull();
    stashRotationSummary(null, { blockNumber: 1 }); // no-op, no throw
  });
});
