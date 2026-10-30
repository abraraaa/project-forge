// @ts-check
// lib/profile-actions.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure (non-React) cores of the profile actions, extracted from ForgeApp so
// the /profile route and ForgeApp's in-place gate share ONE implementation
// (PR3 3d-route, storage-as-store decision).
//
// The React halves stay with their hosts: ForgeApp wraps these with setState
// calls for the in-place path; the /profile route calls them then navigates
// home, where ForgeApp re-hydrates from localStorage naturally (local is
// canonical — the shared-state layer IS the storage).
// ─────────────────────────────────────────────────────────────────────────────

import { LS, P, F, PB, claimProfile, pushNow } from "./storage.js";
import { rotationDiff, computeRotationStimulusDelta, ROTATION_REVISED } from "./programme.js";
import { solveRotation, bandViolations, seededRng } from "./rotation-solver.js";

/**
 * Activate a profile: validate → (optionally) claim → persist as active.
 * No React state — callers reflect the result themselves (ForgeApp via
 * setState; the /profile route via navigation + remount hydration).
 *
 * @param {string} name
 * @param {{claim?: boolean}} [opts]
 * @returns {Promise<{ok: true, name: string} | {ok: false, reason: "empty"|"taken"|"network"}>}
 */
export async function activateProfileCore(name, { claim = false } = {}) {
  const trimmed = String(name).trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // Claim path: first-time signup for a new name. The claim endpoint is
  // atomic — if someone else grabbed the name between the availability
  // check and now, we get a 409 here.
  if (claim) {
    const result = await claimProfile(trimmed, trimmed);
    if (result.taken) return { ok: false, reason: "taken" };
    if (!result.ok)   return { ok: false, reason: "network" };
  }

  P.add(trimmed);
  P.setActive(trimmed);
  return { ok: true, name: trimmed };
}

/**
 * Save a training focus and re-rotate accessories within the current block
 * (history untouched, so future blocks keep the 3-block exclusion memory).
 * Persists F + PB and pushes the snapshot; returns the rotation summary so
 * the caller can surface "what changed".
 *
 * @param {string} profile
 * @param {string} focus
 * @returns {{next: object, summary: {blockNumber: number, changes: any, stimulusDelta: any}}}
 */
export function saveFocusCore(profile, focus) {
  F.save(profile, focus);
  const pb = PB.get();
  const oldConfig = pb.config;
  // Volume-solving rotation: the new focus's target volume shape drives the
  // re-pick, bands are hard constraints (see lib/rotation-solver.js). The
  // legacy dice let a focus change land a config that walked muscles out of
  // their MEV..MRV bands — Sculpt put Glutes over MRV in 40% of rolls.
  const { config: newConfig, report } = solveRotation({
    history: pb.history,
    focus,
    mainLifts: P.getMainLifts(profile),
  });
  const next = { ...pb, config: newConfig };
  PB.save(next);
  const summary = {
    blockNumber: pb.number,
    changes: rotationDiff(oldConfig, newConfig),
    stimulusDelta: computeRotationStimulusDelta(oldConfig, newConfig),
    report,
    reason: "focus",
    focus,
  };
  pushNow(profile);
  return { next, summary };
}

/**
 * Save one main-lift choice, then keep the week in band. The anchor lift feeds
 * weekly volume, so a swap (Front Squat for Back Squat) can push a muscle
 * past MRV or under MEV with the accessories unchanged. Accessories rotate at
 * block boundaries, so they are NOT reshuffled on every swap: see
 * replanForMainLifts.
 *
 * @param {string} profile
 * @param {string} canonical
 * @param {string | null} choice
 * @returns {{ mainLifts: Record<string, string>, summary: object | null }}
 */
export function saveMainLiftCore(profile, canonical, choice) {
  const mainLifts = P.setMainLift(profile, canonical, choice);
  const summary = replanForMainLifts(profile, mainLifts);
  pushNow(profile);
  return { mainLifts, summary };
}

/**
 * The seed of a main-lift change's or a reset's re-plan: the block number,
 * the main lifts (sorted, so the order they were chosen in never counts),
 * the focus and the rotation revision. Every device making the same change
 * solves the same week, so the merge has no newer week to prefer, and a
 * reset lands the same week however often it runs. A lift set back to its
 * default is stored as itself (P.setMainLift) and swaps nothing, so it is
 * left out: the same lifts give the same seed however often they were
 * changed and changed back.
 * @param {{ number?: number, mainLifts?: Record<string, string>, focus?: string }} block
 * @returns {string}
 */
export function replanSeed({ number, mainLifts, focus }) {
  const lifts = Object.entries(mainLifts || {})
    .filter(([canonical, choice]) => choice && choice !== canonical)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([number ?? null, lifts, focus ?? null, ROTATION_REVISED]);
}

/**
 * A block's accessories re-planned under these main lifts, or null when the
 * block stands: the config (the template's accessories when nothing has
 * rotated yet) is re-solved only when it breaks a band, and the solve is
 * kept only if it breaks fewer. Seeded with replanSeed. Pure.
 * @param {{ config?: object, history?: object, number?: number, focus?: string,
 *   mainLifts?: Record<string, string> }} block
 * @returns {{ config: object, report: any } | null}
 */
