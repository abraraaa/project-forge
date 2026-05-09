// lib/programme.js
// ─────────────────────────────────────────────────────────────────────────────
// All static programme data and rotation logic.
// No React, no localStorage — pure data and pure functions.
// Update this file when changing exercises, pools, or session structure.
// ForgeApp.jsx and any future analytics routes import from here.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Weekly schedule ──────────────────────────────────────────────────────────
export const WEEK = [
  { s:"M", label:"Strength", type:"strength" },
  { s:"T", label:"Zone 2",   type:"zone2"    },
  { s:"W", label:"Strength", type:"strength" },
  { s:"T", label:"Cardio",   type:"cardio"   },
  { s:"F", label:"Strength", type:"strength" },
  { s:"S", label:"HIIT",     type:"hiit"     },
  { s:"S", label:"Rest",     type:"rest"     },
];

// Maps WEEK index → SESSIONS index  (Mon=0, Wed=1, Fri=2)
export const STRENGTH_DAY_SESSIONS = { 0:0, 2:1, 4:2 };

// ─── Three strength sessions ───────────────────────────────────────────────────
// Pool[0] of each accessory slot is the programme default.
// EXERCISE_POOLS (below) defines all alternatives for rotation.

export const SESSIONS = [
  // ── A · Monday · Squat + Push ─────────────────────────────────────────────
  {
    name:"Strength A", subtitle:"Squat & Push", type:"strength",
    blocks:[
      { id:"a1",  type:"main",      label:"Main lift · 1 of 2", sets:3, rest:180,
        ex: { name:"Barbell Back Squat",      reps:5,      weight:100, muscle:"Quadriceps",        vid:"nEQQle9-0NA" }},
      { id:"a2",  type:"main",      label:"Main lift · 2 of 2", sets:3, rest:180,
        ex: { name:"Barbell Bench Press",     reps:5,      weight:80,  muscle:"Chest",             vid:"4Y2ZdHCOXok" }},
      { id:"ass1",type:"superset",  label:"Superset · 1 of 2",  sets:3, rest:90,
        exA:{ name:"Barbell Reverse Lunge",   reps:"8/leg",weight:60,  muscle:"Quads & Glutes",    vid:"AIR5XoiQJaI" },
        exB:{ name:"Chest-Supported DB Row",  reps:10,     weight:24,  muscle:"Upper back",        vid:"Gkj_tABvdxs" }},
      { id:"ass2",type:"superset",  label:"Superset · 2 of 2",  sets:3, rest:90,
        exA:{ name:"Barbell Hip Thrust",      reps:10,     weight:100, muscle:"Glutes",            vid:"xDmFkJxPzeM" },
        exB:{ name:"Landmine Press",          reps:10,     weight:30,  muscle:"Upper chest",       vid:"QMrm2WMbj3k" }},
      { id:"afin",type:"finisher",  label:"Finisher",            sets:2, rest:60,
        exA:{ name:"Hanging Leg Raise",       reps:10,     weight:null,muscle:"Core",              vid:"hdng3Nm1x_E" },
        exB:{ name:"Dead Bug",                reps:10,     weight:null,muscle:"Core / Anti-rot",   vid:"g_BYB0R-4Ws" }},
    ],
  },
  // ── B · Wednesday · Hinge + Pull ──────────────────────────────────────────
  {
    name:"Strength B", subtitle:"Hinge & Pull", type:"strength",
    blocks:[
      { id:"b1",  type:"main",      label:"Main lift · 1 of 2", sets:3, rest:180,
        ex: { name:"Hex Bar Deadlift",        reps:5,      weight:120, muscle:"Posterior chain",   vid:"r4MzxtBKyNE" }},
      { id:"b2",  type:"main",      label:"Main lift · 2 of 2", sets:3, rest:180,
        ex: { name:"Barbell Overhead Press",  reps:5,      weight:55,  muscle:"Shoulders",         vid:"2yjwXTZmDtY" }},
      { id:"bss1",type:"superset",  label:"Superset · 1 of 2",  sets:3, rest:90,
        exA:{ name:"Leg Press",               reps:10,     weight:160, muscle:"Quads & Glutes",    vid:"cFAK2V9GO3k" },
        exB:{ name:"Pull-Up",                 reps:8,      weight:null,muscle:"Lats",              vid:"eGo4IYlbE5g" }},
      { id:"bss2",type:"superset",  label:"Superset · 2 of 2",  sets:3, rest:90,
        exA:{ name:"Bulgarian Split Squat",   reps:"8/leg",weight:20,  muscle:"Quads & Glutes",    vid:"2C-uNgKwPLE" },
        exB:{ name:"Machine Hamstring Curl",  reps:12,     weight:40,  muscle:"Hamstrings",        vid:"1Tq3QdYUuHs" }},
      { id:"bfin",type:"finisher",  label:"Finisher",            sets:2, rest:60,
        exA:{ name:"Copenhagen Plank",        reps:"30s",  weight:null,muscle:"Adductors / Core",  vid:"2OUMm2IeVaM" },
        exB:{ name:"Lateral Raise",           reps:15,     weight:8,   muscle:"Lateral delt",      vid:"3VcKaXpzqRo" }},
    ],
  },
  // ── C · Friday · Power + Volume ───────────────────────────────────────────
  {
    name:"Strength C", subtitle:"Power & Volume", type:"strength",
    blocks:[
      { id:"c1",  type:"main",      label:"Main lift",           sets:3, rest:180,
        ex: { name:"Power Clean",             reps:5,      weight:60,  muscle:"Full body / explosive", vid:"GGUDBiRhWrk" }},
      { id:"css1",type:"superset",  label:"Superset · 1 of 3",   sets:3, rest:90,
        exA:{ name:"DB Walking Lunge",        reps:"10/leg",weight:20, muscle:"Quads & Glutes",    vid:"D7KaRcUTQeE" },
        exB:{ name:"Cable Pull-Through",      reps:12,     weight:30,  muscle:"Glutes / Hams",     vid:"r1xvq2TGnA4" }},
      { id:"css2",type:"superset",  label:"Superset · 2 of 3",   sets:4, rest:90,
        exA:{ name:"Incline DB Press",        reps:10,     weight:30,  muscle:"Upper chest",       vid:"8iPEnn-ltC8" },
        exB:{ name:"Seated Cable Row",        reps:10,     weight:50,  muscle:"Mid back",          vid:"GZbfZ033f74" }},
      { id:"css3",type:"superset",  label:"Superset · 3 of 3",   sets:3, rest:90,
        exA:{ name:"DB Curl",                 reps:12,     weight:14,  muscle:"Biceps",            vid:"ykJmrZ5v0Ng" },
        exB:{ name:"Tricep Dips",             reps:12,     weight:null,muscle:"Triceps & chest",   vid:"yN6Q1UI_xr0" }},
      { id:"cfin",type:"finisher",  label:"Finisher",             sets:2, rest:60,
        exA:{ name:"Face Pull",               reps:15,     weight:15,  muscle:"Rear delts / cuff", vid:"HSoHeSz8yD0" },
        exB:{ name:"Low-to-High Cable Crossover", reps:15, weight:10,  muscle:"Upper pec / medial",vid:"d2uBFMIlLds" }},
    ],
  },
];

