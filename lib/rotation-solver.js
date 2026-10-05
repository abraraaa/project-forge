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
//   1. Filters: load profile and cross-slot uniqueness are hard. Recency
//      memory (ROTATION_MEMORY_BLOCKS) is honoured on the first solve; if
//      that week breaks a band, the whole week is solved again without it
//      and kept only if it breaks fewer (see solveRotation).
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
//   4. One bounded repair pass: while any muscle sits out of band (or a day
//      is over its CNS budget, step 5), take the single slot swap with the
//      best improvement (argmax here — the repair's job is correctness, not
//      variety).
//   5. Session CNS budget (see sessionCnsLoad / dayBudget below). Step 2
//      samples on the volume objective as before; if the pick would put a
//      day over budget while another candidate would not, it samples again
//      among the candidates that would not. Unfilled slots count at their
//      cheapest pick, so the check never sees a breach the finished week
//      wouldn't have. Step 4 scores volume objective + a penalty per day
//      over budget (zero within budget). A week the volume solver already
//      keeps within budget is therefore solved identically.
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
  applyFocusToSession,
} from "./programme.js";
import { computeWeeklyVolume, VOLUME_TARGETS, classifyVolume } from "./volume-audit.js";
import { getAnatomy } from "./exercise-anatomy.js";
import { getLiftProfile } from "./lift-translations.js";

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
function volumeFor(config, focus, mainLifts) {
  const rotated = SESSIONS.map((s) => applyRotationToSession(s, config));
  return computeWeeklyVolume(rotated, { focus, config, mainLifts });
}

// ─── Session CNS budget ──────────────────────────────────────────────────────
// Every loaded compound costs CNS, mains included; the volume objective alone
// can't see that a squat day with a split squat AND a loaded hip thrust is a
// heavier session than a power-clean day with the same thrust.
//
// Accessory cost, from its lift profile (category x factor, factor capped at
// 1 so a machine's load ratio doesn't read as extra fatigue):
//   power, lower_compound, accessory_compound (by factor) — highest base
//   upper_push, upper_pull — moderate base
//   isolation, arms, bodyweight, and any lift with no external load — low
// A main is worked heavy whatever the variant, so it costs its category base
// (no factor: a front squat moves less weight than a back squat, not less
// effort) x MAIN_LOAD_MULTIPLIER: a primary main twice, a secondary main
// (SESSIONS load:"secondary") once. Mains are costed as programmed in
// SESSIONS, so a chosen variant (some read as isolation in the lift
// profiles) never changes a day's room.
//
// Each session has the same cap; its mains spend it first, and dayBudget is
// what they leave for accessories. Two primary mains (A) leave the least
// room, one main (C) the most. The cap puts every A that pairs the squat and
// a lunge (ass1-A is all lunges and split squats) with a loaded hip thrust,
// glute bridge or B-stance thrust over budget, lightest such A 4.14 against
// room 4.10, while the templates (A's ass2 defaults to a bodyweight hip
// extension) sit inside theirs.
// tests/rotation-balance.test.js pins both sides.
const CNS_BASE = { power: 3, lower_compound: 3, accessory_compound: 3, upper_push: 1.5, upper_pull: 1.5 };
const CNS_LOW = 0.25;
export const MAIN_LOAD_MULTIPLIER = { primary: 2, secondary: 1 };
export const SESSION_CNS_CAP = 13.1;

// Over budget costs like a set out of band per unit of overage, plus a flat
// step so the repair pass clears even a small breach unless a band would pay
// more for it.
const CNS_STEP = 100;
const CNS_WEIGHT = HARD_WEIGHT;

/**
 * CNS cost of one exercise. `load` is the main block's load ("primary" |
 * "secondary"); omit it for an accessory.
 * @param {{ name?: string, weight?: number | null } | null | undefined} ex
 * @param {string} [load]
 */
export function cnsCost(ex, load) {
  if (!ex?.name) return 0;
  const { category, factor } = getLiftProfile(ex.name);
  const base = CNS_BASE[category];
  if (!base) return CNS_LOW;
  if (load) return base * (MAIN_LOAD_MULTIPLIER[load] ?? MAIN_LOAD_MULTIPLIER.primary);
  // Accessories without external load (bodyweight, bands) are cheap whatever
  // their category.
  if (ex.weight == null) return CNS_LOW;
  return base * Math.min(1, factor);
}

const NO_BUMPS = new Set();

