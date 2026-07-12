// @ts-check
// lib/storage.js
// ─────────────────────────────────────────────────────────────────────────────
// localStorage helpers, Vercel Blob sync, and stateless progression utilities.
// No React, no JSX. Safe to import in both client components and API routes.

import { WEEK as DEFAULT_WEEK } from "./programme.js";
import { activeBreak, breakEndedBy, makeBreak } from "./breaks.js";
//
// ─── DURABILITY CONTRACT ────────────────────────────────────────────────────
// LOAD-BEARING. Read before adding a new store.
//
// localStorage is a write-through cache; blob is canonical. Nothing persists
// here without an explicit decision about how it survives a reinstall. Two
// dispositions, every store picks one:
//
//   1. SYNCED — included in the blob meta payload. Must appear in ALL FOUR
//      seams to round-trip safely:
//        · getLocalProfile()    reads the field into the snapshot
//        · persistToLocal()     writes it back from a merged blob
//        · mergeProfileData()   declares a merge rule
//        · pushNow/pushDeferred (in components/ForgeApp.jsx) fires from the
//                               mutation handler
//      Missing any one of the four lets a reinstall silently revert the
//      store to default.
//
//   2. DEVICE-LOCAL — intentionally not synced. Must carry an inline comment
//      saying so AND why it's safe to lose on reinstall.
//
// SAVE POINTS that guarantee a SYNCED store reaches the blob:
//   · per mutation (class 1)    — pushNow inside the handler, immediate.
//   · per mutation (class 2)    — pushDeferred sets a dirty flag, free.
//   · visibilitychange=hidden   — flushDeferred sweeps the dirty flag.
//   · pagehide                  — same.
// Routing table for class 1 vs class 2 lives in docs/push-refactor.md.
//
// CURRENT INVENTORY (keep in sync as stores land):
//
//   Store  Disposition   Key shape                                  Notes
//   ─────  ───────────   ─────────────────────────────────────────  ─────
//   P      SYNCED        forge:<profile>:weights / reps / streak    Weights, reps, streak
//   H      SYNCED        forge:<profile>:history                    Own blob, server merge-by-id
//   W      SYNCED        forge:weekConfig                           Custom weekly schedule
//   PB     SYNCED        forge:programmeBlock                       Rotation block
//   F      SYNCED        forge:<profile>:focus                      Training focus
//   BW     SYNCED        forge:<profile>:bw                         Bodyweight {kg, updatedAt}
//   TS     SYNCED        forge:<profile>:trainingState              Engine state, mesocycle
//   PN     DEVICE-LOCAL  forge:<profile>:passkeyNudge               Per-device nudge cadence
//   PQ     DEVICE-LOCAL  forge:pendingPushes                        Retry queue, derived
//   D      DEVICE-LOCAL  forge:<profile>:draft                      Transient in-session draft
//
// Adding a new store without picking a side IS a regression. The contract
// is asserted by tests/storage.test.js#durability-contract — see there for
// the enforcement details.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @file
 * Core storage layer.
 *
 * The shape definitions below are JSDoc typedefs — IDE-only, no runtime cost.
 * They exist to give future edits to this file (and to anything that imports
 * it) a sanity check on what the data actually looks like, without a full
 * TypeScript migration.
 *
 * @typedef {Object} SetEntry
 * @property {number|null} weight        Loaded weight in kg, or null for bodyweight-only
 * @property {number|string|null} reps   Reps performed; string permits "8/leg" notation
 * @property {number|null} rir           Reps in reserve, 0-5; null when not captured
 * @property {string|null} rpe           "easy" | "normal" | "hard" | "cooked" | null
 * @property {number} effectiveLoad      weight + bodyweight where load type warrants it
 * @property {number} volume             reps × effectiveLoad
 * @property {string|null} tempo         e.g. "31x0" — null when not specified
 *
 * @typedef {Object} ExerciseEntry
 * @property {string} name
 * @property {string} muscle
 * @property {boolean} swapped           True if rotated out from programme default
 * @property {string|null} fromPool      Pool key if rotation drew from one
 * @property {"linear"|"isometric"|"plyometric"|"bodyweight"} loadType
 * @property {SetEntry[]} sets
 * @property {Object} prescribed         { weight, reps, sets, rir }
 * @property {Object} summary            { totalVolume, topSet, ... }
 *
 * @typedef {Object} BlockEntry
 * @property {string} id                 e.g. "a1", "b1"
 * @property {"main"|"superset"|"accessory"} type
 * @property {ExerciseEntry[]} exercises
 *
 * @typedef {Object} SessionRecord       The canonical shape persisted in history.
 * @property {2} v                       Schema version. Records with v=1 are migrated on read.
 * @property {string} id                 ISO timestamp at session start; doubles as sort key
 * @property {string} date               YYYY-MM-DD on the user's clock
 * @property {number} dow                Day of week, 0=Sun
 * @property {string} session            "strength-a" | "strength-b" | "strength-c" | "z2" | "moderate" | "hiit" | "rest"
 * @property {number} blockNumber        Programme block (1, 2, 3...)
 * @property {"easy"|"normal"|"hard"|"cooked"} readiness
 * @property {string|null} readinessReason   Cooked-only sub-reason
 * @property {"accumulation"|"deload"} mesocyclePhase
 * @property {number|null} bodyweight    Snapshot at session start
 * @property {number|null} hoursSlept
 * @property {number|null} daysSinceLast
 * @property {boolean} retrospective     True if logged after the fact via retro picker
 * @property {BlockEntry[]} blocks
 */

