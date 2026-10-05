// @vitest-environment jsdom
// The trainer-change validator, statuses and device plan (lib/trainer-change.js).
// Pure. Every rule is pinned at its boundary and one rung past it; the
// mutation witnesses are named after the guard they hold (spec §11).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  validateOp, validateChangeSet, boundsFor, checkWeek, liftBasis, weekBasis, anchorIdOf, currentMainLift,
  changeStatus, isUndoable, planDeviceSteps, rowFromDb, anchorLogged,
  DAY_LABELS, LIVE_SLICES, OUTCOMES, KINDS, MAX_OPS, HORIZON_DAYS, SET_ID_RE, REP_LIMITS, TIMED_SECONDS, MAX_KG, RESET,
} from "@/lib/trainer-change";
import { climbRungs, MAX_JUMP_FRACTION } from "@/lib/progression";
import { STEP_SIZES, nextRung, weightStepForLoadType, categoryCeilingKg, CATEGORY_COLD_START_MAX_KG, getLiftProfile, isBodyweightMovement, sanitiseWorkingWeights } from "@/lib/lift-translations";
import { MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, EXERCISE_POOLS, WEEK } from "@/lib/programme";
import { bandViolations } from "@/lib/rotation-solver";
import { resolvedProgramme } from "@/lib/mcp-server";
import { TYPE_LABEL, ensureScheduleHistory } from "@/lib/sync-merge";
import { addDaysIso } from "@/lib/dates";
import { P, W, H, getLocalProfile, startingWeightForLift } from "@/lib/storage";
import { assembleMeta } from "@/lib/db";

const ROOT = join(import.meta.dirname, "..");
const TODAY = "2026-10-05"; // a Monday
const ago = (n) => addDaysIso(TODAY, -n);
const SET_ID = "hws_" + "a".repeat(26);
const SQUAT = "Barbell Back Squat";
const BENCH = "Barbell Bench Press";
const pool = (slot, name) => EXERCISE_POOLS[slot].pool.find((p) => p.name === name);

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
/**
 * A logged session. lifts: { name: { kg, reps?, prescribed?, loadType? } }.
 * @param {string} date
 * @param {Record<string, any>} lifts
 * @param {Record<string, any>} [extra]
 */
function rec(date, lifts, extra = {}) {
  seq += 1;
  const time = extra.time ?? `10:${String(seq % 60).padStart(2, "0")}:00`;
  const { time: _t, ...rest } = extra;
  return {
    id: `${date}T${time}.000Z`, date, schemaVersion: 3, readiness: "fresh", session: "strength-a",
    blocks: [{
      type: "main",
      exercises: Object.entries(lifts).map(([name, l]) => ({
        name, loadType: l.loadType ?? "barbell",
        prescribed: l.prescribed ?? { weight: l.kg, reps: l.reps ?? 5 },
        sets: [1, 2, 3].map(() => ({ weight: l.kg, reps: l.reps ?? 5, rir: 2, loadType: l.loadType ?? "barbell" })),
      })),
    }],
    ...rest,
  };
}

/** @returns {any} */
const ctx = (meta = {}, history = [], extra = {}) => ({ meta, history, todayIso: TODAY, phase: "write", ...extra });

/** The wire basis the trainer's pane would send for these lifts and mains. */
function basisFor(c, { lifts = [], mains = [], weeks = [] } = {}) {
  return {
    lifts: Object.fromEntries(lifts.map((l) => [l, liftBasis(l, c)])),
    mains: Object.fromEntries(mains.map((m) => [m, currentMainLift(c.meta, m)])),
    week: Object.fromEntries(weeks.map((f) => [f, weekBasis(c.meta, f)])),
  };
}

/** Validate one op in write phase with a fresh basis. */
function check(op, meta = {}, history = [], extra = {}) {
  const c = ctx(meta, history, extra);
  const basis = basisFor(c, { lifts: op.lift ? [op.lift] : [], mains: op.canonical ? [op.canonical] : [] });
  return validateOp(op, { ...c, basis });
}
const code = (r) => r.code;
const squatAt = (kg, date = ago(2), extra = {}) => rec(date, { [SQUAT]: { kg } }, extra);

// ── Set-level rules ─────────────────────────────────────────────────────────

describe("set-level rules", () => {
  const ok = { kind: "weight", lift: SQUAT, kg: 102.5 };
  const hist = [squatAt(100)];
  const run = (set, extra = {}) => {
    const c = ctx({}, hist, extra);
    return validateChangeSet(set, { ...c, basis: basisFor(c, { lifts: [SQUAT, BENCH], mains: [SQUAT, BENCH] }) });
  };

  it("accepts 1..16 ops with a minted set id", () => {
    expect(run({ id: SET_ID, ops: [ok] }).ok).toBe(true);
    const sixteen = Array.from({ length: MAX_OPS }, (_, i) => ({ kind: "reps", lift: resolvedProgramme({})[i].name, reps: 10 }));
    expect(MAX_OPS).toBe(16);
    expect(run({ id: SET_ID, ops: sixteen }).refusals.filter((r) => r.code === "set_size")).toEqual([]);
  });
  it("refuses an empty set and a 17th op", () => {
    expect(run({ id: SET_ID, ops: [] }).refusals).toEqual([{ i: null, code: "set_size" }]);
    expect(run({ id: SET_ID, ops: Array.from({ length: 17 }, () => ok) }).refusals).toEqual([{ i: null, code: "set_size" }]);
  });
  it("refuses a set without a minted id", () => {
    for (const id of [undefined, "hws_short", "hwg_" + "a".repeat(26), "hws_" + "A".repeat(26), "hws_" + "1".repeat(26)]) {
      expect(run({ id, ops: [ok] }).refusals).toEqual([{ i: null, code: "set_id" }]);
    }
    expect(SET_ID_RE.test(SET_ID)).toBe(true);
  });
  it("one op per (kind, target): the second is refused", () => {
    const r = run({ id: SET_ID, ops: [ok, { ...ok, kg: 105 }, { kind: "reps", lift: SQUAT, reps: 6 }] });
    expect(r.refusals).toEqual([{ i: 1, code: "duplicate" }]);
    expect(r.ops.map((o) => o.i)).toEqual([0, 2]);
  });
  it("at most one week op", () => {
    const wk = { kind: "week", week: WEEK, from: TODAY };
    expect(run({ id: SET_ID, ops: [wk, { ...wk, from: addDaysIso(TODAY, 7) }] }).refusals[1]).toEqual({ i: 1, code: "duplicate" });
  });
  it("a dated lift change is refused until S3, and out of range before that", () => {
    expect(LIVE_SLICES.dated).toBe(false);
    expect(run({ id: SET_ID, ops: [{ ...ok, from: addDaysIso(TODAY, 3) }] }).refusals).toEqual([{ i: 0, code: "not_yet" }]);
    expect(run({ id: SET_ID, ops: [{ ...ok, from: ago(1) }] }).refusals).toEqual([{ i: 0, code: "from_range" }]);
    expect(run({ id: SET_ID, ops: [{ ...ok, from: addDaysIso(TODAY, HORIZON_DAYS + 1) }] }).refusals).toEqual([{ i: 0, code: "from_range" }]);
    expect(run({ id: SET_ID, ops: [{ ...ok, from: "2026-13-01" }] }).refusals).toEqual([{ i: 0, code: "shape" }]);
  });
  it("a week change is refused until S2", () => {
    expect(LIVE_SLICES.week).toBe(false);
    expect(run({ id: SET_ID, ops: [{ kind: "week", week: WEEK, from: TODAY }] }).refusals).toEqual([{ i: 0, code: "not_yet" }]);
  });
  it("an unknown kind and a free-text note are not ops", () => {
    expect(run({ id: SET_ID, ops: [{ kind: "note", text: "hi" }] }).refusals).toEqual([{ i: 0, code: "kind" }]);
    expect(KINDS).toEqual(["weight", "reps", "mainLift", "week"]);
  });
  it("returns the accepted ops with before, after and the device-only basis", () => {
    const r = run({ id: SET_ID, ops: [ok] });
    expect(r.ops).toEqual([{
      i: 0, kind: "weight", target: SQUAT, before: null, after: 102.5, from: null, warnings: [],
      basis: { anchorId: hist[0].id, trainedId: hist[0].id, w: null, r: null },
    }]);
  });
});

// ── Lift eligibility ────────────────────────────────────────────────────────

