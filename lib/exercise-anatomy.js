// lib/exercise-anatomy.js
// ─────────────────────────────────────────────────────────────────────────────
// Maps each exercise to its primary muscle target and weighted secondary
// contributions. Used by the analytics layer to compute honest volume per
// muscle group — a Squat doesn't "only train legs," it builds quads heavily
// + glutes / hams / calves / core meaningfully + grip a little.
//
// Weights are deliberately conservative:
//   1.0   — primary mover
//   0.4-0.6 — meaningful co-activation in the working range (e.g. glutes on squat)
//   0.2-0.3 — moderate involvement (e.g. core on squat, triceps on bench)
//   0.1-0.15 — minimal/stabiliser (e.g. calves on squat, forearms on row)
//
// Don't inflate weights. The whole point of secondary tagging is to show where
// compounds CAN'T fully replace direct work. If a 0.5 weight on calves means
// 12 squat sets gives you "6 effective calf sets," users will skip direct calf
// work and wonder why their calves don't grow. The honest version says "calves
// get a tiny bit from squats; you still need direct calf raises."
//
// ─── Muscle categories ───────────────────────────────────────────────────────
// Visible in Performance Lab chart (9 groups):
//   Quads, Glutes, Hamstrings, Calves
//   Chest, Back, Shoulders
//   Arms (chart aggregates biceps + triceps for visual simplicity)
//   Core
//
// Internal tracking (more granular — engine + future detail views):
//   Quads, Glutes, Hamstrings, Calves
//   Chest, Back (lats + mid back)
//   Front Delts, Side Delts, Rear Delts (charted as "Shoulders")
//   Biceps, Triceps (charted as "Arms")
//   Core, Forearms
// ─────────────────────────────────────────────────────────────────────────────

// Internal muscle keys — granular for analysis, aggregated for display.
export const MUSCLES = {
  QUADS: "Quads",
  GLUTES: "Glutes",
  HAMS: "Hamstrings",
  CALVES: "Calves",
  CHEST: "Chest",
  BACK: "Back",
  FRONT_DELTS: "Front Delts",
  SIDE_DELTS: "Side Delts",
  REAR_DELTS: "Rear Delts",
  BICEPS: "Biceps",
  TRICEPS: "Triceps",
  FOREARMS: "Forearms",
  CORE: "Core",
};

// Display aggregation — maps internal keys to chart buckets. The chart shows
// 9 buckets; the engine still tracks all 13 internally.
export const DISPLAY_BUCKET = {
  Quads: "Quads",
  Glutes: "Glutes",
  Hamstrings: "Hamstrings",
  Calves: "Calves",
  Chest: "Chest",
  Back: "Back",
  "Front Delts": "Shoulders",
  "Side Delts": "Shoulders",
  "Rear Delts": "Shoulders",
  Biceps: "Arms",
  Triceps: "Arms",
  Forearms: "Arms",
  Core: "Core",
};

