// @ts-check
// lib/analytics.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure aggregation helpers over session history. No React, no side effects.
// All functions return plain data ready for SVG rendering.
// Expect history in the shape produced by finaliseDraft() in storage.js.

import { distributeAcrossMuscles } from "./exercise-anatomy.js";
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1RM estimation (Epley formula) ───────────────────────────────────────────
// Well-established, used by most evidence-based training apps.
// Accurate for 1–10 rep range; becomes lossy above 12 reps.
export function epley1RM(weight, reps) {
  if (!weight || !reps) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// ─── Systemic-load multiplier per loadType ───────────────────────────────────
// What the user types vs. what their body actually moved.
//
//   per_db    → user enters per-dumbbell weight; both hands contribute, so
//               systemic load is 2× the entered number for volume purposes.
//   everything else → entered weight === systemic load (1×).
//
// Why volume only (not 1RM): 1RM is a single-limb capacity number tied to
// the implement the user actually held, so the per-DB number IS the right
// 1RM input. Volume aggregates total work done per session — for a 20kg DB
// curl × 10 reps both arms, the body did 400kg of work, not 200kg.
//
// Used by both weeklyVolume and aggregateVolume so per-muscle distribution
// charts don't under-count every dumbbell exercise by half.
function loadTypeMultiplier(loadType) {
  return loadType === "per_db" ? 2 : 1;
}

// ─── Main lift trend ──────────────────────────────────────────────────────────
// Returns { [exerciseName]: [{ date, est1RM, topSet:{weight,reps,rpe} }] }
// Only includes exercises logged in "main" blocks. Skips sessions marked cooked
// so trend reflects true progression, not deload weeks.
// Bodyweight exercises (weight=null) produce null est1RM → filtered out.
export function mainLiftTrend(history, { includeCooked = false } = {}) {
  const byLift = {};
  for (const rec of history || []) {
    if (!includeCooked && rec.readiness === "cooked") continue;
    const mains = (rec.blocks || []).filter(b => b.type === "main");
    for (const block of mains) {
      for (const ex of block.exercises || []) {
        // Top set = highest estimated 1RM across the sets logged
        let best = null;
        for (const s of ex.sets || []) {
          const est = epley1RM(s.weight, parseReps(s.reps));
          if (est !== null && (!best || est > best.est1RM)) {
            best = { est1RM: est, weight: s.weight, reps: s.reps, rpe: s.rpe };
          }
        }
        if (!best) continue;
        if (!byLift[ex.name]) byLift[ex.name] = [];
        byLift[ex.name].push({
          date: rec.date,
          est1RM: best.est1RM,
          topSet: { weight: best.weight, reps: best.reps, rpe: best.rpe },
          cooked: rec.readiness === "cooked",
        });
      }
    }
  }
  // Sort each lift's series chronologically
  for (const name of Object.keys(byLift)) {
    byLift[name].sort((a, b) => a.date.localeCompare(b.date));
  }
  return byLift;
}

// "8/leg" → 8, "30s" → 30 (degenerate but non-zero), bare number → itself
function parseReps(reps) {
  if (typeof reps === "number") return reps;
  if (typeof reps === "string") {
    const m = reps.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  return 0;
}

// ─── Weekly volume per muscle group ───────────────────────────────────────────
// Volume = sets × reps × weight (for weighted exercises).
// Bodyweight exercises contribute sets × reps × bodyweight-proxy (skipped for
// now — adding proxy weights is a future refinement).
// Returns [{ weekStart, byMuscle: { "Quadriceps": { sets, volume }, ... } }]
export function weeklyVolume(history) {
  const byWeek = {};
  for (const rec of history || []) {
    const weekStart = mondayOfWeek(rec.date);
    if (!byWeek[weekStart]) byWeek[weekStart] = {};
    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        const muscle = normaliseMuscle(ex.muscle);
        if (!muscle) continue;
        if (!byWeek[weekStart][muscle]) byWeek[weekStart][muscle] = { sets: 0, volume: 0 };
        for (const s of ex.sets || []) {
          byWeek[weekStart][muscle].sets += 1;
          // Per-DB exercises (e.g. DB curl, lateral raise) are logged with
          // the per-dumbbell number; systemic load is 2× that across both
          // hands. Cached volume was computed pre-multiplier, so we apply
          // it consistently in both branches.
          const mult = loadTypeMultiplier(s.loadType ?? ex.loadType);
          // Prefer cached volume (Phase 0.5+ records carry it as set.volume,
          // computed using effectiveLoad so BW movements are tracked correctly).
          // Fall back to raw weight × reps for legacy v1 records.
          if (s.volume != null) {
            byWeek[weekStart][muscle].volume += s.volume * mult;
          } else {
            const reps = parseReps(s.reps);
            const load = s.effectiveLoad ?? s.weight;
            if (load && reps) {
              byWeek[weekStart][muscle].volume += load * reps * mult;
            }
          }
        }
      }
    }
  }
  return Object.entries(byWeek)
    .map(([weekStart, byMuscle]) => ({ weekStart, byMuscle }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// Bucket raw `ex.muscle` strings into the 9 display groups used by the
// Performance Lab Weekly Volume chart. Output vocabulary matches
// DISPLAY_BUCKET in lib/exercise-anatomy.js and the MUSCLE_COLOURS map
// in lib/tokens.js: Quads / Glutes / Hamstrings / Calves / Chest / Back
// / Shoulders / Arms / Core, plus "Other" as fallback.
//
// Order matters — specific tokens must be checked BEFORE more generic
// ones. Two ordering subtleties:
//
//   1. delt / shoulder / cuff before lat. Otherwise "Lateral delt"
//      matches "lat" first and gets miscategorised as Back.
//   2. Among leg groups, quad → glute → ham. Compound labels like
//      "Quads & Glutes" → Quads (first-mentioned wins). "Glutes / Hams"
//      → Glutes for the same reason.
//
// Posterior chain / full body / explosive (Power Clean, Hex Bar DL):
// bucketed as Glutes since hip extension is the dominant joint action.
// Adductors: bucketed as Glutes (closest functional bucket since there
// is no adductor display group).
//
// Mirrored in lib/storage.js _normaliseMuscle — the equivalence test in
// tests/analytics.test.js asserts both copies stay in lockstep.
function normaliseMuscle(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes("tricep"))                                                return "Arms";
  if (s.includes("delt") || s.includes("shoulder") || s.includes("cuff")) return "Shoulders";
  if (s.includes("lat"))                                                   return "Back";
  if (s.includes("bicep") || s.includes("brachial") || s.includes("forearm")) return "Arms";
  if (s.includes("core")  || s.includes("anti"))                           return "Core";
  if (s.includes("calf")  || s.includes("calves"))                         return "Calves";
  if (s.includes("quad"))                                                  return "Quads";
  if (s.includes("glute"))                                                 return "Glutes";
  if (s.includes("ham"))                                                   return "Hamstrings";
  if (s.includes("posterior") || s.includes("full body") || s.includes("explosive")) return "Glutes";
  if (s.includes("adductor"))                                              return "Glutes";
  if (s.includes("chest") || s.includes("pec"))                            return "Chest";
  if (s.includes("back"))                                                  return "Back";
  return "Other";
}

// ─── Weekly rhythm (12-week adherence strip) ────────────────────────────────
// Replaces the per-day consistency heatmap: the rhythm doctrine judges WEEKS,
// not days (a rolling adherence ratio, no per-day guilt), so the surface now
// says the same thing — distinct training DAYS per week, read against the
// user's own weekly quota at render time. LOCAL date maths throughout: the
// old grid built its columns from toISOString(), the UTC-shift class that
// mis-bucketed sessions by a day for BST users near midnight.
//
// Cooked ratio is deliberately NOT re-plotted here — the readiness bar below
// the strip already tells that story; one signal per surface.
//
// Returns [{ weekStart, days }] oldest → newest, `weeks` entries, current
// week last.
export function weeklyRhythm(history, weeks = 12) {
  const localIso = (d) => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"),
          dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow));

  const cols = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - w * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    cols.push({ weekStart: localIso(start), _end: localIso(end), _days: new Set() });
  }
  for (const rec of history || []) {
    if (!rec?.date || !String(rec.session || "").startsWith("strength")) continue;
    for (const col of cols) {
      if (rec.date >= col.weekStart && rec.date <= col._end) { col._days.add(rec.date); break; }
    }
  }
  return cols.map(({ weekStart, _days }) => ({ weekStart, days: _days.size }));
}

