// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { blobPush, PQ, SyncStatus, SYNC_STATE_NEEDS_AUTH } from "../lib/storage.js";
import { notePasskey, isKnownPasskeyless } from "../lib/passkeyless.js";

describe("no passkey, nothing leaves the device", () => {
  beforeEach(() => {
    localStorage.clear();
    notePasskey("Sam", true);
  });

  it("a confirmed passkey-less profile queues locally and sends nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    notePasskey("Sam", false);
    expect(await blobPush("Sam", { weights: {} })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(PQ.get()).toContain("Sam");
    expect(SyncStatus.get().state).toBe(SYNC_STATE_NEEDS_AUTH);
    vi.unstubAllGlobals();
  });

  it("unknown (null) changes nothing; a passkey clears the hold", () => {
    notePasskey("Sam", false);
    notePasskey("sam", null);
    expect(isKnownPasskeyless("SAM")).toBe(true);
    notePasskey("Sam", true);
    expect(isKnownPasskeyless("Sam")).toBe(false);
  });

  it("hasPasskey and registration feed the hold", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../lib/webauthn.js"), "utf8");
    expect(src).toContain("notePasskey(profile, has);");
    expect(src).toContain("notePasskey(profile, true);");
  });
});
