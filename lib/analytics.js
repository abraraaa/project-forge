// lib/analytics.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure aggregation helpers over session history. No React, no side effects.
// All functions return plain data ready for SVG rendering.
// Expect history in the shape produced by finaliseDraft() in storage.js.
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1RM estimation (Epley formula) ───────────────────────────────────────────
// Well-established, used by most evidence-based training apps.
// Accurate for 1–10 rep range; becomes lossy above 12 reps.
export function epley1RM(weight, reps) {
  if (!weight || !reps) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
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
          // Prefer cached volume (Phase 0.5+ records carry it as set.volume,
          // computed using effectiveLoad so BW movements are tracked correctly).
          // Fall back to raw weight × reps for legacy v1 records.
          if (s.volume != null) {
            byWeek[weekStart][muscle].volume += s.volume;
          } else {
            const reps = parseReps(s.reps);
            const load = s.effectiveLoad ?? s.weight;
            if (load && reps) {
              byWeek[weekStart][muscle].volume += load * reps;
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

// Collapse granular muscle names into broader groups for rollup readability.
// Order matters — specific groups (Triceps, Biceps, Core) checked BEFORE
// more generic ones (Chest, Back, Legs) so compound strings like
// "Triceps & chest" or "Adductors / Core" bucket correctly.
// "Full body" is deliberately NOT a group — we reassign those exercises
// to their dominant mover (e.g. Power Clean → Legs).
function normaliseMuscle(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  // Specific groups first
  if (s.includes("tricep"))                                   return "Triceps";
  // Lats are a back muscle — check before bicep so "lats / biceps" goes to Back
  if (s.includes("lat"))                                      return "Back";
  if (s.includes("bicep") || s.includes("brachial"))          return "Biceps";
  if (s.includes("core") || s.includes("anti"))               return "Core";
  // Shoulders before back/chest because "rear delts / cuff" etc. are
  // unambiguously shoulder-family even if they contain other fragments
  if (s.includes("delt") || s.includes("shoulder") || s.includes("cuff")) return "Shoulders";
  // Full-body / explosive lifts get reassigned to their dominant mover.
  // Power Clean, Hex Bar Deadlift etc. are leg-dominant.
  if (s.includes("full body") || s.includes("explosive") || s.includes("posterior chain")) return "Legs";
  // Leg family
  if (s.includes("quad") || s.includes("glute") || s.includes("ham") || s.includes("adductor")) return "Legs";
  // Chest and back come last so they don't grab compound strings
  if (s.includes("chest") || s.includes("pec"))               return "Chest";
  if (s.includes("back"))                                     return "Back";
  return "Other";
}

// ─── Consistency grid ────────────────────────────────────────────────────────
// Returns a 7 × N grid (rows = Mon..Sun, cols = weeks, oldest left).
// Each cell = { date, trained, cooked, sessionType }.
export function consistencyGrid(history, weeks = 12) {
  const today = new Date();
  const todayMon = mondayOfWeek(today.toISOString().slice(0, 10));
  const cols = [];
  // Build N weeks of columns ending in current week
  for (let w = weeks - 1; w >= 0; w--) {
    const weekStartDate = new Date(todayMon);
    weekStartDate.setDate(weekStartDate.getDate() - w * 7);
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const col = { weekStart, days: [] };
    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(weekStartDate);
      dayDate.setDate(dayDate.getDate() + d);
      const dateStr = dayDate.toISOString().slice(0, 10);
      col.days.push({ date: dateStr, trained: false, cooked: false, sessionType: null });
    }
    cols.push(col);
  }
  // Fill in training data
  for (const rec of history || []) {
    for (const col of cols) {
      const day = col.days.find(d => d.date === rec.date);
      if (day) {
        day.trained = true;
        day.cooked = rec.readiness === "cooked";
        day.sessionType = rec.session;
        break;
      }
    }
  }
  return cols;
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

// ─── Date helpers ─────────────────────────────────────────────────────────────
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
          let v;
          if (s.volume != null) {
            v = s.volume;
          } else {
            const reps = parseReps(s.reps);
            const load = s.effectiveLoad ?? s.weight;
            v = (load && reps) ? load * reps : 0;
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
// Used by Phase 3+ deload signals and future Performance Lab indicators.
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
};