describe("lift eligibility", () => {
  it("a same-set main lift counts only as its first, valid op: a refused one brings no lift in", () => {
    const c = ctx({});
    const basis = {
      ...basisFor(c, { mains: [SQUAT] }),
      lifts: { "Front Squat": liftBasis("Front Squat", c), "Hack Squat": liftBasis("Hack Squat", c) },
    };
    const run = (ops) => validateChangeSet({ id: SET_ID, ops }, { ...c, basis }).refusals;
    // The second main-lift op on the squat is a duplicate: its lift stays out, the first's comes in.
    expect(run([
      { kind: "mainLift", canonical: SQUAT, choice: "Front Squat" },
      { kind: "mainLift", canonical: SQUAT, choice: "Hack Squat" },
      { kind: "weight", lift: "Front Squat", kg: 20 },
      { kind: "weight", lift: "Hack Squat", kg: 20 },
    ])).toEqual([{ i: 1, code: "duplicate" }, { i: 3, code: "not_in_programme" }]);
    // A stray `lift` on a main-lift op changes nothing: one op per canonical, the first.
    expect(run([
      { kind: "mainLift", canonical: SQUAT, choice: "Front Squat", lift: "x" },
      { kind: "mainLift", canonical: SQUAT, choice: "Hack Squat", lift: "y" },
      { kind: "weight", lift: "Front Squat", kg: 20 },
      { kind: "weight", lift: "Hack Squat", kg: 20 },
    ])).toEqual([{ i: 1, code: "duplicate" }, { i: 3, code: "not_in_programme" }]);
    // Not an option for that main lift: refused, and its lift is not brought in.
    expect(run([
      { kind: "mainLift", canonical: SQUAT, choice: "Incline BB Press" },
      { kind: "weight", lift: "Incline BB Press", kg: 20 },
    ])).toEqual([{ i: 0, code: "not_option" }, { i: 1, code: "not_in_programme" }]);
  });
  it("refuses a lift not in the client's programme", () => {
    expect(code(check({ kind: "weight", lift: "Front Squat", kg: 60 }))).toBe("not_in_programme");
    expect(code(check({ kind: "reps", lift: "Front Squat", reps: 5 }))).toBe("not_in_programme");
  });
  it("a lift chosen by a main-lift op in the same set counts", () => {
    const c = ctx({ bodyweight: { kg: 80 } }, []);
    const kg = startingWeightForLift("Front Squat", 80);
    expect(kg).toBeGreaterThan(0);
    const set = { id: SET_ID, ops: [{ kind: "mainLift", canonical: SQUAT, choice: "Front Squat" }, { kind: "weight", lift: "Front Squat", kg }] };
    const r = validateChangeSet(set, { ...c, basis: { ...basisFor(c, { mains: [SQUAT] }), lifts: { "Front Squat": liftBasis("Front Squat", c) } } });
    expect(r.refusals).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("a rotated-in accessory is eligible", () => {
    const meta = { programmeBlock: { config: { "bss1-A": pool("bss1-A", "Hack Squat") } } };
    expect(code(check({ kind: "reps", lift: "Hack Squat", reps: 12 }, meta))).toBe(null);
    expect(code(check({ kind: "reps", lift: "Leg Press", reps: 12 }, meta))).toBe("not_in_programme");
  });
});

// ── Weight: W1-W10 ──────────────────────────────────────────────────────────

describe("W1: no weight change where W is never read", () => {
  it("refuses weight on Push-Up", () => {
    const meta = { programmeBlock: { config: { "css2-A": pool("css2-A", "Decline Push-Up") } } };
    expect(code(check({ kind: "weight", lift: "Decline Push-Up", kg: 10 }, meta))).toBe("bodyweight");
    expect(code(check({ kind: "weight", lift: "Hanging Leg Raise", kg: 5 }))).toBe("bodyweight");
    expect(boundsFor("Hanging Leg Raise", ctx())).toBe(null);
  });
  it("refuses timed holds and lifts that do not progress by load", () => {
    const timed = { programmeBlock: { config: { "afin-A": pool("afin-A", "L-Sit Hold") } } };
    expect(code(check({ kind: "weight", lift: "L-Sit Hold", kg: 5 }, timed))).toBe("bodyweight");
    const assisted = { programmeBlock: { config: { "bss1-B": pool("bss1-B", "Assisted Pull-Up") } } };
    expect(code(check({ kind: "weight", lift: "Assisted Pull-Up", kg: 20 }, assisted))).toBe("not_by_load");
    const toes = { programmeBlock: { config: { "afin-A": pool("afin-A", "Toes-to-Bar") } } };
    expect(code(check({ kind: "weight", lift: "Toes-to-Bar", kg: 5 }, toes))).toBe("not_by_load");
  });
  it("a loaded bodyweight lift takes added kg in the same band", () => {
    // 10 kg on the belt: two steps would be +2.5, but +15% a week holds it to one rung.
    const hist = [rec(ago(2), { "Pull-Up": { kg: 10, reps: 8, loadType: "loaded_bodyweight" } })];
    expect(code(check({ kind: "weight", lift: "Pull-Up", kg: 11.25 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Pull-Up", kg: 12.5 }, {}, hist))).toBe("per_week");
    const older = [rec(ago(9), { "Pull-Up": { kg: 10, reps: 8, loadType: "loaded_bodyweight" } }), rec(ago(2), { "Pull-Up": { kg: 11.25, reps: 8, loadType: "loaded_bodyweight" } })];
    expect(code(check({ kind: "weight", lift: "Pull-Up", kg: 11.25 }, {}, older))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Pull-Up", kg: 3.75 }, {}, hist))).toBe("floor");
  });
});

describe("W2: the drum's range, on the implement's grid", () => {
  const hist = [squatAt(100), rec(ago(2), { "Chest-Supported DB Row": { kg: 22, reps: 10, loadType: "per_db" } })];
  it("0 < kg ≤ 400", () => {
    for (const kg of [0, -2.5, NaN, Infinity, "100", null]) expect(code(check({ kind: "weight", lift: SQUAT, kg }, {}, hist))).toBe("range");
    expect(MAX_KG).toBe(400);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 401.25 }, {}, hist))).toBe("range");
  });
  it("off-grid is refused, never snapped", () => {
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 101 }, {}, hist))).toBe("off_grid");
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 101.25 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Chest-Supported DB Row", kg: 22.5 }, {}, hist))).toBe("off_grid");
    expect(code(check({ kind: "weight", lift: "Chest-Supported DB Row", kg: 23 }, {}, hist))).toBe(null);
  });
});

describe("W3: the sanitiser's ceiling", () => {
  it("allows exactly the ceiling, refuses one rung past it", () => {
    // Lateral Raise: per_db, isolation cap 25 → ceiling 37.5, off the 1 kg grid.
    const hist = [rec(ago(2), { "Lateral Raise": { kg: 36, reps: 15, loadType: "per_db" } })];
    expect(categoryCeilingKg("Lateral Raise")).toBe(37.5);
    expect(code(check({ kind: "weight", lift: "Lateral Raise", kg: 37 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Lateral Raise", kg: 38 }, {}, hist))).toBe("ceiling");
    expect(boundsFor("Lateral Raise", ctx({}, hist)).max).toBe(37);
  });

  it("holds for a top set at or over it, since their app clamps anything over it; max is never under min", () => {
    const CALF = "Standing Calf Raise";
    const lt = resolvedProgramme({}).find((l) => l.name === CALF).loadType;
    const ceiling = categoryCeilingKg(CALF);
    expect(ceiling).toBe(37.5);
    // The client's app clamps a W over the ceiling, whatever the top set: nothing accepted may sit over it.
    expect(sanitiseWorkingWeights({ [CALF]: ceiling })[CALF]).toBe(ceiling);
    expect(sanitiseWorkingWeights({ [CALF]: 40 })[CALF]).not.toBe(40);
    const at = (kg) => ctx({}, [rec(ago(2), { [CALF]: { kg, reps: 12, loadType: lt } })]);
    const v = (c, x) => validateOp({ kind: "weight", lift: CALF, kg: x }, { ...c, basis: basisFor(c, { lifts: [CALF] }) });
    // At the ceiling or a little over: the range runs from the floor up to the ceiling.
    for (const kg of [ceiling, 50]) {
      const c = at(kg);
      const b = boundsFor(CALF, c);
      expect(b, `${kg}`).toMatchObject({ max: ceiling, blocked: null });
      expect(b.max, `${kg}`).toBeGreaterThanOrEqual(b.min);
      expect(v(c, b.max), `${kg}`).toMatchObject({ ok: true });
      expect(v(c, b.min), `${kg}`).toMatchObject({ ok: true });
      expect(code(v(c, b.max + b.step)), `${kg}`).toBe("ceiling");
    }
    // Far over it the deload floor sits over the ceiling: nothing is accepted, and the pane reads it as blocked.
    for (const kg of [60, 100]) {
      const c = at(kg);
      const b = boundsFor(CALF, c);
      expect(b, `${kg}`).toMatchObject({ min: ceiling, max: ceiling, blocked: { code: "ceiling", until: null } });
      expect(code(v(c, b.max)), `${kg}`).toBe("floor");
      expect(code(v(c, kg)), `${kg}`).toBe("ceiling");
    }
    // Under the ceiling it holds; never lifted, the cap or the template does.
    const under = at(30);
    expect(boundsFor(CALF, under).max).toBeLessThanOrEqual(ceiling);
    expect(code(v(under, 40))).toBe("ceiling");
    expect(boundsFor(CALF, ctx({}))).toMatchObject({ max: 35, blocked: null });
  });
});

describe("W4: the anchor is the last performed top set", () => {
  it("skips travel and cooked records", () => {
    const hist = [squatAt(100, ago(5)), squatAt(60, ago(3), { travel: true }), squatAt(70, ago(2), { readiness: "cooked" })];
    expect(liftBasis(SQUAT, ctx({}, hist))).toMatchObject({ anchorDate: ago(5), anchorKg: 100 });
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 110 }, {}, hist))).toBe(null);
  });
  it("credits only an earned reach set", () => {
    const r = rec(ago(2), { [SQUAT]: { kg: 100 } });
    r.blocks[0].exercises[0].sets.push({ weight: 120, reps: 3, rir: 0, reach: true, loadType: "barbell" });
    expect(liftBasis(SQUAT, ctx({}, [r])).anchorKg).toBe(100);
  });
  it("two stacked +10% sends cannot pass anchor + 10%", () => {
    // The first send landed in W; the client has not trained since.
    const hist = [squatAt(100)];
    const meta = { weights: { [SQUAT]: 110 } };
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 110 }, meta, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 121.25 }, meta, hist))).toBe("per_change");
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 111.25 }, meta, hist))).toBe("per_change");
  });
});

describe("W5: up per change, max(2 engine steps, 10%) or one rung", () => {
  it("a 100 kg squat allows +10, where the engine's fastest climb is +5", () => {
    const hist = [squatAt(100)];
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 110 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 111.25 }, {}, hist))).toBe("per_change");
    const engine = 100 + STEP_SIZES.lower_compound * climbRungs({ consecutiveAdds: 9, rir: 4, addThresholdRir: 2, step: STEP_SIZES.lower_compound, currentWeight: 100 });
    expect(engine).toBe(105); // the documented difference (O2)
    expect(MAX_JUMP_FRACTION).toBe(0.10);
  });
  it("two engine steps win on a light lift", () => {
    // 40 kg squat: 2 × 2.5 = 5 > 10% (4).
    const hist = [squatAt(40)];
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 45 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 46.25 }, {}, hist))).toBe("per_change");
  });
  it("per_db grid: a 22 kg row goes to 24, not 25", () => {
    const hist = [rec(ago(2), { "Chest-Supported DB Row": { kg: 22, reps: 10, loadType: "per_db" } })];
    expect(code(check({ kind: "weight", lift: "Chest-Supported DB Row", kg: 24 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Chest-Supported DB Row", kg: 25 }, {}, hist))).toBe("per_change");
  });
  it("machine grid: a 100 kg leg press goes to 110 on 2.5 kg pins", () => {
    const hist = [rec(ago(2), { "Leg Press": { kg: 100, reps: 10, loadType: "machine" } })];
    expect(code(check({ kind: "weight", lift: "Leg Press", kg: 110 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Leg Press", kg: 112.5 }, {}, hist))).toBe("per_change");
  });
  it("one rung up is always allowed: a 20 kg pushdown may go to 22.5", () => {
    const hist = [rec(ago(2), { "Tricep Pushdown": { kg: 20, reps: 12, loadType: "total" } })];
    expect(nextRung(20, "total", +1)).toBe(22.5);
    expect(code(check({ kind: "weight", lift: "Tricep Pushdown", kg: 22.5 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Tricep Pushdown", kg: 25 }, {}, hist))).toBe("per_change");
  });
});

describe("W6: up per rolling 7 days", () => {
  it("a third send in 7 days cannot pass 1.15 × anchor7", () => {
    // 100 a week ago, then two trainer sends trained at 105 and 110.
    const hist = [squatAt(100, ago(8)), squatAt(105, ago(5)), squatAt(110, ago(2))];
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 115 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 116.25 }, {}, hist))).toBe("per_week");
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 120 }, {}, hist))).toBe("per_week"); // inside +10% of 110
  });
  it("with nothing a week old, the last top set stands in", () => {
    const hist = [squatAt(100, ago(3))];
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 110 }, {}, hist))).toBe(null);
  });
  it("a week ago is exactly today − 7: a top set then counts, one a day later does not", () => {
    // Counted: 1.15 × 100 → 115 per week, under the 120 one change from 110 allows.
    const weekOld = [squatAt(100, ago(7)), squatAt(110, ago(2))];
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 115 }, {}, weekOld))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 116.25 }, {}, weekOld))).toBe("per_week");
    // Six days old is not a week: the last top set stands in, so per change governs.
    const sixDays = [squatAt(100, ago(6)), squatAt(110, ago(2))];
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 116.25 }, {}, sixDays))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 120 }, {}, sixDays))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 121.25 }, {}, sixDays))).toBe("per_change");
  });
});