// ─── localStorage (SSR-safe) ──────────────────────────────────────────────────
export const LS = {
  get: (key, fallback = null) => {
    if (typeof window === "undefined") return fallback;
    try {
      const v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set: (key, val) => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
  remove: (key) => {
    if (typeof window === "undefined") return;
    try { localStorage.removeItem(key); } catch {}
  },
};

// ─── Per-profile data ─────────────────────────────────────────────────────────
export const P = {
  list:         ()       => LS.get("forge:profiles", []),
  add:          (n)      => { const p = P.list(); if (!p.includes(n)) LS.set("forge:profiles", [...p, n]); },
  getActive:    ()       => LS.get("forge:active", null),
  setActive:    (n)      => LS.set("forge:active", n),
  getWeights:   (n)      => LS.get(`forge:${n}:weights`, {}),
  saveWeights:  (n, w)   => LS.set(`forge:${n}:weights`, w),
  getReps:      (n)      => LS.get(`forge:${n}:reps`, {}),
  saveReps:     (n, r)   => LS.set(`forge:${n}:reps`, r),
  getStreak:    (n)      => LS.get(`forge:${n}:streak`, { count: 0, lastDate: null }),
  saveStreak:   (n, s)   => LS.set(`forge:${n}:streak`, s),

  // Day-completion store — date-keyed. Records "user marked this non-strength
  // day complete." Strength days don't write here; the source of truth for
  // strength completion is whether a session record exists in history for
  // that date. Cross-week back-marking just works because the key is the
  // ISO date string, not the weekday-of-current-week.
  //
  // Replaces the older weekKey-scoped weekDone store. getWeekDone is kept
  // as a projection so the home week strip can still look up "is THIS week's
  // Wednesday done?" without re-deriving the math at every call site.
  getDayDone:    (n)            => LS.get(`forge:${n}:dayDone`, {}),
  markDateDone:  (n, dateStr)   => {
    if (!n || !dateStr) return P.getDayDone(n);
    const d = P.getDayDone(n);
    if (d[dateStr]) return d;
    const next = { ...d, [dateStr]: true };
    LS.set(`forge:${n}:dayDone`, next);
    return next;
  },
  // Back-compat: idx-based mark, resolves to today's date for that weekday.
  // Only correct for the current week — kept for the home "Mark complete"
  // button on today. Past-day callers should use markDateDone directly.
  markDayDone:  (n, idx) => {
    if (typeof idx !== "number") return P.getDayDone(n);
    const dateStr = dateOfWeekdayIdxInCurrentWeek(idx);
    return P.markDateDone(n, dateStr);
  },
  // Project dayDone onto the current week as { 0..6: true } so the home
  // week strip can render without knowing about ISO dates.
  getWeekDone:  (n) => {
    const days = P.getDayDone(n);
    const out = {};
    for (let i = 0; i < 7; i++) {
      const dateStr = dateOfWeekdayIdxInCurrentWeek(i);
      if (days[dateStr]) out[i] = true;
    }
    return out;
  },
  // Cardio-day bonus completion. Deliberately a SEPARATE per-week store from
  // weekDone so it can never influence streak/rhythm — bonuses are optional
  // extras, not adherence. Keyed by day index like weekDone.
  getBonusDone:  (n)      => LS.get(`forge:${n}:bonusDone:${weekKey()}`, {}),
  markBonusDone: (n, idx) => {
    const d = LS.get(`forge:${n}:bonusDone:${weekKey()}`, {});
    const next = { ...d, [idx]: true };
    LS.set(`forge:${n}:bonusDone:${weekKey()}`, next);
    return next;
  },
};

// ─── Rhythm (formerly "streak") ──────────────────────────────────────────────
// Replaces the classic "consecutive days" streak with a rolling 28-day
// adherence ratio. The expected sessions in a 28-day window is 12 (3 strength
// days × 4 weeks). Missing a single day or even a whole week doesn't "break"
// anything — the number drops gracefully and recovers as you train again.
//
// Returns: { completed: int, expected: 12, ratio: float, window: 28 }
const RHYTHM_WINDOW_DAYS = 28;
const RHYTHM_EXPECTED    = 12; // 3 strength sessions/week × 4 weeks

export function computeRhythm(history) {
  const now = Date.now();
  const since = now - RHYTHM_WINDOW_DAYS * 86400000;
  const completed = (Array.isArray(history) ? history : [])
    .filter(rec => rec && rec.session && rec.session.startsWith("strength"))
    .filter(rec => {
      const t = new Date(rec.id).getTime();
      return !isNaN(t) && t >= since && t <= now;
    }).length;
  return {
    completed,
    expected: RHYTHM_EXPECTED,
    ratio: Math.min(1, completed / RHYTHM_EXPECTED),
    window: RHYTHM_WINDOW_DAYS,
  };
}

// Legacy helper — kept so existing callers don't break during transition.
// After this patch, HomeScreen should read rhythm directly from history.
export function bumpStreak(name) {
  const today = new Date().toISOString().slice(0, 10);
  const { lastDate } = P.getStreak(name);
  if (lastDate === today) return P.getStreak(name).count;
  // We no longer store a "count" — rhythm is derived from history at render time.
  // But we keep lastDate so we can detect "trained today" without history access.
  P.saveStreak(name, { count: 0, lastDate: today });
  return 0;
}

// ─── Pattern detection — surfaces gentle observations ────────────────────────
// Returns { kind, message } or null. Never nags — caller decides whether to
// render, and the UI should respect a dismissed-in-this-session flag.
export function detectRecoveryPattern(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  // Look at the last 2 sessions in the last 14 days. If both cooked, nudge.
  const fourteenDaysAgo = Date.now() - 14 * 86400000;
  const recent = history
    .filter(rec => rec && rec.id && rec.session && rec.session.startsWith("strength"))
    .filter(rec => new Date(rec.id).getTime() >= fourteenDaysAgo)
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 2);
  if (recent.length < 2) return null;
  const bothCooked = recent.every(r => r.readiness === "cooked");
  if (bothCooked) {
    return {
      kind: "recovery",
      message: "Two cooked sessions in a row. Often that's recovery, sleep, or stress — not effort. Rest is a training variable too.",
    };
  }
  return null;
}

// ─── History (append-only session log) ────────────────────────────────────────
// Records are immutable. Primary key is ISO timestamp id.
// localStorage is a write-through cache; blob is canonical.
//
// v1.1 MIGRATION: on read, records without schemaVersion get upgraded to v2
// shape via migrateV1ToV2 (defined below). Non-destructive — original records
// stay on disk; migration runs per-read. Cheap at our scale (<500 records per
// profile), and avoids the complexity of a one-time backfill pass.
export const H = {
  get: (name) => {
    const raw = LS.get(`forge:${name}:history`, []);
    // Lazy-migrate. Each migration step is idempotent on already-upgraded
    // records, so chaining v1→v2→v3 is safe regardless of the on-disk
    // version. Records on disk stay original; upgrades happen on read.
    return raw.map(r => migrateV2ToV3(migrateV1ToV2(r)));
  },
  save: (name, arr) => LS.set(`forge:${name}:history`, arr),
  append: (name, record) => {
    // Appended records are already v2 (from finaliseDraft). Raw LS write.
    const raw = LS.get(`forge:${name}:history`, []);
    if (raw.some(r => r.id === record.id)) return H.get(name);
    const next = [...raw, record].sort((a, b) => a.id.localeCompare(b.id));
    H.save(name, next);
    return H.get(name);
  },
  // Merge remote history into local. Dedupe by id. Sort chronologically.
  merge: (local, remote) => {
    const byId = new Map();
    [...(local || []), ...(remote || [])].forEach(r => {
      if (r && r.id) byId.set(r.id, r);
    });
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  },
};

// Pending push queue — survives reloads so failed writes retry on next open
export const PQ = {
  get: () => LS.get("forge:pendingPushes", []),
  save: (arr) => LS.set("forge:pendingPushes", arr),
  add: (profile) => {
    const pending = PQ.get();
    if (!pending.includes(profile)) PQ.save([...pending, profile]);
  },
  clear: (profile) => PQ.save(PQ.get().filter(p => p !== profile)),
};

// ─── Programme block (rotation state) ────────────────────────────────────────
// Shared across profiles on this device — one training block.
// Synced to blob so it survives device switches.
// ─── Weekly schedule (user-editable) ────────────────────────────────────────
// ─── Weekly schedule (user-editable, effective-dated edit log) ──────────────
// Per-device weekly schedule — overrides the default WEEK from programme.js
// when the user has customised it (e.g. cardio Mon-Wed → strength Thu-Sat).
// Shared across profiles on this device (same pattern as programmeBlock).
//
// EFFECTIVE-DATING: schedule is NOT a single mutable config. It is an
// append-only list of edits, each effective from a specific date. The
// schedule effective on any date D is the edit with the latest
// effectiveFrom ≤ D. Retroactive edits supported — effectiveFrom may be
// in the past (user did an alternative workout on Monday, opens the app
// Tuesday, says "actually Monday was cardio").
//
// Storage shape on disk:
//
//   forge:weekConfig = [
//     { editedAt: "1970-01-01T00:00:00.000Z", effectiveFrom: "1970-01-01", week: [...7 days...] },
//     { editedAt: "2026-06-18T14:00:00.000Z", effectiveFrom: "2026-06-15", week: [...7 days...] },
//   ]
//
// Sorted ascending by editedAt. The legacy single-7-day-array shape is
// detected on read and wrapped with epoch effectiveFrom so existing
// profiles lose nothing.
//
// Why this matters: a single mutable userWeek made the day's MEANING
// retroactive — editing Wednesday's slot on Thursday silently changed what
// Wednesday "should have been." With an edit log, the past is interpreted
// through the edit that was effective then; the user can also retroactively
// revise a past day via an effectiveFrom in the past. Both flexibility AND
// truthful interpretation, depending on what the user wants.
const VALID_WEEK_TYPES = new Set(["strength", "zone2", "cardio", "hiit", "rest"]);
const POSITION_INITIAL = ["M", "T", "W", "T", "F", "S", "S"];
const TYPE_LABEL = {
  strength: "Strength",
  zone2:    "Zone 2",
  cardio:   "Cardio",
  hiit:     "HIIT",
  rest:     "Rest",
};
function isValidWeekConfig(w) {
  return Array.isArray(w)
    && w.length === 7
    && w.every((d) => d && typeof d === "object" && VALID_WEEK_TYPES.has(d.type));
}
function normaliseWeek(week) {
  return week.map((d, i) => ({
    s:     d.s     || POSITION_INITIAL[i],
    label: d.label || TYPE_LABEL[d.type] || "—",
    type:  d.type,
  }));
}
// ISO YYYY-MM-DD in LOCAL time (matches the date strings used throughout
// the app). UTC would shift overnight edits to the wrong calendar day.
function _todayLocalIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function _isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
// Detect + normalise either shape. Returns null if the input can't be
// interpreted as either a legacy single week or a valid edit log.
function _ensureScheduleHistory(raw) {
  if (raw === null || raw === undefined) return null;
  // New shape: array of {editedAt, effectiveFrom, week}.
  if (Array.isArray(raw) && raw.length > 0 && raw[0] && typeof raw[0] === "object" &&
      "editedAt" in raw[0] && "effectiveFrom" in raw[0] && "week" in raw[0]) {
    const ok = raw.every((e) =>
      typeof e.editedAt === "string" &&
      _isIsoDate(e.effectiveFrom) &&
      isValidWeekConfig(e.week),
    );
    if (!ok) return null;
    return raw.slice().sort((a, b) => a.editedAt.localeCompare(b.editedAt));
  }
  // Legacy shape: a single 7-day array. Wrap with the epoch so it applies
  // to all past dates. editedAt is also epoch so a real future edit sorts
  // after it.
  if (isValidWeekConfig(raw)) {
    return [{
      editedAt:      "1970-01-01T00:00:00.000Z",
      effectiveFrom: "1970-01-01",
      week:          normaliseWeek(raw),
    }];
  }
  return null;
}
export const W = {
  // Returns TODAY'S effective week (normalised to {s, label, type}), or
  // null if no custom schedule has ever been saved. Most callers want
  // this — current rendering, retro picker, week editor's initial draft.
  get: () => W.getEffectiveOn(_todayLocalIso()),

  // Returns the effective week for a given calendar date — i.e. the
  // schedule that was in force on that day. Returns null if no edit
  // precedes the date (user has no custom schedule at all, OR every
  // edit is future-dated relative to this lookup).
  //
  // Resolution: pick the entry with the LATEST effectiveFrom ≤ dateStr.
  // Ties on effectiveFrom break by latest editedAt (the user re-saved
  // the same effective-date — the later save replaces the earlier one;
  // W.save already collapses these, so ties here only arise from
  // cross-device merges).
  getEffectiveOn: (dateStr) => {
    if (!_isIsoDate(dateStr)) return null;
    const history = _ensureScheduleHistory(LS.get("forge:weekConfig", null));
    if (!history || history.length === 0) return null;
    let best = null;
    for (const entry of history) {
      if (entry.effectiveFrom > dateStr) continue;
      if (!best) { best = entry; continue; }
      if (entry.effectiveFrom > best.effectiveFrom ||
         (entry.effectiveFrom === best.effectiveFrom && entry.editedAt > best.editedAt)) {
        best = entry;
      }
    }
    return best ? normaliseWeek(best.week) : null;
  },

  // Full schedule edit log — used by the sync layer so the entire record
  // round-trips through blob meta. Returns null if no custom schedule
  // exists yet.
  getHistory: () => _ensureScheduleHistory(LS.get("forge:weekConfig", null)),

  // Replace the full edit log. Used by persistToLocal after a remote
  // merge has produced the canonical list. Validates shape before
  // writing — a malformed remote payload shouldn't corrupt local.
  replaceHistory: (history) => {
    const cleaned = _ensureScheduleHistory(history);
    if (cleaned === null) return null;
    LS.set("forge:weekConfig", cleaned);
    return cleaned;
  },

  // Save a new effective week. Default effectiveFrom = today (current
  // UI semantics); pass effectiveFrom explicitly for retroactive edits.
  // editedAt is always set to "now" so the log is wall-clock ordered.
  // If an edit on the same date with the same effectiveFrom already
  // exists, it's replaced rather than duplicated.
  save: (week, { effectiveFrom = _todayLocalIso() } = {}) => {
    if (!isValidWeekConfig(week)) {
      throw new Error("W.save: invalid week config — must be 7 entries of {type:<known>}");
    }
    if (!_isIsoDate(effectiveFrom)) {
      throw new Error("W.save: effectiveFrom must be YYYY-MM-DD");
    }
    const editedAt = new Date().toISOString();
    const current = _ensureScheduleHistory(LS.get("forge:weekConfig", null)) || [];
    // Collapse: if there's already an edit with the same effectiveFrom AND
    // the same week shape, no-op. If same effectiveFrom but different week,
    // replace the previous edit for that date (multiple Save taps in one
    // day collapse to one entry).
    const filtered = current.filter((e) => e.effectiveFrom !== effectiveFrom);
    const next = [...filtered, { editedAt, effectiveFrom, week: normaliseWeek(week) }]
      .sort((a, b) => a.editedAt.localeCompare(b.editedAt));
    LS.set("forge:weekConfig", next);
    return normaliseWeek(week);
  },

  // Wipe the entire schedule edit log → callers fall back to default WEEK.
  reset: () => {
    LS.remove("forge:weekConfig");
    return null;
  },
};

export const PB = {
  get: () => LS.get("forge:programmeBlock", {
    number:    1,
    startDate: new Date().toISOString().slice(0, 10),
    config:    {},   // current rotation; empty = use SESSIONS defaults (pool[0])
    history:   {},   // { [slotKey]: string[] } — recent picks (newest first,
                     // up to ROTATION_MEMORY_BLOCKS). Legacy single-string
                     // entries are accepted transparently by rotateAccessories.
  }),
  save: (pb) => LS.set("forge:programmeBlock", pb),
  // Reset rotation state to SESSIONS defaults — clears `config` (so pool[0]
  // is served everywhere) and `history` (so the next rotation starts from a
  // clean exclusion list). Keeps `number` and `startDate` intact so the
  // user's training-journey counter doesn't reset; only the rotation drift
  // is undone. Returns the new programmeBlock object.
  reset: () => {
    const current = PB.get();
    const next = { ...current, config: {}, history: {} };
    LS.set("forge:programmeBlock", next);
    return next;
  },
};

// ─── Day completion (Days) ──────────────────────────────────────────────────
// Unified date-keyed store for what happened on each calendar date — replaces
// dayDone (non-strength manual ticks), bonusDone (cardio bonus marks), and
// the projected weekDone in a single source of truth. Each Day entry carries
// its own type stamps so editing the schedule does NOT retroactively change
// what was logged.
//
// Storage shape:
//
//   forge:<profile>:days = {
//     "2026-06-15": {
//       date:          "2026-06-15",
//       scheduledType: "strength",                 // schedule effective on that date
//       completedType: "strength" | "cardio" | ...,// what actually happened, or null
//       sessionId:     "2026-06-15T14:00:00.000Z", // if strength, the session record id
//       marks:         { bonus?: true },           // optional extras
//       updatedAt:     "2026-06-15T18:00:00.000Z",
//     },
//     ...
//   }
//
// Rollout pattern (this commit, 3/3 of the foundation migration):
//   - Day entries are written IN PARALLEL to the existing dayDone / bonusDone
//     / history stores. Reads still hit the legacy stores — so live UI is
//     unchanged.
//   - On first call to Days.getAll() for a profile, a lazy projection runs
//     once: dayDone + bonusDone + strength history collapse into Day records.
//     A `forge:<profile>:daysProjected` flag prevents re-running.
//   - A follow-up commit will switch reads (week strip, retro picker, etc.)
//     to consume Days directly. The legacy stores then become dead code,
//     removable in the release after.
//
// See docs/architecture.md → Day entity for the rationale and invariants.
export const Days = {
  key:           (profile) => `forge:${profile}:days`,
  _projectedKey: (profile) => `forge:${profile}:daysProjected`,

  // Returns all Day entries for a profile as a date-keyed object. Runs the
  // lazy projection from legacy stores on first call (idempotent thereafter).
  getAll: (profile) => {
    if (!profile) return {};
    Days._maybeProject(profile);
    return LS.get(Days.key(profile), {});
  },

  // Returns the Day entry for a single date, or null if none exists.
  get: (profile, date) => {
    if (!profile || !_isIsoDate(date)) return null;
    const all = Days.getAll(profile);
    return all[date] || null;
  },

  // Returns all Day entries with date in [start, end] (inclusive), as an
  // array sorted oldest-first. Convenience for week-strip projections.
  getInRange: (profile, start, end) => {
    if (!profile || !_isIsoDate(start) || !_isIsoDate(end)) return [];
    const all = Days.getAll(profile);
    return Object.values(all)
      .filter((d) => d.date >= start && d.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date));
  },

  // Upsert a Day entry. `partial` may contain scheduledType / completedType /
  // sessionId / marks. Existing fields are preserved unless overridden; marks
  // is merged shallowly (so setting { bonus: true } doesn't clobber other
  // marks). updatedAt is auto-stamped.
  set: (profile, date, partial) => {
    if (!profile || !_isIsoDate(date) || !partial) return null;
    const all = LS.get(Days.key(profile), {});
    const existing = all[date] || { date };
    const next = {
      ...existing,
      ...partial,
      date,
      marks: { ...(existing.marks || {}), ...(partial.marks || {}) },
      updatedAt: new Date().toISOString(),
    };
    LS.set(Days.key(profile), { ...all, [date]: next });
    return next;
  },

  // Replace the full Day store for a profile. Used by the sync layer after
  // a remote merge. Validates that the input is an object before writing.
  replaceAll: (profile, all) => {
    if (!profile || all === null || typeof all !== "object" || Array.isArray(all)) return null;
    LS.set(Days.key(profile), all);
    // Mark projection done — a remote replace counts as up-to-date.
    LS.set(Days._projectedKey(profile), true);
    return all;
  },

  // Wipe the store + the projected flag.
  clear: (profile) => {
    if (!profile) return;
    LS.remove(Days.key(profile));
    LS.remove(Days._projectedKey(profile));
  },

  // Project the current week onto weekday-index maps (0=Mon..6=Sun) for the
  // week containing `now`. Returns { complete, bonus } where:
  //   complete[i] = true if that date has a Day entry with completedType set
  //                 (covers BOTH strength sessions and manual non-strength
  //                 ticks — the unified completion truth)
  //   bonus[i]    = true if that date's Day entry has marks.bonus
  // This is the read source for the home week strip + today's cards after
  // the cutover from the legacy weekDone / bonusDone projections.
  projectCurrentWeek: (profile, { now = new Date() } = {}) => {
    const out = { complete: {}, bonus: {} };
    if (!profile) return out;
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    const dow = d.getDay();
    const shift = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d); monday.setDate(d.getDate() + shift);
    const all = Days.getAll(profile);
    for (let i = 0; i < 7; i++) {
      const dt = new Date(monday); dt.setDate(monday.getDate() + i);
      const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const entry = all[iso];
      if (!entry) continue;
      // Complete iff the completion satisfies TODAY'S effective schedule for
      // that date: a real strength session (sessionId) satisfies any day —
      // you did more than asked — but a manual tick only satisfies its own
      // type. Fixes the schedule-edit false positive (user report
      // 2026-07-09): tick cardio, flip the day to strength, and the
      // untrained strength day showed "session complete".
      const effectiveType = (W.getEffectiveOn(iso) || DEFAULT_WEEK)[i]?.type || null;
      const satisfied = !!entry.sessionId ||
        (entry.completedType && entry.completedType === effectiveType);
      if (satisfied) out.complete[i] = true;
      if (entry.marks?.bonus) out.bonus[i] = true;
    }
    return out;
  },

  // Date-keyed map of NON-STRENGTH manual completions ({ [date]: true }).
  // Mirrors the legacy `dayDone` shape exactly: a date is present iff it has
  // a completedType set with NO sessionId (a manual tick, not a strength
  // session — strength completion is history-backed). Feeds the retro
  // picker's findUntickedRecent.
  manualTickDates: (profile) => {
    const out = {};
    if (!profile) return out;
    const all = Days.getAll(profile);
    for (const [date, entry] of Object.entries(all)) {
      if (entry.completedType && !entry.sessionId) out[date] = true;
    }
    return out;
  },

  // One-shot projection from the legacy stores. Idempotent — gated by a
  // `forge:<profile>:daysProjected` flag so it runs at most once per profile.
  _maybeProject: (profile) => {
    if (!profile) return;
    if (!LS.get(Days._projectedKey(profile), false)) {
      Days._foldLegacy(profile);
      LS.set(Days._projectedKey(profile), true);
    }
    // Always check the repair gate — it has its own _v1 flag and no-ops
    // once it's run. Lives here (not inside the projection-gated block)
    // so users whose daysProjected flag is already set from a prior load
    // still get their broken entries healed on the next read.
    Days._maybeRepair(profile);
  },

  // Fold the legacy dayDone / history / bonusDone stores into the Day store.
  // UNGATED — safe to call repeatedly (existing entries are preserved; only
  // missing dates are filled). _maybeProject calls this once per profile;
  // persistToLocal calls it after a sync so a peer still on the pre-Day
  // client (pushing legacy fields without `days`) doesn't get dropped now
  // that reads come from Days.
  _foldLegacy: (profile) => {
    if (!profile) return;
    const existing = LS.get(Days.key(profile), {});
    const next = { ...existing };
    const stamp = new Date().toISOString();

    // Project non-strength ticks from dayDone.
    const dayDone = LS.get(`forge:${profile}:dayDone`, {});
    const todayIso = _todayLocalIso();
    for (const [date, done] of Object.entries(dayDone)) {
      if (!done || !_isIsoDate(date) || next[date]) continue;
      // FUTURE dates are refused: you cannot have completed a day that
      // hasn't happened. The only known source of one is the retired
      // legacy P.markDayDone write in the session-finalise path, which
      // resolved the record's weekday in the CURRENT week at wall-clock
      // time — a Sun→Mon midnight straddle marked a date six days ahead.
      // Folding it would mint a phantom "complete" Day entry that then
      // syncs to blob. (This guard heals the write path retroactively:
      // stale phantom dayDone keys stop being folded; any Day entries
      // already minted from them are a separate, explicitly-authorised
      // repair if ever needed.)
      if (date > todayIso) continue;
      // We don't know the historical scheduledType (legacy ticks weren't
      // type-stamped). Best-effort uses the schedule effective on that
      // date — for legacy users this is still the same single-config, so
      // it'll be accurate. New users with retroactive schedule edits get
      // truthful interpretation.
      //
      // CRITICAL fallback to DEFAULT_WEEK: W.getEffectiveOn returns null
      // when no schedule edit log exists (the most common state). Without
      // the fallback, scheduledType and completedType both become null,
      // and Days.manualTickDates filters out the entry — projecting every
      // legacy dayDone tick as INVISIBLE in the retro picker, which then
      // surfaces the same dates as "missed" forever. This was the second
      // half of the "retro keeps showing same cardio days from last week"
      // bug the user reported. Fixed at both sites (here, and in
      // handleMarkDayDone in components/ForgeApp.jsx).
      const eff = W.getEffectiveOn(date) || DEFAULT_WEEK;
      const dow = _dowOfDate(date);
      const scheduledType = eff[dow]?.type || null;
      next[date] = {
        date,
        scheduledType,
        completedType: scheduledType, // legacy dayDone == "did the scheduled thing"
        sessionId:     null,
        marks:         {},
        updatedAt:     stamp,
      };
    }

    // Project strength sessions from history.
    const history = LS.get(`forge:${profile}:history`, []);
    for (const rec of history) {
      if (!rec?.date || !_isIsoDate(rec.date)) continue;
      if (!String(rec.session || "").startsWith("strength")) continue;
      if (next[rec.date]?.sessionId) continue; // already projected
      const eff = W.getEffectiveOn(rec.date);
      const dow = _dowOfDate(rec.date);
      const scheduledType = eff && eff[dow] ? eff[dow].type : "strength";
      next[rec.date] = {
        ...(next[rec.date] || { date: rec.date, marks: {} }),
        scheduledType,
        completedType: "strength",
        sessionId:     rec.id,
        updatedAt:     stamp,
      };
    }

    // Project cardio bonus marks from bonusDone. Stored per ISO week so we
    // walk every key that starts with the bonusDone prefix.
    const bonusPrefix = `forge:${profile}:bonusDone:`;
    if (typeof window !== "undefined") {
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (!k || !k.startsWith(bonusPrefix)) continue;
          const weekKey = k.slice(bonusPrefix.length);
          if (!_isIsoDate(weekKey)) continue;
          const marks = LS.get(k, {});
          for (const [idxStr, done] of Object.entries(marks)) {
            if (!done) continue;
            const idx = Number(idxStr);
            if (!Number.isInteger(idx) || idx < 0 || idx > 6) continue;
            const date = _addDays(weekKey, idx);
            const cur = next[date] || { date, marks: {} };
            next[date] = {
              ...cur,
              marks: { ...(cur.marks || {}), bonus: true },
              updatedAt: cur.updatedAt || stamp,
            };
          }
        }
      } catch { /* localStorage access errors — projection is best-effort */ }
    }

    LS.set(Days.key(profile), next);
  },

  _repairBrokenKey: (profile) => `forge:${profile}:daysRepaired_v1`,

  // One-shot migration for Day entries with null scheduledType + null
  // completedType + no sessionId — the signature of a buggy handleMarkDayDone
  // write from before d6772c1, when W.getEffectiveOn returned null with no
  // schedule edit log. d6772c1 fixed the write path with a DEFAULT_WEEK
  // fallback, but existing broken entries stayed broken because:
  //   1. Days.manualTickDates filters out null completedType, so they
  //      never count as ticked.
  //   2. _foldLegacy's `if (next[date]) continue` skips them — they EXIST
  //      so the fold treats them as already-projected.
  // Result: the retro picker keeps surfacing the same dates as "missed"
  // no matter how many times the user taps Mark ✓ (each tap re-writes
  // the same null values pre-fix). Re-derives both fields from the
  // effective schedule (or DEFAULT_WEEK) and writes back. Gated by a
  // _v1 flag so it runs once per profile; safe to keep in the codebase
  // long-term (no-op for profiles without broken entries).
  _maybeRepair: (profile) => {
    if (!profile) return;
    if (LS.get(Days._repairBrokenKey(profile), false)) return;
    const all = LS.get(Days.key(profile), {});
    let changed = false;
    const stamp = new Date().toISOString();
    for (const [date, entry] of Object.entries(all)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.completedType || entry.sessionId || entry.scheduledType) continue;
      // Bonus marks intentionally NOT a skip-guard here. Pre-fix
      // handleMarkBonusDone wrote { marks: { bonus: true } } with no
      // scheduledType, so a bonus-only entry from old code is
      // indistinguishable from a Mark-then-bonus entry whose Mark wrote
      // nulls. The post-fix handleMarkBonusDone (this same release)
      // derives + writes scheduledType, so any new bonus entry will have
      // scheduledType set and won't fall into this repair branch. Trade-
      // off: rare pre-fix bonus-only-without-scheduled entries get auto-
      // completed (false positive, ~one tap of impact); common pre-fix
      // Mark+bonus entries get healed (true positive, unblocks the retro
      // picker nag). Net for affected users is strongly positive.
      const eff = W.getEffectiveOn(date) || DEFAULT_WEEK;
      const dow = _dowOfDate(date);
      const scheduledType = eff[dow]?.type;
      if (!scheduledType) continue;
      all[date] = {
        ...entry,
        scheduledType,
        completedType: scheduledType,
        updatedAt: stamp,
      };
      changed = true;
    }
    if (changed) LS.set(Days.key(profile), all);
    LS.set(Days._repairBrokenKey(profile), true);
  },
};