// ─── Progression window pressure (the v2 decision, made data-ready) ─────────
// The per-lift engine window is 12 entries — deliberately one mesocycle so
// signals react to the current block. The parked v2 question ("do deep
// patterns need a wider window?") was gated on real data; this makes the
// gate OBSERVABLE instead of waiting: per main lift, how many sessions
// exist (is the window saturated?) and the longest run of sessions with no
// top-set progress (would a deeper window have seen a longer pattern than
// the engine could?). Verdict flips to "binding" the day any flat run
// outgrows the window — that's when the v2 decision arms, not before.
// Pure; reads full session history, which retains everything the capped
// lift-state window forgets.
export function windowPressure(history, window = 12) {
  const perLift = new Map(); // name → [{date, top}]
  for (const rec of history || []) {
    if (!String(rec?.session || "").startsWith("strength")) continue;
    for (const block of rec.blocks || []) {
      if (block.type !== "main") continue;
      for (const ex of block.exercises || []) {
        const loads = (ex.sets || [])
          .map((s) => s?.effectiveLoad ?? s?.weight ?? 0)
          .filter((l) => l > 0);
        if (!loads.length) continue;
        (perLift.get(ex.name) || perLift.set(ex.name, []).get(ex.name))
          .push({ date: rec.date, top: Math.max(...loads) });
      }
    }
  }
  const lifts = [];
  for (const [name, sessions] of perLift) {
    sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let longestFlat = 0, run = 0, best = -Infinity;
    for (const { top } of sessions) {
      if (top > best) { best = top; run = 0; }
      else { run += 1; if (run > longestFlat) longestFlat = run; }
    }
    lifts.push({
      name,
      sessions: sessions.length,
      saturated: sessions.length > window,
      longestFlatRun: longestFlat,
      exceedsWindow: longestFlat >= window,
    });
  }
  lifts.sort((a, b) => b.sessions - a.sessions);
  const binding = lifts.some((l) => l.exceedsWindow);
  return { lifts, window, binding };
}