// ─── Movement pattern defaults ───────────────────────────────────────────────
// Used when a specific exercise isn't in EXERCISE_ANATOMY but matches a known
// pattern. Pattern detection is by name keywords — see resolveByPattern below.
export const PATTERN_DEFAULTS = {
  squat: {
    primary: "Quads",
    secondary: { Glutes: 0.5, Hamstrings: 0.25, Core: 0.3, Calves: 0.15 },
  },
  // Hinge: RDL, SLDL, good morning, pull-through, KB swing. Hip-dominant
  // with hamstrings lengthening under load. Erectors work isometrically.
  hinge: {
    primary: "Hamstrings",
    secondary: { Glutes: 0.6, Back: 0.35, Core: 0.3, Forearms: 0.25 },
  },
  lunge: {
    primary: "Quads",
    secondary: { Glutes: 0.5, Hamstrings: 0.2, Calves: 0.2, Core: 0.25 },
  },
  bench: {
    primary: "Chest",
    secondary: { Triceps: 0.4, "Front Delts": 0.3 },
  },
  press: {
    // Default for vertical/overhead pressing
    primary: "Front Delts",
    secondary: { Triceps: 0.4, "Side Delts": 0.2, Core: 0.15 },
  },
  row: {
    primary: "Back",
    secondary: { Biceps: 0.4, "Rear Delts": 0.3, Forearms: 0.2 },
  },
  pulldown: {
    primary: "Back",
    secondary: { Biceps: 0.4, "Rear Delts": 0.2 },
  },
  pullup: {
    primary: "Back",
    secondary: { Biceps: 0.5, "Rear Delts": 0.2, Core: 0.2, Forearms: 0.2 },
  },
  curl: {
    primary: "Biceps",
    secondary: { Forearms: 0.3 },
  },
  extension: {
    // Tricep extension family
    primary: "Triceps",
    secondary: {},
  },
  raise_side: {
    primary: "Side Delts",
    secondary: { "Front Delts": 0.15, "Rear Delts": 0.1 },
  },
  raise_rear: {
    primary: "Rear Delts",
    secondary: { Back: 0.2 },
  },
  fly: {
    primary: "Chest",
    secondary: { "Front Delts": 0.2 },
  },
  hip_thrust: {
    primary: "Glutes",
    secondary: { Hamstrings: 0.3, Core: 0.2 },
  },
  glute_isolation: {
    primary: "Glutes",
    secondary: { Hamstrings: 0.15 },
  },
  ham_curl: {
    primary: "Hamstrings",
    secondary: { Calves: 0.1 },
  },
  calf: {
    primary: "Calves",
    secondary: {},
  },
  core: {
    primary: "Core",
    secondary: {},
  },
  power: {
    // Olympic lifts — full body explosive. Hip-dominant pull; catch is brief.
    // Quads assist first pull but not the prime mover. Calves for triple ext.
    primary: "Hamstrings",
    secondary: { Glutes: 0.6, Back: 0.5, Quads: 0.3, "Front Delts": 0.25, Calves: 0.25, Forearms: 0.35, Core: 0.4 },
  },
  carry: {
    primary: "Forearms",
    secondary: { Core: 0.5, Back: 0.3, "Side Delts": 0.2 },
  },
};

