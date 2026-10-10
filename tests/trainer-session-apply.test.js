// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// A session a trainer ran with the client, on the client's device: what
// arrives on the home pull (lib/storage.js applyTrainerRows, the session rows
// apart), what Keep writes (keepTrainerSession through lib/session-commit.js),
// what Discard writes, and the report (flushTrainerOutbox, then
// POST /api/sync/trainer and its delivered list).
//
// Witnesses (spec §10):
//   W-B  the kept record is the sent record, except felt, provenance and the
//        bodyweight-derived numbers, which equal a live log's;
//   W-C  Keep leaves the stores exactly as the live finish does for the same
//        session (the real SessionHost, run tap by tap);
//   W-E  superseded when they logged that letter that day themselves, at
//        arrival and at Keep;
//   W-F  no undo after Keep;
//   W-H  a kept record behind this device's push watermark still pushes.
// Text queries in the host run, not getByRole: see SessionScreen.surface.test.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

const route = vi.hoisted(() => ({
  ack: vi.fn(), undo: vi.fn(), list: /** @type {any} */ (null), profile: /** @type {any} */ (null),
}));
vi.mock("@/lib/trainer-changes-store", async (io) => ({
  ...(await io()),
  dbAckChanges: route.ack, dbUndoChanges: route.undo,
  dbChangesForClient: vi.fn(async () => route.list),
}));
vi.mock("@/lib/db", async (io) => ({ ...(await io()), dbReadProfile: vi.fn(async () => route.profile) }));
vi.mock("@/lib/trainer-store", async (io) => ({
  ...(await io()), dbClientShare: vi.fn(async () => null), dbTrainerApplication: vi.fn(async () => null),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));
const CLIENT = "hwa_" + "a".repeat(26);
vi.mock("@/lib/auth-server", async (io) => ({
  ...(await io()),
  readTokenData: async (t) => (t === "tok-sam" ? { accountId: CLIENT, scope: "sync", expires: Date.now() + 86_400_000 } : null),
  resolveTokenIdentity: async (d, profile) => (d?.accountId === CLIENT && profile === "sam"
    ? { accountId: CLIENT, storageKey: "sk-sam", handle: "sam", roles: ["lifter"], plan: "free" } : null),
}));

import SessionHost from "../components/SessionHost.jsx";
import {
  P, H, TL, TS, BW, Days, SessionIntent, getLocalProfile, applyTrainerRows, flushTrainerOutbox,
  keepTrainerSession, discardTrainerSession, holdTrainerSession, recordForKeep, feltKey, setSessionCommit,
  newDraftLog, logSet, finaliseDraft, planStartWeight, rpeToRir, enableAutoSync, disableAutoSync, backgroundSync,
} from "../lib/storage.js";
import { DeltaSync } from "../lib/sync-delta.js";
import { commitSessionRecord } from "../lib/session-commit.js";
import { planSessionSteps, isUndoable, changeStatus, AUTO_KEEP_MS, sessionTarget, sessionPreview } from "../lib/trainer-change.js";
import { cleanAcks } from "../lib/trainer-changes-store.js";
import { SESSIONS, EXERCISE_POOLS, applyRotationToSession, applyMainLiftsToSession, applyFocusToSession } from "../lib/programme.js";
import { getLoadType } from "../lib/lift-translations.js";
import { startDeload } from "../lib/progression.js";

const ROOT = join(import.meta.dirname, "..");

// Records stamp the device's zone and local day: pin both.
const ZONE_WAS = process.env.TZ;
process.env.TZ = "Europe/London";
afterAll(() => { if (ZONE_WAS === undefined) delete process.env.TZ; else process.env.TZ = ZONE_WAS; });

const WHO = "sam";
const TODAY = "2026-10-07";
const T0 = Date.parse(`${TODAY}T09:00:00.000Z`);
const HOUR = 3_600_000;
const SET = "hws_" + "s".repeat(26);
const ID = `${SET}.00`;
const SQUAT = "Barbell Back Squat";
const BENCH = "Barbell Bench Press";
const HIP = "45-Degree Hip Extension"; // A's pure bodyweight slot
const LANDMINE = "Landmine Press";
const BASE_W = { [SQUAT]: 100, [BENCH]: 60, "DB Reverse Lunge": 16, "Chest-Supported DB Row": 22, "Standing Calf Raise": 40 };

let fetchCalls = [];
/** responder(url, init) → { status, body } */
function stubFetch(responder = () => ({})) {
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
    const { status = 200, body = { ok: true } } = (await responder(String(url), init)) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  }));
}
const posts = () => fetchCalls.filter((c) => c.url === "/api/sync/trainer");
const puts = () => fetchCalls.filter((c) => c.url === "/api/sync" && c.method === "PUT");

/** The client: W, R, an anchor, a bodyweight, one earlier session; in delta mode with nothing dirty. */
function seedClient({ priorDaysAgo = 2, reps = { [SQUAT]: 5, [BENCH]: 6 } } = {}) {
  vi.setSystemTime(T0 - priorDaysAgo * 86_400_000);
  P.add(WHO);
  P.setActive(WHO);
  P.saveWeights(WHO, BASE_W);
  P.saveReps(WHO, reps);
  TS.updateMuscleAnchor(WHO, "Chest", { bestE1RM: 80, bestE1RMLift: BENCH });
  BW.set(WHO, 78);
  const prior = newDraftLog({ profileName: WHO, session: "strength-b", blockNumber: 1, readiness: "normal" });
  logSet(prior, { blockId: "b1", blockType: "main", exerciseName: SQUAT, muscle: "Quadriceps", weight: 97.5, reps: 5, rpe: 8, loadType: "barbell", prescribed: { reps: 5, weight: 97.5, sets: 3 } });
  H.append(WHO, finaliseDraft(prior));
  DeltaSync.setCursor(WHO, new Date(T0 - priorDaysAgo * 86_400_000).toISOString());
  DeltaSync.commitPushState(WHO, getLocalProfile(WHO));
  vi.setSystemTime(T0);
}

/**
 * A record as a live host builds it, through the real newDraftLog, logSet and
 * finaliseDraft: Strength A/B/C composed as the client's programme stands,
 * each slot at its plan start weight. `bodyweight` and `profileName` are the
 * device's (the trainer's has neither). Built at a fixed clock, so two builds
 * of the same sets are the same record but for those two.
 */
