// @vitest-environment jsdom
// The client's app applies a trainer's change on the home pull
// (lib/storage.js applyTrainerRows), re-checked against its own latest
// training, through the same stamped setters its own edits use. Spec §4, §11:
// E5 (apply ≡ client edit), E6 (the engine carries on from it), E7 (no rows,
// no change), the home-unmounted guard and ack-after-push.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  P, H, W, TL, BW, TS, getLocalProfile, applyTrainerRows, backgroundSync, enableAutoSync, disableAutoSync,
  flushTrainerOutbox, pushNow, newDraftLog, logSet, finaliseDraft,
} from "@/lib/storage";
import { DeltaSync } from "@/lib/sync-delta";
import { mergeMetaFields, ensureScheduleHistory, scheduleEntryOn } from "@/lib/sync-merge";
import { validateOp, planDeviceSteps, RESET } from "@/lib/trainer-change";
import { resolvedProgramme } from "@/lib/programme-resolve";
import { projectForTrainer } from "@/lib/trainer-plan";
import { CATEGORY_COLD_START_MAX_KG } from "@/lib/lift-translations";
import { cleanAcks } from "@/lib/trainer-changes-store";
import { applySessionToEngine } from "@/lib/session-engine";
import { PROFILE_SUFFIXES } from "@/lib/store-health";
import { WEEK } from "@/lib/programme";
import { addDaysIso } from "@/lib/dates";

const ROOT = join(import.meta.dirname, "..");
const PROFILE = "sam";
const SQUAT = "Barbell Back Squat";
const TODAY = "2026-10-05"; // a Monday
const NOON = new Date(`${TODAY}T12:00:00.000Z`);
const LATER = new Date(`${TODAY}T13:00:00.000Z`);
const SET = "hws_" + "a".repeat(26);
const STAMP = "2026-10-01T10:00:00.000Z";

/** A logged squat session. */
const squat = (date, kg = 100, reps = 5, extra = {}) => ({
  id: `${date}T10:00:00.000Z`, date, schemaVersion: 3, readiness: "fresh", session: "strength-a",
  blocks: [{ type: "main", exercises: [{
    name: SQUAT, loadType: "barbell", prescribed: { weight: kg, reps },
    sets: [1, 2, 3].map(() => ({ weight: kg, reps, rir: 2, loadType: "barbell" })),
  }] }],
  ...extra,
});

/** A profile that trained the squat at 100 × 5, in delta mode with nothing dirty. */
function seed(p = PROFILE) {
  P.add(p);
  P.setActive(p);
  P.saveWeightsRaw(p, { [SQUAT]: 100 }, { [SQUAT]: STAMP });
  P.saveRepsRaw(p, { [SQUAT]: 5 }, { [SQUAT]: STAMP });
  H.save(p, [squat("2026-10-01")]);
  DeltaSync.setCursor(p, "2026-10-01T11:00:00.000Z");
  DeltaSync.commitPushState(p, getLocalProfile(p));
}

/** A row as GET /api/sync delivers it, with the basis the server stores from its own read. */
function rowFor(op, i = 0, over = {}, p = PROFILE) {
  const local = getLocalProfile(p);
  const v = validateOp(op, { meta: local.meta, history: local.history, todayIso: TODAY, phase: "apply" });
  if (!v.change) throw new Error(`fixture refused: ${v.code}`);
  const c = v.change;
  return {
    id: `${SET}.${i}`, set: SET, kind: c.kind, target: c.target, from: c.from, before: c.before, after: c.after,
    basis: c.basis, at: 1_000 + i, appliedAt: null, undone: false, by: "Alex", ...over,
  };
}
const up = () => rowFor({ kind: "weight", lift: SQUAT, kg: 105 });

/** Every key in localStorage, in order. */
function snap() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
function restore(s) {
  localStorage.clear();
  for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
}
const without = (s, ...keys) => Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k)));

let fetchCalls;
/** responder(url, opts) → { status, body } | Promise of one. */
function stubFetch(responder) {
  vi.stubGlobal("fetch", async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(String(opts.body)) : null });
    const { status = 200, body = { ok: true } } = (await responder(String(url), opts)) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
}
const posts = () => fetchCalls.filter((c) => c.url === "/api/sync/trainer");
const puts = () => fetchCalls.filter((c) => c.url === "/api/sync" && c.method === "PUT");
/** The server side of a quiet delta pull, carrying `rows` when given. */
const deltaPull = (rows) => ({ body: { delta: true, meta: {}, history: [], cursor: "2026-10-05T12:00:00.000Z", ...(rows ? { trainer: { rows } } : {}) } });

