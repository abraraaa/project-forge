// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/trainer-sync.js
// ─────────────────────────────────────────────────────────────────────────────
// The client's side of a trainer's changes: the rows the home pull carries,
// applied through storage's stamped setters, the sessions a trainer ran with
// them (keep, discard, auto-keep), and the report of each outcome.
// This module imports lib/storage.js and never the other way: storage's
// backgroundSync reaches the trainer step through setTrainerOnPull, handed in
// below when this module loads.

import {
  LS, TL, P, W, H, PB, F, TS, BW, getLocalProfile, pushNow, recordForKeep, bumpStreak,
  setTrainerOnPull, _tlNormal, _tlRef, _putsSettled, _autoSyncProfile, _autoSyncCallback,
} from "./storage.js";
import {
  SESSIONS, DEFAULT_FOCUS, applyRotationToSession, applyMainLiftsToSession, applyFocusToSession,
} from "./programme.js";
import { planDeviceSteps, planSessionSteps, SESSION_KIND, SESSION_LETTERS } from "./trainer-change.js";
import { todayLocalIso as _todayLocalIso } from "./dates.js";
import { fetchWithTimeout } from "./net.js";
import { repTargetRepairs } from "./progression.js";

// ─── Trainer changes: applied on the home pull ──────────────────────────────
// The trainer never writes the client's data. A change waits on the server;
// the home pull carries it (GET /api/sync's `trainer` key) and this device
// re-checks it against its own latest training (planDeviceSteps, the one
// validator) and applies it with the same stamped setters the client's own
// edits use. The push then carries it like any edit, through THE merge.
// Outcomes are reported only after that push succeeds, so the server never
// reads a change as applied while its copy of the plan lacks the value.

/** At most this many acks, and reverts, in one report (the route's cap). */
const TRAINER_REPORT_MAX = 64;

/**
 * Applies the trainer rows one home pull carried. Synchronous: it runs in the
 * same turn as the merge it follows. Writes, named:
 *   · P.saveWeights / P.saveReps with the stored map plus the changed keys
 *     (the diff-stamping setters: only changed keys get a fresh stamp);
 *   · P.unsetWeight / P.unsetReps for an undo back to a value never set (the
 *     plan's RESET): null with a fresh stamp, an overwrite of that one key;
 *   · P.setMainLift per main lift (stamped);
 *   · W.save per week, appended with by "trainer" and the change's id;
 *   · TL, overwritten in place: pending replaced, marks set per target,
 *     outcomes appended to the outbox.
 * Session rows (a trainer ran a session with them) go apart, to
 * _sessionRowsOnPull, after the plan's writes; see there for its writes.
 * Nothing is deleted. A pull without the key empties pending (and the
 * waiting sessions) only when they held something, so a profile with no
 * trainer is never written.
 * @param {string} profile
 * @param {{ rows?: any[] } | null | undefined} payload
 * @returns {{ wrote: boolean, acks: number, reverts: number, sessions?: SessionPullResult } | null}
 *   null: no rows. sessions: only when a session row came, or the waiting ones went.
 */