/** CNS cost of a session's main blocks alone. @param {any} session */
function mainsCnsLoad(session) {
  let total = 0;
  for (const b of session?.blocks || []) {
    if (b.type === "main" && b.ex) total += cnsCost(b.ex, b.load || "primary");
  }
  return total;
}

/**
 * A session's CNS load as it will be trained: its mains as programmed, plus
 * its accessories with the rotation config and then the focus applied
 * (Strong drops and substitutes blocks). Main-lift choices don't move it
 * (see above). Pure.
 * @param {any} session  one SESSIONS entry
 * @param {object} [config]  rotation config
 * @param {{ focus?: string }} [opts]
 */
export function sessionCnsLoad(session, config = {}, { focus = DEFAULT_FOCUS } = {}) {
  // An empty bump set: Sculpt only adds sets, which the cost never reads, so
  // the week-level bump computation (the solver's hot path) is skipped.
  const trained = applyFocusToSession(applyRotationToSession(session, config), focus, config, {}, NO_BUMPS);
  let total = mainsCnsLoad(session);
  for (const b of trained?.blocks || []) {
    if (b.type === "main") continue;
    for (const ex of [b.ex, b.exA, b.exB]) total += cnsCost(ex);
  }
  return total;
}

/**
 * The CNS room a session's mains leave for its accessories. Pure.
 * @param {any} session  one SESSIONS entry
 */
export function dayBudget(session) {
  return SESSION_CNS_CAP - mainsCnsLoad(session);
}

// How far each day's accessories run over its dayBudget (0 when within):
// accessories minus room is the session's whole load minus the cap.
function cnsOverages(config, focus) {
  return SESSIONS.map((s) => Math.max(0, sessionCnsLoad(s, config, { focus }) - SESSION_CNS_CAP));
}

function cnsPenalty(config, focus) {
  let cost = 0;
  for (const over of cnsOverages(config, focus)) {
    if (over > 1e-9) cost += CNS_STEP + CNS_WEIGHT * over;
  }
  return cost;
}

// The cheapest pick per slot the focus may draw from: what the greedy fill
// counts an unfilled slot as, so a partial week is never charged for a
// breach its finished form can avoid.
function cheapestPicks(focus) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
    let best = null;
    for (const ex of poolFor(key, slot, focus)) if (!best || cnsCost(ex) < cnsCost(best)) best = ex;
    if (best) out[key] = best;
  }
  return out;
}

function recentNamesFor(entry) {
  if (Array.isArray(entry)) return entry;
  if (typeof entry === "string") return [entry];
  return [];
}

// Apart from css2-A, Strong's Triceps volume comes from bench, OHP, the bfin
// pushdown and (secondarily) css2-B's straight-arm pulldown (css3's extensions
// are dropped). A fly in css2-A (Day C's
// kept pressing slot) left Strong Triceps under MEV in ~12% of fresh solves and
// ~25% of chained ones. Under Strong this slot offers only the entries whose
// anatomy credits Triceps (the presses); the week's fly lives in cfin-B.
export const STRONG_PRESS_ONLY_SLOTS = new Set(["css2-A"]);

/** @param {{ name: string }} ex */
function creditsTriceps(ex) {
  const a = getAnatomy(ex.name);
  return !!a && (a.primary === "Triceps" || (a.secondary?.Triceps || 0) > 0);
}

/**
 * The pool a focus may draw from for a slot. Applied before the filter
 * ladder, so every fallback stays inside it.
 * @param {string} key
 * @param {{ pool: Array<{ name: string, loadProfile?: string }> }} slot
 * @param {string} focus
 */
export function poolFor(key, slot, focus) {
  if (focus !== "Strong" || !STRONG_PRESS_ONLY_SLOTS.has(key)) return slot.pool;
  const presses = slot.pool.filter(creditsTriceps);
  return presses.length ? presses : slot.pool;
}

