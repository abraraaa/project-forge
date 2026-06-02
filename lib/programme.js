// lib/programme.js
// ─────────────────────────────────────────────────────────────────────────────
// All static programme data and rotation logic.
// No React, no localStorage — pure data and pure functions.
// Update this file when changing exercises, pools, or session structure.
// ForgeApp.jsx and any future analytics routes import from here.
// ─────────────────────────────────────────────────────────────────────────────

import { distributeAcrossMuscles, DISPLAY_BUCKET, getAnatomy } from "./exercise-anatomy.js";

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

// Maps WEEK index → SESSIONS index  (Mon=0, Wed=1, Fri=2 for the default week).
// For the user-editable week, derive at runtime via deriveStrengthDaySessions.
export const STRENGTH_DAY_SESSIONS = { 0:0, 2:1, 4:2 };

// Derive the strength-day → SESSIONS index mapping from any week config.
// Walks the week in order; each `type: "strength"` slot consumes the next
// session (0 → A, 1 → B, 2 → C). Extra strength days (4th, 5th) cycle back
// to A → so users with a heavier week still get every default session covered.
// Returns the same shape as STRENGTH_DAY_SESSIONS so callers are drop-in.
export function deriveStrengthDaySessions(week = WEEK) {
  const out = {};
  let idx = 0;
  for (let i = 0; i < (week?.length || 0); i++) {
    if (week[i]?.type === "strength") {
      out[i] = idx % SESSIONS.length;
      idx++;
    }
  }
  return out;
}

// ─── Three strength sessions ───────────────────────────────────────────────────
// Pool[0] of each accessory slot is the programme default.
// EXERCISE_POOLS (below) defines all alternatives for rotation.

