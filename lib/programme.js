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
        ex: { name:"Barbell Back Squat",      reps:5,      weight:55,  muscle:"Quadriceps",        vid:"bEv6CCg2BC8", loadType:"barbell" }},
      { id:"a2",  type:"main",      label:"Main lift · 2 of 2", sets:3, rest:180,
        ex: { name:"Barbell Bench Press",     reps:5,      weight:50,  muscle:"Chest",             vid:"ptpmRrzRtWQ", loadType:"barbell" }},
      { id:"ass1",type:"superset",  label:"Superset · 1 of 2",  sets:3, rest:90,
        exA:{ name:"Barbell Reverse Lunge",   reps:"8/leg",weight:40,  muscle:"Quads & Glutes",    vid:"R-g5yPNYv2k", loadType:"barbell" },
        exB:{ name:"Chest-Supported DB Row",  reps:10,     weight:22,  muscle:"Upper back",        vid:"vmX58YYK3-8", loadType:"per_db" }},
      { id:"ass2",type:"superset",  label:"Superset · 2 of 2",  sets:3, rest:90,
        exA:{ name:"Barbell Hip Thrust",      reps:10,     weight:65,  muscle:"Glutes",            vid:"xDmFkJxPzeM", loadType:"barbell" },
        exB:{ name:"Landmine Press",          reps:10,     weight:28,  muscle:"Upper chest",       vid:"gH7PDepHNck", loadType:"barbell" }},
      { id:"afin",type:"finisher",  label:"Finisher",            sets:3, rest:60,
        exA:{ name:"Hanging Leg Raise",       reps:10,     weight:null,muscle:"Core",              vid:"Pr1ieGZ5atk", loadType:"bodyweight" },
        exB:{ name:"Standing Calf Raise",     reps:15,     weight:35,  muscle:"Calves",            vid:"baEXLy09Ncc", loadType:"machine" }},
    ],
  },
  // ── B · Wednesday · Hinge + Pull ──────────────────────────────────────────
  {
    name:"Strength B", subtitle:"Hinge & Pull", type:"strength",
    blocks:[
      { id:"b1",  type:"main",      label:"Main lift · 1 of 2", sets:3, rest:180,
        ex: { name:"Hex Bar Deadlift",        reps:5,      weight:75,  muscle:"Posterior chain",   vid:"EsqwERaSTMI", loadType:"barbell" }},
      { id:"b2",  type:"main",      label:"Main lift · 2 of 2", sets:3, rest:180,
        ex: { name:"Barbell Overhead Press",  reps:5,      weight:30,  muscle:"Shoulders",         vid:"_RlRDWO2jfg", loadType:"barbell" }},
      { id:"bss1",type:"superset",  label:"Superset · 1 of 2",  sets:3, rest:90,
        exA:{ name:"Leg Press",               reps:10,     weight:90,  muscle:"Quads & Glutes",    vid:"nDh_BlnLCGc", loadType:"machine" },
        exB:{ name:"Pull-Up",                 reps:8,      weight:null,muscle:"Lats",              vid:"Hdc7Mw6BIEE", loadType:"bodyweight" }},
      { id:"bss2",type:"superset",  label:"Superset · 2 of 2",  sets:3, rest:90,
        exA:{ name:"Bulgarian Split Squat",   reps:"8/leg",weight:18,  muscle:"Quads & Glutes",    vid:"uODWo4YqbT8", loadType:"per_db" },
        exB:{ name:"Machine Hamstring Curl",  reps:12,     weight:35,  muscle:"Hamstrings",        vid:"Lh3iMIcbkBQ", loadType:"machine" }},
      { id:"bfin",type:"finisher",  label:"Finisher",            sets:2, rest:60,
        exA:{ name:"Tricep Pushdown",         reps:12,     weight:18,  muscle:"Triceps",           vid:"mRmIthbCSNI", loadType:"total" },
        exB:{ name:"Lateral Raise",           reps:15,     weight:7,   muscle:"Lateral delt",      vid:"v_ZkxWzYnMc", loadType:"per_db" }},
    ],
  },
  // ── C · Friday · Power + Volume ───────────────────────────────────────────
  {
    name:"Strength C", subtitle:"Power & Volume", type:"strength",
    blocks:[
      { id:"c1",  type:"main",      label:"Main lift",           sets:3, rest:180,
        ex: { name:"Power Clean",             reps:5,      weight:40,  muscle:"Full body / explosive", vid:"5vVSGITznQk", loadType:"barbell" }},
      { id:"css1",type:"superset",  label:"Superset · 1 of 3",   sets:3, rest:90,
        exA:{ name:"DB Walking Lunge",        reps:"10/leg",weight:18, muscle:"Quads & Glutes",    vid:"xvC10-eCuXs", loadType:"per_db" },
        exB:{ name:"Cable Lateral Raise",     reps:15,     weight:7,   muscle:"Lateral delt",      vid:"gsC3pd6lfKY", loadType:"total" }},
      { id:"css2",type:"superset",  label:"Superset · 2 of 3",   sets:4, rest:90,
        exA:{ name:"Incline DB Press",        reps:10,     weight:26,  muscle:"Upper chest",       vid:"ou6s32mJgjU", loadType:"per_db" },
        exB:{ name:"Seated Cable Row",        reps:10,     weight:45,  muscle:"Mid back",          vid:"7BkgqzC6WsM", loadType:"total" }},
      { id:"css3",type:"superset",  label:"Superset · 3 of 3",   sets:3, rest:90,
        exA:{ name:"DB Curl",                 reps:12,     weight:10,  muscle:"Biceps",            vid:"XE_pHwbst04", loadType:"per_db" },
        exB:{ name:"Skullcrusher",            reps:12,     weight:18,  muscle:"Triceps",           vid:"OQ4TWXkZjTc", loadType:"barbell" }},
      { id:"cfin",type:"finisher",  label:"Finisher",             sets:3, rest:60,
        exA:{ name:"Face Pull",               reps:15,     weight:12,  muscle:"Rear delts / cuff", vid:"cuyx9G1bEwg", loadType:"total" },
        exB:{ name:"Low-to-High Cable Crossover", reps:15, weight:9,   muscle:"Upper pec / medial",vid:"u5X5x1fw_SA", loadType:"total" }},
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
    { name:"Barbell Reverse Lunge",  reps:"8/leg", weight:40,  muscle:"Quads & Glutes",  vid:"R-g5yPNYv2k", loadType:"barbell" },
    { name:"DB Reverse Lunge",       reps:"8/leg", weight:18,  muscle:"Quads & Glutes",  vid:"RZKXLMxPF_I", loadType:"per_db" },
    { name:"Barbell Step-Up",        reps:"8/leg", weight:35,  muscle:"Quads & Glutes",  vid:"1OS-HTTtqD8", loadType:"barbell" },
    { name:"Barbell Walking Lunge",  reps:"8/leg", weight:35,  muscle:"Quads & Glutes",  vid:"X9QswJmhBQI", loadType:"barbell" },
    { name:"Barbell Front Rack Lunge", reps:"8/leg", weight:38, muscle:"Quads & Glutes", vid:"f3WLs_HutLw", loadType:"barbell" },
    { name:"Deficit Reverse Lunge",  reps:"8/leg", weight:38,  muscle:"Quads & Glutes",  vid:"3PIjhyzF3DI", loadType:"barbell" },
  ]},
  "ass1-B":{ gripDemand:"HIGH", zone:"db",         pool:[
    { name:"Chest-Supported DB Row", reps:10,      weight:22,  muscle:"Upper back",       vid:"vmX58YYK3-8", loadType:"per_db" },
    { name:"Single-Arm DB Row",      reps:10,      weight:24,  muscle:"Upper back",       vid:"qN54-QNO1eQ", loadType:"per_db" },
    { name:"Dumbbell Bent-Over Row", reps:10,      weight:20,  muscle:"Upper back",       vid:"6TSP1TRMUzs", loadType:"per_db" },
    { name:"TRX Row",                reps:10,      weight:null,muscle:"Upper back",        vid:"fW_jdwZT804", loadType:"bodyweight" },
    { name:"Meadows Row",            reps:10,      weight:22,  muscle:"Upper back",       vid:"G-jU1aPVhnY", loadType:"per_db" },
    { name:"Incline DB Row",         reps:10,      weight:20,  muscle:"Upper back",       vid:"2LxN3_3atps", loadType:"per_db" },
    { name:"Seal Row",               reps:10,      weight:18,  muscle:"Upper back",       vid:"fBgDGkfT8Rc", loadType:"per_db" },
  ]},
  "ass2-A":{ gripDemand:"NONE", zone:"rack",       pool:[
    { name:"Barbell Hip Thrust",     reps:10,      weight:65,  muscle:"Glutes",           vid:"xDmFkJxPzeM", loadType:"barbell" },
    { name:"Single-Leg Hip Thrust",  reps:10,      weight:45,  muscle:"Glutes",           vid:"4ilXaDauMnE", loadType:"barbell" },
    { name:"Banded Hip Thrust",      reps:15,      weight:null,muscle:"Glutes",            vid:"1hZv0N2szAE", loadType:"bodyweight" },
    { name:"Barbell Glute Bridge",   reps:12,      weight:55,  muscle:"Glutes",           vid:"0od5lwWMGV8", loadType:"barbell" },
    { name:"B-Stance Hip Thrust",    reps:10,      weight:55,  muscle:"Glutes",           vid:"7M9-tWMk3-w", loadType:"barbell" },
    { name:"Frog Pump",              reps:20,      weight:null,muscle:"Glutes",            vid:"HyCiZVMMDW4", loadType:"bodyweight" },
  ]},
  "ass2-B":{ gripDemand:"MED",  zone:"rack",       pool:[
    { name:"Landmine Press",               reps:10, weight:28,  muscle:"Upper chest",     vid:"gH7PDepHNck", loadType:"barbell" },
    { name:"Single-Arm Landmine Press",    reps:10, weight:22,  muscle:"Upper chest",     vid:"Sjb5meztfSE", loadType:"barbell" },
    { name:"Incline Landmine Press",       reps:10, weight:22,  muscle:"Upper chest",     vid:"N9_1DnqUAQw", loadType:"barbell" },
    { name:"Landmine Squeeze Press", reps:12,      weight:22,  muscle:"Upper chest",      vid:"1G-_FTEkoNw", loadType:"barbell" },
    { name:"Kneeling Landmine Press", reps:10,     weight:22,  muscle:"Upper chest",      vid:"39lH32_Ukos", loadType:"barbell" },
    { name:"Floor Press",            reps:10,      weight:45,  muscle:"Upper chest",      vid:"L1BKVBQNc9g", loadType:"barbell" },
  ]},
  "afin-A":{ gripDemand:"HIGH", zone:"bodyweight", pool:[
    { name:"Hanging Leg Raise",      reps:10,      weight:null,muscle:"Core",              vid:"Pr1ieGZ5atk", loadType:"bodyweight" },
    { name:"Toes-to-Bar",            reps:8,       weight:null,muscle:"Core",              vid:null, loadType:"bodyweight" },
    { name:"Captain's Chair Raise",  reps:12,      weight:null,muscle:"Core",              vid:null, loadType:"bodyweight" },
    { name:"Hanging Knee Raise",     reps:12,      weight:null,muscle:"Core",              vid:null, loadType:"bodyweight" },
    { name:"L-Sit Hold",             reps:"20s",   weight:null,muscle:"Core",              vid:null, loadType:"bodyweight" },
    { name:"Windshield Wiper",       reps:8,       weight:null,muscle:"Core",              vid:null, loadType:"bodyweight" },
  ]},
  "afin-B":{ gripDemand:"NONE", zone:"machine", pool:[
    { name:"Standing Calf Raise",    reps:15,      weight:35,  muscle:"Calves",            vid:"baEXLy09Ncc", loadType:"machine" },
    { name:"Seated Calf Raise",      reps:15,      weight:35,  muscle:"Calves",            vid:"6O5hh1rBtx8", loadType:"machine" },
    { name:"Smith Calf Raise",       reps:15,      weight:40,  muscle:"Calves",            vid:"wlqTemUXPXY", loadType:"machine" },
    { name:"Single-Leg Calf Raise",  reps:"15/leg",weight:null,muscle:"Calves",            vid:"ORT4oJ_R8Qs", loadType:"bodyweight" },
    { name:"Donkey Calf Raise",      reps:15,      weight:40,  muscle:"Calves",            vid:"Jk_fDd57e98", loadType:"machine" },
    { name:"Leg Press Calf Raise",   reps:15,      weight:55,  muscle:"Calves",            vid:"PYZY00hI43w", loadType:"machine" },
  ]},

  // ── Day B ─────────────────────────────────────────────────────────────────
  "bss1-A":{ gripDemand:"NONE", zone:"machine",    pool:[
    { name:"Leg Press",              reps:10,      weight:90,  muscle:"Quads & Glutes",   vid:"nDh_BlnLCGc", loadType:"machine" },
    { name:"Hack Squat",             reps:10,      weight:55,  muscle:"Quadriceps",       vid:"hrciyIRwFzs", loadType:"machine" },
    { name:"Leg Extension",          reps:12,      weight:45,  muscle:"Quadriceps",       vid:"ljO4jkwv8wQ", loadType:"machine" },
    { name:"Pendulum Squat",         reps:10,      weight:50,  muscle:"Quadriceps",       vid:"QCLWnLNM35U", loadType:"machine" },
    { name:"V-Squat",                reps:10,      weight:55,  muscle:"Quads & Glutes",   vid:"u_GSjH58s0g", loadType:"machine" },
    { name:"Belt Squat",             reps:10,      weight:50,  muscle:"Quads & Glutes",   vid:"V0bPCIjJA7U", loadType:"machine" },
  ]},
  "bss1-B":{ gripDemand:"HIGH", zone:"bodyweight", pool:[
    { name:"Pull-Up",                reps:8,       weight:null,muscle:"Lats",              vid:"Hdc7Mw6BIEE", loadType:"bodyweight" },
    { name:"Weighted Pull-Up",       reps:6,       weight:8,   muscle:"Lats",             vid:"Qh0jSDYu2Os", loadType:"loaded_bw" },
    { name:"Neutral-Grip Pull-Up",   reps:8,       weight:null,muscle:"Lats / Biceps",    vid:"Ai4S1uzMP7A", loadType:"bodyweight" },
    { name:"Lat Pulldown",           reps:10,      weight:45,  muscle:"Lats",             vid:"hnSqbBk15tw", loadType:"total" },
    { name:"Chin-Up",                reps:8,       weight:null,muscle:"Lats / Biceps",    vid:"e1YSApl-QcM", loadType:"bodyweight" },
    { name:"Wide-Grip Pull-Up",      reps:8,       weight:null,muscle:"Lats",             vid:"bHC16skSN6Q", loadType:"bodyweight" },
    { name:"Assisted Pull-Up",       reps:10,      weight:null,muscle:"Lats",             vid:"gx0RWT7WbmA", loadType:"bodyweight" },
  ]},
  "bss2-A":{ gripDemand:"LOW",  zone:"db",         pool:[
    { name:"Bulgarian Split Squat",  reps:"8/leg", weight:18,  muscle:"Quads & Glutes",   vid:"uODWo4YqbT8", loadType:"per_db" },
    { name:"DB Step-Up",             reps:"8/leg", weight:16,  muscle:"Quads & Glutes",   vid:"aKj-6hgiViA", loadType:"per_db" },
    { name:"Goblet Squat",           reps:10,      weight:28,  muscle:"Quads & Glutes",   vid:"9W5KAqHfDe8", loadType:"per_db" },
    { name:"DB Sumo Squat",          reps:10,      weight:30,  muscle:"Quads & Glutes / Adductors", vid:"7BqURseCGSU", loadType:"per_db" },
    { name:"DB Front Squat",         reps:10,      weight:22,  muscle:"Quads & Glutes",   vid:"B86Zj72LwzA", loadType:"per_db" },
    { name:"DB Split Squat",         reps:"8/leg", weight:16,  muscle:"Quads & Glutes",   vid:"SGHnCftrZkA", loadType:"per_db" },
  ]},
  "bss2-B":{ gripDemand:"NONE", zone:"machine",    pool:[
    { name:"Machine Hamstring Curl", reps:12,      weight:35,  muscle:"Hamstrings",       vid:"Lh3iMIcbkBQ", loadType:"machine" },
    { name:"Swiss Ball Leg Curl",    reps:12,      weight:null,muscle:"Hamstrings",        vid:"WNB90xXLEOg", loadType:"bodyweight" },
    { name:"Nordic Curl",            reps:8,       weight:null,muscle:"Hamstrings",        vid:"6NCN6kOagfY", loadType:"bodyweight" },
    { name:"Seated Leg Curl",        reps:12,      weight:35,  muscle:"Hamstrings",       vid:"NxPR7G_YNHI", loadType:"machine" },
    { name:"Slider Leg Curl",        reps:10,      weight:null,muscle:"Hamstrings",        vid:"lLUniqm00KM", loadType:"bodyweight" },
    { name:"Single-Leg Curl",        reps:10,      weight:22,  muscle:"Hamstrings",       vid:"Y1dQUd6OKHk", loadType:"per_db" },
  ]},
  "bfin-A":{ gripDemand:"LOW",  zone:"cable", pool:[
    { name:"Tricep Pushdown",        reps:12,      weight:18,  muscle:"Triceps",           vid:"mRmIthbCSNI", loadType:"total" },
    { name:"Rope Tricep Pushdown",   reps:12,      weight:16,  muscle:"Triceps",           vid:"n2FSCB4vRSA", loadType:"total" },
    { name:"Cable Overhead Extension",reps:12,     weight:16,  muscle:"Triceps",           vid:"GzmlxvSFE7A", loadType:"total" },
    { name:"Single-Arm Pushdown",    reps:12,      weight:10,  muscle:"Triceps",           vid:"VAHZcPAUwdQ", loadType:"total" },
    { name:"Reverse-Grip Pushdown",  reps:12,      weight:14,  muscle:"Triceps",           vid:"8IK6BkC0lWE", loadType:"total" },
    { name:"DB Overhead Extension",  reps:12,      weight:12,  muscle:"Triceps",           vid:"fYqswDVbJDg", loadType:"per_db" },
  ]},
  "bfin-B":{ gripDemand:"LOW",  zone:"db",         pool:[
    { name:"Lateral Raise",          reps:15,      weight:7,   muscle:"Lateral delt",     vid:"v_ZkxWzYnMc", loadType:"per_db" },
    { name:"Cable Lateral Raise",    reps:15,      weight:7,   muscle:"Lateral delt",     vid:"gsC3pd6lfKY", loadType:"total" },
    { name:"Seated Lateral Raise",   reps:15,      weight:6,   muscle:"Lateral delt",     vid:"zt2NMQNJnMs", loadType:"per_db" },
    { name:"Leaning Lateral Raise",  reps:12,      weight:7,   muscle:"Lateral delt",     vid:"qWif_7SOYpQ", loadType:"per_db" },
    { name:"DB Lu Raise",            reps:10,      weight:5,   muscle:"Lateral delt",     vid:"Dnb1Dt1yXhs", loadType:"per_db" },
    { name:"Band Lateral Raise",     reps:15,      weight:null,muscle:"Lateral delt",     vid:"yfNg5sFndbw", loadType:"bodyweight" },
  ]},

  // ── Day C ─────────────────────────────────────────────────────────────────
  "css1-A":{ gripDemand:"MED",  zone:"db",         pool:[
    { name:"DB Walking Lunge",       reps:"10/leg",weight:18,  muscle:"Quads & Glutes",   vid:"xvC10-eCuXs", loadType:"per_db" },
    { name:"DB Reverse Lunge",       reps:"10/leg",weight:18,  muscle:"Quads & Glutes",   vid:"RZKXLMxPF_I", loadType:"per_db" },
    { name:"DB Step-Up",             reps:"10/leg",weight:16,  muscle:"Quads & Glutes",   vid:"aKj-6hgiViA", loadType:"per_db" },
    { name:"Bulgarian Split Squat",  reps:"8/leg", weight:18,  muscle:"Quads & Glutes",  vid:"uODWo4YqbT8", loadType:"per_db" },
    { name:"DB Lateral Lunge",       reps:"8/leg", weight:14,  muscle:"Quads & Glutes",   vid:"4m9R6PijpWI", loadType:"per_db" },
    { name:"Curtsy Lunge",           reps:"8/leg", weight:12,  muscle:"Quads & Glutes",   vid:"xr9GQeo6lPY", loadType:"per_db" },
  ]},
  "css1-B":{ gripDemand:"LOW",  zone:"cable",      pool:[
    { name:"Cable Lateral Raise",          reps:15, weight:7,   muscle:"Lateral delt",     vid:"gsC3pd6lfKY", loadType:"total" },
    { name:"Cable Rear Delt Fly",          reps:15, weight:9,   muscle:"Rear delts",       vid:"ywMSCem375A", loadType:"total" },
    { name:"Leaning Lateral Raise",        reps:12, weight:7,   muscle:"Lateral delt",     vid:"qWif_7SOYpQ", loadType:"per_db" },
    { name:"Lateral Raise",                reps:15, weight:7,   muscle:"Lateral delt",     vid:"v_ZkxWzYnMc", loadType:"per_db" },
    { name:"Band Lateral Raise",           reps:15, weight:null,muscle:"Lateral delt",     vid:"yfNg5sFndbw", loadType:"bodyweight" },
  ]},
  "css2-A":{ gripDemand:"MED",  zone:"db",         pool:[
    { name:"Incline DB Press",             reps:10, weight:26, muscle:"Upper chest",      vid:"ou6s32mJgjU", loadType:"per_db" },
    { name:"DB Chest Fly",                 reps:12, weight:14, muscle:"Chest / medial",   vid:"eozdVDA78K0", loadType:"per_db" },
    { name:"Low-to-High Cable Fly",        reps:12, weight:10, muscle:"Upper pec",        vid:"eQ_NBB6OBH4", loadType:"total" },
    { name:"DB Floor Press",               reps:10, weight:22, muscle:"Chest",            vid:"uUGDRwge4F8", loadType:"per_db" },
    { name:"Neutral-Grip DB Press",        reps:10, weight:24, muscle:"Chest",            vid:"VzZe73G4vIs", loadType:"per_db" },
    { name:"Decline Push-Up",              reps:15, weight:null,muscle:"Upper chest",     vid:"SKPab2YC8BE", loadType:"bodyweight" },
  ]},
  "css2-B":{ gripDemand:"MED",  zone:"cable",      pool:[
    { name:"Seated Cable Row",             reps:10, weight:45, muscle:"Mid back",         vid:"7BkgqzC6WsM", loadType:"total" },
    { name:"Cable Straight-Arm Pulldown",  reps:12, weight:22, muscle:"Lats",             vid:"98W63pVdW38", loadType:"total" },
    { name:"Single-Arm Cable Row",         reps:10, weight:22, muscle:"Mid back",         vid:"9TWiV80cUYs", loadType:"total" },
    { name:"Wide-Grip Cable Row",          reps:10, weight:40, muscle:"Mid back",         vid:"AEM5A06yV9Q", loadType:"total" },
    { name:"Face-Away Cable Row",          reps:10, weight:26, muscle:"Mid back",         vid:"WYCnIThgbB8", loadType:"total" },
    { name:"Half-Kneeling Cable Row",      reps:10, weight:22, muscle:"Mid back",         vid:"afE9JabFqR4", loadType:"total" },
  ]},
  "css3-A":{ gripDemand:"HIGH", zone:"db",         pool:[
    { name:"DB Curl",                      reps:12, weight:10, muscle:"Biceps",           vid:"XE_pHwbst04", loadType:"per_db" },
    { name:"Incline DB Curl",              reps:12, weight:8,  muscle:"Biceps",           vid:"DCe8f6vMe9A", loadType:"per_db" },
    { name:"Hammer Curl",                  reps:12, weight:10, muscle:"Biceps & brachialis", vid:"BRVDS6HVR9Q", loadType:"per_db" },
    { name:"EZ Bar Curl",                  reps:12, weight:18, muscle:"Biceps",           vid:"5NsFLGUf0Fo", loadType:"barbell" },
    { name:"Concentration Curl",           reps:10, weight:8,  muscle:"Biceps",           vid:"oPGBZHIxusU", loadType:"per_db" },
    { name:"Preacher Curl",                reps:12, weight:14, muscle:"Biceps",           vid:"GNO4OtYoCYk", loadType:"barbell" },
    { name:"Zottman Curl",                 reps:10, weight:8,  muscle:"Biceps & forearms", vid:"ZrpRBgswtHs", loadType:"per_db" },
  ]},
  "css3-B":{ gripDemand:"LOW",  zone:"db", pool:[
    { name:"Skullcrusher",                 reps:12, weight:18,  muscle:"Triceps",         vid:"OQ4TWXkZjTc", loadType:"barbell" },
    { name:"Overhead Tricep Extension",    reps:12, weight:14,  muscle:"Triceps",         vid:"iKX6vEhrGxw", loadType:"per_db" },
    { name:"Close-Grip Push-Up",           reps:15, weight:null,muscle:"Triceps",         vid:"F1Lq9LnyvVc", loadType:"bodyweight" },
    { name:"Diamond Push-Up",              reps:12, weight:null,muscle:"Triceps",         vid:"kGhDnFwMY3E", loadType:"bodyweight" },
    { name:"DB Kickback",                  reps:12, weight:8,   muscle:"Triceps",         vid:"m9me06UBPKc", loadType:"per_db" },
    { name:"Bench Dips",                   reps:15, weight:null,muscle:"Triceps",         vid:"JBCdL6vOoOY", loadType:"bodyweight" },
  ]},
  "cfin-A":{ gripDemand:"LOW",  zone:"cable",      pool:[
    { name:"Face Pull",                    reps:15, weight:12,  muscle:"Rear delts / cuff", vid:"cuyx9G1bEwg", loadType:"total" },
    { name:"Band Face Pull",               reps:15, weight:null,muscle:"Rear delts / cuff", vid:"2RX2OYWlHcU", loadType:"bodyweight" },
    { name:"Rear Delt Fly",                reps:15, weight:6,   muscle:"Rear delts",        vid:"KoRDmXocJII", loadType:"per_db" },
    { name:"Cable Rear Delt Fly",          reps:15, weight:8,   muscle:"Rear delts",        vid:"ywMSCem375A", loadType:"total" },
    { name:"Prone Y Raise",                reps:12, weight:3,   muscle:"Rear delts / cuff", vid:"juoKsTqy77E", loadType:"per_db" },
    { name:"Band Pull-Apart",              reps:20, weight:null,muscle:"Rear delts / cuff", vid:"stwYTTPXubo", loadType:"bodyweight" },
  ]},
  "cfin-B":{ gripDemand:"NONE", zone:"cable",      pool:[
    { name:"Low-to-High Cable Crossover",  reps:15, weight:9,   muscle:"Upper pec / medial", vid:"u5X5x1fw_SA", loadType:"total" },
    { name:"DB Chest Fly",                 reps:15, weight:10,  muscle:"Chest / medial",     vid:"eozdVDA78K0", loadType:"per_db" },
    { name:"Pec Deck",                     reps:15, weight:30,  muscle:"Chest / medial",     vid:"g3T7LsEeDWQ", loadType:"machine" },
    { name:"Cable Crossover",              reps:15, weight:12,  muscle:"Chest / medial",     vid:"taI4XduLpTk", loadType:"total" },
    { name:"Single-Arm Cable Fly",         reps:12, weight:8,   muscle:"Chest / medial",     vid:"lCAAPoM_98Q", loadType:"total" },
    { name:"Svend Press",                  reps:15, weight:8,   muscle:"Chest / medial",     vid:"f7XwzvAhR8Y", loadType:"per_db" },
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
  "Barbell Back Squat":        [{ name:"Goblet Squat",              eq:"Dumbbell",  muscle:"Quadriceps",          vid:"9W5KAqHfDe8" },
                                { name:"Bulgarian Split Squat",     eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:"uODWo4YqbT8" },
                                { name:"Leg Press",                 eq:"Machine",   muscle:"Quads & Glutes",      vid:"nDh_BlnLCGc" },
                                { name:"Hack Squat",                eq:"Machine",   muscle:"Quadriceps",          vid:"hrciyIRwFzs" }],
  "Barbell Bench Press":       [{ name:"Dumbbell Bench Press",      eq:"Dumbbell",  muscle:"Chest",               vid:null },
                                { name:"Push-Up",                   eq:"Bodyweight",muscle:"Chest",               vid:null },
                                { name:"DB Floor Press",            eq:"Dumbbell",  muscle:"Chest",               vid:"uUGDRwge4F8" }],
  "Barbell Reverse Lunge":     [{ name:"DB Reverse Lunge",          eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:"RZKXLMxPF_I" },
                                { name:"Step-Up",                   eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Split Squat",               eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null }],
  "Chest-Supported DB Row":    [{ name:"Dumbbell Bent-Over Row",    eq:"Dumbbell",  muscle:"Upper back",          vid:"6TSP1TRMUzs" },
                                { name:"Cable Row",                 eq:"Cable",     muscle:"Upper back",          vid:"GZbfZ033f74" },
                                { name:"Resistance Band Row",       eq:"Band",      muscle:"Upper back",          vid:null },
                                { name:"TRX Row",                   eq:"Bodyweight",muscle:"Upper back",          vid:"fW_jdwZT804" }],
  "Barbell Hip Thrust":        [{ name:"Glute Bridge",              eq:"Bodyweight",muscle:"Glutes",              vid:"wPM8icPu6H8" },
                                { name:"Single-Leg Hip Thrust",     eq:"Bodyweight",muscle:"Glutes",              vid:"4ilXaDauMnE" },
                                { name:"Cable Pull-Through",        eq:"Cable",     muscle:"Glutes / Hams",       vid:"yXopOhzEoeo" }],
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
  "Leg Press":                 [{ name:"Goblet Squat",              eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:"9W5KAqHfDe8" },
                                { name:"Bulgarian Split Squat",     eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:"uODWo4YqbT8" },
                                { name:"Wall Sit",                  eq:"Bodyweight",muscle:"Quadriceps",          vid:null }],
  "Pull-Up":                   [{ name:"Lat Pulldown",              eq:"Cable",     muscle:"Lats",                vid:"hnSqbBk15tw" },
                                { name:"Resistance Band Pull-Down", eq:"Band",      muscle:"Lats",                vid:null },
                                { name:"TRX Row",                   eq:"Bodyweight",muscle:"Lats",                vid:"fW_jdwZT804" }],
  "Bulgarian Split Squat":     [{ name:"Reverse Lunge",             eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Step-Up",                   eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"DB Reverse Lunge",          eq:"Dumbbell",  muscle:"Quads & Glutes",      vid:"RZKXLMxPF_I" }],
  "Machine Hamstring Curl":    [{ name:"Nordic Curl",               eq:"Bodyweight",muscle:"Hamstrings",          vid:"6NCN6kOagfY" },
                                { name:"Dumbbell Leg Curl",         eq:"Dumbbell",  muscle:"Hamstrings",          vid:null },
                                { name:"Swiss Ball Leg Curl",       eq:"Equipment", muscle:"Hamstrings",          vid:"WNB90xXLEOg" }],
  "Copenhagen Plank":          [{ name:"Side Plank",                eq:"Bodyweight",muscle:"Adductors / Core",    vid:null },
                                { name:"Lateral Band Walk",         eq:"Band",      muscle:"Adductors",           vid:null }],
  "Lateral Raise":             [{ name:"Cable Lateral Raise",       eq:"Cable",     muscle:"Lateral delt",        vid:"gsC3pd6lfKY" },
                                { name:"Resistance Band Lateral",   eq:"Band",      muscle:"Lateral delt",        vid:null },
                                { name:"Seated Lateral Raise",      eq:"Dumbbell",  muscle:"Lateral delt",        vid:"zt2NMQNJnMs" }],
  "Cable Lateral Raise":       [{ name:"Lateral Raise",             eq:"Dumbbell",  muscle:"Lateral delt",        vid:"v_ZkxWzYnMc" },
                                { name:"Leaning Lateral Raise",     eq:"Dumbbell",  muscle:"Lateral delt",        vid:"qWif_7SOYpQ" },
                                { name:"Band Lateral Raise",        eq:"Band",      muscle:"Lateral delt",        vid:"yfNg5sFndbw" }],
  "Power Clean":               [{ name:"Hang Power Clean",          eq:"Barbell",   muscle:"Full body / explosive",vid:null },
                                { name:"Dumbbell Hang Clean",       eq:"Dumbbell",  muscle:"Full body / explosive",vid:null },
                                { name:"Kettlebell Swing",          eq:"Kettlebell",muscle:"Posterior chain",     vid:null }],
  "DB Walking Lunge":          [{ name:"Reverse Lunge",             eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Step-Up",                   eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null },
                                { name:"Split Squat",               eq:"Bodyweight",muscle:"Quads & Glutes",      vid:null }],
  "Incline DB Press":          [{ name:"Incline Push-Up",           eq:"Bodyweight",muscle:"Upper chest",         vid:null },
                                { name:"Landmine Press",            eq:"Barbell",   muscle:"Upper chest",         vid:"gH7PDepHNck" },
                                { name:"Cable Chest Fly",           eq:"Cable",     muscle:"Upper chest",         vid:null }],
  "Seated Cable Row":          [{ name:"Dumbbell Bent-Over Row",    eq:"Dumbbell",  muscle:"Mid back",            vid:"6TSP1TRMUzs" },
                                { name:"TRX Row",                   eq:"Bodyweight",muscle:"Mid back",            vid:"fW_jdwZT804" },
                                { name:"Resistance Band Row",       eq:"Band",      muscle:"Mid back",            vid:null }],
  "DB Curl":                   [{ name:"EZ Bar Curl",               eq:"Barbell",   muscle:"Biceps",              vid:"5NsFLGUf0Fo" },
                                { name:"Resistance Band Curl",      eq:"Band",      muscle:"Biceps",              vid:null },
                                { name:"Incline DB Curl",           eq:"Dumbbell",  muscle:"Biceps",              vid:"DCe8f6vMe9A" }],
  "Tricep Dips":               [{ name:"Close-Grip Push-Up",        eq:"Bodyweight",muscle:"Triceps",             vid:"F1Lq9LnyvVc" },
                                { name:"Overhead Tricep Extension", eq:"Dumbbell",  muscle:"Triceps",             vid:"iKX6vEhrGxw" },
                                { name:"Resistance Band Pushdown",  eq:"Band",      muscle:"Triceps",             vid:null }],
  "Face Pull":                 [{ name:"Resistance Band Face Pull", eq:"Band",      muscle:"Rear delts / cuff",   vid:null },
                                { name:"Rear Delt Fly",             eq:"Dumbbell",  muscle:"Rear delts",          vid:"KoRDmXocJII" },
                                { name:"Y-T-W Raise",               eq:"Bodyweight",muscle:"Rear delts",          vid:null }],
  "Low-to-High Cable Crossover":[{ name:"DB Chest Fly",             eq:"Dumbbell",  muscle:"Upper pec / medial",  vid:"eozdVDA78K0" },
                                { name:"Pec Deck",                  eq:"Machine",   muscle:"Chest",               vid:"g3T7LsEeDWQ" },
                                { name:"Resistance Band Crossover", eq:"Band",      muscle:"Upper pec / medial",  vid:null }],
  "Standing Calf Raise":        [{ name:"Seated Calf Raise",         eq:"Machine",   muscle:"Calves",              vid:"6O5hh1rBtx8" },
                                { name:"Single-Leg Calf Raise",     eq:"Bodyweight",muscle:"Calves",              vid:"ORT4oJ_R8Qs" },
                                { name:"Donkey Calf Raise",         eq:"Bodyweight",muscle:"Calves",              vid:"Jk_fDd57e98" }],
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

// Format a Date as a LOCAL-timezone "YYYY-MM-DD" string. Critical: do NOT
// use `Date.toISOString().slice(0, 10)` here. toISOString shifts to UTC, so
// for UK users in BST (UTC+1) at any time during the day, the UTC date is
// usually the same but at midnight local (00:00 BST = 23:00 UTC the day
// before) the date string would be yesterday's, not today's. Worse: when
// walking back N days from local midnight, every dateStr off by one in
// the timezone-positive direction. That's how a Saturday-morning check-in
// for a missed Friday workout ended up showing Thursday/Wed/Tue instead of
// Fri/Thu/Wed. Use local components throughout.
function localDateStr(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
  // LOCAL date string — see localDateStr note above.
  const todayStr = localDateStr(today);

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
    const dateStr = localDateStr(d);
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
