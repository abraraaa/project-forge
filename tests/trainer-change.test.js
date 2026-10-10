// @vitest-environment jsdom
// The trainer-change validator, statuses and device plan (lib/trainer-change.js).
// Pure. Every rule is pinned at its boundary and one rung past it; the
// mutation witnesses are named after the guard they hold (spec §11).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  validateOp, validateChangeSet, boundsFor, checkWeek, liftBasis, weekBasis, anchorIdOf, currentMainLift,
  changeStatus, isUndoable, planDeviceSteps, rowFromDb, anchorLogged,
  DAY_LABELS, LIVE_SLICES, OUTCOMES, KINDS, MAX_OPS, HORIZON_DAYS, SET_ID_RE, REP_LIMITS, TIMED_SECONDS, MAX_KG, RESET,
  validateSessionSet, sessionStatus, planSessionSteps, isSwapFor, sessionTarget, sessionDayWords, sessionPreview,
  SESSION_KIND, MAX_SETS_PER_LIFT, SESSION_CAP, SESSIONS_PER_WEEK, AUTO_KEEP_MS, RECORD_MAX_BYTES, DRUM_MAX, MAX_DURATION_S,
  SESSION_LETTERS, READINESS, READINESS_REASONS, RECORD_KEYS, RPE_TRACK,
} from "@/lib/trainer-change";
import { climbRungs, MAX_JUMP_FRACTION } from "@/lib/progression";
import { STEP_SIZES, nextRung, weightStepForLoadType, CATEGORY_COLD_START_MAX_KG, WORKING_WEIGHT_MAX_KG, getLiftProfile, isBodyweightMovement, sanitiseWorkingWeights, getLoadType, swapLoadType, ADDED_LOAD_MAX_KG } from "@/lib/lift-translations";
import {
  MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, EXERCISE_POOLS, WEEK, SESSIONS, SWAP_DB,
  applyRotationToSession, applyMainLiftsToSession, applySwapsToSession, applyFocusToSession,
} from "@/lib/programme";
import { repTargets, planStartWeight, validMainLifts } from "@/lib/programme-resolve";
import { bandViolations } from "@/lib/rotation-solver";
import { resolvedProgramme } from "@/lib/mcp-server";
import { TYPE_LABEL, ensureScheduleHistory } from "@/lib/sync-merge";
import { addDaysIso, jsDow, mondayOfWeekIso } from "@/lib/dates";
import {
  P, W, H, getLocalProfile, startingWeightForLift,
  newDraftLog, logSet, finaliseDraft, scaleForReadiness, rpeToRir, SCHEMA_VERSION,
} from "@/lib/storage";
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
    expect(KINDS).toEqual(["weight", "reps", "mainLift", "week", "session"]);
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