export const SESSIONS = [
  // ── A · Monday · Squat + Push ─────────────────────────────────────────────
  {
    name:"Strength A", subtitle:"Squat & Push", type:"strength",
    blocks:[
      { id:"a1",  type:"main",      label:"Main lift · 1 of 2", sets:3, rest:180,
        ex: { name:"Barbell Back Squat",      reps:5,      weight:55,  muscle:"Quadriceps",        vid:"bEv6CCg2BC8", loadType:"barbell", loadProfile:"heavy_low_rep" }},
      { id:"a2",  type:"main",      label:"Main lift · 2 of 2", sets:3, rest:180,
        ex: { name:"Barbell Bench Press",     reps:5,      weight:50,  muscle:"Chest",             vid:"ptpmRrzRtWQ", loadType:"barbell", loadProfile:"heavy_low_rep" }},
      { id:"ass1",type:"superset",  label:"Superset · 1 of 2",  sets:3, rest:90,
        exA:{ name:"Barbell Reverse Lunge",   reps:"8/leg",weight:40,  muscle:"Quads & Glutes",    vid:"R-g5yPNYv2k", loadType:"barbell", loadProfile:"moderate_mid_rep" },
        exB:{ name:"Chest-Supported DB Row",  reps:10,     weight:22,  muscle:"Upper back",        vid:"vmX58YYK3-8", loadType:"per_db", loadProfile:"moderate_mid_rep" }},
      { id:"ass2",type:"superset",  label:"Superset · 2 of 2",  sets:3, rest:90,
        exA:{ name:"Barbell Hip Thrust",      reps:10,     weight:65,  muscle:"Glutes",            vid:"xDmFkJxPzeM", loadType:"barbell", loadProfile:"moderate_mid_rep" },
        exB:{ name:"Landmine Press",          reps:10,     weight:28,  muscle:"Upper chest",       vid:"gH7PDepHNck", loadType:"barbell", loadProfile:"moderate_mid_rep" }},
      { id:"afin",type:"finisher",  label:"Finisher",            sets:3, rest:60,
        exA:{ name:"Hanging Leg Raise",       reps:10,     weight:null,muscle:"Core",              vid:"Pr1ieGZ5atk", loadType:"bodyweight", loadProfile:"light_high_rep" },
        exB:{ name:"Standing Calf Raise",     reps:15,     weight:35,  muscle:"Calves",            vid:"baEXLy09Ncc", loadType:"machine", loadProfile:"light_high_rep" }},
    ],
  },
  // ── B · Wednesday · Hinge + Pull ──────────────────────────────────────────
  {
    name:"Strength B", subtitle:"Hinge & Pull", type:"strength",
    blocks:[
      { id:"b1",  type:"main",      label:"Main lift · 1 of 2", sets:3, rest:180,
        ex: { name:"Hex Bar Deadlift",        reps:5,      weight:75,  muscle:"Posterior chain",   vid:"EsqwERaSTMI", loadType:"barbell", loadProfile:"heavy_low_rep" }},
      { id:"b2",  type:"main",      label:"Main lift · 2 of 2", sets:3, rest:180,
        ex: { name:"Barbell Overhead Press",  reps:5,      weight:30,  muscle:"Shoulders",         vid:"_RlRDWO2jfg", loadType:"barbell", loadProfile:"heavy_low_rep" }},
      { id:"bss1",type:"superset",  label:"Superset · 1 of 2",  sets:3, rest:90,
        exA:{ name:"Leg Press",               reps:10,     weight:90,  muscle:"Quads & Glutes",    vid:"nDh_BlnLCGc", loadType:"machine", loadProfile:"moderate_mid_rep" },
        exB:{ name:"Pull-Up",                 reps:8,      weight:null,muscle:"Lats",              vid:"Hdc7Mw6BIEE", loadType:"bodyweight", loadProfile:"moderate_mid_rep" }},
      { id:"bss2",type:"superset",  label:"Superset · 2 of 2",  sets:3, rest:90,
        exA:{ name:"Bulgarian Split Squat",   reps:"8/leg",weight:18,  muscle:"Quads & Glutes",    vid:"uODWo4YqbT8", loadType:"per_db", loadProfile:"moderate_mid_rep" },
        exB:{ name:"Machine Hamstring Curl",  reps:12,     weight:35,  muscle:"Hamstrings",        vid:"Lh3iMIcbkBQ", loadType:"machine", loadProfile:"moderate_mid_rep" }},
      { id:"bfin",type:"finisher",  label:"Finisher",            sets:2, rest:60,
        exA:{ name:"Tricep Pushdown",         reps:12,     weight:18,  muscle:"Triceps",           vid:"mRmIthbCSNI", loadType:"total", loadProfile:"light_high_rep" },
        exB:{ name:"Lateral Raise",           reps:15,     weight:7,   muscle:"Lateral delt",      vid:"v_ZkxWzYnMc", loadType:"per_db", loadProfile:"light_high_rep" }},
    ],
  },
  // ── C · Friday · Power + Volume ───────────────────────────────────────────
  {
    name:"Strength C", subtitle:"Power & Volume", type:"strength",
    blocks:[
      { id:"c1",  type:"main",      label:"Main lift",           sets:3, rest:180,
        ex: { name:"Power Clean",             reps:5,      weight:40,  muscle:"Full body / explosive", vid:"5vVSGITznQk", loadType:"barbell", loadProfile:"heavy_low_rep" }},
      { id:"css1",type:"superset",  label:"Superset · 1 of 3",   sets:3, rest:90,
        exA:{ name:"DB Walking Lunge",        reps:"10/leg",weight:18, muscle:"Quads & Glutes",    vid:"xvC10-eCuXs", loadType:"per_db", loadProfile:"moderate_mid_rep" },
        exB:{ name:"Cable Lateral Raise",     reps:15,     weight:7,   muscle:"Lateral delt",      vid:"gsC3pd6lfKY", loadType:"total", loadProfile:"light_high_rep" }},
      { id:"css2",type:"superset",  label:"Superset · 2 of 3",   sets:4, rest:90,
        exA:{ name:"Incline DB Press",        reps:10,     weight:26,  muscle:"Upper chest",       vid:"ou6s32mJgjU", loadType:"per_db", loadProfile:"moderate_mid_rep" },
        exB:{ name:"Seated Cable Row",        reps:10,     weight:45,  muscle:"Mid back",          vid:"7BkgqzC6WsM", loadType:"total", loadProfile:"moderate_mid_rep" }},
      { id:"css3",type:"superset",  label:"Superset · 3 of 3",   sets:3, rest:90,
        exA:{ name:"DB Curl",                 reps:12,     weight:10,  muscle:"Biceps",            vid:"XE_pHwbst04", loadType:"per_db", loadProfile:"moderate_mid_rep" },
        exB:{ name:"Skullcrusher",            reps:12,     weight:18,  muscle:"Triceps",           vid:"OQ4TWXkZjTc", loadType:"barbell", loadProfile:"moderate_mid_rep" }},
      { id:"cfin",type:"finisher",  label:"Finisher",             sets:3, rest:60,
        exA:{ name:"Face Pull",               reps:15,     weight:12,  muscle:"Rear delts / cuff", vid:"cuyx9G1bEwg", loadType:"total", loadProfile:"light_high_rep" },
        exB:{ name:"Low-to-High Cable Crossover", reps:15, weight:9,   muscle:"Upper pec / medial",vid:"u5X5x1fw_SA", loadType:"total", loadProfile:"light_high_rep" }},
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
  "ass1-A":{ gripDemand:"LOW", zone:"rack", loadProfile:"moderate_mid_rep", pool:[
    { name:"Barbell Reverse Lunge",  reps:"8/leg", weight:40,  muscle:"Quads & Glutes",  vid:"R-g5yPNYv2k", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"DB Reverse Lunge",       reps:"8/leg", weight:18,  muscle:"Quads & Glutes",  vid:"RZKXLMxPF_I", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Barbell Step-Up",        reps:"8/leg", weight:35,  muscle:"Quads & Glutes",  vid:"1OS-HTTtqD8", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Barbell Walking Lunge",  reps:"8/leg", weight:35,  muscle:"Quads & Glutes",  vid:"X9QswJmhBQI", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Barbell Front Rack Lunge", reps:"8/leg", weight:38, muscle:"Quads & Glutes", vid:"f3WLs_HutLw", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Deficit Reverse Lunge",  reps:"8/leg", weight:38,  muscle:"Quads & Glutes",  vid:"3PIjhyzF3DI", loadType:"barbell", loadProfile:"moderate_mid_rep" },
  ]},
  "ass1-B":{ gripDemand:"HIGH", zone:"db", loadProfile:"moderate_mid_rep", pool:[
    { name:"Chest-Supported DB Row", reps:10,      weight:22,  muscle:"Upper back",       vid:"vmX58YYK3-8", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Single-Arm DB Row",      reps:10,      weight:24,  muscle:"Upper back",       vid:"qN54-QNO1eQ", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Dumbbell Bent-Over Row", reps:10,      weight:20,  muscle:"Upper back",       vid:"6TSP1TRMUzs", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"TRX Row",                reps:10,      weight:null,muscle:"Upper back",        vid:"fW_jdwZT804", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Meadows Row",            reps:10,      weight:22,  muscle:"Upper back",       vid:"G-jU1aPVhnY", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Incline DB Row",         reps:10,      weight:20,  muscle:"Upper back",       vid:"2LxN3_3atps", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Seal Row",               reps:10,      weight:18,  muscle:"Upper back",       vid:"fBgDGkfT8Rc", loadType:"per_db", loadProfile:"moderate_mid_rep" },
  ]},
  "ass2-A":{ gripDemand:"NONE", zone:"rack", loadProfile:"moderate_mid_rep", pool:[
    { name:"Barbell Hip Thrust",     reps:10,      weight:65,  muscle:"Glutes",           vid:"xDmFkJxPzeM", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Single-Leg Hip Thrust",  reps:10,      weight:45,  muscle:"Glutes",           vid:"4ilXaDauMnE", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Banded Hip Thrust",      reps:15,      weight:null,muscle:"Glutes",            vid:"1hZv0N2szAE", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Barbell Glute Bridge",   reps:12,      weight:55,  muscle:"Glutes",           vid:"0od5lwWMGV8", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"B-Stance Hip Thrust",    reps:10,      weight:55,  muscle:"Glutes",           vid:"7M9-tWMk3-w", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Frog Pump",              reps:20,      weight:null,muscle:"Glutes",            vid:"HyCiZVMMDW4", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Single-Leg RDL",         reps:"8/leg", weight:18,  muscle:"Glutes / Hams",    vid:"J0bEKhnP-Mw", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"45-Degree Hip Extension",reps:15,      weight:null,muscle:"Glutes / Posterior chain", vid:"wMMhBY-Izks", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Reverse Hyperextension", reps:12,      weight:25,  muscle:"Glutes / Lower back", vid:"eHMxSNViRWw", loadType:"machine", loadProfile:"moderate_mid_rep" },
  ]},
  "ass2-B":{ gripDemand:"MED", zone:"rack", loadProfile:"moderate_mid_rep", pool:[
    { name:"Landmine Press",               reps:10, weight:28,  muscle:"Upper chest",     vid:"gH7PDepHNck", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Single-Arm Landmine Press",    reps:10, weight:22,  muscle:"Upper chest",     vid:"Sjb5meztfSE", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Incline Landmine Press",       reps:10, weight:22,  muscle:"Upper chest",     vid:"N9_1DnqUAQw", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Landmine Squeeze Press", reps:12,      weight:22,  muscle:"Upper chest",      vid:"1G-_FTEkoNw", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Kneeling Landmine Press", reps:10,     weight:22,  muscle:"Upper chest",      vid:"39lH32_Ukos", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Floor Press",            reps:10,      weight:45,  muscle:"Upper chest",      vid:"L1BKVBQNc9g", loadType:"barbell", loadProfile:"moderate_mid_rep" },
  ]},
  "afin-A":{ gripDemand:"HIGH", zone:"bodyweight", loadProfile:"light_high_rep", pool:[
    { name:"Hanging Leg Raise",      reps:10,      weight:null,muscle:"Core",              vid:"Pr1ieGZ5atk", loadType:"bodyweight", loadProfile:"light_high_rep" },
    { name:"Toes-to-Bar",            reps:8,       weight:null,muscle:"Core",              vid:"0vilSf6UwWU", loadType:"bodyweight", loadProfile:"light_high_rep" },
    { name:"Captain's Chair Raise",  reps:12,      weight:null,muscle:"Core",              vid:"UqmbxvOgnX4", loadType:"bodyweight", loadProfile:"light_high_rep" },
    { name:"Hanging Knee Raise",     reps:12,      weight:null,muscle:"Core",              vid:"RD_A-Z15ER4", loadType:"bodyweight", loadProfile:"light_high_rep" },
    { name:"L-Sit Hold",             reps:"20s",   weight:null,muscle:"Core",              vid:"11B3alBjq-U", loadType:"bodyweight", loadProfile:"light_high_rep" },
    { name:"Windshield Wiper",       reps:8,       weight:null,muscle:"Core",              vid:"X59_4RrU_aA", loadType:"bodyweight", loadProfile:"light_high_rep" },
  ]},
  "afin-B":{ gripDemand:"NONE", zone:"machine", loadProfile:"light_high_rep", pool:[
    { name:"Standing Calf Raise",    reps:15,      weight:35,  muscle:"Calves",            vid:"baEXLy09Ncc", loadType:"machine", loadProfile:"light_high_rep" },
    { name:"Seated Calf Raise",      reps:15,      weight:35,  muscle:"Calves",            vid:"6O5hh1rBtx8", loadType:"machine", loadProfile:"light_high_rep" },
    { name:"Smith Calf Raise",       reps:15,      weight:40,  muscle:"Calves",            vid:"wlqTemUXPXY", loadType:"machine", loadProfile:"light_high_rep" },
    { name:"Single-Leg Calf Raise",  reps:"15/leg",weight:null,muscle:"Calves",            vid:"ORT4oJ_R8Qs", loadType:"bodyweight", loadProfile:"light_high_rep" },
    { name:"Donkey Calf Raise",      reps:15,      weight:40,  muscle:"Calves",            vid:"Jk_fDd57e98", loadType:"machine", loadProfile:"light_high_rep" },
    { name:"Leg Press Calf Raise",   reps:15,      weight:55,  muscle:"Calves",            vid:"PYZY00hI43w", loadType:"machine", loadProfile:"light_high_rep" },
  ]},

  // ── Day B ─────────────────────────────────────────────────────────────────
  "bss1-A":{ gripDemand:"NONE", zone:"machine", loadProfile:"moderate_mid_rep", pool:[
    { name:"Leg Press",              reps:10,      weight:90,  muscle:"Quads & Glutes",   vid:"nDh_BlnLCGc", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"Hack Squat",             reps:10,      weight:55,  muscle:"Quadriceps",       vid:"hrciyIRwFzs", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"Leg Extension",          reps:12,      weight:45,  muscle:"Quadriceps",       vid:"ljO4jkwv8wQ", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"Pendulum Squat",         reps:10,      weight:50,  muscle:"Quadriceps",       vid:"QCLWnLNM35U", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"V-Squat",                reps:10,      weight:55,  muscle:"Quads & Glutes",   vid:"u_GSjH58s0g", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"Belt Squat",             reps:10,      weight:50,  muscle:"Quads & Glutes",   vid:"V0bPCIjJA7U", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"Sissy Squat",            reps:12,      weight:null,muscle:"Quadriceps",       vid:"DOxGMy258rM", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
  ]},
  "bss1-B":{ gripDemand:"HIGH", zone:"bodyweight", loadProfile:"moderate_mid_rep", pool:[
    { name:"Pull-Up",                reps:8,       weight:null,muscle:"Lats",              vid:"Hdc7Mw6BIEE", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Weighted Pull-Up",       reps:6,       weight:8,   muscle:"Lats",             vid:"Qh0jSDYu2Os", loadType:"loaded_bw", loadProfile:"moderate_mid_rep" },
    { name:"Neutral-Grip Pull-Up",   reps:8,       weight:null,muscle:"Lats / Biceps",    vid:"Ai4S1uzMP7A", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Lat Pulldown",           reps:10,      weight:45,  muscle:"Lats",             vid:"hnSqbBk15tw", loadType:"total", loadProfile:"moderate_mid_rep" },
    { name:"Chin-Up",                reps:8,       weight:null,muscle:"Lats / Biceps",    vid:"e1YSApl-QcM", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Wide-Grip Pull-Up",      reps:8,       weight:null,muscle:"Lats",             vid:"bHC16skSN6Q", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Assisted Pull-Up",       reps:10,      weight:null,muscle:"Lats",             vid:"gx0RWT7WbmA", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
  ]},
  "bss2-A":{ gripDemand:"LOW", zone:"db", loadProfile:"moderate_mid_rep", pool:[
    { name:"Bulgarian Split Squat",  reps:"8/leg", weight:18,  muscle:"Quads & Glutes",   vid:"uODWo4YqbT8", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Step-Up",             reps:"8/leg", weight:16,  muscle:"Quads & Glutes",   vid:"aKj-6hgiViA", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Goblet Squat",           reps:10,      weight:28,  muscle:"Quads & Glutes",   vid:"9W5KAqHfDe8", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Sumo Squat",          reps:10,      weight:30,  muscle:"Quads & Glutes / Adductors", vid:"7BqURseCGSU", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Front Squat",         reps:10,      weight:22,  muscle:"Quads & Glutes",   vid:"B86Zj72LwzA", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Split Squat",         reps:"8/leg", weight:16,  muscle:"Quads & Glutes",   vid:"SGHnCftrZkA", loadType:"per_db", loadProfile:"moderate_mid_rep" },
  ]},
  "bss2-B":{ gripDemand:"NONE", zone:"machine", loadProfile:"moderate_mid_rep", pool:[
    { name:"Machine Hamstring Curl", reps:12,      weight:35,  muscle:"Hamstrings",       vid:"Lh3iMIcbkBQ", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"Swiss Ball Leg Curl",    reps:12,      weight:null,muscle:"Hamstrings",        vid:"WNB90xXLEOg", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Nordic Curl",            reps:8,       weight:null,muscle:"Hamstrings",        vid:"6NCN6kOagfY", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Seated Leg Curl",        reps:12,      weight:35,  muscle:"Hamstrings",       vid:"NxPR7G_YNHI", loadType:"machine", loadProfile:"moderate_mid_rep" },
    { name:"Slider Leg Curl",        reps:10,      weight:null,muscle:"Hamstrings",        vid:"lLUniqm00KM", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Single-Leg Curl",        reps:10,      weight:22,  muscle:"Hamstrings",       vid:"Y1dQUd6OKHk", loadType:"per_db", loadProfile:"moderate_mid_rep" },
  ]},
  "bfin-A":{ gripDemand:"LOW", zone:"cable", loadProfile:"light_high_rep", pool:[
    { name:"Tricep Pushdown",        reps:12,      weight:18,  muscle:"Triceps",           vid:"mRmIthbCSNI", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Rope Tricep Pushdown",   reps:12,      weight:16,  muscle:"Triceps",           vid:"n2FSCB4vRSA", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Cable Overhead Extension",reps:12,     weight:16,  muscle:"Triceps",           vid:"GzmlxvSFE7A", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Single-Arm Pushdown",    reps:12,      weight:10,  muscle:"Triceps",           vid:"VAHZcPAUwdQ", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Reverse-Grip Pushdown",  reps:12,      weight:14,  muscle:"Triceps",           vid:"8IK6BkC0lWE", loadType:"total", loadProfile:"light_high_rep" },
    { name:"DB Overhead Extension",  reps:12,      weight:12,  muscle:"Triceps",           vid:"fYqswDVbJDg", loadType:"per_db", loadProfile:"light_high_rep" },
  ]},
  "bfin-B":{ gripDemand:"LOW", zone:"db", loadProfile:"light_high_rep", pool:[
    { name:"Lateral Raise",          reps:15,      weight:7,   muscle:"Lateral delt",     vid:"v_ZkxWzYnMc", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Cable Lateral Raise",    reps:15,      weight:7,   muscle:"Lateral delt",     vid:"gsC3pd6lfKY", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Seated Lateral Raise",   reps:15,      weight:6,   muscle:"Lateral delt",     vid:"zt2NMQNJnMs", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Leaning Lateral Raise",  reps:12,      weight:7,   muscle:"Lateral delt",     vid:"qWif_7SOYpQ", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"DB Lu Raise",            reps:10,      weight:5,   muscle:"Lateral delt",     vid:"Dnb1Dt1yXhs", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Band Lateral Raise",     reps:15,      weight:null,muscle:"Lateral delt",     vid:"yfNg5sFndbw", loadType:"bodyweight", loadProfile:"light_high_rep" },
  ]},

  // ── Day C ─────────────────────────────────────────────────────────────────
  "css1-A":{ gripDemand:"MED", zone:"db", loadProfile:"moderate_mid_rep", pool:[
    { name:"DB Walking Lunge",       reps:"10/leg",weight:18,  muscle:"Quads & Glutes",   vid:"xvC10-eCuXs", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Reverse Lunge",       reps:"10/leg",weight:18,  muscle:"Quads & Glutes",   vid:"RZKXLMxPF_I", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Step-Up",             reps:"10/leg",weight:16,  muscle:"Quads & Glutes",   vid:"aKj-6hgiViA", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Bulgarian Split Squat",  reps:"8/leg", weight:18,  muscle:"Quads & Glutes",  vid:"uODWo4YqbT8", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Lateral Lunge",       reps:"8/leg", weight:14,  muscle:"Quads & Glutes",   vid:"4m9R6PijpWI", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Curtsy Lunge",           reps:"8/leg", weight:12,  muscle:"Quads & Glutes",   vid:"xr9GQeo6lPY", loadType:"per_db", loadProfile:"moderate_mid_rep" },
  ]},
  "css1-B":{ gripDemand:"LOW", zone:"cable", loadProfile:"light_high_rep", pool:[
    { name:"Cable Lateral Raise",          reps:15, weight:7,   muscle:"Lateral delt",     vid:"gsC3pd6lfKY", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Cable Rear Delt Fly",          reps:15, weight:9,   muscle:"Rear delts",       vid:"ywMSCem375A", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Leaning Lateral Raise",        reps:12, weight:7,   muscle:"Lateral delt",     vid:"qWif_7SOYpQ", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Lateral Raise",                reps:15, weight:7,   muscle:"Lateral delt",     vid:"v_ZkxWzYnMc", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Band Lateral Raise",           reps:15, weight:null,muscle:"Lateral delt",     vid:"yfNg5sFndbw", loadType:"bodyweight", loadProfile:"light_high_rep" },
  ]},
  "css2-A":{ gripDemand:"MED", zone:"db", loadProfile:"moderate_mid_rep", pool:[
    { name:"Incline DB Press",             reps:10, weight:26, muscle:"Upper chest",      vid:"ou6s32mJgjU", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"DB Chest Fly",                 reps:12, weight:14, muscle:"Chest / medial",   vid:"eozdVDA78K0", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Low-to-High Cable Fly",        reps:12, weight:10, muscle:"Upper pec",        vid:"eQ_NBB6OBH4", loadType:"total", loadProfile:"moderate_mid_rep" },
    { name:"DB Floor Press",               reps:10, weight:22, muscle:"Chest",            vid:"uUGDRwge4F8", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Neutral-Grip DB Press",        reps:10, weight:24, muscle:"Chest",            vid:"VzZe73G4vIs", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Decline Push-Up",              reps:15, weight:null,muscle:"Upper chest",     vid:"SKPab2YC8BE", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
  ]},
  "css2-B":{ gripDemand:"MED", zone:"cable", loadProfile:"moderate_mid_rep", pool:[
    { name:"Seated Cable Row",             reps:10, weight:45, muscle:"Mid back",         vid:"7BkgqzC6WsM", loadType:"total", loadProfile:"moderate_mid_rep" },
    { name:"Cable Straight-Arm Pulldown",  reps:12, weight:22, muscle:"Lats",             vid:"98W63pVdW38", loadType:"total", loadProfile:"moderate_mid_rep" },
    { name:"Single-Arm Cable Row",         reps:10, weight:22, muscle:"Mid back",         vid:"9TWiV80cUYs", loadType:"total", loadProfile:"moderate_mid_rep" },
    { name:"Wide-Grip Cable Row",          reps:10, weight:40, muscle:"Mid back",         vid:"AEM5A06yV9Q", loadType:"total", loadProfile:"moderate_mid_rep" },
    { name:"Face-Away Cable Row",          reps:10, weight:26, muscle:"Mid back",         vid:"WYCnIThgbB8", loadType:"total", loadProfile:"moderate_mid_rep" },
    { name:"Half-Kneeling Cable Row",      reps:10, weight:22, muscle:"Mid back",         vid:"afE9JabFqR4", loadType:"total", loadProfile:"moderate_mid_rep" },
  ]},
  "css3-A":{ gripDemand:"HIGH", zone:"db", loadProfile:"moderate_mid_rep", pool:[
    { name:"DB Curl",                      reps:12, weight:10, muscle:"Biceps",           vid:"XE_pHwbst04", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Incline DB Curl",              reps:12, weight:8,  muscle:"Biceps",           vid:"DCe8f6vMe9A", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Hammer Curl",                  reps:12, weight:10, muscle:"Biceps & brachialis", vid:"BRVDS6HVR9Q", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"EZ Bar Curl",                  reps:12, weight:18, muscle:"Biceps",           vid:"5NsFLGUf0Fo", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Concentration Curl",           reps:10, weight:8,  muscle:"Biceps",           vid:"oPGBZHIxusU", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Preacher Curl",                reps:12, weight:14, muscle:"Biceps",           vid:"GNO4OtYoCYk", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Zottman Curl",                 reps:10, weight:8,  muscle:"Biceps & forearms", vid:"ZrpRBgswtHs", loadType:"per_db", loadProfile:"moderate_mid_rep" },
  ]},
  "css3-B":{ gripDemand:"LOW", zone:"db", loadProfile:"moderate_mid_rep", pool:[
    { name:"Skullcrusher",                 reps:12, weight:18,  muscle:"Triceps",         vid:"OQ4TWXkZjTc", loadType:"barbell", loadProfile:"moderate_mid_rep" },
    { name:"Overhead Tricep Extension",    reps:12, weight:14,  muscle:"Triceps",         vid:"iKX6vEhrGxw", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Close-Grip Push-Up",           reps:15, weight:null,muscle:"Triceps",         vid:"F1Lq9LnyvVc", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"Diamond Push-Up",              reps:12, weight:null,muscle:"Triceps",         vid:"kGhDnFwMY3E", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
    { name:"DB Kickback",                  reps:12, weight:8,   muscle:"Triceps",         vid:"m9me06UBPKc", loadType:"per_db", loadProfile:"moderate_mid_rep" },
    { name:"Bench Dips",                   reps:15, weight:null,muscle:"Triceps",         vid:"JBCdL6vOoOY", loadType:"bodyweight", loadProfile:"moderate_mid_rep" },
  ]},
  "cfin-A":{ gripDemand:"LOW", zone:"cable", loadProfile:"light_high_rep", pool:[
    { name:"Face Pull",                    reps:15, weight:12,  muscle:"Rear delts / cuff", vid:"cuyx9G1bEwg", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Band Face Pull",               reps:15, weight:null,muscle:"Rear delts / cuff", vid:"2RX2OYWlHcU", loadType:"bodyweight", loadProfile:"light_high_rep" },
    { name:"Rear Delt Fly",                reps:15, weight:6,   muscle:"Rear delts",        vid:"KoRDmXocJII", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Cable Rear Delt Fly",          reps:15, weight:8,   muscle:"Rear delts",        vid:"ywMSCem375A", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Prone Y Raise",                reps:12, weight:3,   muscle:"Rear delts / cuff", vid:"juoKsTqy77E", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Band Pull-Apart",              reps:20, weight:null,muscle:"Rear delts / cuff", vid:"stwYTTPXubo", loadType:"bodyweight", loadProfile:"light_high_rep" },
  ]},
  "cfin-B":{ gripDemand:"NONE", zone:"cable", loadProfile:"light_high_rep", pool:[
    { name:"Low-to-High Cable Crossover",  reps:15, weight:9,   muscle:"Upper pec / medial", vid:"u5X5x1fw_SA", loadType:"total", loadProfile:"light_high_rep" },
    { name:"DB Chest Fly",                 reps:15, weight:10,  muscle:"Chest / medial",     vid:"eozdVDA78K0", loadType:"per_db", loadProfile:"light_high_rep" },
    { name:"Pec Deck",                     reps:15, weight:30,  muscle:"Chest / medial",     vid:"g3T7LsEeDWQ", loadType:"machine", loadProfile:"light_high_rep" },
    { name:"Cable Crossover",              reps:15, weight:12,  muscle:"Chest / medial",     vid:"taI4XduLpTk", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Single-Arm Cable Fly",         reps:12, weight:8,   muscle:"Chest / medial",     vid:"lCAAPoM_98Q", loadType:"total", loadProfile:"light_high_rep" },
    { name:"Svend Press",                  reps:15, weight:8,   muscle:"Chest / medial",     vid:"f7XwzvAhR8Y", loadType:"per_db", loadProfile:"light_high_rep" },
  ]},
};

// Superset pairs — used for zone validation when rotating
export const SS_PAIRS = [
  ["ass1-A","ass1-B"], ["ass2-A","ass2-B"],
  ["bss1-A","bss1-B"], ["bss2-A","bss2-B"],
  ["css1-A","css1-B"], ["css2-A","css2-B"], ["css3-A","css3-B"],
];

// ─── Main-lift functional equivalents ───────────────────────────────────────
// The approved substitution lists for each main lift. Engine consumers
// (Olympic-comfort onboarding, future main-lift rotation) read this map; the
// SWAP_DB entries above must align with it (enforced by an invariant test).
//
// Key constraint: every alternative is heavy_low_rep — a main lift never
// rotates to a lighter substitute (the progressive-overload spine of the
// programme). For Power Clean, Kettlebell Swing is explicitly excluded — it's
// a finisher movement, wrong load profile.
//
// For the doc's "Trap Bar variants" entry under Hex Bar DL: Hex Bar IS a trap
// bar, so high-handle vs low-handle is a setup choice rather than a separate
// movement. Captured by the existing default rather than a swap.
export const MAIN_LIFT_FUNCTIONAL_EQUIVALENTS = {
  "Barbell Back Squat":     ["Front Squat", "Hack Squat"],
  "Barbell Bench Press":    ["Dumbbell Bench Press", "Incline BB Press", "DB Floor Press", "Weighted Dips"],
  "Hex Bar Deadlift":       ["Sumo Deadlift", "Romanian Deadlift"],
  "Barbell Overhead Press": ["Dumbbell Shoulder Press", "Push Press", "Arnold Press"],
  "Power Clean":            ["Hang Power Clean", "Push Press"],
};

// ─── Rotation thresholds (in weeks on current block) ─────────────────────────
export const ROTATION_OPTIONAL = 4;   // "rotate now" card appears on home
export const ROTATION_AUTO     = 8;   // auto-rotate before next session starts
export const ROTATION_FORCED   = 12;  // cannot dismiss — rotation happens

// Zone-compatible pairing check
function zonesCompatible(za, zb) {
  if (za === zb) return true;
  return ZONE_ADJ[za]?.includes(zb) || false;
}

// Pick new accessories, avoiding recent block selections where possible.
// Zone constraints are honoured via re-pick up to MAX_RETRIES.
// If no zone-compatible pair exists after retries, we accept the mismatch
// and log it — grip/muscle-stimulus variety is more important than geography.
//
// `history` shape: { [slotKey]: string[] }  — most-recent first, oldest last.
// We default to excluding up to ROTATION_MEMORY_BLOCKS prior selections per
// slot (kills the A→B→A ping-pong that single-block memory created). Accepts
// legacy single-string entries transparently; they're treated as a 1-element
// array so users upgrading from the old shape lose nothing on first rotate.
export const ROTATION_MEMORY_BLOCKS = 3;

function recentNamesFor(historyEntry) {
  if (Array.isArray(historyEntry)) return historyEntry;
  if (typeof historyEntry === "string") return [historyEntry];
  return [];
}

// ─── Training focus — accessory bias ─────────────────────────────────────────
// Bias the rotation engine's accessory pick by user-chosen training focus,
// without rewriting SESSIONS. The main lifts stay universal ("shared pain");
// only ACCESSORY pool selection is affected. Each focus is a *score function*
// over a pool entry's anatomy distribution:
//   - Forged: identity — every candidate scores 1.0 (current behaviour).
//   - Sculpt: weighted dot product against visible-muscle weights. Pool entries
//             whose primary/secondary anatomy aligns with chest/delts/arms/
//             glutes get higher scores → picked more often. Unisex framing for
//             a hypertrophy-biased aesthetic outcome.
//   - Strong: compoundness — pool entries with more total muscle work (primary
//             + secondary sum) score higher. Compound movements rank above
//             isolation; matches a strength-first preference.
// Future focuses can be added with their own score function.

export const FOCUS_OPTIONS = ["Forged", "Strong", "Sculpt"];
export const DEFAULT_FOCUS = "Forged";

// Short summaries used by the picker UI + the Profile-screen row. Single
// source of truth so copy stays consistent across surfaces.
export const FOCUS_SUMMARIES = {
  Forged: "Balanced strength + conditioning. The default Forge programme.",
  Strong: "Compound-priority, strength-first. Heavier accessories, fewer isolations.",
  Sculpt: "Visible-muscle bias — chest, shoulders, arms, glutes weighted higher.",
};

// Sculpt: visible-muscle weight vector. Default 1.0 for unlisted muscles.
const SCULPT_WEIGHTS = {
  Chest: 1.5,
  "Front Delts": 1.4, "Side Delts": 1.4, "Rear Delts": 1.0,
  Biceps: 1.5, Triceps: 1.5,
  Glutes: 1.5,
  // Lower body other than glutes (quads/hams/calves) and back stay at 1.0 —
  // they still get picked but aren't emphasised. Core stays 1.0.
};

// Score a pool entry under a given focus. Returns a positive float; higher =
// more aligned. Forged returns 1.0 across the board (uniform random fallthrough).
export function scoreExerciseForFocus(ex, focus) {
  if (!focus || focus === "Forged") return 1;
  const anatomy = getAnatomy(ex?.name);
  if (!anatomy) return 1; // unmapped — uniform pick rather than zero (which would exclude)

  if (focus === "Strong") {
    // Compoundness — total muscle work. Primary is implicit 1.0; sum secondary
    // weights. So Squat (Quads 1 + Glutes 0.5 + Hams 0.25 + Core 0.3 + Calves 0.15)
    // scores 2.2; Leg Extension (Quads 1 + 0) scores 1.0. Compound > isolation.
    const sec = Object.values(anatomy.secondary || {}).reduce((a, b) => a + b, 0);
    return 1 + sec;
  }

  if (focus === "Sculpt") {
    let score = SCULPT_WEIGHTS[anatomy.primary] ?? 1;
    for (const [muscle, weight] of Object.entries(anatomy.secondary || {})) {
      score += (SCULPT_WEIGHTS[muscle] ?? 1) * weight;
    }
    return score;
  }

  return 1;
}

// Weighted random pick — given parallel arrays of candidates + their scores
// (all positive), returns a candidate with probability proportional to score.
// Falls back to last entry on numeric edge cases (e.g. all-zero scores —
// shouldn't happen because scoreExerciseForFocus floors at 1, but defensive).
function weightedPick(candidates, scores) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const total = scores.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return candidates[Math.floor(Math.random() * candidates.length)];
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= scores[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

export function rotateAccessories(history = {}, { focus = DEFAULT_FOCUS } = {}) {
  const config = {};

  // First pass: independent pick per slot, excluding up to N recent selections
  // and filtering by the slot's load profile (so a heavy-low-rep movement
  // never rotates into a finisher slot, and vice versa). Profile filtering is
  // a no-op for slots that don't declare one. Within the eligible set, we pick
  // weighted-random by focus (uniform for Forged).
  Object.entries(EXERCISE_POOLS).forEach(([key, slot]) => {
    const { pool, loadProfile } = slot;
    const recent = recentNamesFor(history[key]);
    const onProfile = loadProfile
      ? pool.filter(ex => ex.loadProfile === loadProfile)
      : pool;
    const available = onProfile.filter(ex => !recent.includes(ex.name));
    // Fallback ladder: if 3-block exclusion empties the on-profile pool,
    // relax exclusion (but keep the profile filter — we never cross profiles).
    // If even the profile filter empties, accept any pool entry as last resort.
    let candidates = available;
    if (candidates.length === 0 && recent.length > 1) {
      candidates = onProfile.filter(ex => ex.name !== recent[0]);
    }
    if (candidates.length === 0) candidates = onProfile;
    if (candidates.length === 0) candidates = pool;
    const scores = candidates.map(ex => scoreExerciseForFocus(ex, focus));
    config[key] = weightedPick(candidates, scores);
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

// Push a freshly-rotated config onto the per-slot exclusion history, capped at
// ROTATION_MEMORY_BLOCKS. Pure helper — given the previous history (in either
// legacy string or new array shape) and the config that just became active,
// returns the new history to persist.
export function pushHistoryBlock(prevHistory = {}, newConfig = {}) {
  const next = {};
  Object.entries(newConfig).forEach(([key, ex]) => {
    if (!ex?.name) return;
    const prev = recentNamesFor(prevHistory[key]);
    next[key] = [ex.name, ...prev.filter(n => n !== ex.name)].slice(0, ROTATION_MEMORY_BLOCKS);
  });
  return next;
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

// ─── Slot key → SESSIONS sets count (memoised lazily) ────────────────────────
// Slot keys in EXERCISE_POOLS are "<blockId>-<A|B>". The block's `sets` count
// is the multiplier the muscle-stimulus delta uses to compare configs honestly:
// a 3-set superset changes muscle exposure by 3× the per-rep difference between
// old and new movements, not 1×.
let _slotSetsCache = null;
function slotSetsMap() {
  if (_slotSetsCache) return _slotSetsCache;
  const m = {};
  for (const sess of SESSIONS) {
    for (const block of sess.blocks) {
      if (block.exA) m[`${block.id}-A`] = block.sets;
      if (block.exB) m[`${block.id}-B`] = block.sets;
      if (block.ex)  m[block.id] = block.sets;
    }
  }
  _slotSetsCache = m;
  return m;
}

// Compute the per-(display-bucket)-muscle stimulus delta between two configs.
// Positive value = new config delivers MORE weighted sets to that muscle this
// block; negative = less. Drives the anatomy-aware rotation summary card.
//
// Aggregation matches lib/analytics.js: each slot's sets count is distributed
// across muscles by exercise anatomy (primary 1.0 + weighted secondaries) via
// distributeAcrossMuscles, then bucketed to the 9 display groups so the UI
// shares vocabulary with the Performance Lab.
//
// @param {Record<string, {name:string, muscle?:string}>} oldConfig
// @param {Record<string, {name:string, muscle?:string}>} newConfig
// @returns {Array<{bucket:string, delta:number}>}  sorted by |delta| desc
export function computeRotationStimulusDelta(oldConfig = {}, newConfig = {}) {
  const sets = slotSetsMap();
  const totals = {}; // displayBucket → net delta
  const keys = new Set([...Object.keys(oldConfig || {}), ...Object.keys(newConfig || {})]);

  for (const key of keys) {
    const setsCount = sets[key];
    if (!setsCount) continue;
    const oldEx = oldConfig?.[key] || EXERCISE_POOLS[key]?.pool?.[0];
    const newEx = newConfig?.[key] || EXERCISE_POOLS[key]?.pool?.[0];
    if (!oldEx?.name || !newEx?.name || oldEx.name === newEx.name) continue;

    const oldContrib = distributeAcrossMuscles(oldEx.name, setsCount, oldEx.muscle);
    const newContrib = distributeAcrossMuscles(newEx.name, setsCount, newEx.muscle);
    const muscles = new Set([...Object.keys(oldContrib), ...Object.keys(newContrib)]);
    for (const m of muscles) {
      const bucket = DISPLAY_BUCKET[m] || m;
      const d = (newContrib[m] || 0) - (oldContrib[m] || 0);
      if (d !== 0) totals[bucket] = (totals[bucket] || 0) + d;
    }
  }

  return Object.entries(totals)
    .map(([bucket, delta]) => ({ bucket, delta: Math.round(delta * 10) / 10 }))
    .filter(({ delta }) => delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
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

// ─── Cardio-day bonus challenges ─────────────────────────────────────────────
// Optional 5-minute capacity finishers offered on Moderate Cardio + HIIT days
// ONLY. Deliberately NOT on Zone 2 (an anaerobic spike defeats Z2's recovery
// purpose), nor rest/strength days. These are motivational extras — "today's
// bonus", never homework — and completion is tracked in a separate store with
// ZERO streak/rhythm impact (see P.markBonusDone).
//
// These are metabolic, full-body conditioning movements — the Hyrox/calisthenic
// flavour. They are intentionally NOT in EXERCISE_POOLS (wrong loadProfile,
// zone, and muscle-matching for the isolation finisher slots) and NOT logged as
// training volume, so they don't touch the anatomy dataset or the volume audit.
export const CARDIO_BONUS_POOL = [
  { name: "Sled Push",          detail: "4 lengths, heavy. Rest as needed between." },
  { name: "Wall Balls",         detail: "3 × 15. Full squat, hit the target." },
  { name: "Sandbag Carry",      detail: "4 × 20m. Bear hug, brace, walk tall." },
  { name: "Farmer's Carry",     detail: "4 × 30m. Heavy, grip-limited." },
  { name: "Burpee Ladder",      detail: "1-2-3…up to 5, then back down." },
  { name: "Pistol Squats",      detail: "3 × 5/leg. Controlled, full depth — scale to a box." },
  { name: "Kettlebell Swings",  detail: "3 × 20. Explosive hips, not arms." },
  { name: "Devil's Press",      detail: "3 × 8. Burpee into a double-DB snatch." },
  { name: "Row Sprint",         detail: "5 × 150m. All out, full recovery." },
  { name: "Assault Bike",       detail: "5 × 20s sprint / 40s easy." },
];

// Day types that may receive a bonus. Single source of truth for the guardrail.
export const BONUS_ELIGIBLE_DAY_TYPES = new Set(["cardio", "hiit"]);

// Deterministically pick a bonus for a given date + day type. Stable within a
// day (same pick all day), varies day to day. Returns null for ineligible day
// types so callers can guard with a simple truthiness check.
export function bonusForDay(dateStr, dayType) {
  if (!BONUS_ELIGIBLE_DAY_TYPES.has(dayType)) return null;
  if (!dateStr || typeof dateStr !== "string") return null;
  // Hash the ISO date to an index — cheap, deterministic, no storage needed.
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % CARDIO_BONUS_POOL.length;
  return CARDIO_BONUS_POOL[idx];
}

// ─── Swap overlay data ─────────────────────────────────────────────────────────
export const EQ_COLOUR = {
  Bodyweight:"#8BB09A", Dumbbell:"#A5B8D0", Cable:"#C4A882",
  Machine:"#C9A0B8",    Barbell:"#E0956A",  Band:"#8BB09A",
  Kettlebell:"#C4A882", Equipment:"#A5B8D0",
};

export const SWAP_DB = {
  // Main-lift swaps: heavy_low_rep functional equivalents only. Light
  // substitutes (Goblet Squat, Push-Up, Glute Bridge etc.) are deliberately
  // excluded — a main lift swapped to a lighter movement breaks progressive
  // overload continuity. Source list: MAIN_LIFT_FUNCTIONAL_EQUIVALENTS below.
  "Barbell Back Squat":        [{ name:"Front Squat",               eq:"Barbell",   muscle:"Quadriceps",          vid:null },
                                { name:"Hack Squat",                eq:"Machine",   muscle:"Quadriceps",          vid:"hrciyIRwFzs" }],
  "Barbell Bench Press":       [{ name:"Dumbbell Bench Press",            eq:"Dumbbell",  muscle:"Chest",               vid:null },
                                { name:"Incline BB Press",          eq:"Barbell",   muscle:"Upper chest",         vid:null },
                                { name:"DB Floor Press",            eq:"Dumbbell",  muscle:"Chest",               vid:"uUGDRwge4F8" },
                                { name:"Weighted Dips",             eq:"Bodyweight",muscle:"Chest / Triceps",     vid:null }],
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
  "Hex Bar Deadlift":          [{ name:"Sumo Deadlift",             eq:"Barbell",   muscle:"Posterior chain",     vid:null },
                                { name:"Romanian Deadlift",         eq:"Barbell",   muscle:"Posterior chain",     vid:"hCDzSR6bW10" }],
  "Barbell Overhead Press":    [{ name:"Dumbbell Shoulder Press",         eq:"Dumbbell",  muscle:"Shoulders",           vid:null },
                                { name:"Push Press",                eq:"Barbell",   muscle:"Shoulders",           vid:null },
                                { name:"Arnold Press",              eq:"Dumbbell",  muscle:"Shoulders",           vid:null }],
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
  // Power Clean swap: Hang Power Clean is the first-choice equivalent for
  // experienced lifters; Push Press is the heavy non-Olympic alternative.
  // Kettlebell Swing is explicitly REJECTED — it's a finisher movement, not a
  // main-lift load profile.
  "Power Clean":               [{ name:"Hang Power Clean",          eq:"Barbell",   muscle:"Full body / explosive",vid:null },
                                { name:"Push Press",                eq:"Barbell",   muscle:"Shoulders",           vid:null }],
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
export function sessionMetaForDate(dateStr, week = WEEK) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const d = new Date(dateStr + "T12:00:00"); // noon-anchor avoids DST edge cases
  if (isNaN(d.getTime())) return null;

  const dow     = d.getDay();
  const weekIdx = JS_DAY_TO_WEEK_INDEX[dow];
  const weekDay = week?.[weekIdx];
  if (!weekDay) return null;

  const dateLabel = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  if (weekDay.type === "strength") {
    const strengthDaySessions = (week === WEEK) ? STRENGTH_DAY_SESSIONS : deriveStrengthDaySessions(week);
    const sessionIdx = strengthDaySessions[weekIdx];
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
export function findRecentDays(history = [], daysBack = 3, { order = "desc", week = WEEK } = {}) {
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
    const meta    = sessionMetaForDate(dateStr, week);
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
export function hasMissedStrength(history = [], daysBack = 3, { week = WEEK } = {}) {
  const rows = findRecentDays(history, daysBack, { week });
  return rows.some(r => r.type === "strength" && !r.logged);
}