// Day-of-week index (0=Mon..6=Sun) from an ISO date. Mirrors the convention
// used elsewhere in the app (programme.js's localDateStr family).
function _dowOfDate(dateStr) {
  if (!_isIsoDate(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();   // 0=Sun..6=Sat
  return dow === 0 ? 6 : dow - 1;               // 0=Mon..6=Sun
}

// Add N days to an ISO date string, returning ISO format.
function _addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ─── Training focus (per profile) ────────────────────────────────────────────
// Per-profile focus picker — biases accessory rotation toward a goal (Forged
// = balanced default, Strong = compound emphasis, Mass = vanity-muscle bias).
// Engine consumes via rotateAccessories(history, { focus }). Falls back to
// "Forged" (no bias) when nothing is stored — first-time users get neutral.
export const F = {
  get: (profile) => {
    if (!profile) return "Forged";
    return LS.get(`forge:${profile}:focus`, "Forged");
  },
  save: (profile, focus) => {
    if (!profile) return null;
    LS.set(`forge:${profile}:focus`, focus);
    return focus;
  },
};

// ─── Vercel Blob sync ────────────────────────────────────────────────────────
// Two blob shapes per profile:
//   forge/profiles/{name}/meta.json    — weights, reps, streak, programmeBlock
//   forge/profiles/{name}/history.json — full session history (append-only)
//
// ARCHITECTURE: Blob is the canonical source of truth. localStorage is a
// write-through cache for offline resilience and instant hydration.
//
// On load: Pull blob → merge with local → update local + state
// On write: Update state → update local → push to blob (with retry queue)

// Sync status tracking for UI feedback
let _syncStatus = { state: "idle", lastSync: null, error: null };
const _syncListeners = new Set();

export const SyncStatus = {
  get: () => ({ ..._syncStatus }),
  subscribe: (fn) => { _syncListeners.add(fn); return () => _syncListeners.delete(fn); },
  _set: (update) => {
    _syncStatus = { ..._syncStatus, ...update };
    // Persist lastSync to localStorage for display across sessions
    if (update.lastSync) {
      try { localStorage.setItem("forge:lastSyncAt", update.lastSync.toString()); } catch {}
    }
    _syncListeners.forEach(fn => fn(_syncStatus));
  },
  // Restore lastSync from localStorage on load
  _init: () => {
    try {
      const stored = localStorage.getItem("forge:lastSyncAt");
      if (stored) _syncStatus.lastSync = parseInt(stored, 10);
    } catch {}
  },
};

// Initialize on module load
if (typeof window !== "undefined") SyncStatus._init();

// ─── Auto-sync on visibility/online + push routing ──────────────────────────
//
//   visible  → backgroundSync (pull merged data, hydrate React state)
//   hidden   → flushDeferred (push only if dirty)
//   online   → flush push queue + pull
//
// Two-tier push model. Mutation handlers route to pushNow (class 1, immediate)
// or pushDeferred (class 2, coalesced). Class 2 sets a dirty flag and
// consumes zero blob ops; the next pushNow or lifecycle flush sweeps it.
// See docs/push-refactor.md for the routing table and cost shape.
let _autoSyncProfile = null;
let _autoSyncCallback = null;

// Per-profile dirty flag for class-2 (deferred) mutations. In-memory only:
// cold-start recovery is the existing backgroundSync.localHadMore path,
// which compares against the actual remote snapshot rather than any flag.
const deferredPushProfiles = new Map();

export function enableAutoSync(profile, onUpdate) {
  _autoSyncProfile = profile;
  _autoSyncCallback = onUpdate;
}

export function disableAutoSync() {
  _autoSyncProfile = null;
  _autoSyncCallback = null;
}

// Class 1 — push the current local snapshot now. Also sweeps the deferred
// dirty flag for this profile (the snapshot we're about to push includes
// any class-2 mutations that were waiting).
export async function pushNow(profile) {
  if (!profile) return false;
  deferredPushProfiles.delete(profile);
  return blobPush(profile, getLocalProfile(profile));
}

// Class 2 — mark this profile as having unflushed mutations. Free
// (in-memory flag set, zero blob ops). The push fires on the next
// pushNow or lifecycle flush.
export function pushDeferred(profile) {
  if (!profile) return;
  deferredPushProfiles.set(profile, true);
}

// Lifecycle flush — push only if dirty. Safe to call repeatedly; no-ops
// when nothing is pending. Returns false on no-op, the blobPush boolean
// otherwise.
export async function flushDeferred(profile) {
  if (!profile || !deferredPushProfiles.has(profile)) return false;
  return pushNow(profile);
}

function _handleVisibilityChange() {
  if (document.visibilityState === "visible" && _autoSyncProfile) {
    backgroundSync(_autoSyncProfile, { onUpdate: _autoSyncCallback });
  } else if (document.visibilityState === "hidden" && _autoSyncProfile) {
    flushDeferred(_autoSyncProfile);
  }
}

function _handlePageHide() {
  if (_autoSyncProfile) flushDeferred(_autoSyncProfile);
}

function _handleOnline() {
  if (_autoSyncProfile) {
    // Also flush any pending pushes
    flushPendingPushes((profile) => ({
      meta: {
        weights: P.getWeights(profile),
        reps: P.getReps(profile),
        streak: P.getStreak(profile),
        programmeBlock: PB.get(),
        // Cross-device-survivable user state — see getLocalProfile and the
        // merge logic for the contract on each. userWeek carries the FULL
        // schedule edit log (effective-dated), not just today's active
        // config — cross-device merge needs every edit's effectiveFrom +
        // editedAt to interpret historical dates correctly.
        userWeek: W.getHistory(),
        userFocus: F.get(profile),
        // Days entity — date-keyed unified completion record (replaces
        // the prior dayDone / bonusDone meta fields). A peer still on the
        // pre-cutover client (pushing dayDone/bonusDone without `days`)
        // is folded into Days via Days._foldLegacy in persistToLocal.
        days: Days.getAll(profile),
        bodyweight: BW.getRaw(profile),
        trainingState: TS.get(profile),
      },
      history: H.get(profile),
    }));
    backgroundSync(_autoSyncProfile, { onUpdate: _autoSyncCallback });
  }
}

// Register global listeners (only in browser)
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", _handleVisibilityChange);
  window.addEventListener("online", _handleOnline);
  // pagehide is the reliable "tab is going away" signal on iOS Safari —
  // visibilitychange to "hidden" misses some PWA backgrounding cases there.
  window.addEventListener("pagehide", _handlePageHide);
}

export async function blobPull(profile) {
  SyncStatus._set({ state: "pulling", error: null });
  try {
    const res = await fetch(`/api/sync?profile=${encodeURIComponent(profile)}`);
    if (!res.ok) {
      SyncStatus._set({ state: "error", error: `Pull failed: ${res.status}` });
      return null;
    }
    const data = await res.json();
    SyncStatus._set({ state: "idle", lastSync: Date.now(), error: null });
    return data;
  } catch (e) {
    SyncStatus._set({ state: "error", error: e.message || "Network error" });
    return null;
  }
}

export async function blobPush(profile, data) {
  SyncStatus._set({ state: "pushing", error: null });
  try {
    const res = await fetch("/api/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, data }),
    });
    if (!res.ok) throw new Error(`Push failed: ${res.status}`);
    PQ.clear(profile);
    SyncStatus._set({ state: "idle", lastSync: Date.now(), error: null });
    return true;
  } catch (e) {
    PQ.add(profile);
    SyncStatus._set({ state: "error", error: e.message || "Sync failed" });
    return false;
  }
}