function liveLog({ idx = 0, bodyweight = null, profileName = null, rpe = (si) => 7 + si * 0.5, startedAt = T0, finishedAt = T0 + HOUR } = {}) {
  const at = Date.now();
  vi.setSystemTime(startedAt);
  const s = applyFocusToSession(applyMainLiftsToSession(applyRotationToSession(SESSIONS[idx], {}), {}), "Forged", {}, {});
  const draft = newDraftLog({ profileName, session: ["strength-a", "strength-b", "strength-c"][idx], blockNumber: 1, readiness: "normal" });
  for (const b of s.blocks) {
    for (const [k, suffix] of [["ex", ""], ["exA", "-A"], ["exB", "-B"]]) {
      const ex = b[k];
      if (!ex) continue;
      const loadType = getLoadType(ex);
      const weight = loadType === "bodyweight" ? null : planStartWeight(ex, { working: BASE_W, bodyweight: null, anchors: {} });
      for (let si = 0; si < b.sets; si++) {
        logSet(draft, {
          blockId: b.id, blockType: b.type, exerciseName: ex.name, muscle: ex.muscle, swapped: false,
          fromPool: EXERCISE_POOLS[`${b.id}${suffix}`] ? `${b.id}${suffix}` : null, loadType, bodyweight, weight, reps: ex.reps,
          rpe: b.type === "main" ? rpe(si) : null, prescribed: { reps: ex.reps, weight, sets: b.sets },
        });
      }
    }
  }
  vi.setSystemTime(finishedAt);
  const rec = JSON.parse(JSON.stringify(finaliseDraft(draft)));
  vi.setSystemTime(at);
  return rec;
}

/** A session row as GET /api/sync delivers it (lib/trainer-changes-store.js dbOpenChangesFor). */
const sessionRow = (record, over = {}) => ({
  id: ID, set: SET, kind: "session", target: sessionTarget(record), from: record.date, before: null,
  after: { record, drum: {} }, basis: null, at: T0, appliedAt: null, undone: false, by: "Alex",
  deliveredAt: null, editsLive: true, ...over,
});

const strip = ({ loggedAt, loggedBy, ...rest }) => rest;
const stored = (key) => localStorage.getItem(`forge:${WHO}:${key}`);
function snap() {
  const out = {};
  for (const k of Object.keys(localStorage).sort()) out[k] = localStorage.getItem(k);
  return out;
}

