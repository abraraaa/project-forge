// @ts-check
// lib/programme.js
// ─────────────────────────────────────────────────────────────────────────────
// All static programme data and rotation logic.
// No React, no localStorage — pure data and pure functions.
// Update this file when changing exercises, pools, or session structure.
// ForgeApp.jsx and any future analytics routes import from here.
// ─────────────────────────────────────────────────────────────────────────────

import { distributeAcrossMuscles, DISPLAY_BUCKET, getAnatomy } from "./exercise-anatomy.js";
import { localDateStr } from "./dates.js";

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
      { id:"c1",  type:"main",      label:"Main lift",           sets:4, rest:180,
        ex: { name:"Power Clean",             reps:3,      weight:40,  muscle:"Full body / explosive", vid:"5vVSGITznQk", loadType:"barbell", loadProfile:"heavy_low_rep" }},
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
  db:         ["rack","cable","bodyweight"],
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
    // Floor Press intentionally removed from this slot — same horizontal-
    // push pattern as Barbell Bench Press (the day's main lift), so a
    // rotation roll into Floor Press here produces two near-identical
    // movements in the same session. It stays in SWAP_DB["Barbell Bench
    // Press"] so users can still substitute it for Bench explicitly.
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
    { name:"Weighted Pull-Up",       reps:6,       weight:8,   muscle:"Lats",             vid:"Qh0jSDYu2Os", loadType:"loaded_bodyweight", loadProfile:"moderate_mid_rep" },
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
    { name:"Svend Press",                  reps:15, weight:8,   muscle:"Chest / medial",     vid:"f7XwzvAhR8Y", loadType:"total", loadProfile:"light_high_rep" },
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
// (A ROTATION_FORCED=12 tier was declared here for months but never enforced
// anywhere — deleted by the rotation audit rather than left implying a
// behaviour the app doesn't have. The AUTO tier is the only hard trigger.)

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
  Sculpt: "Built to be seen. Chest, shoulders, arms and glutes sit high in every week's volume.",
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

  // Second pass: deduplicate across slots. The pools overlap (e.g. "Leaning
  // Lateral Raise" lives in both bfin-B and css1-B), so two independent picks
  // can land on the same exercise — meaning the user trains it twice in the
  // same week. Walk the config in slot-key order: for any slot whose pick
  // already appears in an earlier slot, re-pick from its candidates excluding
  // every name claimed so far. The first-defined slot wins; later duplicates
  // re-roll. If a slot can't satisfy uniqueness (every option already claimed),
  // fall back to the original pick — better a duplicate than an empty slot.
  const claimed = new Set();
  Object.entries(config).forEach(([key, pick]) => {
    if (!pick?.name) return;
    if (!claimed.has(pick.name)) {
      claimed.add(pick.name);
      return;
    }
    // Duplicate detected — re-roll this slot avoiding all currently claimed names.
    const slot = EXERCISE_POOLS[key];
    if (!slot) { claimed.add(pick.name); return; }
    const { pool, loadProfile } = slot;
    const onProfile = loadProfile
      ? pool.filter(ex => ex.loadProfile === loadProfile)
      : pool;
    const recent = recentNamesFor(history[key]);
    // Prefer: on-profile, not-recent, not-claimed. Then loosen.
    let candidates = onProfile.filter(ex => !recent.includes(ex.name) && !claimed.has(ex.name));
    if (candidates.length === 0) candidates = onProfile.filter(ex => !claimed.has(ex.name));
    if (candidates.length === 0) candidates = pool.filter(ex => !claimed.has(ex.name));
    if (candidates.length === 0) {
      // Pool is fully claimed — keep the duplicate. Programmatically rare;
      // would only happen for tiny pools with significant cross-slot overlap.
      claimed.add(pick.name);
      return;
    }
    const scores = candidates.map(ex => scoreExerciseForFocus(ex, focus));
    const replacement = weightedPick(candidates, scores);
    config[key] = replacement;
    claimed.add(replacement.name);
  });

  // Third pass: validate SS pairs, re-pick if zones are incompatible.
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

// One-shot migration for existing programmeBlock.config entries that have
// cross-slot duplicates from before the dedup pass landed (e.g. the user
// who rolled Leaning Lateral Raise into both bfin-B and css1-B). Walks the
// config in slot order; for any slot whose pick already appears earlier,
// re-rolls from its candidate pool excluding all claimed names. Same logic
// as the second pass of rotateAccessories above.
//
// Returns the deduped config (new object, never mutates input). If no
// duplicates were found, returns the input reference for cheap identity
// comparison: `if (next !== config) PB.save({...pb, config: next})`.
export function dedupeRotationConfig(config = {}, history = {}, { focus = DEFAULT_FOCUS } = {}) {
  if (!config || Object.keys(config).length === 0) return config;
  let mutated = null; // lazy clone — only allocate if we actually change something
  const claimed = new Set();
  for (const [key, pick] of Object.entries(config)) {
    if (!pick?.name) continue;
    if (!claimed.has(pick.name)) {
      claimed.add(pick.name);
      continue;
    }
    const slot = EXERCISE_POOLS[key];
    if (!slot) { claimed.add(pick.name); continue; }
    const { pool, loadProfile } = slot;
    const onProfile = loadProfile ? pool.filter(ex => ex.loadProfile === loadProfile) : pool;
    const recent = recentNamesFor(history[key]);
    let candidates = onProfile.filter(ex => !recent.includes(ex.name) && !claimed.has(ex.name));
    if (candidates.length === 0) candidates = onProfile.filter(ex => !claimed.has(ex.name));
    if (candidates.length === 0) candidates = pool.filter(ex => !claimed.has(ex.name));
    if (candidates.length === 0) { claimed.add(pick.name); continue; }
    const scores = candidates.map(ex => scoreExerciseForFocus(ex, focus));
    const replacement = weightedPick(candidates, scores);
    if (!mutated) mutated = { ...config };
    mutated[key] = replacement;
    claimed.add(replacement.name);
  }
  return mutated || config;
}

