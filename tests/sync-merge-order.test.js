// Order and repeat properties of THE merge (lib/sync-merge.js), field by
// field, through each entry point: mergeMetaFields (the delta PUT),
// mergeMeta and mergeProfileData. With the per-row guard, pushes to one
// closure land one after the other, each merged onto the row the others left.
// The stored result must not depend on the order they land in, and a push
// applied twice must change nothing the second time. Stamps repeat within a
// case on purpose: two devices writing the same millisecond is a tie, broken
// by content. Seeded: a failure names the seed and the case.
import { describe, it, expect } from "vitest";
import { mergeMetaFields, mergeMeta, mergeProfileData, fieldClosure, mergeDayEntries } from "../lib/sync-merge.js";
import { recentNamesFor } from "../lib/programme.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One case: base and three device writes (a, b, c) for one closure.
function caseFor(field, seed) {
  const r = rng(seed);
  const int = (n) => Math.floor(r() * n);
  const pick = (xs) => xs[int(xs.length)];
  const some = (xs) => xs.filter(() => r() < 0.6);
  const used = [];
  // About a third of the stamps repeat one already minted in this case.
  const stamp = () => {
    if (used.length && r() < 0.35) return pick(used);
    const s = new Date(Date.UTC(2026, 9, 1 + int(7), int(24), int(60), int(60))).toISOString();
    used.push(s);
    return s;
  };
  const day = () => `2026-10-0${1 + int(7)}`;
  const LIFTS = ["Squat", "Bench", "Deadlift", "Press"];
  const stampedMap = (vals, stamps, value) => () => {
    const keys = some(LIFTS);
    return { [vals]: Object.fromEntries(keys.map((k) => [k, value()])), [stamps]: Object.fromEntries(keys.map((k) => [k, stamp()])) };
  };
  const NAMES = ["A", "B", "C", "D", "E"];
  const memory = () => {
    const names = some(NAMES).slice(0, 3);
    const roll = r();
    if (roll < 0.3) return names; // older array shape
    if (roll < 0.4) return names[0] ?? "A"; // legacy single string
    return Object.fromEntries(names.map((n) => [n, stamp()]));
  };
  const dayEntry = (d) => {
    const e = {
      date: d, updatedAt: stamp(),
      scheduledType: r() < 0.5 ? pick(["strength", "zone2"]) : null,
      completedType: r() < 0.5 ? pick(["strength", "zone2"]) : null,
      sessionId: r() < 0.5 ? `s${int(3)}` : null,
      marks: r() < 0.5 ? { bonus: true } : {},
    };
    // A few malformed entries carry no updatedAt at all (fields read at epoch).
    if (r() < 0.1) delete e.updatedAt;
    // Half the entries carry per-field stamps (Days.set); the rest read at updatedAt.
    if (r() < 0.5) e.stamps = Object.fromEntries(some(["scheduledType", "completedType", "sessionId"]).map((k) => [k, stamp()]));
    return e;
  };
  const gen = {
    weights: stampedMap("weights", "weightStamps", () => 20 + 2.5 * int(40)),
    reps: stampedMap("reps", "repStamps", () => 3 + int(10)),
    mainLifts: stampedMap("mainLifts", "mainLiftStamps", () => pick(["Back Squat", "Front Squat", "Bench Press", "Incline Press"])),
    userFocus: () => ({ userFocus: pick(["strength", "size", "balanced"]), userFocusUpdatedAt: stamp() }),
    // Some copies omit a zero count, so equal count and lastDate can differ in content.
    streak: () => ({ streak: r() < 0.2 ? { lastDate: day() } : { count: int(3), lastDate: day() } }),
    programmeBlock: () => {
      const reset = r() < 0.2;
      return {
        programmeBlock: {
          number: 1 + int(2), updatedAt: stamp(),
          config: reset ? {} : { push: { name: pick(NAMES) } },
          history: reset ? {} : Object.fromEntries(some(["push", "pull", "legs"]).map((k) => [k, memory()])),
        },
      };
    },
    userWeek: () => ({
      userWeek: some([0, 1, 2]).map(() => ({
        editedAt: stamp(), effectiveFrom: day(),
        week: Array.from({ length: 7 }, () => ({ type: pick(["strength", "zone2", "rest"]) })),
      })),
    }),
    days: () => ({ days: Object.fromEntries(some(["2026-10-01", "2026-10-02"]).map((d) => [d, dayEntry(d)])) }),
    bodyweightLog: () => ({ bodyweightLog: Object.fromEntries(some(["2026-10-01", "2026-10-02"]).map((d) => [d, { kg: 70 + int(20), updatedAt: stamp() }])) }),
    bodyweight: () => ({ bodyweight: { kg: 70 + int(20), updatedAt: stamp() } }),
    addedLoads: () => ({ addedLoads: Object.fromEntries(some(["Pull-up", "Dip"]).map((k) => [k, { kg: int(4) * 5, updatedAt: stamp() }])) }),
    trainingState: () => ({
      trainingState: { updatedAt: stamp(), lifts: Object.fromEntries(some(LIFTS).map((k) => [k, { e1rm: 50 + int(100) }])), muscleAnchors: {} },
    }),
    breaks: () => ({
      breaks: some(["b1", "b2"]).map((id) => ({
        id, start: id === "b1" ? "2026-10-01" : "2026-10-03", endedAt: r() < 0.5 ? null : day(),
        // Copies of one record may disagree on a field other than endedAt.
        ...(r() < 0.5 ? { reason: pick(["rest", "ill", null]) } : {}),
      })),
    }),
    mystery: () => ({ mystery: r() < 0.5 ? { v: int(5) } : { v: int(5), updatedAt: stamp() } }),
  }[field];
  return { base: gen(), a: gen(), b: gen(), c: gen() };
}

