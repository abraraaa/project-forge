// lib/storage.js
// ─────────────────────────────────────────────────────────────────────────────
// localStorage helpers, Vercel Blob sync, and stateless progression utilities.
// No React, no JSX. Safe to import in both client components and API routes.
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
  getWeekDone:  (n)      => LS.get(`forge:${n}:weekDone:${weekKey()}`, {}),
  saveWeekDone: (n, d)   => LS.set(`forge:${n}:weekDone:${weekKey()}`, d),
  markDayDone:  (n, idx) => {
    const d = P.getWeekDone(n);
    const next = { ...d, [idx]: true };
    P.saveWeekDone(n, next);
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
    // Lazy-migrate any v1 records. migrateV1ToV2 is a no-op if already v2.
    return raw.map(r => migrateV1ToV2(r));
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
export const PB = {
  get: () => LS.get("forge:programmeBlock", {
    number:    1,
    startDate: new Date().toISOString().slice(0, 10),
    config:    {},   // current rotation; empty = use SESSIONS defaults (pool[0])
    history:   {},   // previous block's selections for exclusion on next rotate
  }),
  save: (pb) => LS.set("forge:programmeBlock", pb),
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

// ─── Auto-sync on visibility/online ──────────────────────────────────────────
// Retry sync when the app comes back into focus or reconnects to the network.
// This is fire-and-forget — no blocking, no errors surfaced.
let _autoSyncProfile = null;
let _autoSyncCallback = null;

export function enableAutoSync(profile, onUpdate) {
  _autoSyncProfile = profile;
  _autoSyncCallback = onUpdate;
}

export function disableAutoSync() {
  _autoSyncProfile = null;
  _autoSyncCallback = null;
}

function _handleVisibilityChange() {
  if (document.visibilityState === "visible" && _autoSyncProfile) {
    backgroundSync(_autoSyncProfile, { onUpdate: _autoSyncCallback });
  }
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
function mergeProfileData(local, remote) {
  const localMeta = local.meta || {};
  const remoteMeta = remote.meta || {};
  const localHistory = local.history || [];
  const remoteHistory = remote.history || [];

  // Merge strategy:
  // - Weights/reps: union of keys, remote wins ties (more recent device)
  // - Streak: higher count wins
  // - ProgrammeBlock: higher block number wins
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
  H.save(profile, history || []);
}

// Background sync: fetch blob, merge, update localStorage, call onUpdate if changed.
// Fire-and-forget — never blocks, never throws to caller.
// Returns a promise that resolves when sync completes (for testing/optional awaiting).
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

// ─── Schema versioning ────────────────────────────────────────────────────────
// v1 records: { id, date, session, blocks:[{ exercises:[{ sets:[{weight,reps,rpe}] }] }] }
// v2 adds:    prescribed targets, RIR scale, tempo, derived summaries, mesocycle context
// Backwards-compatible: v1 records parse cleanly in v2 code. Missing fields are
// either null or derivable at read time (see migrateV1ToV2).
export const SCHEMA_VERSION = 2;

// Map legacy 3-point RPE enum to RIR (reps-in-reserve) 0-4 scale.
// Used when reading v1 records in v2 code, and as a fallback anywhere else.
// Higher RIR = more in the tank.
//   easy  ≈ 3 RIR (plenty left)
//   hard  ≈ 1 RIR (close to limit)
//   limit ≈ 0 RIR (absolute max effort)
export function rpeToRir(rpe) {
  if (rpe === "easy")  return 3;
  if (rpe === "hard")  return 1;
  if (rpe === "limit") return 0;
  return null;
}

// Inverse — for analytics that still want to think in the 3-point bucket.
export function rirToRpe(rir) {
  if (rir === null || rir === undefined) return null;
  if (rir >= 3) return "easy";
  if (rir >= 1) return "hard";
  return "limit";
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
  return {
    id: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    dow: new Date().getDay(),
    profileName,
    schemaVersion: SCHEMA_VERSION,

    session,                            // "strength-a" | "strength-b" | "strength-c"
    blockNumber,

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

  // Session-level summary — volume by muscle, overall completion, PR flags
  const volumeByMuscle = {};
  let totalVolume = 0;
  const allRirs = [];
  let prescribedCount = 0;
  let hitCount        = 0;

  for (const block of blocks) {
    for (const ex of block.exercises) {
      const muscle = _normaliseMuscle(ex.muscle);
      if (muscle) {
        volumeByMuscle[muscle] = (volumeByMuscle[muscle] || 0) + ex.summary.totalVolume;
      }
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
      volumeByMuscle,
      avgRir,
      completionRate,
      mainLiftPRs: [],                  // populated by progression engine in Phase 2
    },
  };
}

// ─── Muscle normaliser (mirrors analytics.js — duplicated to avoid circular) ──
// When Phase 1+ extracts this to a shared lib, storage + analytics both import from there.
function _normaliseMuscle(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes("tricep"))                                   return "Triceps";
  if (s.includes("lat"))                                      return "Back";
  if (s.includes("bicep") || s.includes("brachial"))          return "Biceps";
  if (s.includes("core") || s.includes("anti"))               return "Core";
  if (s.includes("delt") || s.includes("shoulder") || s.includes("cuff")) return "Shoulders";
  if (s.includes("full body") || s.includes("explosive") || s.includes("posterior chain")) return "Legs";
  if (s.includes("quad") || s.includes("glute") || s.includes("ham") || s.includes("adductor")) return "Legs";
  if (s.includes("chest") || s.includes("pec"))               return "Chest";
  if (s.includes("back"))                                     return "Back";
  return "Other";
}

// ─── v1 → v2 migration (read-time) ────────────────────────────────────────────
// Takes an old session record, returns a v2-shaped record with derived fields
// populated. Non-destructive: does not modify the input. Used by H.get() to
// upgrade records as they're read, so histories on disk stay original.
export function migrateV1ToV2(rec) {
  if (!rec || rec.schemaVersion === SCHEMA_VERSION) return rec;

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

  // Recompute session summary
  const volumeByMuscle = {};
  let totalVolume = 0;
  const allRirs = [];
  for (const block of blocks) {
    for (const ex of block.exercises) {
      const muscle = _normaliseMuscle(ex.muscle);
      if (muscle) volumeByMuscle[muscle] = (volumeByMuscle[muscle] || 0) + ex.summary.totalVolume;
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
    schemaVersion: SCHEMA_VERSION,
    mesocyclePhase: rec.mesocyclePhase || "accumulation",
    bodyweight:    rec.bodyweight    ?? null,
    hoursSlept:    rec.hoursSlept    ?? null,
    daysSinceLast: rec.daysSinceLast ?? null,
    blocks,
    summary: rec.summary || {
      totalVolume,
      volumeByMuscle,
      avgRir,
      completionRate: null,
      mainLiftPRs: [],
    },
  };
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