// Strip config entries whose exercise name is no longer in the slot's live
// pool. Pairs with the applyRotationToSession self-heal — that helper falls
// back to the SESSIONS default at READ time, but the in-session resolver
// (ForgeApp.jsx#resolveExFn) reads programmeBlock.config directly. So a
// stale entry like the old "DB Kickback" pick keeps showing up in the live
// session screen even though the home preview self-heals.
//
// This is the PERSISTENT layer: walks config once at load time and deletes
// any entry whose name isn't in EXERCISE_POOLS[key].pool, so every consumer
// downstream sees the same clean state.
//
// Returns the input reference when nothing's stale — identity-comparable
// for cheap "skip persistence" guards. Never mutates input.
export function pruneStaleRotationConfig(config = {}) {
  if (!config || Object.keys(config).length === 0) return config;
  let mutated = null;
  for (const [key, pick] of Object.entries(config)) {
    if (!pick?.name) continue;
    const slot = EXERCISE_POOLS[key];
    if (!slot) continue;          // unknown slot — leave alone, applyRotation skips it too
    if (slot.pool.some(ex => ex.name === pick.name)) continue;  // still in pool
    if (!mutated) mutated = { ...config };
    delete mutated[key];          // stale — drop so SESSIONS default takes over
  }
  return mutated || config;
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

// ─── Focus programming: per-focus volume + rep-range adjustments ─────────────
// PR-D of the focus-picker series. The bias scoring (PR-B) changes WHICH
// alternatives rotation favours. This layer changes the programming itself:
//   - Strong drops one accessory superset per strength day and shifts the
//     remaining accessories to a 6–8 rep range. Mains untouched. Net effect:
//     ~30% less accessory volume, all heavier. Recovery prioritised for the
//     main lifts.
//   - Sculpt bumps any accessory slot that's aligned with the visible-muscle
//     vector (score > ALIGNED_SCORE_THRESHOLD under Sculpt) by +1 set, and
//     shifts those slots' rep range to 12–15. Non-aligned slots unchanged.
//     Net effect: more felt-effort + more productive-hypertrophy volume where
//     it counts. Other muscles maintain baseline (still comprehensive).
//   - Forged is identity — bit-identical to the static SESSIONS template.
//
// "Drop a superset" per day (Strong): SESSIONS[0]/ass2, SESSIONS[1]/bss2,
// SESSIONS[2]/css3. These are each day's lower-value accessory superset for
// a strength outcome — ass2 (Hip Thrust + Landmine Press) is pure isolation
// for the squat day; bss2 (Bulgarian + Ham Curl) is quad-dominant accessory
// work on a hinge day; css3 (DB Curl + Skullcrusher) is pure-arm isolation
// for the power day. All three drops preserve the main lifts + at least one
// accessory superset + the finisher.
//
// HAMSTRING RESCUE (audit #59, boss call 2026-07-24): bss2 held the
// programme's ONLY direct knee-flexion work, so dropping it wholesale left
// Strong with zero hamstring curls forever (the old rationale — "duplicates
// ass2's hip work" — was wrong twice over: ass2 is also dropped, and a leg
// curl is knee flexion, not hip work). Under Strong, the kept superset's
// Leg Press slot becomes the Ham Curl instead: the pull-up survives (losing
// the only vertical pull was ruled unacceptable), knee flexion survives,
// and the two movements actually lost — Leg Press + Bulgarian — are both
// quad accessories on a day whose main lift is a hinge.

export const STRONG_DROP_BLOCK_IDS = new Set(["ass2", "bss2", "css3"]);

// The rescue: applied to bss1.exA under Strong BEFORE the 6–8 rep shift,
// so it gets the same heavier-load treatment as every surviving accessory.
export const STRONG_SLOT_SUBSTITUTIONS = {
  "bss1-A": { name:"Machine Hamstring Curl", reps:12, weight:35, muscle:"Hamstrings", vid:"Lh3iMIcbkBQ", loadType:"machine", loadProfile:"moderate_mid_rep" },
};
const STRONG_ACCESSORY_REPS = "6-8";
const SCULPT_ACCESSORY_REPS = "12-15";

// Strong shifts surviving accessories to 6–8 reps AND raises their load to
// match. Without the bump a light-isolation slot became "6–8 reps @ 7 kg"
// (junk — a lateral raise at ~40% effort), and the spec's promise of "heavier
// accessories" was unmet. We hold estimated 1RM roughly constant across the
// rep drop (Epley basis — the same model the analytics layer uses), so fewer
// reps ⇒ heavier for equal relative effort. Seed weights are a starting point:
// the progression engine and the user tune from here, so we don't treat the
// first number as gospel — this just stops the first prescription being wrong.
const STRONG_TARGET_REPS = 7; // midpoint of the 6–8 band

function _leadingReps(reps) {
  if (typeof reps === "number") return reps;
  const m = String(reps ?? "").match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function bumpWeightForStrong(weight, reps) {
  if (typeof weight !== "number" || weight <= 0) return weight; // bodyweight / unset — leave
  const r = _leadingReps(reps);
  if (!r || r <= STRONG_TARGET_REPS) return weight;             // already at/below target
  const factor = (1 + r / 30) / (1 + STRONG_TARGET_REPS / 30);  // Epley-constant e1RM
  return Math.round((weight * factor) / 1.25) * 1.25;           // nearest 1.25 kg
}

// "Aligned with Sculpt" = primary-muscle membership in the visible-muscle set,
// NOT a dot-product score. Reason: a dot-product check incidentally catches
// compounds where the primary contribution is a non-visible muscle but a
// visible muscle is a secondary (e.g. Reverse Lunge — Quads primary, Glutes
// secondary). Bumping such a slot adds more to the primary muscle than the
// visible one, which contradicts Sculpt's spec. Primary-only keeps the bump
// honest: more sets only land on slots whose dominant contribution per set
// is a visible muscle.
//
// Rear Delts + Back are deliberately NOT in this set. Sculpt is the "front-
// of-mirror visible" focus; full-body bodybuilding bias is out of scope.
// They still get baseline volume — they just don't get the +set bump.
export const SCULPT_ALIGNED_PRIMARIES = new Set([
  "Chest", "Front Delts", "Side Delts", "Biceps", "Triceps", "Glutes",
]);

// Pure helper: given the user's per-block rotation config (which determines
// the currently-active exercise per slot), which accessory slot keys are
// "aligned" under the focus's bias? Returns a Set of slot keys.
function alignedSlotKeysForFocus(config = {}, focus = DEFAULT_FOCUS) {
  const aligned = new Set();
  if (focus !== "Sculpt") return aligned; // only Sculpt uses the alignment logic today
  for (const [key, ex] of Object.entries(config)) {
    if (!ex?.name) continue;
    const anatomy = getAnatomy(ex.name);
    if (anatomy && SCULPT_ALIGNED_PRIMARIES.has(anatomy.primary)) aligned.add(key);
  }
  return aligned;
}

// Apply focus-programming rules to a session template. Pure — returns a new
// session object; never mutates input. `config` is the user's active rotation
// config (programmeBlock.config), used by Sculpt to know which slots' currently
// -active exercises are aligned with the bias vector. Forged returns the input
// session unchanged (deep-equal but identical references on blocks).
//
// @param {object} session  one SESSIONS entry { name, subtitle, type, blocks }
// @param {string} focus    Forged | Strong | Sculpt (any other = identity)
// @param {object} [config] programmeBlock.config (per-slot active exercise)
// @returns {object}        adjusted session (same shape) — possibly with fewer
//                          blocks (Strong) and/or different sets/reps on blocks
// Substitute each accessory slot's currently-active exercise (from the user's
// rotation config) into a session template. Without this step, the home
// session preview + the SessionOverviewSheet read straight from SESSIONS and
// show the template defaults even though rotation has happened — which made
// rotations look like they hadn't applied (user rotated Skullcrusher → Bench
// Dips, force-closed before continuing to readiness, came back to "Block 2"
// still showing Skullcrusher because the preview was reading the template).
//
// resolveExFn in ForgeApp already does this substitution per-block at render
// time during the live session. This helper does it ONCE at the data-shape
// level so the rest of the UI (preview cards, overview sheet, DoneScreen
// summaries) sees the same exercises the session screen will. Idempotent —
// calling it twice with the same config is a no-op.
//
// Pure: returns a new session object; never mutates input. Empty config =
// identity (same reference, useful for unit testing and the no-rotation case).
//
// Self-healing: if a config entry references an exercise name that no longer
// exists in its slot's pool (e.g. we culled DB Kickback from css3-B after
// users had already rolled into it), the stale entry is silently ignored
// and the slot falls back to the SESSIONS default. Prevents ghost picks
// from surviving pool deletions; users don't need to manually reset.
//
// @param {object} session  one SESSIONS entry { name, subtitle, type, blocks }
// @param {object} [config] programmeBlock.config (per-slot active exercise)
// @returns {object}        session with exercise instances swapped to match config
export function applyRotationToSession(session, config = {}) {
  if (!session?.blocks) return session;
  if (!config || Object.keys(config).length === 0) return session;
  // Validate a config entry against its slot pool — returns the entry if the
  // name is still in the live pool, null if it's been culled (so we fall
  // back to the SESSIONS default). Slot keys without a matching pool entry
  // (e.g. main lifts, which don't live in EXERCISE_POOLS) are passed through
  // unchanged — only accessory slots get validated.
  const validForSlot = (slotKey, c) => {
    if (!c?.name) return null;
    const slot = EXERCISE_POOLS[slotKey];
    if (!slot) return c;
    return slot.pool.some(ex => ex.name === c.name) ? c : null;
  };
  const blocks = session.blocks.map((b) => {
    // Main blocks key on b.id alone (no -A/-B suffix). Currently main lifts
    // never rotate (no main slot keys exist in config), but the helper is
    // future-proof — when main-lift rotation lands it'll Just Work.
    let next = b;
    if (b.ex) {
      const c = validForSlot(b.id, config[b.id]);
      if (c) next = { ...next, ex: { ...b.ex, ...c } };
    }
    if (b.exA) {
      const c = validForSlot(`${b.id}-A`, config[`${b.id}-A`]);
      if (c) next = { ...next, exA: { ...b.exA, ...c } };
    }
    if (b.exB) {
      const c = validForSlot(`${b.id}-B`, config[`${b.id}-B`]);
      if (c) next = { ...next, exB: { ...b.exB, ...c } };
    }
    return next;
  });
  return { ...session, blocks };
}

// Apply user-initiated in-session swaps to a session. Mirrors the same
// keying as applyRotationToSession (block.id for main, block.id-A/-B for
// supersets) but skips pool validation — a swap is the user's explicit
// choice, anything is valid (including exercises from SWAP_DB that aren't
// in EXERCISE_POOLS).
//
// This is the final transformation in the rotation → swap → focus → readiness
// chain that produces `activeSession`. SessionScreen reads exercises straight
// off `activeSession.blocks[i]` instead of re-resolving from raw config — kills
// the historical split-brain where the overview saw the resolved exercise but
// the live session screen saw a stale config entry.
//
// Pure: returns a new session object; never mutates input. Empty swaps =
// identity (same reference).
// Merge one swap over the slot's exercise. Legacy heal (audit #58): swaps
// stored before 2026-07-24 carry no loadType — spreading them let the
// swapped-in exercise inherit the ORIGINAL's loadType (Nordic Curl logged
// as "machine") and its weight prefill (a 35kg machine number on a
// bodyweight movement). When the swap record lacks a loadType we strip the
// inherited one — getLoadType falls back to name inference at render/log —
// and drop the inherited prefill so the seeding path re-derives it.
function mergeSwap(ex, s) {
  const merged = { ...ex, ...s };
  if (!s.loadType) {
    delete merged.loadType;
    merged.weight = null;
  }
  return merged;
}

export function applySwapsToSession(session, swaps = {}) {
  if (!session?.blocks) return session;
  if (!swaps || Object.keys(swaps).length === 0) return session;
  const blocks = session.blocks.map((b) => {
    let next = b;
    if (b.ex) {
      const s = swaps[b.id];
      if (s?.name) next = { ...next, ex: mergeSwap(b.ex, s) };
    }
    if (b.exA) {
      const s = swaps[`${b.id}-A`];
      if (s?.name) next = { ...next, exA: mergeSwap(b.exA, s) };
    }
    if (b.exB) {
      const s = swaps[`${b.id}-B`];
      if (s?.name) next = { ...next, exB: mergeSwap(b.exB, s) };
    }
    return next;
  });
  return { ...session, blocks };
}

export function applyFocusToSession(session, focus = DEFAULT_FOCUS, config = {}) {
  if (!session?.blocks) return session;
  if (focus === "Forged" || !focus) return session;

  if (focus === "Strong") {
    const blocks = session.blocks
      .filter(b => !STRONG_DROP_BLOCK_IDS.has(b.id))
      .map(b => {
        if (b.type === "main" || b.type === "finisher") return b;
        // superset (or any non-main, non-finisher accessory): shift reps to 6–8.
        // Sets count unchanged for the surviving supersets.
        const next = { ...b };
        // Hamstring rescue (audit #59) — see STRONG_SLOT_SUBSTITUTIONS.
        // Deliberately overrides rotation/swap picks for the slot: Strong
        // is an opinionated overlay, and this slot IS the hamstring slot
        // under it. Runs before the rep shift so it gets the 6–8 + load
        // treatment like everything else.
        const subA = STRONG_SLOT_SUBSTITUTIONS[`${b.id}-A`];
        if (subA && next.exA) next.exA = { ...subA };
        const subB = STRONG_SLOT_SUBSTITUTIONS[`${b.id}-B`];
        if (subB && next.exB) next.exB = { ...subB };
        // Read the ORIGINAL reps to size the bump, then set the 6–8 target.
        if (next.exA) next.exA = { ...next.exA, weight: bumpWeightForStrong(next.exA.weight, next.exA.reps), reps: STRONG_ACCESSORY_REPS };
        if (next.exB) next.exB = { ...next.exB, weight: bumpWeightForStrong(next.exB.weight, next.exB.reps), reps: STRONG_ACCESSORY_REPS };
        if (next.ex)  next.ex  = { ...next.ex,  weight: bumpWeightForStrong(next.ex.weight,  next.ex.reps),  reps: STRONG_ACCESSORY_REPS };
        return next;
      });
    return { ...session, blocks };
  }

  if (focus === "Sculpt") {
    const aligned = alignedSlotKeysForFocus(config, focus);
    const blocks = session.blocks.map(b => {
      if (b.type === "main" || b.type === "finisher") return b;
      // For superset blocks: check if either side is in an aligned slot. The
      // slot key is `${b.id}-A` for exA, `${b.id}-B` for exB.
      const aIsAligned = aligned.has(`${b.id}-A`);
      const bIsAligned = aligned.has(`${b.id}-B`);
      if (!aIsAligned && !bIsAligned) return b;
      const next = { ...b, sets: b.sets + 1 }; // +1 set on the whole superset
      if (aIsAligned && next.exA) next.exA = { ...next.exA, reps: SCULPT_ACCESSORY_REPS };
      if (bIsAligned && next.exB) next.exB = { ...next.exB, reps: SCULPT_ACCESSORY_REPS };
      return next;
    });
    return { ...session, blocks };
  }

  return session;
}

// Convenience: apply focus to every session in a programme. Used by the
// volume audit so weekly totals reflect what the user actually does, not
// the static template.
export function applyFocusToSessions(sessions = SESSIONS, focus = DEFAULT_FOCUS, config = {}) {
  return sessions.map(s => applyFocusToSession(s, focus, config));
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
// ORDER IS DELIBERATE: consecutive dates walk this list in order (see
// bonusForDay), so adjacent entries land on adjacent days. Neighbours are
// interleaved by modality — no two carries, ergs, burpee-family, or
// leg-dominant movements touch (cyclically) — so yesterday's bonus never
// feels like today's. Keep the length PRIME (currently 17): a weekly
// cardio slot strides the cycle by 7, and a prime length guarantees it
// visits the whole pool before any repeat.
export const CARDIO_BONUS_POOL = [
  { name: "Sled Push",          detail: "4 lengths, heavy. Rest as needed between." },
  { name: "Row Sprint",         detail: "5 × 150m. All out, full recovery." },
  { name: "Wall Balls",         detail: "3 × 15. Full squat, hit the target." },
  { name: "Burpee Ladder",      detail: "1-2-3…up to 5, then back down." },
  { name: "Farmer's Carry",     detail: "4 × 30m. Heavy, grip-limited." },
  { name: "Box Jumps",          detail: "3 × 10. Explode up, step down soft." },
  { name: "Battle Ropes",       detail: "5 × 30s on / 30s off. Whole body, not wrists." },
  { name: "Pistol Squats",      detail: "3 × 5/leg. Controlled, full depth — scale to a box." },
  { name: "Assault Bike",       detail: "5 × 20s sprint / 40s easy." },
  { name: "Med Ball Slams",     detail: "3 × 15. Full reach, slam through the floor." },
  { name: "Sandbag Carry",      detail: "4 × 20m. Bear hug, brace, walk tall." },
  { name: "Burpee Broad Jumps", detail: "3 × 8. Jump far, stick the landing." },
  { name: "Kettlebell Swings",  detail: "3 × 20. Explosive hips, not arms." },
  { name: "Shuttle Runs",       detail: "6 × 20m. Touch the line, turn hard." },
  { name: "Walking Lunges",     detail: "4 × 20m. Sandbag or DBs, chest tall." },
  { name: "Ski Erg Sprint",     detail: "5 × 200m. Hard pulls, full recovery." },
  { name: "Devil's Press",      detail: "3 × 8. Burpee into a double-DB snatch." },
];

// Day types that may receive a bonus. Single source of truth for the guardrail.
export const BONUS_ELIGIBLE_DAY_TYPES = new Set(["cardio", "hiit"]);

// Deterministically pick a bonus for a given date + day type. Stable within a
// day (same pick all day), varies day to day. Returns null for ineligible day
// types so callers can guard with a simple truthiness check.
//
// Picker is a days-since-epoch CYCLE, not a hash: consecutive dates walk the
// pool in order, so a repeat requires a full lap (pool-length calendar days).
// The string hash this replaced was already mostly-sequential but stuttered
// at month boundaries — the same pair of bonuses could land on four
// consecutive days across a rollover (probed 2026-07-15). Freshness comes
// from the lap length; day-to-day contrast comes from the pool's interleaved
// ordering above.
export function bonusForDay(dateStr, dayType) {
  if (!BONUS_ELIGIBLE_DAY_TYPES.has(dayType)) return null;
  if (typeof dateStr !== "string") return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const days = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  const len = CARDIO_BONUS_POOL.length;
  return CARDIO_BONUS_POOL[((days % len) + len) % len];
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
                                { name:"TRX Row",                   eq:"Equipment",muscle:"Upper back",          vid:"fW_jdwZT804" }],
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
                                { name:"TRX Row",                   eq:"Equipment",muscle:"Lats",                vid:"fW_jdwZT804" }],
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
                                { name:"TRX Row",                   eq:"Equipment",muscle:"Mid back",            vid:"fW_jdwZT804" },
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

  // ───────────────────────────────────────────────────────────────────────────
  // Accessory swap coverage. Closes the long-standing gap where the bulk of
  // accessory-pool exercises had no SWAP_DB entry, leaving the in-session
  // swap overlay empty for most slots. Main-lift swaps above are untouched —
  // those are curated against the heavy_low_rep invariant in
  // MAIN_LIFT_FUNCTIONAL_EQUIVALENTS (and locked in by the alignment tests in
  // tests/programme.test.js). Equipment values use the existing vocabulary
  // (Barbell / Dumbbell / Cable / Machine / Bodyweight / Band / Equipment).
  // ───────────────────────────────────────────────────────────────────────────
  "45-Degree Hip Extension": [{ name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Posterior chain"           , vid:"wPM8icPu6H8" },
                               { name:"Romanian Deadlift"               , eq:"Barbell"    , muscle:"Posterior chain"           , vid:"hCDzSR6bW10" }],
  "Assisted Pull-Up": [{ name:"Lat Pulldown"                    , eq:"Cable"    , muscle:"Lats"                      , vid:"hnSqbBk15tw" },
                        { name:"Pull-Up"                         , eq:"Bodyweight" , muscle:"Lats"                      , vid:"Hdc7Mw6BIEE" }],
  "B-Stance Hip Thrust": [{ name:"Single-Leg Hip Thrust"           , eq:"Bodyweight" , muscle:"Glutes"                    , vid:"4ilXaDauMnE" },
                           { name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Glutes"                    , vid:"wPM8icPu6H8" }],
  "Band Face Pull": [{ name:"Resistance Band Face Pull"       , eq:"Band"       , muscle:"Rear delts"                , vid:null },
                      { name:"Rear Delt Fly"                   , eq:"Dumbbell"   , muscle:"Rear delts"                , vid:"KoRDmXocJII" }],
  "Band Lateral Raise": [{ name:"Resistance Band Lateral"         , eq:"Band"       , muscle:"Lateral delt"              , vid:null },
                          { name:"Lateral Raise"                   , eq:"Dumbbell"   , muscle:"Lateral delt"              , vid:"v_ZkxWzYnMc" }],
  "Band Pull-Apart": [{ name:"Resistance Band Face Pull"       , eq:"Band"       , muscle:"Rear delts"                , vid:null },
                       { name:"Rear Delt Fly"                   , eq:"Dumbbell"   , muscle:"Rear delts"                , vid:"KoRDmXocJII" }],
  "Banded Hip Thrust": [{ name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Glutes"                    , vid:"wPM8icPu6H8" },
                         { name:"Barbell Hip Thrust"              , eq:"Barbell"    , muscle:"Glutes"                    , vid:"xDmFkJxPzeM" }],
  "Barbell Front Rack Lunge": [{ name:"DB Reverse Lunge"                , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"RZKXLMxPF_I" },
                                { name:"Step-Up"                         , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null }],
  "Barbell Glute Bridge": [{ name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Glutes"                    , vid:"wPM8icPu6H8" },
                            { name:"Barbell Hip Thrust"              , eq:"Barbell"    , muscle:"Glutes"                    , vid:"xDmFkJxPzeM" }],
  "Barbell Step-Up": [{ name:"Step-Up"                         , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null },
                       { name:"DB Step-Up"                      , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"aKj-6hgiViA" }],
  "Barbell Walking Lunge": [{ name:"DB Walking Lunge"                , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"xvC10-eCuXs" },
                             { name:"Reverse Lunge"                   , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null }],
  "Belt Squat": [{ name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"9W5KAqHfDe8" },
                  { name:"Leg Press"                       , eq:"Machine"    , muscle:"Quads & Glutes"            , vid:"nDh_BlnLCGc" }],
  "Bench Dips": [{ name:"Tricep Pushdown"                 , eq:"Cable"      , muscle:"Triceps"                   , vid:"mRmIthbCSNI" },
                  { name:"Close-Grip Push-Up"              , eq:"Bodyweight" , muscle:"Triceps"                   , vid:"F1Lq9LnyvVc" }],
  "Cable Crossover": [{ name:"DB Chest Fly"                    , eq:"Dumbbell"   , muscle:"Chest / medial"            , vid:"eozdVDA78K0" },
                       { name:"Pec Deck"                        , eq:"Machine"    , muscle:"Chest / medial"            , vid:"g3T7LsEeDWQ" }],
  "Cable Overhead Extension": [{ name:"DB Overhead Extension"           , eq:"Dumbbell"   , muscle:"Triceps"                   , vid:"fYqswDVbJDg" },
                                { name:"Skullcrusher"                    , eq:"Barbell"    , muscle:"Triceps"                   , vid:"OQ4TWXkZjTc" }],
  "Cable Rear Delt Fly": [{ name:"Rear Delt Fly"                   , eq:"Dumbbell"   , muscle:"Rear delts"                , vid:"KoRDmXocJII" },
                           { name:"Resistance Band Face Pull"       , eq:"Band"       , muscle:"Rear delts"                , vid:null }],
  "Cable Straight-Arm Pulldown": [{ name:"Lat Pulldown"                    , eq:"Cable"    , muscle:"Lats"                      , vid:"hnSqbBk15tw" },
                                   { name:"Resistance Band Pull-Down"       , eq:"Band"       , muscle:"Lats"                      , vid:null }],
  "Captain's Chair Raise": [{ name:"Hanging Knee Raise"              , eq:"Bodyweight" , muscle:"Core"                      , vid:"RD_A-Z15ER4" },
                             { name:"Lying Leg Raise"                 , eq:"Bodyweight" , muscle:"Core"                      , vid:null }],
  "Chin-Up": [{ name:"Pull-Up"                         , eq:"Bodyweight" , muscle:"Lats"                      , vid:"Hdc7Mw6BIEE" },
               { name:"Lat Pulldown"                    , eq:"Cable"    , muscle:"Lats"                      , vid:"hnSqbBk15tw" }],
  "Close-Grip Push-Up": [{ name:"Diamond Push-Up"                 , eq:"Bodyweight" , muscle:"Triceps"                   , vid:"kGhDnFwMY3E" },
                          { name:"Bench Dips"                      , eq:"Bodyweight" , muscle:"Triceps"                   , vid:"JBCdL6vOoOY" }],
  "Concentration Curl": [{ name:"DB Curl"                         , eq:"Dumbbell"   , muscle:"Biceps"                    , vid:"XE_pHwbst04" },
                          { name:"Hammer Curl"                     , eq:"Dumbbell"   , muscle:"Biceps"                    , vid:"BRVDS6HVR9Q" }],
  "Curtsy Lunge": [{ name:"DB Reverse Lunge"                , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"RZKXLMxPF_I" },
                    { name:"Reverse Lunge"                   , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null }],
  "DB Chest Fly": [{ name:"Cable Crossover"                 , eq:"Cable"      , muscle:"Chest / medial"            , vid:"taI4XduLpTk" },
                    { name:"Pec Deck"                        , eq:"Machine"    , muscle:"Chest / medial"            , vid:"g3T7LsEeDWQ" }],
  "DB Floor Press": [{ name:"Dumbbell Bench Press"            , eq:"Dumbbell"   , muscle:"Chest"                     , vid:null },
                      { name:"Close-Grip Push-Up"              , eq:"Bodyweight" , muscle:"Chest"                     , vid:"F1Lq9LnyvVc" }],
  "DB Front Squat": [{ name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"9W5KAqHfDe8" },
                      { name:"Barbell Back Squat"              , eq:"Barbell"    , muscle:"Quads & Glutes"            , vid:"bEv6CCg2BC8" }],
  "DB Lateral Lunge": [{ name:"DB Reverse Lunge"                , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"RZKXLMxPF_I" },
                        { name:"Reverse Lunge"                   , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null }],
  "DB Lu Raise": [{ name:"Lateral Raise"                   , eq:"Dumbbell"   , muscle:"Lateral delt"              , vid:"v_ZkxWzYnMc" },
                   { name:"Resistance Band Lateral"         , eq:"Band"       , muscle:"Lateral delt"              , vid:null }],
  "DB Overhead Extension": [{ name:"Cable Overhead Extension"        , eq:"Cable"      , muscle:"Triceps"                   , vid:"GzmlxvSFE7A" },
                             { name:"Skullcrusher"                    , eq:"Barbell"    , muscle:"Triceps"                   , vid:"OQ4TWXkZjTc" }],
  "DB Reverse Lunge": [{ name:"Reverse Lunge"                   , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null },
                        { name:"Split Squat"                     , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null }],
  "DB Split Squat": [{ name:"Split Squat"                     , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null },
                      { name:"DB Reverse Lunge"                , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"RZKXLMxPF_I" }],
  "DB Step-Up": [{ name:"Step-Up"                         , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null },
                  { name:"DB Reverse Lunge"                , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"RZKXLMxPF_I" }],
  "DB Sumo Squat": [{ name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"9W5KAqHfDe8" },
                     { name:"Barbell Back Squat"              , eq:"Barbell"    , muscle:"Quads & Glutes"            , vid:"bEv6CCg2BC8" }],
  "Decline Push-Up": [{ name:"Incline DB Press"                , eq:"Dumbbell"   , muscle:"Upper chest"               , vid:"ou6s32mJgjU" },
                       { name:"Pike Push-Up"                    , eq:"Bodyweight" , muscle:"Upper chest"               , vid:null }],
  "Deficit Reverse Lunge": [{ name:"DB Reverse Lunge"                , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"RZKXLMxPF_I" },
                             { name:"Reverse Lunge"                   , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null }],
  "Diamond Push-Up": [{ name:"Close-Grip Push-Up"              , eq:"Bodyweight" , muscle:"Triceps"                   , vid:"F1Lq9LnyvVc" },
                       { name:"Bench Dips"                      , eq:"Bodyweight" , muscle:"Triceps"                   , vid:"JBCdL6vOoOY" }],
  "Donkey Calf Raise": [{ name:"Leg Press Calf Raise"            , eq:"Machine"    , muscle:"Calves"                    , vid:"PYZY00hI43w" },
                         { name:"Standing Calf Raise"             , eq:"Machine"    , muscle:"Calves"                    , vid:"baEXLy09Ncc" }],
  "Dumbbell Bent-Over Row": [{ name:"Chest-Supported DB Row"          , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"vmX58YYK3-8" },
                              { name:"TRX Row"                         , eq:"Equipment"  , muscle:"Upper back"                , vid:"fW_jdwZT804" }],
  "EZ Bar Curl": [{ name:"DB Curl"                         , eq:"Dumbbell"   , muscle:"Biceps"                    , vid:"XE_pHwbst04" },
                   { name:"Hammer Curl"                     , eq:"Dumbbell"   , muscle:"Biceps"                    , vid:"BRVDS6HVR9Q" }],
  "Face-Away Cable Row": [{ name:"Seated Cable Row"                , eq:"Cable"      , muscle:"Mid back"                  , vid:"7BkgqzC6WsM" },
                           { name:"Dumbbell Bent-Over Row"          , eq:"Dumbbell"   , muscle:"Mid back"                  , vid:"6TSP1TRMUzs" }],
  "Frog Pump": [{ name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Glutes"                    , vid:"wPM8icPu6H8" },
                 { name:"Banded Hip Thrust"               , eq:"Band"       , muscle:"Glutes"                    , vid:"1hZv0N2szAE" }],
  "Goblet Squat": [{ name:"DB Front Squat"                  , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"B86Zj72LwzA" },
                    { name:"Wall Sit"                        , eq:"Bodyweight" , muscle:"Quads & Glutes"            , vid:null }],
  "Hack Squat": [{ name:"Leg Press"                       , eq:"Machine"    , muscle:"Quadriceps"                , vid:"nDh_BlnLCGc" },
                  { name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quadriceps"                , vid:"9W5KAqHfDe8" }],
  "Half-Kneeling Cable Row": [{ name:"Seated Cable Row"                , eq:"Cable"      , muscle:"Mid back"                  , vid:"7BkgqzC6WsM" },
                               { name:"Resistance Band Row"             , eq:"Band"       , muscle:"Mid back"                  , vid:null }],
  "Hammer Curl": [{ name:"DB Curl"                         , eq:"Dumbbell"   , muscle:"Biceps & brachialis"       , vid:"XE_pHwbst04" },
                   { name:"Zottman Curl"                    , eq:"Dumbbell"   , muscle:"Biceps & brachialis"       , vid:"ZrpRBgswtHs" }],
  "Hanging Knee Raise": [{ name:"Lying Leg Raise"                 , eq:"Bodyweight" , muscle:"Core"                      , vid:null },
                          { name:"Reverse Crunch"                  , eq:"Bodyweight" , muscle:"Core"                      , vid:null }],
  "Incline DB Curl": [{ name:"DB Curl"                         , eq:"Dumbbell"   , muscle:"Biceps"                    , vid:"XE_pHwbst04" },
                       { name:"EZ Bar Curl"                     , eq:"Barbell"    , muscle:"Biceps"                    , vid:"5NsFLGUf0Fo" }],
  "Incline DB Row": [{ name:"Chest-Supported DB Row"          , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"vmX58YYK3-8" },
                      { name:"Dumbbell Bent-Over Row"          , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"6TSP1TRMUzs" }],
  "Incline Landmine Press": [{ name:"Landmine Press"                  , eq:"Barbell"    , muscle:"Upper chest"               , vid:"gH7PDepHNck" },
                              { name:"Incline DB Press"                , eq:"Dumbbell"   , muscle:"Upper chest"               , vid:"ou6s32mJgjU" }],
  "Kneeling Landmine Press": [{ name:"Landmine Press"                  , eq:"Barbell"    , muscle:"Upper chest"               , vid:"gH7PDepHNck" },
                               { name:"Dumbbell Shoulder Press"         , eq:"Dumbbell"   , muscle:"Upper chest"               , vid:null }],
  "L-Sit Hold": [{ name:"Plank"                           , eq:"Bodyweight" , muscle:"Core"                      , vid:null },
                  { name:"Hanging Knee Raise"              , eq:"Bodyweight" , muscle:"Core"                      , vid:"RD_A-Z15ER4" }],
  "Landmine Squeeze Press": [{ name:"DB Chest Fly"                    , eq:"Dumbbell"   , muscle:"Upper chest"               , vid:"eozdVDA78K0" },
                              { name:"Cable Crossover"                 , eq:"Cable"      , muscle:"Upper chest"               , vid:"taI4XduLpTk" }],
  "Lat Pulldown": [{ name:"Pull-Up"                         , eq:"Bodyweight" , muscle:"Lats"                      , vid:"Hdc7Mw6BIEE" },
                    { name:"Resistance Band Pull-Down"       , eq:"Band"       , muscle:"Lats"                      , vid:null }],
  "Leaning Lateral Raise": [{ name:"Lateral Raise"                   , eq:"Dumbbell"   , muscle:"Lateral delt"              , vid:"v_ZkxWzYnMc" },
                             { name:"Cable Lateral Raise"             , eq:"Cable"      , muscle:"Lateral delt"              , vid:"gsC3pd6lfKY" }],
  "Leg Extension": [{ name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quadriceps"                , vid:"9W5KAqHfDe8" },
                     { name:"Wall Sit"                        , eq:"Bodyweight" , muscle:"Quadriceps"                , vid:null }],
  "Leg Press Calf Raise": [{ name:"Standing Calf Raise"             , eq:"Machine"    , muscle:"Calves"                    , vid:"baEXLy09Ncc" },
                            { name:"Seated Calf Raise"               , eq:"Machine"    , muscle:"Calves"                    , vid:"6O5hh1rBtx8" }],
  "Low-to-High Cable Fly": [{ name:"Incline DB Press"                , eq:"Dumbbell"   , muscle:"Upper chest"               , vid:"ou6s32mJgjU" },
                             { name:"Incline Push-Up"                 , eq:"Bodyweight" , muscle:"Upper chest"               , vid:null }],
  "Meadows Row": [{ name:"Dumbbell Bent-Over Row"          , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"6TSP1TRMUzs" },
                   { name:"Single-Arm DB Row"               , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"qN54-QNO1eQ" }],
  "Neutral-Grip DB Press": [{ name:"Dumbbell Bench Press"            , eq:"Dumbbell"   , muscle:"Chest"                     , vid:null },
                             { name:"DB Floor Press"                  , eq:"Dumbbell"   , muscle:"Chest"                     , vid:"uUGDRwge4F8" }],
  "Neutral-Grip Pull-Up": [{ name:"Pull-Up"                         , eq:"Bodyweight" , muscle:"Lats"                      , vid:"Hdc7Mw6BIEE" },
                            { name:"Chin-Up"                         , eq:"Bodyweight" , muscle:"Lats"                      , vid:"e1YSApl-QcM" }],
  "Nordic Curl": [{ name:"Dumbbell Leg Curl"               , eq:"Dumbbell"   , muscle:"Hamstrings"                , vid:null },
                   { name:"Swiss Ball Leg Curl"             , eq:"Equipment" , muscle:"Hamstrings"                , vid:"WNB90xXLEOg" }],
  "Overhead Tricep Extension": [{ name:"DB Overhead Extension"           , eq:"Dumbbell"   , muscle:"Triceps"                   , vid:"fYqswDVbJDg" },
                                 { name:"Tricep Pushdown"                 , eq:"Cable"      , muscle:"Triceps"                   , vid:"mRmIthbCSNI" }],
  "Pec Deck": [{ name:"Cable Crossover"                 , eq:"Cable"      , muscle:"Chest / medial"            , vid:"taI4XduLpTk" },
                { name:"DB Chest Fly"                    , eq:"Dumbbell"   , muscle:"Chest / medial"            , vid:"eozdVDA78K0" }],
  "Pendulum Squat": [{ name:"Hack Squat"                      , eq:"Machine"    , muscle:"Quadriceps"                , vid:"hrciyIRwFzs" },
                      { name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quadriceps"                , vid:"9W5KAqHfDe8" }],
  "Preacher Curl": [{ name:"DB Curl"                         , eq:"Dumbbell"   , muscle:"Biceps"                    , vid:"XE_pHwbst04" },
                     { name:"Concentration Curl"              , eq:"Dumbbell"   , muscle:"Biceps"                    , vid:"oPGBZHIxusU" }],
  "Prone Y Raise": [{ name:"Rear Delt Fly"                   , eq:"Dumbbell"   , muscle:"Rear delts"                , vid:"KoRDmXocJII" },
                     { name:"Resistance Band Face Pull"       , eq:"Band"       , muscle:"Rear delts"                , vid:null }],
  "Rear Delt Fly": [{ name:"Resistance Band Face Pull"       , eq:"Band"       , muscle:"Rear delts"                , vid:null },
                     { name:"Cable Rear Delt Fly"             , eq:"Cable"      , muscle:"Rear delts"                , vid:"ywMSCem375A" }],
  "Reverse Hyperextension": [{ name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Glutes"                    , vid:"wPM8icPu6H8" },
                              { name:"Romanian Deadlift"               , eq:"Barbell"    , muscle:"Posterior chain"           , vid:"hCDzSR6bW10" }],
  "Reverse-Grip Pushdown": [{ name:"Tricep Pushdown"                 , eq:"Cable"      , muscle:"Triceps"                   , vid:"mRmIthbCSNI" },
                             { name:"Rope Tricep Pushdown"            , eq:"Cable"      , muscle:"Triceps"                   , vid:"n2FSCB4vRSA" }],
  "Rope Tricep Pushdown": [{ name:"Tricep Pushdown"                 , eq:"Cable"      , muscle:"Triceps"                   , vid:"mRmIthbCSNI" },
                            { name:"Single-Arm Pushdown"             , eq:"Cable"      , muscle:"Triceps"                   , vid:"VAHZcPAUwdQ" }],
  "Seal Row": [{ name:"Dumbbell Bent-Over Row"          , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"6TSP1TRMUzs" },
                { name:"TRX Row"                         , eq:"Equipment"  , muscle:"Upper back"                , vid:"fW_jdwZT804" }],
  "Seated Calf Raise": [{ name:"Standing Calf Raise"             , eq:"Machine"    , muscle:"Calves"                    , vid:"baEXLy09Ncc" },
                         { name:"Single-Leg Calf Raise"           , eq:"Bodyweight" , muscle:"Calves"                    , vid:"ORT4oJ_R8Qs" }],
  "Seated Lateral Raise": [{ name:"Lateral Raise"                   , eq:"Dumbbell"   , muscle:"Lateral delt"              , vid:"v_ZkxWzYnMc" },
                            { name:"Cable Lateral Raise"             , eq:"Cable"      , muscle:"Lateral delt"              , vid:"gsC3pd6lfKY" }],
  "Seated Leg Curl": [{ name:"Machine Hamstring Curl"          , eq:"Machine"    , muscle:"Hamstrings"                , vid:"Lh3iMIcbkBQ" },
                       { name:"Dumbbell Leg Curl"               , eq:"Dumbbell"   , muscle:"Hamstrings"                , vid:null }],
  "Single-Arm Cable Fly": [{ name:"DB Chest Fly"                    , eq:"Dumbbell"   , muscle:"Chest / medial"            , vid:"eozdVDA78K0" },
                            { name:"Pec Deck"                        , eq:"Machine"    , muscle:"Chest / medial"            , vid:"g3T7LsEeDWQ" }],
  "Single-Arm Cable Row": [{ name:"Seated Cable Row"                , eq:"Cable"      , muscle:"Mid back"                  , vid:"7BkgqzC6WsM" },
                            { name:"Single-Arm DB Row"               , eq:"Dumbbell"   , muscle:"Mid back"                  , vid:"qN54-QNO1eQ" }],
  "Single-Arm DB Row": [{ name:"Dumbbell Bent-Over Row"          , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"6TSP1TRMUzs" },
                         { name:"TRX Row"                         , eq:"Equipment"  , muscle:"Upper back"                , vid:"fW_jdwZT804" }],
  "Single-Arm Landmine Press": [{ name:"Landmine Press"                  , eq:"Barbell"    , muscle:"Upper chest"               , vid:"gH7PDepHNck" },
                                 { name:"Dumbbell Shoulder Press"         , eq:"Dumbbell"   , muscle:"Upper chest"               , vid:null }],
  "Single-Arm Pushdown": [{ name:"Tricep Pushdown"                 , eq:"Cable"      , muscle:"Triceps"                   , vid:"mRmIthbCSNI" },
                           { name:"Rope Tricep Pushdown"            , eq:"Cable"      , muscle:"Triceps"                   , vid:"n2FSCB4vRSA" }],
  "Single-Leg Calf Raise": [{ name:"Standing Calf Raise"             , eq:"Machine"    , muscle:"Calves"                    , vid:"baEXLy09Ncc" },
                             { name:"Seated Calf Raise"               , eq:"Machine"    , muscle:"Calves"                    , vid:"6O5hh1rBtx8" }],
  "Single-Leg Curl": [{ name:"Dumbbell Leg Curl"               , eq:"Dumbbell"   , muscle:"Hamstrings"                , vid:null },
                       { name:"Slider Leg Curl"                 , eq:"Bodyweight" , muscle:"Hamstrings"                , vid:"lLUniqm00KM" }],
  "Single-Leg Hip Thrust": [{ name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Glutes"                    , vid:"wPM8icPu6H8" },
                             { name:"Barbell Hip Thrust"              , eq:"Barbell"    , muscle:"Glutes"                    , vid:"xDmFkJxPzeM" }],
  "Single-Leg RDL": [{ name:"Romanian Deadlift"               , eq:"Barbell"    , muscle:"Glutes / Hams"             , vid:"hCDzSR6bW10" },
                      { name:"Glute Bridge"                    , eq:"Bodyweight" , muscle:"Glutes / Hams"             , vid:"wPM8icPu6H8" }],
  "Sissy Squat": [{ name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quadriceps"                , vid:"9W5KAqHfDe8" },
                   { name:"Wall Sit"                        , eq:"Bodyweight" , muscle:"Quadriceps"                , vid:null }],
  "Skullcrusher": [{ name:"DB Overhead Extension"           , eq:"Dumbbell"   , muscle:"Triceps"                   , vid:"fYqswDVbJDg" },
                    { name:"Tricep Pushdown"                 , eq:"Cable"      , muscle:"Triceps"                   , vid:"mRmIthbCSNI" }],
  "Slider Leg Curl": [{ name:"Swiss Ball Leg Curl"             , eq:"Equipment" , muscle:"Hamstrings"                , vid:"WNB90xXLEOg" },
                       { name:"Dumbbell Leg Curl"               , eq:"Dumbbell"   , muscle:"Hamstrings"                , vid:null }],
  "Smith Calf Raise": [{ name:"Standing Calf Raise"             , eq:"Machine"    , muscle:"Calves"                    , vid:"baEXLy09Ncc" },
                        { name:"Leg Press Calf Raise"            , eq:"Machine"    , muscle:"Calves"                    , vid:"PYZY00hI43w" }],
  "Svend Press": [{ name:"DB Chest Fly"                    , eq:"Dumbbell"   , muscle:"Chest / medial"            , vid:"eozdVDA78K0" },
                   { name:"Cable Crossover"                 , eq:"Cable"      , muscle:"Chest / medial"            , vid:"taI4XduLpTk" }],
  "Swiss Ball Leg Curl": [{ name:"Slider Leg Curl"                 , eq:"Bodyweight" , muscle:"Hamstrings"                , vid:"lLUniqm00KM" },
                           { name:"Dumbbell Leg Curl"               , eq:"Dumbbell"   , muscle:"Hamstrings"                , vid:null }],
  "Toes-to-Bar": [{ name:"Hanging Leg Raise"               , eq:"Bodyweight" , muscle:"Core"                      , vid:"Pr1ieGZ5atk" },
                   { name:"Lying Leg Raise"                 , eq:"Bodyweight" , muscle:"Core"                      , vid:null }],
  "Tricep Pushdown": [{ name:"Rope Tricep Pushdown"            , eq:"Cable"      , muscle:"Triceps"                   , vid:"n2FSCB4vRSA" },
                       { name:"Close-Grip Push-Up"              , eq:"Bodyweight" , muscle:"Triceps"                   , vid:"F1Lq9LnyvVc" }],
  "TRX Row": [{ name:"Dumbbell Bent-Over Row"          , eq:"Dumbbell"   , muscle:"Upper back"                , vid:"6TSP1TRMUzs" },
               { name:"Resistance Band Row"             , eq:"Band"       , muscle:"Upper back"                , vid:null }],
  "V-Squat": [{ name:"Leg Press"                       , eq:"Machine"    , muscle:"Quads & Glutes"            , vid:"nDh_BlnLCGc" },
               { name:"Goblet Squat"                    , eq:"Dumbbell"   , muscle:"Quads & Glutes"            , vid:"9W5KAqHfDe8" }],
  "Weighted Pull-Up": [{ name:"Pull-Up"                         , eq:"Bodyweight" , muscle:"Lats"                      , vid:"Hdc7Mw6BIEE" },
                        { name:"Lat Pulldown"                    , eq:"Cable"    , muscle:"Lats"                      , vid:"hnSqbBk15tw" }],
  "Wide-Grip Cable Row": [{ name:"Seated Cable Row"                , eq:"Cable"      , muscle:"Mid back"                  , vid:"7BkgqzC6WsM" },
                           { name:"Dumbbell Bent-Over Row"          , eq:"Dumbbell"   , muscle:"Mid back"                  , vid:"6TSP1TRMUzs" }],
  "Wide-Grip Pull-Up": [{ name:"Pull-Up"                         , eq:"Bodyweight" , muscle:"Lats"                      , vid:"Hdc7Mw6BIEE" },
                         { name:"Lat Pulldown"                    , eq:"Cable"    , muscle:"Lats"                      , vid:"hnSqbBk15tw" }],
  "Windshield Wiper": [{ name:"Hanging Knee Raise"              , eq:"Bodyweight" , muscle:"Core"                      , vid:"RD_A-Z15ER4" },
                        { name:"Plank"                           , eq:"Bodyweight" , muscle:"Core"                      , vid:null }],
  "Zottman Curl": [{ name:"DB Curl"                         , eq:"Dumbbell"   , muscle:"Biceps & forearms"         , vid:"XE_pHwbst04" },
                    { name:"Hammer Curl"                     , eq:"Dumbbell"   , muscle:"Biceps & forearms"         , vid:"BRVDS6HVR9Q" }],
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

// localDateStr (LOCAL "YYYY-MM-DD", never toISOString) is the reference this
// module's Saturday-morning-check-in fix established; it now lives in
// lib/dates.js as the one implementation. Imported at the top of this file.

// Walk back N calendar days (excluding today) and return rows describing what
// was scheduled and whether it was logged. Caller decides what to do with each
// row (render dim, render tappable, render "view session", etc).
//
// `history` is the standard v2 history array. We match logged-ness by comparing
// `record.date` (already ISO YYYY-MM-DD format from finaliseDraft) — exact match.
//
// `weekFor(dateStr)` resolves the week config IN FORCE on a given date —
// callers with schedule-edit history pass a W.getEffectiveOn-backed resolver
// so past days keep the meaning they had when they happened. A single static
// `week` (the fallback) reinterprets the whole window under one config,
// which is only correct when the schedule has never been edited. This module
// stays pure (no storage import) — the resolver is how effective-dating
// reaches it.
//
// Returns oldest first → newest first based on `order` param. Default newest first.
//
// Each row: { date, ...sessionMeta, logged: boolean, recordId: string|null }
export function findRecentDays(history = [], daysBack = 3, { order = "desc", week = WEEK, weekFor = null } = {}) {
  if (daysBack < 1) return [];
  const resolveWeek = weekFor || (() => week);
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
    const meta    = sessionMetaForDate(dateStr, resolveWeek(dateStr) || week);
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
export function hasMissedStrength(history = [], daysBack = 3, { week = WEEK, weekFor = null } = {}) {
  const rows = findRecentDays(history, daysBack, { week, weekFor });
  return rows.some(r => r.type === "strength" && !r.logged);
}

// Map a JS getDay() result (0=Sun..6=Sat) to Forge's monday-start weekday
// index (0=Mon..6=Sun). Used to look up weekDone, which is keyed in that
// convention to match the home week strip.
const SUNSTART_TO_MONSTART = [6, 0, 1, 2, 3, 4, 5];

// Returns the local-date string for the Monday of the week containing the
// given date. Used to decide "is this day in the same week as today" so
// past-week days don't surface as actionable (weekDone is scoped to the
// current ISO week — we'd have no way to tick a Sunday from the Monday after).
function localMondayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();                   // 0=Sun..6=Sat
  const delta = dow === 0 ? -6 : 1 - dow;      // shift back to Monday
  date.setDate(date.getDate() + delta);
  return localDateStr(date);
}

// Walk a local date string forward N days. Local components throughout —
// same DST/timezone reasoning as localDateStr above.
function addDaysLocal(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return localDateStr(date);
}

// Broader version of hasMissedStrength — true if any RECENT training-type day
// is unrecorded: missed strength session (not yet logged), OR non-strength
// non-rest training day (Z2, HIIT, cardio) that's not yet ticked in weekDone.
// Lets the catch-up link on home surface for users who've trained the lifts
// but haven't checked their cardio days off, not just users with logged-but-
// missing strength sessions.
//
// Past-week days don't count — weekDone is current-week scoped, so we'd
// have no way to record the tick. The link stays hidden in that case.
/**
 * Returns the recent training days that are still unmarked. Each row carries
 * an `action` hint:
 *   - "log"  — strength day, no history record. The retro session sheet is
 *              the way through.
 *   - "tick" — non-strength training day (cardio/Z2/HIIT). One-tap Mark ✓
 *              writes dayDone[date] = true.
 *
 * Rest days are excluded (nothing to mark). Today is excluded (still might
 * train it). dayDone is the unified "this date is done" store — strength
 * session finalises auto-write it, the Mark ✓ path writes it explicitly.
 * No past-week guard, no idx-based lookups: cross-week back-marking is the
 * point of the date-keyed store.
 */
export function findUntickedRecent(history = [], daysBack = 7, dayDone = {}, { week = WEEK, weekFor = null } = {}) {
  const rows = findRecentDays(history, daysBack, { week, weekFor });
  const resolveWeek = weekFor || (() => week);

  // Per-week strength cap. The "missing" check has to be aware of the
  // schedule's strength-day count for that week, not just whether THIS
  // date carries a record. Otherwise, editing the schedule mid-week to
  // shift strength to different days makes the new days look "missing"
  // even though the existing records on the original days already
  // satisfy the week's strength quota — and the retro picker offers
  // duplicate logs as a result. Cap == count of scheduled strength
  // entries in this week; once actual ≥ cap, all strength rows for
  // that week are treated as satisfied.
  //
  // The cap is computed PER WEEK, each of the week's seven dates judged
  // under the schedule in force on it (an edit can land mid-week) — the
  // 7-day window spans two weeks, and applying today's strength count to
  // last week both under- and over-suppressed depending on the edit.
  const capByWeek = {};
  const scheduledStrengthCountFor = (weekStart) => {
    if (capByWeek[weekStart] === undefined) {
      let count = 0;
      for (let i = 0; i < 7; i++) {
        const w = resolveWeek(addDaysLocal(weekStart, i)) || week || WEEK;
        if (w[i]?.type === "strength") count += 1;
      }
      capByWeek[weekStart] = count;
    }
    return capByWeek[weekStart];
  };
  const actualStrengthByWeek = {};
  for (const rec of history) {
    if (!rec?.date || !String(rec.session || "").startsWith("strength")) continue;
    // Prefer the denormalised v3 field; fall back for pre-v3 records that
    // haven't been read through H.get yet (callers may pass raw history).
    const ws = rec.weekStart || localMondayOfWeek(rec.date);
    actualStrengthByWeek[ws] = (actualStrengthByWeek[ws] || 0) + 1;
  }

  const out = [];
  for (const r of rows) {
    if (r.type === "rest") continue;
    // SCHEDULE-TYPE drives WHICH store proves completion. Strength is
    // history-backed (only a real session record counts); non-strength is
    // dayDone-backed (manual Mark ✓). Editing the schedule must NEVER
    // promote a cardio tick into a "strength completed" — type lives in
    // userWeek, completion proof lives in the type's own store.
    if (r.type === "strength") {
      if (r.logged) continue;
      const ws = localMondayOfWeek(r.date);
      if ((actualStrengthByWeek[ws] || 0) >= scheduledStrengthCountFor(ws)) continue;
      out.push({ ...r, action: "log" });
    } else {
      if (dayDone[r.date]) continue;
      out.push({ ...r, action: "tick" });
    }
  }
  return out;
}

// Boolean wrapper — historical callers that only need a presence check.
export function hasUntickedRecent(history = [], daysBack = 7, dayDone = {}, { week = WEEK, weekFor = null } = {}) {
  return findUntickedRecent(history, daysBack, dayDone, { week, weekFor }).length > 0;
}

// Translate a date string ("YYYY-MM-DD") into the monday-start weekday
// index Forge uses for weekDone. Exposed so the home screen can tick a
// past non-strength day off the week strip without re-deriving the
// mapping at the call site.
export function weekdayIdxForDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  return SUNSTART_TO_MONSTART[new Date(y, m - 1, d).getDay()];
}