// ─── Stale-While-Revalidate sync ─────────────────────────────────────────────
// ARCHITECTURE:
//   1. App loads INSTANTLY from localStorage (0ms, works offline)
//   2. Background fetch from blob starts immediately
//   3. If blob has newer/more data, merge and call onUpdate callback
//   4. UI updates seamlessly — no blocking, no error modals
//
// Blob is canonical for conflict resolution, but localStorage is the hot cache.

// Merge local + remote data. Returns merged state + whether anything changed.
// Merge two effective-dated schedule edit logs. Either side may be in the
// legacy single-7-day-array shape (auto-wrapped to the epoch entry by
// _ensureScheduleHistory). The merged result is union by editedAt — on
// duplicate timestamps, remote wins. Returns null if neither side has
// anything to merge.
function mergeScheduleHistory(localUserWeek, remoteUserWeek) {
  const localArr  = _ensureScheduleHistory(localUserWeek)  || [];
  const remoteArr = _ensureScheduleHistory(remoteUserWeek) || [];
  if (localArr.length === 0 && remoteArr.length === 0) return null;
  const byEditedAt = new Map();
  for (const e of localArr)  byEditedAt.set(e.editedAt, e);
  for (const e of remoteArr) byEditedAt.set(e.editedAt, e); // remote wins
  return [...byEditedAt.values()].sort((a, b) => a.editedAt.localeCompare(b.editedAt));
}

// Merge two Day stores (date-keyed objects). Per date, the entry with the
// latest `updatedAt` wins. Entries missing from either side are preserved.
// Either side being null/undefined is treated as empty.
// Merge breather lists across devices. Union by id (the confirmation
// timestamp — a fact, no conflict possible). For a shared id, a resolved
// endedAt beats an open one (a breather ended on any device is ended
// everywhere), and two resolved ends collapse to the EARLIER (the first
// real return is the truth). Sorted oldest-first by start.
function mergeBreaks(localBreaks, remoteBreaks) {
  const byId = new Map();
  for (const b of [...(localBreaks || []), ...(remoteBreaks || [])]) {
    if (!b || !b.id) continue;
    const prior = byId.get(b.id);
    if (!prior) { byId.set(b.id, b); continue; }
    const endedAt = prior.endedAt && b.endedAt
      ? (prior.endedAt < b.endedAt ? prior.endedAt : b.endedAt)
      : (prior.endedAt || b.endedAt || null);
    byId.set(b.id, { ...prior, ...b, endedAt });
  }
  return Array.from(byId.values()).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

function mergeDayEntries(localDays, remoteDays) {
  const l = (localDays && typeof localDays === "object" && !Array.isArray(localDays)) ? localDays : {};
  const r = (remoteDays && typeof remoteDays === "object" && !Array.isArray(remoteDays)) ? remoteDays : {};
  const out = {};
  const dates = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const date of dates) {
    const a = l[date], b = r[date];
    if (!a) { out[date] = b; continue; }
    if (!b) { out[date] = a; continue; }
    // Both sides have an entry — latest-updatedAt wins. Tie goes to remote
    // (cross-device canonical, matches the pattern for other fields).
    const at = a.updatedAt || "";
    const bt = b.updatedAt || "";
    out[date] = bt >= at ? b : a;
  }
  return out;
}

function mergeProfileData(local, remote) {
  const localMeta = local.meta || {};
  const remoteMeta = remote.meta || {};
  const localHistory = local.history || [];
  const remoteHistory = remote.history || [];

  // Merge strategy:
  // - Weights/reps: union of keys, remote wins ties (more recent device)
  // - Streak: higher count wins
  // - ProgrammeBlock: higher block number wins
  // - userWeek: effective-dated schedule edit log. Union by editedAt
  //   (each edit is a fact, no merge conflict possible — even concurrent
  //   edits on two devices produce two log entries with different editedAt
  //   timestamps). Either side may still be in the legacy single-7-day
  //   shape; _ensureScheduleHistory wraps it to an epoch entry for the
  //   merge. Back-compat with pre-edit-log clients.
  // - userFocus: remote wins iff present. Same intent-not-deltas logic.
  // - days: per date, latest-updatedAt wins (see mergeDayEntries). Replaces
  //   the previous dayDone / bonusDone union rules — Day entries are the
  //   sole source of truth for per-date completion now.
  // - bodyweight: latest-wins by updatedAt timestamp. A user weighing in on
  //   one device shouldn't be overwritten by a stale value from another.
  // - trainingState: remote wins if it has any lift state OR muscle anchors.
  //   The engine's per-lift state is derived from history, but it's expensive
  //   to recompute and includes cycle context (deload, recovery counters)
  //   that aren't trivially redivable. Treating it as canonical-from-blob
  //   when present, falling back to local for first-ever sync, is the
  //   simplest correct behaviour.
  // - History: union by id, sorted chronologically
  const mergedMeta = {
    weights: { ...localMeta.weights, ...(remoteMeta.weights || {}) },
    reps: { ...localMeta.reps, ...(remoteMeta.reps || {}) },
    streak: (remoteMeta.streak?.count || 0) >= (localMeta.streak?.count || 0)
      ? (remoteMeta.streak || localMeta.streak)
      : localMeta.streak,
    programmeBlock: (remoteMeta.programmeBlock?.number || 0) >= (localMeta.programmeBlock?.number || 0)
      ? (remoteMeta.programmeBlock || localMeta.programmeBlock)
      : localMeta.programmeBlock,
    userWeek: mergeScheduleHistory(localMeta.userWeek, remoteMeta.userWeek),
    userFocus: remoteMeta.userFocus ?? localMeta.userFocus ?? null,
    days: mergeDayEntries(localMeta.days, remoteMeta.days),
    bodyweight: (() => {
      const r = remoteMeta.bodyweight, l = localMeta.bodyweight;
      if (!r) return l ?? null;
      if (!l) return r;
      // Both present — pick by timestamp. Falls back to remote if either
      // is malformed (defensive — never lose a real value).
      const rt = new Date(r.updatedAt || 0).getTime();
      const lt = new Date(l.updatedAt || 0).getTime();
      return rt >= lt ? r : l;
    })(),
    trainingState: (() => {
      const r = remoteMeta.trainingState, l = localMeta.trainingState;
      const liftCount = (s) => s?.lifts ? Object.keys(s.lifts).length : 0;
      const anchorCount = (s) => s?.muscleAnchors ? Object.keys(s.muscleAnchors).length : 0;
      const richness = (s) => liftCount(s) + anchorCount(s);
      if (richness(r) > 0) return r;
      if (richness(l) > 0) return l;
      return r ?? l ?? null;
    })(),
    breaks: mergeBreaks(localMeta.breaks, remoteMeta.breaks),
    displayName: remoteMeta.displayName || localMeta.displayName,
  };
  const mergedHistory = H.merge(localHistory, remoteHistory);

  // Detect if remote had anything new
  const remoteHadMore = remoteHistory.length > localHistory.length ||
    Object.keys(remoteMeta.weights || {}).length > Object.keys(localMeta.weights || {}).length;
  const localHadMore = localHistory.length > remoteHistory.length ||
    Object.keys(localMeta.weights || {}).length > Object.keys(remoteMeta.weights || {}).length;

  return { meta: mergedMeta, history: mergedHistory, remoteHadMore, localHadMore };
}