describe("W7: down to the engine's deload load", () => {
  const hist = [squatAt(100)];
  it("refuses below 65% on a squat", () => {
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 65 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 63.75 }, {}, hist))).toBe("floor");
  });
  it("warns big_drop below 85%", () => {
    expect(check({ kind: "weight", lift: SQUAT, kg: 82.5 }, {}, hist).warnings).toEqual(["big_drop"]);
    expect(check({ kind: "weight", lift: SQUAT, kg: 85 }, {}, hist).warnings).toEqual([]);
  });
  it("60% on power, 70% on accessories, rounded up to the grid", () => {
    const clean = [rec(ago(2), { "Power Clean": { kg: 60, reps: 3 } })];
    expect(code(check({ kind: "weight", lift: "Power Clean", kg: 36.25 }, {}, clean))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Power Clean", kg: 35 }, {}, clean))).toBe("floor");
    const row = [rec(ago(2), { "Chest-Supported DB Row": { kg: 22, reps: 10, loadType: "per_db" } })];
    // upper_pull is a main category (65%): 14.3 → 15 on the 1 kg grid.
    expect(code(check({ kind: "weight", lift: "Chest-Supported DB Row", kg: 15 }, {}, row))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Chest-Supported DB Row", kg: 14 }, {}, row))).toBe("floor");
    const curl = [rec(ago(2), { "DB Curl": { kg: 12, reps: 12, loadType: "per_db" } })];
    expect(code(check({ kind: "weight", lift: "DB Curl", kg: 9 }, {}, curl))).toBe(null); // 8.4 → 9
    expect(code(check({ kind: "weight", lift: "DB Curl", kg: 8 }, {}, curl))).toBe("floor");
  });
});