describe("W3: no ceiling past the cold-start cap; MAX_KG is the app's sanity bound", () => {
  const CALF = "Standing Calf Raise";
  const calfLt = () => resolvedProgramme({}).find((l) => l.name === CALF).loadType;
  const calfAt = (kg) => ctx({}, [rec(ago(2), { [CALF]: { kg, reps: 12, loadType: calfLt() } })]);
  const v = (c, lift, x) => validateOp({ kind: "weight", lift, kg: x }, { ...c, basis: basisFor(c, { lifts: [lift] }) });

  it("MAX_KG is the sanitiser's bound, and the device keeps every weight up to it", () => {
    expect(MAX_KG).toBe(WORKING_WEIGHT_MAX_KG);
    expect(sanitiseWorkingWeights({ [CALF]: 110 })).toEqual({ [CALF]: 110 });
    expect(sanitiseWorkingWeights({ [CALF]: MAX_KG })).toEqual({ [CALF]: MAX_KG });
  });

  it("a Standing Calf Raise anchored at 100 kg gives 70 to 110, and both ends are accepted", () => {
    const c = calfAt(100);
    const b = boundsFor(CALF, c);
    expect(b).toMatchObject({ min: 70, max: 110, blocked: null });
    expect(v(c, CALF, 110)).toMatchObject({ ok: true });
    expect(v(c, CALF, 70)).toMatchObject({ ok: true });
    expect(code(v(c, CALF, 110 + b.step))).toBe("per_change");
    expect(code(v(c, CALF, 70 - b.step))).toBe("floor");
  });

  it("a Lateral Raise past the old 37.5 kg clamp moves by the per-change rule", () => {
    const hist = [rec(ago(2), { "Lateral Raise": { kg: 36, reps: 15, loadType: "per_db" } })];
    expect(code(check({ kind: "weight", lift: "Lateral Raise", kg: 38 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Lateral Raise", kg: 39 }, {}, hist))).toBe(null);
    expect(code(check({ kind: "weight", lift: "Lateral Raise", kg: 40 }, {}, hist))).toBe("per_change");
    expect(boundsFor("Lateral Raise", ctx({}, hist)).max).toBe(39);
  });

  it("400 is accepted at the right anchor; 402.5 is refused 'range'", () => {
    const c = ctx({}, [squatAt(380)]);
    expect(boundsFor(SQUAT, c)).toMatchObject({ max: 400, blocked: null });
    expect(v(c, SQUAT, 400)).toMatchObject({ ok: true });
    expect(code(v(c, SQUAT, 402.5))).toBe("range");
  });

  it("a top set whose deload floor sits over MAX_KG is blocked 'range'; max is never under min and nothing is accepted", () => {
    for (const kg of [600, 1000]) {
      const c = calfAt(kg);
      const b = boundsFor(CALF, c);
      expect(b, `${kg}`).toMatchObject({ max: MAX_KG, blocked: { code: "range", until: null } });
      expect(b.max, `${kg}`).toBeGreaterThanOrEqual(b.min);
      expect(code(v(c, CALF, b.max)), `${kg}`).toBe("floor");
      expect(code(v(c, CALF, b.max + b.step)), `${kg}`).toBe("range");
    }
  });

  it("never lifted, the cap or the template still bounds it", () => {
    expect(boundsFor(CALF, ctx({}))).toMatchObject({ max: 35, blocked: null });
    expect(code(check({ kind: "weight", lift: CALF, kg: 37.5 }))).toBe("no_history");
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
            .toBe("no_history");
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
        expect(code(inPhase({ kind: "weight", lift: name, kg: 40 }, {}, phase)), `${name} ${phase}`).toBe("no_history");
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
      // A deload floor over MAX_KG: blocked, and nothing at either end is taken.
      if (b.blocked?.code === "range") { expect(v(b.max).ok).toBe(false); expect(v(b.max + b.step).ok).toBe(false); continue; }
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
  }, 20_000); // reads every source file: a longer budget under full-suite load
  it("the engine's limits are used only by the engine and the validator", () => {
    const USE = /\b(MAX_JUMP_FRACTION|deloadIntensityFor)\b/;
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

// ── Coached sessions (kind "session") ───────────────────────────────────────

const NOW = Date.parse(`${TODAY}T10:00:00.000Z`);
const HOUR = 3600 * 1000;
const S_META = { programmeBlock: { number: 2, config: {} }, userFocus: "Forged", mainLifts: {}, weights: { [SQUAT]: 100, [BENCH]: 80 }, reps: {} };
const HIP = "45-Degree Hip Extension"; // A's pure bodyweight slot (ass2-A)

/** What the swap overlay hands the host (components/SessionScreen.jsx SwapOverlay). */
function swapPick(activeEx, optionName) {
  const option = SWAP_DB[activeEx.name].find((o) => o.name === optionName);
  const loadType = swapLoadType(option);
  return { name: option.name, muscle: option.muscle, reps: activeEx.reps ?? 10, weight: loadType === getLoadType(activeEx) ? (activeEx.weight ?? null) : null, vid: option.vid ?? null, loadType };
}

/**
 * A record as the live host builds it on the trainer's device: the same
 * composition chain, no bodyweight and no anchors, through the real
 * newDraftLog, logSet and finaliseDraft, then over the wire.
 */
function liveRecord(meta = S_META, idx = 0, { readiness = "normal", reason = null, swaps = {}, sets = null, rpe = 8 } = {}) {
  const config = meta.programmeBlock?.config || {};
  const mains = validMainLifts(meta) || {};
  const main = applyMainLiftsToSession(applyRotationToSession(SESSIONS[idx], config), mains);
  const picks = typeof swaps === "function" ? swaps(main) : swaps;
  const active = scaleForReadiness(applyFocusToSession(applySwapsToSession(main, picks), meta.userFocus || "Forged", config, mains), readiness);
  const targets = repTargets(meta);
  const draft = newDraftLog({ profileName: null, session: SESSION_LETTERS[idx], blockNumber: meta.programmeBlock.number, readiness, readinessReason: reason });
  for (const b of active.blocks) {
    for (const [k, suffix] of [["ex", ""], ["exA", "-A"], ["exB", "-B"]]) {
      const ex = b[k];
      if (!ex) continue;
      const key = `${b.id}${suffix}`;
      const loadType = getLoadType(ex);
      const weight = loadType === "bodyweight" ? null : planStartWeight(ex, { working: meta.weights, bodyweight: null, anchors: {} });
      const reps = targets[ex.name] ?? ex.reps;
      for (let n = 0; n < (sets ?? b.sets); n++) {
        logSet(draft, {
          blockId: b.id, blockType: b.type, exerciseName: ex.name, muscle: ex.muscle, swapped: !!picks[key],
          fromPool: EXERCISE_POOLS[key] ? key : null, loadType, bodyweight: null, weight, reps,
          rpe: b.type === "main" ? rpe : null, prescribed: { reps, weight, sets: b.sets },
        });
      }
    }
  }
  return JSON.parse(JSON.stringify(finaliseDraft(draft)));
}

const edit = (record, fn) => { const r = structuredClone(record); fn(r); return r; };
const redate = (r, date, idDate = date) => { r.date = date; r.dow = jsDow(date); r.weekStart = mondayOfWeekIso(date); r.id = `${idDate}T10:00:00.000Z`; };
const exOf = (r, name) => r.blocks.flatMap((b) => b.exercises).find((e) => e.name === name);
const sset = (record, drum = {}) => ({ id: SET_ID, ops: [{ kind: "session", record, drum }] });
/** The verdict in one word: ok, stale, or "<rule>:<code>". */
function vs(record, { drum = {}, meta = S_META, history = [], ...extra } = {}) {
  const r = validateSessionSet(sset(record, drum), { meta, history, todayIso: TODAY, phase: "write", ...extra });
  return r.ok ? "ok" : r.stale ? "stale" : `${r.rule}:${r.code}`;
}
const sessionClock = () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
};

describe("coached session: the limits", () => {
  it("are the owner's numbers", () => {
    expect(SESSION_KIND).toBe("session");
    expect(MAX_SETS_PER_LIFT).toBe(10);
    expect(SESSION_CAP).toBe(7);
    expect(SESSIONS_PER_WEEK).toBe(SESSION_CAP);
    expect(AUTO_KEEP_MS).toBe(5 * 60 * 60 * 1000);
    expect(RECORD_MAX_BYTES).toBe(32768);
    expect(DRUM_MAX).toBe(32);
    expect(MAX_DURATION_S).toBe(21600);
    expect(OUTCOMES).toEqual(expect.arrayContaining(["kept", "auto_kept", "discarded", "superseded", "limits"]));
  });
  it("the readiness lists are the readiness screen's own", () => {
    const src = readFileSync(join(ROOT, "components/SessionScreen.jsx"), "utf8");
    const block = src.slice(src.indexOf("const reasons = ["), src.indexOf("];", src.indexOf("const reasons = [")));
    expect([...block.matchAll(/id:"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...READINESS_REASONS]);
    const opts = src.slice(src.indexOf("const opts=["), src.indexOf("];", src.indexOf("const opts=[")));
    expect([...opts.matchAll(/id:"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...READINESS]);
    expect(src).toMatch(/max=\{target\.timed\?180:30\}/);
  });
  it("the added-load bound is the drum's own", () => {
    expect(ADDED_LOAD_MAX_KG).toBe(100);
    expect(readFileSync(join(ROOT, "components/SessionScreen.jsx"), "utf8")).toMatch(/max=\{Math\.max\(ADDED_LOAD_MAX_KG,initKg\)\}/);
  });
});

describe("coached session: validateSessionSet, S1-S14", () => {
  sessionClock();
  const base = () => liveRecord();

  it("a live record of every letter, focus and readiness is accepted", () => {
    for (const idx of [0, 1, 2]) expect(vs(liveRecord(S_META, idx))).toBe("ok");
    for (const userFocus of ["Strong", "Sculpt"]) {
      const meta = { ...S_META, userFocus };
      for (const idx of [0, 1, 2]) expect(vs(liveRecord(meta, idx), { meta }), `${userFocus} ${idx}`).toBe("ok");
    }
    // Strong logs its accessories' range ("6-8") when no target was set.
    expect(exOf(liveRecord({ ...S_META, userFocus: "Strong" }, 0), "DB Reverse Lunge").sets[0].reps).toBe("6-8");
    expect(vs(liveRecord(S_META, 0, { readiness: "cooked", reason: "sore" }))).toBe("ok");
    // No W on a cooked day: the main lift prescribes its deloaded template.
    const noW = { ...S_META, weights: {} };
    expect(vs(liveRecord(noW, 0, { readiness: "cooked" }), { meta: noW })).toBe("ok");
    expect(vs(liveRecord(S_META, 1, { readiness: "fresh", sets: MAX_SETS_PER_LIFT }))).toBe("ok");
  });
  it("returns the change to store and the preview", () => {
    const record = base();
    const r = validateSessionSet(sset(record, { [SQUAT]: 102.5 }), { meta: S_META, history: [], todayIso: TODAY });
    expect(r.ok).toBe(true);
    expect(r.change).toEqual({ kind: "session", target: `${TODAY}:A`, before: null, after: { record, drum: { [SQUAT]: 102.5 } }, from: TODAY, basis: null });
    expect(r.ops).toEqual([{ i: 0, ...r.change, warnings: [] }]);
    expect(sessionTarget(record)).toBe(`${TODAY}:A`);
    const sets = record.blocks.flatMap((b) => b.exercises).reduce((n, e) => n + e.sets.length, 0);
    const exercises = record.blocks.flatMap((b) => b.exercises).length;
    expect(exercises).toBe(8);
    expect(r.preview).toEqual({ letter: "A", date: TODAY, day: "today", exercises, sets });
    expect(sessionPreview(record)).toEqual({ letter: "A", date: TODAY, day: null, exercises, sets });
  });
  it("S1: one session op on a real set id, and nothing else on it", () => {
    const record = base();
    const run = (set) => { const r = validateSessionSet(set, { meta: S_META, history: [], todayIso: TODAY }); return r.ok ? "ok" : `${r.rule}:${r.code}`; };
    expect(run({ id: "hws_short", ops: [{ kind: "session", record }] })).toBe("S1:set_id");
    expect(run({ id: SET_ID, ops: [] })).toBe("S1:set_size");
    expect(run({ id: SET_ID, ops: [{ kind: "session", record }, { kind: "session", record }] })).toBe("S1:set_size");
    expect(run({ id: SET_ID, ops: [{ kind: "weight", record }] })).toBe("S1:kind");
    expect(run({ id: SET_ID, ops: [{ kind: "session", record, note: "hi" }] })).toBe("S1:op_shape");
    expect(run({ id: SET_ID, ops: [{ kind: "session" }] })).toBe("S1:op_shape");
    expect(run({ id: SET_ID, ops: [{ kind: "session", record }] })).toBe("ok");
  });
  it("S2: 32,768 bytes pass the size bound, 32,769 do not", () => {
    const record = base();
    const bytes = (r) => new TextEncoder().encode(JSON.stringify({ record: r, drum: {} })).length;
    const padded = (n) => edit(record, (r) => { r.pad = ""; r.pad = "x".repeat(n - bytes(r)); });
    expect(bytes(padded(RECORD_MAX_BYTES))).toBe(RECORD_MAX_BYTES);
    // No legal record comes near the bound (a full Strength C is about half), so the
    // padding is the junk the bound exists for: at the bound it passes S2 and S3 names it.
    expect(vs(padded(RECORD_MAX_BYTES))).toBe("S3:record_shape");
    expect(vs(padded(RECORD_MAX_BYTES + 1))).toBe("S2:size");
    expect(vs(edit(record, (r) => { r.loggedTz = "é".repeat(RECORD_MAX_BYTES / 2); }))).toBe("S2:size");
  });
  it("S2: the drum holds the record's own lifts, on the drum's bounds", () => {
    const record = base();
    expect(vs(record, { drum: { [SQUAT]: 102.5, [BENCH]: 400 } })).toBe("ok");
    expect(vs(record, { drum: { [SQUAT]: 400.25 } })).toBe("S2:drum");
    expect(vs(record, { drum: { [SQUAT]: 102.6 } })).toBe("S2:drum");
    expect(vs(record, { drum: { [SQUAT]: null } })).toBe("S2:drum");
    expect(vs(record, { drum: { "Hack Squat": 100 } })).toBe("S2:drum");
    expect(vs(record, { drum: { [HIP]: 100 } })).toBe("ok");
    expect(vs(record, { drum: { [HIP]: 100.25 } })).toBe("S2:drum");
    const many = Object.fromEntries(Array.from({ length: DRUM_MAX + 1 }, (_, i) => [`Lift ${i}`, 10]));
    expect(vs(record, { drum: many })).toBe("S2:drum");
  });
  it("S3: exactly the producer's fields, and nothing the client's device owns", () => {
    const record = base();
    const no = (fn) => vs(edit(record, fn));
    expect(no((r) => { r.schemaVersion = SCHEMA_VERSION - 1; })).toBe("S3:record_shape");
    expect(no((r) => { r.profileName = "sam"; })).toBe("S3:record_shape");
    expect(no((r) => { r.bodyweight = 80; })).toBe("S3:record_shape");
    expect(no((r) => { r.hoursSlept = 7; })).toBe("S3:record_shape");
    expect(no((r) => { r.daysSinceLast = 2; })).toBe("S3:record_shape");
    expect(no((r) => { r.blocks[0].exercises[0].sets[0].bodyweightUsed = 80; })).toBe("S3:record_shape");
    expect(no((r) => { r.mesocyclePhase = "deload"; })).toBe("S3:record_shape");
    expect(no((r) => { r.travel = true; })).toBe("S3:record_shape");
    expect(no((r) => { r.retrospective = true; })).toBe("S3:record_shape");
    expect(no((r) => { r.loggedAt = new Date(NOW).toISOString(); })).toBe("S3:record_shape");
    expect(no((r) => { r.loggedBy = { by: "trainer", name: "Sam" }; })).toBe("S3:record_shape");
    expect(no((r) => { r.blocks[0].exercises[0].sets[0].note = "x"; })).toBe("S3:record_shape");
    expect(no((r) => { r.blocks[0].exercises[0].prescribed.rir = 2; })).toBe("S3:record_shape");
    expect(no((r) => { delete r.summary; })).toBe("S3:record_shape");
    expect(no((r) => { r.summary.mainLiftPRs = [SQUAT]; })).toBe("S3:record_shape");
    expect(no((r) => { r.summary.volumeByMuscle = {}; })).toBe("S3:record_shape");
    expect(no((r) => { r.blocks[0].exercises[0].summary.totalVolume = "lots"; })).toBe("S3:record_shape");
    expect(no((r) => { r.blocks[0].exercises[0].sets[0].reach = false; })).toBe("S3:record_shape");
    expect(no((r) => { r.blocks[0].exercises[0].sets[0].loadType = "per_db"; })).toBe("S3:record_shape");
    expect(no((r) => { r.blocks = []; })).toBe("S3:record_shape");
    // Derived numbers are shape only: the client's device rebuilds them at Keep.
    expect(no((r) => { r.blocks[0].exercises[0].sets[0].est1rm = 999; r.summary.totalVolume = 1; })).toBe("ok");
  });
  it("S3: RECORD_KEYS is every field the producer writes, and no other", () => {
    const record = liveRecord(S_META, 0, { readiness: "fresh" });
    const reach = edit(record, (r) => { r.blocks[0].exercises[0].sets[2].reach = true; });
    expect(vs(reach)).toBe("ok");
    const ex = reach.blocks[0].exercises[0];
    const sorted = (a) => [...a].sort();
    expect(sorted(Object.keys(reach))).toEqual(sorted(RECORD_KEYS.record));
    expect(sorted(Object.keys(reach.blocks[0]))).toEqual(sorted(RECORD_KEYS.block));
    expect(sorted(Object.keys(ex))).toEqual(sorted(RECORD_KEYS.exercise));
    expect(sorted(Object.keys(ex.prescribed))).toEqual(sorted(RECORD_KEYS.prescribed));
    expect(sorted(Object.keys(ex.sets[2]))).toEqual(sorted(RECORD_KEYS.set));
    expect(sorted(Object.keys(ex.summary))).toEqual(sorted(RECORD_KEYS.exerciseSummary));
    expect(sorted(Object.keys(ex.summary.topSet))).toEqual(sorted(RECORD_KEYS.topSet));
    expect(sorted(Object.keys(reach.summary))).toEqual(sorted(RECORD_KEYS.summary));
  });
  it("S4: today and yesterday on the trainer's clock, never two days back or tomorrow", () => {
    const record = base();
    expect(vs(edit(record, (r) => redate(r, TODAY)))).toBe("ok");
    expect(vs(edit(record, (r) => redate(r, ago(1), TODAY)))).toBe("ok");
    expect(vs(edit(record, (r) => redate(r, ago(2))))).toBe("S4:day");
    expect(vs(edit(record, (r) => redate(r, ago(2), ago(1))))).toBe("S4:day");
    expect(vs(edit(record, (r) => redate(r, addDaysIso(TODAY, 1))))).toBe("S4:day");
    expect(vs(record, { todayIso: null })).toBe("S4:day");
    // A trainer whose clock is a day ahead of the server sends for their today.
    expect(vs(edit(record, (r) => redate(r, addDaysIso(TODAY, 1))), { todayIso: addDaysIso(TODAY, 1) })).toBe("ok");
  });
  it("S4: the id is an instant within a day of the date; dow, weekStart and duration follow", () => {
    const record = base();
    expect(vs(edit(record, (r) => { r.id = `${addDaysIso(TODAY, 1)}T02:00:00.000Z`; }))).toBe("ok");
    expect(vs(edit(record, (r) => { r.id = `${addDaysIso(TODAY, 2)}T02:00:00.000Z`; }))).toBe("S4:date");
    expect(vs(edit(record, (r) => { r.id = `${TODAY}T10:00:00Z`; }))).toBe("S4:date");
    expect(vs(edit(record, (r) => { r.date = "2026-02-30"; }))).toBe("S4:date");
    expect(vs(edit(record, (r) => { r.dow = (r.dow + 1) % 7; }))).toBe("S4:date");
    expect(vs(edit(record, (r) => { r.weekStart = ago(7); }))).toBe("S4:date");
    expect(vs(edit(record, (r) => { r.duration = MAX_DURATION_S; }))).toBe("ok");
    expect(vs(edit(record, (r) => { r.duration = MAX_DURATION_S + 1; }))).toBe("S4:duration");
    expect(vs(edit(record, (r) => { r.duration = -1; }))).toBe("S4:duration");
    expect(vs(edit(record, (r) => { r.duration = 1.5e3 + 0.5; }))).toBe("S4:duration");
  });
  it("S5: a strength letter, and the letter it names", () => {
    const record = base();
    expect(vs(edit(record, (r) => { r.session = "strength-d"; }))).toBe("S5:letter");
    expect(vs(edit(record, (r) => { r.session = "cardio"; }))).toBe("S5:letter");
    expect(vs(edit(record, (r) => { r.scheduledLetter = "B"; }))).toBe("S5:letter");
  });
  it("S6: the letter's own blocks, once each, in session order; skipped blocks pass", () => {
    const record = base();
    expect(vs(edit(record, (r) => { r.blocks.splice(2, 1); }))).toBe("ok");
    expect(vs(edit(record, (r) => { r.blocks = [r.blocks[0]]; }))).toBe("ok");
    expect(vs(edit(record, (r) => { [r.blocks[0], r.blocks[1]] = [r.blocks[1], r.blocks[0]]; }))).toBe("S6:block");
    expect(vs(edit(record, (r) => { r.blocks.push(structuredClone(r.blocks[0])); }))).toBe("S6:block");
    expect(vs(edit(record, (r) => { r.blocks[0].id = "b1"; }))).toBe("S6:block");
    expect(vs(edit(record, (r) => { r.blocks[2].type = "main"; }))).toBe("S6:block");
    expect(vs(liveRecord(S_META, 1), { meta: S_META })).toBe("ok");
  });
  it("S7: the slot's lift, or an option the swap overlay offers for that slot", () => {
    const swapped = liveRecord(S_META, 0, { swaps: (main) => ({ a1: swapPick(main.blocks[0].ex, "Hack Squat") }) });
    const hack = exOf(swapped, "Hack Squat");
    expect(hack).toMatchObject({ swapped: true, loadType: swapLoadType(SWAP_DB[SQUAT][1]) });
    expect(isSwapFor(SQUAT, "Hack Squat")).toBe(true);
    expect(vs(swapped)).toBe("ok");
    const dips = liveRecord(S_META, 0, { swaps: (main) => ({ a2: swapPick(main.blocks[1].ex, "Weighted Dips") }) });
    expect(exOf(dips, "Weighted Dips").loadType).toBe(swapLoadType(SWAP_DB[BENCH][3]));
    expect(vs(dips)).toBe("ok");
    expect(vs(edit(swapped, (r) => { exOf(r, "Hack Squat").swapped = false; }))).toBe("S7:exercise");
    expect(vs(edit(swapped, (r) => { exOf(r, "Hack Squat").loadType = "barbell"; for (const s of exOf(r, "Hack Squat").sets) s.loadType = "barbell"; }))).toBe("S7:exercise");
    expect(isSwapFor(SQUAT, "Leg Press")).toBe(false);
    expect(isSwapFor("constructor", "Leg Press")).toBe(false);
    expect(vs(edit(record0(), (r) => { r.blocks[0].exercises[0].name = "Leg Press"; r.blocks[0].exercises[0].swapped = true; }))).toBe("S7:exercise");
    // At most one exercise per slot.
    expect(vs(edit(swapped, (r) => { r.blocks[0].exercises.push(structuredClone(r.blocks[0].exercises[0])); }))).toBe("S7:exercise");
    expect(vs(edit(record0(), (r) => { r.blocks[2].exercises[0].fromPool = null; }))).toBe("S7:exercise");
  });
  it("S8: 1 to 10 sets a lift, one reach a session", () => {
    const ten = liveRecord(S_META, 2, { sets: MAX_SETS_PER_LIFT });
    expect(vs(ten)).toBe("ok");
    expect(vs(edit(ten, (r) => { r.blocks[0].exercises[0].sets.push(structuredClone(r.blocks[0].exercises[0].sets[0])); }))).toBe("S8:sets");
    expect(vs(edit(ten, (r) => { r.blocks[1].exercises[1].sets = []; }))).toBe("S8:sets");
    const fresh = liveRecord(S_META, 0, { readiness: "fresh" });
    expect(vs(edit(fresh, (r) => { r.blocks[0].exercises[0].sets[2].reach = true; }))).toBe("ok");
    expect(vs(edit(fresh, (r) => { r.blocks[0].exercises[0].sets[2].reach = true; r.blocks[1].exercises[0].sets[2].reach = true; }))).toBe("S8:reach");
  });
  it("S8: a reach only where the live host offers it", () => {
    expect(readFileSync(join(ROOT, "components/SessionHost.jsx"), "utf8")).toMatch(/const REACH_EARLIEST_SET = 3;/);
    const fresh = liveRecord(S_META, 0, { readiness: "fresh" });
    const reach = (record, fn, extra) => vs(edit(record, fn), extra);
    // The headline's last prescribed set, or a set added after it.
    expect(reach(fresh, (r) => { r.blocks[0].exercises[0].sets[2].reach = true; })).toBe("ok");
    expect(reach(fresh, (r) => { const sets = r.blocks[0].exercises[0].sets; sets.push({ ...structuredClone(sets[2]), reach: true }); })).toBe("ok");
    // Not before the last prescribed set, and never before the third.
    expect(reach(fresh, (r) => { r.blocks[0].exercises[0].sets[1].reach = true; })).toBe("S8:reach");
    expect(reach(liveRecord(S_META, 0, { readiness: "fresh", sets: 2 }), (r) => {
      r.blocks[0].exercises[0].prescribed.sets = 2; r.blocks[0].exercises[0].sets[1].reach = true;
    }, { meta: S_META, phase: "apply", at: NOW })).toBe("S8:reach");
    // Only on a fresh day, only on the session's first main block, never on a superset.
    for (const readiness of ["normal", "cooked"]) {
      expect(reach(liveRecord(S_META, 0, { readiness }), (r) => { r.blocks[0].exercises[0].sets[2].reach = true; }), readiness).toBe("S8:reach");
    }
    expect(reach(fresh, (r) => { r.blocks[1].exercises[0].sets[2].reach = true; })).toBe("S8:reach");
    const ss = fresh.blocks.findIndex((b) => b.type === "superset");
    expect(reach(fresh, (r) => { const e = r.blocks[ss].exercises[0]; e.sets[e.sets.length - 1].reach = true; })).toBe("S8:reach");
    // Never a pure bodyweight lift (the device's own check: the write path refuses the load type first).
    const apply = (r) => { const v = validateSessionSet(sset(r), { phase: "apply", at: NOW }); return v.ok ? "ok" : `${v.rule}:${v.code}`; };
    expect(apply(edit(fresh, (r) => { r.blocks[0].exercises[0].sets[2].reach = true; }))).toBe("ok");
    expect(apply(edit(fresh, (r) => {
      const e = r.blocks[0].exercises[0];
      e.loadType = "bodyweight";
      for (const st of e.sets) Object.assign(st, { loadType: "bodyweight", weight: null });
      e.sets[2].reach = true;
    }))).toBe("S8:reach");
  });
  it("S8-S10: the prescription the engine reads is bounded, swapped or not, at write and on the device", () => {
    const swapped = liveRecord(S_META, 0, { swaps: (main) => ({ a1: swapPick(main.blocks[0].ex, "Hack Squat") }) });
    const pre = (over, record = swapped, name = "Hack Squat") => vs(edit(record, (r) => { Object.assign(exOf(r, name).prescribed, over); }));
    expect(pre({})).toBe("ok");
    expect(pre({ reps: 30, weight: MAX_KG, sets: MAX_SETS_PER_LIFT })).toBe("ok");
    expect(pre({ reps: 31 })).toBe("S10:reps");
    expect(pre({ reps: 0 })).toBe("S10:reps");
    expect(pre({ reps: -5 })).toBe("S10:reps");
    expect(pre({ reps: "999" })).toBe("S10:reps");
    expect(pre({ reps: "9".repeat(5000) })).toBe("S10:reps");
    // The template's own strings in the lift's own shape; a hold's seconds on a
    // lift that isn't one would make the client's engine store it as a hold.
    for (const reps of ["6-8", "12-15", "8/leg"]) expect(pre({ reps }), reps).toBe("ok");
    for (const reps of ["45s", "180s"]) expect(pre({ reps }), reps).toBe("S10:reps");
    // A live timed swap (Leg Press to Wall Sit) carries its own seconds.
    const wall = liveRecord(S_META, 1, { swaps: (main) => ({ "bss1-A": swapPick(main.blocks.find((b) => b.id === "bss1").exA, "Wall Sit") }) });
    expect(exOf(wall, "Wall Sit").prescribed.reps).toBe("45s");
    expect(vs(wall)).toBe("ok");
    expect(pre({ weight: MAX_KG + 0.25 })).toBe("S9:load");
    expect(pre({ weight: 1e9 })).toBe("S9:load");
    expect(pre({ weight: -50 })).toBe("S9:load");
    expect(pre({ weight: null })).toBe("ok");
    expect(pre({ sets: MAX_SETS_PER_LIFT + 1 })).toBe("S8:sets");
    expect(pre({ sets: 100000 })).toBe("S8:sets");
    expect(pre({ sets: -3 })).toBe("S8:sets");
    expect(pre({ sets: 0 })).toBe("S8:sets");
    // A pure bodyweight lift's prescribed load is the added kg, at most.
    const record = record0();
    expect(pre({ weight: ADDED_LOAD_MAX_KG }, record, HIP)).toBe("stale");
    expect(pre({ weight: ADDED_LOAD_MAX_KG + 0.25 }, record, HIP)).toBe("S9:load");
    // The device holds the same bounds on every lift.
    const apply = (over) => {
      const v = validateSessionSet(sset(edit(record, (r) => { Object.assign(r.blocks[0].exercises[0].prescribed, over); })), { phase: "apply", at: NOW });
      return v.ok ? "ok" : `${v.rule}:${v.code}`;
    };
    expect(apply({ sets: MAX_SETS_PER_LIFT, reps: 30, weight: MAX_KG })).toBe("ok");
    expect(apply({ reps: 999 })).toBe("S10:reps");
    expect(apply({ weight: 1e9 })).toBe("S9:load");
    expect(apply({ sets: 100000 })).toBe("S8:sets");
    expect(apply({ reps: "45s" })).toBe("S10:reps");
    expect(apply({ reps: "180s" })).toBe("S10:reps");
  });
  it("S9: weight on the drum's grid, 0 to 400 kg; a pure bodyweight lift's added kg to 100", () => {
    const record = base();
    const set0 = (w) => vs(edit(record, (r) => { r.blocks[0].exercises[0].sets[0].weight = w; }));
    expect(set0(400)).toBe("ok");
    expect(set0(400.25)).toBe("S9:load");
    expect(set0(0)).toBe("ok");
    expect(set0(null)).toBe("ok");
    expect(set0(-1)).toBe("S9:load");
    expect(set0(102.75)).toBe("ok");
    expect(set0(102.6)).toBe("S9:load");
    expect(set0("100")).toBe("S9:load");
    const hip = (w) => vs(edit(record, (r) => { exOf(r, HIP).sets[0].weight = w; }));
    expect(exOf(record, HIP).loadType).toBe("bodyweight");
    expect(hip(ADDED_LOAD_MAX_KG)).toBe("ok");
    expect(hip(ADDED_LOAD_MAX_KG + 0.25)).toBe("S9:load");
  });
  it("S10: reps 1 to 30 (also per leg, or a template's range); a timed hold 5 to 180 s in fives", () => {
    const record = base();
    const reps = (v, name = SQUAT) => vs(edit(record, (r) => { exOf(r, name).sets[0].reps = v; }));
    expect(reps(30)).toBe("ok");
    expect(reps(31)).toBe("S10:reps");
    expect(reps(1)).toBe("ok");
    expect(reps(0)).toBe("S10:reps");
    expect(reps(5.5)).toBe("S10:reps");
    expect(reps("5")).toBe("S10:reps");
    expect(reps("30/leg", "DB Reverse Lunge")).toBe("ok");
    expect(reps("31/leg", "DB Reverse Lunge")).toBe("S10:reps");
    expect(reps("0/leg", "DB Reverse Lunge")).toBe("S10:reps");
    expect(reps("6-8")).toBe("ok");
    expect(reps("8-6")).toBe("S10:reps");
    expect(reps("6-31")).toBe("S10:reps");
    // A timed hold, rotated into A's finisher.
    const meta = { ...S_META, programmeBlock: { number: 2, config: { "afin-A": pool("afin-A", "L-Sit Hold") } } };
    const held = liveRecord(meta, 0);
    expect(exOf(held, "L-Sit Hold").sets[0].reps).toBe("20s");
    const sec = (v) => vs(edit(held, (r) => { exOf(r, "L-Sit Hold").sets[0].reps = v; }), { meta });
    expect(sec("20s")).toBe("ok");
    expect(sec(TIMED_SECONDS.max)).toBe("ok");
    expect(sec(TIMED_SECONDS.max + TIMED_SECONDS.step)).toBe("S10:reps");
    expect(sec(TIMED_SECONDS.min)).toBe("ok");
    expect(sec(0)).toBe("S10:reps");
    expect(sec(7)).toBe("S10:reps");
    expect(sec("185s")).toBe("S10:reps");
    expect(sec("20/leg")).toBe("S10:reps");
  });
  it("S11: felt on the track (6 to 10 in halves) with the engine's RIR, or none", () => {
    const record = base();
    const felt = (rpe, rir) => vs(edit(record, (r) => { Object.assign(r.blocks[0].exercises[0].sets[0], { rpe, rir }); }));
    for (let rpe = RPE_TRACK.min; rpe <= RPE_TRACK.max; rpe += RPE_TRACK.step) expect(felt(rpe, rpeToRir(rpe)), String(rpe)).toBe("ok");
    expect(felt(5.5, rpeToRir(5.5))).toBe("S11:felt");
    expect(felt(10.5, 0)).toBe("S11:felt");
    expect(felt(7.25, rpeToRir(7.25))).toBe("S11:felt");
    expect(felt(8, 3)).toBe("S11:felt");
    expect(felt(null, null)).toBe("ok");
    expect(felt(null, 2)).toBe("S11:felt");
    expect(felt("normal", 2)).toBe("S11:felt");
  });
  it("S12: what the trainer's device prescribed is the client's plan now; swapped lifts are bounds only", () => {
    const record = base();
    expect(vs(record, { meta: { ...S_META, weights: { [SQUAT]: 105, [BENCH]: 80 } } })).toBe("stale");
    // Strong drops blocks: the record no longer fits the plan at all.
    expect(vs(record, { meta: { ...S_META, userFocus: "Strong" } })).toBe("S6:block");
    expect(vs(record, { meta: { ...S_META, reps: { [SQUAT]: 6 } } })).toBe("stale");
    expect(vs(edit(record, (r) => { r.blocks[0].exercises[0].prescribed.sets = 4; }))).toBe("stale");
    expect(vs(edit(record, (r) => { r.blocks[0].exercises[0].prescribed.weight = null; }))).toBe("ok");
    expect(vs(edit(record, (r) => { r.blocks[0].exercises[0].prescribed.weight = SESSIONS[0].blocks[0].ex.weight; }))).toBe("ok");
    const swapped = liveRecord(S_META, 0, { swaps: (main) => ({ a1: swapPick(main.blocks[0].ex, "Hack Squat") }) });
    expect(vs(edit(swapped, (r) => { Object.assign(exOf(r, "Hack Squat").prescribed, { reps: 12, weight: 140, sets: 5 }); }))).toBe("ok");
    // A cooked day trims a superset's sets: fewer pass, more do not.
    const cooked = liveRecord(S_META, 0, { readiness: "cooked" });
    expect(cooked.blocks.find((b) => b.id === "ass1").exercises[0].prescribed.sets).toBe(2);
    expect(vs(edit(cooked, (r) => { r.blocks.find((b) => b.id === "ass1").exercises[0].prescribed.sets = 4; }))).toBe("stale");
  });
  it("S12: with no W on a cooked day, a main lift's prescribed weight is the template or lighter", () => {
    const meta = { ...S_META, weights: {} };
    const tmpl = SESSIONS[0].blocks[0].ex.weight;
    const cooked = liveRecord(meta, 0, { readiness: "cooked" });
    expect(exOf(cooked, SQUAT).prescribed.weight).toBeLessThan(tmpl);
    expect(vs(cooked, { meta })).toBe("ok");
    const w = (kg) => vs(edit(cooked, (r) => { exOf(r, SQUAT).prescribed.weight = kg; }), { meta });
    expect(w(tmpl)).toBe("ok");
    expect(w(tmpl + 0.25)).toBe("stale");
    expect(w(MAX_KG)).toBe("stale");
  });
  it("S13: they logged this letter that day themselves", () => {
    const record = base();
    expect(vs(record, { history: [{ id: `${TODAY}T07:00:00.000Z`, date: TODAY, session: "strength-a", scheduledLetter: "A", blocks: [] }] })).toBe("S13:already_logged");
    expect(vs(record, { history: [{ id: `${TODAY}T12:00:00.000Z`, date: TODAY, session: "strength-a", retrospective: true, blocks: [] }] })).toBe("S13:already_logged");
    expect(vs(record, { history: [{ id: `${TODAY}T07:00:00.000Z`, date: TODAY, session: "strength-b", scheduledLetter: "B", blocks: [] }] })).toBe("ok");
    expect(vs(record, { history: [{ id: `${ago(2)}T07:00:00.000Z`, date: ago(2), session: "strength-a", scheduledLetter: "A", blocks: [] }] })).toBe("ok");
  });
  it("S13: a record reusing one of their record ids is refused", () => {
    const theirs = { id: `${ago(1)}T18:00:00.000Z`, date: ago(1), session: "strength-b", scheduledLetter: "B", blocks: [] };
    const reused = edit(record0(), (r) => { r.id = theirs.id; });
    const v = validateSessionSet(sset(reused), { meta: S_META, history: [theirs], todayIso: TODAY, phase: "write" });
    expect(v.ok).toBe(false);
    expect(v.refusals).toEqual([{ i: 0, code: "already_logged", rule: "S13", field: "id" }]);
    expect(vs(reused, { history: [{ ...theirs, id: `${ago(1)}T18:00:00.001Z` }] })).toBe("ok");
  });
  it("S14: readiness and its reason from the readiness screen's lists", () => {
    const record = base();
    expect(vs(edit(record, (r) => { r.readiness = "tired"; }))).toBe("S14:readiness");
    expect(vs(edit(record, (r) => { r.readinessReason = "hungover"; }))).toBe("S14:readiness");
    for (const reason of READINESS_REASONS) expect(vs(edit(record, (r) => { r.readinessReason = reason; }))).toBe("ok");
  });
  it("the device re-checks bounds, not programme membership, and measures the day from the send", () => {
    const record = base();
    const apply = (r, at = NOW) => {
      const v = validateSessionSet(sset(r), { phase: "apply", at });
      return v.ok ? "ok" : v.stale ? "stale" : `${v.rule}:${v.code}`;
    };
    // A rotation between send and Keep never refuses what they trained.
    expect(apply(edit(record, (r) => { r.blocks[0].id = "zz"; r.blocks[0].exercises[0].name = "Leg Press"; }))).toBe("ok");
    expect(apply(edit(record, (r) => { r.blocks[0].exercises[0].prescribed.sets = 9; }))).toBe("ok");
    // Sent a week ago, still in its window: it never goes stale waiting.
    const old = edit(record, (r) => redate(r, ago(7)));
    expect(apply(old, Date.parse(`${ago(7)}T22:00:00.000Z`))).toBe("ok");
    expect(apply(edit(record, (r) => redate(r, ago(2), ago(1))))).toBe("ok");
    expect(apply(edit(record, (r) => redate(r, ago(3), ago(2))))).toBe("S4:day");
    expect(apply(edit(record, (r) => redate(r, addDaysIso(TODAY, 1))))).toBe("ok");
    expect(apply(edit(record, (r) => redate(r, addDaysIso(TODAY, 2), addDaysIso(TODAY, 1))))).toBe("S4:day");
    // The bounds hold on the device.
    expect(apply(edit(record, (r) => { r.blocks[0].exercises[0].sets[0].weight = 400.25; }))).toBe("S9:load");
    expect(apply(edit(record, (r) => { r.blocks[0].exercises[0].sets[0].bodyweightUsed = 80; }))).toBe("S3:record_shape");
    expect(apply(edit(record, (r) => { r.loggedBy = { name: "Sam" }; }))).toBe("S3:record_shape");
  });
  it("a session never rides validateOp or a plan set", () => {
    const record = base();
    expect(validateOp({ kind: "session", record }, { meta: S_META, history: [], todayIso: TODAY }).code).toBe("kind");
    expect(validateOp({ kind: "session", record }, { meta: S_META, history: [], todayIso: TODAY, phase: "apply" }).code).toBe("kind");
    const set = (ops) => validateChangeSet({ id: SET_ID, ops }, { meta: S_META, history: [], todayIso: TODAY }).refusals;
    expect(set([{ kind: "session", record }])).toEqual([{ i: null, code: "set_kind" }]);
    expect(set([{ kind: "reps", lift: SQUAT, reps: 6 }, { kind: "session", record }])).toEqual([{ i: null, code: "set_kind" }]);
  });
});

/** A plain Strength A record for the edits above. */
function record0() { return liveRecord(); }

describe("coached session: the day in words", () => {
  it("today, yesterday, else the record's own day, never today when clocks disagree", () => {
    expect(sessionDayWords(TODAY, TODAY)).toBe("today");
    expect(sessionDayWords(ago(1), TODAY)).toBe("yesterday");
    expect(sessionDayWords("2026-10-06", "2026-10-08")).toBe("Tuesday 6 Oct");
    // The trainer's today is the client's yesterday: the client reads the record's day.
    expect(sessionDayWords(addDaysIso(TODAY, 1), TODAY)).toBe("Tuesday 6 Oct");
    expect(sessionDayWords("2026-13-01", TODAY)).toBe(null);
  });
  it("the preview names the day the trainer chose", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const y = edit(liveRecord(), (r) => redate(r, ago(1), TODAY));
      expect(validateSessionSet(sset(y), { meta: S_META, history: [], todayIso: TODAY }).preview).toMatchObject({ date: ago(1), day: "yesterday" });
    } finally { vi.useRealTimers(); }
  });
});

// ── Session statuses (§7) ───────────────────────────────────────────────────

const DELIVERED = `${TODAY}T11:00:00.000Z`;
/** A stored session row, as rowFromDb returns it. */
const srowDb = (over = {}) => rowFromDb({
  id: `${SET_ID}.0`, set_id: SET_ID, kind: "session", target: `${TODAY}:A`, old_value: null,
  new_value: { record: { date: TODAY }, drum: {} }, effective_from: TODAY, basis: null, created_at: String(NOW),
  applied_at: null, outcome: null, undone_at: null, undone_by: null, reverted_at: null, warnings: null, delivered_at: null, ...over,
});

describe("sessionStatus", () => {
  const st = (over, editsLive = true) => sessionStatus(srowDb(over), { editsLive });
  it("waiting: sent, not yet on their phone", () => {
    expect(st({})).toEqual({ status: "waiting", reason: null, date: TODAY });
  });
  it("seen: on their phone, kept five hours after it arrived unless they say otherwise", () => {
    expect(st({ delivered_at: DELIVERED })).toEqual({ status: "seen", reason: null, date: TODAY, keepsAt: Date.parse(DELIVERED) + AUTO_KEEP_MS });
  });
  it("seen, sharing stopped: it stays until they decide, with no auto-keep", () => {
    expect(st({ delivered_at: DELIVERED }, false)).toEqual({ status: "seen", reason: "stopped", date: TODAY, keepsAt: null });
  });
  it("kept, kept after five hours, discarded, superseded", () => {
    expect(st({ outcome: "kept", applied_at: DELIVERED, delivered_at: DELIVERED })).toEqual({ status: "kept", reason: null, date: TODAY });
    expect(st({ outcome: "auto_kept", applied_at: DELIVERED, delivered_at: DELIVERED })).toEqual({ status: "auto_kept", reason: null, date: TODAY });
    expect(st({ outcome: "discarded", delivered_at: DELIVERED })).toEqual({ status: "discarded", reason: null, date: TODAY });
    expect(st({ outcome: "superseded" })).toEqual({ status: "superseded", reason: null, date: TODAY });
    // An outcome stands whether or not sharing is live now.
    expect(st({ outcome: "kept" }, false).status).toBe("kept");
  });
  it("not_applied: limits, or sharing stopped before it arrived", () => {
    expect(st({ outcome: "limits" })).toEqual({ status: "not_applied", reason: "limits", date: TODAY });
    expect(st({}, false)).toEqual({ status: "not_applied", reason: "stopped", date: TODAY });
  });
  it("withdrawn: by the trainer, before it arrived", () => {
    expect(st({ undone_at: String(NOW + 1), undone_by: "trainer" })).toEqual({ status: "withdrawn", reason: null, date: TODAY });
  });
  it("a keep that lands after a withdraw reads as kept: it is in their history", () => {
    // The phone had it, its arrival report had not landed, the trainer withdrew.
    const late = { undone_at: String(NOW + 1), undone_by: "trainer", applied_at: DELIVERED };
    expect(st({ ...late, outcome: "kept" })).toEqual({ status: "kept", reason: null, date: TODAY });
    expect(st({ ...late, outcome: "auto_kept" }).status).toBe("auto_kept");
    expect(st({ undone_at: String(NOW + 1), undone_by: "trainer", outcome: "discarded" }).status).toBe("withdrawn");
  });
  it("the date is the record's day; changeStatus delegates; the client never undoes one", () => {
    const y = srowDb({ effective_from: null, new_value: { record: { date: ago(1) }, drum: {} } });
    expect(sessionStatus(y, {}).date).toBe(ago(1));
    const r = srowDb({ delivered_at: DELIVERED });
    const s = changeStatus(r, { meta: {}, history: [], todayIso: TODAY, editsLive: true });
    expect(s).toEqual(sessionStatus(r, { editsLive: true }));
    expect(isUndoable(srowDb(), changeStatus(srowDb(), { meta: {}, history: [], todayIso: TODAY, editsLive: true }), { meta: {} })).toBe(false);
    expect(r.deliveredAt).toBe(DELIVERED);
  });
});

// ── The device's session plan, and W-D ──────────────────────────────────────

describe("planSessionSteps", () => {
  sessionClock();
  /** A session row as the pull delivers it. */
  const srow = (record, over = {}) => ({
    id: `${SET_ID}.0`, set: SET_ID, kind: "session", target: sessionTarget(record), from: record.date,
    before: null, after: { record, drum: { [SQUAT]: 102.5 } }, basis: null, at: NOW - HOUR, appliedAt: null, undone: false,
    by: "Sam", deliveredAt: null, editsLive: true, ...over,
  });
  const steps = (rows, { history = [], nowMs = NOW, local = {}, acked = [], holding = [] } = {}) => planSessionSteps(rows, { history, nowMs, local, acked, holding });

  it("first sight: marks it seen and shows the card", () => {
    const record = liveRecord();
    const p = steps([srow(record)]);
    expect(p.seen).toEqual([{ id: `${SET_ID}.0`, at: new Date(NOW).toISOString() }]);
    expect(p.acks).toEqual([]);
    expect(p.keep).toEqual([]);
    expect(p.cards).toEqual([{ id: `${SET_ID}.0`, record, drum: { [SQUAT]: 102.5 }, by: "Sam", startMs: NOW, keepsAt: NOW + AUTO_KEEP_MS }]);
  });
  it("W-D: never auto-keeps a record no device has had, at any time", () => {
    const record = liveRecord();
    for (const nowMs of [NOW, NOW + AUTO_KEEP_MS, NOW + 50 * HOUR, NOW + 365 * 24 * HOUR]) {
      const p = steps([srow(record)], { nowMs });
      expect(p.keep, String(nowMs)).toEqual([]);
      expect(p.cards[0].keepsAt).toBe(nowMs + AUTO_KEEP_MS);
    }
  });
  it("W-D: the five hours start at first sight, never at the send", () => {
    // Sent long ago, never delivered: the send time starts nothing.
    const record = liveRecord();
    const p = steps([srow(record, { at: NOW - 10 * HOUR })], { nowMs: NOW });
    expect(p.keep).toEqual([]);
    expect(p.cards[0].startMs).toBe(NOW);
  });
  it("W-D: keeps at seen + five hours, not a millisecond before", () => {
    const record = liveRecord();
    const local = { [`${SET_ID}.0`]: { seenAt: NOW } };
    expect(steps([srow(record)], { local, nowMs: NOW + AUTO_KEEP_MS - 1 }).keep).toEqual([]);
    const p = steps([srow(record)], { local, nowMs: NOW + AUTO_KEEP_MS });
    expect(p.keep).toEqual([{ id: `${SET_ID}.0`, record, drum: { [SQUAT]: 102.5 }, by: "Sam", startMs: NOW, keepsAt: NOW + AUTO_KEEP_MS, auto: true }]);
    expect(p.cards).toEqual([]);
    expect(p.seen).toEqual([]);
  });
  it("W-D: the buffer starts at the earlier of the server's delivered and this device's seen", () => {
    const record = liveRecord();
    const id = `${SET_ID}.0`;
    const delivered = new Date(NOW - 2 * HOUR).toISOString();
    // Another device had it two hours ago.
    expect(steps([srow(record, { deliveredAt: delivered })], { local: { [id]: { seenAt: NOW } } }).cards[0].startMs).toBe(NOW - 2 * HOUR);
    expect(steps([srow(record, { deliveredAt: delivered })], {}).cards[0].startMs).toBe(NOW - 2 * HOUR);
    // This device had it first (offline before its report landed).
    expect(steps([srow(record, { deliveredAt: delivered })], { local: { [id]: { seenAt: NOW - 3 * HOUR } } }).cards[0].startMs).toBe(NOW - 3 * HOUR);
    // A phone saw it at 10:00, this device opens at 15:00: kept now.
    expect(steps([srow(record, { deliveredAt: new Date(NOW - AUTO_KEEP_MS).toISOString() })], {}).keep.map((k) => k.id)).toEqual([id]);
  });
  it("sharing stopped after delivery: the card stays, with no auto-keep", () => {
    const record = liveRecord();
    const old = new Date(NOW - 20 * HOUR).toISOString();
    for (const editsLive of [false, undefined]) {
      const p = steps([srow(record, { deliveredAt: old, editsLive })]);
      expect(p.keep).toEqual([]);
      expect(p.cards).toMatchObject([{ id: `${SET_ID}.0`, keepsAt: null }]);
    }
  });
  it("limits: the device's own checks fail; no card, nothing seen", () => {
    const record = liveRecord();
    const bad = edit(record, (r) => { r.blocks[0].exercises[0].sets[0].bodyweightUsed = 80; });
    expect(steps([srow(bad)])).toEqual({ seen: [], acks: [{ id: `${SET_ID}.0`, outcome: "limits" }], keep: [], cards: [] });
    expect(steps([srow(record, { after: { record, drum: {}, extra: 1 } })]).acks).toEqual([{ id: `${SET_ID}.0`, outcome: "limits" }]);
    expect(steps([srow(record, { after: null })]).acks).toEqual([{ id: `${SET_ID}.0`, outcome: "limits" }]);
    // Sent three days after its date: outside the window from the send.
    expect(steps([srow(record, { at: NOW + 3 * 24 * HOUR })]).acks).toEqual([{ id: `${SET_ID}.0`, outcome: "limits" }]);
  });
  it("W-E: they logged that letter that day themselves: superseded, nothing written", () => {
    const record = liveRecord();
    const own = { id: `${TODAY}T08:00:00.000Z`, date: TODAY, session: "strength-a", scheduledLetter: "A", blocks: [] };
    expect(steps([srow(record)], { history: [own] })).toEqual({ seen: [], acks: [{ id: `${SET_ID}.0`, outcome: "superseded" }], keep: [], cards: [] });
    const retro = { id: `${TODAY}T12:00:00.000Z`, date: TODAY, session: "strength-a", retrospective: true, blocks: [] };
    expect(steps([srow(record)], { history: [retro] }).acks).toEqual([{ id: `${SET_ID}.0`, outcome: "superseded" }]);
    const otherDay = { ...own, date: ago(1), id: `${ago(1)}T08:00:00.000Z` };
    expect(steps([srow(record)], { history: [otherDay] }).cards).toHaveLength(1);
  });
  it("kept on another of their devices: ack kept, no write", () => {
    const record = liveRecord();
    const id = `${SET_ID}.0`;
    for (const loggedBy of [{ by: "trainer", name: "Sam", changeId: id }, { name: "Sam", accountId: "acc_1" }]) {
      expect(steps([srow(record)], { history: [{ ...record, loggedBy }] })).toEqual({ seen: [], acks: [{ id, outcome: "kept" }], keep: [], cards: [] });
    }
  });
  it("an id that matches anything but this row's own kept record is never read as kept", () => {
    const record = liveRecord();
    const id = `${SET_ID}.0`;
    const ack = (history) => steps([srow(record)], { history }).acks;
    // Their own log of another letter or day under that id: the trainer's record is forged.
    expect(ack([{ ...record, date: ago(1), loggedBy: undefined }])).toEqual([{ id, outcome: "limits" }]);
    expect(ack([{ id: record.id, date: ago(1), session: "strength-b", scheduledLetter: "B", blocks: [] }])).toEqual([{ id, outcome: "limits" }]);
    // That letter that day, but not kept from this row: theirs stands.
    expect(ack([{ ...record }])).toEqual([{ id, outcome: "superseded" }]);
    expect(ack([{ ...record, loggedBy: { by: "trainer", name: "Sam", changeId: `${SET_ID}.1` } }])).toEqual([{ id, outcome: "superseded" }]);
  });
  it("nothing auto-keeps while the client has the record open", () => {
    const record = liveRecord();
    const id = `${SET_ID}.0`;
    const local = { [id]: { seenAt: NOW - AUTO_KEEP_MS - HOUR } };
    const held = steps([srow(record)], { local, holding: [id] });
    expect(held.keep).toEqual([]);
    expect(held.cards).toMatchObject([{ id, keepsAt: NOW - HOUR }]);
    expect(steps([srow(record)], { local, holding: ["other"] }).keep.map((k) => k.id)).toEqual([id]);
  });
  it("leaves alone what this device decided, what it already acked, and every other row", () => {
    const record = liveRecord();
    const id = `${SET_ID}.0`;
    const none = { seen: [], acks: [], keep: [], cards: [] };
    expect(steps([srow(record)], { local: { [id]: { seenAt: NOW - 9 * HOUR, decided: "kept" } } })).toEqual(none);
    expect(steps([srow(record)], { acked: [id] })).toEqual(none);
    expect(steps([srow(record, { undone: true })])).toEqual(none);
    expect(steps([srow(record, { outcome: "discarded" })])).toEqual(none);
    expect(steps([{ ...srow(record), kind: "weight" }, null, { id: 3 }])).toEqual(none);
  });
  it("the plan-change applier never touches a session row", () => {
    const record = liveRecord();
    expect(planDeviceSteps([srow(record)], { meta: {}, history: [], todayIso: TODAY }))
      .toEqual({ weights: {}, reps: {}, mainLifts: {}, weeks: [], acks: [], reverts: [], applied: [] });
  });
});