beforeEach(() => {
  localStorage.clear();
  fetchCalls = [];
  stubFetch();
  holdTrainerSession(null);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  disableAutoSync();
  holdTrainerSession(null);
  setSessionCommit(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── W-B: kept = sent ────────────────────────────────────────────────────────

// Every leaf of a record, by path with indices folded, and what may differ
// between the sent record and the kept one. A path not listed fails the
// test until it is classified.
const SAME = "same", PROV = "provenance", FELT = "felt", DERIVED = "bodyweight", SUMMARY = "summary";
const FIELDS = {
  id: SAME, date: SAME, dow: SAME, profileName: PROV, schemaVersion: SAME, loggedTz: SAME, loggedTzOffset: SAME,
  session: SAME, blockNumber: SAME, weekStart: SAME, scheduledLetter: SAME, mesocyclePhase: SAME,
  readiness: SAME, readinessReason: SAME, bodyweight: SAME, hoursSlept: SAME, daysSinceLast: SAME, duration: SAME,
  "blocks[].id": SAME, "blocks[].type": SAME, "blocks[].intent": SAME,
  "blocks[].exercises[].name": SAME, "blocks[].exercises[].muscle": SAME, "blocks[].exercises[].loadType": SAME,
  "blocks[].exercises[].swapped": SAME, "blocks[].exercises[].fromPool": SAME, "blocks[].exercises[].tempo": SAME,
  "blocks[].exercises[].prescribed.reps": SAME, "blocks[].exercises[].prescribed.weight": SAME, "blocks[].exercises[].prescribed.sets": SAME,
  "blocks[].exercises[].sets[].weight": SAME, "blocks[].exercises[].sets[].reps": SAME, "blocks[].exercises[].sets[].loadType": SAME,
  "blocks[].exercises[].sets[].reach": SAME,
  "blocks[].exercises[].sets[].rpe": FELT, "blocks[].exercises[].sets[].rir": FELT,
  "blocks[].exercises[].sets[].bodyweightUsed": DERIVED, "blocks[].exercises[].sets[].effectiveLoad": DERIVED,
  "blocks[].exercises[].sets[].est1rm": DERIVED, "blocks[].exercises[].sets[].volume": DERIVED,
  "blocks[].exercises[].summary.totalVolume": SUMMARY, "blocks[].exercises[].summary.avgRir": SUMMARY,
  "blocks[].exercises[].summary.topSet": SUMMARY, "blocks[].exercises[].summary.topSet.weight": SUMMARY,
  "blocks[].exercises[].summary.topSet.reps": SUMMARY, "blocks[].exercises[].summary.topSet.rir": SUMMARY,
  "blocks[].exercises[].summary.topSet.rpe": SUMMARY, "blocks[].exercises[].summary.topSet.est1rm": SUMMARY,
  "blocks[].exercises[].summary.hitTarget": SUMMARY,
  "summary.totalVolume": SUMMARY, "summary.avgRir": SUMMARY, "summary.completionRate": SUMMARY, "summary.mainLiftPRs": SUMMARY,
  loggedAt: PROV, "loggedBy.name": PROV, "loggedBy.accountId": PROV,
};
function leaves(v, path = "", out = new Map()) {
  if (v !== null && typeof v === "object") {
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    if (!entries.length) out.set(path, JSON.stringify(v));
    for (const [k, x] of entries) leaves(x, path === "" ? String(k) : `${path}.${k}`, out);
  } else out.set(path, v);
  return out;
}
const fold = (p) => p.replace(/\.(\d+)(?=\.|$)/g, "[]").replace(/^(\w+)\[\]/, "$1[]");
/** Leaf paths that differ between two records, each with its class. */
function diff(a, b) {
  const A = leaves(JSON.parse(JSON.stringify(a))), B = leaves(JSON.parse(JSON.stringify(b)));
  const paths = new Set([...A.keys(), ...B.keys()]);
  for (const p of paths) expect(FIELDS[fold(p)], `unclassified field ${p}`).toBeDefined();
  return [...paths].filter((p) => A.has(p) !== B.has(p) || !Object.is(A.get(p), B.get(p))).map((p) => ({ path: p, kind: FIELDS[fold(p)] }));
}
const kinds = (d) => [...new Set(d.map((x) => x.kind))].sort();
const keepOpts = (over = {}) => ({ felt: {}, bodyweight: null, profile: WHO, by: { name: "Alex", accountId: "hwa_trainer" }, nowIso: "2026-10-07T15:00:00.000Z", ...over });

describe("W-B: the kept record is the sent record", () => {
  for (const idx of [0, 1, 2]) {
    it(`Strength ${"ABC"[idx]}: no felt edit, no bodyweight → only profileName, loggedAt and loggedBy differ`, () => {
      const sent = liveLog({ idx });
      const kept = recordForKeep(sent, keepOpts());
      expect(kinds(diff(sent, kept))).toEqual([PROV]);
      expect(diff(sent, kept).map((d) => d.path).sort()).toEqual(["loggedAt", "loggedBy.accountId", "loggedBy.name", "profileName"]);
      expect(kept.loggedBy).toEqual({ name: "Alex", accountId: "hwa_trainer" });
      expect(kept.loggedAt).toBe("2026-10-07T15:00:00.000Z");
      expect(kept.profileName).toBe(WHO);
      // The input is never touched.
      expect(sent.profileName).toBeNull();
      expect(sent).not.toHaveProperty("loggedBy");
    });
  }

  it("felt edits change only those sets' rpe and rir, and the summaries", () => {
    const sent = liveLog();
    const felt = { [feltKey(0, 0, 1)]: 9.5, [feltKey(1, 0, 2)]: 6, [feltKey(0, 0, 0)]: 11, [feltKey(9, 9, 9)]: 8 };
    const kept = recordForKeep(sent, keepOpts({ felt }));
    const d = diff(sent, kept);
    expect(kinds(d)).toEqual([FELT, PROV, SUMMARY]);
    expect(d.filter((x) => x.kind === FELT).map((x) => x.path).sort()).toEqual([
      "blocks.0.exercises.0.sets.1.rir", "blocks.0.exercises.0.sets.1.rpe", "blocks.1.exercises.0.sets.2.rir", "blocks.1.exercises.0.sets.2.rpe",
    ]);
    expect(kept.blocks[0].exercises[0].sets[1]).toMatchObject({ rpe: 9.5, rir: rpeToRir(9.5) });
    expect(kept.blocks[1].exercises[0].sets[2]).toMatchObject({ rpe: 6, rir: rpeToRir(6) });
    // Off the track (11) and off the record (9.9.9): ignored.
    expect(kept.blocks[0].exercises[0].sets[0].rpe).toBe(sent.blocks[0].exercises[0].sets[0].rpe);
    // The summaries are what a live finish computes for those sets.
    const twin = liveLog({ rpe: (si) => (si === 1 ? 9.5 : 7 + si * 0.5) });
    expect(kept.blocks[0].exercises[0].summary).toEqual(twin.blocks[0].exercises[0].summary);
    expect(feltKey(1, 2, 3)).toBe("1.2.3");
  });

  it("with their bodyweight, the derived numbers are exactly a live log's with that bodyweight (O1)", () => {
    for (const idx of [0, 1, 2]) {
      const sent = liveLog({ idx });
      const kept = recordForKeep(sent, keepOpts({ bodyweight: 78 }));
      expect(kinds(diff(sent, kept))).toEqual(expect.arrayContaining([PROV, DERIVED]));
      expect(kinds(diff(sent, kept)).every((k) => [PROV, DERIVED, SUMMARY].includes(k))).toBe(true);
      // Byte for byte the record the client's own device logs for the same sets.
      const live = liveLog({ idx, bodyweight: 78, profileName: WHO });
      expect(JSON.stringify(strip(kept))).toBe(JSON.stringify(live));
    }
    // A pure bodyweight lift arrives with no load numbers and is kept with them.
    const sent = liveLog();
    const hip = (r) => r.blocks.flatMap((b) => b.exercises).find((e) => e.name === HIP);
    expect(hip(sent).sets[0]).toMatchObject({ bodyweightUsed: null, effectiveLoad: null, volume: 0 });
    expect(hip(recordForKeep(sent, keepOpts({ bodyweight: 78 }))).sets[0]).toMatchObject({ bodyweightUsed: 78, effectiveLoad: 78, volume: 78 * 15 });
  });
});

// ── Arrival on the home pull ────────────────────────────────────────────────

describe("a session arrives on the home pull", () => {
  it("first sight: noted and reported delivered, a card waits, their training untouched", () => {
    seedClient();
    const before = snap();
    const record = liveLog();
    const res = applyTrainerRows(WHO, { rows: [sessionRow(record)] });
    expect(res).toEqual({ wrote: false, acks: 0, reverts: 0, sessions: { seen: 1, acks: 0, cards: 1, due: [], changed: true } });
    const tl = TL.get(WHO);
    expect(tl.sessions).toEqual({ [ID]: { seenAt: T0 } });
    expect(tl.outbox).toEqual({ acks: [], reverts: [], delivered: [{ id: ID, at: new Date(T0).toISOString() }] });
    expect(tl.pendingSessions).toEqual([{
      id: ID, record, drum: {}, by: "Alex", startMs: T0, keepsAt: T0 + AUTO_KEEP_MS,
      set: SET, at: T0, deliveredAt: null, editsLive: true, authorId: null,
    }]);
    // Only trainerLocal moved.
    const after = snap();
    expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([TL.key(WHO)]);
    // A second pull of the same row: nothing new.
    vi.setSystemTime(T0 + HOUR);
    expect(applyTrainerRows(WHO, { rows: [sessionRow(record, { deliveredAt: new Date(T0).toISOString() })] }).sessions)
      .toMatchObject({ seen: 0, cards: 1, due: [] });
    expect(TL.get(WHO).outbox.delivered).toEqual([{ id: ID, at: new Date(T0).toISOString() }]);
  });

  it("the plan rows still go through their own applier, and a profile with no session keeps its old shape", () => {
    seedClient();
    applyTrainerRows(WHO, { rows: [sessionRow(liveLog())] });
    // The pull that no longer serves it (decided elsewhere, or withdrawn before it arrived): the card goes.
    expect(applyTrainerRows(WHO, null)).toMatchObject({ sessions: { changed: true } });
    expect(TL.get(WHO).pendingSessions).toEqual([]);
    expect(applyTrainerRows(WHO, null)).toBeNull();
    localStorage.clear();
    seedClient();
    expect(applyTrainerRows(WHO, null)).toBeNull();
    expect(localStorage.getItem(TL.key(WHO))).toBeNull();
  });

  it("the home pull keeps it five hours after it first reached any of their devices, and not a moment before", async () => {
    seedClient();
    const record = liveLog();
    const delivered = new Date(T0 - 2 * HOUR).toISOString(); // their other phone, two hours ago
    const rows = [sessionRow(record, { deliveredAt: delivered })];
    stubFetch((url) => (url.startsWith("/api/sync?") ? { body: { delta: true, meta: {}, history: [], cursor: "2026-10-07T10:00:00.000Z", trainer: { rows } } } : {}));
    const cb = vi.fn();
    enableAutoSync(WHO, cb);
    vi.setSystemTime(T0 + 3 * HOUR - 1);
    let res = await backgroundSync(WHO, { onUpdate: cb, applyTrainer: true });
    expect(await res.trainer.delivery).toBe(true);
    expect(res.trainer.sessions).toMatchObject({ seen: 1, cards: 1, due: [] });
    expect(H.get(WHO)).toHaveLength(1);
    expect(TL.get(WHO).pendingSessions[0].keepsAt).toBe(T0 + 3 * HOUR);
    vi.setSystemTime(T0 + 3 * HOUR);
    fetchCalls = [];
    cb.mockClear();
    res = await backgroundSync(WHO, { onUpdate: cb, applyTrainer: true });
    expect(res.trainer.sessions).toMatchObject({ due: [ID] });
    expect(await res.trainer.delivery).toBe(true);
    expect(H.get(WHO).map((r) => r.id)).toContain(record.id);
    expect(TL.get(WHO).sessions[ID].decided).toBe("auto_kept");
    expect(TL.get(WHO).pendingSessions).toEqual([]);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["GET /api/sync", "PUT /api/sync", "POST /api/sync/trainer"]);
    expect(posts()[0].body.acks).toEqual([{ id: ID, outcome: "auto_kept", at: new Date(T0 + 3 * HOUR).toISOString() }]);
    expect(TL.get(WHO).outbox).toEqual({ acks: [], reverts: [] });
    // Home hears of it once it landed.
    expect(cb.mock.calls.at(-1)[0]).toMatchObject({ source: "trainer" });
    expect(cb.mock.calls.at(-1)[0].history.map((r) => r.id)).toContain(record.id);
  });

  it("never before it arrived: no delivered mark and no local sight, however long since the send", () => {
    seedClient();
    const record = liveLog();
    vi.setSystemTime(T0 + 40 * HOUR);
    applyTrainerRows(WHO, { rows: [sessionRow(record, { at: T0 - 20 * HOUR })] });
    expect(H.get(WHO)).toHaveLength(1);
    expect(TL.get(WHO).pendingSessions[0].keepsAt).toBe(T0 + 45 * HOUR);
  });

  it("sharing stopped after it arrived: the card stays, never kept by itself", async () => {
    seedClient();
    const record = liveLog();
    const delivered = new Date(T0 - 20 * HOUR).toISOString();
    applyTrainerRows(WHO, { rows: [sessionRow(record, { deliveredAt: delivered, editsLive: false })] });
    expect(H.get(WHO)).toHaveLength(1);
    expect(TL.get(WHO).pendingSessions).toMatchObject([{ id: ID, keepsAt: null }]);
    enableAutoSync(WHO, vi.fn());
    expect((await keepTrainerSession(WHO, ID, { auto: true })).kept).toBe(false);
    expect(H.get(WHO)).toHaveLength(1);
    // The client can still keep it.
    expect((await keepTrainerSession(WHO, ID)).outcome).toBe("kept");
  });

  it("open on their screen, or off Home: never kept by itself", async () => {
    seedClient();
    const record = liveLog();
    const delivered = new Date(T0 - 6 * HOUR).toISOString();
    holdTrainerSession(ID);
    applyTrainerRows(WHO, { rows: [sessionRow(record, { deliveredAt: delivered })] });
    expect(TL.get(WHO).pendingSessions).toMatchObject([{ id: ID }]);
    enableAutoSync(WHO, vi.fn());
    expect(await keepTrainerSession(WHO, ID, { auto: true })).toMatchObject({ kept: false, reason: "not_due" });
    holdTrainerSession(null);
    // Off Home (a live session may be mounted): an auto-keep waits.
    disableAutoSync();
    expect(await keepTrainerSession(WHO, ID, { auto: true })).toMatchObject({ kept: false, reason: "away" });
    expect(H.get(WHO)).toHaveLength(1);
    enableAutoSync(WHO, vi.fn());
    expect((await keepTrainerSession(WHO, ID, { auto: true })).outcome).toBe("auto_kept");
  });

  it("W-E: they logged that letter that day themselves: superseded, nothing written, no card", () => {
    seedClient();
    const record = liveLog();
    for (const own of [
      { ...liveLog({ profileName: WHO, startedAt: T0 - 2 * HOUR, finishedAt: T0 - HOUR }), id: "2026-10-07T07:00:00.000Z" },
      { id: "2026-10-07T18:00:00.000Z", date: TODAY, session: "strength-a", retrospective: true, loggedAt: "2026-10-07T18:00:00.000Z", blocks: [] },
    ]) {
      localStorage.clear();
      seedClient();
      H.append(WHO, own);
      const before = snap();
      expect(applyTrainerRows(WHO, { rows: [sessionRow(record)] })).toMatchObject({ wrote: false, acks: 1, sessions: { cards: 0 } });
      expect(TL.get(WHO).outbox.acks).toEqual([{ id: ID, outcome: "superseded", at: new Date(T0).toISOString() }]);
      expect(TL.get(WHO).pendingSessions).toEqual([]);
      const after = snap();
      expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([TL.key(WHO)]);
    }
  });

  it("W-E: the same check at Keep, after they logged it themselves while it waited", async () => {
    seedClient();
    const record = liveLog();
    applyTrainerRows(WHO, { rows: [sessionRow(record)] });
    H.append(WHO, { ...liveLog({ profileName: WHO }), id: "2026-10-07T11:00:00.000Z" });
    const before = snap();
    const res = await keepTrainerSession(WHO, ID);
    expect(res).toMatchObject({ kept: false, outcome: "superseded", reason: "superseded" });
    const after = snap();
    expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([TL.key(WHO)]);
    expect(TL.get(WHO).outbox.acks.map((a) => a.outcome)).toEqual(["superseded"]);
    expect(H.get(WHO).some((r) => r.id === record.id)).toBe(false);
  });

  it("kept on their other device already: reported kept, nothing written", () => {
    seedClient();
    const record = liveLog();
    H.append(WHO, recordForKeep(record, keepOpts()));
    const before = snap();
    applyTrainerRows(WHO, { rows: [sessionRow(record)] });
    expect(TL.get(WHO).outbox.acks.map((a) => a.outcome)).toEqual(["kept"]);
    const after = snap();
    expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([TL.key(WHO)]);
  });

  it("only home applies: a pull with home unmounted leaves the rows alone", async () => {
    seedClient();
    stubFetch((url) => (url.startsWith("/api/sync?") ? { body: { delta: true, meta: {}, history: [], cursor: "2026-10-07T10:00:00.000Z", trainer: { rows: [sessionRow(liveLog())] } } } : {}));
    const res = await backgroundSync(WHO, { applyTrainer: true });
    expect(res.trainer).toBeUndefined();
    expect(localStorage.getItem(TL.key(WHO))).toBeNull();
  });
});

// ── Keep and Discard ────────────────────────────────────────────────────────

describe("Keep and Discard", () => {
  it("the account the pull names on the row is the one loggedBy keeps, beside the name", async () => {
    seedClient();
    const record = liveLog();
    applyTrainerRows(WHO, { rows: [sessionRow(record, { authorId: "hwa_trainerAlex0000000000" })] });
    expect(TL.get(WHO).pendingSessions[0].authorId).toBe("hwa_trainerAlex0000000000");
    vi.setSystemTime(T0 + HOUR);
    expect(await keepTrainerSession(WHO, ID)).toMatchObject({ kept: true, outcome: "kept" });
    expect(H.get(WHO).find((r) => r.id === record.id).loggedBy).toEqual({ name: "Alex", accountId: "hwa_trainerAlex0000000000" });
  });

  it("Keep writes history, the day, the engine, then W/R; then pushes, then reports", async () => {
    seedClient();
    const record = liveLog();
    applyTrainerRows(WHO, { rows: [sessionRow(record, { after: { record, drum: { [SQUAT]: 102.5 } } })] });
    TL.save(WHO, { ...TL.get(WHO), sessions: { [ID]: { ...TL.get(WHO).sessions[ID], felt: { [feltKey(0, 0, 2)]: 9 } } } });
    vi.setSystemTime(T0 + HOUR);
    const res = await keepTrainerSession(WHO, ID);
    expect(res).toMatchObject({ kept: true, outcome: "kept", reason: null });
    const kept = H.get(WHO).find((r) => r.id === record.id);
    expect(kept.loggedBy).toEqual({ name: "Alex", accountId: null });
    expect(kept.loggedAt).toBe(new Date(T0 + HOUR).toISOString());
    expect(kept.blocks[0].exercises[0].sets[2]).toMatchObject({ rpe: 9, rir: 1 });
    expect(kept.blocks[0].exercises[0].sets[0].bodyweightUsed).toBe(78);
    expect(Days.get(WHO, TODAY)).toMatchObject({ completedType: "strength", sessionId: record.id });
    expect(TS.get(WHO).lifts[SQUAT]).toBeTruthy();
    expect(P.getStreak(WHO).lastDate).toBe(TODAY);
    expect(TL.get(WHO).pendingSessions).toEqual([]);
    expect(TL.get(WHO).sessions[ID].decided).toBe("kept");
    expect(await res.delivery).toBe(true);
    expect(fetchCalls.map((c) => `${c.method} ${c.url}`)).toEqual(["PUT /api/sync", "POST /api/sync/trainer"]);
    expect(puts()[0].body.delta.history.map((r) => r.id)).toEqual([record.id]);
    expect(posts()[0].body).toEqual({
      profile: WHO, acks: [{ id: ID, outcome: "kept", at: new Date(T0 + HOUR).toISOString() }], reverts: [],
      delivered: [{ id: ID, at: new Date(T0).toISOString() }],
    });
    expect(TL.get(WHO).outbox).toEqual({ acks: [], reverts: [] });
    // Final: a second keep, or a discard, does nothing.
    expect((await keepTrainerSession(WHO, ID)).kept).toBe(false);
    expect(discardTrainerSession(WHO, ID).discarded).toBe(false);
    expect(H.get(WHO).filter((r) => r.id === record.id)).toHaveLength(1);
  });

  it("the felt edits held on the device are used when Keep passes none, and Keep's own win", async () => {
    seedClient();
    const record = liveLog();
    applyTrainerRows(WHO, { rows: [sessionRow(record)] });
    TL.save(WHO, { ...TL.get(WHO), sessions: { [ID]: { ...TL.get(WHO).sessions[ID], felt: { [feltKey(0, 0, 0)]: 10 } } } });
    await keepTrainerSession(WHO, ID, { felt: { [feltKey(0, 0, 0)]: 6.5 } });
    expect(H.get(WHO).find((r) => r.id === record.id).blocks[0].exercises[0].sets[0].rpe).toBe(6.5);
  });

  it("a yesterday record dates its day, never bumps today's streak, and stays behind newer evidence", async () => {
    seedClient();
    // They trained the squat this morning, on their own.
    H.append(WHO, { ...liveLog({ profileName: WHO, startedAt: T0 - HOUR, finishedAt: T0 - HOUR / 2 }), id: "2026-10-07T08:00:00.000Z" });
    const squatBefore = JSON.stringify(TS.get(WHO).lifts[SQUAT] ?? null);
    const streakBefore = stored("streak");
    const record = liveLog({ startedAt: T0 - 86_400_000, finishedAt: T0 - 86_400_000 + HOUR });
    expect(record.date).toBe("2026-10-06");
    applyTrainerRows(WHO, { rows: [sessionRow(record, { at: T0 - 20 * HOUR })] });
    expect((await keepTrainerSession(WHO, ID)).outcome).toBe("kept");
    expect(Days.get(WHO, "2026-10-06")).toMatchObject({ completedType: "strength", sessionId: record.id });
    expect(stored("streak")).toBe(streakBefore);
    expect(JSON.stringify(TS.get(WHO).lifts[SQUAT] ?? null)).toBe(squatBefore);
  });

  it("Not mine: only trainerLocal moves, and the refusal is reported", async () => {
    seedClient();
    applyTrainerRows(WHO, { rows: [sessionRow(liveLog())] });
    const before = snap();
    const res = discardTrainerSession(WHO, ID);
    expect(res.discarded).toBe(true);
    const after = snap();
    expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([TL.key(WHO)]);
    expect(TL.get(WHO).pendingSessions).toEqual([]);
    expect(TL.get(WHO).sessions[ID].decided).toBe("discarded");
    expect(await res.delivery).toBe(true);
    expect(posts()[0].body.acks).toEqual([{ id: ID, outcome: "discarded", at: new Date(T0).toISOString() }]);
    expect((await keepTrainerSession(WHO, ID)).kept).toBe(false);
  });

  it("an auto_kept the server refuses as never delivered goes again behind its arrival; any other refusal waits", async () => {
    seedClient();
    const autoKept = { id: ID, outcome: "auto_kept", at: new Date(T0 + 5 * HOUR).toISOString() };
    TL.save(WHO, { pending: [], marks: {}, sessions: { [ID]: { seenAt: T0, decided: "auto_kept" } }, outbox: { acks: [autoKept], reverts: [] } });
    stubFetch(() => ({ status: 503, body: {} }));
    expect(await flushTrainerOutbox(WHO)).toBe(false);
    expect(TL.get(WHO).outbox.acks).toHaveLength(1);
    stubFetch(() => ({ status: 400, body: { error: "Bad report" } }));
    expect(await flushTrainerOutbox(WHO)).toBe(false);
    expect(TL.get(WHO).outbox.acks).toHaveLength(1);
    // Its arrival did not ride the report: refused, then sent again with the
    // arrival from first sight, and it lands.
    fetchCalls = [];
    let n = 0;
    stubFetch(() => (n++ === 0 ? { status: 400, body: { error: "Bad report", undelivered: [ID] } } : { body: { ok: true } }));
    expect(await flushTrainerOutbox(WHO)).toBe(true);
    expect(posts().map((c) => c.body)).toEqual([
      { profile: WHO, acks: [autoKept], reverts: [] },
      { profile: WHO, acks: [autoKept], reverts: [], delivered: [{ id: ID, at: new Date(T0).toISOString() }] },
    ]);
    expect(TL.get(WHO).outbox).toEqual({ acks: [], reverts: [] });
    // Refused although its arrival rode with it: it can never land, and leaves.
    TL.save(WHO, { ...TL.get(WHO), outbox: { acks: [autoKept], reverts: [], delivered: [{ id: ID, at: new Date(T0).toISOString() }] } });
    fetchCalls = [];
    stubFetch(() => ({ status: 400, body: { error: "Bad report", undelivered: [ID] } }));
    expect(await flushTrainerOutbox(WHO)).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(TL.get(WHO).outbox).toEqual({ acks: [], reverts: [] });
  });

  it("with the app's commit handed in, Keep fetches nothing: it has written before its first wait", async () => {
    seedClient();
    const record = liveLog();
    applyTrainerRows(WHO, { rows: [sessionRow(record)] });
    const commit = vi.fn(commitSessionRecord);
    setSessionCommit(commit);
    const pending = keepTrainerSession(WHO, ID);
    // Synchronously, before anything could load: the record and its day are written.
    expect(H.get(WHO).some((r) => r.id === record.id)).toBe(true);
    expect(Days.get(WHO, TODAY)).toMatchObject({ sessionId: record.id });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toBe(WHO);
    expect((await pending).outcome).toBe("kept");
  });
});

// ── W-F: no undo after Keep ─────────────────────────────────────────────────

/** Each top-level declaration's text in a module, by name. */
function declarations(src) {
  const out = {};
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm;
  let m;
  const starts = [];
  while ((m = re.exec(src))) starts.push({ name: m[1] ?? m[2], at: m.index });
  starts.forEach((s, i) => { out[s.name] = src.slice(s.at, starts[i + 1]?.at ?? src.length); });
  return out;
}

describe("W-F: no undo after Keep", () => {
  it("nothing on the device takes a history record out or rewrites it by its change", () => {
    const storage = readFileSync(join(ROOT, "lib/storage.js"), "utf8");
    const decl = declarations(storage);
    const writesHistory = Object.entries(decl).filter(([, text]) => /\bH\.save\(|LS\.set\(`[^`]*:history`/.test(text.replace(/^\s*(\/\/|\*).*$/gm, "")));
    // History is written in two places only: the append (dedupe by id, never a removal) and THE merge's persist.
    expect(writesHistory.map(([n]) => n).sort()).toEqual(["H", "persistToLocal"]);
    for (const [name, text] of writesHistory) expect(text, name).not.toMatch(/changeId|loggedBy|\.filter\(/);
    // The session commit only appends.
    const commit = readFileSync(join(ROOT, "lib/session-commit.js"), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    expect(commit).not.toMatch(/H\.save|removeItem|LS\.remove|\.splice\(/);
    // The plan module writes nothing at all.
    expect(readFileSync(join(ROOT, "lib/trainer-change.js"), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")).not.toMatch(/localStorage|H\.save|LS\./);
    // The server refuses to undo a session (dbUndoChanges' WHERE).
    const store = declarations(readFileSync(join(ROOT, "lib/trainer-changes-store.js"), "utf8"));
    expect(store.dbUndoChanges).toMatch(/AND kind <> 'session'/);
  });

  it("a kept session is never undoable, and the route will not undo one", async () => {
    const row = { id: ID, set: SET, kind: "session", target: `${TODAY}:A`, from: TODAY, before: null, after: { record: { date: TODAY }, drum: {} },
      at: T0, appliedAt: new Date(T0).toISOString(), outcome: "kept", undoneAt: null, undoneBy: null, revertedAt: null,
      deliveredAt: new Date(T0).toISOString(), warnings: null, editsLive: true, by: "Alex" };
    const st = changeStatus(row, { meta: {}, history: [], todayIso: TODAY, editsLive: true });
    expect(st.status).toBe("kept");
    expect(isUndoable(row, st, { meta: {} })).toBe(false);
    route.list = { edits: { on: true, since: T0 - 86_400_000 }, rows: [row] };
    route.profile = { meta: {}, history: [] };
    route.undo.mockReset();
    vi.useRealTimers();
    const res = await postRoute({ profile: "sam", undo: ID });
    expect(res.status).toBe(409);
    expect(route.undo).not.toHaveBeenCalled();
  });
});

// ── W-H: push order ─────────────────────────────────────────────────────────

describe("W-H: a kept record behind the push watermark still pushes", () => {
  it("rides the next push by its loggedAt", async () => {
    seedClient();
    // This device pushed something newer than the record's id since.
    vi.setSystemTime(T0 + 3 * HOUR);
    H.append(WHO, { ...liveLog({ idx: 2, profileName: WHO, startedAt: T0 + 2 * HOUR, finishedAt: T0 + 3 * HOUR }) });
    DeltaSync.commitPushState(WHO, getLocalProfile(WHO));
    const mark = DeltaSync.getPushState(WHO).lastRecordId;
    vi.setSystemTime(T0 - 2 * HOUR);
    const record = liveLog({ startedAt: T0 - 2 * HOUR, finishedAt: T0 - HOUR });
    expect(record.id < mark).toBe(true);
    vi.setSystemTime(T0 + 4 * HOUR);
    applyTrainerRows(WHO, { rows: [sessionRow(record, { at: T0 })] });
    const res = await keepTrainerSession(WHO, ID);
    expect(DeltaSync.newRecords(H.get(WHO), mark).map((r) => r.id)).toEqual([record.id]);
    await res.delivery;
    expect(puts()[0].body.delta.history.map((r) => r.id)).toEqual([record.id]);
  });
});

// ── The report route: POST /api/sync/trainer ────────────────────────────────

const { GET: getRoute, POST: POST_ROUTE } = await import("@/app/api/sync/trainer/route");
function postRoute(body) {
  return POST_ROUTE(new NextRequest("https://heatwayve.app/api/sync/trainer", {
    method: "POST", headers: { "content-type": "application/json", cookie: "hw_sync=tok-sam" }, body: JSON.stringify(body),
  }));
}

describe("POST /api/sync/trainer: delivered and the session outcomes", () => {
  beforeEach(() => {
    vi.useRealTimers();
    process.env.DATABASE_URL = "postgres://fake";
    route.ack.mockReset();
    route.ack.mockImplementation(async () => ({ acked: [], reverted: [], delivered: [ID], undelivered: [] }));
  });
  const AT = "2026-10-07T10:00:00.000Z";

  it("delivered alone is a report; it reaches the store with the server's now", async () => {
    const before = Date.now();
    const res = await postRoute({ profile: "sam", delivered: [{ id: ID, at: AT }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, acked: [], reverted: [], delivered: [ID] });
    const [[me, report, now]] = route.ack.mock.calls;
    expect(me).toBe(CLIENT);
    expect(report).toEqual({ acks: undefined, reverts: undefined, delivered: [{ id: ID, at: AT }] });
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it("the session outcomes are outcomes the report accepts", () => {
    for (const outcome of ["kept", "auto_kept", "discarded", "superseded", "limits"]) {
      expect(cleanAcks([{ id: ID, outcome, at: AT }], [], [{ id: ID, at: AT }])).not.toBeNull();
    }
  });

  it("a bad delivered entry refuses the whole report, and nothing is written", async () => {
    for (const delivered of [[{ id: ID, at: "yesterday" }], [{ id: "", at: AT }], "x", Array.from({ length: 65 }, (_, i) => ({ id: `${SET}.${i}`, at: AT }))]) {
      expect((await postRoute({ profile: "sam", delivered })).status).toBe(400);
    }
    expect(route.ack).not.toHaveBeenCalled();
  });

  it("kept after five hours for a record the server never saw arrive: 400 with the ids", async () => {
    route.ack.mockImplementation(async () => ({ acked: [], reverted: [], delivered: [], undelivered: [ID] }));
    const res = await postRoute({ profile: "sam", acks: [{ id: ID, outcome: "auto_kept", at: AT }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad report", undelivered: [ID], acked: [], reverted: [], delivered: [] });
  });

  it("one verb per request: delivered beside another branch's key is not found", async () => {
    expect((await postRoute({ profile: "sam", delivered: [{ id: ID, at: AT }], stop: "g" })).status).toBe(404);
    expect((await postRoute({ profile: "sam", delivered: [{ id: ID, at: AT }], undo: ID })).status).toBe(404);
    expect(route.ack).not.toHaveBeenCalled();
  });

  it("their list carries a session's letter, day and size (never the record), its arrival and when it keeps; never undoable", async () => {
    const record = liveLog();
    const delivered = new Date(T0).toISOString();
    route.profile = { meta: {}, history: [] };
    route.list = { edits: { on: true, since: T0 - 86_400_000 }, rows: [
      { id: ID, set: SET, kind: "session", target: sessionTarget(record), from: record.date, before: null, after: { record, drum: {} }, basis: null,
        at: T0, appliedAt: null, outcome: null, undoneAt: null, undoneBy: null, revertedAt: null, warnings: null, deliveredAt: delivered, editsLive: true, by: "Alex" },
    ] };
    const res = await getRoute(new NextRequest("https://heatwayve.app/api/sync/trainer?profile=sam&today=2026-10-07", { headers: { cookie: "hw_sync=tok-sam" } }));
    const { changes } = await res.json();
    expect(changes).toEqual([expect.objectContaining({
      id: ID, kind: "session", status: "seen", undoable: false, deliveredAt: delivered, keepsAt: T0 + AUTO_KEEP_MS, after: sessionPreview(record), by: "Alex",
    })]);
    expect(changes[0].after).toEqual({ letter: "A", date: record.date, day: null, exercises: expect.any(Number), sets: expect.any(Number) });
    expect(changes[0].after.sets).toBeGreaterThan(0);
    expect(JSON.stringify(changes)).not.toContain('"blocks"');
  });
});

// ── W-C: Keep runs the engine exactly as the live finish ────────────────────

const button = (re) => screen.queryAllByText(re).map((n) => n.closest("button")).filter(Boolean)[0] ?? null;

/**
 * Run Strength A through the real host to the done screen. The squat's drum
 * goes up before its first set; Landmine Press (no W, no anchor: a cold
 * start) goes up after its first set, so the drum, not the record, carries
 * its number. Returns the drum as the host held it and the finish instant.
 */
function runLive() {
  fireEvent.click(screen.getByText("Normal"));
  fireEvent.click(screen.getByText(/Start session/));
  const drum = {};
  let at = T0, clickedAt = T0, squatNudged = false, landmineSets = 0, landmineNudged = false, commits = 0;
  for (let step = 0; step < 300; step++) {
    at = T0 + (step + 1) * 45_000;
    vi.setSystemTime(at);
    const heading = screen.queryByRole("heading", { level: 1 })?.textContent;
    const nudge = () => screen.getAllByLabelText(/^Add [\d.]+ kg$/)[0];
    if (!squatNudged && heading === SQUAT) { squatNudged = true; fireEvent.click(nudge()); continue; }
    if (!landmineNudged && heading === LANDMINE && landmineSets === 1) { landmineNudged = true; fireEvent.click(nudge()); continue; }
    const logAt = button(/Log at/);
    const log = logAt ?? button(/^Log (set( \d+)?|A — into B|B — round done)$/);
    if (log) {
      if (heading === LANDMINE) landmineSets += 1;
      commits += 1;
      if (logAt) for (let i = 0; i < commits % 3; i++) fireEvent.keyDown(screen.getByLabelText("Effort, RPE 6 to 10"), { key: "ArrowRight" });
      fireEvent.click(log);
      continue;
    }
    const next = button(/^Next: /) ?? button(/^Finish session$/);
    if (next) { clickedAt = at; fireEvent.click(next); continue; }
    break;
  }
  const rec = H.get(WHO).at(-1);
  const lastWeight = (name) => rec.blocks.flatMap((b) => b.exercises).find((e) => e.name === name)?.sets.at(-1)?.weight;
  drum[SQUAT] = lastWeight(SQUAT);
  drum[LANDMINE] = lastWeight(LANDMINE);
  // The finish ran at the last tap.
  return { rec, drum, finishedAt: clickedAt, squatNudged, landmineNudged };
}

/** The record as the trainer's device would have sent it: the same sets, logged with no bodyweight and no profile. */
function asSent(rec) {
  const d = newDraftLog({ profileName: null, session: rec.session, blockNumber: rec.blockNumber, readiness: rec.readiness, readinessReason: rec.readinessReason });
  for (const k of ["id", "date", "dow", "loggedTz", "loggedTzOffset", "weekStart", "scheduledLetter"]) d[k] = rec[k];
  d.startedAt = Date.now() - rec.duration * 1000;
  for (const b of rec.blocks) for (const ex of b.exercises) for (const s of ex.sets) {
    logSet(d, {
      blockId: b.id, blockType: b.type, blockIntent: b.intent, exerciseName: ex.name, muscle: ex.muscle, swapped: ex.swapped, fromPool: ex.fromPool,
      tempo: ex.tempo, prescribed: ex.prescribed, loadType: s.loadType, bodyweight: null, weight: s.weight, reps: s.reps, rpe: s.rpe, rir: s.rir, reach: s.reach === true,
    });
  }
  return JSON.parse(JSON.stringify(finaliseDraft(d)));
}

const ENGINE_KEYS = ["history", "days", "trainingState", "weights", "weightStamps", "reps", "repStamps", "streak"];
const engineStores = () => Object.fromEntries(ENGINE_KEYS.map((k) => [k, stored(k)]));

async function bothPaths(setup) {
  vi.setSystemTime(T0);
  seedClient({ reps: { [SQUAT]: 3, [BENCH]: 6 } }); // the squat's R below its base: the session repairs it
  setup?.();
  SessionIntent.stash(WHO, { sessionIdx: 0 });
  render(createElement(SessionHost));
  const live = runLive();
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  const L = engineStores();
  cleanup();

  localStorage.clear();
  vi.setSystemTime(T0);
  seedClient({ reps: { [SQUAT]: 3, [BENCH]: 6 } });
  setup?.();
  vi.setSystemTime(live.finishedAt);
  const sent = asSent(live.rec);
  applyTrainerRows(WHO, { rows: [sessionRow(sent, { at: live.finishedAt, after: { record: sent, drum: live.drum } })] });
  const res = await keepTrainerSession(WHO, ID);
  await res.delivery;
  const K = engineStores();
  // The kept record carries who logged it and when it was kept; nothing else differs.
  const hk = JSON.parse(K.history);
  const kept = hk.find((r) => r.id === live.rec.id);
  expect(kept.loggedBy).toEqual({ name: "Alex", accountId: null });
  K.history = JSON.stringify(hk.map((r) => (r.id === live.rec.id ? strip(r) : r)));
  return { L, K, live, res };
}

// The real host, tap by tap: slow on a loaded runner, so a longer timeout.
describe("W-C: Keep leaves the stores as the live finish does", { timeout: 30_000 }, () => {
  it("a rep repair, a drum edit, a cold start carried by the drum, a bodyweight lift", async () => {
    const { L, K, live, res } = await bothPaths();
    expect(res.outcome).toBe("kept");
    expect(live).toMatchObject({ squatNudged: true, landmineNudged: true });
    // The witnesses are really in the run.
    const W = JSON.parse(L.weights);
    expect(W[LANDMINE]).toBe(live.drum[LANDMINE]);
    expect(live.rec.blocks.flatMap((b) => b.exercises).find((e) => e.name === LANDMINE).sets[0].weight).not.toBe(live.drum[LANDMINE]);
    expect(JSON.parse(L.reps)[SQUAT]).toBe(5);
    expect(live.rec.blocks.flatMap((b) => b.exercises).find((e) => e.name === HIP).sets[0].bodyweightUsed).toBe(78);
    for (const k of ENGINE_KEYS) expect([k, K[k]]).toEqual([k, L[k]]);
  });

  it("a deload that completes on this session", async () => {
    const { L, K, res } = await bothPaths(() => {
      vi.setSystemTime(T0 - 10 * 86_400_000);
      TS.replaceState(WHO, startDeload(TS.get(WHO), { type: "stall", lift: SQUAT }));
      vi.setSystemTime(T0);
    });
    expect(res.outcome).toBe("kept");
    expect(JSON.parse(L.trainingState).mesocycle.activeDeload).toBeNull();
    for (const k of ENGINE_KEYS) expect([k, K[k]]).toEqual([k, L[k]]);
  });
});

// The plan the device runs is the trainer-change module's own.
it("the device's plan is planSessionSteps, the one plan", () => {
  const storage = readFileSync(join(ROOT, "lib/storage.js"), "utf8");
  expect(storage).toMatch(/planSessionSteps\(/);
  expect(typeof planSessionSteps).toBe("function");
});