// ─── Readiness breakdown ──────────────────────────────────────────────────────
// Returns { fresh, normal, cooked, total } counts across all history.
export function readinessBreakdown(history) {
  const counts = { fresh: 0, normal: 0, cooked: 0 };
  for (const rec of history || []) {
    if (counts[rec.readiness] !== undefined) counts[rec.readiness] += 1;
  }
  return { ...counts, total: counts.fresh + counts.normal + counts.cooked };
}

// ─── Session counts ───────────────────────────────────────────────────────────
export function sessionCount(history) {
  const today = Date.now();
  const sevenAgo  = today - 7  * 86400000;
  const thirtyAgo = today - 30 * 86400000;
  let total = 0, last7 = 0, last30 = 0;
  for (const rec of history || []) {
    total += 1;
    const t = new Date(rec.id).getTime();
    if (t >= sevenAgo) last7 += 1;
    if (t >= thirtyAgo) last30 += 1;
  }
  return { total, last7, last30 };
}

// ─── Recent-history lookup for an exercise ───────────────────────────────────
// Returns the user's last N sessions where the named exercise was performed,
// newest-first, with a "top set" summary + dominant effort signal. Surfaces in
// the SessionScreen as a sanity-check ribbon — users compare the engine's
// recommended weight against what they actually did last time.
//
// "Top set" = max weight; on ties, max reps. Sets where weight === null AND
// reps absent are excluded (matches the same qualifying-set rule the volume
// audit uses). The `allEqual` flag lets the UI render a single line ("5×100")
// when sets were uniform, vs per-set when they varied.
//
// @param {Array}  history       — session records
// @param {string} exerciseName  — exact match against ex.name in the log
// @param {number} [n=3]         — max results
// @returns {Array<{
//   date: string,
//   sets: Array<{weight,reps,rpe,...}>,
//   topSet: object,
//   effort: string|null,
//   allEqual: boolean,
// }>}
export function recentForExercise(history = [], exerciseName, n = 3) {
  if (!exerciseName) return [];
  const matches = [];
  const sorted = [...(history || [])]
    .filter(r => r && r.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const rec of sorted) {
    let found = null;
    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        if (ex?.name !== exerciseName) continue;
        const sets = (ex.sets || []).filter(s => s && (s.weight != null || s.reps));
        if (sets.length === 0) continue;
        const topSet = sets.reduce((best, s) => {
          const bw = best.weight ?? -Infinity;
          const sw = s.weight    ?? -Infinity;
          if (sw > bw) return s;
          if (sw === bw && (s.reps ?? 0) > (best.reps ?? 0)) return s;
          return best;
        }, sets[0]);
        const effort = topSet?.rpe || sets.find(s => s.rpe)?.rpe || null;
        const first = sets[0];
        const allEqual = sets.every(s => s.weight === first.weight && s.reps === first.reps);
        found = { date: rec.date, sets, topSet, effort, allEqual };
        break;
      }
      if (found) break;
    }
    if (found) matches.push(found);
    if (matches.length >= n) break;
  }
  return matches;
}

