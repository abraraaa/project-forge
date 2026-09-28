// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// Travel mode is device-local: it must never ride the sync payload.
//
// Travel describes where the DEVICE is, not who the user is. Syncing it would
// put the phone left at home into travel mode. getLocalProfile is THE payload
// builder (every push, retry and delta goes through it), so the guard is
// exercised there, with the flag actually set in localStorage — which is why
// this file runs under jsdom: in node, LS.get returns its fallback and a
// seeded flag would never be read.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { getLocalProfile, TRAVEL } from "../lib/storage.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("the travel flag stays on the device", () => {
  it("a set flag does not appear in the payload's meta", () => {
    TRAVEL.set("t", true);
    // The seed is live — otherwise the assertions below prove nothing.
    expect(TRAVEL.get("t")).toBe(true);
    expect(localStorage.getItem("forge:t:travel")).toBe("true");

    const payload = getLocalProfile("t");
    expect("travel" in payload.meta).toBe(false);
  });

  it("the payload is exactly { meta, history } — no side channel for it", () => {
    TRAVEL.set("t", true);
    expect(Object.keys(getLocalProfile("t")).sort()).toEqual(["history", "meta"]);
  });

  it("toggling the flag leaves the payload unchanged, under any key name", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T10:00:00.000Z"));
    TRAVEL.set("t", false);
    const off = getLocalProfile("t");
    TRAVEL.set("t", true);
    const on = getLocalProfile("t");
    expect(on).toEqual(off);
  });
});