// ─── Hand-tuned anatomy for the baseline SESSIONS programme ──────────────────
// Every exercise that appears in the default Days A/B/C is explicitly mapped
// here with considered weights. Pool variants fall back to PATTERN_DEFAULTS
// (see resolveByPattern below) for now; can be refined post-launch.
//
// Schema: { primary: <muscle>, secondary: { <muscle>: <weight 0..1> } }
export const EXERCISE_ANATOMY = {
  // ── Day A · Squat & Push ──────────────────────────────────────────────────
  "Barbell Back Squat": {
    primary: "Quads",
    secondary: { Glutes: 0.5, Hamstrings: 0.25, Core: 0.3, Calves: 0.15 },
  },
  "Barbell Bench Press": {
    primary: "Chest",
    secondary: { Triceps: 0.4, "Front Delts": 0.3 },
  },
  "Barbell Reverse Lunge": {
    primary: "Quads",
    secondary: { Glutes: 0.55, Hamstrings: 0.25, Calves: 0.2, Core: 0.2 },
  },
  "Chest-Supported DB Row": {
    primary: "Back",
    secondary: { Biceps: 0.4, "Rear Delts": 0.35, Forearms: 0.2 },
  },
  // Hip Thrust: Glute-dominant with minimal hamstring (Contreras 2015 EMG).
  // Quads assist lockout. Core stabilizes but not heavily loaded.
  "Barbell Hip Thrust": {
    primary: "Glutes",
    secondary: { Hamstrings: 0.25, Core: 0.15, Quads: 0.15 },
  },
  // Landmine Press: Angled arc emphasizes upper chest more than strict OHP.
  // Anti-rotation demand = high core involvement. Standing version adds legs.
  "Landmine Press": {
    primary: "Front Delts",
    secondary: { Chest: 0.45, Triceps: 0.3, Core: 0.3, "Side Delts": 0.1 },
  },
  "Hanging Leg Raise": {
    primary: "Core",
    secondary: { Forearms: 0.3 }, // grip from the dead hang
  },
  "Dead Bug": {
    primary: "Core",
    secondary: {},
  },
  "Standing Calf Raise": {
    primary: "Calves",
    secondary: {},
  },

  // ── Day B · Hinge & Pull ──────────────────────────────────────────────────
  // Hex Bar: More quad-dominant than conventional due to handle position. EMG
  // studies (Camara 2016) show similar quad activation to squats. Back works
  // hard isometrically. Traps assist lockout.
  "Hex Bar Deadlift": {
    primary: "Quads",
    secondary: { Glutes: 0.6, Hamstrings: 0.5, Back: 0.45, Forearms: 0.35, Core: 0.35, Calves: 0.1 },
  },
  // OHP: Front delts primary with triceps assisting lockout. Side delts
  // stabilize abduction. Upper chest assists initial drive off shoulders.
  // Core works hard to prevent hyperextension under load.
  "Barbell Overhead Press": {
    primary: "Front Delts",
    secondary: { Triceps: 0.4, "Side Delts": 0.25, Core: 0.3, Chest: 0.1 },
  },
  "Leg Press": {
    primary: "Quads",
    secondary: { Glutes: 0.4, Hamstrings: 0.2, Calves: 0.15 },
  },
  // Pull-Up: Lats primary. EMG shows biceps ~40-50% of lat activation.
  // Core works hard for stability; forearms for grip endurance.
  "Pull-Up": {
    primary: "Back",
    secondary: { Biceps: 0.45, "Rear Delts": 0.2, Core: 0.3, Forearms: 0.35 },
  },
  // BSS: Unilateral quad-dominant with high glute stretch at bottom.
  // Core works hard for balance. Rear leg hip flexor gets passive stretch.
  "Bulgarian Split Squat": {
    primary: "Quads",
    secondary: { Glutes: 0.6, Hamstrings: 0.2, Calves: 0.15, Core: 0.3 },
  },
  "Machine Hamstring Curl": {
    primary: "Hamstrings",
    secondary: { Calves: 0.1 },
  },
  "Copenhagen Plank": {
    primary: "Core",
    secondary: { Glutes: 0.2 }, // adductors don't have their own bucket; tracked here
  },
  "Lateral Raise": {
    primary: "Side Delts",
    secondary: { "Front Delts": 0.1, "Rear Delts": 0.1 },
  },
  "Tricep Pushdown": {
    primary: "Triceps",
    secondary: {},
  },

  // ── Day C · Power & Volume ────────────────────────────────────────────────
  // Power Clean: Hip-dominant explosive pull. Quads contribute to first pull
  // but briefly; catch/front rack is momentary. Back (traps/erectors) works
  // hard throughout. Calves for triple extension. Shoulders catch but briefly.
  "Power Clean": {
    primary: "Hamstrings",
    secondary: { Glutes: 0.6, Back: 0.5, Quads: 0.3, "Front Delts": 0.25, Calves: 0.25, Forearms: 0.35, Core: 0.4 },
  },
  "DB Walking Lunge": {
    primary: "Quads",
    secondary: { Glutes: 0.55, Hamstrings: 0.25, Calves: 0.2, Core: 0.25 },
  },
  // Pull-Through: Hip hinge pattern with constant cable tension. Glutes
  // dominate lockout; hamstrings stretch under load. Less back than RDL.
  "Cable Pull-Through": {
    primary: "Glutes",
    secondary: { Hamstrings: 0.45, Core: 0.2, Back: 0.15 },
  },
  // Incline Press: Upper pec emphasis shifts load toward front delts. EMG
  // shows ~30-40% more anterior delt activation vs flat bench (Trebs 2010).
  "Incline DB Press": {
    primary: "Chest",
    secondary: { "Front Delts": 0.45, Triceps: 0.3 },
  },
  // Seated Cable Row: Mid-back dominant (rhomboids, mid traps). Constant
  // tension = good bicep stimulus. Rear delts assist horizontal pull.
  "Seated Cable Row": {
    primary: "Back",
    secondary: { Biceps: 0.4, "Rear Delts": 0.25, Core: 0.15, Forearms: 0.2 },
  },
  "DB Curl": {
    primary: "Biceps",
    secondary: { Forearms: 0.3 },
  },
  // Dips: Depends on torso angle. Upright = tricep-dominant; forward lean
  // = more chest. Programme cue is "tricep dips" so assume upright form.
  // Chest still works, especially at depth. Delts stabilize throughout.
  "Tricep Dips": {
    primary: "Triceps",
    secondary: { Chest: 0.35, "Front Delts": 0.25 },
  },
  "Skullcrusher": {
    primary: "Triceps",
    secondary: {},
  },
  // Face Pull: External rotation + horizontal abduction = rear delts + rotator
  // cuff. Mid-traps and rhomboids assist retraction. Biceps work to pull.
  "Face Pull": {
    primary: "Rear Delts",
    secondary: { Back: 0.35, Biceps: 0.2, "Side Delts": 0.15 },
  },
  "Low-to-High Cable Crossover": {
    primary: "Chest",
    secondary: { "Front Delts": 0.2 },
  },
};

