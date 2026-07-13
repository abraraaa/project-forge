// @ts-check
// lib/rotation-solver.js
// ─────────────────────────────────────────────────────────────────────────────
// Volume-solving rotation — the intent layer over the old dice.
//
// REFRAME (agreed 2026-07-13): a training focus is a TARGET VOLUME SHAPE,
// and rotation solves for it. The old engine picked per-slot with local
// constraints only; measured over 400 random rotations per focus, 65–71%
// of configs walked at least one muscle out of its MEV..MRV band (Sculpt
// put Glutes over MRV in 40% of rolls — two open-loop biases, pick
// weighting and the +1 set bump, compounding unchecked). Here the band IS
// the objective, so no bias stack can walk out of it.
//
// SHAPE OF THE SOLVE (deliberately tier-2, not full joint optimisation):
//   1. Hard filters exactly as the legacy engine: load profile, recency
//      memory (ROTATION_MEMORY_BLOCKS), cross-slot uniqueness.
//   2. Greedy marginal fit, most-constrained slot first: each candidate is
//      scored by the EXACT weekly-volume objective of the config-so-far
//      with that candidate in place (exactness matters — the Sculpt +1 set
//      bump couples the two sides of a superset block, so per-slot
//      approximations lie; we recompute through the real pipeline).
//   3. TEMPERATURE, not argmax: sample softmax-style over candidate
//      objectives. A true optimiser converges on the same "best" config
//      every block — sterility is a worse bug than drift, rotation exists
//      to stay fresh. The temperature knob buys variety inside the good
//      region.
//   4. One bounded repair pass: while any muscle sits out of band, take
//      the single slot swap with the best improvement (argmax here — the
//      repair's job is correctness, not variety).
//
// The rng is INJECTED (defaults to Math.random) so tests are deterministic
// — the legacy engine's bare Math.random was untestable by construction.
//
// Focus profiles: each focus states where every landmarked muscle should
// SIT, as a position inside [MEV..MRV]. Indirect-volume muscles (mev 0 —
// Traps, Core) get ceilings, not goals: pulling them toward a target would
// make the solver chase volume nobody should chase; they only penalise
// above MRV. Strong's floorExempt set is its documented trade (isolation
// arms ride at/below the floor deliberately) — exempt from the under-MEV
// hard penalty, softly pulled to the floor rather than the middle.
// ─────────────────────────────────────────────────────────────────────────────

import {
  EXERCISE_POOLS, SESSIONS, applyRotationToSession, DEFAULT_FOCUS,
  SCULPT_ALIGNED_PRIMARIES, STRONG_DROP_BLOCK_IDS,
} from "./programme.js";
import { computeWeeklyVolume, VOLUME_TARGETS, classifyVolume } from "./volume-audit.js";

// ─── Focus → target volume shape ─────────────────────────────────────────────
// position: where in [MEV..MRV] the muscle should sit (0 = MEV, 1 = MRV).
// Landmarks: Quads mev 8 / mav 18 / mrv 22 → position 0.5 targets 15 sets.
// mev-0 muscles ignore position entirely (ceiling-only, see header).
//
// PROPOSED SHAPES — the boss vetoes/tunes these three:
//   Forged: everything mid-band. The balanced default.
//   Sculpt: visible muscles sit high (0.65); the rest hold the lower
//           productive stretch (0.3) — still trained, never neglected.
//   Strong: compound-fed muscles mid-band; isolation arms ride the floor
//           (its documented trade), never punished for being there.
export const FOCUS_VOLUME_PROFILES = {
  Forged: {
    defaultPosition: 0.5,
    positions: {},
    floorExempt: new Set(),
  },
  Sculpt: {
    defaultPosition: 0.3,
    positions: (() => {
      const p = {};
      for (const m of SCULPT_ALIGNED_PRIMARIES) p[m] = 0.65;
      return p;
    })(),
    floorExempt: new Set(),
  },
  Strong: {
    defaultPosition: 0.5,
    positions: { Biceps: 0, Triceps: 0 },
    floorExempt: new Set(["Biceps", "Triceps"]),
  },
};