describe("W8: never performed — the larger of the category's cold-start cap and the template, in every phase", () => {
  /** The public first-load top: max(category cap, template weight) on the lift's grid. */
  const firstMax = (lift) => {
    const step = weightStepForLoadType(lift.loadType);
    const top = Math.max(CATEGORY_COLD_START_MAX_KG[getLiftProfile(lift.name).category], lift.ex.weight ?? 0);
    return Math.round(Math.floor(top / step + 1e-9) * step * 100) / 100;
  };
  const up = (kg, lt) => Math.round((kg + weightStepForLoadType(lt)) * 100) / 100;
  const inPhase = (op, meta, phase, history = []) => {
    const c = { ...ctx(meta, history), phase };
    return validateOp(op, { ...c, basis: basisFor(c, { lifts: op.lift ? [op.lift] : [] }) });
  };
  // Every primary muscle of every lift any main-lift choice brings in.
  const MUSCLES = [...new Set([
    ...resolvedProgramme({}),
    ...Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS).flatMap(([c, alts]) => alts.flatMap((a) => resolvedProgramme({ mainLifts: { [c]: a } }))),
  ].map((l) => getLiftProfile(l.name).primaryMuscle).filter(Boolean))];
  const anchorsAt = (e1rm) => Object.fromEntries(MUSCLES.map((m) => [m, { bestE1RM: e1rm }]));
  // Far-apart bodyweights and far-apart anchor sets on every muscle: nothing about the client moves an answer, in any phase.
  const PROBES = [
    {},
    { bodyweight: { kg: 40 } },
    { bodyweight: { kg: 60 } },
    { bodyweight: { kg: 120 } },
    { bodyweight: { kg: 200 } },
    { trainingState: { muscleAnchors: anchorsAt(20) } },
    { trainingState: { muscleAnchors: anchorsAt(400) } },
    { bodyweight: { kg: 200 }, trainingState: { muscleAnchors: anchorsAt(400) } },
  ];
  it("the anchor probes cover every primary muscle in the programme", () => {
    expect(MUSCLES.length).toBeGreaterThan(8);
    for (const m of ["Quadriceps", "Chest", "Calves", "Hamstrings", "Triceps", "Biceps"]) expect(MUSCLES, m).toContain(m);
  });

  it("up to the cap or the template, whichever is larger; one step more is refused; write and apply alike, whatever the bodyweight or anchors", () => {
    let checked = 0;
    for (const lift of resolvedProgramme({})) {
      if (isBodyweightMovement(lift.loadType) || boundsFor(lift.name, ctx({})) === null) continue;
      const max = firstMax(lift);
      const ref = boundsFor(lift.name, ctx({}));
      expect(ref, lift.name).toMatchObject({ max, blocked: null });
      for (const meta of PROBES) {
        for (const phase of ["write", "apply"]) {
          expect(boundsFor(lift.name, { ...ctx(meta), phase }), `${lift.name} ${phase}`).toEqual(ref);
          expect(code(inPhase({ kind: "weight", lift: lift.name, kg: max }, meta, phase)), `${lift.name} ${max} ${phase}`).toBe(null);
          expect(code(inPhase({ kind: "weight", lift: lift.name, kg: up(max, lift.loadType) }, meta, phase)), `${lift.name} max + step ${phase}`)
            .toBe(up(max, lift.loadType) > categoryCeilingKg(lift.name) ? "ceiling" : "no_history");
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
  });
  it("Standing Calf Raise and Machine Hamstring Curl take their template weight (35) over the isolation cap (25)", () => {
    expect(CATEGORY_COLD_START_MAX_KG.accessory_isolation).toBe(25);
    for (const name of ["Standing Calf Raise", "Machine Hamstring Curl"]) {
      expect(resolvedProgramme({}).find((l) => l.name === name).ex.weight, name).toBe(35);
      expect(boundsFor(name, ctx({})), name).toMatchObject({ max: 35, blocked: null });
      for (const phase of ["write", "apply"]) {
        expect(code(inPhase({ kind: "weight", lift: name, kg: 35 }, {}, phase)), `${name} ${phase}`).toBe(null);
        expect(code(inPhase({ kind: "weight", lift: name, kg: 37.5 }, {}, phase)), `${name} ${phase}`).toBe("no_history");
        expect(code(inPhase({ kind: "weight", lift: name, kg: 40 }, {}, phase)), `${name} ${phase}`).toBe("ceiling");
      }
    }
  });
  it("a squat's first load is 250 kg at most, at any bodyweight, in both phases", () => {
    expect(CATEGORY_COLD_START_MAX_KG.lower_compound).toBe(250);
    for (const meta of PROBES) {
      for (const phase of ["write", "apply"]) {
        expect(code(inPhase({ kind: "weight", lift: SQUAT, kg: 250 }, meta, phase))).toBe(null);
        expect(code(inPhase({ kind: "weight", lift: SQUAT, kg: 251.25 }, meta, phase))).toBe("no_history");
      }
    }
  });
  it("probe: every kg answers the same across bodyweights, anchors and phases", () => {
    for (const name of [SQUAT, BENCH, "Barbell Overhead Press", "Lateral Raise", "Standing Calf Raise", "Machine Hamstring Curl"]) {
      const lt = resolvedProgramme({}).find((l) => l.name === name).loadType;
      const step = weightStepForLoadType(lt);
      const answers = PROBES.flatMap((meta) => ["write", "apply"].map((phase) => {
        const out = [];
        for (let kg = step; kg <= MAX_KG; kg = Math.round((kg + step) * 100) / 100) out.push(code(inPhase({ kind: "weight", lift: name, kg }, meta, phase)));
        return out.join(",");
      }));
      for (const a of answers) expect(a, name).toBe(answers[0]);
    }
  });
  it("a swapped-in main with no template of its own takes up to its cap, at write and at apply alike", () => {
    for (const [canonical, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      for (const choice of alts) {
        const meta = { mainLifts: { [canonical]: choice } };
        const lift = resolvedProgramme(meta).find((l) => l.name === choice);
        if (lift.loadType === "loaded_bodyweight" || lift.ex.weight != null) continue;
        const max = firstMax(lift);
        expect(boundsFor(choice, ctx(meta)), choice).toMatchObject({ max, blocked: null });
        for (const phase of ["write", "apply"]) {
          expect(code(inPhase({ kind: "weight", lift: choice, kg: max }, meta, phase)), `${choice} ${phase}`).toBe(null);
          expect(code(inPhase({ kind: "weight", lift: choice, kg: up(max, lift.loadType) }, meta, phase)), `${choice} ${phase}`).not.toBe(null);
        }
      }
    }
    const c = ctx({});
    const set = { id: SET_ID, ops: [{ kind: "mainLift", canonical: SQUAT, choice: "Front Squat" }, { kind: "weight", lift: "Front Squat", kg: 250 }] };
    const basis = { ...basisFor(c, { mains: [SQUAT] }), lifts: { "Front Squat": liftBasis("Front Squat", c) } };
    expect(validateChangeSet(set, { ...c, basis }).refusals).toEqual([]);
    const over = { ...set, ops: [set.ops[0], { kind: "weight", lift: "Front Squat", kg: 251.25 }] };
    expect(validateChangeSet(over, { ...c, basis }).refusals).toEqual([{ i: 1, code: "no_history" }]);
  });
  it("at apply: a never-lifted lift at the max lands; one step over acks limits; bodyweight and anchors change nothing", () => {
    const sent = (kg) => row({ before: null, after: kg, basis: { anchorId: null, trainedId: null, w: null, r: null } });
    const at = (kg, meta) => planDeviceSteps([sent(kg)], { meta, history: [], todayIso: TODAY });
    const metas = [{ bodyweight: { kg: 60 } }, { bodyweight: { kg: 120 } }, { trainingState: { muscleAnchors: anchorsAt(20) } },
      { trainingState: { muscleAnchors: anchorsAt(400) } }, {}];
    for (const meta of metas) {
      expect(at(250, meta), JSON.stringify(meta)).toMatchObject({ weights: { [SQUAT]: 250 }, acks: [{ outcome: "applied" }] });
      expect(at(251.25, meta), JSON.stringify(meta)).toMatchObject({ weights: {}, acks: [{ outcome: "limits" }] });
      expect(at(250, meta)).toEqual(at(250, metas[0]));
      expect(at(251.25, meta)).toEqual(at(251.25, metas[0]));
    }
  });
  it("a bodyweight movement's added kg: two engine steps from 0, whatever the bodyweight, in both phases", () => {
    const max = Math.max(nextRung(0, "loaded_bodyweight", +1), 2 * STEP_SIZES[getLiftProfile("Pull-Up").category]);
    expect(max).toBeLessThanOrEqual(5);
    const bodyweightOnly = [rec(ago(2), { "Pull-Up": { kg: 0, reps: 8, loadType: "loaded_bodyweight" } })];
    for (const [meta, hist] of [[{ bodyweight: { kg: 80 } }, []], [{}, []], [{ bodyweight: { kg: 80 } }, bodyweightOnly]]) {
      expect(boundsFor("Pull-Up", ctx(meta, hist))).toMatchObject({ max, blocked: null });
      for (const phase of ["write", "apply"]) {
        expect(code(inPhase({ kind: "weight", lift: "Pull-Up", kg: max }, meta, phase, hist))).toBe(null);
        expect(code(inPhase({ kind: "weight", lift: "Pull-Up", kg: max + 1.25 }, meta, phase, hist))).toBe("no_history");
        expect(code(inPhase({ kind: "weight", lift: "Pull-Up", kg: 100 }, meta, phase, hist))).toBe("no_history");
      }
    }
  });
  it("the validator reads no bodyweight, muscle anchor or engine start, in any phase", () => {
    const SRC = readFileSync(join(ROOT, "lib/trainer-change.js"), "utf8");
    const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/bodyweight\?*\.kg|muscleAnchors|planStartWeight|startingWeightForLift|NO_HISTORY_FACTOR/);
  });
});

describe("a top set read from a derived load is reps only, in both phases", () => {
  /** A squat set logged as barbell whose effectiveLoad carries the body. */
  const derivedSquat = (body) => {
    const r = rec(ago(2), { [SQUAT]: { kg: 100 } });
    r.blocks[0].exercises[0].sets = [{ weight: 100, reps: 5, rir: 2, loadType: "barbell", bodyweightUsed: body, effectiveLoad: 100 + body }];
    return r;
  };
  /** A legacy Pull-Up set logged under 'bodyweight' whose weight is the body. */
  const legacyPullUp = (body) => {
    const r = rec(ago(2), { "Pull-Up": { kg: body, reps: 6, loadType: "bodyweight" } });
    r.blocks[0].exercises[0].sets = [{ weight: body, reps: 6, rir: 2, loadType: "bodyweight", bodyweightUsed: body, effectiveLoad: body }];
    return r;
  };
  const sweep = (name, history, meta, phase) => {
    const lt = resolvedProgramme({}).find((l) => l.name === name).loadType;
    const step = weightStepForLoadType(lt);
    const out = [];
    for (let kg = step; kg <= MAX_KG; kg = Math.round((kg + step) * 100) / 100) {
      const c = { ...ctx(meta, history), phase };
      out.push(code(validateOp({ kind: "weight", lift: name, kg }, { ...c, basis: basisFor(c, { lifts: [name] }) })));
    }
    return out;
  };

  it("every kg on the grid answers the same at far-apart bodyweights, and the answer names no number", () => {
    for (const [name, make] of [[SQUAT, derivedSquat], ["Pull-Up", legacyPullUp]]) {
      for (const phase of ["write", "apply"]) {
        const [light, heavy] = [60, 100].map((body) => sweep(name, [make(body)], { bodyweight: { kg: body } }, phase));
        expect(heavy, `${name} ${phase}`).toEqual(light);
        expect(new Set(light), `${name} ${phase}`).toEqual(new Set(["reps_only"]));
      }
      for (const body of [60, 100]) {
        expect(boundsFor(name, ctx({ bodyweight: { kg: body } }, [make(body)])), name).toBe(null);
        expect(anchorLogged([make(body)], name, resolvedProgramme({}).find((l) => l.name === name).loadType), name).toBe(false);
      }
    }
  });
  it("reps still change, and a plain logged top set is measured from as before", () => {
    expect(code(check({ kind: "reps", lift: SQUAT, reps: 6 }, {}, [derivedSquat(80)]))).toBe(null);
    expect(anchorLogged([squatAt(100)], SQUAT, "barbell")).toBe(true);
    expect(anchorLogged([], SQUAT, "barbell")).toBe(true);
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 110 }, {}, [squatAt(100)]))).toBe(null);
  });
  it("a week-ago top set the view withholds sets no limit: one rung up that week, whatever the body", () => {
    const weekAgo = (body) => {
      const r = rec(ago(9), { [SQUAT]: { kg: 50 } });
      r.blocks[0].exercises[0].sets = [{ weight: 50, reps: 5, rir: 2, loadType: "barbell", bodyweightUsed: body, effectiveLoad: 50 + body }];
      return r;
    };
    const [light, heavy] = [40, 200].map((body) => boundsFor(SQUAT, ctx({ bodyweight: { kg: body } }, [weekAgo(body), squatAt(100)])));
    expect(heavy).toEqual(light);
    expect(light).toMatchObject({ max: nextRung(100, "barbell", +1), blocked: null });
    for (const body of [40, 200]) {
      for (const phase of ["write", "apply"]) {
        const c = { ...ctx({ bodyweight: { kg: body } }, [weekAgo(body), squatAt(100)]), phase };
        const at = (kg) => code(validateOp({ kind: "weight", lift: SQUAT, kg }, { ...c, basis: basisFor(c, { lifts: [SQUAT] }) }));
        expect(at(101.25), `${body} ${phase}`).toBe(null);
        expect(at(102.5), `${body} ${phase}`).toBe("per_week");
      }
    }
  });
  it("mixed load types: a derived load in one set makes the lift reps only, whatever its size or the body", () => {
    // A squat (and a bench) session with a plain barbell set and a set whose effectiveLoad carries the body:
    // loaded (added kg + body) or assisted (body − assist, which equals the assist at body 80).
    const second = {
      loaded: (body) => ({ weight: 20, reps: 8, rir: 2, loadType: "loaded_bodyweight", bodyweightUsed: body, effectiveLoad: 20 + body }),
      assisted: (body) => ({ weight: 40, reps: 8, rir: 2, loadType: "assisted_bodyweight", bodyweightUsed: body, effectiveLoad: body - 40 }),
    };
    const mixed = (name, body, shape) => {
      const r = rec(ago(2), { [name]: { kg: 100 } });
      r.blocks[0].exercises[0].sets = [{ weight: 100, reps: 5, rir: 2, loadType: "barbell" }, second[shape](body)];
      return r;
    };
    for (const [name, shape] of [[SQUAT, "loaded"], [BENCH, "loaded"], [SQUAT, "assisted"], [BENCH, "assisted"]]) {
      const lt = resolvedProgramme({}).find((l) => l.name === name).loadType;
      const answers = [50, 60, 80, 100, 120].map((body) => {
        const hist = [mixed(name, body, shape)];
        const meta = { bodyweight: { kg: body } };
        return JSON.stringify({
          write: sweep(name, hist, meta, "write"), apply: sweep(name, hist, meta, "apply"),
          bounds: boundsFor(name, ctx(meta, hist)), logged: anchorLogged(hist, name, lt),
        });
      });
      for (const a of answers) expect(a, `${name} ${shape}`).toBe(answers[0]);
      const one = JSON.parse(answers[0]);
      expect(new Set([...one.write, ...one.apply]), name).toEqual(new Set(["reps_only"]));
      expect(one.bounds, name).toBe(null);
      expect(one.logged, name).toBe(false);
    }
  });
  it("an untyped set carrying an effectiveLoad reads as derived, whatever its values: the same answer at every body", () => {
    // Not a shape the app writes (logSet and the v1 migration type every set). An assisted
    // effectiveLoad (body − 40) on it would match the 40 kg weight at body 80 only.
    const untyped = (name, body) => {
      const r = rec(ago(2), { [name]: { kg: 100 } });
      const ex = r.blocks[0].exercises[0];
      delete ex.loadType;
      ex.sets = [{ weight: 100, reps: 5, rir: 2 }, { weight: 40, reps: 8, rir: 2, bodyweightUsed: body, effectiveLoad: Math.max(0, body - 40) }];
      return r;
    };
    // The exercise typed, the set not: the same.
    const setUntyped = (name, body) => {
      const r = untyped(name, body);
      r.blocks[0].exercises[0].loadType = "barbell";
      return r;
    };
    for (const [name, make] of [[SQUAT, untyped], [BENCH, untyped], [SQUAT, setUntyped], [BENCH, setUntyped]]) {
      const lt = resolvedProgramme({}).find((l) => l.name === name).loadType;
      const answers = [50, 60, 80, 81, 100, 120].map((body) => {
        const hist = [make(name, body)];
        const meta = { bodyweight: { kg: body } };
        return JSON.stringify({
          write: sweep(name, hist, meta, "write"), bounds: boundsFor(name, ctx(meta, hist)), logged: anchorLogged(hist, name, lt),
        });
      });
      for (const a of answers) expect(a, name).toBe(answers[0]);
      const one = JSON.parse(answers[0]);
      expect(new Set(one.write), name).toEqual(new Set(["reps_only"]));
      expect(one.bounds, name).toBe(null);
      expect(one.logged, name).toBe(false);
    }
    // A typed set whose effectiveLoad equals its weight (logSet's and the migration's shape) still reads as logged.
    const typed = rec(ago(2), { [SQUAT]: { kg: 100 } });
    typed.blocks[0].exercises[0].sets = typed.blocks[0].exercises[0].sets.map((x) => ({ ...x, loadType: "external", effectiveLoad: 100 }));
    expect(anchorLogged([typed], SQUAT, resolvedProgramme({}).find((l) => l.name === SQUAT).loadType)).toBe(true);
  });
  it("at apply a row onto such a lift acks limits and writes nothing", () => {
    const hist = [derivedSquat(80)];
    const r = row({ before: null, after: 105, basis: { anchorId: anchorIdOf(hist, SQUAT), trainedId: hist[0].id, w: null, r: null } });
    expect(planDeviceSteps([r], { meta: { bodyweight: { kg: 80 } }, history: hist, todayIso: TODAY })).toMatchObject({ weights: {}, acks: [{ outcome: "limits" }] });
  });
});