// ─── Plateau hint ─────────────────────────────────────────────────────────────
// Simple detector: on a given main lift, have the last N sessions held the
// same top-set weight? Returns { lift, weight, sessions } for any such lift.
// Doesn't fire unless there are at least N sessions for the lift.
export function detectPlateaus(history, { minSessions = 3 } = {}) {
  const trends = mainLiftTrend(history);
  const plateaus = [];
  for (const [lift, series] of Object.entries(trends)) {
    if (series.length < minSessions) continue;
    const recent = series.slice(-minSessions);
    const weights = recent.map(p => p.topSet.weight);
    const allEqual = weights.every(w => w === weights[0]);
    if (allEqual && weights[0]) {
      plateaus.push({ lift, weight: weights[0], sessions: minSessions });
    }
  }
  return plateaus;
}

// ─── Per-muscle weekly trend (granular vocabulary) ──────────────────────────
// Returns a per-muscle weekly set-count series at the 13-muscle granular
// vocabulary used by lib/volume-audit.js (separate Front/Side/Rear delts,
// separate Biceps/Triceps, etc.) — NOT the 9-bucket display vocabulary used
// by weeklyVolume() above.
//
// This shape pairs directly with VOLUME_TARGETS so the Performance Lab can
// render one sparkline + MEV/MAV/MRV band per muscle. Set-counting matches
// volume-audit.js#auditHistoryVolume so chart and audit agree on every set:
//   - sets where weight === null AND reps absent are excluded (matches the
//     volume-audit "completed" rule)
//   - per-set anatomy distribution via distributeAcrossMuscles (primary 1.0
//     + weighted secondaries) so a squat credits quads fully and glutes/
//     hams/core/calves partially
//
// @param {Array}  history
// @param {object} [opts]
// @param {number} [opts.weeks=8]    number of week columns
// @param {Date}   [opts.now=Date.now()]   right-edge of the trailing window
// @returns {{
//   weeks: string[],                       // weekStart ISO dates, oldest left
//   byMuscle: Record<string, number[]>,    // sets per week for each muscle
// }}
export function weeklyVolumeByMuscle(history = [], { weeks = 8, now = new Date() } = {}) {
  // Build the week-column scaffolding from the current week back N-1 weeks.
  const todayMon = mondayOfWeek(toIsoDate(now));
  const weekStarts = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const d = new Date(todayMon);
    d.setDate(d.getDate() - w * 7);
    weekStarts.push(d.toISOString().slice(0, 10));
  }
  const weekIndex = Object.fromEntries(weekStarts.map((ws, i) => [ws, i]));

  const byMuscle = {};
  const credit = (muscle, weekIdx, value) => {
    if (!byMuscle[muscle]) byMuscle[muscle] = new Array(weeks).fill(0);
    byMuscle[muscle][weekIdx] += value;
  };

  for (const rec of history || []) {
    if (!rec?.date) continue;
    const ws = mondayOfWeek(rec.date);
    const idx = weekIndex[ws];
    if (idx === undefined) continue;
    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        const setsCount = (ex.sets || []).filter(s => s && (s.weight !== null || s.reps)).length;
        if (!setsCount) continue;
        const contrib = distributeAcrossMuscles(ex.name, setsCount, ex.muscle);
        for (const [muscle, value] of Object.entries(contrib)) {
          credit(muscle, idx, value);
        }
      }
    }
  }
  // Round per-cell to 1dp so the sparkline values match the audit's display.
  for (const muscle of Object.keys(byMuscle)) {
    byMuscle[muscle] = byMuscle[muscle].map(v => Math.round(v * 10) / 10);
  }
  return { weeks: weekStarts, byMuscle };
}

