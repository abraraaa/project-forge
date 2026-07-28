// tests/locker-window.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The Locker Room's bounded photo-load contract (#264, hardened after an
// external review). #264 killed the N+1 "fetch every photo on reveal" spike by
// loading only a bounded window around the visible frame and evicting the rest.
// The review's fair warning: a neat fix with NO test pinning the window / order /
// eviction is one "harmless" refactor away from quietly reverting to the N+1.
// These lock the geometry — pure functions, so no jsdom, no mock, no flake.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { photoWindowIndices, outsideEvictBand, PREFETCH, EVICT } from "../app/locker-room/page.jsx";

describe("photoWindowIndices — what loads around the visible frame", () => {
  it("a small collection (<= 2·PREFETCH+1) loads in FULL — no behaviour change", () => {
    // The whole point: today's collections fit the window and load whole, so
    // the bounding is invisible until a timeline outgrows it.
    const len = 2 * PREFETCH + 1; // 13 at PREFETCH=6
    const got = photoWindowIndices(Math.floor(len / 2), len).sort((a, b) => a - b);
    expect(got).toEqual([...Array(len).keys()]);
  });

  it("a long timeline loads only a bounded neighbourhood, never all of it", () => {
    const got = photoWindowIndices(500, 1000);
    expect(got.length).toBe(2 * PREFETCH + 1);          // bounded, not 1000
    expect(Math.min(...got)).toBe(500 - PREFETCH);
    expect(Math.max(...got)).toBe(500 + PREFETCH);
  });

  it("requests the visible frame FIRST, then fans out centre-outward", () => {
    // The review's point 1: the frame under the finger must not queue behind
    // its own prefetch. First index is the centre; each |i-centre| is
    // non-decreasing thereafter.
    const got = photoWindowIndices(500, 1000);
    expect(got[0]).toBe(500);
    const dist = got.map((i) => Math.abs(i - 500));
    for (let k = 1; k < dist.length; k++) expect(dist[k]).toBeGreaterThanOrEqual(dist[k - 1]);
    // ...and the immediate neighbour (the other frame visible mid-drag) is in
    // the first two requests, never deep in the queue.
    expect(got.slice(0, 3)).toContain(501);
  });

  it("clamps at both ends without running off the list", () => {
    expect(Math.min(...photoWindowIndices(0, 50))).toBe(0);          // no negative index
    expect(photoWindowIndices(0, 50)).toContain(0);
    const end = photoWindowIndices(49, 50);
    expect(Math.max(...end)).toBe(49);                                // no index past the end
  });

  it("returns nothing for an empty collection (no fetch on zero photos)", () => {
    expect(photoWindowIndices(0, 0)).toEqual([]);
  });

  it("never repeats an index (dedupe within one window pass)", () => {
    const got = photoWindowIndices(3, 8);
    expect(new Set(got).size).toBe(got.length);
  });
});

describe("outsideEvictBand — what gets revoked to stay bounded", () => {
  it("keeps frames inside ±EVICT and revokes the rest", () => {
    expect(outsideEvictBand(500, 500)).toBe(false);          // the centre stays
    expect(outsideEvictBand(500 + EVICT, 500)).toBe(false);  // edge of the band stays
    expect(outsideEvictBand(500 - EVICT, 500)).toBe(false);
    expect(outsideEvictBand(500 + EVICT + 1, 500)).toBe(true);   // just past → revoke
    expect(outsideEvictBand(500 - EVICT - 1, 500)).toBe(true);
  });

  it("always evicts a frame no longer in the list (i < 0 from findIndex)", () => {
    // A deleted photo's stale object URL must be revoked, not leaked.
    expect(outsideEvictBand(-1, 500)).toBe(true);
  });

  it("the keep-band is wider than the load-window (loaded frames aren't instantly evicted)", () => {
    // EVICT > PREFETCH by design: a frame you just prefetched at the window edge
    // must not be revoked on the very next re-sync, or the drag would thrash.
    expect(EVICT).toBeGreaterThan(PREFETCH);
  });
});