// Filter ladder per slot — same semantics as the legacy engine.
// relaxMemory drops the recency exclusion for EVERY slot; solveRotation sets
// it for a whole second solve, never per slot. Bands are contracts, variety
// is a preference.
function candidatesFor(key, slot, history, claimed, { relaxMemory = false, focus = DEFAULT_FOCUS } = {}) {
  const { loadProfile } = slot;
  const pool = poolFor(key, slot, focus);
  const onProfile = loadProfile ? pool.filter((ex) => ex.loadProfile === loadProfile) : pool;
  const recent = relaxMemory ? [] : recentNamesFor(history[key]);
  let c = onProfile.filter((ex) => !recent.includes(ex.name) && !claimed.has(ex.name));
  if (c.length === 0 && recent.length > 1) {
    c = onProfile.filter((ex) => ex.name !== recent[0] && !claimed.has(ex.name));
  }
  if (c.length === 0) c = onProfile.filter((ex) => !claimed.has(ex.name));
  if (c.length === 0) c = pool.filter((ex) => !claimed.has(ex.name));
  if (c.length === 0) c = onProfile.length ? onProfile : pool;
  return c;
}

// Muscles a volume map leaves outside their band, honouring the focus's
// floor exemptions. Used by the repair pass and the report; solveRotation
// reads report.outOfBand to decide whether memory yields.
function hardViolations(volume, focus) {
  const profile = FOCUS_VOLUME_PROFILES[focus] || FOCUS_VOLUME_PROFILES.Forged;
  return Object.entries(VOLUME_TARGETS)
    .filter(([m, t]) => {
      const v = volume[m] || 0;
      return v > t.mrv || (v < t.mev && !profile.floorExempt.has(m));
    })
    .map(([m]) => m);
}

/**
 * Muscles a config puts out of band for this focus and these main lifts.
 * The check a main-lift change runs before deciding whether to re-plan.
 * @param {object} config
 * @param {{ focus?: string, mainLifts?: Record<string, string> }} [opts]
 * @returns {string[]}
 */
export function bandViolations(config, { focus = DEFAULT_FOCUS, mainLifts = {} } = {}) {
  return hardViolations(volumeFor(config || {}, focus, mainLifts), focus);
}

// Candidates this close to the best (relative) are treated as equal, so
// near-ties share the slot evenly instead of rounding-level anatomy weights
// deciding it. Across blocks the exclusion memory turns that into rotation.
// 1%: wider bands flatten real preferences (plan fit fell ~2-4% at 2%).
export const NEAR_TIE = 0.01;

