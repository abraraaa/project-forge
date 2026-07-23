// @vitest-environment jsdom
// tests/durability-fixes.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Locks for the four independently-fixed durability bugs (audit #4–#7):
//   #4 PB.reset stamps updatedAt → the cleared rotation WINS the same-number
//      merge tie-break instead of resurrecting.
//   #5 profile wipe iterates the canonical PROFILE_SUFFIXES registry — plus a
//      source-scan class lock so a future per-profile key can't dodge it.
//   #6 credential writes go write-first-then-sweep (writeJsonReplacingPrefix)
//      — a failure between the steps can no longer destroy the only copy.
//   #7 sync PUT's unreadable-blob guard lives in the route (verified by code
//      shape here: the guard must reference the up-front blob list).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { PB } from "../lib/storage.js";
import { PROFILE_SUFFIXES, LEGACY_PROFILE_KEY_PREFIXES } from "../lib/store-health.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("#4 — PB.reset stamps updatedAt (deletion expressed as newer state)", () => {
  beforeEach(() => localStorage.clear());

  it("reset carries a FRESH updatedAt so it wins the same-number tie-break", () => {
    PB.save({ number: 3, startDate: "2026-06-01", config: { "ass1-A": { name: "X" } }, history: { "ass1-A": ["X"] }, updatedAt: "2026-06-01T00:00:00.000Z" }, { touch: false });
    const before = Date.now();
    const next = PB.reset();
    expect(next.config).toEqual({});
    expect(next.history).toEqual({});
    expect(next.number).toBe(3); // journey counter preserved
    expect(new Date(next.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
    // Stored state matches the returned state (callers set React state from it)
    expect(PB.get().updatedAt).toBe(next.updatedAt);
  });
});

describe("#5 — wipe key coverage class lock", () => {
  // Every per-profile localStorage key template in the codebase must use a
  // suffix the canonical registry knows, so the wipe (which iterates the
  // registry) and /diag-sync can never miss a store again. If this fails,
  // add the new suffix to PROFILE_SUFFIXES in lib/store-health.js.
  const KNOWN = new Set([...PROFILE_SUFFIXES, "pendingPushes"]);
  const sourceFiles = (dir) =>
    readdirSync(resolve(__dirname, dir)).filter((f) => /\.(js|jsx)$/.test(f)).map((f) => join(dir, f));

  it("every forge:${…}:<suffix> template resolves to a registered suffix", () => {
    const offenders = [];
    for (const rel of [...sourceFiles("../lib"), ...sourceFiles("../components")]) {
      const src = readFileSync(resolve(__dirname, rel), "utf8");
      for (const m of src.matchAll(/forge:\$\{[A-Za-z0-9_.]+\}:([A-Za-z0-9_]+)/g)) {
        const suffix = m[1];
        const ok = KNOWN.has(suffix) || LEGACY_PROFILE_KEY_PREFIXES.some((p) => p.startsWith(suffix)) ||
          // template continues with another ${} segment (legacy week-keyed)
          src.includes(`forge:\${`) && LEGACY_PROFILE_KEY_PREFIXES.some((p) => p.replace(/:$/, "") === suffix);
        if (!ok) offenders.push(`${rel}: ${suffix}`);
      }
    }
    expect(offenders, `unregistered per-profile keys (add to PROFILE_SUFFIXES): ${offenders.join(", ")}`).toEqual([]);
  });

  it("the wipe iterates the registry, not a hand-typed list", () => {
    const src = readFileSync(resolve(__dirname, "../components/ProfileScreen.jsx"), "utf8");
    expect(src).toMatch(/PROFILE_SUFFIXES\.forEach/);
    expect(src).not.toMatch(/\["weights","reps","streak","history","pendingPushes"\]/);
  });
});