export function applyTrainerRows(profile, payload) {
  if (!profile) return null;
  const all = Array.isArray(payload?.rows) && payload.rows.length ? payload.rows : null;
  const stored = LS.get(TL.key(profile), null);
  const tl = _tlNormal(stored);
  const sessionRows = (all ?? []).filter((r) => r?.kind === SESSION_KIND);
  const rows = all ? all.filter((r) => r?.kind !== SESSION_KIND) : null;
  if (!all) {
    // No rows: none waiting, or the read failed (GET /api/sync leaves the key
    // out either way). The cards go too: one kept past its row could be kept
    // again after another device decided it. A failed read hides them until
    // the next good pull.
    const hadSessions = !!tl.pendingSessions?.length;
    if (stored !== null && (tl.pending.length || hadSessions)) {
      TL.save(profile, { ...tl, pending: [], ...(hadSessions ? { pendingSessions: [] } : {}) });
    }
    return hadSessions ? { wrote: false, acks: 0, reverts: 0, sessions: { seen: 0, acks: 0, cards: 0, due: [], changed: true } } : null;
  }
  // A row this device already decided (its outcome not yet reported) is not
  // decided again: the client may have moved the value since.
  const acked = new Set(tl.outbox.acks.map((a) => a?.id));
  const reverted = new Set(tl.outbox.reverts.map((r) => r?.id));
  const fresh = rows.filter((r) => r && typeof r.id === "string" && !(r.undone ? reverted.has(r.id) : acked.has(r.id)));
  const local = getLocalProfile(profile);
  const plan = planDeviceSteps(fresh, { meta: local.meta, history: local.history, todayIso: _todayLocalIso() });

  // Values are saved; a reset (an undo back to never set) is an unset.
  const isReset = (v) => v === null || v === undefined || (typeof v === "object" && /** @type {any} */ (v).reset === true);
  /** @type {Record<string, any>} */
  const weights = {};
  const weightUnsets = [];
  for (const [k, v] of Object.entries(plan.weights)) {
    if (isReset(v)) weightUnsets.push(k);
    else weights[k] = v;
  }
  /** @type {Record<string, any>} */
  const reps = {};
  const repUnsets = [];
  for (const [k, v] of Object.entries(plan.reps)) {
    if (isReset(v)) repUnsets.push(k);
    else reps[k] = v;
  }

  const at = new Date().toISOString();
  const failuresBefore = LS._quotaFailures || 0;
  let wrote = false;
  if (Object.keys(weights).length) {
    P.saveWeights(profile, { ...P.getWeights(profile), ...weights });
    wrote = true;
  }
  if (Object.keys(reps).length) {
    P.saveReps(profile, { ...P.getReps(profile), ...reps });
    wrote = true;
  }
  for (const k of weightUnsets) if (P.unsetWeight(profile, k)) wrote = true;
  for (const k of repUnsets) if (P.unsetReps(profile, k)) wrote = true;
  for (const [canonical, choice] of Object.entries(plan.mainLifts)) {
    P.setMainLift(profile, canonical, choice);
    wrote = true;
  }
  const unsaved = new Set();
  for (const w of plan.weeks) {
    try {
      W.save(w.week, { effectiveFrom: w.from, profile, by: "trainer", changeId: w.changeId });
      wrote = true;
    } catch (e) {
      console.error("[forge:trainer] week not saved", e?.message || e);
      unsaved.add(w.changeId);
    }
  }
  // A write that did not land reports nothing: every row is decided again on
  // the next pull, against whatever did land.
  const landed = (LS._quotaFailures || 0) === failuresBefore;
  const acks = landed ? plan.acks.filter((a) => !unsaved.has(a.id)).map((a) => ({ id: a.id, outcome: a.outcome, at })) : [];
  const reverts = landed ? plan.reverts.map((id) => ({ id, at })) : [];

  const marks = { ...tl.marks };
  if (landed) {
    for (const a of plan.applied) {
      if (unsaved.has(a.id)) continue;
      marks[a.target] = { ...(marks[a.target] || {}), [a.kind]: { id: a.id, after: a.after, by: a.by ?? null, at } };
    }
  }
  const decided = new Set(acks.map((a) => a.id));
  const pending = fresh
    .filter((r) => !r.undone && !decided.has(r.id))
    .map((r) => ({
      id: r.id, set: r.set ?? null, kind: r.kind, target: r.target, from: r.from ?? null,
      after: r.after ?? null, by: r.by ?? null, at: typeof r.at === "number" ? r.at : null,
    }));
  const next = {
    ...tl, pending, marks,
    outbox: { ...tl.outbox, acks: [...tl.outbox.acks, ...acks], reverts: [...tl.outbox.reverts, ...reverts] },
  };
  // Only a change is saved: a pull that decides nothing new writes nothing.
  if (JSON.stringify(next) !== JSON.stringify(tl)) TL.save(profile, next);
  // Sessions after the plan's writes, so a keep runs on the plan as it now stands.
  if (!sessionRows.length && !tl.pendingSessions?.length) return { wrote, acks: acks.length, reverts: reverts.length };
  const sessions = _sessionRowsOnPull(profile, sessionRows);
  return { wrote, acks: acks.length + sessions.acks, reverts: reverts.length, sessions };
}

