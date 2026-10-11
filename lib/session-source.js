// lib/session-source.js
// ─────────────────────────────────────────────────────────────────────────────
// Where the live session host reads from and writes to, as one adapter, so
// the host itself names no store. localSource/localSinks are the lifter's own
// device stores, exactly as the host used them inline.
//
// Reads (localSource), each a fresh read when called:
//   weights          P.getWeights            forge:<p>:weights (W)
//   reps             P.getReps               forge:<p>:reps (R)
//   liftStates       TS.get().lifts          forge:<p>:trainingState
//   trainerMarks     TL.get().marks          forge:<p>:trainerLocal
//   muscleAnchors    TS.get().muscleAnchors  forge:<p>:trainingState
//   history          H.get                   forge:<p>:history
//   bodyweight       BW.getKg                forge:<p>:bodyweight
//   programmeBlock   PB.get                  the active profile's programmeBlock
//   focus            F.get                   forge:<p>:focus
//   mainLifts        P.getMainLifts          forge:<p>:mainLifts
//   addedLoads       P.getAddedLoads         forge:<p>:addedLoads
//   userWeek         W.get                   the active profile's weekConfig
//   activeDeload     TS.get().mesocycle      forge:<p>:trainingState
//   travel           TRAVEL.get              forge:<p>:travel
//   inRecovery       TS.get().lifts[name]    forge:<p>:trainingState
//
// Writes (localSinks):
//   saveW            P.saveWeights           overwrites W (and its stamps)
//   saveR            P.saveReps              overwrites R (and its stamps)
//   addedLoad        P.setAddedLoad, push    forge:<p>:addedLoads, one lift
//   bodyweight       BW.set, push            forge:<p>:bodyweight and :bodyweightLog
//   travel           TRAVEL.set              forge:<p>:travel
//   draft.take       SessionIntent.take      reads, then removes, forge:<p>:pendingSession
//   draft.load       D.load                  forge:<p>:draft; D.load removes a
//                                            draft past its expiry, as it always has
//   draft.save       D.save                  overwrites forge:<p>:draft
//   draft.clear      D.clear                 removes forge:<p>:draft
//   finish           bumpStreak (forge:<p>:streak), commitSessionRecord
//                    (history, the day, the engine, W/R; see
//                    lib/session-commit.js), then push
//
// coachedSource/coachedSinks run a client's session on a trainer's device.
// They read the client's programme inputs from the plan the trainer route
// sends (view.plan), never a store, and write one key only:
//   forge:coachDraft  CD, this device's drafts by grant ref. One entry is
//                     overwritten in place on every logged set, and at Review
//                     (its set id and first Review's duration); an entry is
//                     removed only after its Send answers 200, or on the
//                     trainer's "Discard this session", and the key goes with
//                     the last entry. No other key is touched.
// ─────────────────────────────────────────────────────────────────────────────

import {
  P, H, W, PB, F, TS, BW, D, SessionIntent, TRAVEL, TL, LS,
  bumpStreak, pushNow,
} from "./storage.js";
import { DEFAULT_FOCUS, SESSIONS } from "./programme.js";
import { commitSessionRecord } from "./session-commit.js";
import { jsDow, mondayOfWeekIso } from "./dates.js";

/**
 * The lifter's own stores, read as the live host reads them. Every reader
 * tolerates a missing profile the way the host's lazy initialisers did.
 * @param {string | null} profile
 */
export function localSource(profile) {
  return {
    weights: () => (profile ? P.getWeights(profile) : {}),
    reps: () => (profile ? P.getReps(profile) : {}),
    liftStates: () => {
      if (!profile) return {};
      try { return TS.get(profile)?.lifts || {}; } catch { return {}; }
    },
    trainerMarks: () => {
      if (!profile) return {};
      try { return TL.get(profile).marks; } catch { return {}; }
    },
    muscleAnchors: () => {
      if (!profile) return {};
      try { return TS.get(profile)?.muscleAnchors || {}; } catch { return {}; }
    },
    history: () => (profile ? H.get(profile) : []),
    bodyweight: () => (profile ? BW.getKg(profile) : null),
    programmeBlock: () => PB.get(),
    focus: () => (profile ? F.get(profile) || DEFAULT_FOCUS : DEFAULT_FOCUS),
    mainLifts: () => (profile ? P.getMainLifts(profile) : {}),
    addedLoads: () => (profile ? P.getAddedLoads(profile) : {}),
    userWeek: () => W.get(),
    activeDeload: () => {
      if (!profile) return null;
      try { return TS.get(profile)?.mesocycle?.activeDeload || null; } catch { return null; }
    },
    travel: () => TRAVEL.get(profile),
    /** @param {string} name  May throw; the caller guards it. */
    inRecovery: (name) => (TS.get(profile)?.lifts?.[name]?.inRecoveryUntil ?? 0) > 0,
  };
}