describe("#6 — writeJsonReplacingPrefix: write first, sweep after", () => {
  beforeEach(() => vi.resetModules());

  const setupBlobMock = ({ putFails = false } = {}) => {
    const calls = [];
    vi.doMock("@vercel/blob", () => ({
      get: vi.fn(),
      list: vi.fn(async () => ({ blobs: [{ pathname: "p/credentials-OLD.json", url: "https://blob/OLD" }] })),
      put: vi.fn(async () => {
        calls.push("put");
        if (putFails) throw new Error("boom");
        return { pathname: "p/credentials-NEW.json" };
      }),
      del: vi.fn(async (urls) => { calls.push(["del", urls]); }),
    }));
    return calls;
  };

  it("deletes ONLY the pre-existing blobs, and only after the put succeeds", async () => {
    const calls = setupBlobMock();
    const { writeJsonReplacingPrefix } = await import("../lib/blob-utils.js");
    await writeJsonReplacingPrefix("p/credentials", "p/credentials.json", { credentials: [] });
    expect(calls[0]).toBe("put");
    expect(calls[1]).toEqual(["del", ["https://blob/OLD"]]);
  });

  it("a failed put deletes NOTHING — the old copy survives", async () => {
    const calls = setupBlobMock({ putFails: true });
    const { writeJsonReplacingPrefix } = await import("../lib/blob-utils.js");
    await expect(writeJsonReplacingPrefix("p/credentials", "p/credentials.json", {})).rejects.toThrow("boom");
    expect(calls).toEqual(["put"]); // no del call
  });
});

