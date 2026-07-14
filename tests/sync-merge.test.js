// tests/sync-merge.test.js
// ─────────────────────────────────────────────────────────────────────────────
// THE merge's contract (lib/sync-merge.js), locking the sync-audit fixes:
//   S2 — stamps beat direction: a stamped newer local survives a stale
//        remote pull (the "trained offline, app forgot my weights" bug),
//        while fully-unstamped data keeps the legacy remote-wins-ties
//        behaviour byte-for-byte.
//   S3 — server direction: merging an INCOMING partial payload into the
//        existing blob never deletes existing fields — the blob is always
//        a superset. (The server-side backstop for the S1 class.)
//   S4 — change detection is exact: meta-only differences register; a
//        no-op merge registers nothing (self-normalised compare).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { mergeMeta, mergeProfileData } from "../lib/sync-merge.js";

const T1 = "2026-07-13T10:00:00.000Z";
const T2 = "2026-07-13T18:00:00.000Z"; // later

describe("S2 — stamps beat direction", () => {
  it("a stamped newer local weight survives a stale remote (offline training)", () => {
    const local = { weights: { Squat: 102.5 }, weightStamps: { Squat: T2 } };
    const remote = { weights: { Squat: 100 }, weightStamps: { Squat: T1 } };
    const m = mergeMeta(local, remote);
    expect(m.weights.Squat).toBe(102.5);
    expect(m.weightStamps.Squat).toBe(T2);
  });

  it("per-key: each side wins the keys it stamped later", () => {
    const local = { weights: { Squat: 102.5, Bench: 60 }, weightStamps: { Squat: T2, Bench: T1 } };
    const remote = { weights: { Squat: 100, Bench: 62.5 }, weightStamps: { Squat: T1, Bench: T2 } };
    const m = mergeMeta(local, remote);
    expect(m.weights).toEqual({ Squat: 102.5, Bench: 62.5 });
  });

  it("fully-unstamped data keeps legacy remote-wins-ties behaviour", () => {
    const local = { weights: { Squat: 102.5, Row: 70 } };
    const remote = { weights: { Squat: 100 } };
    const m = mergeMeta(local, remote);
    expect(m.weights).toEqual({ Squat: 100, Row: 70 }); // === {...local, ...remote}
  });

  it("a stamped newer local focus survives an unstamped/stale remote", () => {
    const m1 = mergeMeta(
      { userFocus: "Sculpt", userFocusUpdatedAt: T2 },
      { userFocus: "Forged", userFocusUpdatedAt: T1 },
    );
    expect(m1.userFocus).toBe("Sculpt");
    // Unstamped remote still wins the tie (legacy).
    const m2 = mergeMeta({ userFocus: "Sculpt" }, { userFocus: "Forged" });
    expect(m2.userFocus).toBe("Forged");
  });

  it("trainingState: both rich → newer stamp wins; rich beats empty", () => {
    const rich = (stamp, marker) => ({
      updatedAt: stamp,
      lifts: { Squat: { currentWeight: marker } },
      muscleAnchors: {},
    });
    const m = mergeMeta(
      { trainingState: rich(T2, 102.5) },
      { trainingState: rich(T1, 100) },
    );
    expect(m.trainingState.lifts.Squat.currentWeight).toBe(102.5);

    const m2 = mergeMeta(
      { trainingState: { lifts: {}, muscleAnchors: {} } },
      { trainingState: rich(T1, 100) },
    );
    expect(m2.trainingState.lifts.Squat.currentWeight).toBe(100);
  });
});

describe("S3 — server direction: incoming partial payloads never delete", () => {
  it("existing blob fields survive an incoming payload that lacks them", () => {
    const existing = {
      weights: { Squat: 100 },
      days: { "2026-07-10": { date: "2026-07-10", completedType: "cardio", updatedAt: T1 } },
      breaks: [{ id: T1, start: "2026-07-01", reason: "resting", endedAt: null }],
      userWeek: [{ editedAt: T1, effectiveFrom: "2026-07-01",
        week: Array(7).fill({ type: "strength" }) }],
      bodyweight: { kg: 80, updatedAt: T1 },
      trainingState: { updatedAt: T1, lifts: { Squat: { currentWeight: 100 } }, muscleAnchors: {} },
    };
    // The S1-class payload: only four fields.
    const incoming = { weights: { Squat: 100 }, reps: {}, streak: { count: 0 }, programmeBlock: { number: 2 } };
    const m = mergeMeta(existing, incoming);
    expect(m.days["2026-07-10"].completedType).toBe("cardio");
    expect(m.breaks.length).toBe(1);
    expect(m.userWeek.length).toBe(1);
    expect(m.bodyweight.kg).toBe(80);
    expect(m.trainingState.lifts.Squat.currentWeight).toBe(100);
    expect(m.programmeBlock.number).toBe(2); // incoming's real change lands
  });
});

describe("S4 — exact change detection", () => {
  it("a meta-only remote change (a day tick) sets remoteHadMore", () => {
    const local = { meta: { weights: { Squat: 100 } }, history: [] };
    const remote = {
      meta: {
        weights: { Squat: 100 },
        days: { "2026-07-10": { date: "2026-07-10", completedType: "cardio", updatedAt: T1 } },
      },
      history: [],
    };
    const { remoteHadMore, localHadMore } = mergeProfileData(local, remote);
    expect(remoteHadMore).toBe(true);
    expect(localHadMore).toBe(false);
  });

  it("identical sides register no change in either direction", () => {
    const side = { meta: { weights: { Squat: 100 }, weightStamps: { Squat: T1 } }, history: [] };
    const { remoteHadMore, localHadMore } = mergeProfileData(side, JSON.parse(JSON.stringify(side)));
    expect(remoteHadMore).toBe(false);
    expect(localHadMore).toBe(false);
  });

  it("normalisation noise (absent vs null fields) is not a change", () => {
    const local = { meta: { weights: { Squat: 100 } }, history: [] };
    const remote = { meta: { weights: { Squat: 100 }, userFocus: null, days: {} }, history: [] };
    const { remoteHadMore, localHadMore } = mergeProfileData(local, remote);
    expect(remoteHadMore).toBe(false);
    expect(localHadMore).toBe(false);
  });
});