const _tlOutboxSize = (profile) => {
  const { outbox } = TL.get(profile);
  return outbox.acks.length + outbox.reverts.length + (outbox.delivered?.length ?? 0);
};

/**
 * Reports this device's trainer outcomes (POST /api/sync/trainer { acks,
 * reverts, delivered? }), up to 64 of each per request; delivered (a
 * session's first arrival here) only when there is one, and the server
 * marks it before it reads the acks, so a session's five hours have started
 * on the row by the time its auto_kept lands. On success the reported
 * entries leave the outbox (TL overwritten in place, re-read first so
 * entries added meanwhile stay). A 400 { undelivered } is an auto_kept the
 * server refused because it has no arrival for the row (its delivered entry
 * did not ride the report); the rest of that report was kept. Its arrival is
 * queued again, at the front, from this device's first sight, and its
 * outcome waits for the next report, which then lands. One refused although
 * its arrival rode with it can never land, and leaves. Callers push first:
 * see _deliverTrainer.
 * @param {string} profile
 * @returns {Promise<boolean>} true when the outbox is empty
 */
export async function flushTrainerOutbox(profile) {
  if (!profile) return false;
  for (let round = 0; round < 8; round++) {
    const { outbox } = TL.get(profile);
    const waiting = outbox.delivered ?? [];
    if (!outbox.acks.length && !outbox.reverts.length && !waiting.length) return true;
    const acks = outbox.acks.slice(0, TRAINER_REPORT_MAX);
    const reverts = outbox.reverts.slice(0, TRAINER_REPORT_MAX);
    const delivered = waiting.slice(0, TRAINER_REPORT_MAX);
    const sentA = new Set(acks.map((a) => a?.id));
    const sentR = new Set(reverts.map((r) => r?.id));
    const sentD = new Set(delivered.map((d) => d?.id));
    /** @type {Set<string>} auto_kept acks to send again, behind their arrival */
    let again = new Set();
    try {
      const res = await fetchWithTimeout("/api/sync/trainer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, acks, reverts, ...(delivered.length ? { delivered } : {}) }),
      });
      if (!res.ok) {
        const body = res.status === 400 ? await res.json().catch(() => null) : null;
        if (!Array.isArray(body?.undelivered) || !body.undelivered.length) return false;
        again = new Set(body.undelivered.filter((id) => typeof id === "string" && sentA.has(id) && !sentD.has(id)));
        const lost = body.undelivered.filter((id) => !again.has(id));
        if (lost.length) console.error("[forge:trainer] kept after five hours, but it never arrived on the server:", lost.join(", "));
      }
    } catch {
      return false;
    }
    const now = TL.get(profile);
    const { delivered: stillWaiting = [], ...box } = now.outbox;
    // The arrival goes again from this device's first sight (the server holds
    // it between the row's send and its now), else from the keep itself.
    const arrivals = [...again].filter((id) => !stillWaiting.some((d) => d?.id === id)).map((id) => {
      const seen = now.sessions?.[id]?.seenAt;
      const ack = acks.find((a) => a?.id === id);
      return { id, at: Number.isFinite(seen) ? new Date(seen).toISOString() : (ack?.at ?? new Date().toISOString()) };
    });
    const left = [...arrivals, ...stillWaiting.filter((d) => !sentD.has(d?.id))];
    TL.save(profile, {
      ...now,
      outbox: {
        ...box,
        acks: now.outbox.acks.filter((a) => !sentA.has(a?.id) || again.has(a?.id)),
        reverts: now.outbox.reverts.filter((r) => !sentR.has(r?.id)),
        ...(left.length ? { delivered: left } : {}),
      },
    });
  }
  return _tlOutboxSize(profile) === 0;
}