describe("W9: deload and recovery session 1", () => {
  const hist = [squatAt(100)];
  it("refuses during activeDeload and recovery session 1", () => {
    const deload = { trainingState: { mesocycle: { activeDeload: { startedAt: "2026-10-03T09:00:00.000Z", plannedDays: 5 } } } };
    const r = check({ kind: "weight", lift: SQUAT, kg: 102.5 }, deload, hist);
    expect(r.code).toBe("deload");
    expect(r.until).toBe(addDaysIso(new Date("2026-10-03T09:00:00.000Z"), 5));
    const recovery = { trainingState: { lifts: { [SQUAT]: { inRecoveryUntil: 3 } } } };
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 102.5 }, recovery, hist))).toBe("recovery");
    expect(code(check({ kind: "weight", lift: BENCH, kg: 50 }, recovery, hist))).toBe(null);
  });
  it("reads as deload even when the number also breaks a limit", () => {
    const deload = { trainingState: { mesocycle: { activeDeload: { startedAt: "2026-10-03T09:00:00.000Z", plannedDays: 5 } } } };
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 150 }, deload, hist))).toBe("deload");
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 50 }, deload, hist))).toBe("deload");
  });
  it("recovery session 2 takes a change", () => {
    const recovery = { trainingState: { lifts: { [SQUAT]: { inRecoveryUntil: 2 } } } };
    expect(code(check({ kind: "weight", lift: SQUAT, kg: 102.5 }, recovery, hist))).toBe(null);
  });
  it("the pane's bounds say so", () => {
    const recovery = { trainingState: { lifts: { [SQUAT]: { inRecoveryUntil: 3 } } } };
    expect(boundsFor(SQUAT, ctx(recovery, hist)).blocked).toEqual({ code: "recovery", until: null });
    expect(boundsFor(SQUAT, ctx({}, hist)).blocked).toBe(null);
  });
});

describe("W10: a stale basis (write phase only)", () => {
  const hist = [squatAt(100)];
  const meta = { weights: { [SQUAT]: 102.5 } };
  const op = { kind: "weight", lift: SQUAT, kg: 105 };
  it("passes when the pane saw what the server reads", () => {
    const r = check(op, meta, hist);
    expect(r).toMatchObject({ ok: true, stale: false, code: null });
    expect(r.change).toMatchObject({ before: 102.5, after: 105 });
  });
  it("is stale when they trained, or W moved, since the pane looked", () => {
    const c = ctx(meta, hist);
    const saw = liftBasis(SQUAT, c);
    for (const lifts of [{}, { [SQUAT]: { ...saw, anchorKg: 97.5 } }, { [SQUAT]: { ...saw, anchorDate: ago(9) } }, { [SQUAT]: { ...saw, w: 100 } }]) {
      const r = validateOp(op, { ...c, basis: { lifts } });
      expect(r).toMatchObject({ ok: false, stale: true, code: null });
    }
  });
  it("a set with a stale op is stale, not refused", () => {
    const c = ctx(meta, hist);
    const r = validateChangeSet({ id: SET_ID, ops: [op] }, { ...c, basis: { lifts: {} } });
    expect(r).toMatchObject({ ok: false, stale: true, refusals: [] });
  });
  it("is not checked at apply", () => {
    expect(validateOp(op, { ...ctx(meta, hist), phase: "apply" })).toMatchObject({ ok: true, stale: false });
  });
});

// ── Reps: R1-R5 ─────────────────────────────────────────────────────────────

describe("reps", () => {
  const timed = { programmeBlock: { config: { "afin-A": pool("afin-A", "L-Sit Hold") } } };
  it("R1: a timed hold takes 5..180 s in fives, stored as an integer", () => {
    expect(TIMED_SECONDS).toEqual({ min: 5, max: 180, step: 5 });
    for (const s of [5, 180]) expect(check({ kind: "reps", lift: "L-Sit Hold", reps: s }, timed).change.after).toBe(s);
    for (const s of [0, 185, 7, 20.5]) expect(code(check({ kind: "reps", lift: "L-Sit Hold", reps: s }, timed))).toBe("timed_range");
  });
  it("R2: an integer 3..30, in the template's shape", () => {
    expect(REP_LIMITS).toEqual({ min: 3, max: 30 });
    expect(check({ kind: "reps", lift: SQUAT, reps: 3 }).change.after).toBe(3);
    expect(check({ kind: "reps", lift: SQUAT, reps: 30 }).change.after).toBe(30);
    for (const r of [2, 31, 5.5, "6"]) expect(code(check({ kind: "reps", lift: SQUAT, reps: r }))).toBe("reps_range");
    expect(check({ kind: "reps", lift: "DB Reverse Lunge", reps: 10 }).change.after).toBe("10/leg");
  });
  it("R2: the programme's mains at 5 stay legal", () => {
    expect(check({ kind: "reps", lift: BENCH, reps: 5 }).ok).toBe(true);
  });
  it("R3: warns outside the programme's range or the effective band, never refuses", () => {
    expect(check({ kind: "reps", lift: SQUAT, reps: 5 }).warnings).toEqual(["below_rep_band"]);
    expect(check({ kind: "reps", lift: SQUAT, reps: 4 }).warnings).toEqual(["off_programme_reps", "below_rep_band"]);
    expect(check({ kind: "reps", lift: "Chest-Supported DB Row", reps: 10 }).warnings).toEqual([]);
    expect(check({ kind: "reps", lift: "Chest-Supported DB Row", reps: 12 }).warnings).toEqual(["off_programme_reps"]);
  });
  it("R4: warns double_progression when a set raises both kg and reps", () => {
    const meta = { weights: { [SQUAT]: 100 }, reps: { [SQUAT]: 5 } };
    const hist = [squatAt(100)];
    const c = ctx(meta, hist);
    const basis = basisFor(c, { lifts: [SQUAT] });
    const both = validateChangeSet({ id: SET_ID, ops: [{ kind: "weight", lift: SQUAT, kg: 105 }, { kind: "reps", lift: SQUAT, reps: 6 }] }, { ...c, basis });
    expect(both.warnings.filter((w) => w.code === "double_progression")).toEqual([{ i: 0, code: "double_progression" }, { i: 1, code: "double_progression" }]);
    const one = validateChangeSet({ id: SET_ID, ops: [{ kind: "weight", lift: SQUAT, kg: 97.5 }, { kind: "reps", lift: SQUAT, reps: 6 }] }, { ...c, basis });
    expect(one.warnings.filter((w) => w.code === "double_progression")).toEqual([]);
  });
  it("R5: stale when R moved", () => {
    const c = ctx({ reps: { [SQUAT]: 6 } });
    const r = validateOp({ kind: "reps", lift: SQUAT, reps: 8 }, { ...c, basis: { lifts: { [SQUAT]: { anchorDate: null, anchorKg: null, w: null, r: 5 } } } });
    expect(r).toMatchObject({ stale: true, ok: false });
    expect(validateOp({ kind: "reps", lift: SQUAT, reps: 8 }, { ...c, basis: basisFor(c, { lifts: [SQUAT] }) }).ok).toBe(true);
  });
});

// ── Main lifts: M1-M4 ───────────────────────────────────────────────────────