// Get local data immediately (synchronous, never fails)
export function getLocalProfile(profile) {
  return {
    meta: {
      weights: P.getWeights(profile),
      reps: P.getReps(profile),
      streak: P.getStreak(profile),
      programmeBlock: PB.get(),
      // Survivable across a fresh install: edited schedule (W), focus
      // identity (F), and per-date completion (Days). Without these in
      // meta, a user who reinstalls Forge gets history back but loses
      // every customisation — schedule reverts to default, focus drops
      // to Forged, and all manual "yes I did this" ticks disappear.
      // userWeek carries the FULL schedule edit log so a reinstall recovers
      // not just today's schedule but every prior edit + its effective date.
      userWeek: W.getHistory(),
      userFocus: F.get(profile),
      // Days entity — unified date-keyed completion store. Replaces the
      // prior dayDone / bonusDone meta fields. A peer still on a pre-
      // cutover client is rescued via Days._foldLegacy in persistToLocal.
      days: Days.getAll(profile),
      // Bodyweight: lost on reinstall before this. Needed by the BW-
      // progression exercises AND by the progression engine's confidence
      // calibration. Synced as the raw stored shape ({kg, updatedAt}) so
      // the merge can compare timestamps.
      bodyweight: BW.getRaw(profile),
      // TrainingState: per-lift currentWeight / e1RM / stall signal /
      // consecutive holds, muscle anchors for cold-start, mesocycle and
      // deload state, volume aggregates. Without this on the blob, a
      // reinstall cold-starts the engine as if the user has never
      // trained — even though history fully rehydrates.
      trainingState: TS.get(profile),
      // Breathers — declared pauses (lib/breaks.js). Carries the user's
      // annotation + intent, so unlike absence (derived) it MUST survive
      // reinstall and sync. Merge rule: mergeBreaks (union by id, a
      // resolved end beats an open one).
      breaks: Bk.getAll(profile),
    },
    history: H.get(profile),
  };
}

// Save merged data back to localStorage (write-through cache)
function persistToLocal(profile, { meta, history }) {
  P.saveWeights(profile, meta.weights || {});
  P.saveReps(profile, meta.reps || {});
  if (meta.streak) P.saveStreak(profile, meta.streak);
  if (meta.programmeBlock) PB.save(meta.programmeBlock);
  // Hydrate user-state stores from the merged meta so a fresh install
  // (or any device whose localStorage is colder than blob) actually picks
  // up the schedule + focus + tick-marks. Each save call is guarded —
  // an empty meta field shouldn't blow away local data that's richer.
  if (meta.userWeek) {
    // replaceHistory accepts either the new effective-dated array OR the
    // legacy single-7-day-array shape (auto-wrapped to an epoch entry).
    // A peer device still pushing the old shape rehydrates cleanly here.
    W.replaceHistory(meta.userWeek);
  }
  if (meta.userFocus) F.save(profile, meta.userFocus);
  // Legacy dayDone / bonusDone payload fields from pre-cutover peers are
  // landed into localStorage here so Days._foldLegacy (called below) can
  // rescue them into the unified Day store. Guarded by length checks so an
  // empty legacy field can't clobber populated local data.
  if (meta.dayDone && Object.keys(meta.dayDone).length > 0) {
    LS.set(`forge:${profile}:dayDone`, meta.dayDone);
  }
  if (meta.bonusDone && Object.keys(meta.bonusDone).length > 0) {
    LS.set(`forge:${profile}:bonusDone:${weekKey()}`, meta.bonusDone);
  }
  if (meta.days && typeof meta.days === "object" && !Array.isArray(meta.days) && Object.keys(meta.days).length > 0) {
    Days.replaceAll(profile, meta.days);
  }
  // Fold any legacy dayDone / bonusDone / history marks that arrived in this
  // payload into the Day store. Covers a peer still on the pre-Day-entity
  // client (pushes dayDone/bonusDone without `days`): without this, reads —
  // which now come from Days — would miss the peer's marks. Idempotent;
  // existing Day entries are preserved. Runs after H.save so history-derived
  // strength days fold too.
  H.save(profile, history || []);
  Days._foldLegacy(profile);
  if (meta.bodyweight) BW.saveRaw(profile, meta.bodyweight);
  if (meta.trainingState && (
    Object.keys(meta.trainingState.lifts || {}).length > 0 ||
    Object.keys(meta.trainingState.muscleAnchors || {}).length > 0
  )) {
    TS.replaceState(profile, meta.trainingState);
  }
  // Breathers: replace with the merged list (mergeBreaks already unioned
  // local+remote, so this is authoritative). Guarded on array-ness only —
  // an empty array is a legitimate "no breathers" state and may correctly
  // clear a stale local one that was resolved on another device.
  if (Array.isArray(meta.breaks)) Bk.replaceAll(profile, meta.breaks);
}

// Background sync: fetch blob, merge, update localStorage, call onUpdate if changed.
// Fire-and-forget — never blocks, never throws to caller.
// Returns a promise that resolves when sync completes (for testing/optional awaiting).
/**
 * @param {string} profile
 * @param {Object} opts
 * @param {Function} [opts.onUpdate]      Called if remote data changed local
 * @param {Function} [opts.onError]       Called on sync errors
 * @returns {Promise<{ source: string, changed: boolean }>}
 */
export function backgroundSync(profile, { onUpdate, onError } = {}) {
  const local = getLocalProfile(profile);
  
  return blobPull(profile).then(remote => {
    if (!remote) {
      // Blob unavailable — we're offline or blob is empty. That's fine.
      // If we have local data that might not be in blob, queue a push.
      if (local.history.length > 0) {
        PQ.add(profile);
      }
      return { source: "local", changed: false };
    }

    const merged = mergeProfileData(local, remote);
    
    // Persist merge to localStorage
    persistToLocal(profile, merged);

    // If remote had new data, notify the UI to refresh
    if (merged.remoteHadMore && onUpdate) {
      onUpdate({ meta: merged.meta, history: merged.history, source: "blob" });
    }

    // If local had data remote didn't, push the merge back
    if (merged.localHadMore) {
      blobPush(profile, { meta: merged.meta, history: merged.history });
    }

    return { source: merged.remoteHadMore ? "blob" : "local", changed: merged.remoteHadMore };
  }).catch(err => {
    // Swallow errors — offline is not an error state
    if (onError) onError(err);
    return { source: "local", changed: false, error: err };
  });
}

// Legacy wrapper for existing callers — returns merged data after sync.
// Prefer backgroundSync for new code.
export async function syncProfile(profile) {
  const local = getLocalProfile(profile);
  const remote = await blobPull(profile);
  
  if (!remote) {
    if (local.history.length || Object.keys(local.meta.weights).length) {
      return { ...local, source: "local" };
    }
    return null;
  }

  const merged = mergeProfileData(local, remote);
  persistToLocal(profile, merged);

  if (merged.localHadMore) {
    blobPush(profile, { meta: merged.meta, history: merged.history });
  }

  return {
    meta: merged.meta,
    history: merged.history,
    source: merged.localHadMore ? "merged" : "blob",
  };
}

// Check whether a profile name is already claimed globally.
// Returns { exists: boolean } or null on network error.
export async function checkProfileExists(profile) {
  try {
    const res = await fetch(`/api/sync?profile=${encodeURIComponent(profile)}&check=1`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Claim a profile name globally. Returns { ok, taken } — taken=true if race loss.
export async function claimProfile(profile, displayName) {
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, displayName }),
    });
    if (res.status === 409) return { ok: false, taken: true };
    if (!res.ok) return { ok: false, taken: false };
    return { ok: true, taken: false };
  } catch {
    return { ok: false, taken: false };
  }
}

// Nuke all cloud data for a profile. Releases the name.
// If the profile has passkeys, requires authToken from passkey authentication.
// Returns { ok, deleted } on success, { ok: false, error, requiresAuth? } on failure.
/**
 * @param {string} profile
 * @param {Object} opts
 * @param {string} [opts.authToken]
 * @returns {Promise<{ ok: boolean, deleted?: boolean, error?: string, requiresAuth?: boolean }>}
 */
export async function blobDelete(profile, { authToken } = {}) {
  try {
    let url = `/api/sync?profile=${encodeURIComponent(profile)}`;
    if (authToken) {
      url += `&authToken=${encodeURIComponent(authToken)}`;
    }
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { 
        ok: false, 
        error: body.error || `HTTP ${res.status}`,
        requiresAuth: body.requiresAuth || false,
      };
    }
    const body = await res.json();
    return { ok: true, deleted: body.deleted || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Called on app open — retry any profiles whose last push failed
export async function flushPendingPushes(dataFn) {
  const pending = PQ.get();
  if (!pending.length) return;
  for (const profile of pending) {
    const data = dataFn(profile);
    if (data) await blobPush(profile, data);
  }
}

// ─── Progression utilities ────────────────────────────────────────────────────
export const roundPlate = (kg) => Math.round(kg / 1.25) * 1.25;

// Apply an RPE rating to a working weight
export function applyRpe(weight, rpe) {
  if (weight === null || weight === undefined) return weight;
  if (rpe === "easy")  return roundPlate(weight * 1.025);
  if (rpe === "limit") return roundPlate(weight * 0.95);
  return weight; // "hard" — hold weight, don't adjust
}

// ─── BW-percentage starting weights for the 5 main lifts ─────────────────────
// Replaces the hardcoded SESSIONS defaults for first-session prescription.
// Multipliers are evidence-based intermediate-novice floors (Israetel/Helms),
// rounded to the nearest 2.5kg. Barbell lifts are floored at 20kg (empty bar).
//
// Returns null when bodyweight isn't captured — caller falls back to the
// programme.js SESSIONS default for that lift.
export const MAIN_LIFT_BW_MULTIPLIERS = {
  "Hex Bar Deadlift":       1.00,
  "Barbell Back Squat":     0.75,
  "Barbell Bench Press":    0.65,
  "Barbell Overhead Press": 0.40,
  "Power Clean":            0.50,
};

// Round to the nearest 2.5kg — standard plate-loadable increment.
export function roundToHalfPlate(kg) {
  return Math.round(kg / 2.5) * 2.5;
}

export function startingWeightForLift(liftName, bodyweightKg) {
  if (!liftName) return null;
  if (bodyweightKg === null || bodyweightKg === undefined) return null;
  const mult = MAIN_LIFT_BW_MULTIPLIERS[liftName];
  if (!mult) return null;
  const raw = bodyweightKg * mult;
  const rounded = roundToHalfPlate(raw);
  // Empty-bar floor on barbell lifts — all five mains here are barbell.
  return Math.max(20, rounded);
}

// ─── Time utilities ───────────────────────────────────────────────────────────
export function weeksSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (7 * 86400000));
}

export function weekKey() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d);
  mon.setDate(diff);
  return mon.toISOString().slice(0, 10);
}

// Resolve a Forge weekday index (0=Mon..6=Sun) to its LOCAL ISO date string
// within the current week. Used so day-done lookups stay date-keyed even when
// the caller thinks in weekday indices (e.g. the home week strip rendering
// loop). Local time so DST and timezones don't shift the day.
export function dateOfWeekdayIdxInCurrentWeek(weekdayIdx) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();                            // 0=Sun..6=Sat
  const monShift = dow === 0 ? -6 : 1 - dow;         // shift to local Monday
  d.setDate(d.getDate() + monShift + weekdayIdx);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Schema versioning ────────────────────────────────────────────────────────
// v1 records: { id, date, session, blocks:[{ exercises:[{ sets:[{weight,reps,rpe}] }] }] }
// v2 adds:    prescribed targets, RIR scale, tempo, derived summaries, mesocycle context
// v3 adds:    weekStart (Monday of date, denormalised for per-week queries),
//             scheduledLetter ("A"|"B"|"C" parsed from session, for query simplicity)
// Backwards-compatible: older records parse cleanly in v3 code. Missing fields
// are either null or derivable at read time (see migrateV1ToV2 + migrateV2ToV3).
export const SCHEMA_VERSION = 3;