// Softmax sample over objectives (lower = better). Temperature scales
// against the score spread so the knob behaves the same across slots.
function sampleByObjective(candidates, objectives, temperature, rng) {
  if (candidates.length === 1) return 0;
  const min = Math.min(...objectives);
  const max = Math.max(...objectives);
  const tie = NEAR_TIE * Math.abs(min);
  const gap = (o) => Math.max(0, o - min - tie);
  const spread = gap(max) || 1;
  const weights = objectives.map((o) => Math.exp(-(gap(o) / spread) / Math.max(temperature, 0.01)));
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
 * @param {object} [opts.mainLifts]    chosen anchor movements (P.getMainLifts)
 * @param {() => number} [opts.rng]    injected randomness (tests seed this)
 * @param {number} [opts.temperature]  variety knob; 0 → near-argmax, higher → looser
 * @param {number} [opts.repairPasses] bounded out-of-band repair iterations
 * @param {boolean} [opts.cnsBudget]   score the session CNS budget (default true)
 * @param {boolean} [opts.fillRedraw]  redraw a fill pick that breaches the budget (default true)
 * @returns {{ config: object, report: {
 *   volume: Record<string, number>,
 *   bands: Record<string, string>,
 *   objective: number,
 *   outOfBand: string[],
 *   memoryRelaxed: boolean,
 *   overBudget: string[],
 * }}}
 */
export function solveRotation({
  history = {},
  focus = DEFAULT_FOCUS,
  // The solver picks accessories to land each muscle in its band. A chosen
  // anchor shifts that baseline, so it has to solve against the week the user
  // will actually train.
  mainLifts = {},
  rng = Math.random,
  temperature = 0.35,
  repairPasses = 6,
  // false scores on volume alone (the pre-budget solver); for tests.
  cnsBudget = true,
  // false skips the greedy fill's over-budget redraw (repair still scores
  // the budget); for tests.
  fillRedraw = true,
} = {}) {
  const opts = { history, focus, mainLifts, rng, temperature, repairPasses, cnsBudget, fillRedraw };
  // Band beats memory. Solve with the recency memory first — variety is the
  // point of rotation. Only if the finished week still breaks a band does the
  // memory yield: solve again with it relaxed and keep whichever week has
  // fewer violations (the remembered one on a tie, so variety is never
  // spent for nothing).
  const remembered = solveOnce({ ...opts, relaxMemory: false });
  if (remembered.report.outOfBand.length === 0) return remembered;
  const relaxed = solveOnce({ ...opts, relaxMemory: true });
  return relaxed.report.outOfBand.length < remembered.report.outOfBand.length ? relaxed : remembered;
}

function solveOnce({ history, focus, mainLifts, rng, temperature, repairPasses, relaxMemory, cnsBudget, fillRedraw }) {
  const config = {};
  const claimed = new Set();
  // Repair scoring: volume objective plus the CNS budget penalty (zero
  // within budget).
  const score = (trial, volume = volumeFor(trial, focus, mainLifts)) =>
    volumeObjective(volume, focus) + (cnsBudget ? cnsPenalty(trial, focus) : 0);
  // Greedy fill: the week's total overage with unfilled slots at their
  // cheapest pick — a lower bound on the finished week's.
  const floor = cnsBudget ? cheapestPicks(focus) : {};
  const overage = (trial) => cnsOverages({ ...floor, ...trial }, focus).reduce((a, b) => a + b, 0);

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
    .map(([key, slot]) => ({ key, slot, n: candidatesFor(key, slot, history, claimed, { relaxMemory, focus }).length }))
    .sort((a, b) => a.n - b.n);

  // Greedy fill with temperature sampling. Unfilled slots implicitly sit at
  // their pool[0] default inside volumeFor (applyRotationToSession falls
  // back), so the running objective approximates the finished week rather
  // than a half-empty one.
  for (const { key, slot } of slots) {
    const candidates = candidatesFor(key, slot, history, claimed, { relaxMemory, focus });
    const objectives = candidates.map((ex) => volumeObjective(volumeFor({ ...config, [key]: ex }, focus, mainLifts), focus));
    let idx = sampleByObjective(candidates, objectives, temperature, rng);
    if (cnsBudget && fillRedraw) {
      // A pick that puts a day over budget when another candidate wouldn't:
      // sample again, same sampler, among the candidates with the least
      // overage. A pick within budget keeps its draw untouched.
      const over = candidates.map((ex) => overage({ ...config, [key]: ex }));
      const least = Math.min(...over);
      if (over[idx] > least + 1e-9) {
        const keep = over.flatMap((o, i) => (o <= least + 1e-9 ? [i] : []));
        idx = keep[sampleByObjective(keep.map((i) => candidates[i]), keep.map((i) => objectives[i]), temperature, rng)];
      }
    }
    config[key] = candidates[idx];
    claimed.add(candidates[idx].name);
  }

  // Bounded repair: while anything is out of band or a day is over its CNS
  // budget, take the single best improving swap. Argmax on purpose —
  // correctness, not variety. The budget needs it when the fill's cheapest
  // completion wasn't on offer (memory or claimed names held it back).
  for (let pass = 0; pass < repairPasses; pass++) {
    const volume = volumeFor(config, focus, mainLifts);
    const overBudget = cnsBudget && cnsPenalty(config, focus) > 0;
    if (hardViolations(volume, focus).length === 0 && !overBudget) break;

    const currentCost = score(config, volume);
    const bestSwap = (relaxMemory) => {
      let best = null;
      for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
        if (dropped(key)) continue;
        const others = new Set(
          Object.entries(config).filter(([k]) => k !== key).map(([, ex]) => ex.name),
        );
        for (const ex of candidatesFor(key, slot, history, others, { relaxMemory, focus })) {
          if (ex.name === config[key]?.name) continue;
          const cost = score({ ...config, [key]: ex });
          if (cost < currentCost && (!best || cost < best.cost)) best = { key, ex, cost };
        }
      }
      return best;
    };
    const best = bestSwap(relaxMemory);
    if (!best) break; // no improving swap exists — accept the least-bad config
    config[best.key] = best.ex;
  }

  const volume = volumeFor(config, focus, mainLifts);
  /** @type {Record<string, string>} */
  const bands = {};
  for (const [muscle, t] of Object.entries(VOLUME_TARGETS)) {
    bands[muscle] = classifyVolume(volume[muscle] || 0, t);
  }
  const outOfBand = hardViolations(volume, focus);
  // Session names whose accessories run over the day's CNS budget.
  const overBudget = cnsOverages(config, focus)
    .flatMap((over, i) => (over > 1e-9 ? [SESSIONS[i].name] : []));

  return {
    config,
    report: { volume, bands, objective: volumeObjective(volume, focus), outOfBand, memoryRelaxed: relaxMemory, overBudget },
  };
}
