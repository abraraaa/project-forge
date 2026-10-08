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
import { mergeMeta, mergeMetaFields, mergeProfileData, mergeProgrammeBlock } from "../lib/sync-merge.js";

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

describe("mergeProgrammeBlock — the same-block race unions memory", () => {
  it("higher block number still wins wholesale", () => {
    const older = { number: 3, config: { a: { name: "X" } }, history: { a: ["X"] } };
    const newer = { number: 4, config: { a: { name: "Y" } }, history: { a: ["Y"] } };
    expect(mergeProgrammeBlock(older, newer).number).toBe(4);
    expect(mergeProgrammeBlock(newer, older).number).toBe(4);
  });

  it("equal numbers: newer updatedAt's config wins, exclusion history unions", () => {
    const l = { number: 3, updatedAt: T2, config: { a: { name: "Y" } },
      history: { "s1": ["Y", "X"], "s2": ["P"] } };
    const r = { number: 3, updatedAt: T1, config: { a: { name: "Z" } },
      history: { "s1": ["Z"], "s3": ["Q"] } };
    const m = mergeProgrammeBlock(l, r);
    expect(m.config.a.name).toBe("Y");          // newer stamp wins the config
    expect(m.history.s1).toEqual(["Y", "X", "Z"]); // union, winner order first, capped 3
    expect(m.history.s2).toEqual(["P"]);        // loser-only slots survive
    expect(m.history.s3).toEqual(["Q"]);
  });

  it("legacy single-string history entries normalise to arrays", () => {
    const l = { number: 2, updatedAt: T2, history: { s1: "OldPick" } };
    const r = { number: 2, updatedAt: T1, history: { s1: ["NewPick"] } };
    expect(mergeProgrammeBlock(l, r).history.s1).toEqual(["OldPick", "NewPick"]);
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

describe("unset: null is a value in the stamped maps", () => {
  const T3 = "2026-07-14T09:00:00.000Z"; // later still
  const maps = (field) => (field === "weights" ? ["weights", "weightStamps"] : ["reps", "repStamps"]);

  for (const field of ["weights", "reps"]) {
    const [v, st] = maps(field);
    it(`${field}: a newer null beats an older number, whichever side carries it`, () => {
      const unset = { [v]: { Squat: null }, [st]: { Squat: T2 } };
      const number = { [v]: { Squat: 8 }, [st]: { Squat: T1 } };
      for (const [l, r] of [[unset, number], [number, unset]]) {
        const m = mergeMeta(l, r);
        expect(Object.hasOwn(m[v], "Squat")).toBe(true);
        expect(m[v].Squat).toBeNull();
        expect(m[st].Squat).toBe(T2);
      }
    });

    it(`${field}: an older null loses to a newer number, whichever side carries it`, () => {
      const unset = { [v]: { Squat: null }, [st]: { Squat: T1 } };
      const number = { [v]: { Squat: 8 }, [st]: { Squat: T3 } };
      for (const [l, r] of [[unset, number], [number, unset]]) {
        const m = mergeMeta(l, r);
        expect(m[v].Squat).toBe(8);
        expect(m[st].Squat).toBe(T3);
      }
    });

    it(`${field}: a null on one side only is carried with its stamp; idempotent`, () => {
      const one = { [v]: { Squat: null, Bench: 5 }, [st]: { Squat: T2, Bench: T1 } };
      for (const [l, r] of [[one, {}], [{}, one], [one, one]]) {
        const m = mergeMeta(l, r);
        expect(m[v]).toEqual({ Squat: null, Bench: 5 });
        expect(m[st]).toEqual({ Squat: T2, Bench: T1 });
        // Normalising again changes nothing: the null is never dropped.
        const again = mergeMeta(m, m);
        expect(again[v]).toEqual(m[v]);
        expect(again[st]).toEqual(m[st]);
      }
    });
  }

  it("two nulls: the newer stamp is kept; the merge commutes on values and stamps", () => {
    const a = { weights: { Squat: null }, weightStamps: { Squat: T1 } };
    const b = { weights: { Squat: null }, weightStamps: { Squat: T2 } };
    expect(mergeMeta(a, b).weightStamps.Squat).toBe(T2);
    expect(mergeMeta(b, a).weightStamps.Squat).toBe(T2);
    expect(mergeMeta(a, b).weights).toEqual({ Squat: null });
  });

  it("change detection: an unset is a real difference both ways; a re-pull of it is not", () => {
    const local = { meta: { weights: { Squat: null }, weightStamps: { Squat: T2 } }, history: [] };
    const remote = { meta: { weights: { Squat: 100 }, weightStamps: { Squat: T1 } }, history: [] };
    const r = mergeProfileData(local, remote);
    expect(r.meta.weights).toEqual({ Squat: null });
    expect(r.localHadMore).toBe(true);
    expect(r.remoteHadMore).toBe(false);
    const again = mergeProfileData(local, { meta: r.meta, history: [] });
    expect([again.localHadMore, again.remoteHadMore]).toEqual([false, false]);
  });

  it("delta PUT (mergeMetaFields): an incoming unset beats the stored number and ships with its stamp", () => {
    const existing = { weights: { Squat: 105, Bench: 60 }, weightStamps: { Squat: T1, Bench: T1 } };
    const out = mergeMetaFields(existing, { weights: { Squat: null, Bench: 60 }, weightStamps: { Squat: T2, Bench: T1 } });
    expect(out).toEqual({ weights: { Squat: null, Bench: 60 }, weightStamps: { Squat: T2, Bench: T1 } });
    // An older number arriving later (a stale device) does not bring it back.
    const stale = mergeMetaFields(out, { weights: { Squat: 105 }, weightStamps: { Squat: T1 } });
    expect(stale.weights.Squat).toBeNull();
    expect(stale.weightStamps.Squat).toBe(T2);
  });

  it("the meta rows round-trip keeps a null entry (metaRowsFrom ⇄ JSONB ⇄ assembleMeta)", async () => {
    const { metaRowsFrom, assembleMeta } = await import("../lib/db.js");
    const meta = { weights: { Squat: null, Bench: 60 }, weightStamps: { Squat: T2, Bench: T1 }, reps: { Squat: null }, repStamps: { Squat: T2 } };
    // The upsert sends JSON.stringify(value)::jsonb; a read returns the parsed value.
    const rows = metaRowsFrom(meta).map(({ field, value }) => ({ field, value: JSON.parse(JSON.stringify(value)) }));
    expect(assembleMeta(rows)).toEqual(meta);
    expect(Object.hasOwn(assembleMeta(rows).weights, "Squat")).toBe(true);
  });
});