// Map UI 3-point RPE labels to numeric RIR (reps-in-reserve, 0-5 scale).
// Higher RIR = more in the tank.
//
// CRITICAL: this mapping must cover every value the UI can produce, or sets
// silently arrive at the engine with rir: null and the engine returns
// "no_rir_signal — HOLD" — meaning the user logs work but never sees
// progression. The UI ships `easy / normal / cooked`. An earlier version of
// this function only handled `easy / hard / limit` so EVERY default-RPE set
// (every set tagged "normal" — the default in the picker) and EVERY max-
// effort set (every set tagged "cooked") arrived as rir: null and blocked
// progression across the entire user base. The fix is to align this mapping
// to the UI's actual 3-point scale.
//
// Mapping rationale:
//   easy   = ≥3 RIR (plenty in the tank — should ADD)
//   normal = 2 RIR (the default — meaningful effort with margin to spare)
//   cooked = 0 RIR (max effort — should HOLD; per-session "cooked" readiness
//                   is handled separately by the engine override)
//
// Legacy aliases ("hard", "limit") map cleanly for any v1 records that may
// have been logged with those strings before the UI was finalised.
export function rpeToRir(rpe) {
  if (rpe === "easy")   return 3;
  if (rpe === "normal") return 2;
  if (rpe === "hard")   return 1;
  if (rpe === "cooked") return 0;
  if (rpe === "limit")  return 0;  // legacy alias for cooked
  // null/undefined/"" are legitimate "no RPE logged" signals — silently null.
  // ANY OTHER non-empty value (typo, future scale, casing drift) is a typo
  // we want to know about — warn loudly so it surfaces in dev rather than
  // silently dropping the set's effort signal downstream.
  if (rpe != null && rpe !== "") {
    console.warn(`rpeToRir: unrecognised RPE "${rpe}" → null (set will lack effort signal)`);
  }
  return null;
}

// Inverse — derives a UI-shaped RPE label from a numeric RIR. Used when the
// caller supplies a precise RIR but no RPE, so we can show consistent
// labelling in history views.
export function rirToRpe(rir) {
  if (rir === null || rir === undefined) return null;
  if (rir >= 3) return "easy";
  if (rir >= 2) return "normal";
  if (rir >= 1) return "hard";   // surfaced when migrating v1 records
  return "cooked";
}