// One delivery at a time: let every push already sent settle (a full push
// of pre-apply values must not land over the change), push the plan, then
// report. A failed push reports nothing; the outbox waits for the next pull.
let _trainerFlight = Promise.resolve(true);
function _deliverTrainer(profile) {
  _trainerFlight = _trainerFlight.catch(() => false).then(async () => {
    if (!_tlOutboxSize(profile)) return true;
    await _putsSettled();
    const pushed = await pushNow(profile);
    return pushed ? flushTrainerOutbox(profile) : false;
  });
  return _trainerFlight;
}

// ─── Sessions a trainer ran with them ───────────────────────────────────────
// The trainer runs the client's session on their own device and the finished
// record waits on the server (a change of kind "session"). This device
// decides what happens to it (planSessionSteps, the one plan): on first
// sight it notes the arrival and reports it (the five hours start then, never
// at the send); it is superseded when the client logged that letter that day
// themselves; it waits as a card until the client keeps or discards it; and,
// while sharing is live and nobody has it open, it is kept five hours after
// it first reached any of their devices. Keep writes through the same path
// as a live log (lib/session-commit.js). Keep is final; nothing here deletes.

/**
 * @typedef {{ seen: number, acks: number, cards: number, due: string[], changed: boolean }} SessionPullResult
 * cards: sessions waiting on the client; due: those to keep now (the home
 * pull keeps them, keepTrainerSession with auto).
 */

// The session the client has open on this device: it is never kept under
// their finger. Module state, like the auto-sync profile.
/** @type {string | null} */
let _heldSession = null;

/**
 * The client has a session open (its id), or none (null). While it is open
 * no plan keeps it; ForgeApp keeps it on the next tick after it closes.
 * @param {string | null} id
 */
export function holdTrainerSession(id) {
  _heldSession = typeof id === "string" && id ? id : null;
}

// Keep's writes, lib/session-commit.js commitSessionRecord, handed in by the
// app when it loads (setSessionCommit). That module imports this one, so
// storage cannot import it back (tests/trainer-bundle.test.js); and a module
// loaded on first use is a separate chunk the offline shell may not hold.
/** @type {((profile: string, rec: any, ctx: { currentWeights: Record<string, any>, repairedReps: Record<string, any> }) => unknown) | null} */
let _sessionCommit = null;

/**
 * The app hands Keep its writes: commitSessionRecord, at module load, so a
 * Keep offline needs nothing fetched. Until then Keep loads it on use.
 * @param {((profile: string, rec: any, ctx: { currentWeights: Record<string, any>, repairedReps: Record<string, any> }) => unknown) | null} fn
 */
export function setSessionCommit(fn) {
  _sessionCommit = typeof fn === "function" ? fn : null;
}

/** A row for planSessionSteps from a card this device holds. */
const _rowOfCard = (c) => ({
  id: c.id, set: c.set ?? null, kind: SESSION_KIND, after: { record: c.record, drum: c.drum ?? {} },
  at: typeof c.at === "number" ? c.at : null, deliveredAt: c.deliveredAt ?? null, editsLive: c.editsLive === true,
  by: c.by ?? null, authorId: c.authorId ?? null,
});

/** A card to hold from a plan card and the row it came from. */
const _cardOf = (planned, row) => ({
  id: planned.id, record: planned.record, drum: planned.drum, by: planned.by, startMs: planned.startMs,
  keepsAt: planned.keepsAt, set: row.set ?? null, at: typeof row.at === "number" ? row.at : null,
  deliveredAt: row.deliveredAt ?? null, editsLive: row.editsLive === true,
  authorId: typeof row.authorId === "string" ? row.authorId : null,
});