/**
 * The lifter's own stores, written as the live host writes them.
 * @param {string | null} profile
 */
export function localSinks(profile) {
  // Each writing sink is a named const so the push audit
  // (tests/forge-app-mutation-coverage.test.js) checks its own body.
  /**
   * @param {string} name
   * @param {number | null} kg
   * @returns {Record<string, any>} the added-load map after the write
   */
  const addedLoad = (name, kg) => {
    const next = P.setAddedLoad(profile, name, kg);
    pushNow(profile);
    return next;
  };
  /** @param {number} kg */
  const bodyweight = (kg) => {
    BW.set(profile, kg);
    pushNow(profile);
  };
  /**
   * The finish's writes: the streak, then the record (when there is one)
   * through commitSessionRecord, then the push. `ctx.onCommitted` runs
   * after the writes and before the push.
   * @param {any} rec  the finalised record, or null when nothing was logged
   * @param {Parameters<typeof commitSessionRecord>[2] & { onCommitted?: (engine: ReturnType<typeof commitSessionRecord> | null) => void }} ctx
   */
  const finish = (rec, ctx) => {
    bumpStreak(profile);
    const engine = rec ? commitSessionRecord(profile, rec, ctx) : null;
    if (!rec) ctx.afterHistory?.();
    ctx.onCommitted?.(engine);
    // The full canonical snapshot (getLocalProfile), never a subset.
    pushNow(profile);
    return engine;
  };
  return {
    /** @param {Record<string, any>} next  the whole W map */
    saveW: (next) => { if (profile) P.saveWeights(profile, next); },
    /** @param {Record<string, any>} next  the whole R map */
    saveR: (next) => { if (profile) P.saveReps(profile, next); },
    addedLoad,
    bodyweight,
    /** @param {boolean} on */
    travel: (on) => { TRAVEL.set(profile, on); },
    draft: {
      take: () => SessionIntent.take(profile),
      load: () => D.load(profile),
      /** @param {any} draft */
      save: (draft) => D.save(profile, draft),
      clear: () => D.clear(profile),
    },
    finish,
  };
}

// ─── Coached mode: a trainer's device ────────────────────────────────────────

/** The trainer's device key for coached drafts (lib/store-health.js DEVICE_KEYS). */
export const COACH_DRAFT_KEY = "forge:coachDraft";
/** The session keys the host runs, by letter index (components/SessionHost.jsx). */
const LETTERS = ["A", "B", "C"];
/** A record's duration in seconds, at most (lib/trainer-change.js MAX_DURATION_S). */
const MAX_DURATION_S = 21600;
/** Sets a lift a record may carry (lib/trainer-change.js MAX_SETS_PER_LIFT). */
export const COACH_MAX_SETS = 10;

const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * One coached draft, as CD stores it.
 * @typedef {{
 *   v: 1, letter: string, savedAt: number, name: string | null, plan: any,
 *   draft: any, swaps: Record<string, any>, sessionWeights: Record<string, number>,
 *   sessionReps: Record<string, any>, addedLoads: Record<string, any>,
 *   readiness: string | null, readinessReason: string | null,
 *   setId?: string | null, duration?: number | null,
 * }} CoachDraft
 * setId: the change set id Review minted, kept across sets and reloads.
 * duration: the first Review's, until another set is logged, so a later
 * Review (after a reload too) sends the same record and a send whose reply
 * was lost replays as sent.
 */

/**
 * forge:coachDraft: `{ [ref]: CoachDraft }`. Never purged on read: a draft
 * waits for its Send however old it is.
 */
