// A set's effective load needs a bodyweight only when the body is in the load.
// Barbell, dumbbell, cable and machine sets log their weight, an e1RM and a
// volume whether or not a bodyweight is on file.

import { describe, it, expect } from "vitest";
import { computeEffectiveLoad, logSet, migrateV1ToV2, recordForKeep } from "../lib/storage.js";

const UNBODIED = [undefined, "external", "barbell", "per_db", "total", "machine"];
const BODIED = ["bodyweight", "loaded_bodyweight", "assisted_bodyweight"];

describe("computeEffectiveLoad without a bodyweight", () => {
  it("every type without the body in it is its weight", () => {
    for (const lt of UNBODIED) {
      expect(computeEffectiveLoad(lt, 60, null), String(lt)).toBe(60);
      expect(computeEffectiveLoad(lt, 60, undefined), String(lt)).toBe(60);
      expect(computeEffectiveLoad(lt, 60, 80), String(lt)).toBe(60);
    }
  });

  it("the three bodyweight types stay null", () => {
    for (const lt of BODIED) {
      expect(computeEffectiveLoad(lt, 10, null), lt).toBeNull();
      expect(computeEffectiveLoad(lt, 10, undefined), lt).toBeNull();
    }
    expect(computeEffectiveLoad("assisted_bodyweight", 20, 80)).toBe(60);
  });
});

describe("logSet without a bodyweight", () => {
  const log = (loadType, weight) => {
    const d = logSet({ blocks: {} }, {
      blockId: "main", blockType: "main", exerciseName: "Lift", muscle: "Quads",
      swapped: false, fromPool: null, weight, reps: 5, rpe: 8, loadType, bodyweight: null,
    });
    return d.blocks.main.exercises.Lift.sets[0];
  };

  it("a barbell, dumbbell, cable or machine set logs an e1RM and a volume", () => {
    for (const lt of ["barbell", "per_db", "total", "machine", "external"]) {
      const s = log(lt, 60);
      expect(s, lt).toMatchObject({ bodyweightUsed: null, effectiveLoad: 60, est1rm: 70, volume: 300 });
    }
  });

  it("bodyweight, loaded and assisted sets still log null", () => {
    for (const lt of BODIED) {
      const s = log(lt, 10);
      expect(s, lt).toMatchObject({ bodyweightUsed: null, effectiveLoad: null, est1rm: null, volume: 0 });
    }
  });
});

describe("recordForKeep without a bodyweight", () => {
  const sent = {
    id: "2026-10-07T14:00:00.000Z", date: "2026-10-07", profileName: null,
    blocks: [{ id: "main", type: "main", exercises: [
      { name: "Barbell Back Squat", loadType: "barbell", sets: [{ weight: 60, reps: 5, rir: 2, rpe: 8, loadType: "barbell" }] },
      { name: "Pull-Up", loadType: "loaded_bodyweight", sets: [{ weight: 10, reps: 5, rir: 2, rpe: 8, loadType: "loaded_bodyweight" }] },
    ] }],
  };
  const kept = recordForKeep(sent, { profile: "p", nowIso: "2026-10-07T15:00:00.000Z" });

  it("keeps a barbell set with its e1RM and volume", () => {
    expect(kept.blocks[0].exercises[0].sets[0]).toMatchObject({ effectiveLoad: 60, est1rm: 70, volume: 300 });
  });

  it("keeps a loaded bodyweight set with none", () => {
    expect(kept.blocks[0].exercises[1].sets[0]).toMatchObject({ effectiveLoad: null, est1rm: null, volume: 0 });
  });
});

describe("migrateV1ToV2 without a bodyweight", () => {
  const v1 = (sets, loadType) => ({ id: "x", date: "2026-06-15", blocks: [{ id: "b", type: "main", exercises: [{ name: "Lift", loadType, sets }] }] });

  it("a typed dumbbell set derives its e1RM from the weight", () => {
    const set = migrateV1ToV2(v1([{ weight: 20, reps: 5, rpe: "normal" }], "per_db")).blocks[0].exercises[0].sets[0];
    expect(set).toMatchObject({ effectiveLoad: 20, est1rm: 23.3, volume: 100 });
  });

  it("a stored null e1RM stays null", () => {
    const set = migrateV1ToV2(v1([{ weight: 20, reps: 5, rpe: "normal", effectiveLoad: null, est1rm: null, volume: 0 }], "per_db")).blocks[0].exercises[0].sets[0];
    expect(set).toMatchObject({ effectiveLoad: null, est1rm: null, volume: 0 });
  });
});