// ─── Rotation: zone adjacency ──────────────────────────────────────────────────
// Which gym zones sit close enough to superset without losing the bar.
export const ZONE_ADJ = {
  rack:       ["db","bodyweight"],
  db:         ["rack","cable"],
  cable:      ["db","machine"],
  machine:    ["cable"],
  bodyweight: ["rack","db"],
};

// ─── Rotation: accessory slot pools ───────────────────────────────────────────
// Main lifts are omitted — they never rotate (progressive overload needs continuity).
// Keys match ${block.id}-${phase} used throughout ForgeApp.
// gripDemand is at slot level: all entries are substitutes with the same grip class.
// Pool[0] must equal the SESSIONS default for that slot.

export const EXERCISE_POOLS = {
  // ── Day A ─────────────────────────────────────────────────────────────────
  "ass1-A":{ gripDemand:"LOW",  zone:"rack",       pool:[
    { name:"Barbell Reverse Lunge",  reps:"8/leg", weight:60,  muscle:"Quads & Glutes",  vid:"AIR5XoiQJaI" },
    { name:"DB Reverse Lunge",       reps:"8/leg", weight:20,  muscle:"Quads & Glutes",  vid:null },
    { name:"Barbell Step-Up",        reps:"8/leg", weight:40,  muscle:"Quads & Glutes",  vid:null },
    { name:"Barbell Walking Lunge",  reps:"8/leg", weight:40,  muscle:"Quads & Glutes",  vid:null },
    { name:"Barbell Front Rack Lunge", reps:"8/leg", weight:50, muscle:"Quads & Glutes", vid:null },
    { name:"Deficit Reverse Lunge",  reps:"8/leg", weight:50,  muscle:"Quads & Glutes",  vid:null },
  ]},
  "ass1-B":{ gripDemand:"HIGH", zone:"db",         pool:[
    { name:"Chest-Supported DB Row", reps:10,      weight:24,  muscle:"Upper back",       vid:"Gkj_tABvdxs" },
    { name:"Single-Arm DB Row",      reps:10,      weight:28,  muscle:"Upper back",       vid:null },
    { name:"Dumbbell Bent-Over Row", reps:10,      weight:22,  muscle:"Upper back",       vid:null },
    { name:"TRX Row",                reps:10,      weight:null,muscle:"Upper back",        vid:null },
    { name:"Meadows Row",            reps:10,      weight:26,  muscle:"Upper back",       vid:null },
    { name:"Incline DB Row",         reps:10,      weight:22,  muscle:"Upper back",       vid:null },
    { name:"Seal Row",               reps:10,      weight:20,  muscle:"Upper back",       vid:null },
  ]},
  "ass2-A":{ gripDemand:"NONE", zone:"rack",       pool:[
    { name:"Barbell Hip Thrust",     reps:10,      weight:100, muscle:"Glutes",           vid:"xDmFkJxPzeM" },
    { name:"Single-Leg Hip Thrust",  reps:10,      weight:60,  muscle:"Glutes",           vid:null },
    { name:"Banded Hip Thrust",      reps:15,      weight:null,muscle:"Glutes",            vid:null },
    { name:"Barbell Glute Bridge",   reps:12,      weight:80,  muscle:"Glutes",           vid:null },
    { name:"B-Stance Hip Thrust",    reps:10,      weight:80,  muscle:"Glutes",           vid:null },
    { name:"Frog Pump",              reps:20,      weight:null,muscle:"Glutes",            vid:null },
  ]},
  "ass2-B":{ gripDemand:"MED",  zone:"rack",       pool:[
    { name:"Landmine Press",               reps:10, weight:30,  muscle:"Upper chest",     vid:"QMrm2WMbj3k" },
    { name:"Single-Arm Landmine Press",    reps:10, weight:25,  muscle:"Upper chest",     vid:null },
    { name:"Incline Landmine Press",       reps:10, weight:25,  muscle:"Upper chest",     vid:null },
    { name:"Landmine Squeeze Press", reps:12,      weight:25,  muscle:"Upper chest",      vid:null },
    { name:"Kneeling Landmine Press", reps:10,     weight:25,  muscle:"Upper chest",      vid:null },
    { name:"Floor Press",            reps:10,      weight:60,  muscle:"Upper chest",      vid:null },
  ]},
  "afin-A":{ gripDemand:"HIGH", zone:"bodyweight", pool:[
    { name:"Hanging Leg Raise",      reps:10,      weight:null,muscle:"Core",              vid:"hdng3Nm1x_E" },
    { name:"Toes-to-Bar",            reps:8,       weight:null,muscle:"Core",              vid:null },
    { name:"Captain's Chair Raise",  reps:12,      weight:null,muscle:"Core",              vid:null },
    { name:"Hanging Knee Raise",     reps:12,      weight:null,muscle:"Core",              vid:null },
    { name:"L-Sit Hold",             reps:"20s",   weight:null,muscle:"Core",              vid:null },
    { name:"Windshield Wiper",       reps:8,       weight:null,muscle:"Core",              vid:null },
  ]},
  "afin-B":{ gripDemand:"NONE", zone:"bodyweight", pool:[
    { name:"Dead Bug",               reps:10,      weight:null,muscle:"Core / Anti-rot",   vid:"g_BYB0R-4Ws" },
    { name:"Hollow Body Hold",       reps:30,      weight:null,muscle:"Core / Anti-ext",   vid:null },
    { name:"Bird Dog",               reps:10,      weight:null,muscle:"Core / Anti-rot",   vid:null },
    { name:"Pallof Press",           reps:10,      weight:15,  muscle:"Core / Anti-rot",   vid:null },
    { name:"Plank",                  reps:"45s",   weight:null,muscle:"Core / Anti-ext",   vid:null },
    { name:"Stir the Pot",           reps:10,      weight:null,muscle:"Core / Anti-rot",   vid:null },
  ]},

  // ── Day B ─────────────────────────────────────────────────────────────────
  "bss1-A":{ gripDemand:"NONE", zone:"machine",    pool:[
    { name:"Leg Press",              reps:10,      weight:160, muscle:"Quads & Glutes",   vid:"cFAK2V9GO3k" },
    { name:"Hack Squat",             reps:10,      weight:80,  muscle:"Quadriceps",       vid:null },
    { name:"Leg Extension",          reps:12,      weight:60,  muscle:"Quadriceps",       vid:null },
    { name:"Pendulum Squat",         reps:10,      weight:60,  muscle:"Quadriceps",       vid:null },
    { name:"V-Squat",                reps:10,      weight:70,  muscle:"Quads & Glutes",   vid:null },
    { name:"Belt Squat",             reps:10,      weight:60,  muscle:"Quads & Glutes",   vid:null },
  ]},
  "bss1-B":{ gripDemand:"HIGH", zone:"bodyweight", pool:[
    { name:"Pull-Up",                reps:8,       weight:null,muscle:"Lats",              vid:"eGo4IYlbE5g" },
    { name:"Weighted Pull-Up",       reps:6,       weight:10,  muscle:"Lats",             vid:null },
    { name:"Neutral-Grip Pull-Up",   reps:8,       weight:null,muscle:"Lats / Biceps",    vid:null },
    { name:"Lat Pulldown",           reps:10,      weight:55,  muscle:"Lats",             vid:null },
    { name:"Chin-Up",                reps:8,       weight:null,muscle:"Lats / Biceps",    vid:null },
    { name:"Wide-Grip Pull-Up",      reps:8,       weight:null,muscle:"Lats",             vid:null },
    { name:"Assisted Pull-Up",       reps:10,      weight:null,muscle:"Lats",             vid:null },
  ]},
  "bss2-A":{ gripDemand:"LOW",  zone:"db",         pool:[
    { name:"Bulgarian Split Squat",  reps:"8/leg", weight:20,  muscle:"Quads & Glutes",   vid:"2C-uNgKwPLE" },
    { name:"DB Step-Up",             reps:"8/leg", weight:18,  muscle:"Quads & Glutes",   vid:null },
    { name:"Goblet Squat",           reps:10,      weight:32,  muscle:"Quads & Glutes",   vid:null },
    { name:"DB Sumo Squat",          reps:10,      weight:36,  muscle:"Quads & Glutes / Adductors", vid:null },
    { name:"DB Front Squat",         reps:10,      weight:24,  muscle:"Quads & Glutes",   vid:null },
    { name:"DB Split Squat",         reps:"8/leg", weight:18,  muscle:"Quads & Glutes",   vid:null },
  ]},
  "bss2-B":{ gripDemand:"NONE", zone:"machine",    pool:[
    { name:"Machine Hamstring Curl", reps:12,      weight:40,  muscle:"Hamstrings",       vid:"1Tq3QdYUuHs" },
    { name:"Swiss Ball Leg Curl",    reps:12,      weight:null,muscle:"Hamstrings",        vid:null },
    { name:"Nordic Curl",            reps:8,       weight:null,muscle:"Hamstrings",        vid:"d2GpGFLOiOA" },
    { name:"Seated Leg Curl",        reps:12,      weight:40,  muscle:"Hamstrings",       vid:null },
    { name:"Slider Leg Curl",        reps:10,      weight:null,muscle:"Hamstrings",        vid:null },
    { name:"Single-Leg Curl",        reps:10,      weight:25,  muscle:"Hamstrings",       vid:null },
  ]},
  "bfin-A":{ gripDemand:"NONE", zone:"bodyweight", pool:[
    { name:"Copenhagen Plank",       reps:"30s",   weight:null,muscle:"Adductors / Core", vid:"2OUMm2IeVaM" },
    { name:"Side Plank",             reps:"30s",   weight:null,muscle:"Adductors / Core", vid:null },
    { name:"Lateral Band Walk",      reps:20,      weight:null,muscle:"Adductors / Glutes",vid:null },
    { name:"Cossack Squat",          reps:8,       weight:null,muscle:"Adductors / Glutes",vid:null },
    { name:"Adductor Stretch Lunge", reps:10,      weight:null,muscle:"Adductors / Core", vid:null },
    { name:"Side-Lying Adduction",   reps:15,      weight:null,muscle:"Adductors",        vid:null },
  ]},
  "bfin-B":{ gripDemand:"LOW",  zone:"db",         pool:[
    { name:"Lateral Raise",          reps:15,      weight:8,   muscle:"Lateral delt",     vid:"3VcKaXpzqRo" },
    { name:"Cable Lateral Raise",    reps:15,      weight:8,   muscle:"Lateral delt",     vid:null },
    { name:"Seated Lateral Raise",   reps:15,      weight:7,   muscle:"Lateral delt",     vid:null },
    { name:"Leaning Lateral Raise",  reps:12,      weight:8,   muscle:"Lateral delt",     vid:null },
    { name:"DB Lu Raise",            reps:10,      weight:6,   muscle:"Lateral delt",     vid:null },
    { name:"Band Lateral Raise",     reps:15,      weight:null,muscle:"Lateral delt",     vid:null },
  ]},

  // ── Day C ─────────────────────────────────────────────────────────────────
  "css1-A":{ gripDemand:"MED",  zone:"db",         pool:[
    { name:"DB Walking Lunge",       reps:"10/leg",weight:20,  muscle:"Quads & Glutes",   vid:"D7KaRcUTQeE" },
    { name:"DB Reverse Lunge",       reps:"10/leg",weight:22,  muscle:"Quads & Glutes",   vid:null },
    { name:"DB Step-Up",             reps:"10/leg",weight:18,  muscle:"Quads & Glutes",   vid:null },
    { name:"DB Bulgarian Split Squat", reps:"8/leg", weight:20, muscle:"Quads & Glutes",  vid:null },
    { name:"DB Lateral Lunge",       reps:"8/leg", weight:16,  muscle:"Quads & Glutes",   vid:null },
    { name:"Curtsy Lunge",           reps:"8/leg", weight:14,  muscle:"Quads & Glutes",   vid:null },
  ]},
  "css1-B":{ gripDemand:"NONE", zone:"cable",      pool:[
    { name:"Cable Pull-Through",           reps:12, weight:30, muscle:"Glutes / Hams",   vid:"r1xvq2TGnA4" },
    { name:"Cable Kickback",               reps:12, weight:15, muscle:"Glutes",           vid:null },
    { name:"Glute Bridge",                 reps:15, weight:null,muscle:"Glutes",          vid:null },
    { name:"Cable Hip Abduction",          reps:12, weight:15, muscle:"Glutes",           vid:null },
    { name:"Standing Cable Hip Extension", reps:12, weight:20, muscle:"Glutes / Hams",   vid:null },
    { name:"Banded Glute Bridge",          reps:15, weight:null,muscle:"Glutes",          vid:null },
  ]},
  "css2-A":{ gripDemand:"MED",  zone:"db",         pool:[
    { name:"Incline DB Press",             reps:10, weight:30, muscle:"Upper chest",      vid:"8iPEnn-ltC8" },
    { name:"DB Chest Fly",                 reps:12, weight:18, muscle:"Chest / medial",   vid:null },
    { name:"Low-to-High Cable Fly",        reps:12, weight:12, muscle:"Upper pec",        vid:null },
    { name:"DB Floor Press",               reps:10, weight:26, muscle:"Chest",            vid:null },
    { name:"Neutral-Grip DB Press",        reps:10, weight:28, muscle:"Chest",            vid:null },
    { name:"Decline Push-Up",              reps:15, weight:null,muscle:"Upper chest",     vid:null },
  ]},
  "css2-B":{ gripDemand:"MED",  zone:"cable",      pool:[
    { name:"Seated Cable Row",             reps:10, weight:50, muscle:"Mid back",         vid:"GZbfZ033f74" },
    { name:"Cable Straight-Arm Pulldown",  reps:12, weight:25, muscle:"Lats",             vid:null },
    { name:"Single-Arm Cable Row",         reps:10, weight:25, muscle:"Mid back",         vid:null },
    { name:"Wide-Grip Cable Row",          reps:10, weight:45, muscle:"Mid back",         vid:null },
    { name:"Face-Away Cable Row",          reps:10, weight:30, muscle:"Mid back",         vid:null },
    { name:"Half-Kneeling Cable Row",      reps:10, weight:25, muscle:"Mid back",         vid:null },
  ]},
  "css3-A":{ gripDemand:"HIGH", zone:"db",         pool:[
    { name:"DB Curl",                      reps:12, weight:14, muscle:"Biceps",           vid:"ykJmrZ5v0Ng" },
    { name:"Incline DB Curl",              reps:12, weight:12, muscle:"Biceps",           vid:null },
    { name:"Hammer Curl",                  reps:12, weight:16, muscle:"Biceps & brachialis", vid:"zC3nLlEvin4" },
    { name:"EZ Bar Curl",                  reps:12, weight:25, muscle:"Biceps",           vid:null },
    { name:"Concentration Curl",           reps:10, weight:12, muscle:"Biceps",           vid:null },
    { name:"Preacher Curl",                reps:12, weight:20, muscle:"Biceps",           vid:null },
    { name:"Zottman Curl",                 reps:10, weight:10, muscle:"Biceps & forearms", vid:null },
  ]},
  "css3-B":{ gripDemand:"LOW",  zone:"bodyweight", pool:[
    { name:"Tricep Dips",                  reps:12, weight:null,muscle:"Triceps & chest", vid:"yN6Q1UI_xr0" },
    { name:"Close-Grip Push-Up",           reps:15, weight:null,muscle:"Triceps",         vid:null },
    { name:"Overhead Tricep Extension",    reps:12, weight:16,  muscle:"Triceps",         vid:null },
    { name:"Skull Crusher",                reps:12, weight:20,  muscle:"Triceps",         vid:null },
    { name:"Diamond Push-Up",              reps:12, weight:null,muscle:"Triceps",         vid:null },
    { name:"Bench Dips",                   reps:15, weight:null,muscle:"Triceps",         vid:null },
    { name:"Kickback",                     reps:12, weight:10,  muscle:"Triceps",         vid:null },
  ]},
  "cfin-A":{ gripDemand:"LOW",  zone:"cable",      pool:[
    { name:"Face Pull",                    reps:15, weight:15,  muscle:"Rear delts / cuff", vid:"HSoHeSz8yD0" },
    { name:"Band Face Pull",               reps:15, weight:null,muscle:"Rear delts / cuff", vid:null },
    { name:"Rear Delt Fly",                reps:15, weight:8,   muscle:"Rear delts",        vid:null },
    { name:"Cable Rear Delt Fly",          reps:15, weight:10,  muscle:"Rear delts",        vid:null },
    { name:"Prone Y Raise",                reps:12, weight:4,   muscle:"Rear delts / cuff", vid:null },
    { name:"Band Pull-Apart",              reps:20, weight:null,muscle:"Rear delts / cuff", vid:null },
  ]},
  "cfin-B":{ gripDemand:"NONE", zone:"cable",      pool:[
    { name:"Low-to-High Cable Crossover",  reps:15, weight:10,  muscle:"Upper pec / medial", vid:"d2uBFMIlLds" },
    { name:"DB Chest Fly",                 reps:15, weight:14,  muscle:"Chest / medial",     vid:null },
    { name:"Pec Deck",                     reps:15, weight:40,  muscle:"Chest / medial",     vid:null },
    { name:"Cable Crossover",              reps:15, weight:15,  muscle:"Chest / medial",     vid:null },
    { name:"Single-Arm Cable Fly",         reps:12, weight:10,  muscle:"Chest / medial",     vid:null },
    { name:"Svend Press",                  reps:15, weight:10,  muscle:"Chest / medial",     vid:null },
  ]},
};