export const CD = {
  key: COACH_DRAFT_KEY,
  /** @returns {Record<string, CoachDraft>} */
  all: () => {
    const v = LS.get(COACH_DRAFT_KEY, null);
    return isPlain(v) ? v : {};
  },
  /**
   * @param {string | null | undefined} ref
   * @returns {CoachDraft | null}
   */
  load: (ref) => {
    if (typeof ref !== "string" || !ref) return null;
    const e = CD.all()[ref];
    return isPlain(e) && isPlain(e.draft) && LETTERS.includes(e.letter) ? e : null;
  },
  /** The ref of the draft saved last, or null. */
  latest: () => {
    let best = null, at = -Infinity;
    for (const [ref, e] of Object.entries(CD.all())) {
      if (isPlain(e) && isPlain(e.draft) && Number(e.savedAt) > at) { best = ref; at = Number(e.savedAt); }
    }
    return best;
  },
  /**
   * WRITE: overwrites forge:coachDraft with this ref's entry replaced.
   * @param {string} ref
   * @param {Omit<CoachDraft, "v" | "savedAt">} entry
   */
  save: (ref, entry) => {
    if (typeof ref !== "string" || !ref) return;
    LS.set(COACH_DRAFT_KEY, { ...CD.all(), [ref]: { v: 1, ...entry, savedAt: Date.now() } });
  },
  /**
   * WRITE: overwrites this ref's entry with `fields` laid over it. Nothing
   * when there is no entry.
   * @param {string} ref
   * @param {{ setId?: string | null, duration?: number | null }} fields
   */
  hold: (ref, fields) => {
    const e = CD.load(ref);
    if (!e) return;
    LS.set(COACH_DRAFT_KEY, { ...CD.all(), [ref]: { ...e, ...fields } });
  },
  /**
   * DELETE-ON-USE: this ref's entry, after a Send answers 200 or on the
   * trainer's Discard only. The map is rewritten without it; with no entry
   * left the key itself is removed.
   * @param {string} ref
   */
  clear: (ref) => {
    const all = CD.all();
    if (typeof ref !== "string" || !Object.hasOwn(all, ref)) return;
    const { [ref]: _sent, ...rest } = all;
    if (Object.keys(rest).length) LS.set(COACH_DRAFT_KEY, rest);
    else LS.remove(COACH_DRAFT_KEY);
  },
};

/**
 * This device's unsent coached draft for a client, in brief, for the
 * trainer's pane: its letter, the day it started and the sets in it. Null
 * with none. Reads only.
 * @param {string | null | undefined} ref
 * @returns {{ letter: string, date: string | null, sets: number } | null}
 */
export function unsentDraft(ref) {
  const e = CD.load(ref);
  if (!e) return null;
  let sets = 0;
  for (const b of Object.values(isPlain(e.draft.blocks) ? e.draft.blocks : {})) {
    for (const ex of Object.values(isPlain(b?.exercises) ? b.exercises : {})) sets += Array.isArray(ex?.sets) ? ex.sets.length : 0;
  }
  const date = typeof e.draft.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.draft.date) ? e.draft.date : null;
  return { letter: e.letter, date, sets };
}

/**
 * A client's programme inputs, read from the plan the trainer route sends
 * (view.plan) and the view's sessions. Nothing here reads a store, and
 * nothing that moves with the client's bodyweight or anchors is ever there.
 * @param {any} plan  view.plan, with plan.programme { number, config, focus, mainLifts }
 * @param {any} view  the trainer view (sessions feed the recent-sets cell)
 * @param {CoachDraft | null} [entry]  a draft being resumed
 */