// The stored state after a push, per entry point.
const ENTRY_POINTS = {
  mergeMetaFields: (state, incoming) => ({ ...state, ...mergeMetaFields(state, incoming) }),
  mergeMeta: (state, incoming) => mergeMeta(state, incoming),
  mergeProfileData: (state, incoming) => mergeProfileData({ meta: state, history: [] }, { meta: incoming, history: [] }).meta,
};
const closureOf = (field, state) => Object.fromEntries([...fieldClosure([field])].map((k) => [k, state[k]]));
const CASES = 300;

function counterexample(field, landFn, property) {
  for (let i = 0; i < CASES; i++) {
    const seed = 0x5eed + i;
    const cs = caseFor(field, seed);
    const results = property(landFn, cs).map((s) => closureOf(field, s));
    for (const res of results.slice(1)) {
      try {
        expect(res).toEqual(results[0]);
      } catch {
        return { seed, ...cs, left: results[0], right: res };
      }
    }
  }
  return null;
}
const fold = (landFn, base, writes) => writes.reduce(landFn, base);
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const order = (landFn, { base, a, b }) => [fold(landFn, base, [a, b]), fold(landFn, base, [b, a])];
const threeDevices = (landFn, { base, a, b, c }) => PERMS.map((p) => fold(landFn, base, p.map((i) => [a, b, c][i])));
const repeat = (landFn, { base, a }) => [fold(landFn, base, [a, a]), fold(landFn, base, [a])];

// Every field the merge rules on, plus one it does not know.
const FIELDS = ["weights", "reps", "mainLifts", "userFocus", "streak", "programmeBlock", "userWeek", "days",
  "bodyweightLog", "bodyweight", "addedLoads", "trainingState", "breaks", "mystery"];

