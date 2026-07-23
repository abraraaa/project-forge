// @ts-check
// lib/lift-translations.js
import { inferLoadType } from "./storage.js";
// ─────────────────────────────────────────────────────────────────────────────
// Cold-start lift translations. When a user does an exercise for the first time,
// we look up its profile here to produce a sensible starting weight derived from
// their existing strength on related lifts.
//
// Approach: every exercise gets a "lift profile" that captures:
//  - primaryMuscle: which muscle group's history we look up for the anchor
//  - category: progression category (drives step size, miss tolerance, ADD threshold)
//  - anchorLift: the canonical lift in this muscle group (the reference)
//  - translationFactor: multiplier from anchor's e1RM to this lift's working weight
//  - progressesByLoad: false for accessories where reps progress, not weight
//
// Profiles are keyed by canonical exercise name. For exercises not explicitly
// listed, getLiftProfile() falls back to pattern matching on name + a sensible
// default category.
//
// Translation factors are pattern-matched from coaching norms (Israetel, Nuckols,
// Helms). They're approximations — Rail 1 (user dials in via the picker after
// session 1) ensures they self-correct quickly.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Categories ──────────────────────────────────────────────────────────────
// Step sizes per category (kg added per session when ADD signal fires):
//   lower_compound   — 2.5kg   (squat, deadlift, hip thrust)
//   upper_push       — 1.25kg  (bench, OHP, press variants)
//   upper_pull       — 1.25kg  (rows, weighted pull-ups)
//   power            — 2.5kg   (cleans — same step but higher ADD threshold)
//   accessory_compound — 1kg   (Bulgarian split squat, reverse lunge, etc.)
//   accessory_arm    — 0.5kg   (curls, tricep work)
//   accessory_isolation — 0.5kg (lateral raises, rear delt, calf)
//   bw_progression   — 0kg    (progress reps, not weight — push-ups, planks, dead bug)
//
// Miss tolerance is also category-dependent: power lifts are less forgiving on
// missed reps than accessories.
export const STEP_SIZES = {
  lower_compound:      2.5,
  upper_push:          1.25,
  upper_pull:          1.25,
  power:               2.5,
  accessory_compound:  1.0,
  accessory_arm:       0.5,
  accessory_isolation: 0.5,
  bw_progression:      0,    // weight-immutable, progress by adding reps
};

// ADD threshold per category — minimum RIR on the top set to qualify for adding
// weight. Higher = more conservative.
//   2 means "must have 2+ reps in reserve" — typical
//   3 means "must have 3+ reps in reserve" — extra cautious for power/heavy
export const ADD_THRESHOLD_RIR = {
  lower_compound:      2,
  upper_push:          2,
  upper_pull:          2,
  power:               3,    // power lifts need to be moved fast — never grind
  accessory_compound:  2,
  accessory_arm:       2,
  accessory_isolation: 2,
  bw_progression:      2,
};