describe("#7 — sync PUT unreadable-blob guard (code shape)", () => {
  it("the PUT handler guards both meta and history reads against present-but-unreadable blobs", () => {
    const src = readFileSync(resolve(__dirname, "../app/api/sync/route.js"), "utf8");
    expect(src).toMatch(/blobExists\(metaPath\(profile\)\)/);
    expect(src).toMatch(/blobExists\(historyPath\(profile\)\)/);
    expect((src.match(/status: 503/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("db helpers (Neon step 2) — pure meta row mapping", () => {
  it("metaRowsFrom ⇄ assembleMeta round-trips and skips undefined", async () => {
    const { metaRowsFrom, assembleMeta } = await import("../lib/db.js");
    const meta = { weights: { a: 1 }, streak: 3, ghost: undefined, empty: null };
    const rows = metaRowsFrom(meta);
    expect(rows.map((r) => r.field).sort()).toEqual(["empty", "streak", "weights"]);
    expect(assembleMeta(rows)).toEqual({ weights: { a: 1 }, streak: 3, empty: null });
    expect(metaRowsFrom(null)).toEqual([]);
    expect(assembleMeta(null)).toEqual({});
  });
});

describe("#40 — every client API call has a deadline", () => {
  it("lib client layers never call bare fetch — all go through fetchWithTimeout", () => {
    for (const rel of ["../lib/storage.js", "../lib/photos.js", "../lib/webauthn.js"]) {
      const src = readFileSync(resolve(__dirname, rel), "utf8");
      expect(src.match(/await fetch\(/g), `${rel} has a bare fetch`).toBeNull();
      expect(src).toContain("fetchWithTimeout");
    }
  });
  it("the wrapper aborts a radio-limbo request instead of hanging forever", async () => {
    const { fetchWithTimeout } = await import("../lib/net.js");
    const orig = globalThis.fetch;
    // A fetch that never settles unless the signal fires — iOS radio limbo.
    globalThis.fetch = (url, { signal } = {}) => new Promise((resolvePromise, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    try {
      await expect(fetchWithTimeout("/api/x", {}, 30)).rejects.toThrow();
    } finally { globalThis.fetch = orig; }
  });
});

describe("#42 — lifecycle flushes live on every route (code shape)", () => {
  const src = readFileSync(resolve(__dirname, "../lib/storage.js"), "utf8");
  it("hidden/pagehide flush the ACTIVE profile even when auto-sync (home) is off", () => {
    expect(src).toMatch(/_lifecycleProfile = \(\) => _autoSyncProfile \|\| P\.getActive\(\)/);
    expect(src).toMatch(/function _handlePageHide\(\) \{\s*flushDeferred\(_lifecycleProfile\(\), \{ keepalive: true \}\)/);
  });
  it("online-flush is unconditional; pull-refresh stays gated on the home mount", () => {
    const online = src.slice(src.indexOf("function _handleOnline"), src.indexOf("// Ask the browser"));
    expect(online.indexOf("flushPendingPushes()")).toBeLessThan(online.indexOf("if (_autoSyncProfile)"));
    expect(online).toMatch(/if \(_autoSyncProfile\) \{\s*backgroundSync/);
  });
});

describe("#62 — selftest cron cleanup is namespace-locked (code shape)", () => {
  it("the finally-block delete fires only for profiles matching the selftest junk pattern", () => {
    const s = readFileSync(resolve(__dirname, "../app/api/cron/sync-selftest/route.js"), "utf8");
    expect(s).toMatch(/SELFTEST_PROFILE_RE\s*=\s*\/\^selftest-/);
    const cleanup = s.slice(s.indexOf("} finally {"));
    // The pattern test must gate the delete call — refusal, not routing.
    expect(cleanup.indexOf("SELFTEST_PROFILE_RE.test(profile)")).toBeGreaterThan(-1);
    expect(cleanup.indexOf("SELFTEST_PROFILE_RE.test(profile)")).toBeLessThan(cleanup.indexOf("syncDELETE"));
  });
  it("the junk pattern actually matches what the cron generates — and nothing person-shaped", () => {
    const RE = /^selftest-\d{13}-[a-z0-9]{1,6}$/;
    expect(RE.test(`selftest-${1753142400000}-k3x9qz`)).toBe(true);
    expect(RE.test("selftest-1753142400000-a")).toBe(true); // rare short random tail
    expect(RE.test("sarah")).toBe(false);
    expect(RE.test("selftest-sarah")).toBe(false);
    expect(RE.test("selftest-1753142400000-k3x9qz-extra")).toBe(false);
  });
});

describe("#68 — ONE counted-set rule (behaviour + class lock)", () => {
  it("isCountedSet: weight OR reps counts; empty scaffold and malformed rows don't", async () => {
    const { isCountedSet } = await import("../lib/counted-set.js");
    expect(isCountedSet({ weight: 100, reps: null })).toBe(true);
    expect(isCountedSet({ weight: null, reps: 8 })).toBe(true);
    expect(isCountedSet({ weight: 0, reps: null })).toBe(true);  // logged bodyweight-relative 0
    expect(isCountedSet({ weight: null, reps: 0 })).toBe(false); // 0 reps is not evidence
    expect(isCountedSet({ weight: null, reps: null })).toBe(false);
    expect(isCountedSet({ weight: undefined, reps: null })).toBe(false);
    expect(isCountedSet(null)).toBe(false);
  });
  it("no inline copies of the guard survive anywhere in lib/", () => {
    const libFiles = readdirSync(resolve(__dirname, "../lib")).filter((f) => /\.(js|jsx)$/.test(f)).map((f) => join("../lib", f));
    for (const rel of libFiles) {
      if (rel.endsWith("counted-set.js")) continue;
      const src = readFileSync(resolve(__dirname, rel), "utf8");
      expect(src, `${rel} re-inlines the counted-set rule — use isCountedSet`).not.toMatch(/weight (!==|!=) null \|\|/);
    }
  });
});

describe("audit tail nits #54/#55/#35 (code shape)", () => {
  it("#54: sync refresh is PRESENCE-gated — resets to 0/empty reflect", () => {
    const s = readFileSync(resolve(__dirname, "../components/ForgeApp.jsx"), "utf8");
    expect(s).toMatch(/typeof meta\.streak\.count === "number"/);
    expect(s).toMatch(/Array\.isArray\(remoteHistory\)/);
    expect(s).not.toMatch(/meta\.streak\?\.count\)/);
    expect(s).not.toMatch(/remoteHistory\?\.length\)/);
  });
  it("#55: home header + strip share ONE re-anchoring clock", () => {
    const s = readFileSync(resolve(__dirname, "../components/HomeScreen.jsx"), "utf8");
    expect(s).toContain("new Date(nowMs).toLocaleDateString");
    expect(s).not.toMatch(/\{new Date\(\)\.toLocaleDateString/);
    expect(s).toMatch(/toDateString\(\) === new Date\(now\)\.toDateString\(\)/);
  });
  it("#35: deload math is calendar-day local; dead MAX constant gone", () => {
    const s = readFileSync(resolve(__dirname, "../lib/progression.js"), "utf8");
    expect(s).toContain("parseLocalDate(sessionDate || todayLocalIso())");
    expect(s).not.toContain("DELOAD_AUTO_CLOSE_MAX_DAYS      = 10");
    expect(s).not.toMatch(/new Date\(sessionDate/);
  });
});