export function coachedSource(plan, view, entry = null) {
  const lifts = Array.isArray(plan?.lifts) ? plan.lifts.filter((l) => typeof l?.name === "string") : [];
  const prog = isPlain(plan?.programme) ? plan.programme : {};
  return {
    weights: () => Object.fromEntries(lifts.filter((l) => Number.isFinite(l.w)).map((l) => [l.name, l.w])),
    // The targets in force (plan.programme.reps, repairs included): a lift
    // without one takes its own slot's template, as on the client's device.
    // lifts[].reps fills from the first slot's template, so it is only the
    // fallback for a plan without them.
    reps: () => (isPlain(prog.reps)
      ? Object.fromEntries(Object.entries(prog.reps).filter(([, v]) => v !== null && v !== undefined))
      : Object.fromEntries(lifts.filter((l) => l.reps !== null && l.reps !== undefined).map((l) => [l.name, l.reps]))),
    // No coach line here.
    liftStates: () => ({}),
    trainerMarks: () => ({}),
    // Never sent to a trainer.
    muscleAnchors: () => ({}),
    history: () => (Array.isArray(view?.sessions) ? view.sessions : []),
    bodyweight: () => null,
    programmeBlock: () => ({ number: Number.isInteger(prog.number) ? prog.number : 1, config: isPlain(prog.config) ? prog.config : null }),
    focus: () => (typeof prog.focus === "string" && prog.focus ? prog.focus : DEFAULT_FOCUS),
    mainLifts: () => (isPlain(prog.mainLifts) ? prog.mainLifts : {}),
    addedLoads: () => (isPlain(entry?.addedLoads) ? entry.addedLoads : {}),
    userWeek: () => null,
    activeDeload: () => (plan?.deload?.active === true ? { coached: true } : null),
    travel: () => false,
    inRecovery: () => false,
  };
}

/**
 * The trainer device's sinks: every client write stays in the session, the
 * draft goes to CD, and the finished record goes to the change route.
 * @param {string} ref  the grant
 * @param {{
 *   letter: string, name?: string | null, plan?: any, entry?: CoachDraft | null,
 *   post?: (body: any) => Promise<{ status: number, body: any }>,
 * }} opts  post sends a body to POST /api/trainer/change (ref and today added by the caller)
 */
export function coachedSinks(ref, { letter, name = null, plan = null, entry = null, post }) {
  // Added loads on pure bodyweight lifts: session-local, in P.setAddedLoad's shape.
  /** @type {Record<string, { kg: number, updatedAt: string }>} */
  let added = isPlain(entry?.addedLoads) ? { ...entry.addedLoads } : {};
  /**
   * @param {string} lift
   * @param {number | null} kg
   */
  const addedLoad = (lift, kg) => {
    if (!lift || typeof kg !== "number" || !Number.isFinite(kg) || kg < 0) return added;
    const rounded = Math.round(kg * 100) / 100;
    if ((added[lift]?.kg ?? 0) === rounded) return added;
    added = { ...added, [lift]: { kg: rounded, updatedAt: new Date().toISOString() } };
    return added;
  };
  /**
   * The finished record to the change route: a dry run, or the send. A send
   * that answers 200 removes this ref's draft (CD.clear), and nothing else does.
   * @param {{ record: any, drum: Record<string, number>, setId: string, dryRun: boolean }} s
   */
  const send = async ({ record, drum, setId, dryRun }) => {
    if (!post) return { status: 0, body: {} };
    const body = {
      set: { id: setId, ops: [{ kind: "session", record, drum }] },
      basis: { programme: { number: record?.blockNumber ?? null } },
      ...(dryRun ? { dryRun: true } : {}),
    };
    const r = await post(body).catch(() => ({ status: 0, body: {} }));
    if (!dryRun && r.status === 200 && r.body?.sent) CD.clear(ref);
    return r;
  };
  return {
    // W, R, the bodyweight and travel are the client's: never written here.
    /** @param {Record<string, any>} _next */
    saveW: (_next) => {},
    /** @param {Record<string, any>} _next */
    saveR: (_next) => {},
    addedLoad,
    /** @param {number} _kg */
    bodyweight: (_kg) => {},
    /** @param {boolean} _on */
    travel: (_on) => {},
    draft: {
      // The letter the pane picked; there is no intent store on this device.
      take: () => ({ sessionIdx: Math.max(0, LETTERS.indexOf(letter)) }),
      load: () => {
        const e = CD.load(ref);
        return e ? { draft: e.draft, ageMs: Date.now() - (Number(e.savedAt) || 0) } : null;
      },
      /**
       * WRITE: this ref's entry in forge:coachDraft, overwritten on every set.
       * The set id stays; a reviewed duration goes, as the record has moved.
       * @param {any} draft
       * @param {{ swaps?: any, sessionWeights?: any, sessionReps?: any }} [state]
       */
      save: (draft, state = {}) => {
        if (!draft) return;
        CD.save(ref, {
          letter, name, plan, draft,
          swaps: state.swaps ?? {}, sessionWeights: state.sessionWeights ?? {}, sessionReps: state.sessionReps ?? {},
          addedLoads: added, readiness: draft.readiness ?? null, readinessReason: draft.readinessReason ?? null,
          setId: CD.load(ref)?.setId ?? null,
        });
      },
      /** What Review keeps with the draft: its set id and first duration. */
      held: () => {
        const e = CD.load(ref);
        return {
          setId: typeof e?.setId === "string" && e.setId ? e.setId : null,
          duration: typeof e?.duration === "number" && Number.isFinite(e.duration) ? e.duration : null,
        };
      },
      /**
       * WRITE: the set id and duration Review uses, onto this ref's entry.
       * @param {{ setId?: string | null, duration?: number | null }} fields
       */
      hold: (fields) => CD.hold(ref, fields),
      // A coached Quit pauses: the draft stays until its Send, or Discard.
      clear: () => {},
    },
    // Nothing is written on this device at the finish: the record goes to Review.
    finish: () => null,
    send,
    // DELETE: the trainer's confirmed "Discard this session", this ref's draft only.
    discard: () => CD.clear(ref),
  };
}