// ─── Total tonnage moved across all history ─────────────────────────────────
// Sum of every logged set's systemic load × reps, across the entire history.
// Cheap to recompute — runs O(n) over sessions, no expensive lookups. Powers
// the "you've moved X tonnes since you started with Forge" milestone card.
//
// Uses the same per-DB doubling + cached-volume-preferred logic as
// weeklyVolume / aggregateVolume so the numbers agree across surfaces.
// Returns total kg moved (UI converts to tonnes when displaying).
export function totalTonnage(history = []) {
  let total = 0;
  for (const rec of history || []) {
    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        for (const s of ex.sets || []) {
          const mult = loadTypeMultiplier(s.loadType ?? ex.loadType);
          if (s.volume != null) {
            total += s.volume * mult;
          } else {
            const reps = parseReps(s.reps);
            const load = s.effectiveLoad ?? s.weight;
            if (load && reps) total += load * reps * mult;
          }
        }
      }
    }
  }
  return Math.round(total);
}

// Milestone thresholds (kg). Lifetime-tonnage card surfaces once per crossed
// threshold; once dismissed it's gone until the user crosses the next one.
// Curve is log-ish so early users get encouragement and veterans still
// occasionally cross a beat without it becoming wallpaper.
export const TONNAGE_MILESTONES_KG = [
  1_000,    // 1 tonne — first proper bookmark
  5_000,    // 5 tonnes
  10_000,   // 10 tonnes
  25_000,
  50_000,
  100_000,  // 100 tonnes — meaningful badge
  250_000,
  500_000,
  1_000_000,
];

// Given a current total and the highest milestone already acknowledged,
// returns the next unseen milestone the user has crossed, or null.
export function pendingTonnageMilestone(totalKg, lastSeenKg = 0) {
  for (const m of TONNAGE_MILESTONES_KG) {
    if (m > lastSeenKg && totalKg >= m) return m;
  }
  return null;
}