// ─── Lift profiles ────────────────────────────────────────────────────────────
// Explicit profiles for the canonical and most-used lifts. Pattern matching
// fills in the rest at lookup time.
//
// Each profile: { primaryMuscle, category, translationFactor (relative to anchor),
//                 progressesByLoad, repProgressionTarget? }
const PROFILES = {
  // ─── Lower-body knee-dominant (Quadriceps anchor: Barbell Back Squat) ───
  "Barbell Back Squat":      { primaryMuscle: "Quadriceps", category: "lower_compound",     factor: 1.00, progressesByLoad: true },
  "Front Squat":             { primaryMuscle: "Quadriceps", category: "lower_compound",     factor: 0.85, progressesByLoad: true },
  "Goblet Squat":            { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.35, progressesByLoad: true },
  "Bulgarian Split Squat":   { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.30, progressesByLoad: true },
  "DB Sumo Squat":           { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.35, progressesByLoad: true },
  "Hack Squat":              { primaryMuscle: "Quadriceps", category: "lower_compound",     factor: 0.85, progressesByLoad: true },
  "Leg Press":               { primaryMuscle: "Quadriceps", category: "lower_compound",     factor: 1.50, progressesByLoad: true },
  "Leg Extension":           { primaryMuscle: "Quadriceps", category: "accessory_isolation", factor: 0.30, progressesByLoad: true },
  "Wall Sit":                { primaryMuscle: "Quadriceps", category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Lower-body hip-dominant ────────────────────────────────────────────
  "Hex Bar Deadlift":        { primaryMuscle: "Posterior",  category: "lower_compound",     factor: 1.00, progressesByLoad: true },
  "Conventional Deadlift":   { primaryMuscle: "Posterior",  category: "lower_compound",     factor: 0.95, progressesByLoad: true },
  "Sumo Deadlift":           { primaryMuscle: "Posterior",  category: "lower_compound",     factor: 0.95, progressesByLoad: true },
  "Romanian Deadlift":       { primaryMuscle: "Hamstrings", category: "lower_compound",     factor: 0.75, progressesByLoad: true },
  "Dumbbell Deadlift":       { primaryMuscle: "Posterior",  category: "accessory_compound", factor: 0.40, progressesByLoad: true },
  "Dumbbell RDL":            { primaryMuscle: "Hamstrings", category: "accessory_compound", factor: 0.30, progressesByLoad: true },
  "Good Morning":            { primaryMuscle: "Hamstrings", category: "accessory_compound", factor: 0.40, progressesByLoad: true },
  "Nordic Curl":             { primaryMuscle: "Hamstrings", category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Dumbbell Leg Curl":       { primaryMuscle: "Hamstrings", category: "accessory_isolation", factor: 0.20, progressesByLoad: true },
  "Machine Hamstring Curl":  { primaryMuscle: "Hamstrings", category: "accessory_isolation", factor: 0.30, progressesByLoad: true }, // machine carries more load than DB
  "Swiss Ball Leg Curl":     { primaryMuscle: "Hamstrings", category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // Glutes — anchor is Hip Thrust, factors vs THAT anchor
  "Barbell Hip Thrust":      { primaryMuscle: "Glutes",     category: "lower_compound",     factor: 1.00, progressesByLoad: true },
  "Banded Hip Thrust":       { primaryMuscle: "Glutes",     category: "accessory_compound", factor: 0.90, progressesByLoad: true },
  "Single-Leg Hip Thrust":   { primaryMuscle: "Glutes",     category: "accessory_compound", factor: 0.30, progressesByLoad: true },
  "Glute Bridge":            { primaryMuscle: "Glutes",     category: "accessory_compound", factor: 0.80, progressesByLoad: true },
  "Cable Pull-Through":      { primaryMuscle: "Glutes",     category: "accessory_compound", factor: 0.40, progressesByLoad: true },
  "Cable Kickback":          { primaryMuscle: "Glutes",     category: "accessory_isolation", factor: 0.20, progressesByLoad: true },
  "Donkey Kick":             { primaryMuscle: "Glutes",     category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Lateral Band Walk":       { primaryMuscle: "Glutes",     category: "bw_progression",     factor: 0,    progressesByLoad: false }, // band-resisted abductor work — progress reps

  // ─── Lunge family — Quads & Glutes mix, smaller step ────────────────────
  "Barbell Reverse Lunge":   { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.50, progressesByLoad: true },
  "DB Reverse Lunge":        { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.20, progressesByLoad: true },
  "Barbell Walking Lunge":   { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.50, progressesByLoad: true },
  "DB Walking Lunge":        { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.20, progressesByLoad: true },
  "Barbell Step-Up":         { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.40, progressesByLoad: true },
  "DB Step-Up":              { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.18, progressesByLoad: true },
  "Step-Up":                 { primaryMuscle: "Quadriceps", category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Split Squat":             { primaryMuscle: "Quadriceps", category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Upper-body horizontal push (Chest anchor: Barbell Bench Press) ─────
  "Barbell Bench Press":     { primaryMuscle: "Chest",      category: "upper_push",         factor: 1.00, progressesByLoad: true },
  "Dumbbell Bench Press":    { primaryMuscle: "Chest",      category: "upper_push",         factor: 0.45, progressesByLoad: true }, // per DB
  "Incline DB Press":        { primaryMuscle: "Chest",      category: "upper_push",         factor: 0.40, progressesByLoad: true },
  "Incline Landmine Press":  { primaryMuscle: "Chest",      category: "accessory_compound", factor: 0.45, progressesByLoad: true }, // upper-chest biased landmine
  "Single-Arm Landmine Press": { primaryMuscle: "Chest",    category: "accessory_compound", factor: 0.25, progressesByLoad: true }, // unilateral landmine
  "Pec Deck":                { primaryMuscle: "Chest",      category: "accessory_isolation", factor: 0.25, progressesByLoad: true }, // machine isolation, slightly more load than DB fly
  "DB Chest Fly":            { primaryMuscle: "Chest",      category: "accessory_isolation", factor: 0.20, progressesByLoad: true },
  "Cable Chest Fly":         { primaryMuscle: "Chest",      category: "accessory_isolation", factor: 0.30, progressesByLoad: true },
  "Low-to-High Cable Fly":   { primaryMuscle: "Chest",      category: "accessory_isolation", factor: 0.25, progressesByLoad: true }, // upper-chest variant of cable fly
  "Low-to-High Cable Crossover": { primaryMuscle: "Chest",  category: "accessory_isolation", factor: 0.25, progressesByLoad: true },
  "Push-Up":                 { primaryMuscle: "Chest",      category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Incline Push-Up":         { primaryMuscle: "Chest",      category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Close-Grip Push-Up":      { primaryMuscle: "Triceps",    category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Upper-body vertical push (Shoulders anchor: Barbell OHP) ───────────
  "Barbell Overhead Press":  { primaryMuscle: "Shoulders",  category: "upper_push",         factor: 1.00, progressesByLoad: true },
  "Dumbbell Shoulder Press": { primaryMuscle: "Shoulders",  category: "upper_push",         factor: 0.40, progressesByLoad: true },
  "Arnold Press":            { primaryMuscle: "Shoulders",  category: "upper_push",         factor: 0.40, progressesByLoad: true },
  "Landmine Press":          { primaryMuscle: "Shoulders",  category: "accessory_compound", factor: 0.50, progressesByLoad: true },
  "Pike Push-Up":            { primaryMuscle: "Shoulders",  category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Lateral Raise":           { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.10, progressesByLoad: true },
  "Seated Lateral Raise":    { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.10, progressesByLoad: true }, // seated removes momentum cheat
  "Cable Lateral Raise":     { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.12, progressesByLoad: true },
  "Rear Delt Fly":           { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.10, progressesByLoad: true },
  "Face Pull":               { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.20, progressesByLoad: true },
  "Band Face Pull":          { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.10, progressesByLoad: true },
  "Y-T-W Raise":             { primaryMuscle: "Shoulders",  category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Upper-body pull (Back anchor: Pull-Up loaded) ──────────────────────
  // Pull-Up's "weight" is the added load; effectiveLoad in the engine is BW+weight.
  // Translation factors here are relative to the user's pull-up effectiveLoad.
  "Pull-Up":                 { primaryMuscle: "Back",       category: "upper_pull",         factor: 1.00, progressesByLoad: true },
  "Weighted Pull-Up":        { primaryMuscle: "Back",       category: "upper_pull",         factor: 1.00, progressesByLoad: true }, // alias — user logs added load, engine reads effectiveLoad
  "Neutral-Grip Pull-Up":    { primaryMuscle: "Back",       category: "upper_pull",         factor: 1.00, progressesByLoad: true },
  "Wide-Grip Pull-Up":       { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.95, progressesByLoad: true },
  "Chin-Up":                 { primaryMuscle: "Back",       category: "upper_pull",         factor: 1.05, progressesByLoad: true },
  "Lat Pulldown":            { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.85, progressesByLoad: true }, // vs effectiveLoad
  "Cable Row":               { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.70, progressesByLoad: true },
  "Seated Cable Row":        { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.70, progressesByLoad: true },
  "Single-Arm Cable Row":    { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.35, progressesByLoad: true }, // half of bilateral cable row
  "Dumbbell Bent-Over Row":  { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.35, progressesByLoad: true },
  "Single-Arm DB Row":       { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.40, progressesByLoad: true }, // unilateral allows slightly heavier per-DB
  "Chest-Supported DB Row":  { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.35, progressesByLoad: true },
  "TRX Row":                 { primaryMuscle: "Back",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Cable Straight-Arm Pulldown": { primaryMuscle: "Back",   category: "accessory_isolation", factor: 0.30, progressesByLoad: true },
  "Resistance Band Pull-Down":   { primaryMuscle: "Back",   category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Resistance Band Row":     { primaryMuscle: "Back",       category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Power lifts ────────────────────────────────────────────────────────
  "Power Clean":             { primaryMuscle: "Power",      category: "power",              factor: 1.00, progressesByLoad: true },
  "Hang Clean":              { primaryMuscle: "Power",      category: "power",              factor: 0.90, progressesByLoad: true },
  "Dumbbell Hang Clean":     { primaryMuscle: "Power",      category: "accessory_compound", factor: 0.35, progressesByLoad: true },
  "Kettlebell Swing":        { primaryMuscle: "Power",      category: "accessory_compound", factor: 0.30, progressesByLoad: true },
  "Jump Squat":              { primaryMuscle: "Power",      category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Biceps ─────────────────────────────────────────────────────────────
  "Barbell Curl":            { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 1.00, progressesByLoad: true },
  "EZ Bar Curl":             { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.95, progressesByLoad: true },
  "DB Curl":                 { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.40, progressesByLoad: true },
  "Incline DB Curl":         { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.35, progressesByLoad: true }, // incline stretch position = slightly less load per DB
  "Hammer Curl":             { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.45, progressesByLoad: true },
  "Resistance Band Curl":    { primaryMuscle: "Biceps",     category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Supinated Dumbbell Curl": { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.40, progressesByLoad: true },

  // ─── Triceps ────────────────────────────────────────────────────────────
  "Tricep Dips":             { primaryMuscle: "Triceps",    category: "upper_pull",         factor: 1.00, progressesByLoad: true }, // loaded BW
  "Overhead Tricep Extension": { primaryMuscle: "Triceps",  category: "accessory_arm",      factor: 0.30, progressesByLoad: true },
  "Skullcrusher":            { primaryMuscle: "Triceps",    category: "accessory_arm",      factor: 0.35, progressesByLoad: true },
  "Tricep Pushdown":         { primaryMuscle: "Triceps",    category: "accessory_arm",      factor: 0.50, progressesByLoad: true },
  "Resistance Band Pushdown": { primaryMuscle: "Triceps",   category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Core (mostly bw_progression) ───────────────────────────────────────
  "Hanging Leg Raise":       { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Lying Leg Raise":         { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Captain's Chair Raise":   { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Toes-to-Bar":             { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Reverse Crunch":          { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Dead Bug":                { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Bird Dog":                { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Plank":                   { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Side Plank":              { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Hollow Body Hold":        { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Copenhagen Plank":        { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Pallof Press":            { primaryMuscle: "Core",       category: "accessory_isolation", factor: 0.10, progressesByLoad: true },
  "Ab Wheel":                { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Swiss Ball Curl":         { primaryMuscle: "Hamstrings", category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── Calves ─────────────────────────────────────────────────────────────────
  "Standing Calf Raise":     { primaryMuscle: "Calves",     category: "accessory_isolation", factor: 0,    progressesByLoad: true },
  "Seated Calf Raise":       { primaryMuscle: "Calves",     category: "accessory_isolation", factor: 0,    progressesByLoad: true },
  "Single-Leg Calf Raise":   { primaryMuscle: "Calves",     category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Donkey Calf Raise":       { primaryMuscle: "Calves",     category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // ─── New exercises (library expansion) ──────────────────────────────────────
  // Day A additions
  "Barbell Front Rack Lunge":  { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.45, progressesByLoad: true },
  "Deficit Reverse Lunge":     { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.45, progressesByLoad: true },
  "Meadows Row":               { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.35, progressesByLoad: true },
  "Incline DB Row":            { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.32, progressesByLoad: true },
  "Seal Row":                  { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.30, progressesByLoad: true },
  "Barbell Glute Bridge":      { primaryMuscle: "Glutes",     category: "lower_compound",     factor: 0.80, progressesByLoad: true },
  "B-Stance Hip Thrust":       { primaryMuscle: "Glutes",     category: "accessory_compound", factor: 0.70, progressesByLoad: true },
  "Frog Pump":                 { primaryMuscle: "Glutes",     category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Landmine Squeeze Press":    { primaryMuscle: "Shoulders",  category: "accessory_compound", factor: 0.45, progressesByLoad: true },
  "Kneeling Landmine Press":   { primaryMuscle: "Shoulders",  category: "accessory_compound", factor: 0.45, progressesByLoad: true },
  "Floor Press":               { primaryMuscle: "Chest",      category: "upper_push",         factor: 0.85, progressesByLoad: true },
  "Hanging Knee Raise":        { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "L-Sit Hold":                { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Windshield Wiper":          { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Stir the Pot":              { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // Day B additions
  "Pendulum Squat":            { primaryMuscle: "Quadriceps", category: "lower_compound",     factor: 0.70, progressesByLoad: true },
  "V-Squat":                   { primaryMuscle: "Quadriceps", category: "lower_compound",     factor: 0.75, progressesByLoad: true },
  "Belt Squat":                { primaryMuscle: "Quadriceps", category: "lower_compound",     factor: 0.70, progressesByLoad: true },
  "Assisted Pull-Up":          { primaryMuscle: "Back",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "DB Front Squat":            { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.30, progressesByLoad: true },
  "DB Split Squat":            { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.25, progressesByLoad: true },
  "Seated Leg Curl":           { primaryMuscle: "Hamstrings", category: "accessory_isolation", factor: 0.25, progressesByLoad: true },
  "Slider Leg Curl":           { primaryMuscle: "Hamstrings", category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Single-Leg Curl":           { primaryMuscle: "Hamstrings", category: "accessory_isolation", factor: 0.15, progressesByLoad: true },
  "Cossack Squat":             { primaryMuscle: "Quadriceps", category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Adductor Stretch Lunge":    { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Side-Lying Adduction":      { primaryMuscle: "Core",       category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Leaning Lateral Raise":     { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.12, progressesByLoad: true },
  "DB Lu Raise":               { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.10, progressesByLoad: true },
  "Band Lateral Raise":        { primaryMuscle: "Shoulders",  category: "bw_progression",     factor: 0,    progressesByLoad: false },

  // Day C additions
  "DB Lateral Lunge":          { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.20, progressesByLoad: true },
  "Curtsy Lunge":              { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.18, progressesByLoad: true },
  "Cable Hip Abduction":       { primaryMuscle: "Glutes",     category: "accessory_isolation", factor: 0.18, progressesByLoad: true },
  "Standing Cable Hip Extension": { primaryMuscle: "Glutes", category: "accessory_compound", factor: 0.25, progressesByLoad: true },
  "Banded Glute Bridge":       { primaryMuscle: "Glutes",     category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "DB Floor Press":            { primaryMuscle: "Chest",      category: "upper_push",         factor: 0.40, progressesByLoad: true },
  "Neutral-Grip DB Press":     { primaryMuscle: "Chest",      category: "upper_push",         factor: 0.42, progressesByLoad: true },
  "Decline Push-Up":           { primaryMuscle: "Chest",      category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Wide-Grip Cable Row":       { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.65, progressesByLoad: true },
  "Face-Away Cable Row":       { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.55, progressesByLoad: true },
  "Half-Kneeling Cable Row":   { primaryMuscle: "Back",       category: "upper_pull",         factor: 0.45, progressesByLoad: true },
  "Concentration Curl":        { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.35, progressesByLoad: true },
  "Preacher Curl":             { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.55, progressesByLoad: true },
  "Zottman Curl":              { primaryMuscle: "Biceps",     category: "accessory_arm",      factor: 0.30, progressesByLoad: true },
  "Diamond Push-Up":           { primaryMuscle: "Triceps",    category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Bench Dips":                { primaryMuscle: "Triceps",    category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "DB Kickback":               { primaryMuscle: "Triceps",    category: "accessory_arm",      factor: 0.20, progressesByLoad: true },
  "Cable Rear Delt Fly":       { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.12, progressesByLoad: true },
  "Prone Y Raise":             { primaryMuscle: "Shoulders",  category: "accessory_isolation", factor: 0.08, progressesByLoad: true },
  "Band Pull-Apart":           { primaryMuscle: "Shoulders",  category: "bw_progression",     factor: 0,    progressesByLoad: false },
  "Cable Crossover":           { primaryMuscle: "Chest",      category: "accessory_isolation", factor: 0.18, progressesByLoad: true },
  "Single-Arm Cable Fly":      { primaryMuscle: "Chest",      category: "accessory_isolation", factor: 0.12, progressesByLoad: true },
  "Svend Press":               { primaryMuscle: "Chest",      category: "accessory_isolation", factor: 0.12, progressesByLoad: true },
};

// ─── Pattern-matched fallback ─────────────────────────────────────────────────
// Exercises not explicitly listed get classified by name pattern. Keeps the
// engine working when the programme adds new exercises without us updating
// PROFILES — auto-classification is conservative (assumes accessory if unsure).
function inferProfileFromName(name) {
  if (!name) return null;
  const n = name.toLowerCase();

  // Bodyweight / hold patterns
  if (/(plank|hold|dead\s*bug|bird\s*dog|hollow|wall\s*sit|jump|pike\s*push)/.test(n)) {
    return { primaryMuscle: "Core", category: "bw_progression", factor: 0, progressesByLoad: false };
  }
  if (/push-?up/.test(n))                  return { primaryMuscle: "Chest",     category: "bw_progression", factor: 0, progressesByLoad: false };
  if (/(crunch|leg\s*raise|toes-?to-?bar)/.test(n)) {
    return { primaryMuscle: "Core", category: "bw_progression", factor: 0, progressesByLoad: false };
  }

  // Curl variants
  if (/curl/.test(n)) {
    if (/leg/.test(n))   return { primaryMuscle: "Hamstrings", category: "accessory_isolation", factor: 0.20, progressesByLoad: true };
    if (/db|dumbbell/.test(n))  return { primaryMuscle: "Biceps", category: "accessory_arm", factor: 0.40, progressesByLoad: true };
    return { primaryMuscle: "Biceps", category: "accessory_arm", factor: 0.95, progressesByLoad: true };
  }

  // Pull-Up / Chin-Up variants
  if (/(pull-?up|chin-?up|muscle-?up)/.test(n)) {
    return { primaryMuscle: "Back", category: "upper_pull", factor: 0.95, progressesByLoad: true };
  }

  // Squat variants
  if (/squat/.test(n)) {
    if (/db|dumbbell|goblet|sumo/.test(n)) return { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.35, progressesByLoad: true };
    if (/split|bulgarian/.test(n))         return { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.30, progressesByLoad: true };
    return { primaryMuscle: "Quadriceps", category: "lower_compound", factor: 0.85, progressesByLoad: true };
  }

  // Deadlift variants
  if (/deadlift/.test(n)) {
    if (/db|dumbbell/.test(n)) return { primaryMuscle: "Posterior", category: "accessory_compound", factor: 0.40, progressesByLoad: true };
    return { primaryMuscle: "Posterior", category: "lower_compound", factor: 0.95, progressesByLoad: true };
  }

  // Press variants — chest unless OHP/Shoulder
  if (/press/.test(n)) {
    if (/(overhead|shoulder|landmine)/.test(n)) {
      if (/(db|dumbbell|arnold)/.test(n))  return { primaryMuscle: "Shoulders", category: "upper_push", factor: 0.40, progressesByLoad: true };
      return { primaryMuscle: "Shoulders", category: "upper_push", factor: 0.95, progressesByLoad: true };
    }
    if (/(db|dumbbell|floor|incline)/.test(n)) return { primaryMuscle: "Chest", category: "upper_push", factor: 0.40, progressesByLoad: true };
    return { primaryMuscle: "Chest", category: "upper_push", factor: 0.95, progressesByLoad: true };
  }

  // Row variants
  if (/row/.test(n)) {
    if (/cable/.test(n))       return { primaryMuscle: "Back", category: "upper_pull", factor: 0.70, progressesByLoad: true };
    if (/db|dumbbell/.test(n)) return { primaryMuscle: "Back", category: "upper_pull", factor: 0.35, progressesByLoad: true };
    return { primaryMuscle: "Back", category: "upper_pull", factor: 0.50, progressesByLoad: true };
  }

  // Lunge / Step-up
  if (/(lunge|step-?up)/.test(n)) {
    if (/db|dumbbell/.test(n)) return { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.20, progressesByLoad: true };
    return { primaryMuscle: "Quadriceps", category: "accessory_compound", factor: 0.45, progressesByLoad: true };
  }

  // Hip thrust / Bridge
  if (/(hip\s*thrust|bridge|kickback|pull-?through)/.test(n)) {
    return { primaryMuscle: "Glutes", category: "accessory_compound", factor: 0.50, progressesByLoad: true };
  }

  // Lateral / Rear / Y-T-W (shoulder isolation)
  if (/(lateral|rear|y-?t-?w|reverse\s*fly)/.test(n)) {
    return { primaryMuscle: "Shoulders", category: "accessory_isolation", factor: 0.12, progressesByLoad: true };
  }

  // Tricep work
  if (/(tricep|skull|pushdown|extension|kickback)/.test(n)) {
    return { primaryMuscle: "Triceps", category: "accessory_arm", factor: 0.40, progressesByLoad: true };
  }

  // Fly variants
  if (/fly/.test(n)) {
    return { primaryMuscle: "Chest", category: "accessory_isolation", factor: 0.20, progressesByLoad: true };
  }

  // Default — unknown lift, treat as conservative accessory with no anchor
  return { primaryMuscle: null, category: "accessory_isolation", factor: 0, progressesByLoad: true };
}

// ─── Public API ───────────────────────────────────────────────────────────────
// Lookup an exercise's lift profile. Falls back to inference if not explicitly
// in the table. Always returns a non-null object — at worst, a conservative
// "unknown accessory" profile with no anchor.
export function getLiftProfile(name) {
  if (!name) {
    return { primaryMuscle: null, category: "accessory_isolation", factor: 0, progressesByLoad: true };
  }
  return PROFILES[name] || inferProfileFromName(name) || {
    primaryMuscle: null, category: "accessory_isolation", factor: 0, progressesByLoad: true
  };
}

// Sanity caps on cold-start output. Per-category upper bounds for what a
// freshly-prescribed working weight should ever be. Defensive ceiling: if the
// anchor's bestE1RM gets inflated by a bug or a corrupted record (real-world
// example: user saw 110kg recommended for Leaning Lateral Raise), the cap
// kicks in and returns a sane number. These are generous upper bounds — well
// above what most lifters use day-to-day, but below "obviously absurd".
export const CATEGORY_COLD_START_MAX_KG = {
  lower_compound:      250,
  upper_push:          120,
  upper_pull:          120,
  power:               150,
  accessory_compound:   80,
  accessory_arm:        40,
  accessory_isolation:  25,
  bw_progression:        0,
};

// Compute a cold-start prescription for a lift the user has never logged before,
// based on their best e1RM in the same primary muscle group.
//
// Returns: kg suggestion, or null if no anchor data is available (caller should
// fall back to programme.js's hardcoded default).
export function coldStartFromAnchor(targetLiftName, muscleAnchor) {
  const profile = getLiftProfile(targetLiftName);
  if (!profile.progressesByLoad)        return null;  // BW progression — no weight prescription
  if (!profile.primaryMuscle)           return null;  // Unknown lift — caller fallback
  if (!muscleAnchor || !muscleAnchor.bestE1RM) return null;  // No history yet

  // The anchor's e1RM gives us an upper bound. Working weights are typically
  // 70-85% of e1RM at moderate rep ranges. We want a conservative starting
  // working weight, so we use ~75% of e1RM × translation factor.
  const workingFraction = 0.75;
  const suggested = muscleAnchor.bestE1RM * workingFraction * profile.factor;

  // Sanity cap — see CATEGORY_COLD_START_MAX_KG above. Protects against
  // anchor inflation (a single big e1RM in a related lift translating to an
  // absurd recommendation for a small isolation movement).
  const cap = CATEGORY_COLD_START_MAX_KG[profile.category];
  const capped = cap !== undefined ? Math.min(suggested, cap) : suggested;

  // Round to plate increment (2.5kg for compounds, 0.5kg for isolation/arms)
  const roundTo = profile.category === "lower_compound" || profile.category === "upper_push" || profile.category === "upper_pull" || profile.category === "power"
    ? 2.5
    : 0.5;

  return Math.max(0, Math.round(capped / roundTo) * roundTo);
}

// Sanity-clamp a workingWeights map against the category caps. Any entry
// whose weight is wildly above what the cold-start cap allows for its
// category gets clamped back to the cap — almost certainly stale corruption
// from an earlier bug or a data anomaly (real-world case: a user with a
// recommendation of 110kg for Leaning Lateral Raise, which is an isolation
// movement with a 25kg ceiling).
//
// Why a 1.5× buffer over the cap before clamping: the cap is the cold-start
// max, but a real lifter who has progressively added 0.5kg/session can
// legitimately end up SLIGHTLY above that ceiling over time. We only treat
// values >150% of the cap as definitely-corrupt and reset them. Anything
// between 100–150% is left alone — user-authored.
//
// Returns the input reference when no entries need clamping (cheap identity
// check for callers that want to skip persistence when nothing changed).
export function sanitiseWorkingWeights(weights) {
  if (!weights || typeof weights !== "object") return weights;
  let mutated = null;
  for (const [name, kg] of Object.entries(weights)) {
    if (typeof kg !== "number" || !isFinite(kg)) continue;
    const profile = getLiftProfile(name);
    if (!profile.progressesByLoad) continue;
    const cap = CATEGORY_COLD_START_MAX_KG[profile.category];
    if (cap === undefined || cap === 0) continue;
    // Only clamp obviously-corrupt values. 1.5× buffer over the cap leaves
    // room for legitimate ADD progression past the cold-start ceiling.
    if (kg > cap * 1.5) {
      if (!mutated) mutated = { ...weights };
      mutated[name] = cap;
    }
  }
  return mutated || weights;
}

// For testing — expose internal classifier
export const __test__ = { PROFILES, inferProfileFromName };

// ─── Shared helper: resolve load type for an exercise ────────────────────────
// Used by both the session-finalise logger (in pushSetToDraft) and the session
// screen render. Centralises the "honour ex.loadType if set, otherwise infer
// from name" pattern so both call sites can't drift.
export function getLoadType(ex) {
  return ex?.loadType || inferLoadType(ex?.name);
}

// Resolve a loadType for a SWAP_DB option (audit #58). Swap entries carry
// {name, eq, muscle, vid} but historically no loadType — the swapped-in
// exercise inherited the ORIGINAL slot's type via spread, so a Nordic Curl
// swapped over a Machine Ham Curl logged as "machine" (volume read the
// stale 35kg prefill instead of bodyweight math), and anything swapped
// over a per_db slot double-counted. Priority: explicit loadType on the
// option → its eq label → name inference.
const SINGLE_IMPLEMENT_DB = /(goblet|leg\s*curl|pullover|sumo\s*squat|between)/i;
export function swapLoadType(option) {
  if (!option) return "external";
  if (option.loadType) return option.loadType;
  switch (option.eq) {
    case "Barbell":    return "barbell";
    case "Machine":    return "machine";
    case "Cable":      return "total";
    case "Kettlebell": return "total";   // one bell, both hands
    case "Band":       return "total";   // nominal band "weight", 1× systemic
    case "Dumbbell":
      // Per-hand pairs double in volume math; single-implement DB moves don't.
      return SINGLE_IMPLEMENT_DB.test(option.name || "") ? "total" : "per_db";
    default:
      // "Bodyweight", "Equipment" (swiss ball, sliders…) and anything new:
      // the name inference distinguishes plain BW from loaded-BW (dips,
      // pull-ups) and falls back to external.
      return inferLoadType(option.name);
  }
}

// Real-world implement increments per loadType. Dumbbells rarely come in
// fractional kg — most racks step in whole kg from 2-30kg then 2.5kg above.
// Cable stacks are typically pinned at 2.5kg per plate. Barbells take micro-
// plates as small as 1.25kg. Bodyweight has no scale. Used by every drum that
// edits a weight so the scroll feels honest to what you can actually load.
export function weightStepForLoadType(lt) {
  if (lt === "per_db")            return 1;     // most DB racks step in whole kg
  if (lt === "cable" || lt === "total") return 2.5;  // pin-loaded stacks
  if (lt === "bodyweight" || lt === "loaded_bodyweight" || lt === "assisted_bodyweight") return 1.25;
  return 1.25;  // barbell / external default
}

// Detect a "timed" prescription string like "20s", "30sec", "1m". Returns
// either { seconds: 20 } for a parseable duration or null for everything
// else. Lets the session screen show "20s · hold" instead of "20 reps",
// and lets the drum edit overlay swap its unit to seconds. The string
// form lives in the pool data (L-Sit Hold reps:"20s"); when a user
// overrides via the drum we store an integer alongside — same shape as
// numeric reps — and treat it as seconds whenever the prescribed value
// was originally timed.
export function parseTimedReps(reps) {
  if (typeof reps !== "string") return null;
  const m = reps.trim().match(/^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const seconds = unit.startsWith("m") ? n * 60 : n;
  return { seconds };
}


// What does the number the user types represent? Resolves the per-DB vs
// total-load ambiguity the picker has historically left implicit. Two
// vocabularies coexist: programme.js entries carry "barbell"/"per_db"/
// "total"/"machine"/"loaded_bw"/"bodyweight"; storage.js inference can
// also produce "external"/"loaded_bodyweight"/"assisted_bodyweight" for
// exercises without an explicit programme.js loadType. We cover both.
// "bodyweight" intentionally has no caption — the picker hides the weight
// field entirely for those.
export const WEIGHT_CAPTIONS = {
  barbell:               "weight on the bar",
  per_db:                "weight per dumbbell",
  total:                 "total weight",
  machine:               "machine stack weight",
  loaded_bw:             "added weight",
  loaded_bodyweight:     "added weight",
  assisted_bodyweight:   "band assistance",
};
