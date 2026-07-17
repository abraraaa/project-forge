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