// ─── Epley 1RM (duplicated from analytics.js for perf — avoid cross-import) ───
// weight * (1 + reps/30). Accurate in 1-10 rep range, lossy above 12.
function _epley1RM(weight, reps) {
  if (!weight || !reps) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// Numeric reps parser — "8/leg" → 8, "30s" → 30 (seconds treated as reps for
// volume calc; we'll refine when we add explicit time-under-tension support).
function _parseReps(reps) {
  if (typeof reps === "number") return reps;
  if (typeof reps === "string") {
    const m = reps.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  return 0;
}

// ─── Load type model ──────────────────────────────────────────────────────────
// "external"          → barbell, dumbbell, machine. weight = load. (default)
// "bodyweight"        → push-ups, pull-ups, dips. weight = 0. effective = BW.
// "loaded_bodyweight" → weighted pull-ups, weighted dips. weight = added. effective = BW + weight.
// "assisted_bodyweight" → band-assisted pull-ups. weight = assistance (positive). effective = BW - weight.
//
// effectiveLoad is what the lifter's body actually moved — the right input for
// Epley 1RM and volume calculations on bodyweight movements. A 75kg lifter doing
// pull-ups + 20kg should be tracked as a 95kg loaded movement, not a 20kg one.
//
// When loadType is anything other than "external" but bodyweight isn't known
// (user hasn't set it yet), effectiveLoad returns null. The set is logged with
// the user's reps + RIR captured, but est1rm and volume stay null until BW is
// set. Phase 1 surfaces a prompt; old sessions stay null forever (acceptable).
export const LOAD_TYPES = ["external", "bodyweight", "loaded_bodyweight", "assisted_bodyweight"];

// Infer the load type for an exercise from its name. Used when programme.js
// definitions don't carry an explicit `loadType` field — keeps that file clean
// and consolidates the rule here where it's auditable.
//
// "loaded_bodyweight" is reserved for movements where adding weight is normal
// practice (pull-ups, dips, chin-ups, muscle-ups). The session UI shows a
// "+ kg" picker for these even though they default to bodyweight only.
//
// Accepts the exercise name; falls back to "external" for anything not matched.
export function inferLoadType(name) {
  if (!name) return "external";
  const n = name.toLowerCase();

  // Loaded bodyweight — add weight via belt/dip-belt/dumbbell-between-feet
  if (/(pull-?up|chin-?up|dip|muscle-?up|toes-?to-?bar)/.test(n)) {
    return "loaded_bodyweight";
  }

  // Pure bodyweight — adding weight is unusual or impractical
  if (/(plank|hold|dead\s*bug|bird\s*dog|hollow|push-?up|crunch|raise|row\s*\(trx|trx|nordic|copenhagen|glute\s*bridge|side\s*plank|lateral\s*band|band\s*face\s*pull|leg\s*curl)/.test(n)) {
    // Some of these admit "loaded" variants but in casual lifting are typically BW
    return "bodyweight";
  }

  // Default — barbell, dumbbell, machine, cable
  return "external";
}

export function computeEffectiveLoad(loadType, weight, bodyweight) {
  // External: just the bar/dumbbell weight
  if (!loadType || loadType === "external") return weight ?? null;
  // BW-derived types need bodyweight to compute
  if (bodyweight === null || bodyweight === undefined) return null;
  if (loadType === "bodyweight")          return bodyweight;
  if (loadType === "loaded_bodyweight")   return bodyweight + (weight || 0);
  if (loadType === "assisted_bodyweight") return Math.max(0, bodyweight - (weight || 0));
  return weight ?? null;
}

// ─── Bodyweight store ─────────────────────────────────────────────────────────
// Per-profile current bodyweight + when it was last set. Read by progression
// engine, session UI, and home-screen "update your BW" card. Sits separate from
// TS so a single BW update doesn't touch the larger training-state blob.
const BW_STALE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const BW = {
  key: (profile) => `forge:${profile}:bodyweight`,

  get: (profile) => {
    if (!profile) return null;
    const stored = LS.get(BW.key(profile), null);
    if (!stored) return null;
    return {
      kg: stored.kg,
      updatedAt: stored.updatedAt,
      ageMs: Date.now() - new Date(stored.updatedAt).getTime(),
    };
  },

  // Returns just the kg value, or null if not set. Convenience for the hot path.
  getKg: (profile) => {
    const bw = BW.get(profile);
    return bw ? bw.kg : null;
  },

  // Returns the raw stored shape ({ kg, updatedAt } | null), no derived
  // ageMs. Used by the sync payload — blob serialises this as-is so
  // mergeProfileData can timestamp-compare cross-device updates without
  // smuggling a derived field that the next device would re-derive anyway.
  getRaw: (profile) => {
    if (!profile) return null;
    return LS.get(BW.key(profile), null);
  },

  // Persist a raw {kg, updatedAt} object as-is — used by the sync hydration
  // path to land a remote-merged bodyweight without bumping updatedAt.
  saveRaw: (profile, raw) => {
    if (!profile || !raw || typeof raw.kg !== "number") return;
    LS.set(BW.key(profile), { kg: raw.kg, updatedAt: raw.updatedAt || new Date().toISOString() });
  },

  set: (profile, kg) => {
    if (!profile || kg === null || kg === undefined) return;
    LS.set(BW.key(profile), {
      kg: Math.round(kg * 10) / 10, // single decimal
      updatedAt: new Date().toISOString(),
    });
  },

  // True if BW was last updated > 14 days ago (or never set).
  // Drives the home-screen re-prompt card and progression-engine confidence.
  isStale: (profile) => {
    const bw = BW.get(profile);
    if (!bw) return true;
    return bw.ageMs > BW_STALE_MS;
  },

  clear: (profile) => {
    if (!profile) return;
    LS.remove(BW.key(profile));
  },
};

// ─── Breathers (Bk) — declared pauses on the training rhythm ────────────────
// The STORED companion to the derived absence model (lib/absence.js). Absence
// is detected; a breather is declared — the user saying "stepping back, and
// it's fine", with a reason. Records are { id, start, reason, endedAt } (shape
// + pure logic in lib/breaks.js). Lives in the blob meta payload
// (getLocalProfile / persistToLocal / mergeBreaks) so a breather AND its
// resolution survive reinstall and sync across devices — the one store this
// whole feature needs (durability contract satisfied here, deliberately).
export const Bk = {
  key: (profile) => `forge:${profile}:breaks`,

  // All records, oldest-first. An array (not date-keyed): breaks are events,
  // and `id` (the confirmation timestamp) is the conflict-free merge key.
  getAll: (profile) => {
    if (!profile) return [];
    const raw = LS.get(Bk.key(profile), []);
    return Array.isArray(raw) ? raw : [];
  },

  // The open breather (endedAt null), or null. Pure predicate in breaks.js.
  getActive: (profile) => activeBreak(Bk.getAll(profile)),

  // Begin a breather. Closes any already-open one first (defensive — there
  // should only ever be one, but a cross-device race could leave two).
  // `reason` is a REASONS id or null. Returns the new record.
  /** @param {{today?: string, confirmedAt?: string}} [opts] */
  start: (profile, reason, opts = {}) => {
    if (!profile) return null;
    const { today, confirmedAt } = opts;
    const day = _isIsoDate(today) ? today : _todayLocalIso();
    const stamp = confirmedAt || new Date().toISOString();
    const all = Bk.getAll(profile).map((b) =>
      b && b.start && !b.endedAt ? { ...b, endedAt: day } : b
    );
    const rec = makeBreak(reason, day, stamp);
    LS.set(Bk.key(profile), [...all, rec]);
    return rec;
  },

  // End the open breather iff `activityDate` falls after its start (a
  // session logged live OR retro-filled past the confirmation day). No-op
  // otherwise. Returns true when a breather was closed.
  endOnActivity: (profile, activityDate) => {
    if (!profile) return false;
    const all = Bk.getAll(profile);
    const open = activeBreak(all);
    if (!open || !breakEndedBy(open, activityDate)) return false;
    LS.set(Bk.key(profile), all.map((b) =>
      b.id === open.id ? { ...b, endedAt: activityDate } : b
    ));
    return true;
  },

  // Manually end the open breather NOW, no activity required — the "Back
  // to it" affordance (a user who declared a pause and changed their mind,
  // or is ready before their next logged session). endedAt = today. No-op
  // if nothing is open. Returns true when a breather was closed.
  /** @param {{today?: string}} [opts] */
  end: (profile, opts = {}) => {
    if (!profile) return false;
    const { today } = opts;
    const day = _isIsoDate(today) ? today : _todayLocalIso();
    const all = Bk.getAll(profile);
    const open = activeBreak(all);
    if (!open) return false;
    LS.set(Bk.key(profile), all.map((b) =>
      b.id === open.id ? { ...b, endedAt: day } : b
    ));
    return true;
  },

  // Replace the full list — sync hydration after a remote merge.
  replaceAll: (profile, arr) => {
    if (!profile || !Array.isArray(arr)) return null;
    LS.set(Bk.key(profile), arr);
    return arr;
  },

  clear: (profile) => {
    if (!profile) return;
    LS.remove(Bk.key(profile));
  },
};

// ─── recordCompletion — the ONE write path for "something happened on a date" ─
// Every completion goes through here: live session finalise, retro finalise,
// manual Mark ✓, cardio bonus. It owns the three steps a completion needs —
// effective-schedule stamping (per-date via W.getEffectiveOn, DEFAULT_WEEK
// fallback), the Days upsert, and breather resolution (Bk.endOnActivity) —
// so no call site can forget one. Before this existed, each of the three-
// plus call sites hand-rolled the trio and each historic bug in this
// territory (null scheduledType, midnight-straddle mismarks, retro logs
// never resuming a breather) was one call site missing one step.
//
//   kind "session" — a real strength session record; sessionId required.
//                    Satisfies any scheduled type (you did more than asked).
//   kind "tick"    — manual confirmation the user did the scheduled thing;
//                    completedType is stamped from the schedule effective
//                    ON THAT DATE, so later schedule edits can't reinterpret
//                    what was logged.
//   kind "bonus"   — optional cardio bonus mark. Never adherence: no
//                    completedType, never bumps rhythm, never resumes a
//                    breather.
//
// Returns { entry, scheduledType, endedBreak } or null on bad input.
/**
 * @param {string} profile
 * @param {string} date  ISO YYYY-MM-DD
 * @param {{kind?: "session"|"tick"|"bonus", sessionId?: string|null}} [opts]
 */
export function recordCompletion(profile, date, { kind, sessionId = null } = {}) {
  if (!profile || !_isIsoDate(date)) return null;
  const eff = W.getEffectiveOn(date) || DEFAULT_WEEK;
  const scheduledType = eff[_dowOfDate(date)]?.type || null;

  let entry;
  if (kind === "session") {
    if (!sessionId) return null;
    entry = Days.set(profile, date, { scheduledType, completedType: "strength", sessionId });
  } else if (kind === "tick") {
    entry = Days.set(profile, date, { scheduledType, completedType: scheduledType });
  } else if (kind === "bonus") {
    entry = Days.set(profile, date, { scheduledType, marks: { bonus: true } });
  } else {
    return null;
  }

  // Training on/after an open breather's start resumes the rhythm — live or
  // retro, session or tick. Bonus marks are extras, not activity.
  const endedBreak = kind === "bonus" ? false : Bk.endOnActivity(profile, date);
  return { entry, scheduledType, endedBreak };
}

// ─── Passkey Nudge (PN) — per-profile state for the home-screen passkey nudge ─
// Stores when the profile was created and when the user manually snoozed the
// nudge. Drives both the chip (days 0-3) and the card (days 4+) on home, and
// the snooze cooldown after a manual dismiss. Lives separate from the larger
// training-state blob so updates are cheap.
//
// The "stage" decision is read-only and derived from createdAt + current time:
//   age < 4 days → "chip"
//   age >= 4 days → "card"
//
// Snooze: hides everything until snoozedUntil. Default snooze window = 7 days.
const PN_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export const PN = {
  key: (profile) => `forge:${profile}:passkeyNudge`,

  get: (profile) => {
    if (!profile) return null;
    return LS.get(PN.key(profile), null);
  },

  // Initialise on profile claim. Idempotent — won't overwrite an existing record
  // (which would reset the day-counter and re-show the chip after a card).
  init: (profile) => {
    if (!profile) return;
    const existing = PN.get(profile);
    if (existing?.createdAt) return existing;
    const next = { createdAt: new Date().toISOString(), snoozedUntil: null };
    LS.set(PN.key(profile), next);
    return next;
  },

  // Mark dismissed — sets snoozedUntil to now + 7 days
  snooze: (profile) => {
    if (!profile) return;
    const existing = PN.get(profile) || { createdAt: new Date().toISOString() };
    LS.set(PN.key(profile), {
      ...existing,
      snoozedUntil: new Date(Date.now() + PN_SNOOZE_MS).toISOString(),
    });
  },

  // What stage should the home nudge be in for this profile?
  // Returns "chip" | "card" | "hidden". Caller is responsible for also gating
  // on hasPasskey() and webAuthnSupported.
  stage: (profile) => {
    if (!profile) return "hidden";
    const rec = PN.get(profile);
    if (!rec?.createdAt) return "hidden";
    if (rec.snoozedUntil && new Date(rec.snoozedUntil).getTime() > Date.now()) return "hidden";
    const ageMs = Date.now() - new Date(rec.createdAt).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    return ageDays < 4 ? "chip" : "card";
  },

  clear: (profile) => {
    if (!profile) return;
    LS.remove(PN.key(profile));
  },
};

// ─── Session record builder (v2) ──────────────────────────────────────────────
// Collects per-set logs during a session, finalises into a history record.
export function newDraftLog({
  profileName,
  session,
  blockNumber,
  readiness,
  readinessReason = null,
  // New v2 context — all optional
  mesocyclePhase = "accumulation",     // "accumulation" | "deload" | "recovery" | "baseline"
  bodyweight    = null,                // kg, snapshot at session start
  hoursSlept    = null,                // from readiness screen if provided
  daysSinceLast = null,                // computed by caller from history
}) {
  const date = new Date().toISOString().slice(0, 10);
  return {
    id: new Date().toISOString(),
    date,
    dow: new Date().getDay(),
    profileName,
    schemaVersion: SCHEMA_VERSION,

    session,                            // "strength-a" | "strength-b" | "strength-c"
    blockNumber,

    // v3 — denormalised query helpers. Both are pure functions of fields
    // above; we stamp them at log time so analytics can group by week or
    // letter without re-parsing on every read.
    weekStart:       _mondayOfDate(date),
    scheduledLetter: _parseSessionLetter(session),

    // Mesocycle context — deload philosophy is signal-triggered, not calendar.
    // Default "accumulation" just means "normal training"; flips to "deload"
    // only when user accepts a signal-driven deload offer.
    mesocyclePhase,

    // Readiness (kept for backwards compat)
    readiness,                          // "fresh" | "normal" | "cooked"
    readinessReason,                    // sentiment tag, nullable

    // Context — optional, used by progression engine when available
    bodyweight,
    hoursSlept,
    daysSinceLast,

    startedAt: Date.now(),
    duration: 0,
    blocks: {},                         // keyed by block.id during collection, array at finalise
  };
}

// Push a set into the draft. v2: accepts prescribed targets + RIR + tempo.
// Backwards-compatible: callers still passing only {weight,reps,rpe} work fine;
// RIR is auto-derived from RPE if not supplied, prescribed defaults to nulls.
export function logSet(draft, {
  blockId, blockType, exerciseName, muscle, swapped, fromPool,
  // What actually happened:
  weight, reps, rpe = null, rir = null,
  // Load type — defaults to external for backwards compatibility
  loadType = "external",                // "external"|"bodyweight"|"loaded_bodyweight"|"assisted_bodyweight"
  bodyweight = null,                    // snapshot of user's BW at time of set, for non-external types
  // What was prescribed (v2 — callers should populate these going forward):
  prescribed = null,                    // { weight, reps, sets, rir } or null
  tempo = null,                         // "3-1-1-0" eccentric-pause-concentric-pause, nullable
  blockIntent = null,                   // "strength" | "hypertrophy" | "endurance" | "power"
}) {
  if (!draft.blocks[blockId]) {
    draft.blocks[blockId] = {
      id: blockId,
      type: blockType,
      intent: blockIntent,              // v2 addition, nullable
      exercises: {},
    };
  }
  const bl = draft.blocks[blockId];
  // Late-arriving block intent — populate if first log didn't have it
  if (!bl.intent && blockIntent) bl.intent = blockIntent;

  if (!bl.exercises[exerciseName]) {
    bl.exercises[exerciseName] = {
      name: exerciseName,
      muscle,
      loadType,                         // sticks to the exercise level — all sets share it
      swapped: !!swapped,
      fromPool: fromPool || null,
      tempo,                            // v2
      prescribed,                       // v2
      sets: [],
    };
  } else {
    // Late-arriving prescribed / tempo — populate if first log didn't have them
    if (!bl.exercises[exerciseName].prescribed && prescribed) {
      bl.exercises[exerciseName].prescribed = prescribed;
    }
    if (!bl.exercises[exerciseName].tempo && tempo) {
      bl.exercises[exerciseName].tempo = tempo;
    }
    // loadType locked at exercise creation — don't drift across sets
  }

  // Derive RIR from RPE if caller didn't provide it (legacy paths)
  const effectiveRir = rir !== null && rir !== undefined ? rir : rpeToRir(rpe);

  // Keep RPE consistent: if caller supplied a precise RIR, derive RPE from it
  // (overrides any caller-supplied RPE that may disagree with the RIR).
  // This way the 3-point and 5-point scales stay in sync on disk.
  const effectiveRpe = (rir !== null && rir !== undefined)
    ? rirToRpe(effectiveRir)
    : (rpe || rirToRpe(effectiveRir));

  // Compute the actual systemic load. For external lifts this is just the
  // bar/dumbbell weight. For bodyweight movements it factors in BW (and any
  // added/assisted load). When BW is needed but not set, returns null —
  // the set still logs, est1rm/volume just stay null.
  const effectiveLoad = computeEffectiveLoad(loadType, weight, bodyweight);

  // Cache derived per-set fields so analytics doesn't recompute on every read
  const parsedReps = _parseReps(reps);
  const est1rm     = _epley1RM(effectiveLoad, parsedReps);
  const volume     = (effectiveLoad && parsedReps) ? effectiveLoad * parsedReps : 0;

  bl.exercises[exerciseName].sets.push({
    weight: weight ?? null,             // raw load logged by user (bar weight, or +/- on BW)
    reps,
    rir: effectiveRir,
    rpe: effectiveRpe,                  // kept in sync with RIR
    // Load context — explicit on every set so a single set is self-describing
    loadType,
    bodyweightUsed: bodyweight ?? null, // null if user hadn't set BW at session time
    effectiveLoad,                      // weight that actually moved the body — null if untrackable
    // Cached derived metrics (effective-load-based)
    est1rm,
    volume,
  });
  return draft;
}

// Convert nested collection into serialisable array shape with v2 summaries.
// Summaries are cached at finalise time so Performance Lab renders instantly
// over long histories — no recomputation on every chart view.
export function finaliseDraft(draft) {
  const duration = Math.round((Date.now() - draft.startedAt) / 1000);

  // Shape blocks from keyed object → array, with per-exercise + per-block summaries
  const blocks = Object.values(draft.blocks).map(b => {
    const exercises = Object.values(b.exercises).map(ex => {
      // Per-exercise summary
      const nonEmptySets = (ex.sets || []).filter(s => s.weight !== null || s.reps);
      const totalVolume  = nonEmptySets.reduce((n, s) => n + (s.volume || 0), 0);
      const rirValues    = nonEmptySets.map(s => s.rir).filter(r => r !== null && r !== undefined);
      const avgRir       = rirValues.length
        ? Math.round((rirValues.reduce((a, b) => a + b, 0) / rirValues.length) * 10) / 10
        : null;
      const topSet       = nonEmptySets.reduce((best, s) => {
        if (!best) return s;
        return (s.est1rm || 0) > (best.est1rm || 0) ? s : best;
      }, null);

      // Did we hit the prescribed target?
      let hitTarget = null;
      if (ex.prescribed && ex.prescribed.sets && ex.prescribed.reps) {
        const prescribedTotal = ex.prescribed.sets * _parseReps(ex.prescribed.reps);
        const actualTotal     = nonEmptySets.reduce((n, s) => n + _parseReps(s.reps), 0);
        hitTarget = actualTotal >= prescribedTotal;
      }

      return {
        ...ex,
        sets: ex.sets,
        summary: {
          totalVolume,
          avgRir,
          topSet: topSet ? { weight: topSet.weight, reps: topSet.reps, rir: topSet.rir, est1rm: topSet.est1rm } : null,
          hitTarget,
        },
      };
    });

    return { id: b.id, type: b.type, intent: b.intent || null, exercises };
  });

  // Session-level summary — total volume, avg effort, completion-rate, PR flags.
  // (Per-muscle volume USED to be cached here as `volumeByMuscle`, but nothing
  // ever read it — both Performance Lab and the volume-audit pipeline
  // recompute from raw set logs on every read, in a different vocabulary than
  // the cache used. Dropping the cache simplifies the record shape; old
  // records carry the dead field forever, harmlessly.)
  let totalVolume = 0;
  const allRirs = [];
  let prescribedCount = 0;
  let hitCount        = 0;

  for (const block of blocks) {
    for (const ex of block.exercises) {
      totalVolume += ex.summary.totalVolume;
      // Push raw set RIRs (not pre-averaged exercise RIR) so the session avg
      // is correctly weighted across all working sets, regardless of how many
      // sets each exercise has.
      for (const s of ex.sets || []) {
        if (s.rir !== null && s.rir !== undefined) allRirs.push(s.rir);
      }
      if (ex.summary.hitTarget !== null) {
        prescribedCount++;
        if (ex.summary.hitTarget) hitCount++;
      }
    }
  }

  const avgRir = allRirs.length
    ? Math.round((allRirs.reduce((a, b) => a + b, 0) / allRirs.length) * 10) / 10
    : null;
  const completionRate = prescribedCount > 0
    ? Math.round((hitCount / prescribedCount) * 100) / 100
    : null;

  const { startedAt, ...rest } = draft;
  return {
    ...rest,
    duration,
    blocks,
    summary: {
      totalVolume,
      avgRir,
      completionRate,
      mainLiftPRs: [],                  // populated by progression engine in Phase 2
    },
  };
}

// ─── v1 → v2 migration (read-time) ────────────────────────────────────────────
// Takes an old session record, returns a v2-shaped record with derived fields
// populated. Non-destructive: does not modify the input. Used by H.get() to
// upgrade records as they're read, so histories on disk stay original.
export function migrateV1ToV2(rec) {
  if (!rec) return rec;
  // Per-step idempotent — early-return if already at v2 or beyond. v3 fields
  // are added by migrateV2ToV3, which the H.get chain runs after this.
  if ((rec.schemaVersion || 1) >= 2) return rec;

  const blocks = (rec.blocks || []).map(b => {
    const exercises = (b.exercises || []).map(ex => {
      // v1 records had no loadType — assume "external" (barbell/dumbbell/machine).
      // Safe assumption: v1 sessions almost always logged conventional weights.
      const exLoadType = ex.loadType || "external";

      // Upgrade each set: add rir (from rpe), loadType, effectiveLoad, est1rm, volume
      const sets = (ex.sets || []).map(s => {
        const rir     = s.rir !== undefined && s.rir !== null ? s.rir : rpeToRir(s.rpe);
        const parsed  = _parseReps(s.reps);
        // For legacy external lifts, effectiveLoad === weight
        const setLoadType    = s.loadType || exLoadType;
        const effectiveLoad  = s.effectiveLoad !== undefined
          ? s.effectiveLoad
          : computeEffectiveLoad(setLoadType, s.weight, s.bodyweightUsed ?? null);
        const est1rm  = s.est1rm !== undefined ? s.est1rm : _epley1RM(effectiveLoad, parsed);
        const volume  = s.volume !== undefined ? s.volume : ((effectiveLoad && parsed) ? effectiveLoad * parsed : 0);
        return {
          ...s,
          rir,
          loadType: setLoadType,
          bodyweightUsed: s.bodyweightUsed ?? null,
          effectiveLoad,
          est1rm,
          volume,
        };
      });

      // Per-exercise summary (same logic as finaliseDraft)
      const nonEmpty = sets.filter(s => s.weight !== null || s.reps);
      const totalVolume = nonEmpty.reduce((n, s) => n + (s.volume || 0), 0);
      const rirValues = nonEmpty.map(s => s.rir).filter(r => r !== null && r !== undefined);
      const avgRir = rirValues.length
        ? Math.round((rirValues.reduce((a, b) => a + b, 0) / rirValues.length) * 10) / 10
        : null;
      const topSet = nonEmpty.reduce((best, s) => {
        if (!best) return s;
        return (s.est1rm || 0) > (best.est1rm || 0) ? s : best;
      }, null);

      return {
        ...ex,
        loadType: exLoadType,
        prescribed: ex.prescribed || null,
        tempo: ex.tempo || null,
        sets,
        summary: ex.summary || {
          totalVolume,
          avgRir,
          topSet: topSet ? { weight: topSet.weight, reps: topSet.reps, rir: topSet.rir, est1rm: topSet.est1rm } : null,
          hitTarget: null,
        },
      };
    });
    return { ...b, intent: b.intent || null, exercises };
  });

  // Recompute session summary. (Per-muscle volume USED to be cached here as
  // `volumeByMuscle`, but nothing ever read it — see finaliseDraft comment.)
  let totalVolume = 0;
  const allRirs = [];
  for (const block of blocks) {
    for (const ex of block.exercises) {
      totalVolume += ex.summary.totalVolume;
      // Average over individual sets, not pre-averaged exercise RIRs
      for (const s of ex.sets || []) {
        if (s.rir !== null && s.rir !== undefined) allRirs.push(s.rir);
      }
    }
  }
  const avgRir = allRirs.length
    ? Math.round((allRirs.reduce((a, b) => a + b, 0) / allRirs.length) * 10) / 10
    : null;

  return {
    ...rec,
    // Stamp as v2 explicitly so the v2→v3 step still fires on this record
    // — the H.get chain runs migrateV2ToV3 after this.
    schemaVersion: 2,
    mesocyclePhase: rec.mesocyclePhase || "accumulation",
    bodyweight:    rec.bodyweight    ?? null,
    hoursSlept:    rec.hoursSlept    ?? null,
    daysSinceLast: rec.daysSinceLast ?? null,
    blocks,
    summary: rec.summary || {
      totalVolume,
      avgRir,
      completionRate: null,
      mainLiftPRs: [],
    },
  };
}

// ─── v2 → v3 migration (read-time) ────────────────────────────────────────────
// Adds the denormalised query-helper fields that v3 introduces. Both new
// fields are pure functions of existing fields — `weekStart` from `date`,
// `scheduledLetter` from `session` — so the migration is loss-less and
// idempotent. Pre-v3 records on disk stay original; H.get() upgrades on read.
export function migrateV2ToV3(rec) {
  if (!rec) return rec;
  if ((rec.schemaVersion || 1) >= 3) return rec;
  return {
    ...rec,
    schemaVersion: 3,
    weekStart:       rec.weekStart       || _mondayOfDate(rec.date),
    scheduledLetter: rec.scheduledLetter || _parseSessionLetter(rec.session),
  };
}

// Parses session strings ("strength-a", "strength_b", "strength-c") into
// the canonical "A" | "B" | "C" letter. Returns null for non-strength
// sessions and unrecognisable inputs — analytics consumers handle null
// gracefully.
function _parseSessionLetter(session) {
  if (typeof session !== "string") return null;
  const m = session.toLowerCase().match(/^strength[-_]([abc])$/);
  return m ? m[1].toUpperCase() : null;
}

// Monday of the calendar week containing a given ISO date. Uses local-time
// math (matches the rest of the app's local-date semantics — see the long
// comment on localDateStr in programme.js). Returns null for invalid input.
function _mondayOfDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (isNaN(dt.getTime())) return null;
  const dow = dt.getDay();              // 0=Sun..6=Sat
  const shift = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + shift);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ─── Profile training state (v2) ──────────────────────────────────────────────
// Persistent state beyond session history. One blob per profile.
// Used by progression engine (Phase 2) to compute next prescriptions,
// detect stalls, and trigger signal-driven deloads.
//
// Written at session finalise. Read when computing next session's working weights.
export const TS = {
  key: (profile) => `forge:${profile}:trainingState`,

  get: (profile) => {
    if (!profile) return _defaultTrainingState();
    return LS.get(TS.key(profile), _defaultTrainingState());
  },

  save: (profile, state) => {
    if (!profile) return;
    LS.set(TS.key(profile), { ...state, schemaVersion: SCHEMA_VERSION });
  },

  // Update a single lift's progression state. Preserves other lifts.
  updateLift: (profile, liftName, liftState) => {
    const current = TS.get(profile);
    const next = {
      ...current,
      lifts: { ...current.lifts, [liftName]: liftState },
    };
    TS.save(profile, next);
    return next;
  },

  // Update a single muscle group's anchor (Phase 2). Preserves other muscle groups.
  // Anchors track best e1RM seen per muscle group, used for cold-start prescriptions
  // when a user does a new lift in that group.
  updateMuscleAnchor: (profile, muscleGroup, anchor) => {
    const current = TS.get(profile);
    const next = {
      ...current,
      muscleAnchors: { ...(current.muscleAnchors || {}), [muscleGroup]: anchor },
    };
    TS.save(profile, next);
    return next;
  },

  // Replace the entire mesocycle subtree (Phase 3). Used by deload state transitions
  // (startDeload / completeDeload / dismissDeloadOffer return new mesocycle shapes).
  // Preserves lifts, muscleAnchors, volume, bodyweight.
  updateMesocycle: (profile, mesocycle) => {
    const current = TS.get(profile);
    const next = { ...current, mesocycle };
    TS.save(profile, next);
    return next;
  },

  // Replace the entire training state atomically (Phase 3). Used when state
  // transition helpers return a fully updated trainingState object — avoids
  // multiple sequential writes that could race against each other.
  replaceState: (profile, newState) => {
    if (!profile) return;
    TS.save(profile, newState);
    return newState;
  },

  // Record rolling volume totals — updated on every session finalise
  updateVolume: (profile, volume) => {
    const current = TS.get(profile);
    const next = { ...current, volume };
    TS.save(profile, next);
    return next;
  },
};

function _defaultTrainingState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lifts: {},                          // keyed by canonical exercise name
    muscleAnchors: {},                  // keyed by muscle group ("Quadriceps", "Chest", ...)
    mesocycle: {
      currentPhase: "accumulation",     // "accumulation" | "deload" | "recovery" | "baseline"
      startedDate:  new Date().toISOString().slice(0, 10),
      activeDeload: null,               // { startedAt, plannedDays, triggeredBy } when in deload
      deloadSignals: {
        active: [],                     // currently elevated signal types
        history: [],                    // rolling log of past deload events, capped at 20
        lastDeloadCompletedAt: null,    // ISO date — drives 14-day cooldown
        lastOfferDismissedAt: null,     // ISO date — drives 5-day post-dismissal cooldown
      },
    },
    volume: {
      last7Days:   { byMuscle: {}, total: 0, updatedAt: null },
      last14Days:  { byMuscle: {}, total: 0, updatedAt: null },
      last28Days:  { byMuscle: {}, total: 0, updatedAt: null },
      baseline28d: { byMuscle: {}, total: 0, updatedAt: null },
    },
    bodyweightKg: null,
    bodyweightUpdatedAt: null,
  };
}