// Objective weights: a set outside the band costs ~40× a set of drift from
// the soft target — bands are contracts, targets are preferences. Tuned by
// Monte Carlo (tests/rotation-solver.test.js locks flag-rate ≈ 0 with
// diversity intact).
const HARD_WEIGHT = 40;
const SOFT_WEIGHT = 1;

function targetFor(muscle, profile) {
  const t = VOLUME_TARGETS[muscle];
  if (!t) return null;                    // untargeted muscle — no opinion
  if (t.mev === 0) return null;           // ceiling-only (Traps, Core)
  const pos = profile.positions[muscle] ?? profile.defaultPosition;
  return t.mev + pos * (t.mrv - t.mev);
}

// Score a weekly-volume map against a focus profile. Lower = better.
export function volumeObjective(volume, focus = DEFAULT_FOCUS) {
  const profile = FOCUS_VOLUME_PROFILES[focus] || FOCUS_VOLUME_PROFILES.Forged;
  let cost = 0;
  for (const [muscle, t] of Object.entries(VOLUME_TARGETS)) {
    const v = volume[muscle] || 0;
    if (v > t.mrv) cost += HARD_WEIGHT * (v - t.mrv) ** 2;
    if (v < t.mev && !profile.floorExempt.has(muscle)) {
      cost += HARD_WEIGHT * (t.mev - v) ** 2;
    }
    const target = targetFor(muscle, profile);
    if (target !== null) cost += SOFT_WEIGHT * (v - target) ** 2;
  }
  return cost;
}

// Exact weekly volume for a candidate config — through the REAL pipeline
// (rotation substitution, then focus programming inside computeWeeklyVolume),
// so the Sculpt superset-bump coupling is priced correctly.
function volumeFor(config, focus) {
  const rotated = SESSIONS.map((s) => applyRotationToSession(s, config));
  return computeWeeklyVolume(rotated, { focus, config });
}

function recentNamesFor(entry) {
  if (Array.isArray(entry)) return entry;
  if (typeof entry === "string") return [entry];
  return [];
}

// Hard-filter ladder per slot — same semantics as the legacy engine.
function candidatesFor(key, slot, history, claimed) {
  const { pool, loadProfile } = slot;
  const onProfile = loadProfile ? pool.filter((ex) => ex.loadProfile === loadProfile) : pool;
  const recent = recentNamesFor(history[key]);
  let c = onProfile.filter((ex) => !recent.includes(ex.name) && !claimed.has(ex.name));
  if (c.length === 0 && recent.length > 1) {
    c = onProfile.filter((ex) => ex.name !== recent[0] && !claimed.has(ex.name));
  }
  if (c.length === 0) c = onProfile.filter((ex) => !claimed.has(ex.name));
  if (c.length === 0) c = pool.filter((ex) => !claimed.has(ex.name));
  if (c.length === 0) c = onProfile.length ? onProfile : pool;
  return c;
}