// ─── Pattern resolver ────────────────────────────────────────────────────────
// For exercises not in EXERCISE_ANATOMY, infer from name keywords. Order
// matters — more specific patterns checked first so "RDL" doesn't match
// "deadlift" if we later distinguish them.
function resolveByPattern(name) {
  const lower = name.toLowerCase();

  // Specific compound names first
  if (/clean|snatch|jerk/.test(lower)) return PATTERN_DEFAULTS.power;
  if (/farmer|carry|suitcase/.test(lower)) return PATTERN_DEFAULTS.carry;

  // Hinge family — RDL, deadlift, good morning, pull-through
  if (/rdl|romanian|stiff[- ]?leg|good morning|pull-through|kettlebell swing|swing/.test(lower)) return PATTERN_DEFAULTS.hinge;
  if (/deadlift/.test(lower)) return PATTERN_DEFAULTS.hinge;

  // Hip thrust / glute bridge family
  if (/hip thrust|glute bridge|glute kickback|kickback|cable abduction|hip abduction/.test(lower)) return PATTERN_DEFAULTS.hip_thrust;
  if (/clamshell|fire hydrant/.test(lower)) return PATTERN_DEFAULTS.glute_isolation;

  // Hamstring isolation
  if (/ham(string)? curl|leg curl|nordic/.test(lower)) return PATTERN_DEFAULTS.ham_curl;

  // Calf
  if (/calf raise|calf press/.test(lower)) return PATTERN_DEFAULTS.calf;

  // Squat family — covers BSS, lunge, step-up, hack, leg press, belt squat etc
  if (/lunge|step[- ]?up|split squat/.test(lower)) return PATTERN_DEFAULTS.lunge;
  if (/squat|leg press|hack|pendulum|sissy/.test(lower)) return PATTERN_DEFAULTS.squat;

  // Press family
  if (/bench press|incline press|decline press|chest press|floor press|push[- ]?up/.test(lower)) return PATTERN_DEFAULTS.bench;
  if (/overhead press|shoulder press|military|landmine press|arnold|seated press|push press/.test(lower)) return PATTERN_DEFAULTS.press;

  // Pull family
  if (/pull[- ]?up|chin[- ]?up/.test(lower)) return PATTERN_DEFAULTS.pullup;
  if (/pulldown|straight[- ]?arm/.test(lower)) return PATTERN_DEFAULTS.pulldown;
  if (/row/.test(lower)) return PATTERN_DEFAULTS.row;

  // Isolation
  if (/curl|hammer/.test(lower)) return PATTERN_DEFAULTS.curl;
  if (/skullcrusher|tricep|extension|kickback|pushdown|overhead extension/.test(lower)) return PATTERN_DEFAULTS.extension;
  if (/lateral raise|side raise|lu raise/.test(lower)) return PATTERN_DEFAULTS.raise_side;
  if (/rear delt|reverse fly|face pull|band pull[- ]?apart/.test(lower)) return PATTERN_DEFAULTS.raise_rear;
  if (/fly|crossover/.test(lower)) return PATTERN_DEFAULTS.fly;

  // Core
  if (/plank|crunch|raise|sit[- ]?up|dead bug|bird dog|wood chop|ab wheel|rollout|copenhagen/.test(lower)) return PATTERN_DEFAULTS.core;

  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve anatomy for an exercise name. Falls back through:
 *   1. EXERCISE_ANATOMY (hand-tuned)
 *   2. resolveByPattern (movement-pattern defaults)
 *   3. null (caller decides — analytics treats as "primary muscle gets 1.0, no secondaries")
 */
export function getAnatomy(exerciseName) {
  if (!exerciseName) return null;
  if (EXERCISE_ANATOMY[exerciseName]) return EXERCISE_ANATOMY[exerciseName];
  return resolveByPattern(exerciseName);
}

/**
 * Distribute a value (sets, volume, or any other scalar) across muscles by
 * anatomy weights. Generic primitive used by both sets-based and volume-based
 * aggregations in analytics.js.
 *
 * Example: distributeAcrossMuscles("Barbell Back Squat", 500, "Quadriceps")
 *   → { Quads: 500, Glutes: 250, Hamstrings: 125, Core: 150, Calves: 75 }
 *
 * @param {string} exerciseName
 * @param {number} value     Scalar to distribute (sets count, volume kg, etc.)
 * @param {string} [fallbackMuscle]   If anatomy resolution fails, all value
 *                                    goes to this muscle. Pass exercise.muscle.
 * @returns {Record<string, number>}
 */
export function distributeAcrossMuscles(exerciseName, value, fallbackMuscle = null) {
  const anatomy = getAnatomy(exerciseName);
  const out = {};
  if (anatomy) {
    out[anatomy.primary] = value;
    for (const [muscle, weight] of Object.entries(anatomy.secondary || {})) {
      out[muscle] = (out[muscle] || 0) + value * weight;
    }
  } else if (fallbackMuscle) {
    out[fallbackMuscle] = value;
  }
  return out;
}

/**
 * Compute the muscle contribution map for a single exercise log (sets-based).
 * Thin wrapper around distributeAcrossMuscles for set count.
 *
 * @param {string} exerciseName
 * @param {number} sets   Number of working sets performed
 * @param {string} [fallbackMuscle]
 * @returns {Record<string, number>}
 */
export function computeMuscleContribution(exerciseName, sets, fallbackMuscle = null) {
  return distributeAcrossMuscles(exerciseName, sets, fallbackMuscle);
}

/**
 * Aggregate muscle contributions across many sessions, with display bucketing.
 * Returns { [displayBucket]: totalWeightedSets }.
 *
 * @param {Array<{ blocks: Array<{ exercises: Array<{ name, muscle, sets }> }> }>} sessions
 * @returns {Record<string, number>}
 */
export function aggregateBucketedVolume(sessions) {
  const totals = {}; // displayBucket → sets
  for (const session of sessions || []) {
    for (const block of session.blocks || []) {
      for (const ex of block.exercises || []) {
        const setsCount = (ex.sets || []).filter(s => s.weight !== null || s.reps).length;
        if (setsCount === 0) continue;
        const contrib = computeMuscleContribution(ex.name, setsCount, ex.muscle);
        for (const [muscle, value] of Object.entries(contrib)) {
          const bucket = DISPLAY_BUCKET[muscle] || muscle;
          totals[bucket] = (totals[bucket] || 0) + value;
        }
      }
    }
  }
  return totals;
}