// Format a kg value as a short tonnage display string. <1000kg renders kg,
// >=1000 renders tonnes with a sensible decimal count.
export function formatTonnage(kg) {
  if (kg < 1000) return `${kg} kg`;
  const t = kg / 1000;
  if (t >= 100) return `${Math.round(t)} t`;
  if (t >= 10)  return `${t.toFixed(1)} t`;
  return `${t.toFixed(2)} t`;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function toIsoDate(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

function mondayOfWeek(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d);
  mon.setDate(diff);
  return mon.toISOString().slice(0, 10);
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4 — Rolling volume baselines (silent infrastructure)
// ═════════════════════════════════════════════════════════════════════════════
//
// Phase 4 produces rolling-window volume aggregates per muscle group, used by:
//
//   - Phase 3's deload signal detection (compare last7 vs baseline28)
//   - Future Performance Lab visualisations (post-launch)
//   - Future fatigue/MEV/MAV/MRV tuning (Phase 5+)
//
// Different shape from weeklyVolume(): this returns single aggregates over
// rolling windows ending at "now," not week-by-week breakdowns. Both functions
// coexist — they answer different questions.
//
// All functions here are pure. ForgeApp calls computeVolumeAggregates() at
// session finalise and persists via TS.updateVolume(); no UI consumes the
// data yet — that lands in a future phase.
// ═════════════════════════════════════════════════════════════════════════════

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Window selection ────────────────────────────────────────────────────────
// Inclusive of `now`, exclusive of (now - days).
// Records are filtered by their `id` (ISO timestamp) for sub-day precision;
// falls back to `date` (YYYY-MM-DD) for legacy v1 records lacking a full id.
function recordTime(rec) {
  if (!rec) return 0;
  if (rec.id) {
    const t = new Date(rec.id).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (rec.date) {
    // Treat date-only as midnight UTC start of that day
    const t = new Date(rec.date + "T00:00:00.000Z").getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function recordsInWindow(history, days, anchor = Date.now()) {
  const start = anchor - days * MS_PER_DAY;
  return (history || []).filter(rec => {
    const t = recordTime(rec);
    return t > start && t <= anchor;
  });
}

// ─── Volume aggregator (single window) ───────────────────────────────────────
// Computes total volume + per-muscle volume across an arbitrary set of records.
// Uses effectiveLoad-aware s.volume cache when present (Phase 0.5+), falls
// back to raw weight × reps for legacy.
function aggregateVolume(records) {
  const byMuscle = {};
  let total = 0;
  for (const rec of records || []) {
    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        const muscle = normaliseMuscle(ex.muscle);
        if (!muscle) continue;
        if (!byMuscle[muscle]) byMuscle[muscle] = 0;
        for (const s of ex.sets || []) {
          // Per-DB exercises log per-dumbbell weight; systemic load 2× —
          // see loadTypeMultiplier comment for rationale.
          const mult = loadTypeMultiplier(s.loadType ?? ex.loadType);
          let v;
          if (s.volume != null) {
            v = s.volume * mult;
          } else {
            const reps = parseReps(s.reps);
            const load = s.effectiveLoad ?? s.weight;
            v = (load && reps) ? load * reps * mult : 0;
          }
          byMuscle[muscle] += v;
          total += v;
        }
      }
    }
  }
  // Round to single decimal to avoid float-drift artefacts from summing
  // non-integer per-set volumes (e.g. 1000/3 distributed across sets)
  for (const m of Object.keys(byMuscle)) {
    byMuscle[m] = Math.round(byMuscle[m] * 10) / 10;
  }
  total = Math.round(total * 10) / 10;
  return { byMuscle, total };
}

// ─── Public API ──────────────────────────────────────────────────────────────
//
// computeVolumeAggregates(history, options?)
//   → returns the full v2 volume blob for TS.updateVolume(), shaped to match
//     the schema in _defaultTrainingState():
//
//     {
//       last7Days:   { byMuscle, total, updatedAt },
//       last14Days:  { byMuscle, total, updatedAt },
//       last28Days:  { byMuscle, total, updatedAt },
//       baseline28d: { byMuscle, total, updatedAt }, // mean of trailing 4 × 28d windows
//     }
//
// `baseline28d` is the average of FOUR consecutive 28-day windows ending 28 days
// ago — i.e. the "trailing 16-week typical week, normalised back to a 28-day
// volume." It's the comparison point for fatigue detection: if current 7-day
// volume is meaningfully above (baseline28d / 4), accumulated stress is likely
// above the user's typical training load.
//
// For users with <16 weeks of history, baseline28d falls back to whatever
// records exist — early users get a less-stable baseline that improves with time.
//
// `anchor` (test injection, default Date.now()) lets tests fix the clock.
export function computeVolumeAggregates(history, { anchor = Date.now() } = {}) {
  const updatedAt = new Date(anchor).toISOString();

  const last7  = aggregateVolume(recordsInWindow(history, 7,  anchor));
  const last14 = aggregateVolume(recordsInWindow(history, 14, anchor));
  const last28 = aggregateVolume(recordsInWindow(history, 28, anchor));

  // Baseline: trailing 16 weeks, *excluding* the most recent 28 days.
  // We aggregate that whole window and divide by 4 to get a "typical 28-day
  // volume" anchor that doesn't include the current load we're measuring against.
  const baselineEndAnchor   = anchor - 28 * MS_PER_DAY;
  const baselineWindowDays  = 28 * 4;
  const baselineRecords     = recordsInWindow(history, baselineWindowDays, baselineEndAnchor);
  const baselineRaw         = aggregateVolume(baselineRecords);

  // Normalise to 28-day equivalent: divide by 4 if we have full 16 weeks.
  // For thinner histories, count how many full 28-day windows actually had
  // records and normalise by that — falls back to the raw aggregate if we
  // have <28 days of history (i.e. the user hasn't accumulated enough data).
  // Soft-start by construction: with < 28 days of history the baseline is
  // effectively the same window as last28d, so deload-signal detection stays
  // quiet for early users — the baseline hardens as real history accumulates
  // over ~4 weeks. Intentional: a brand-new user has no accumulated fatigue
  // worth signalling about.
  const baselineWindowsCovered = Math.max(1, Math.min(4, Math.floor(baselineRecords.length > 0 ? baselineWindowDays / 28 : 1)));
  const baselineByMuscle = {};
  for (const [m, v] of Object.entries(baselineRaw.byMuscle)) {
    baselineByMuscle[m] = Math.round((v / baselineWindowsCovered) * 100) / 100;
  }
  const baselineTotal = Math.round((baselineRaw.total / baselineWindowsCovered) * 100) / 100;

  return {
    last7Days:   { byMuscle: last7.byMuscle,  total: round1(last7.total),  updatedAt },
    last14Days:  { byMuscle: last14.byMuscle, total: round1(last14.total), updatedAt },
    last28Days:  { byMuscle: last28.byMuscle, total: round1(last28.total), updatedAt },
    baseline28d: { byMuscle: baselineByMuscle, total: baselineTotal,        updatedAt },
  };
}

// ─── Volume change detection ─────────────────────────────────────────────────
// Returns per-muscle deltas between current 7-day volume and (baseline28d / 4).
// Positive delta = above baseline (potential fatigue accumulation).
// Negative delta = below baseline (potential undertraining).
//
// Not yet wired into the UI — kept warm as raw material for future fatigue
// indicators / deload signals once we have a clean shape for surfacing them.
// Threshold defaults to +50% (1.5×) for "elevated" classification — tuning
// should happen against real user data once we have it.
export function volumeDeltas(volumeAggregates, { elevatedThreshold = 1.5, lowThreshold = 0.7 } = {}) {
  if (!volumeAggregates?.baseline28d || !volumeAggregates?.last7Days) return {};
  const baseline   = volumeAggregates.baseline28d.byMuscle || {};
  const recent     = volumeAggregates.last7Days.byMuscle || {};
  const deltas     = {};

  // Iterate all muscles seen in either window
  const allMuscles = new Set([...Object.keys(baseline), ...Object.keys(recent)]);
  for (const muscle of allMuscles) {
    const recentVol     = recent[muscle]   || 0;
    const baseline28    = baseline[muscle] || 0;
    // Baseline28 is a 28-day total; recent7 is 7 days. Normalise the baseline
    // to "expected weekly volume" by dividing by 4.
    const expectedWeekly = baseline28 / 4;

    if (expectedWeekly === 0) {
      // No baseline data yet — classification undefined
      deltas[muscle] = { recentVol, expectedWeekly: 0, ratio: null, classification: "no_baseline" };
      continue;
    }

    const ratio = recentVol / expectedWeekly;
    let classification = "typical";
    if (ratio >= elevatedThreshold)      classification = "elevated";
    else if (ratio <= lowThreshold)      classification = "low";

    deltas[muscle] = {
      recentVol:      round1(recentVol),
      expectedWeekly: round1(expectedWeekly),
      ratio:          Math.round(ratio * 100) / 100,
      classification,
    };
  }
  return deltas;
}

function round1(n) { return Math.round(n * 10) / 10; }

// Test exports
export const __test_p4__ = {
  recordsInWindow,
  aggregateVolume,
  recordTime,
  normaliseMuscle,
};