for (const [name, landFn] of Object.entries(ENTRY_POINTS)) {
  describe(`${name}: landing order does not change the result`, () => {
    for (const field of FIELDS) it(field, () => expect(counterexample(field, landFn, order)).toBeNull());
  });
  describe(`${name}: three devices, all six landing orders agree`, () => {
    for (const field of FIELDS) it(field, () => expect(counterexample(field, landFn, threeDevices)).toBeNull());
  });
  describe(`${name}: a push applied twice changes nothing the second time`, () => {
    for (const field of FIELDS) it(field, () => expect(counterexample(field, landFn, repeat)).toBeNull());
  });
}

// ─── Named cases, each in every landing order ────────────────────────────────

const T = (h, m = 0) => `2026-10-20T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const land = ENTRY_POINTS.mergeMetaFields;

// Lands every order of `writes` on `base` through every entry point, asserts
// they all agree, and returns the result (the keys the case touches).
function allOrders(base, writes) {
  let first = null;
  const perms = writes.length === 3 ? PERMS : [[0, 1], [1, 0]];
  const keys = Object.keys(Object.assign({}, base, ...writes));
  for (const landFn of Object.values(ENTRY_POINTS)) {
    for (const p of perms) {
      const got = fold(landFn, base, p.map((i) => writes[i]));
      const view = Object.fromEntries(keys.map((k) => [k, got[k]]));
      if (!first) first = view;
      else expect(view).toEqual(first);
    }
  }
  return first;
}

describe("days: per-field stamps", () => {
  const D = "2026-10-20";
  // S: a zone2 tick at s0, stored before per-field stamps (no stamps).
  const S = { days: { [D]: { date: D, scheduledType: "zone2", completedType: "zone2", sessionId: null, marks: {}, updatedAt: T(8) } } };

  it("the design note's case: a retro strength session and a later bonus mark both survive, either order", () => {
    // A: retro strength session with its sessionId, at sA.
    const A = { days: { [D]: { date: D, scheduledType: "zone2", completedType: "strength", sessionId: "sess-1", marks: {}, updatedAt: T(10),
      stamps: { scheduledType: T(10), completedType: T(10), sessionId: T(10) } } } };
    // B: a bonus mark with a null completion, at sB > sA.
    const B = { days: { [D]: { date: D, scheduledType: "zone2", completedType: null, sessionId: null, marks: { bonus: true }, updatedAt: T(12),
      stamps: { scheduledType: T(12) } } } };
    for (const [x, y] of [[A, B], [B, A]]) {
      const e = land(land(S, x), y).days[D];
      expect(e.completedType).toBe("strength");
      expect(e.sessionId).toBe("sess-1");
      expect(e.marks.bonus).toBe(true);
    }
    expect(allOrders(S, [A, B]).days[D]).toMatchObject({ completedType: "strength", sessionId: "sess-1", marks: { bonus: true }, updatedAt: T(12) });
  });

  it("a stale copy of the zone2 tick that marks a bonus does not override a newer completion", () => {
    const A = { days: { [D]: { date: D, scheduledType: "zone2", completedType: "strength", sessionId: "sess-1", marks: {}, updatedAt: T(10),
      stamps: { scheduledType: T(10), completedType: T(10), sessionId: T(10) } } } };
    // B held S; its bonus write keeps completedType at S's time (Days.set).
    const B = { days: { [D]: { date: D, scheduledType: "zone2", completedType: "zone2", sessionId: null, marks: { bonus: true }, updatedAt: T(12),
      stamps: { scheduledType: T(12), completedType: T(8) } } } };
    const e = allOrders(S, [A, B]).days[D];
    expect(e).toMatchObject({ completedType: "strength", sessionId: "sess-1", marks: { bonus: true } });
    expect(e.stamps.completedType).toBe(T(10));
  });

  it("an entry without stamps reads every field as stamped at its updatedAt", () => {
    const legacy = { days: { [D]: { date: D, completedType: "zone2", updatedAt: T(9) } } };
    // completedType written at 7; a later write at 11 touched only the marks.
    const stamped = { days: { [D]: { date: D, completedType: "cardio", marks: { bonus: true }, updatedAt: T(11), stamps: { completedType: T(7) } } } };
    const e = allOrders({}, [legacy, stamped]).days[D];
    expect(e.completedType).toBe("zone2");
    expect(e.stamps.completedType).toBe(T(9));
    expect(e.updatedAt).toBe(T(11));
    // Read alone, the legacy entry keeps its shape: its stamps are implied by updatedAt.
    expect(mergeDayEntries(legacy.days, {})[D]).toEqual({
      date: D, scheduledType: null, completedType: "zone2", sessionId: null, marks: {}, updatedAt: T(9),
    });
  });

  it("equal completedType stamps tie by content, not by arrival", () => {
    const A = { days: { [D]: { date: D, completedType: "strength", updatedAt: T(10) } } };
    const B = { days: { [D]: { date: D, completedType: "cardio", updatedAt: T(10) } } };
    expect(allOrders({}, [A, B]).days[D].completedType).toBe("strength"); // "strength" > "cardio"
  });

  it("three devices on one date: a session, a bonus and a schedule restamp all land, in any order", () => {
    const A = { days: { [D]: { date: D, completedType: "strength", sessionId: "sess-1", updatedAt: T(10), stamps: { completedType: T(10), sessionId: T(10) } } } };
    const B = { days: { [D]: { date: D, scheduledType: "zone2", completedType: "zone2", marks: { bonus: true }, updatedAt: T(12), stamps: { scheduledType: T(12), completedType: T(8) } } } };
    const C = { days: { [D]: { date: D, scheduledType: "strength", updatedAt: T(11), stamps: { scheduledType: T(11) } } } };
    expect(allOrders(S, [A, B, C]).days[D]).toMatchObject({
      scheduledType: "zone2", completedType: "strength", sessionId: "sess-1", marks: { bonus: true }, updatedAt: T(12),
    });
  });
});

describe("programmeBlock at one number", () => {
  const names = (block, slot) => recentNamesFor(block.history[slot]);

  it("a rotation's memory on A and a later reset on B: the reset wins, in either order", () => {
    const S = { programmeBlock: { number: 3, updatedAt: T(8), config: { s1: { name: "X" } }, history: { s1: ["X"] } } };
    const A = { programmeBlock: { number: 3, updatedAt: T(10), config: { s1: { name: "Y" } }, history: { s1: { Y: T(10), X: T(8) } } } };
    const B = { programmeBlock: { number: 3, updatedAt: T(12), config: {}, history: {} } };
    const pb = allOrders(S, [A, B]).programmeBlock;
    expect(pb.config).toEqual({});
    expect(pb.updatedAt).toBe(T(12));
    expect(names(pb, "s1")).toEqual([]);
    // A stale copy landing afterwards can't bring the cleared names back.
    expect(names(land({ programmeBlock: pb }, S).programmeBlock, "s1")).toEqual([]);
  });

  it("a reset older than the other device's new pick keeps that pick and clears the rest", () => {
    const S = { programmeBlock: { number: 3, updatedAt: T(8), config: { s1: { name: "X" } }, history: { s1: ["X"] } } };
    const A = { programmeBlock: { number: 3, updatedAt: T(12), config: { s1: { name: "Y" } }, history: { s1: { Y: T(12), X: T(8) } } } };
    const B = { programmeBlock: { number: 3, updatedAt: T(10), config: {}, history: {} } };
    const pb = allOrders(S, [A, B]).programmeBlock;
    expect(pb.config).toEqual({ s1: { name: "Y" } });
    expect(names(pb, "s1")).toEqual(["Y"]);
  });

  it("same number and same updatedAt: the config ties by content", () => {
    const A = { programmeBlock: { number: 2, updatedAt: T(10), config: { s1: { name: "Alpha" } }, history: {} } };
    const B = { programmeBlock: { number: 2, updatedAt: T(10), config: { s1: { name: "Bravo" } }, history: {} } };
    expect(allOrders({}, [A, B]).programmeBlock.config).toEqual({ s1: { name: "Bravo" } });
  });

  it("three devices at one number: every remembered name survives, the newest three read", () => {
    const A = { programmeBlock: { number: 4, updatedAt: T(10), config: { s1: { name: "P" } }, history: { s1: { P: T(10), Q: T(5) } } } };
    const B = { programmeBlock: { number: 4, updatedAt: T(11), config: { s1: { name: "R" } }, history: { s1: { R: T(11), Q: T(6) } } } };
    const C = { programmeBlock: { number: 4, updatedAt: T(9), config: { s1: { name: "S" } }, history: { s1: { S: T(9) }, s2: { Z: T(9) } } } };
    const pb = allOrders({}, [A, B, C]).programmeBlock;
    expect(pb.history.s1).toEqual({ P: T(10), Q: T(6), R: T(11), S: T(9) });
    expect(pb.history.s2).toEqual({ Z: T(9) });
    expect(names(pb, "s1")).toEqual(["R", "P", "S"]);
    expect(pb.config).toEqual({ s1: { name: "R" } });
  });

  it("an array-shaped history reads as stamped at the block's updatedAt; the reader still gives three names", () => {
    const A = { programmeBlock: { number: 2, updatedAt: T(10), history: { s1: ["Y", "X", "W"] } } };
    const B = { programmeBlock: { number: 2, updatedAt: T(8), history: { s1: { Z: T(8) } } } };
    const pb = allOrders({}, [A, B]).programmeBlock;
    expect(pb.history.s1).toEqual({ Y: T(10), X: T(10), W: T(10), Z: T(8) });
    expect(names(pb, "s1")).toHaveLength(3);
    expect([...names(pb, "s1")].sort()).toEqual(["W", "X", "Y"]);
  });
});

describe("unknown fields", () => {
  it("stamped inside the value: the newer wins, in either order", () => {
    const A = { mystery: { v: 1, updatedAt: T(12) } };
    const B = { mystery: { v: 9, updatedAt: T(10) } };
    expect(allOrders({}, [A, B]).mystery).toEqual({ v: 1, updatedAt: T(12) });
  });

  it("neither stamped: one value, in either order", () => {
    const A = { mystery: { v: 1 } };
    const B = { mystery: { v: 2 } };
    expect(allOrders({}, [A, B]).mystery).toEqual({ v: 2 });
  });
});

describe("equal stamps tie by content at every register", () => {
  const at = T(10);
  const week = (type) => Array.from({ length: 7 }, () => ({ type }));
  const cases = {
    weights: [{ weights: { Squat: 100 }, weightStamps: { Squat: at } }, { weights: { Squat: 105 }, weightStamps: { Squat: at } },
      (m) => expect(m.weights.Squat).toBe(105)],
    reps: [{ reps: { Squat: 5 }, repStamps: { Squat: at } }, { reps: { Squat: 8 }, repStamps: { Squat: at } },
      (m) => expect(m.reps.Squat).toBe(8)],
    mainLifts: [{ mainLifts: { "Barbell Back Squat": "Front Squat" }, mainLiftStamps: { "Barbell Back Squat": at } },
      { mainLifts: { "Barbell Back Squat": "Hack Squat" }, mainLiftStamps: { "Barbell Back Squat": at } },
      (m) => expect(m.mainLifts["Barbell Back Squat"]).toBe("Hack Squat")],
    userFocus: [{ userFocus: "Sculpt", userFocusUpdatedAt: at }, { userFocus: "Strong", userFocusUpdatedAt: at },
      (m) => expect(m.userFocus).toBe("Strong")],
    bodyweight: [{ bodyweight: { kg: 80, updatedAt: at } }, { bodyweight: { kg: 81, updatedAt: at } },
      (m) => expect(m.bodyweight.kg).toBe(81)],
    trainingState: [{ trainingState: { updatedAt: at, lifts: { Squat: { e1rm: 100 } } } }, { trainingState: { updatedAt: at, lifts: { Squat: { e1rm: 120 } } } },
      (m) => expect(m.trainingState.lifts.Squat.e1rm).toBe(120)],
    bodyweightLog: [{ bodyweightLog: { "2026-10-20": { kg: 80, updatedAt: at } } }, { bodyweightLog: { "2026-10-20": { kg: 82, updatedAt: at } } },
      (m) => expect(m.bodyweightLog["2026-10-20"].kg).toBe(82)],
    addedLoads: [{ addedLoads: { Dip: { kg: 5, updatedAt: at } } }, { addedLoads: { Dip: { kg: 10, updatedAt: at } } },
      (m) => expect(m.addedLoads.Dip.kg).toBe(5)], // '{"kg":5' > '{"kg":10'
    userWeek: [
      { userWeek: [{ editedAt: at, effectiveFrom: "2026-10-19", week: week("rest") }] },
      { userWeek: [{ editedAt: at, effectiveFrom: "2026-10-19", week: week("zone2") }] },
      (m) => { expect(m.userWeek).toHaveLength(1); expect(m.userWeek[0].week[0].type).toBe("zone2"); }],
  };
  for (const [field, [A, B, check]] of Object.entries(cases)) {
    it(field, () => check(allOrders({}, [A, B])));
  }

  it("streak: same count and lastDate, different content", () => {
    const A = { streak: { count: 0, lastDate: "2026-10-20" } };
    const B = { streak: { lastDate: "2026-10-20" } };
    expect(allOrders({}, [A, B]).streak).toEqual({ lastDate: "2026-10-20" }); // '{"lastDate"' > '{"count"'
  });

  it("breaks: two copies of one record that disagree on reason", () => {
    const A = { breaks: [{ id: "b1", start: "2026-10-01", reason: "ill", endedAt: null }] };
    const B = { breaks: [{ id: "b1", start: "2026-10-01", reason: "rest", endedAt: "2026-10-05" }] };
    expect(allOrders({}, [A, B]).breaks).toEqual([{ id: "b1", start: "2026-10-01", reason: "rest", endedAt: "2026-10-05" }]);
  });
});

describe("days: an entry with no updatedAt", () => {
  const D = "2026-10-02";
  it("reads at epoch and keeps that stamp, so three devices agree in any order", () => {
    const base = { days: { [D]: { date: D, scheduledType: "zone2", completedType: "zone2", sessionId: "s0", marks: {} } } };
    const A = { days: { [D]: { date: D, scheduledType: "strength", completedType: null, sessionId: null, marks: {}, updatedAt: "2026-10-02T09:00:00.000Z" } } };
    const B = { days: { [D]: { date: D, scheduledType: null, completedType: "strength", sessionId: null, marks: { bonus: true }, updatedAt: "2026-10-03T09:00:00.000Z" } } };
    const C = { days: { [D]: { date: D, scheduledType: null, completedType: null, sessionId: "s1", marks: {}, updatedAt: "2026-10-01T09:00:00.000Z" } } };
    const got = allOrders(base, [A, B, C]).days[D];
    expect(got.scheduledType).toBe("strength");
    expect(got.completedType).toBe("strength");
    expect(got.sessionId).toBe("s1");
    expect(got.marks).toEqual({ bonus: true });
  });

  it("a lone entry with no updatedAt normalises to explicit epoch stamps, idempotently", () => {
    const e = { date: D, completedType: "zone2", sessionId: null, marks: {} };
    const once = mergeDayEntries({ [D]: e }, {})[D];
    expect(once.stamps).toEqual({ completedType: "1970-01-01T00:00:00.000Z" });
    expect(mergeDayEntries({ [D]: once }, {})[D]).toEqual(once);
  });
});