describe("main lifts", () => {
  it("M1: a listed equivalent, or back to the programme's own", () => {
    expect(check({ kind: "mainLift", canonical: SQUAT, choice: "Front Squat" }).change).toMatchObject({ before: SQUAT, after: "Front Squat", basis: { choice: SQUAT } });
    expect(check({ kind: "mainLift", canonical: SQUAT, choice: SQUAT }, { mainLifts: { [SQUAT]: "Hack Squat" } }).change).toMatchObject({ before: "Hack Squat", after: SQUAT });
    expect(code(check({ kind: "mainLift", canonical: BENCH, choice: "Front Squat" }))).toBe("not_option");
    expect(code(check({ kind: "mainLift", canonical: SQUAT, choice: "" }))).toBe("shape");
  });
  it("M1's quirk: an unknown canonical is refused, even with an equal choice", () => {
    expect(code(check({ kind: "mainLift", canonical: "Leg Press", choice: "Leg Press" }))).toBe("not_main");
    expect(code(check({ kind: "mainLift", canonical: "Nope", choice: "Nope" }))).toBe("not_main");
  });
  it("M1: inherited object keys are not main lifts, and never throw", () => {
    for (const canonical of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(code(check({ kind: "mainLift", canonical, choice: "x" })), canonical).toBe("not_main");
      expect(code(check({ kind: "mainLift", canonical, choice: canonical })), canonical).toBe("not_main");
      const r = validateChangeSet({ id: SET_ID, ops: [{ kind: "mainLift", canonical, choice: "x" }] }, ctx());
      expect(r.refusals).toEqual([{ i: 0, code: "not_main" }]);
    }
  });
  it("M2: warns band exactly when the choice adds muscles out of band", () => {
    let warned = 0;
    for (const [canonical, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      for (const choice of alts) {
        const now = new Set(bandViolations({}, { focus: "Forged", mainLifts: {} }));
        const adds = bandViolations({}, { focus: "Forged", mainLifts: { [canonical]: choice } }).some((m) => !now.has(m));
        const r = check({ kind: "mainLift", canonical, choice });
        expect(r.warnings).toEqual(adds ? ["band"] : []);
        if (adds) warned++;
      }
    }
    expect(warned).toBe(0); // the default plan has room for every listed choice
    // Single-Leg RDL rotated in: a Romanian deadlift main pushes hamstrings over.
    const meta = { programmeBlock: { config: { "ass2-A": pool("ass2-A", "Single-Leg RDL") } } };
    expect(check({ kind: "mainLift", canonical: "Hex Bar Deadlift", choice: "Romanian Deadlift" }, meta).warnings).toEqual(["band"]);
    expect(check({ kind: "mainLift", canonical: "Hex Bar Deadlift", choice: "Sumo Deadlift" }, meta).warnings).toEqual([]);
  });
  it("M4: stale when the choice moved", () => {
    const c = ctx({ mainLifts: { [SQUAT]: "Hack Squat" } });
    expect(validateOp({ kind: "mainLift", canonical: SQUAT, choice: "Front Squat" }, { ...c, basis: { mains: { [SQUAT]: SQUAT } } })).toMatchObject({ stale: true });
    expect(validateOp({ kind: "mainLift", canonical: SQUAT, choice: "Front Squat" }, { ...c, basis: { mains: { [SQUAT]: "Hack Squat" } } })).toMatchObject({ stale: false, ok: true });
  });
  it("an invalid stored choice reads as the programme's own", () => {
    expect(currentMainLift({ mainLifts: { [SQUAT]: "Bicep Curl" } }, SQUAT)).toBe(SQUAT);
  });
});

// ── Week: K1-K3, K5 (S2; validateOp refuses until then) ─────────────────────

describe("week rules", () => {
  const week = WEEK.map((d) => ({ type: d.type }));
  const c = (meta = {}) => ({ ...ctx(meta), basis: { week: { [TODAY]: weekBasis(meta, TODAY), [addDaysIso(TODAY, 7)]: weekBasis(meta, addDaysIso(TODAY, 7)) } } });
  it("K1: seven days of known types", () => {
    expect(checkWeek({ kind: "week", week, from: TODAY }, c()).ok).toBe(true);
    expect(checkWeek({ kind: "week", week: week.slice(0, 6), from: TODAY }, c()).code).toBe("week_shape");
    expect(checkWeek({ kind: "week", week: [...week.slice(0, 6), { type: "yoga" }], from: TODAY }, c()).code).toBe("week_shape");
  });
  it("K2: a label is the type's own or from the fixed list; strength takes none", () => {
    const withLabel = (i, d) => week.map((x, j) => (j === i ? d : x));
    expect(checkWeek({ kind: "week", week: withLabel(3, { type: "cardio", label: "Pilates" }), from: TODAY }, c()).change.after[3]).toEqual({ type: "cardio", label: "Pilates" });
    expect(checkWeek({ kind: "week", week: withLabel(3, { type: "cardio", label: "Cardio" }), from: TODAY }, c()).change.after[3]).toEqual({ type: "cardio" });
    expect(checkWeek({ kind: "week", week: withLabel(3, { type: "zone2", label: "Pilates" }), from: TODAY }, c()).code).toBe("label");
    expect(checkWeek({ kind: "week", week: withLabel(0, { type: "strength", label: "Legs" }), from: TODAY }, c()).code).toBe("label");
    expect(checkWeek({ kind: "week", week: withLabel(3, { type: "cardio", label: "<b>hi</b>" }), from: TODAY }, c()).code).toBe("label");
    expect(DAY_LABELS.strength).toEqual([]);
    for (const [type, labels] of Object.entries(DAY_LABELS)) for (const l of labels) expect(l).not.toBe(TYPE_LABEL[type]);
  });
  it("K3: a Monday from this week up to today + 28", () => {
    expect(checkWeek({ kind: "week", week, from: addDaysIso(TODAY, 1) }, c()).code).toBe("from_range");
    expect(checkWeek({ kind: "week", week, from: addDaysIso(TODAY, -7) }, c()).code).toBe("from_range");
    expect(checkWeek({ kind: "week", week, from: addDaysIso(TODAY, 28) }, { ...c(), basis: { week: { [addDaysIso(TODAY, 28)]: weekBasis({}, TODAY) } } }).ok).toBe(true);
    expect(checkWeek({ kind: "week", week, from: addDaysIso(TODAY, 35) }, c()).code).toBe("from_range");
  });
  it("K5: stale when the governing week's types moved", () => {
    const meta = { userWeek: [{ editedAt: "2026-09-01T00:00:00.000Z", effectiveFrom: "2026-09-01", week: WEEK.map((d) => ({ type: "rest" })) }] };
    const r = checkWeek({ kind: "week", week, from: TODAY }, { ...ctx(meta), basis: { week: { [TODAY]: WEEK.map((d) => d.type) } } });
    expect(r.stale).toBe(true);
    const ok = checkWeek({ kind: "week", week, from: TODAY }, { ...ctx(meta), basis: { week: { [TODAY]: weekBasis(meta, TODAY) } } });
    expect(ok).toMatchObject({ ok: true, change: { basis: { weekEditedAt: "2026-09-01T00:00:00.000Z" } } });
  });
});

// ── Bounds ≡ validator ──────────────────────────────────────────────────────

describe("boundsFor: the pane's range is the validator's", () => {
  // Seeded, so a failure reproduces.
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
  it("max is accepted and max + one rung refused; min accepted and min − one rung refused", () => {
    const rand = rng(7);
    const lifts = resolvedProgramme({});
    let checked = 0;
    for (let n = 0; n < 300; n++) {
      const lift = lifts[Math.floor(rand() * lifts.length)];
      const step = weightStepForLoadType(lift.loadType);
      const performed = rand() < 0.8;
      const history = [];
      if (performed) {
        const kg = Math.max(step, Math.round((5 + rand() * 150) / step) * step);
        if (rand() < 0.5) history.push(rec(ago(9), { [lift.name]: { kg: Math.max(step, kg - step * 2), loadType: lift.loadType } }));
        history.push(rec(ago(2), { [lift.name]: { kg, loadType: lift.loadType } }));
      }
      const meta = rand() < 0.5 ? { bodyweight: { kg: 50 + Math.round(rand() * 60) } } : {};
      const c = ctx(meta, history);
      const b = boundsFor(lift.name, c);
      const v = (kg) => validateOp({ kind: "weight", lift: lift.name, kg }, { ...c, basis: basisFor(c, { lifts: [lift.name] }) });
      if (b === null) { expect(v(10).code).toMatch(/^(bodyweight|timed|not_by_load)$/); continue; }
      expect(b.max, `${lift.name} ${history.at(-1)?.blocks[0].exercises[0].sets[0].weight}`).toBeGreaterThanOrEqual(b.min);
      // A floor over the ceiling: blocked, and nothing at either end is taken.
      if (b.blocked?.code === "ceiling") { expect(v(b.max).ok).toBe(false); expect(v(b.max + b.step).ok).toBe(false); continue; }
      expect(v(b.max)).toMatchObject({ ok: true });
      expect(v(Math.round((b.max + b.step) * 100) / 100).ok).toBe(false);
      expect(v(b.min)).toMatchObject({ ok: true });
      if (b.min - b.step > 0) expect(v(Math.round((b.min - b.step) * 100) / 100).ok).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });
});

// ── Status ──────────────────────────────────────────────────────────────────

const APPLIED_AT = `${ago(3)}T12:00:00.000Z`;
const row = (over = {}) => ({
  id: `${SET_ID}.0`, set: SET_ID, kind: "weight", target: SQUAT, before: 100, after: 105, from: null,
  basis: { anchorId: null, w: 100, r: null }, at: 1, appliedAt: null, outcome: null,
  undoneAt: null, undoneBy: null, revertedAt: null, ...over,
});
const state = (meta = {}, history = [], extra = {}) => ({ meta, history, todayIso: TODAY, editsLive: true, ...extra });

describe("changeStatus", () => {
  it("waiting, with its start date", () => {
    expect(changeStatus(row(), state())).toEqual({ status: "waiting", reason: null, date: null });
    expect(changeStatus(row({ from: "2026-10-13" }), state())).toEqual({ status: "waiting", reason: null, date: "2026-10-13" });
  });
  it("not_applied: sharing or changes ended before it landed", () => {
    expect(changeStatus(row(), state({}, [], { editsLive: false }))).toEqual({ status: "not_applied", reason: "stopped", date: null });
  });
  it("not_applied: each device outcome", () => {
    for (const outcome of OUTCOMES.filter((o) => o !== "applied")) {
      expect(changeStatus(row({ outcome }), state())).toEqual({ status: "not_applied", reason: outcome, date: null });
    }
  });
  it("undone by the client, withdrawn by the trainer, whatever came before", () => {
    expect(changeStatus(row({ undoneAt: 5, undoneBy: "client", outcome: "applied", appliedAt: APPLIED_AT }), state()).status).toBe("undone");
    expect(changeStatus(row({ undoneAt: 5, undoneBy: "trainer" }), state()).status).toBe("withdrawn");
  });
  const landed = row({ outcome: "applied", appliedAt: APPLIED_AT });
  it("in_force: the value holds and nothing trained since", () => {
    expect(changeStatus(landed, state({ weights: { [SQUAT]: 105 } }, [squatAt(100, ago(4))]))).toEqual({ status: "in_force", reason: null, date: null });
  });
  it("trained_yours: the first session after it ran the trainer's number", () => {
    const after = squatAt(107.5, ago(1), { time: "09:00:00" });
    after.blocks[0].exercises[0].prescribed = { weight: 105, reps: 5 };
    const later = squatAt(110, TODAY);
    expect(changeStatus(landed, state({ weights: { [SQUAT]: 110 } }, [later, after]))).toEqual({ status: "trained_yours", reason: null, date: ago(1) });
  });
  it("trained_yours on a cooked day, named", () => {
    const cooked = squatAt(105, ago(1), { readiness: "cooked" });
    expect(changeStatus(landed, state({ weights: { [SQUAT]: 105 } }, [cooked]))).toEqual({ status: "trained_yours", reason: null, date: ago(1), cooked: true });
  });
  it("a travel session is not training at it", () => {
    const trip = squatAt(0, ago(1), { travel: true });
    expect(changeStatus(landed, state({ weights: { [SQUAT]: 105 } }, [trip])).status).toBe("in_force");
  });
  it("changed_since: moved without training, or trained at another number", () => {
    expect(changeStatus(landed, state({ weights: { [SQUAT]: 102.5 } })).status).toBe("changed_since");
    const other = squatAt(100, ago(1));
    expect(changeStatus(landed, state({ weights: { [SQUAT]: 105 } }, [other])).status).toBe("changed_since");
  });
  it("a resumed draft (started before the apply) reads changed_since, not trained_yours", () => {
    const draft = squatAt(105, ago(3), { time: "11:00:00" }); // id before APPLIED_AT
    expect(draft.id < APPLIED_AT).toBe(true);
    expect(changeStatus(landed, state({ weights: { [SQUAT]: 107.5 } }, [draft])).status).toBe("changed_since");
  });
  it("reps: trained_yours on the template-shaped value", () => {
    const r = row({ kind: "reps", target: "DB Reverse Lunge", before: "8/leg", after: "10/leg", outcome: "applied", appliedAt: APPLIED_AT });
    const s = rec(ago(1), { "DB Reverse Lunge": { kg: 18, reps: 10, loadType: "per_db", prescribed: { weight: 18, reps: "10/leg" } } });
    expect(changeStatus(r, state({ reps: { "DB Reverse Lunge": "10/leg" } }, [s])).status).toBe("trained_yours");
    expect(changeStatus(r, state({ reps: { "DB Reverse Lunge": "10/leg" } })).status).toBe("in_force");
  });
  it("main lift: in force, then trained at the chosen lift, or changed", () => {
    const r = row({ kind: "mainLift", target: SQUAT, before: SQUAT, after: "Front Squat", outcome: "applied", appliedAt: APPLIED_AT });
    expect(changeStatus(r, state({ mainLifts: { [SQUAT]: "Front Squat" } })).status).toBe("in_force");
    const s = rec(ago(1), { "Front Squat": { kg: 60 } });
    expect(changeStatus(r, state({ mainLifts: { [SQUAT]: "Front Squat" } }, [s])).status).toBe("trained_yours");
    expect(changeStatus(r, state({ mainLifts: { [SQUAT]: "Hack Squat" } })).status).toBe("changed_since");
  });
  it("week: in force while its entry governs today", () => {
    const id = `${SET_ID}.3`;
    const entry = { editedAt: `${TODAY}T08:00:00.000Z`, effectiveFrom: TODAY, week: WEEK, changeId: id };
    const r = row({ id, kind: "week", target: "week", from: TODAY, outcome: "applied", appliedAt: entry.editedAt });
    expect(changeStatus(r, state({ userWeek: [entry] })).status).toBe("in_force");
    const later = { editedAt: `${TODAY}T09:00:00.000Z`, effectiveFrom: TODAY, week: WEEK };
    expect(changeStatus(r, state({ userWeek: [entry, later] })).status).toBe("changed_since");
  });
  it("isUndoable: waiting, in force; a week only while its entry is the latest edit", () => {
    const s = (r, st) => isUndoable(r, changeStatus(r, st), st);
    expect(s(row(), state())).toBe(true);
    expect(s(landed, state({ weights: { [SQUAT]: 105 } }))).toBe(true);
    expect(s(landed, state({ weights: { [SQUAT]: 102.5 } }))).toBe(false);
    expect(s(row({ outcome: "superseded" }), state())).toBe(false);
    const id = `${SET_ID}.3`;
    const entry = { editedAt: `${TODAY}T08:00:00.000Z`, effectiveFrom: TODAY, week: WEEK, changeId: id };
    const r = row({ id, kind: "week", target: "week", from: TODAY, outcome: "applied", appliedAt: entry.editedAt });
    expect(s(r, state({ userWeek: [entry] }))).toBe(true);
  });
  it("Put back not offered after a later client edit", () => {
    const id = `${SET_ID}.3`;
    const entry = { editedAt: `${TODAY}T08:00:00.000Z`, effectiveFrom: TODAY, week: WEEK, changeId: id };
    // A later client edit dated next week: the trainer's entry still governs today.
    const later = { editedAt: `${TODAY}T09:00:00.000Z`, effectiveFrom: addDaysIso(TODAY, 7), week: WEEK };
    const r = row({ id, kind: "week", target: "week", from: TODAY, outcome: "applied", appliedAt: entry.editedAt });
    const st = state({ userWeek: [entry, later] });
    expect(changeStatus(r, st).status).toBe("in_force");
    expect(isUndoable(r, changeStatus(r, st), st)).toBe(false);
  });
  it("reads a DB row (snake_case, BIGINT as text)", () => {
    const db = {
      id: `${SET_ID}.0`, set_id: SET_ID, kind: "weight", target: SQUAT, old_value: 100, new_value: 105, effective_from: null,
      basis: { anchorId: null, w: 100, r: null }, created_at: "1759650000000", applied_at: APPLIED_AT, outcome: "applied",
      undone_at: null, undone_by: null, reverted_at: null, warnings: [],
    };
    const r = rowFromDb(db);
    expect(r).toMatchObject({ set: SET_ID, before: 100, after: 105, at: 1759650000000, appliedAt: APPLIED_AT });
    expect(changeStatus(r, state({ weights: { [SQUAT]: 105 } })).status).toBe("in_force");
  });
});

// ── E2: device ≡ server ─────────────────────────────────────────────────────

describe("E2: changeStatus is the same on device-shaped and server-shaped input", () => {
  const PROFILE = "e2-client";
  beforeEach(() => { localStorage.clear(); });

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
  const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];

  it("across generated fixtures", () => {
    const rand = rng(42);
    const lifts = [SQUAT, BENCH, "DB Reverse Lunge"];
    let compared = 0;
    for (let f = 0; f < 25; f++) {
      localStorage.clear();
      const weights = {}, reps = {}, mainLifts = {};
      for (const l of lifts) {
        if (rand() < 0.8) weights[l] = pick(rand, [100, 102.5, 105, 18]);
        if (rand() < 0.5) reps[l] = pick(rand, [5, 6, "10/leg", 10]);
      }
      if (rand() < 0.6) mainLifts[SQUAT] = pick(rand, [SQUAT, "Front Squat", "Hack Squat"]);
      const userWeek = rand() < 0.5 ? [{ editedAt: `${ago(2)}T08:00:00.000Z`, effectiveFrom: ago(2), week: WEEK, changeId: `${SET_ID}.9` }] : null;
      const history = [];
      for (let i = 0; i < 6; i++) {
        const l = pick(rand, lifts);
        history.push(rec(ago(Math.floor(rand() * 8)), { [l]: { kg: pick(rand, [100, 105, 18]), prescribed: { weight: pick(rand, [100, 105, 18]), reps: pick(rand, [5, "10/leg"]) } } },
          { time: `${String(8 + i).padStart(2, "0")}:00:00`, ...(rand() < 0.2 ? { readiness: "cooked" } : {}), ...(rand() < 0.15 ? { travel: true } : {}) }));
      }
      // Device: written through the client's own stores, read back as the app reads it.
      P.saveWeightsRaw(PROFILE, weights, {});
      P.saveRepsRaw(PROFILE, reps, {});
      P.saveMainLiftsRaw(PROFILE, mainLifts, {});
      if (userWeek) W.replaceHistory(userWeek, PROFILE);
      H.save(PROFILE, [...history].sort((a, b) => a.id.localeCompare(b.id)));
      const local = getLocalProfile(PROFILE);
      const device = { meta: local.meta, history: H.get(PROFILE) };
      // Server: meta rows as stored (absent fields absent), sessions ORDER BY id.
      const metaRows = [["weights", weights], ["reps", reps], ["mainLifts", mainLifts], ["userWeek", userWeek]]
        .filter(([, v]) => v !== null && Object.keys(v).length > 0).map(([field, value]) => ({ field, value }));
      const server = { meta: assembleMeta(metaRows), history: [...history].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };

      for (let k = 0; k < 8; k++) {
        const kind = pick(rand, ["weight", "reps", "mainLift", "week"]);
        const target = kind === "mainLift" ? SQUAT : kind === "week" ? "week" : pick(rand, lifts);
        const after = kind === "weight" ? pick(rand, [100, 105, 18]) : kind === "reps" ? pick(rand, [5, 6, "10/leg"]) : kind === "mainLift" ? pick(rand, ["Front Squat", "Hack Squat"]) : WEEK;
        const r = row({
          id: kind === "week" && rand() < 0.5 ? `${SET_ID}.9` : `${SET_ID}.${k}`, kind, target, after,
          outcome: pick(rand, [null, "applied", "applied", "applied", "superseded"]),
          appliedAt: `${ago(Math.floor(rand() * 8))}T09:30:00.000Z`,
          undoneAt: rand() < 0.15 ? 9 : null, undoneBy: pick(rand, ["client", "trainer"]),
        });
        for (const editsLive of [true, false]) {
          const a = changeStatus(r, { ...device, todayIso: TODAY, editsLive });
          const b = changeStatus(r, { ...server, todayIso: TODAY, editsLive });
          expect(a).toEqual(b);
          expect(isUndoable(r, a, device)).toBe(isUndoable(r, b, server));
          compared++;
        }
      }
      expect(planDeviceSteps([row({ after: 105, basis: { anchorId: anchorIdOf(device.history, SQUAT), w: weights[SQUAT] ?? null, r: null } })], { ...device, todayIso: TODAY }))
        .toEqual(planDeviceSteps([row({ after: 105, basis: { anchorId: anchorIdOf(server.history, SQUAT), w: weights[SQUAT] ?? null, r: null } })], { ...server, todayIso: TODAY }));
    }
    expect(compared).toBe(400);
  });
});

// ── The device plan ─────────────────────────────────────────────────────────

describe("planDeviceSteps", () => {
  const hist = [squatAt(100, ago(4))];
  const anchorId = hist[0].id;
  const meta = { weights: { [SQUAT]: 100 }, reps: { [SQUAT]: 5 } };
  const due = (over = {}) => row({ basis: { anchorId, w: 100, r: 5 }, ...over });
  const plan = (rows, m = meta, h = hist) => planDeviceSteps(rows, { meta: m, history: h, todayIso: TODAY });

  it("applies a next-session change onto exactly what the trainer saw", () => {
    const p = plan([due({ by: "Sam" })]);
    expect(p.weights).toEqual({ [SQUAT]: 105 });
    expect(p.acks).toEqual([{ id: `${SET_ID}.0`, outcome: "applied" }]);
    expect(p.applied).toEqual([{ id: `${SET_ID}.0`, kind: "weight", target: SQUAT, after: 105, by: "Sam" }]);
  });
  it("cur === after is an idempotent applied, with no write", () => {
    const p = plan([due()], { weights: { [SQUAT]: 105 } });
    expect(p.weights).toEqual({});
    expect(p).toMatchObject({ acks: [{ id: `${SET_ID}.0`, outcome: "applied" }], applied: [] });
  });
  it("trained since: superseded, not applied", () => {
    const trained = [...hist, squatAt(100, ago(1))];
    const p = plan([due()], meta, trained);
    expect(p.weights).toEqual({});
    expect(p.acks).toEqual([{ id: `${SET_ID}.0`, outcome: "superseded" }]);
  });
  it("a cooked session in between supersedes; a travel one does not", () => {
    const sent = validateOp({ kind: "weight", lift: SQUAT, kg: 105 }, { ...ctx(meta, hist), phase: "apply" }).change;
    const r = due({ basis: sent.basis });
    expect(plan([r]).acks).toEqual([{ id: r.id, outcome: "applied" }]);
    expect(plan([r], meta, [...hist, squatAt(100, ago(1), { readiness: "cooked" })]).acks).toEqual([{ id: r.id, outcome: "superseded" }]);
    expect(plan([r], meta, [...hist, squatAt(100, ago(1), { travel: true })]).acks).toEqual([{ id: r.id, outcome: "applied" }]);
  });
  it("W moved since: superseded", () => {
    expect(plan([due()], { weights: { [SQUAT]: 102.5 } }).acks[0].outcome).toBe("superseded");
  });
  it("a main lift chosen otherwise since: superseded, nothing written", () => {
    const r = due({ id: `${SET_ID}.0`, kind: "mainLift", target: SQUAT, before: SQUAT, after: "Front Squat", basis: { choice: SQUAT } });
    const p = plan([r], { mainLifts: { [SQUAT]: "Hack Squat" } });
    expect(p).toMatchObject({ mainLifts: {}, acks: [{ id: r.id, outcome: "superseded" }], applied: [] });
    // Onto what the trainer saw, it lands.
    expect(plan([r], { mainLifts: {} })).toMatchObject({ mainLifts: { [SQUAT]: "Front Squat" }, acks: [{ id: r.id, outcome: "applied" }] });
  });
  it("dated (S3): re-validated on its day; out of limits or in a deload, nothing is written", () => {
    const big = due({ from: ago(1), before: 100, after: 130 });
    expect(plan([big])).toMatchObject({ weights: {}, acks: [{ id: big.id, outcome: "limits" }], applied: [] });
    const deload = { ...meta, trainingState: { mesocycle: { activeDeload: { startedAt: `${ago(1)}T08:00:00.000Z`, plannedDays: 5 } } } };
    const ok = due({ from: ago(1), before: 100, after: 105 });
    expect(plan([ok], deload)).toMatchObject({ weights: {}, acks: [{ id: ok.id, outcome: "deload" }] });
    const reps = due({ id: `${SET_ID}.1`, kind: "reps", from: ago(1), before: 5, after: 40 });
    expect(plan([reps])).toMatchObject({ reps: {}, acks: [{ id: reps.id, outcome: "limits" }] });
  });
  it("deload at apply: deload; out of limits at apply: limits", () => {
    const deload = { ...meta, trainingState: { mesocycle: { activeDeload: { startedAt: `${ago(1)}T08:00:00.000Z`, plannedDays: 5 } } } };
    expect(plan([due()], deload).acks).toEqual([{ id: `${SET_ID}.0`, outcome: "deload" }]);
    expect(plan([due({ after: 130 })], deload).acks).toEqual([{ id: `${SET_ID}.0`, outcome: "deload" }]);
    expect(plan([due({ after: 130 })]).acks).toEqual([{ id: `${SET_ID}.0`, outcome: "limits" }]);
  });
  it("newest due row per target wins; the rest are replaced", () => {
    const a = due({ id: `${SET_ID}.0`, after: 102.5, at: 1 });
    const b = due({ id: "hws_" + "b".repeat(26) + ".0", set: "hws_" + "b".repeat(26), after: 105, at: 2 });
    const p = plan([b, a]);
    expect(p.weights).toEqual({ [SQUAT]: 105 });
    expect(p.acks).toEqual(expect.arrayContaining([{ id: a.id, outcome: "replaced" }, { id: b.id, outcome: "applied" }]));
    expect(p.acks).toHaveLength(2);
  });
  it("rows not yet due are left alone", () => {
    const p = plan([due({ from: addDaysIso(TODAY, 3) })]);
    expect(p).toEqual({ weights: {}, reps: {}, mainLifts: {}, weeks: [], acks: [], reverts: [], applied: [] });
  });
  it("reps land in the template's shape", () => {
    const p = plan([due({ id: `${SET_ID}.1`, kind: "reps", before: 5, after: 8 })]);
    expect(p.reps).toEqual({ [SQUAT]: 8 });
  });
  it("a main lift and its first weight land in one pull", () => {
    const rows = [
      due({ id: `${SET_ID}.1`, kind: "weight", target: "Front Squat", before: null, after: 60, basis: { anchorId: null, w: null, r: null } }),
      due({ id: `${SET_ID}.0`, kind: "mainLift", target: SQUAT, before: SQUAT, after: "Front Squat", basis: { choice: SQUAT } }),
    ];
    const p = plan(rows, { ...meta, bodyweight: { kg: 80 } });
    expect(p.mainLifts).toEqual({ [SQUAT]: "Front Squat" });
    expect(p.weights).toEqual({ "Front Squat": 60 });
  });
  it("dated (S3): a stale up never pulls anyone down", () => {
    const up = due({ from: ago(1), before: 100, after: 105 });
    expect(plan([up], { weights: { [SQUAT]: 107.5 } }).acks[0].outcome).toBe("already_there");
    expect(plan([up], meta, [squatAt(105, ago(2))]).acks[0].outcome).toBe("already_there");
    expect(plan([up]).acks[0].outcome).toBe("applied");
    expect(plan([up]).weights).toEqual({ [SQUAT]: 105 });
  });
  it("week: lands onto the entry the trainer saw, once", () => {
    const id = `${SET_ID}.2`;
    const base = { editedAt: `${ago(10)}T08:00:00.000Z`, effectiveFrom: ago(10), week: WEEK };
    const r = due({ id, kind: "week", target: "week", from: TODAY, before: WEEK, after: WEEK.map((d) => ({ type: d.type })), basis: { weekEditedAt: base.editedAt } });
    const p = plan([r], { userWeek: [base] });
    expect(p.weeks).toEqual([{ week: r.after, from: TODAY, changeId: id }]);
    expect(p.acks).toEqual([{ id, outcome: "applied" }]);
    const landed = { editedAt: `${TODAY}T07:00:00.000Z`, effectiveFrom: TODAY, week: WEEK, changeId: id };
    expect(plan([r], { userWeek: [base, landed] })).toMatchObject({ weeks: [], acks: [{ id, outcome: "applied" }] });
    const clientEdit = { editedAt: `${ago(1)}T08:00:00.000Z`, effectiveFrom: ago(7), week: WEEK };
    expect(plan([r], { userWeek: [base, clientEdit] })).toMatchObject({ weeks: [], acks: [{ id, outcome: "superseded" }] });
    expect(ensureScheduleHistory([base, landed])[1].changeId).toBe(id); // the merge keeps the provenance
  });
  it("revert: writes the old value back while in force, acks either way", () => {
    const undone = row({ outcome: "applied", appliedAt: APPLIED_AT, undoneAt: 7, undoneBy: "client" });
    const inForce = plan([undone], { weights: { [SQUAT]: 105 } });
    expect(inForce).toMatchObject({ weights: { [SQUAT]: 100 }, reverts: [undone.id] });
    // Moved or trained since: the client's own value stands; nothing is written.
    const moved = plan([undone], { weights: { [SQUAT]: 107.5 } });
    expect(moved).toEqual({ weights: {}, reps: {}, mainLifts: {}, weeks: [], acks: [], reverts: [undone.id], applied: [] });
    const trained = plan([undone], { weights: { [SQUAT]: 105 } }, [squatAt(105, ago(1))]);
    expect(trained).toEqual({ weights: {}, reps: {}, mainLifts: {}, weeks: [], acks: [], reverts: [undone.id], applied: [] });
  });
  it("revert to a value never set: an explicit reset, never a null", () => {
    const w = row({ before: null, outcome: "applied", appliedAt: APPLIED_AT, undoneAt: 7, undoneBy: "client" });
    const r = row({ id: `${SET_ID}.1`, kind: "reps", before: null, after: 8, outcome: "applied", appliedAt: APPLIED_AT, undoneAt: 7, undoneBy: "client" });
    const p = plan([w, r], { weights: { [SQUAT]: 105 }, reps: { [SQUAT]: 8 } });
    expect(p.weights).toEqual({ [SQUAT]: { reset: true } });
    expect(p.reps).toEqual({ [SQUAT]: { reset: true } });
    expect(p.weights[SQUAT]).toBe(RESET);
    expect(Object.isFrozen(RESET)).toBe(true);
    expect(p.reverts).toEqual([w.id, r.id]);
  });
  it("revert reads the sync payload shape (undone: true, no outcome)", () => {
    const payload = { id: `${SET_ID}.0`, set: SET_ID, kind: "mainLift", target: SQUAT, before: SQUAT, after: "Front Squat", from: null, basis: { choice: SQUAT }, at: 1, appliedAt: APPLIED_AT, undone: true, by: "Sam" };
    expect(plan([payload], { mainLifts: { [SQUAT]: "Front Squat" } })).toMatchObject({ mainLifts: { [SQUAT]: SQUAT }, reverts: [payload.id] });
  });
  it("a revert gives way to a newer change landing on the same target", () => {
    const undone = row({ outcome: "applied", appliedAt: APPLIED_AT, undoneAt: 7, undoneBy: "client" });
    const newer = due({ id: "hws_" + "c".repeat(26) + ".0", after: 107.5, basis: { anchorId, w: 105, r: 5 } });
    const p = plan([undone, newer], { weights: { [SQUAT]: 105 }, reps: { [SQUAT]: 5 } });
    expect(p.weights).toEqual({ [SQUAT]: 107.5 });
    expect(p.reverts).toEqual([undone.id]);
  });
  it("ignores rows it cannot read", () => {
    expect(plan([null, { id: 3 }, { id: "x", kind: "note" }])).toEqual({ weights: {}, reps: {}, mainLifts: {}, weeks: [], acks: [], reverts: [], applied: [] });
  });
});

// ── E1: one validator ───────────────────────────────────────────────────────

describe("E1: one validator, built from the engine's modules", () => {
  const files = (dir) => readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(ROOT, dir, f);
    return statSync(p).isDirectory() ? files(relative(ROOT, p)) : /\.(jsx?|mjs)$/.test(f) ? [relative(ROOT, p)] : [];
  });
  const source = [...files("components"), ...files("app"), ...files("lib")];
  const SRC = readFileSync(join(ROOT, "lib/trainer-change.js"), "utf8");

  it("no second definition of the validator, bounds, status or apply plan", () => {
    const DEF = /\b(?:function\s+|const\s+|let\s+)(validateOp|validateChangeSet|boundsFor|changeStatus|planDeviceSteps|DAY_LABELS)\b/;
    expect(source.filter((f) => f !== "lib/trainer-change.js" && DEF.test(readFileSync(join(ROOT, f), "utf8")))).toEqual([]);
  });
  it("the engine's limits are used only by the engine and the validator", () => {
    const USE = /\b(MAX_JUMP_FRACTION|deloadIntensityFor|categoryCeilingKg)\b/;
    const allowed = new Set(["lib/progression.js", "lib/lift-translations.js", "lib/trainer-change.js"]);
    expect(source.filter((f) => !allowed.has(f) && USE.test(readFileSync(join(ROOT, f), "utf8")))).toEqual([]);
  });
  it("copies no engine number", () => {
    const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    for (const lit of [/\b0\.65\b/, /\b0\.70?\b/, /\b0\.60?\b/, /\b0\.10?\b/, /\b1\.5\b/, /\b2\.5\b/, /\b1\.25\b/, /\b250\b/, /\b375\b/]) {
      expect(code).not.toMatch(lit);
    }
  });
  it("is pure: no storage, fetch, window or database", () => {
    const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/\blocalStorage\b|\bfetch\s*\(|\bwindow\b|\bsql\b|from "\.\/db\.js"|from "\.\/net\.js"/);
  });
});