// Superset pairs — used for zone validation when rotating
export const SS_PAIRS = [
  ["ass1-A","ass1-B"], ["ass2-A","ass2-B"],
  ["bss1-A","bss1-B"], ["bss2-A","bss2-B"],
  ["css1-A","css1-B"], ["css2-A","css2-B"], ["css3-A","css3-B"],
];

// ─── Rotation thresholds (in weeks on current block) ─────────────────────────
export const ROTATION_OPTIONAL = 4;   // "rotate now" card appears on home
export const ROTATION_AUTO     = 8;   // auto-rotate before next session starts
export const ROTATION_FORCED   = 12;  // cannot dismiss — rotation happens

// Zone-compatible pairing check
function zonesCompatible(za, zb) {
  if (za === zb) return true;
  return ZONE_ADJ[za]?.includes(zb) || false;
}

// Pick new accessories, avoiding last block's choices where possible.
// Zone constraints are honoured via re-pick up to MAX_RETRIES.
// If no zone-compatible pair exists after retries, we accept the mismatch
// and log it — grip/muscle-stimulus variety is more important than geography.
export function rotateAccessories(history = {}) {
  const MAX_RETRIES = 3;
  const config = {};

  // First pass: independent pick per slot, excluding last selection
  Object.entries(EXERCISE_POOLS).forEach(([key, { pool }]) => {
    const lastName = history[key];
    const available = pool.filter(ex => ex.name !== lastName);
    const candidates = available.length > 0 ? available : pool;
    config[key] = candidates[Math.floor(Math.random() * candidates.length)];
  });

  // Second pass: validate SS pairs, re-pick if zones are incompatible.
  // Grip is already invariant within a slot (slot-level gripDemand), so we
  // only need to check zone compatibility.
  SS_PAIRS.forEach(([ka, kb]) => {
    const sa = EXERCISE_POOLS[ka], sb = EXERCISE_POOLS[kb];
    if (!sa || !sb) return;
    if (zonesCompatible(sa.zone, sb.zone)) return; // pair is fine

    // Slot zones are static in our schema — individual exercises in a pool
    // share the slot's zone. So a zone mismatch at slot level means no
    // re-pick within the pool can fix it; the warning is informational.
    // Kept for future-proofing if pool entries ever get zone overrides.
    console.warn(`Rotation: zone mismatch ${ka}(${sa.zone}) ↔ ${kb}(${sb.zone}) — acceptable, but verify gym layout`);
  });

  return config;
}