/**
 * The draft as it can be sent: each lift's first ten sets (the route refuses
 * more). A copy; the draft itself keeps every set. Pure.
 * @param {any} draft  newDraftLog's draft
 * @returns {{ draft: any, over: string[] }}  over: the lifts that held more
 */
export function capDraftSets(draft) {
  /** @type {string[]} */
  const over = [];
  if (!isPlain(draft?.blocks)) return { draft, over };
  const copy = JSON.parse(JSON.stringify(draft));
  for (const b of Object.values(copy.blocks)) {
    for (const e of Object.values(isPlain(b?.exercises) ? b.exercises : {})) {
      if (Array.isArray(e?.sets) && e.sets.length > COACH_MAX_SETS) {
        e.sets = e.sets.slice(0, COACH_MAX_SETS);
        if (!over.includes(e.name)) over.push(e.name);
      }
    }
  }
  return { draft: copy, over };
}

/**
 * The drum at the finish, as the change carries it: today's plan weights for
 * the lifts the record names, finite and not negative.
 * @param {any} record  finaliseDraft's record
 * @param {Record<string, any>} sessionWeights
 * @returns {Record<string, number>}
 */
export function sessionDrum(record, sessionWeights) {
  const names = new Set();
  for (const b of Array.isArray(record?.blocks) ? record.blocks : []) {
    for (const e of Array.isArray(b?.exercises) ? b.exercises : []) if (typeof e?.name === "string") names.add(e.name);
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(sessionWeights || {})) {
    if (names.has(k) && typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * The record on the day the trainer picked at Send: the date and the fields
 * that follow from it, and the duration held to the route's bound (a draft
 * resumed the next day would otherwise count the night).
 * @param {any} record
 * @param {string} day  "YYYY-MM-DD"
 */
export function recordOnDay(record, day) {
  return {
    ...record,
    date: day,
    dow: jsDow(day),
    weekStart: mondayOfWeekIso(day),
    duration: Math.min(Math.max(0, Math.round(Number(record?.duration) || 0)), MAX_DURATION_S),
  };
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A change set id (lib/trainer-change.js SET_ID_RE), minted when Review opens. */
export function mintSessionSetId() {
  const bytes = new Uint8Array(26);
  globalThis.crypto.getRandomValues(bytes);
  return `hws_${Array.from(bytes, (b) => B32[b & 31]).join("")}`;
}

// The signed-in trainer's name, in memory only (never written to the device):
// the pane sets it before it opens a session, and Face ID on Send needs it.
/** @type {string | null} */
let trainerName = null;
export const coachTrainer = {
  /** @param {unknown} name */
  set: (name) => { trainerName = typeof name === "string" && name.trim() ? name.trim() : null; },
  get: () => trainerName,
};

/** "A" → 0. The letter the pane asked for, else -1. @param {unknown} letter */
export const letterIndex = (letter) => (typeof letter === "string" ? LETTERS.indexOf(letter.toUpperCase()) : -1);
/** 0 → "A". @param {number} idx */
export const letterOf = (idx) => LETTERS[idx] ?? null;
/** "Strength A". @param {number} idx */
export const sessionNameOf = (idx) => SESSIONS[idx]?.name ?? null;