export function replanBlock({ config = {}, history = {}, number, focus, mainLifts = {} }) {
  const before = bandViolations(config, { focus, mainLifts });
  if (!before.length) return null;
  const rng = seededRng(replanSeed({ number, mainLifts, focus }));
  const solved = solveRotation({ history, focus, mainLifts, rng });
  return solved.report.outOfBand.length < before.length ? solved : null;
}

/**
 * Keep the block in band under these main lifts (replanBlock). Same block,
 * same history. The user's own change, a trainer's (lib/trainer-sync.js)
 * and the accessory reset all land through here, on one seed (replanSeed).
 * Writes PB when it re-plans.
 *
 * @param {string} profile
 * @param {Record<string, string>} mainLifts
 * @returns {object | null} the rotation summary, null when the block stands
 */
export function replanForMainLifts(profile, mainLifts) {
  const pb = PB.get(profile);
  const solved = replanBlock({
    config: pb.config, history: pb.history, number: pb.number, focus: F.get(profile), mainLifts,
  });
  if (!solved) return null;
  const { config: newConfig, report } = solved;
  PB.save({ ...pb, config: newConfig }, { profile });
  return {
    blockNumber: pb.number,
    changes: rotationDiff(pb.config, newConfig),
    stimulusDelta: computeRotationStimulusDelta(pb.config, newConfig),
    report,
    reason: "main_lift",
  };
}

/**
 * Reset the block's accessories to the template, then keep the week in band:
 * the template under a swapped main lift can break a band (Strong with
 * Romanian Deadlift leaves Quads under MEV), so it is re-planned the way a
 * main-lift change is. In band, the reset stands as the plain template.
 * Keeps block number and start date. Writes PB (the reset, then the re-plan
 * as an overwrite in place) and pushes.
 *
 * @param {string} profile
 * @returns {{next: object, summary: object | null}} summary: the re-plan's,
 *   as a reset's (reason "reset"), null when the reset stands as the template
 */
export function resetProgrammeCore(profile) {
  PB.reset(profile);
  const replan = replanForMainLifts(profile, P.getMainLifts(profile));
  pushNow(profile);
  return { next: PB.get(profile), summary: replan && { ...replan, reason: "reset" } };
}

/** @type {{ seed: string, config: object } | null} */
let lastReset = null;

/**
 * The accessories a reset lands on (resetProgrammeCore): the template, or its
 * seeded re-plan when it breaks a band under these main lifts. Pure. Home
 * asks on every mount and every sync, so the last answer is kept by its
 * seed, which holds every input: only a new block number, focus or main lift
 * solves again. The answer is shared; read it, never change it.
 * @param {{ number?: number, focus?: string, mainLifts?: Record<string, string> }} block
 * @returns {object}
 */
export function resetConfigFor({ number, focus, mainLifts }) {
  const seed = replanSeed({ number, mainLifts, focus });
  if (lastReset?.seed !== seed) {
    lastReset = { seed, config: replanBlock({ number, focus, mainLifts })?.config ?? {} };
  }
  return lastReset.config;
}

// One-shot handoff for the rotation summary when focus is changed on the
// /profile route: the "here's what changed" modal lives on the home shell,
// which isn't mounted at that moment. The route stashes the summary here;
// ForgeApp's seed effect takes (reads + clears) it on the next mount and
// shows the modal. DEVICE-LOCAL by design (transient UI feedback, safe to
// lose on reinstall — the underlying F/PB changes are SYNCED separately).
const pendingSummaryKey = (profile) => `forge:${profile}:pendingRotationSummary`;

export function stashRotationSummary(profile, summary) {
  if (!profile || !summary) return;
  LS.set(pendingSummaryKey(profile), summary);
}

export function takePendingRotationSummary(profile) {
  if (!profile) return null;
  const summary = LS.get(pendingSummaryKey(profile), null);
  if (summary) LS.remove(pendingSummaryKey(profile));
  return summary;
}

// One-shot handoff for first run when a name is claimed on the /profile
// route: the steps live on the home shell, which isn't mounted there. The
// route stashes the claimed name; ForgeApp's seed effect takes it on the next
// mount and opens first run when it names the active profile. Device-wide
// (one claim at a time) and device-local: a lost marker only skips the steps.
const pendingFirstRunKey = "forge:pendingFirstRun";

/** @param {string} name the name just claimed */
export function stashFirstRun(name) {
  if (!name) return;
  LS.set(pendingFirstRunKey, name);
}

/**
 * Reads and removes the marker in one step, whoever it names: a marker for
 * another name is consumed and dropped by the caller.
 * @returns {string | null}
 */
export function takePendingFirstRun() {
  let present = false;
  try { present = typeof localStorage !== "undefined" && localStorage.getItem(pendingFirstRunKey) !== null; } catch { present = false; }
  if (!present) return null;
  const name = LS.get(pendingFirstRunKey, null);
  // Removed whatever it held: a marker that fails to parse must not linger.
  LS.remove(pendingFirstRunKey);
  return typeof name === "string" && name ? name : null;
}
