// tests/fixtures/finalise-draft-cases.js
// Drafts for tests/finalise-draft-identity.test.js, built through the real
// logSet so every per-set field is what a live session caches. The recorded
// output sits beside this file (finalise-draft.json); `serialise` keeps keys
// whose value is undefined, so a dropped or reordered key fails the test.

import { logSet } from "../../lib/storage.js";

export const NOW_MS = Date.parse("2026-10-07T10:30:00.000Z");

function base(over = {}) {
  return {
    id: "2026-10-07T09:30:00.000Z",
    date: "2026-10-07",
    dow: 3,
    profileName: "Tess",
    schemaVersion: 3,
    loggedTz: "Europe/London",
    loggedTzOffset: -60,
    session: "strength-a",
    blockNumber: 2,
    weekStart: "2026-10-05",
    scheduledLetter: "A",
    mesocyclePhase: "accumulation",
    readiness: "normal",
    readinessReason: null,
    travel: undefined,
    bodyweight: null,
    hoursSlept: null,
    daysSinceLast: null,
    startedAt: NOW_MS - 3_600_000,
    duration: 0,
    blocks: {},
    ...over,
  };
}

const squat = { blockId: "a1", blockType: "main", exerciseName: "Barbell Back Squat", muscle: "Quadriceps", swapped: false, fromPool: null, loadType: "external" };
const bench = { blockId: "a2", blockType: "main", exerciseName: "Barbell Bench Press", muscle: "Chest", swapped: false, fromPool: null, loadType: "external" };
const lunge = { blockId: "ass1", blockType: "superset", exerciseName: "DB Reverse Lunge", muscle: "Quadriceps", swapped: false, fromPool: "ass1-A", loadType: "external" };
const row   = { blockId: "ass1", blockType: "superset", exerciseName: "Chest-Supported DB Row", muscle: "Back", swapped: true, fromPool: "ass1-B", loadType: "external" };
const raise = { blockId: "afin", blockType: "finisher", exerciseName: "Hanging Leg Raise", muscle: "Abs", swapped: false, fromPool: null, loadType: "bodyweight" };
const dip   = { blockId: "afin", blockType: "finisher", exerciseName: "Weighted Dip", muscle: "Chest", swapped: false, fromPool: null, loadType: "loaded_bodyweight" };
const pull  = { blockId: "b1", blockType: "main", exerciseName: "Assisted Pull-up", muscle: "Back", swapped: false, fromPool: null, loadType: "assisted_bodyweight" };
const plank = { blockId: "b2", blockType: "accessory", exerciseName: "Plank", muscle: "Abs", swapped: false, fromPool: null, loadType: "bodyweight" };

/** @type {Record<string, () => any>} */
export const CASES = {
  empty: () => base(),

  "main lifts, prescribed, mixed effort": () => {
    const d = base();
    const p = { reps: 5, weight: 100, sets: 3 };
    logSet(d, { ...squat, weight: 100, reps: 5, rpe: 7.5, prescribed: p });
    logSet(d, { ...squat, weight: 100, reps: 5, rpe: 8.5, prescribed: p });
    logSet(d, { ...squat, weight: 100, reps: 4, rpe: 10, prescribed: p });
    logSet(d, { ...bench, weight: 62.5, reps: 5, rpe: 8, prescribed: { reps: 5, weight: 60, sets: 3 }, blockIntent: "strength" });
    logSet(d, { ...bench, weight: 62.5, reps: 6, rpe: 9, reach: true });
    logSet(d, { ...bench, weight: 65, reps: 5, rpe: 9.5, tempo: "3-1-1-0" });
    return d;
  },

  "superset strings, swaps and an uncounted set": () => {
    const d = base({ readiness: "cooked", readinessReason: "sleep" });
    const p = { reps: "8/leg", weight: 16, sets: 3 };
    logSet(d, { ...lunge, weight: 16, reps: "8/leg", rpe: null, prescribed: p });
    logSet(d, { ...row, weight: 22, reps: 10, rpe: null, prescribed: { reps: 10, weight: null, sets: 3 } });
    logSet(d, { ...lunge, weight: 16, reps: "8/leg", rpe: "normal" });
    logSet(d, { ...row, weight: 22, reps: 9, rir: 1 });
    logSet(d, { ...lunge, weight: null, reps: null, rpe: null });
    logSet(d, { ...row, weight: null, reps: 0, rpe: 8 });
    return d;
  },

  "bodyweight family with a bodyweight": () => {
    const d = base({ bodyweight: 78 });
    logSet(d, { ...raise, weight: null, reps: 10, rpe: 8, bodyweight: 78, prescribed: { reps: 10, weight: null, sets: 4 } });
    logSet(d, { ...raise, weight: 5, reps: 12, rpe: 9, bodyweight: 78 });
    logSet(d, { ...dip, weight: 20, reps: 6, rpe: 8.5, bodyweight: 78, prescribed: { reps: 6, weight: 20, sets: 4 } });
    logSet(d, { ...pull, weight: 25, reps: 8, rpe: 8, bodyweight: 78, prescribed: { reps: 8, weight: 25, sets: 3 } });
    logSet(d, { ...pull, weight: 100, reps: 8, rpe: 7, bodyweight: 78 });
    logSet(d, { ...plank, weight: null, reps: "45s", rpe: 8, bodyweight: 78, prescribed: { reps: "45s", weight: null, sets: 2 } });
    return d;
  },

  "bodyweight family without a bodyweight": () => {
    const d = base();
    logSet(d, { ...raise, weight: null, reps: 10, rpe: 8, bodyweight: null, prescribed: { reps: 10, weight: null, sets: 4 } });
    logSet(d, { ...dip, weight: 20, reps: 6, rpe: 8.5, bodyweight: null, prescribed: { reps: 6, weight: 20, sets: 4 } });
    logSet(d, { ...pull, weight: 25, reps: 8, rpe: 8, bodyweight: null });
    return d;
  },

  "travel, a prescription without sets, ties on est1rm": () => {
    const d = base({ travel: true, readiness: "fresh", session: "strength-b", scheduledLetter: "B" });
    const p = { reps: 5, weight: 80, sets: null };
    logSet(d, { ...squat, weight: 80, reps: 5, rpe: 8, prescribed: p });
    logSet(d, { ...squat, weight: 80, reps: 5, rpe: 9 });
    logSet(d, { ...bench, weight: 0, reps: 10, rpe: 6 });
    return d;
  },

  "a hand-shaped draft: exercise with no sets array, late intent": () => {
    const d = base();
    d.blocks.x1 = {
      id: "x1", type: "main", intent: null,
      exercises: {
        Ghost: { name: "Ghost", muscle: "Back", loadType: "external", swapped: false, fromPool: null, tempo: null, prescribed: { reps: 5, sets: 3 } },
      },
    };
    logSet(d, { ...squat, blockId: "x1", weight: 90, reps: 3, rpe: 9, blockIntent: "power", prescribed: { reps: 3, weight: 90, sets: 1 } });
    return d;
  },
};

/** JSON with undefined kept as a marker, so key presence is pinned too. */
export function serialise(value) {
  return JSON.stringify(value, (_k, v) => (v === undefined ? "__undefined__" : v), 2);
}