beforeEach(() => {
  localStorage.clear();
  fetchCalls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOON);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  disableAutoSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── E5: apply ≡ client edit ─────────────────────────────────────────────────

describe("E5: a trainer's change lands exactly as the client's own edit", () => {
  for (const [name, op, edit] of [
    ["weight", { kind: "weight", lift: SQUAT, kg: 105 }, (p) => P.saveWeights(p, { ...P.getWeights(p), [SQUAT]: 105 })],
    ["reps", { kind: "reps", lift: SQUAT, reps: 8 }, (p) => P.saveReps(p, { ...P.getReps(p), [SQUAT]: 8 })],
    ["main lift", { kind: "mainLift", canonical: SQUAT, choice: "Front Squat" }, (p) => P.setMainLift(p, SQUAT, "Front Squat")],
  ]) {
    it(`${name}: the same stores and stamps, and the same pushed delta through THE merge`, async () => {
      seed();
      const start = snap();
      const server = getLocalProfile(PROFILE).meta;
      stubFetch(() => ({}));

      applyTrainerRows(PROFILE, { rows: [rowFor(op)] });
      const viaTrainer = without(snap(), TL.key(PROFILE));
      await pushNow(PROFILE);
      const trainerDelta = puts()[0].body.delta;

      restore(start);
      fetchCalls.length = 0;
      edit(PROFILE);
      const viaClient = snap();
      await pushNow(PROFILE);
      const clientDelta = puts()[0].body.delta;

      // Same instant, so stamps match too: nothing but the device-local record differs.
      expect(viaTrainer).toEqual(viaClient);
      expect(JSON.stringify(trainerDelta)).toBe(JSON.stringify(clientDelta));
      expect(JSON.stringify(mergeMetaFields(server, trainerDelta.meta))).toBe(JSON.stringify(mergeMetaFields(server, clientDelta.meta)));
    });
  }

  it("only the changed key gets a fresh stamp", () => {
    seed();
    P.saveWeightsRaw(PROFILE, { [SQUAT]: 100, "Barbell Bench Press": 80 }, { [SQUAT]: STAMP, "Barbell Bench Press": STAMP });
    applyTrainerRows(PROFILE, { rows: [up()] });
    expect(P.getWeights(PROFILE)).toEqual({ [SQUAT]: 105, "Barbell Bench Press": 80 });
    expect(P.getWeightStamps(PROFILE)).toEqual({ [SQUAT]: NOON.toISOString(), "Barbell Bench Press": STAMP });
  });
});

// ── E6: the engine carries on from the trainer's numbers ────────────────────

/** One session at the stored W and R, finalised the way SessionHost does it. */
function train(p, date, { reps, rir = 2 } = {}) {
  vi.setSystemTime(new Date(`${date}T18:00:00.000Z`));
  const W0 = P.getWeights(p)[SQUAT];
  const R0 = P.getReps(p)[SQUAT];
  const prescribed = { reps: R0, weight: W0, sets: 3 };
  const draft = newDraftLog({ profileName: p, session: "strength-a", blockNumber: 1, readiness: "normal" });
  draft.id = `${date}T18:00:00.000Z`;
  draft.date = date;
  for (let i = 0; i < 3; i++) {
    logSet(draft, {
      blockId: "a1", blockType: "main", exerciseName: SQUAT, muscle: "Quadriceps", loadType: "barbell",
      weight: W0, reps: reps ?? R0, rpe: 10 - rir, prescribed,
    });
  }
  const rec = finaliseDraft(draft);
  H.append(p, rec);
  const out = applySessionToEngine(p, rec, { currentWeights: P.getWeights(p) });
  P.saveWeights(p, { ...P.getWeights(p), ...out.wwUpdates });
  P.saveReps(p, { ...P.getReps(p), ...out.wrUpdates });
  return { rec, out };
}
const prescribedOf = (rec) => rec.blocks.flatMap((b) => b.exercises).find((e) => e.name === SQUAT).prescribed;

describe("E6: the engine continues from the trainer's numbers", () => {
  it("weight: a session at the applied value gives the same next W as at an engine-set one", () => {
    for (const p of ["a", "b"]) {
      P.add(p);
      P.saveWeightsRaw(p, { [SQUAT]: 100 }, { [SQUAT]: STAMP });
      P.saveRepsRaw(p, { [SQUAT]: 5 }, { [SQUAT]: STAMP });
      H.save(p, [squat("2026-09-28"), squat("2026-10-01")]);
    }
    applyTrainerRows("a", { rows: [rowFor({ kind: "weight", lift: SQUAT, kg: 105 }, 0, {}, "a")] });
    P.saveWeights("b", { ...P.getWeights("b"), [SQUAT]: 105 });
    expect(P.getWeights("a")[SQUAT]).toBe(105);
    const a = train("a", "2026-10-06");
    const b = train("b", "2026-10-06");
    expect(prescribedOf(a.rec).weight).toBe(105);
    expect(a.out.wwUpdates).toEqual(b.out.wwUpdates);
    expect(a.out.wrUpdates).toEqual(b.out.wrUpdates);
  });

  it("reps: apply 10, train session 1, and session 2 still prescribes 10", () => {
    seed();
    H.save(PROFILE, []);
    train(PROFILE, "2026-09-24");
    train(PROFILE, "2026-09-28");
    vi.setSystemTime(NOON);
    applyTrainerRows(PROFILE, { rows: [rowFor({ kind: "reps", lift: SQUAT, reps: 10 })] });
    expect(P.getReps(PROFILE)[SQUAT]).toBe(10);
    const one = train(PROFILE, "2026-10-06");
    expect(prescribedOf(one.rec).reps).toBe(10);
    const two = train(PROFILE, "2026-10-09");
    expect(prescribedOf(two.rec).reps).toBe(10);
  });
});

describe("E6: the engine after an unset", () => {
  it("a stored null reads as no weight: the next W and R come out numbers, the same as with the key absent", () => {
    const outs = [];
    for (const [p, unset] of [["u", true], ["v", false]]) {
      P.add(p);
      P.saveWeightsRaw(p, { [SQUAT]: 100 }, { [SQUAT]: STAMP });
      P.saveRepsRaw(p, { [SQUAT]: 5 }, { [SQUAT]: STAMP });
      H.save(p, [squat("2026-09-28"), squat("2026-10-01")]);
      if (unset) { P.unsetWeight(p, SQUAT); P.unsetReps(p, SQUAT); }
      else { P.saveWeightsRaw(p, {}, {}); P.saveRepsRaw(p, {}, {}); }
      const rec = squat("2026-10-06", 100, 5);
      H.append(p, rec);
      // ForgeApp hands the engine the raw map (null kept); SessionHost the reader's.
      for (const current of [P.getWeightsRaw(p), P.getWeights(p)]) {
        const out = applySessionToEngine(p, rec, { currentWeights: current, repairedReps: {} });
        expect(Number.isFinite(out.wwUpdates[SQUAT]), p).toBe(true);
        for (const v of [...Object.values(out.wwUpdates), ...Object.values(out.wrUpdates)]) {
          expect(v === null || Number.isNaN(v), p).toBe(false);
        }
        outs.push(JSON.stringify({ ww: out.wwUpdates, wr: out.wrUpdates }));
        TS.replaceState(p, { lifts: {}, muscleAnchors: {} }, { touch: false });
      }
    }
    expect(new Set(outs).size).toBe(1);
  });
});

// ── Re-checked against the latest training ──────────────────────────────────

describe("applyTrainerRows", () => {
  it("applies a next-session change, marks who set it, and queues the outcome", () => {
    seed();
    const r = up();
    expect(applyTrainerRows(PROFILE, { rows: [r] })).toEqual({ wrote: true, acks: 1, reverts: 0 });
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(105);
    expect(TL.get(PROFILE)).toEqual({
      pending: [],
      marks: { [SQUAT]: { weight: { id: r.id, after: 105, by: "Alex", at: NOON.toISOString() } } },
      outbox: { acks: [{ id: r.id, outcome: "applied", at: NOON.toISOString() }], reverts: [] },
    });
  });

  it("trained since: superseded, not applied", () => {
    seed();
    const r = up();
    H.append(PROFILE, squat("2026-10-04"));
    expect(applyTrainerRows(PROFILE, { rows: [r] })).toEqual({ wrote: false, acks: 1, reverts: 0 });
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
    expect(TL.get(PROFILE).outbox.acks).toEqual([{ id: r.id, outcome: "superseded", at: NOON.toISOString() }]);
    expect(TL.get(PROFILE).marks).toEqual({});
  });

  it("a row this device already decided is not decided again", () => {
    seed();
    const r = up();
    applyTrainerRows(PROFILE, { rows: [r] });
    // The client sets it back before the outcome is reported; the row comes again.
    P.saveWeights(PROFILE, { ...P.getWeights(PROFILE), [SQUAT]: 100 });
    expect(applyTrainerRows(PROFILE, { rows: [r] })).toEqual({ wrote: false, acks: 0, reverts: 0 });
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
    expect(TL.get(PROFILE).outbox.acks).toHaveLength(1);
  });

  it("a write that does not land reports nothing; the next pull decides again", () => {
    seed();
    const r = up();
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (k, v) {
      if (k === `forge:${PROFILE}:weights`) throw new DOMException("full", "QuotaExceededError");
      return real.call(this, k, v);
    });
    stubFetch(() => ({}));
    applyTrainerRows(PROFILE, { rows: [r] });
    expect(TL.get(PROFILE).outbox.acks).toEqual([]);
    expect(TL.get(PROFILE).marks).toEqual({});
    spy.mockRestore();
    applyTrainerRows(PROFILE, { rows: [r] });
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(105);
    expect(TL.get(PROFILE).outbox.acks).toEqual([{ id: r.id, outcome: "applied", at: NOON.toISOString() }]);
  });

  it("an undone change still in force goes back to its old value", () => {
    seed();
    P.saveWeights(PROFILE, { [SQUAT]: 105 });
    const r = { ...up(), before: 100, after: 105, undone: true, appliedAt: "2026-10-04T08:00:00.000Z" };
    applyTrainerRows(PROFILE, { rows: [r] });
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
    expect(TL.get(PROFILE).outbox).toEqual({ acks: [], reverts: [{ id: r.id, at: NOON.toISOString() }] });
  });

  it("an undo of a first weight writes an unset: no stored weight, null with a newer stamp, the revert reported, nothing removed from localStorage", () => {
    seed();
    BW.set(PROFILE, 80);
    const undone = { undone: true, appliedAt: "2026-10-04T08:00:00.000Z" };
    const w = { ...up(), ...undone, before: null, after: 105 };
    P.saveWeights(PROFILE, { [SQUAT]: 105 });
    const trainerStamp = P.getWeightStamps(PROFILE)[SQUAT];
    const mark = { [SQUAT]: { weight: { id: w.id, after: 105, by: "Alex", at: STAMP } } };
    TL.save(PROFILE, { ...TL.get(PROFILE), marks: mark });
    const local = getLocalProfile(PROFILE);
    // The plan asks for a reset; the squat's template weight (55) is not put in its place.
    expect(planDeviceSteps([w], { meta: local.meta, history: local.history, todayIso: TODAY }).weights).toEqual({ [SQUAT]: RESET });
    expect(resolvedProgramme(local.meta).find((l) => l.name === SQUAT).ex.weight).toBe(55);
    const start = snap();
    vi.setSystemTime(LATER);
    expect(applyTrainerRows(PROFILE, { rows: [w] })).toEqual({ wrote: true, acks: 0, reverts: 1 });
    expect(P.getWeights(PROFILE)[SQUAT]).toBeUndefined();
    expect(P.getWeightsRaw(PROFILE)).toEqual({ [SQUAT]: null });
    expect(P.getWeightStamps(PROFILE)[SQUAT]).toBe(LATER.toISOString());
    expect(P.getWeightStamps(PROFILE)[SQUAT] > trainerStamp).toBe(true);
    expect(TL.get(PROFILE).outbox).toEqual({ acks: [], reverts: [{ id: w.id, at: LATER.toISOString() }] });
    // The mark stays; the "Set by" line reads it as no longer in force.
    expect(TL.get(PROFILE).marks).toEqual(mark);
    // Every key still there; only the weights, their stamps and trainerLocal moved.
    const end = snap();
    expect(Object.keys(end)).toEqual(Object.keys(start));
    expect(Object.keys(end).filter((k) => end[k] !== start[k]).sort()).toEqual([
      `forge:${PROFILE}:trainerLocal`, `forge:${PROFILE}:weightStamps`, `forge:${PROFILE}:weights`,
    ]);
  });

  it("an unset at any bodyweight or anchors, and for a lift with no template weight: their plan reads no weight, the same everywhere", () => {
    const outs = [];
    for (const [label, body, anchor, main] of [
      ["none", null, null, null], ["b60", 60, null, null], ["b120", 120, null, null],
      ["a40", 80, 40, null], ["a300", 80, 300, null], ["front", 80, null, "Front Squat"],
    ]) {
      localStorage.clear();
      P.add(PROFILE);
      P.setActive(PROFILE);
      if (body !== null) BW.set(PROFILE, body);
      if (anchor !== null) TS.updateMuscleAnchor(PROFILE, "Quadriceps", { bestE1RM: anchor });
      const lift = main ?? SQUAT;
      const base = rowFor({ kind: "weight", lift: SQUAT, kg: 60 }); // drafted while the squat was their main
      if (main) P.setMainLift(PROFILE, SQUAT, main);
      // Never lifted: the trainer set 60, the client undoes it.
      const row = { ...base, target: lift, before: null, undone: true, appliedAt: "2026-10-04T08:00:00.000Z" };
      P.saveWeights(PROFILE, { [lift]: 60 });
      expect(applyTrainerRows(PROFILE, { rows: [row] }), label).toEqual({ wrote: true, acks: 0, reverts: 1 });
      expect(P.getWeightsRaw(PROFILE), label).toEqual({ [lift]: null });
      const local = getLocalProfile(PROFILE);
      const view = projectForTrainer({ meta: local.meta, history: local.history }, { todayIso: TODAY, edits: { rows: [], used: 0, freeAt: null } });
      const l = view.plan.lifts.find((x) => x.name === lift);
      expect([l.w, l.basis.w], label).toEqual([null, null]);
      if (!main) outs.push(JSON.stringify(view.plan));
    }
    expect(new Set(outs).size).toBe(1);
  });

  it("an unset is no loop: pushed, then reported; a pull before the report lands decides nothing again; once reported, pulls write nothing", async () => {
    seed();
    const undone = { undone: true, appliedAt: "2026-10-04T08:00:00.000Z" };
    const w = { ...up(), ...undone, before: null, after: 105 };
    P.saveWeights(PROFILE, { [SQUAT]: 105 });
    DeltaSync.commitPushState(PROFILE, getLocalProfile(PROFILE));
    vi.setSystemTime(LATER);
    // The server delivers the row until the device reports its revert.
    let reported = false;
    let reportOk = false;
    stubFetch((url) => {
      if (url.startsWith("/api/sync?")) return deltaPull(reported ? undefined : [w]);
      if (url === "/api/sync/trainer") { if (!reportOk) return { status: 503 }; reported = true; }
      return {};
    });
    enableAutoSync(PROFILE, vi.fn());
    const first = await backgroundSync(PROFILE, { applyTrainer: true });
    expect(first.trainer).toMatchObject({ wrote: true, acks: 0, reverts: 1 });
    expect(await first.trainer.delivery).toBe(false);
    // The unset was pushed, with its stamp, before any report.
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.delta.meta).toEqual({ weights: { [SQUAT]: null }, weightStamps: { [SQUAT]: LATER.toISOString() } });
    // The report failed: the next pull carries the row again and it is not decided again.
    const held = without(snap(), "forge:lastSyncAt");
    fetchCalls = [];
    reportOk = true;
    const second = await backgroundSync(PROFILE, { applyTrainer: true });
    expect(second.trainer).toMatchObject({ wrote: false, acks: 0, reverts: 0 });
    expect(await second.trainer.delivery).toBe(true);
    expect(posts().map((c) => c.body.reverts)).toEqual([[{ id: w.id, at: LATER.toISOString() }]]);
    expect(puts()).toHaveLength(0);
    expect(P.getWeightsRaw(PROFILE)).toEqual(JSON.parse(held[`forge:${PROFILE}:weights`]));
    // Reported: the row no longer comes, and nothing moves.
    let after = null;
    for (let pull = 0; pull < 2; pull++) {
      fetchCalls = [];
      const res = await backgroundSync(PROFILE, { applyTrainer: true });
      expect(res.trainer ?? null, `pull ${pull}`).toBeNull();
      expect(fetchCalls.map((c) => c.method), `pull ${pull}`).toEqual(["GET"]);
      if (after) expect(without(snap(), "forge:lastSyncAt"), `pull ${pull}`).toEqual(after);
      after = without(snap(), "forge:lastSyncAt");
    }
    expect(P.getWeights(PROFILE)[SQUAT]).toBeUndefined();
    expect(TL.get(PROFILE).outbox).toEqual({ acks: [], reverts: [] });
  });

  it("an unset and another undone row on the same target: one write, both reported", () => {
    seed();
    const FRONT = "Front Squat";
    const base = up(); // drafted while the squat was still their main
    P.setMainLift(PROFILE, SQUAT, FRONT);
    const undone = { undone: true, appliedAt: "2026-10-04T08:00:00.000Z" };
    const a = { ...base, ...undone, target: FRONT, before: null, after: 60 };
    const b = { ...base, ...undone, id: `${SET}.1`, target: FRONT, before: 60, after: 62.5 };
    P.saveWeights(PROFILE, { ...P.getWeights(PROFILE), [FRONT]: 60 });
    const local = getLocalProfile(PROFILE);
    const plan = planDeviceSteps([a, b], { meta: local.meta, history: local.history, todayIso: TODAY });
    expect(plan.weights).toEqual({ [FRONT]: RESET });
    expect(plan.reverts).toEqual([a.id, b.id]);

    expect(applyTrainerRows(PROFILE, { rows: [a, b] })).toEqual({ wrote: true, acks: 0, reverts: 2 });
    expect(P.getWeights(PROFILE)[FRONT]).toBeUndefined();
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
    expect(TL.get(PROFILE).outbox.reverts).toEqual([{ id: a.id, at: NOON.toISOString() }, { id: b.id, at: NOON.toISOString() }]);
  });

  it("reps undone back to nothing: an unset in the store and the pushed delta, never a reset object", async () => {
    seed();
    P.saveRepsRaw(PROFILE, {}, {});
    DeltaSync.commitPushState(PROFILE, getLocalProfile(PROFILE));
    const r = { ...rowFor({ kind: "reps", lift: SQUAT, reps: 8 }), undone: true, appliedAt: "2026-10-04T08:00:00.000Z", before: null, after: 8 };
    P.saveReps(PROFILE, { [SQUAT]: 8 });
    vi.setSystemTime(LATER);
    stubFetch(() => ({}));
    expect(applyTrainerRows(PROFILE, { rows: [r] })).toEqual({ wrote: true, acks: 0, reverts: 1 });
    expect(P.getReps(PROFILE)).toEqual({});
    expect(P.getRepsRaw(PROFILE)).toEqual({ [SQUAT]: null });
    expect(P.getRepStamps(PROFILE)[SQUAT]).toBe(LATER.toISOString());
    await pushNow(PROFILE);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.delta.meta).toEqual({ reps: { [SQUAT]: null }, repStamps: { [SQUAT]: LATER.toISOString() } });
    for (const c of puts()) expect(JSON.stringify(c.body)).not.toMatch(/"reset"/);
  });

  it("no top set yet: the max the route offers lands, one step over acks limits, at any bodyweight or anchors", () => {
    const BENCH = "Barbell Bench Press";
    const MAX = CATEGORY_COLD_START_MAX_KG.upper_push; // over the bench's template (50)
    const outcomes = [];
    for (const [p, setup] of [
      ["light", (q) => BW.set(q, 60)],
      ["heavy", (q) => BW.set(q, 120)],
      ["weak", (q) => TS.updateMuscleAnchor(q, "Chest", { bestE1RM: 20 })],
      ["strong", (q) => TS.updateMuscleAnchor(q, "Chest", { bestE1RM: 400 })],
    ]) {
      seed(p);
      setup(p);
      const at = { ...rowFor({ kind: "weight", lift: BENCH, kg: MAX }, 0, {}, p) };
      const over = { ...rowFor({ kind: "weight", lift: BENCH, kg: MAX }, 1, {}, p), target: BENCH, after: MAX + 1.25 };
      // Different lifts would race; one at a time, on its own profile.
      const first = applyTrainerRows(p, { rows: [at] });
      const landed = P.getWeights(p)[BENCH];
      P.saveWeights(p, Object.fromEntries(Object.entries(P.getWeights(p)).filter(([k]) => k !== BENCH)));
      const second = applyTrainerRows(p, { rows: [over] });
      outcomes.push(JSON.stringify({ first, landed, second, acks: TL.get(p).outbox.acks.map((a) => a.outcome), marks: Object.keys(TL.get(p).marks) }));
    }
    expect(JSON.parse(outcomes[0])).toEqual({
      first: { wrote: true, acks: 1, reverts: 0 }, landed: MAX,
      second: { wrote: false, acks: 1, reverts: 0 }, acks: ["applied", "limits"], marks: [BENCH],
    });
    for (const o of outcomes) expect(o).toBe(outcomes[0]);
  });

  it("a week lands on its date with the trainer's provenance on the entry", () => {
    seed();
    const week = WEEK.map((d, i) => (i === 3 ? { type: "cardio", label: "Pilates" } : { type: d.type }));
    const r = { ...up(), id: `${SET}.1`, kind: "week", target: "week", from: TODAY, before: WEEK, after: week, basis: { weekEditedAt: null } };
    applyTrainerRows(PROFILE, { rows: [r] });
    const log = W.getHistory(PROFILE);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ effectiveFrom: TODAY, by: "trainer", changeId: r.id, editedAt: NOON.toISOString() });
    expect(scheduleEntryOn(ensureScheduleHistory(log), TODAY).changeId).toBe(r.id);
    expect(W.get(PROFILE)[3]).toMatchObject({ type: "cardio", label: "Pilates" });
    expect(TL.get(PROFILE).outbox.acks).toEqual([{ id: r.id, outcome: "applied", at: NOON.toISOString() }]);
  });

  it("W.save without provenance writes the entry as before", () => {
    seed();
    W.save(WEEK, { effectiveFrom: TODAY, profile: PROFILE });
    expect(Object.keys(W.getHistory(PROFILE)[0]).sort()).toEqual(["editedAt", "effectiveFrom", "week"]);
  });

  it("pending: rows not yet due wait; a pull without the key empties it, once", () => {
    seed();
    const later = up();
    later.from = addDaysIso(TODAY, 3);
    applyTrainerRows(PROFILE, { rows: [later] });
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
    expect(TL.get(PROFILE).pending).toEqual([
      { id: later.id, set: SET, kind: "weight", target: SQUAT, from: later.from, after: 105, by: "Alex", at: later.at },
    ]);
    expect(applyTrainerRows(PROFILE, undefined)).toBeNull();
    expect(TL.get(PROFILE).pending).toEqual([]);
    const after = snap();
    applyTrainerRows(PROFILE, { rows: [] });
    expect(snap()).toEqual(after);
  });

  it("is never read into the sync payload", () => {
    seed();
    TL.save(PROFILE, { pending: [{ id: "marker-not-synced" }], marks: {}, outbox: { acks: [], reverts: [] } });
    expect(JSON.stringify(getLocalProfile(PROFILE))).not.toContain("marker-not-synced");
  });

  it("is registered, so the local profile wipe removes it by name", () => {
    expect(PROFILE_SUFFIXES.has("trainerLocal")).toBe(true);
    expect(TL.key(PROFILE)).toBe(`forge:${PROFILE}:trainerLocal`);
  });
});