// Compute what changed between two configs — used for the rotation summary card
export function rotationDiff(oldConfig, newConfig) {
  const changes = [];
  Object.keys(newConfig).forEach(key => {
    const oldName = oldConfig?.[key]?.name || EXERCISE_POOLS[key]?.pool?.[0]?.name;
    const newName = newConfig[key]?.name;
    if (oldName && newName && oldName !== newName) {
      changes.push({ slot: key, from: oldName, to: newName });
    }
  });
  return changes;
}

// ─── Home screen config ────────────────────────────────────────────────────────
export const DAY_NAMES = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

export const DAY_CONFIG = {
  strength: { headline:["Strength", null], sub:null, canBegin:true },
  zone2:    { headline:["Zone 2","Cardio"],    sub:"60 min at conversational pace. Any modality.",
              tips:["Keep heart rate at 60–70% max","Nasal breathing if possible","Walk, cycle, row, ski erg — your call"], canBegin:false },
  cardio:   { headline:["Moderate","Cardio"],  sub:"35 min at ~75% effort. Elevated but controlled.",
              tips:["Target 75–80% max heart rate","Assault bike, rower, or run","Steady state — not a sprint"], canBegin:false },
  hiit:     { headline:["HIIT"],               sub:"8–10 rounds of 20s all-out / 10s rest.",
              tips:["Full effort on every sprint interval","Assault bike or ski erg preferred","Stop if form breaks down"], canBegin:false },
  rest:     { headline:["Rest","Day"],          sub:"Recover. You've earned it.",
              tips:["Mobility or light yoga if you want to move","Focus on sleep and nutrition","Come back stronger tomorrow"], canBegin:false },
};