// Softmax sample over objectives (lower = better). Temperature scales
// against the score spread so the knob behaves the same across slots.
function sampleByObjective(candidates, objectives, temperature, rng) {
  if (candidates.length === 1) return 0;
  const min = Math.min(...objectives);
  const max = Math.max(...objectives);
  const spread = max - min || 1;
  const weights = objectives.map((o) => Math.exp(-((o - min) / spread) / Math.max(temperature, 0.01)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Solve a rotation: pick one exercise per accessory slot so the week's
 * volume lands on the focus's target shape, inside every band.
 *
 * @param {object} opts
 * @param {object} [opts.history]      per-slot exclusion memory (PB.history)
 * @param {string} [opts.focus]        Forged | Strong | Sculpt
 * @param {() => number} [opts.rng]    injected randomness (tests seed this)
 * @param {number} [opts.temperature]  variety knob; 0 → near-argmax, higher → looser
 * @param {number} [opts.repairPasses] bounded out-of-band repair iterations
 * @returns {{ config: object, report: {
 *   volume: Record<string, number>,
 *   bands: Record<string, string>,
 *   objective: number,
 *   outOfBand: string[],
 * }}}
 */
export function solveRotation({
  history = {},
  focus = DEFAULT_FOCUS,
  rng = Math.random,
  temperature = 0.35,
  repairPasses = 6,
} = {}) {
  const config = {};
  const claimed = new Set();

  // Slots the focus never trains don't get picks: Strong drops three
  // accessory blocks outright, and the legacy engine still rolled exercises
  // for them — phantom picks polluting the exclusion memory with movements
  // the user never performed. Their volume is zero either way (the focus
  // programming removes the blocks before counting), so skipping them
  // changes nothing downstream except keeping history honest.
  const dropped = (key) =>
    focus === "Strong" && STRONG_DROP_BLOCK_IDS.has(key.replace(/-[AB]$/, ""));

  // Most-constrained slot first: fewest hard-legal candidates.
  const slots = Object.entries(EXERCISE_POOLS)
    .filter(([key]) => !dropped(key))
    .map(([key, slot]) => ({ key, slot, n: candidatesFor(key, slot, history, claimed).length }))
    .sort((a, b) => a.n - b.n);

  // Greedy fill with temperature sampling. Unfilled slots implicitly sit at
  // their pool[0] default inside volumeFor (applyRotationToSession falls
  // back), so the running objective approximates the finished week rather
  // than a half-empty one.
  for (const { key, slot } of slots) {
    const candidates = candidatesFor(key, slot, history, claimed);
    const objectives = candidates.map((ex) => {
      const trial = { ...config, [key]: ex };
      return volumeObjective(volumeFor(trial, focus), focus);
    });
    const idx = sampleByObjective(candidates, objectives, temperature, rng);
    config[key] = candidates[idx];
    claimed.add(candidates[idx].name);
  }

  // Bounded repair: while anything is out of band, take the single best
  // improving swap. Argmax on purpose — correctness, not variety.
  for (let pass = 0; pass < repairPasses; pass++) {
    const volume = volumeFor(config, focus);
    const oob = Object.entries(VOLUME_TARGETS).filter(([m, t]) => {
      const v = volume[m] || 0;
      const profile = FOCUS_VOLUME_PROFILES[focus] || FOCUS_VOLUME_PROFILES.Forged;
      return v > t.mrv || (v < t.mev && !profile.floorExempt.has(m));
    });
    if (oob.length === 0) break;

    let best = null;
    const currentCost = volumeObjective(volume, focus);
    for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
      if (dropped(key)) continue;
      const others = new Set(
        Object.entries(config).filter(([k]) => k !== key).map(([, ex]) => ex.name),
      );
      for (const ex of candidatesFor(key, slot, history, others)) {
        if (ex.name === config[key]?.name) continue;
        const trial = { ...config, [key]: ex };
        const cost = volumeObjective(volumeFor(trial, focus), focus);
        if (cost < currentCost && (!best || cost < best.cost)) best = { key, ex, cost };
      }
    }
    if (!best) break; // no improving swap exists — accept the least-bad config
    config[best.key] = best.ex;
  }

  const volume = volumeFor(config, focus);
  /** @type {Record<string, string>} */
  const bands = {};
  /** @type {string[]} */
  const outOfBand = [];
  const profile = FOCUS_VOLUME_PROFILES[focus] || FOCUS_VOLUME_PROFILES.Forged;
  for (const [muscle, t] of Object.entries(VOLUME_TARGETS)) {
    const band = classifyVolume(volume[muscle] || 0, t);
    bands[muscle] = band;
    if (band === "over_mrv" || (band === "under_mev" && !profile.floorExempt.has(muscle))) {
      outOfBand.push(muscle);
    }
  }

  return {
    config,
    report: { volume, bands, objective: volumeObjective(volume, focus), outOfBand },
  };
}