/**
 * The session rows one home pull carried (applyTrainerRows partitions them
 * out). Runs only under the home pull's guard (_trainerOnPull): an
 * auto-keep runs the engine, which must never land under a live session.
 * Writes, named:
 *   · TL, overwritten in place: sessions[id].seenAt on first sight,
 *     sessions[id].decided for an outcome decided here (superseded, limits,
 *     or kept on another of their devices), the arrival (outbox.delivered)
 *     and the outcomes (outbox.acks) appended, and pendingSessions replaced
 *     by the cards this pull still serves (one decided elsewhere, or
 *     withdrawn before it arrived, goes).
 * The sessions due for auto-keep come back in `due`; keeping them is the
 * caller's (_trainerOnPull), since Keep loads the engine.
 * @param {string} profile
 * @param {any[]} rows  rows of kind "session"
 * @param {number} [nowMs]
 * @returns {SessionPullResult}
 */
function _sessionRowsOnPull(profile, rows, nowMs = Date.now()) {
  const tl = TL.get(profile);
  const local = tl.sessions ?? {};
  const plan = planSessionSteps(rows, {
    history: H.get(profile), nowMs, local,
    acked: tl.outbox.acks.map((a) => a.id),
    holding: _heldSession ? [_heldSession] : [],
  });
  const at = new Date(nowMs).toISOString();
  const sessions = { ...local };
  for (const s of plan.seen) sessions[s.id] = { ...(sessions[s.id] || {}), seenAt: nowMs };
  for (const a of plan.acks) sessions[a.id] = { ...(sessions[a.id] || {}), decided: a.outcome };
  const queued = new Set((tl.outbox.delivered ?? []).map((d) => d.id));
  const delivered = [...(tl.outbox.delivered ?? []), ...plan.seen.filter((s) => !queued.has(s.id))];
  const byId = new Map(rows.map((r) => [r?.id, r]));
  const waiting = [...plan.cards, ...plan.keep].map((c) => _cardOf(c, byId.get(c.id) ?? {}));
  const next = {
    ...tl,
    sessions,
    pendingSessions: waiting,
    outbox: {
      ...tl.outbox,
      acks: [...tl.outbox.acks, ...plan.acks.map((a) => ({ id: a.id, outcome: a.outcome, at }))],
      ...(delivered.length ? { delivered } : {}),
    },
  };
  const changed = JSON.stringify(next) !== JSON.stringify(tl);
  if (changed) TL.save(profile, next);
  return { seen: plan.seen.length, acks: plan.acks.length, cards: waiting.length, due: plan.keep.map((k) => k.id), changed };
}

/**
 * The rep targets the live session would have shown repaired for this
 * record's letter, on this device's own state (SessionHost's repRepairs):
 * the programmed session (rotation, main lifts, focus), R and lift state,
 * leaving out the lifts a swap placed.
 * @param {string} profile
 * @param {any} rec
 */
function _keptRepairs(profile, rec) {
  const idx = SESSION_LETTERS.indexOf(rec?.session);
  if (idx < 0) return {};
  const config = PB.get(profile)?.config;
  const mainLifts = P.getMainLifts(profile);
  const programmed = applyFocusToSession(
    applyMainLiftsToSession(applyRotationToSession(SESSIONS[idx], config), mainLifts),
    F.get(profile) || DEFAULT_FOCUS, config, mainLifts,
  );
  /** @type {Record<string, any>} */
  let lifts = {};
  try { lifts = TS.get(profile)?.lifts || {}; } catch { lifts = {}; }
  const swapped = (rec.blocks ?? []).flatMap((b) => b?.exercises ?? []).filter((e) => e?.swapped === true).map((e) => e.name);
  return repTargetRepairs({ reps: P.getReps(profile), lifts, sessions: [programmed], exclude: swapped });
}

/**
 * Records this device's decision on a session. Writes: TL, overwritten in
 * place (sessions[id].decided set, the outcome appended to outbox.acks, the
 * card taken off pendingSessions).
 * @param {string} profile
 * @param {string} id
 * @param {string} outcome
 * @param {number} nowMs
 */