// ── E7: no rows, no change ──────────────────────────────────────────────────

describe("E7: a pull with no trainer rows changes nothing and ships nothing extra", () => {
  for (const [name, setup, server] of [
    ["delta pull", () => {}, () => deltaPull(null)],
    ["full pull", () => DeltaSync.clearCursor(PROFILE), () => ({ body: { ...getLocalProfile(PROFILE), cursor: "2026-10-05T12:00:00.000Z" } })],
  ]) {
    it(name, async () => {
      seed();
      setup();
      const start = snap();
      const body = server();
      stubFetch(() => body);
      const plain = await backgroundSync(PROFILE, {});
      const plainLs = snap();
      const plainCalls = [...fetchCalls];

      restore(start);
      fetchCalls.length = 0;
      const cb = vi.fn();
      enableAutoSync(PROFILE, cb);
      const home = await backgroundSync(PROFILE, { onUpdate: cb, applyTrainer: true });
      expect(home).toEqual(plain);
      expect(snap()).toEqual(plainLs);
      expect(fetchCalls).toEqual(plainCalls);
      expect(cb).not.toHaveBeenCalled();
    });
  }
});

// ── Home only, and push before report ───────────────────────────────────────

describe("the home pull", () => {
  it("applies, tells the mounted home, pushes, then reports", async () => {
    seed();
    const r = up();
    stubFetch((url) => (url.startsWith("/api/sync?") ? deltaPull([r]) : {}));
    const cb = vi.fn();
    enableAutoSync(PROFILE, cb);
    const res = await backgroundSync(PROFILE, { onUpdate: cb, applyTrainer: true });
    expect(res.trainer).toMatchObject({ wrote: true, acks: 1 });
    expect(await res.trainer.delivery).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ source: "trainer", meta: { weights: { [SQUAT]: 105 } } });
    const order = fetchCalls.map((c) => `${c.method} ${c.url.split("?")[0]}`);
    expect(order).toEqual(["GET /api/sync", "PUT /api/sync", "POST /api/sync/trainer"]);
    expect(puts()[0].body.delta.meta.weights).toEqual({ [SQUAT]: 105 });
    expect(posts()[0].body).toEqual({ profile: PROFILE, acks: [{ id: r.id, outcome: "applied", at: NOON.toISOString() }], reverts: [] });
    expect(TL.get(PROFILE).outbox).toEqual({ acks: [], reverts: [] });
  });

  it("home unmounted mid-pull: nothing applied", async () => {
    seed();
    const r = up();
    let release;
    stubFetch((url) => (url.startsWith("/api/sync?") ? new Promise((done) => { release = () => done(deltaPull([r])); }) : {}));
    const cb = vi.fn();
    enableAutoSync(PROFILE, cb);
    const pull = backgroundSync(PROFILE, { onUpdate: cb, applyTrainer: true });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    disableAutoSync();
    release();
    const res = await pull;
    expect(res.trainer).toBeUndefined();
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
    expect(localStorage.getItem(TL.key(PROFILE))).toBeNull();
    expect(cb).not.toHaveBeenCalled();
    expect(fetchCalls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("only home callers apply: a pull without the option leaves the rows alone", async () => {
    seed();
    stubFetch((url) => (url.startsWith("/api/sync?") ? deltaPull([up()]) : {}));
    enableAutoSync(PROFILE, vi.fn());
    const res = await backgroundSync(PROFILE, {});
    expect(res.trainer).toBeUndefined();
    expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
    expect(localStorage.getItem(TL.key(PROFILE))).toBeNull();
  });

  it("push failure: no ack sent, outbox holds it; the next pull reports it", async () => {
    seed();
    const r = up();
    let putStatus = 503;
    stubFetch((url, opts) => {
      if (url.startsWith("/api/sync?")) return deltaPull([r]);
      if (opts.method === "PUT") return { status: putStatus, body: {} };
      return {};
    });
    enableAutoSync(PROFILE, vi.fn());
    const first = await backgroundSync(PROFILE, { applyTrainer: true });
    expect(await first.trainer.delivery).toBe(false);
    expect(posts()).toEqual([]);
    expect(TL.get(PROFILE).outbox.acks).toEqual([{ id: r.id, outcome: "applied", at: NOON.toISOString() }]);

    putStatus = 200;
    fetchCalls.length = 0;
    const second = await backgroundSync(PROFILE, { applyTrainer: true });
    expect(second.trainer).toMatchObject({ wrote: false, acks: 0 });
    expect(await second.trainer.delivery).toBe(true);
    expect(puts()[0].body.delta.meta.weights).toEqual({ [SQUAT]: 105 });
    expect(posts()[0].body.acks).toEqual([{ id: r.id, outcome: "applied", at: NOON.toISOString() }]);
    expect(TL.get(PROFILE).outbox.acks).toEqual([]);
  });

  it("a refused report keeps the outbox; entries added meanwhile survive a later success", async () => {
    seed();
    TL.save(PROFILE, { pending: [], marks: {}, outbox: { acks: [{ id: "a.0", outcome: "applied", at: NOON.toISOString() }], reverts: [] } });
    stubFetch(() => ({ status: 404, body: {} }));
    expect(await flushTrainerOutbox(PROFILE)).toBe(false);
    expect(TL.get(PROFILE).outbox.acks).toHaveLength(1);
    fetchCalls.length = 0;
    let added = false;
    stubFetch(() => {
      // A pull queues a revert while the first report is in flight.
      if (!added) {
        added = true;
        const now = TL.get(PROFILE);
        TL.save(PROFILE, { ...now, outbox: { ...now.outbox, reverts: [{ id: "b.0", at: NOON.toISOString() }] } });
      }
      return {};
    });
    expect(await flushTrainerOutbox(PROFILE)).toBe(true);
    expect(posts().map((c) => [c.body.acks.map((a) => a.id), c.body.reverts.map((r) => r.id)])).toEqual([[["a.0"], []], [[], ["b.0"]]]);
    expect(TL.get(PROFILE).outbox).toEqual({ acks: [], reverts: [] });
  });
});

describe("the home pull, against other pushes and a failed persist", () => {
  it("full pull with a push-back on the wire: the plan waits for it, then pushes, then reports", async () => {
    P.add(PROFILE);
    P.setActive(PROFILE);
    P.saveWeightsRaw(PROFILE, { [SQUAT]: 100 }, { [SQUAT]: STAMP });
    P.saveRepsRaw(PROFILE, { [SQUAT]: 5 }, { [SQUAT]: STAMP });
    H.save(PROFILE, [squat("2026-10-01")]);
    const server = getLocalProfile(PROFILE);
    const r = up();
    // An older session the server lacks: the full pull pushes the merge back.
    H.save(PROFILE, [squat("2026-09-20"), squat("2026-10-01")]);
    let release;
    stubFetch((url, opts) => {
      if (url.startsWith("/api/sync?")) return { body: { ...server, cursor: "2026-10-05T11:00:00.000Z", trainer: { rows: [r] } } };
      if (opts.method === "PUT" && !release) return new Promise((done) => { release = () => done({}); });
      return {};
    });
    enableAutoSync(PROFILE, vi.fn());
    const res = await backgroundSync(PROFILE, { applyTrainer: true });
    expect(res.trainer).toMatchObject({ wrote: true, acks: 1 });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await new Promise((done) => setTimeout(done, 20));
    // The push-back still carries the old value and is still open: nothing else goes out.
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.data.meta.weights).toEqual({ [SQUAT]: 100 });
    expect(posts()).toEqual([]);
    release();
    expect(await res.trainer.delivery).toBe(true);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["GET /api/sync", "PUT /api/sync", "PUT /api/sync", "POST /api/sync/trainer"]);
    expect(puts()[1].body.delta.meta.weights).toEqual({ [SQUAT]: 105 });
  });

  for (const path of ["delta", "full"]) {
    it(`${path} pull whose merge did not land: nothing applied, nothing recorded, cursor held`, async () => {
      seed();
      const r = up();
      const cursor = "2026-10-01T11:00:00.000Z";
      if (path === "full") DeltaSync.clearCursor(PROFILE);
      const server = { ...getLocalProfile(PROFILE) };
      const pull = path === "delta"
        ? { body: { delta: true, meta: { weights: { [SQUAT]: 100 }, weightStamps: { [SQUAT]: STAMP } }, history: [], cursor: "2026-10-05T12:00:00.000Z", trainer: { rows: [r] } } }
        : { body: { ...server, cursor: "2026-10-05T12:00:00.000Z", trainer: { rows: [r] } } };
      stubFetch((url) => (url.startsWith("/api/sync?") ? pull : {}));
      // The merge's first weights write fails; anything after it would land.
      let failNext = true;
      const real = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (k, v) {
        if (failNext && k === `forge:${PROFILE}:weights`) { failNext = false; throw new DOMException("full", "QuotaExceededError"); }
        return real.call(this, k, v);
      });
      enableAutoSync(PROFILE, vi.fn());
      const res = await backgroundSync(PROFILE, { applyTrainer: true });
      expect(failNext).toBe(false);
      expect(res.trainer).toBeUndefined();
      expect(P.getWeights(PROFILE)[SQUAT]).toBe(100);
      expect(localStorage.getItem(TL.key(PROFILE))).toBeNull();
      expect(DeltaSync.getCursor(PROFILE)).toBe(path === "delta" ? cursor : null);
      expect(posts()).toEqual([]);
    });
  }

  it("an outbox entry the report route would refuse is never sent and does not hold the rest back", async () => {
    seed();
    const good = { id: `${SET}.0`, outcome: "applied", at: NOON.toISOString() };
    TL.save(PROFILE, { pending: [], marks: {}, outbox: {
      acks: [{ id: "old.0", outcome: "applied", at: 1_000 }, { id: "", outcome: "applied", at: NOON.toISOString() }, { id: "x.0", outcome: "maybe", at: NOON.toISOString() }, good],
      reverts: [{ id: "y.0" }, null],
    } });
    // The route's own check: one bad entry refuses the whole report.
    stubFetch((url, opts) => {
      const body = JSON.parse(String(opts.body));
      return { status: cleanAcks(body.acks, body.reverts) ? 200 : 400, body: {} };
    });
    expect(await flushTrainerOutbox(PROFILE)).toBe(true);
    expect(posts().map((c) => c.body)).toEqual([{ profile: PROFILE, acks: [good], reverts: [] }]);
    expect(TL.get(PROFILE).outbox).toEqual({ acks: [], reverts: [] });
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────

describe("wiring", () => {
  const read = (f) => readFileSync(join(ROOT, f), "utf8");
  it("home's mount pull and the home-only auto-sync pulls apply; nobody else does", () => {
    expect(read("components/ForgeApp.jsx")).toContain("backgroundSync(activeProfile, { onUpdate: onSyncUpdate, applyTrainer: true })");
    expect(read("lib/storage.js").match(/backgroundSync\(_autoSyncProfile, \{ onUpdate: _autoSyncCallback, applyTrainer: true \}\)/g)).toHaveLength(2);
    for (const f of ["components/PerformanceLabView.jsx", "components/sync-cards.jsx", "app/diag-sync/page.jsx"]) {
      expect(read(f), f).not.toContain("applyTrainer");
    }
  });
  it("the applier writes only through the stamped setters", () => {
    const src = read("lib/storage.js");
    const body = src.slice(src.indexOf("export function applyTrainerRows"), src.indexOf("const _tlOutboxSize"));
    expect(body).not.toMatch(/saveWeightsRaw|saveRepsRaw|saveMainLiftsRaw|replaceHistory|LS\.remove|removeItem/);
    expect(body).toContain("P.saveWeights(");
    expect(body).toContain("P.saveReps(");
    expect(body).toContain("P.setMainLift(");
    expect(body).toContain("W.save(");
  });
});