// ─── Draft persistence (LS-only, survives force-quit) ─────────────────────────
// A draft is the in-progress session. We persist it to localStorage after every
// set logged so a force-quit or crashed tab doesn't wipe the user's work. Blob
// is deliberately NOT written to during a session — too chatty, no consistency
// guarantee, and blob is our least-reliable layer anyway.
//
// Drafts expire after 12 hours. Covers "started morning session, got
// interrupted, resume after work" without carrying yesterday's ghost.
const DRAFT_EXPIRY_MS = 12 * 60 * 60 * 1000; // 12 hours

// ─── Session intent (one-shot, device-local) ─────────────────────────────────
// Handoff from the home shell to the /session route: beginSession stashes
// which session to start (or resume:true for a draft resume), navigates, and
// SessionHost takes the intent on mount. Same one-shot LS pattern as the
// rotation-summary stash in lib/profile-actions.js. Deliberately NOT synced
// to blob — it's a navigation payload, not user data.
export const SessionIntent = {
  key:   (profile) => `forge:${profile}:pendingSession`,
  stash: (profile, intent) => { if (profile && intent) LS.set(SessionIntent.key(profile), intent); },
  take:  (profile) => {
    if (!profile) return null;
    const v = LS.get(SessionIntent.key(profile), null);
    if (v !== null) LS.remove(SessionIntent.key(profile));
    return v;
  },
};

export const D = {
  key: (profile) => `forge:${profile}:draft`,
  save: (profile, draft) => {
    if (!profile || !draft) return;
    LS.set(D.key(profile), { draft, savedAt: Date.now() });
  },
  // Returns { draft, ageMs, sessionMeta } or null. Silently purges stale drafts.
  load: (profile) => {
    if (!profile) return null;
    const wrapped = LS.get(D.key(profile), null);
    if (!wrapped || !wrapped.draft) return null;
    const ageMs = Date.now() - (wrapped.savedAt || 0);
    if (ageMs > DRAFT_EXPIRY_MS) {
      LS.remove(D.key(profile));
      return null;
    }
    // Count sets logged so the UI can surface a meaningful resume prompt
    let setCount = 0;
    const blocks = wrapped.draft.blocks || {};
    for (const b of Object.values(blocks)) {
      for (const ex of Object.values(b.exercises || {})) {
        setCount += (ex.sets || []).length;
      }
    }
    return { draft: wrapped.draft, ageMs, setCount };
  },
  clear: (profile) => {
    if (!profile) return;
    LS.remove(D.key(profile));
  },
};

// ─── Cooked-day volume scaling ─────────────────────────────────────────────────
// Returns a session with blocks modified for "cooked" readiness.
// Pure function — doesn't touch originals.
export function scaleForReadiness(session, readiness) {
  if (readiness !== "cooked") return session;
  const scaled = {
    ...session,
    blocks: session.blocks
      // Drop finishers entirely on cooked days
      .filter(b => b.type !== "finisher")
      .map(b => {
        if (b.type === "main") {
          // Scale main lift weight to 85% — deload level
          const scaleEx = (ex) => ex?.weight ? { ...ex, weight: roundPlate(ex.weight * 0.85) } : ex;
          return {
            ...b,
            ex:  scaleEx(b.ex),
            exA: scaleEx(b.exA),
            exB: scaleEx(b.exB),
          };
        }
        if (b.type === "superset") {
          // Drop the last set on supersets
          return { ...b, sets: Math.max(2, b.sets - 1) };
        }
        return b;
      }),
  };
  return scaled;
}