// ─── Swap overlay data ─────────────────────────────────────────────────────────
export const EQ_COLOUR = {
  Bodyweight:"#8BB09A", Dumbbell:"#A5B8D0", Cable:"#C4A882",
  Machine:"#C9A0B8",    Barbell:"#E0956A",  Band:"#8BB09A",
  Kettlebell:"#C4A882", Equipment:"#A5B8D0",
};

export const SWAP_DB = {
  "Barbell Back Squat":        [{ name:"Goblet Squat",              eq:"Dumbbell",  muscle:"Quadriceps",          vid:null },
                                { name:"Bulgarian Split Squat",     eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:"2C-uNgKwPLE" },
                                { name:"Leg Press",                 eq:"Machine",   muscle:"Quads & Glutes",      vid:"cFAK2V9GO3k" },
                                { name:"Hack Squat",                eq:"Machine",   muscle:"Quadriceps",          vid:null }],
  "Barbell Bench Press":       [{ name:"Dumbbell Bench Press",      eq:"Dumbbell",  muscle:"Chest",               vid:null },
                                { name:"Push-Up",                   eq:"Bodyweight",muscle:"Chest",               vid:null },
                                { name:"Dumbbell Floor Press",      eq:"Dumbbell",  muscle:"Chest",               vid:null }],
  "Barbell Reverse Lunge":     [{ name:"DB Reverse Lunge",          eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:null },
                                { name:"Step-Up",                   eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Split Squat",               eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null }],
  "Chest-Supported DB Row":    [{ name:"Dumbbell Bent-Over Row",    eq:"Dumbbell",  muscle:"Upper back",          vid:null },
                                { name:"Cable Row",                 eq:"Cable",     muscle:"Upper back",          vid:"GZbfZ033f74" },
                                { name:"Resistance Band Row",       eq:"Band",      muscle:"Upper back",          vid:null },
                                { name:"TRX Row",                   eq:"Bodyweight",muscle:"Upper back",          vid:null }],
  "Barbell Hip Thrust":        [{ name:"Glute Bridge",              eq:"Bodyweight",muscle:"Glutes",              vid:null },
                                { name:"Single-Leg Hip Thrust",     eq:"Bodyweight",muscle:"Glutes",              vid:null },
                                { name:"Cable Pull-Through",        eq:"Cable",     muscle:"Glutes / Hams",       vid:"r1xvq2TGnA4" }],
  "Landmine Press":            [{ name:"Dumbbell Shoulder Press",   eq:"Dumbbell",  muscle:"Shoulders",           vid:null },
                                { name:"Arnold Press",              eq:"Dumbbell",  muscle:"Shoulders",           vid:null },
                                { name:"Pike Push-Up",              eq:"Bodyweight",muscle:"Shoulders",           vid:null }],
  "Hanging Leg Raise":         [{ name:"Lying Leg Raise",           eq:"Bodyweight",muscle:"Core",                vid:null },
                                { name:"Ab Wheel",                  eq:"Equipment", muscle:"Core",                vid:"DHNmCJBJlG4" },
                                { name:"Reverse Crunch",            eq:"Bodyweight",muscle:"Core",                vid:null }],
  "Dead Bug":                  [{ name:"Hollow Body Hold",          eq:"Bodyweight",muscle:"Core / Anti-rot",     vid:"LlDNef_Ztsc" },
                                { name:"Plank",                     eq:"Bodyweight",muscle:"Core",                vid:null }],
  "Hex Bar Deadlift":          [{ name:"Romanian Deadlift",         eq:"Barbell",   muscle:"Posterior chain",     vid:"hCDzSR6bW10" },
                                { name:"Dumbbell Deadlift",         eq:"Dumbbell",  muscle:"Posterior chain",     vid:null },
                                { name:"Sumo Deadlift",             eq:"Barbell",   muscle:"Posterior chain",     vid:null }],
  "Barbell Overhead Press":    [{ name:"Dumbbell Shoulder Press",   eq:"Dumbbell",  muscle:"Shoulders",           vid:null },
                                { name:"Arnold Press",              eq:"Dumbbell",  muscle:"Shoulders",           vid:null },
                                { name:"Push Press",                eq:"Barbell",   muscle:"Shoulders",           vid:null }],
  "Leg Press":                 [{ name:"Goblet Squat",              eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:null },
                                { name:"Bulgarian Split Squat",     eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:"2C-uNgKwPLE" },
                                { name:"Wall Sit",                  eq:"Bodyweight",muscle:"Quadriceps",          vid:null }],
  "Pull-Up":                   [{ name:"Lat Pulldown",              eq:"Cable",     muscle:"Lats",                vid:null },
                                { name:"Resistance Band Pull-Down", eq:"Band",      muscle:"Lats",                vid:null },
                                { name:"TRX Row",                   eq:"Bodyweight",muscle:"Lats",                vid:null }],
  "Bulgarian Split Squat":     [{ name:"Reverse Lunge",             eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Step-Up",                   eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"DB Reverse Lunge",          eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:null }],
  "Machine Hamstring Curl":    [{ name:"Nordic Curl",               eq:"Bodyweight",muscle:"Hamstrings",          vid:"d2GpGFLOiOA" },
                                { name:"Dumbbell Leg Curl",         eq:"Dumbbell",  muscle:"Hamstrings",          vid:null },
                                { name:"Swiss Ball Leg Curl",       eq:"Equipment", muscle:"Hamstrings",          vid:null }],
  "Copenhagen Plank":          [{ name:"Side Plank",                eq:"Bodyweight",muscle:"Adductors / Core",    vid:null },
                                { name:"Lateral Band Walk",         eq:"Band",      muscle:"Adductors",           vid:null }],
  "Lateral Raise":             [{ name:"Cable Lateral Raise",       eq:"Cable",     muscle:"Lateral delt",        vid:null },
                                { name:"Resistance Band Lateral",   eq:"Band",      muscle:"Lateral delt",        vid:null },
                                { name:"Seated Lateral Raise",      eq:"Dumbbell",  muscle:"Lateral delt",        vid:null }],
  "Power Clean":               [{ name:"Hang Power Clean",          eq:"Barbell",   muscle:"Full body / explosive",vid:null },
                                { name:"Dumbbell Hang Clean",       eq:"Dumbbell",  muscle:"Full body / explosive",vid:null },
                                { name:"Kettlebell Swing",          eq:"Kettlebell",muscle:"Posterior chain",     vid:null }],
  "DB Walking Lunge":          [{ name:"Reverse Lunge",             eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Step-Up",                   eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Split Squat",               eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null }],
  "Cable Pull-Through":        [{ name:"Good Morning",              eq:"Barbell",   muscle:"Posterior chain",     vid:null },
                                { name:"Glute Bridge",              eq:"Bodyweight",muscle:"Glutes",              vid:null },
                                { name:"Resistance Band Pull-Through",eq:"Band",    muscle:"Glutes / Hams",       vid:null }],
  "Incline DB Press":          [{ name:"Incline Push-Up",           eq:"Bodyweight",muscle:"Upper chest",         vid:null },
                                { name:"Landmine Press",            eq:"Barbell",   muscle:"Upper chest",         vid:"QMrm2WMbj3k" },
                                { name:"Cable Chest Fly",           eq:"Cable",     muscle:"Upper chest",         vid:null }],
  "Seated Cable Row":          [{ name:"Dumbbell Bent-Over Row",    eq:"Dumbbell",  muscle:"Mid back",            vid:null },
                                { name:"TRX Row",                   eq:"Bodyweight",muscle:"Mid back",            vid:null },
                                { name:"Resistance Band Row",       eq:"Band",      muscle:"Mid back",            vid:null }],
  "DB Curl":                   [{ name:"EZ Bar Curl",               eq:"Barbell",   muscle:"Biceps",              vid:null },
                                { name:"Resistance Band Curl",      eq:"Band",      muscle:"Biceps",              vid:null },
                                { name:"Incline DB Curl",           eq:"Dumbbell",  muscle:"Biceps",              vid:null }],
  "Tricep Dips":               [{ name:"Close-Grip Push-Up",        eq:"Bodyweight",muscle:"Triceps",             vid:null },
                                { name:"Overhead Tricep Extension", eq:"Dumbbell",  muscle:"Triceps",             vid:null },
                                { name:"Resistance Band Pushdown",  eq:"Band",      muscle:"Triceps",             vid:null }],
  "Face Pull":                 [{ name:"Resistance Band Face Pull", eq:"Band",      muscle:"Rear delts / cuff",   vid:null },
                                { name:"Rear Delt Fly",             eq:"Dumbbell",  muscle:"Rear delts",          vid:"oVFyRsN0gLo" },
                                { name:"Y-T-W Raise",               eq:"Bodyweight",muscle:"Rear delts",          vid:null }],
  "Low-to-High Cable Crossover":[{ name:"DB Chest Fly",             eq:"Dumbbell",  muscle:"Upper pec / medial",  vid:null },
                                { name:"Pec Deck",                  eq:"Machine",   muscle:"Chest",               vid:null },
                                { name:"Resistance Band Crossover", eq:"Band",      muscle:"Upper pec / medial",  vid:null }],
};

// ═════════════════════════════════════════════════════════════════════════════
// RETROSPECTIVE LOGGING HELPERS
// ═════════════════════════════════════════════════════════════════════════════
//
// These two pure functions support the post-launch retrospective logging flow:
// "log a session you forgot/missed in the last 3 days." They live here because
// they need WEEK + STRENGTH_DAY_SESSIONS, which both already export from this
// module. Keeping them next to the rotation tables means the retro logic can't
// drift from how the live home screen computes today's session.
// ═════════════════════════════════════════════════════════════════════════════

// Map a JavaScript Date.getDay() value (Sun=0 … Sat=6) to a WEEK index (Mon=0).
// The mapping is duplicated as `weekMap` in ForgeApp.jsx in two places — same
// table, single source of truth lives here so the retro picker can import it.
const JS_DAY_TO_WEEK_INDEX = [6, 0, 1, 2, 3, 4, 5];

// For a given ISO date string ("YYYY-MM-DD"), return the programme metadata
// describing what session was scheduled for that day. Returns:
//   - { type: "strength", sessionIdx: 0|1|2, sessionName: "Strength A|B|C", weekIdx, dow, dateLabel }
//   - { type: "zone2"|"cardio"|"hiit"|"rest", sessionIdx: null, sessionName, weekIdx, dow, dateLabel }
//
// `dateLabel` is a short human-readable label like "Mon 27 Apr" — used by the
// retro picker rows so we don't duplicate Date formatting logic at the UI layer.
//
// Pure function. No history or state lookups — calculation is purely from the
// static WEEK + STRENGTH_DAY_SESSIONS rotation tables.
export function sessionMetaForDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const d = new Date(dateStr + "T12:00:00"); // noon-anchor avoids DST edge cases
  if (isNaN(d.getTime())) return null;

  const dow     = d.getDay();
  const weekIdx = JS_DAY_TO_WEEK_INDEX[dow];
  const weekDay = WEEK[weekIdx];
  if (!weekDay) return null;

  const dateLabel = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  if (weekDay.type === "strength") {
    const sessionIdx = STRENGTH_DAY_SESSIONS[weekIdx];
    const session    = SESSIONS[sessionIdx];
    return {
      type: "strength",
      sessionIdx,
      sessionName: session?.name || "Strength",
      sessionSubtitle: session?.subtitle || null,
      weekIdx,
      dow,
      dateLabel,
    };
  }

  // Non-strength day — return type info so picker can render it as context
  return {
    type: weekDay.type,
    sessionIdx: null,
    sessionName: weekDay.label,
    sessionSubtitle: null,
    weekIdx,
    dow,
    dateLabel,
  };
}

// Walk back N calendar days (excluding today) and return rows describing what
// was scheduled and whether it was logged. Caller decides what to do with each
// row (render dim, render tappable, render "view session", etc).
//
// `history` is the standard v2 history array. We match logged-ness by comparing
// `record.date` (already ISO YYYY-MM-DD format from finaliseDraft) — exact match.
//
// Returns oldest first → newest first based on `order` param. Default newest first.
//
// Each row: { date, ...sessionMeta, logged: boolean, recordId: string|null }
export function findRecentDays(history = [], daysBack = 3, { order = "desc" } = {}) {
  if (daysBack < 1) return [];
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  const loggedDates = new Map();
  for (const rec of history) {
    if (!rec || !rec.date) continue;
    if (rec.date === todayStr) continue;          // ignore today
    if (!rec.session?.startsWith?.("strength")) continue; // only strength counts
    loggedDates.set(rec.date, rec.id);
  }

  const rows = [];
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const meta    = sessionMetaForDate(dateStr);
    if (!meta) continue;
    rows.push({
      date: dateStr,
      ...meta,
      logged: loggedDates.has(dateStr),
      recordId: loggedDates.get(dateStr) || null,
    });
  }

  // rows currently newest → oldest (we walked back from today)
  return order === "asc" ? rows.reverse() : rows;
}

// Given recent days, returns true if any day is a strength day that's still
// missing. Used by the home screen to decide whether to surface the
// "Log past session" link at all — when there's nothing to fill, the link
// stays hidden so home doesn't acquire chrome that isn't pulling its weight.
export function hasMissedStrength(history = [], daysBack = 3) {
  const rows = findRecentDays(history, daysBack);
  return rows.some(r => r.type === "strength" && !r.logged);
}