function _decideSession(profile, id, outcome, nowMs) {
  const tl = TL.get(profile);
  const sessions = tl.sessions ?? {};
  TL.save(profile, {
    ...tl,
    sessions: { ...sessions, [id]: { ...(sessions[id] || {}), decided: outcome } },
    pendingSessions: (tl.pendingSessions ?? []).filter((c) => c.id !== id),
    outbox: { ...tl.outbox, acks: [...tl.outbox.acks.filter((a) => a.id !== id), { id, outcome, at: new Date(nowMs).toISOString() }] },
  });
}

/**
 * Keep, without the report. See keepTrainerSession.
 * @param {string} profile
 * @param {string} id
 * @param {{ auto?: boolean, felt?: Record<string, any> | null, nowMs?: number,
 *   commit: (profile: string, rec: any, ctx: { currentWeights: Record<string, any>, repairedReps: Record<string, any> }) => unknown }} opts
 * @returns {{ kept: boolean, outcome: string | null, reason: string | null }}
 */
function _keepSession(profile, id, { auto = false, felt = null, nowMs = Date.now(), commit }) {
  const no = (reason, outcome = null) => ({ kept: false, outcome, reason });
  if (!profile || !_tlRef(id)) return no("gone");
  const tl = TL.get(profile);
  const card = (tl.pendingSessions ?? []).find((c) => c.id === id);
  if (!card) return no("gone");
  if (tl.sessions?.[id]?.decided || tl.outbox.acks.some((a) => a.id === id)) return no("decided");
  // The device's checks again, on their history as it is now: they may have
  // logged this letter that day since it arrived.
  const plan = planSessionSteps([_rowOfCard(card)], {
    history: H.get(profile), nowMs, local: tl.sessions ?? {},
    holding: auto && _heldSession ? [_heldSession] : [],
  });
  if (plan.acks.length) {
    _decideSession(profile, id, plan.acks[0].outcome, nowMs);
    return no(plan.acks[0].outcome, plan.acks[0].outcome);
  }
  // Auto-keep only once due: five hours after it arrived, sharing live, not open.
  const due = auto ? plan.keep[0] : (plan.keep[0] ?? plan.cards[0]);
  if (!due) return no("not_due");
  const edits = felt && typeof felt === "object" ? felt : (tl.sessions?.[id]?.felt ?? {});
  const rec = recordForKeep(card.record, {
    felt: edits, bodyweight: BW.getKg(profile), profile,
    by: { name: card.by ?? null, accountId: card.authorId ?? null }, nowIso: new Date(nowMs).toISOString(),
  });
  const ctx = { currentWeights: { ...P.getWeights(profile), ...(due.drum ?? {}) }, repairedReps: _keptRepairs(profile, rec) };
  const failuresBefore = LS._quotaFailures || 0;
  commit(profile, rec, ctx);
  // The streak marks today, so only a session dated today moves it.
  if (rec.date === _todayLocalIso()) bumpStreak(profile);
  // A write that did not land reports nothing: the next plan finds the
  // record in history (kept) or not (waiting), and decides again.
  if ((LS._quotaFailures || 0) !== failuresBefore) return no("storage");
  const outcome = auto ? "auto_kept" : "kept";
  _decideSession(profile, id, outcome, nowMs);
  return { kept: true, outcome, reason: null };
}

/**
 * The client keeps a session their trainer ran with them (auto: five hours
 * after it arrived, while sharing is live and it is not open). THIS WRITES
 * THEIR TRAINING, through the same path as a live log, and deletes nothing.
 * Writes, named, in order:
 *   · commitSessionRecord (lib/session-commit.js, as setSessionCommit handed
 *     it in, else loaded on use): H.append, recordCompletion
 *     (the day), applySessionToEngine (trainingState), then W and R for the
 *     lifts the engine moved; with the live finish's context on this
 *     device's own state: W plus the record's drum, and the rep repairs;
 *   · bumpStreak, only when the record is dated today;
 *   · TL (see _decideSession), then the push and the report (_deliverTrainer).
 * The kept record is recordForKeep's: the sent record, felt as edited,
 * bodyweight-derived numbers from this device's bodyweight, and loggedAt and
 * loggedBy set here. Already decided, gone, superseded (they logged that
 * letter that day themselves: reported, nothing written) or not yet due:
 * nothing kept. An auto-keep runs only while home is mounted for this
 * profile, never under a live session. Keep is final; there is no undo.
 * @param {string} profile
 * @param {string} id  the change id
 * @param {{ auto?: boolean, felt?: Record<string, any> | null }} [opts]  felt: by feltKey; else the held edits
 * @returns {Promise<{ kept: boolean, outcome: string | null, reason: string | null, delivery: Promise<boolean> }>}
 */
