// @vitest-environment jsdom
// tests/sync-payload.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The push-payload contract (sync audit S1, 2026-07-13). The server
// overwrites blob meta wholesale, so ANY push carrying a partial meta
// payload deletes the omitted fields from canonical. That bug shipped:
// the app-open retry hand-built {weights, reps, streak, programmeBlock}
// and wiped six fields on every retry. These tests lock the two halves of
// the fix: getLocalProfile carries EVERY synced field (principle 0's
// single payload builder), and flushPendingPushes uses it by default —
// the actual bytes leaving the device are checked, not the intention.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getLocalProfile, flushPendingPushes, PQ } from "../lib/storage.js";

const PROFILE = "payload-probe";

// Every field the merge layer has a rule for. Adding a synced store without
// extending BOTH getLocalProfile and this list is the regression S1 was.
const SYNCED_META_FIELDS = [
  "weights", "reps", "streak", "programmeBlock", "userWeek", "userFocus",
  "days", "bodyweight", "trainingState", "breaks",
];

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("getLocalProfile — the single payload builder", () => {
  it("carries every synced meta field, even for an empty profile", () => {
    const snap = getLocalProfile(PROFILE);
    for (const field of SYNCED_META_FIELDS) {
      expect(field in snap.meta, `meta.${field} missing from getLocalProfile`).toBe(true);
    }
    expect(Array.isArray(snap.history)).toBe(true);
  });
});

describe("flushPendingPushes — retries push the FULL snapshot by default", () => {
  it("the retried PUT body contains every synced meta field", async () => {
    PQ.add(PROFILE);
    let sentBody = null;
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (opts?.method === "PUT") sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ok: true }) };
    }));

    await flushPendingPushes(); // no dataFn — the default is under test

    expect(sentBody, "no PUT was sent for the pending profile").not.toBeNull();
    expect(sentBody.profile).toBe(PROFILE);
    for (const field of SYNCED_META_FIELDS) {
      expect(field in sentBody.data.meta, `retry payload dropped meta.${field}`).toBe(true);
    }
    expect(Array.isArray(sentBody.data.history)).toBe(true);
  });
});