export async function keepTrainerSession(profile, id, { auto = false, felt = null } = {}) {
  // The app's commit (setSessionCommit); without it, loaded on use. Home is
  // checked after, since a load can outlast a navigation.
  const commit = _sessionCommit ?? (await import("./session-commit.js")).commitSessionRecord;
  if (auto && _autoSyncProfile !== profile) return { kept: false, outcome: null, reason: "away", delivery: Promise.resolve(true) };
  const res = _keepSession(profile, id, { auto, felt, commit });
  return { ...res, delivery: res.outcome ? _deliverTrainer(profile) : Promise.resolve(true) };
}

/**
 * "Not mine": the client refuses a session. Writes only TL (decided
 * "discarded", the outcome queued) and then reports it; their training is
 * not touched. The record stays with the trainer's changes on the server.
 * @param {string} profile
 * @param {string} id
 * @returns {{ discarded: boolean, delivery: Promise<boolean> }}
 */
export function discardTrainerSession(profile, id) {
  const tl = profile ? TL.get(profile) : null;
  const waiting = !!tl && _tlRef(id) && (tl.pendingSessions ?? []).some((c) => c.id === id)
    && !tl.sessions?.[id]?.decided && !tl.outbox.acks.some((a) => a.id === id);
  if (!waiting) return { discarded: false, delivery: Promise.resolve(true) };
  _decideSession(profile, id, "discarded", Date.now());
  return { discarded: true, delivery: _deliverTrainer(profile) };
}

/** Tells the mounted home what its stores now hold (the auto-sync callback). */
function _tellHome(profile) {
  if (!_autoSyncCallback) return;
  try {
    const now = getLocalProfile(profile);
    _autoSyncCallback({ meta: now.meta, history: now.history, source: "trainer" });
  } catch (e) {
    console.error("[forge:trainer] home update failed", e?.message || e);
  }
}

/**
 * The home pull's trainer step, after the merge has landed and the UI has
 * seen it. Applies only while home is still mounted for this profile: a
 * session snapshots W/R at mount and writes the whole map back at finish, so
 * a value landing under it would be overwritten. Tells the mounted home
 * (the auto-sync callback) when it wrote, keeps the sessions now due (each
 * keepTrainerSession with auto, which checks home again once loaded, and
 * tells home when one lands), then delivers.
 * @param {string} profile
 * @param {any} payload
 */
function _trainerOnPull(profile, payload) {
  if (_autoSyncProfile !== profile) return null;
  const res = applyTrainerRows(profile, payload);
  if (res?.wrote || res?.sessions?.changed) _tellHome(profile);
  const due = res?.sessions?.due ?? [];
  const waiting = _tlOutboxSize(profile) > 0;
  if (!res && !waiting) return null;
  const keeping = Promise.all(due.map((id) => keepTrainerSession(profile, id, { auto: true }))).then((kept) => {
    if (kept.some((k) => k.kept)) _tellHome(profile);
    return Promise.all(kept.map((k) => k.delivery));
  });
  const delivery = Promise.all([waiting ? _deliverTrainer(profile) : Promise.resolve(true), keeping])
    .then(([sent, reports]) => sent && reports.every(Boolean), () => false);
  return { ...(res || { wrote: false, acks: 0, reverts: 0 }), delivery };
}

// The home pull runs this step after its merge (backgroundSync, applyTrainer).
setTrainerOnPull(_trainerOnPull);
