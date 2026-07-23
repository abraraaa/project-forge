// @ts-check
// lib/sync-merge.js
// ─────────────────────────────────────────────────────────────────────────────
// THE merge. One implementation of every cross-device merge rule, imported
// by BOTH the client sync layer (lib/storage.js) and the server PUT route
// (app/api/sync/route.js). Pure — no localStorage, no fetch, no window —
// precisely so it can run on the server: the sync audit's core finding (S3)
// was that meta PUTs overwrote the blob wholesale while only history got a
// server-side merge, so any device pushing from stale local state deleted
// the other device's meta. With this module on both sides, the blob is
// always a merged superset and races converge instead of clobbering.
//
// TIMESTAMP DOCTRINE (audit S2): "remote wins" is only safe when remote is
// actually newer. Fields whose values change in place carry stamps —
// per-key for weights/reps (forge:<p>:weightStamps), whole-value for
// userFocus (userFocusUpdatedAt) and trainingState (updatedAt) — and the
// newer stamp wins. A missing stamp reads as epoch, which preserves the
// legacy behaviour (remote wins) for unstamped data, so old blobs merge
// exactly as before until every device has stamped once. Append-only or
// already-keyed stores (history, schedule log, Days, breaks) never needed
// stamps: union IS their merge.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_WEEK_TYPES = new Set(["strength", "zone2", "cardio", "hiit", "rest"]);
const POSITION_INITIAL = ["M", "T", "W", "T", "F", "S", "S"];
const TYPE_LABEL = {
  strength: "Strength", zone2: "Zone 2", cardio: "Cardio", hiit: "HIIT", rest: "Rest",
};
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidWeekConfig(w) {
  return Array.isArray(w)
    && w.length === 7
    && w.every((d) => d && typeof d === "object" && VALID_WEEK_TYPES.has(d.type));
}

export function normaliseWeek(week) {
  return week.map((d, i) => ({
    s:     d.s     || POSITION_INITIAL[i],
    label: d.label || TYPE_LABEL[d.type] || "—",
    type:  d.type,
  }));
}

// Accepts the schedule edit log in either the modern effective-dated array
// shape or the legacy single-7-day-array shape (wrapped to an epoch entry).
// Returns null when there's nothing valid.
export function ensureScheduleHistory(raw) {
  if (Array.isArray(raw) && raw.length > 0 && raw.every((e) =>
    e && typeof e === "object" && typeof e.editedAt === "string" &&
    typeof e.effectiveFrom === "string" && ISO_DATE_RE.test(e.effectiveFrom) &&
    isValidWeekConfig(e.week))) {
    return raw.map((e) => ({ ...e, week: normaliseWeek(e.week) }))
      .sort((a, b) => a.editedAt.localeCompare(b.editedAt));
  }
  if (isValidWeekConfig(raw)) {
    return [{
      editedAt:      "1970-01-01T00:00:00.000Z",
      effectiveFrom: "1970-01-01",
      week:          normaliseWeek(raw),
    }];
  }
  return null;
}

// Union by editedAt — each edit is a fact; concurrent edits on two devices
// produce two entries. On duplicate timestamps, remote wins.
export function mergeScheduleHistory(localUserWeek, remoteUserWeek) {
  const localArr  = ensureScheduleHistory(localUserWeek)  || [];
  const remoteArr = ensureScheduleHistory(remoteUserWeek) || [];
  if (localArr.length === 0 && remoteArr.length === 0) return null;
  const byEditedAt = new Map();
  for (const e of localArr)  byEditedAt.set(e.editedAt, e);
  for (const e of remoteArr) byEditedAt.set(e.editedAt, e);
  return [...byEditedAt.values()].sort((a, b) => a.editedAt.localeCompare(b.editedAt));
}

// Union by id (confirmation timestamp — a fact). For a shared id, a resolved
// endedAt beats an open one; two resolutions collapse to the EARLIER.
export function mergeBreaks(localBreaks, remoteBreaks) {
  const byId = new Map();
  for (const b of [...(localBreaks || []), ...(remoteBreaks || [])]) {
    if (!b || !b.id) continue;
    const prior = byId.get(b.id);
    // endedAt normalised on first insert too — idempotence (see mergeDayEntries).
    if (!prior) { byId.set(b.id, { ...b, endedAt: b.endedAt ?? null }); continue; }
    const endedAt = prior.endedAt && b.endedAt
      ? (prior.endedAt < b.endedAt ? prior.endedAt : b.endedAt)
      : (prior.endedAt || b.endedAt || null);
    byId.set(b.id, { ...prior, ...b, endedAt });
  }
  return Array.from(byId.values()).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// Field-aware per-date merge: latest-updatedAt entry wins per-field
// conflicts, the loser's facts survive where the winner has none, marks
// union. Safe because nothing un-completes or un-marks a day.
export function mergeDayEntries(localDays, remoteDays) {
  const l = (localDays && typeof localDays === "object" && !Array.isArray(localDays)) ? localDays : {};
  const r = (remoteDays && typeof remoteDays === "object" && !Array.isArray(remoteDays)) ? remoteDays : {};
  const out = {};
  // Normalise on EVERY path, not just the conflict path — the merge must be
  // idempotent (mergeX(x, x) === normalised x) or the exact change
  // detection in mergeProfileData reads shape noise as data.
  const norm = (e) => ({
    ...e,
    scheduledType: e.scheduledType ?? null,
    completedType: e.completedType ?? null,
    sessionId: e.sessionId ?? null,
    marks: { ...(e.marks || {}) },
  });
  const dates = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const date of dates) {
    const a = l[date], b = r[date];
    if (!a) { out[date] = norm(b); continue; }
    if (!b) { out[date] = norm(a); continue; }
    const at = a.updatedAt || "";
    const bt = b.updatedAt || "";
    const winner = bt >= at ? b : a;
    const loser  = bt >= at ? a : b;
    out[date] = {
      ...winner,
      scheduledType: winner.scheduledType ?? loser.scheduledType ?? null,
      completedType: winner.completedType ?? loser.completedType ?? null,
      sessionId:     winner.sessionId     ?? loser.sessionId     ?? null,
      marks: { ...(loser.marks || {}), ...(winner.marks || {}) },
    };
  }
  return out;
}

// ─── Delta sync (#2 family — design in docs/delta-sync.md) ─────────────────
// A delta PUT carries only DIRTY meta fields, but several fields are only
// meaningful as pairs (a value map without its stamp map can't merge
// stamp-aware). The closure expands any requested set to include partners,
// in both directions.
export const FIELD_PAIRS = {
  weights: ["weightStamps"],
  weightStamps: ["weights"],
  reps: ["repStamps"],
  repStamps: ["reps"],
  userFocus: ["userFocusUpdatedAt"],
  userFocusUpdatedAt: ["userFocus"],
};

// Fields a delta client may never write: displayName is SERVER-managed
// identity (written at claim; see audit #15), syncedAt is server-stamped.
const DELTA_READONLY = new Set(["displayName", "syncedAt"]);

export function fieldClosure(fields) {
  const out = new Set();
  for (const f of fields || []) {
    if (DELTA_READONLY.has(f)) continue;
    out.add(f);
    for (const p of FIELD_PAIRS[f] || []) out.add(p);
  }
  return out;
}

// Field-scoped merge for the delta PUT. Runs THE merge (mergeMeta — same
// algebra as the fat path, incoming plays the remote role and wins ties)
// over just the closure of the incoming fields, then returns ONLY those
// keys. The trim is load-bearing: mergeMeta normalises every canonical key
// it knows (absent days → {}, absent streak → null …), and writing those
// back would clobber real rows with empties.
export function mergeMetaFields(existingMeta, incomingMeta) {
  const closure = fieldClosure(Object.keys(incomingMeta || {}));
  const pick = (obj) => {
    const out = {};
    for (const k of closure) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
  };
  const merged = mergeMeta(pick(existingMeta), pick(incomingMeta));
  const out = {};
  for (const k of closure) if (merged[k] !== undefined) out[k] = merged[k];
  return out;
}

// Bodyweight journal: date-keyed { "YYYY-MM-DD": { kg, updatedAt } }. Union
// of dates; per-date the newer updatedAt wins whole-entry (an entry is one
// scale reading — nothing to splice). Idempotent by construction: entries
// pass through untouched, mergeBwLog(x, x) === x shape-for-shape.
export function mergeBwLog(localLog, remoteLog) {
  const l = (localLog && typeof localLog === "object" && !Array.isArray(localLog)) ? localLog : {};
  const r = (remoteLog && typeof remoteLog === "object" && !Array.isArray(remoteLog)) ? remoteLog : {};
  const out = {};
  for (const date of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const a = l[date], b = r[date];
    if (!a) { out[date] = b; continue; }
    if (!b) { out[date] = a; continue; }
    out[date] = (b.updatedAt || "") >= (a.updatedAt || "") ? b : a;
  }
  return out;
}

// programmeBlock: higher block number wins wholesale (a rotation happened).
// EQUAL numbers = two devices mutated the same block (re-pick race, the
// rotation audit's finding 8): the newer updatedAt's config wins (missing
// stamp = epoch, tie → remote), but the per-slot exclusion HISTORY unions —
// winner's order first, loser's unseen names appended, capped at 3
// (ROTATION_MEMORY_BLOCKS — literal here so the server bundle doesn't drag
// in the whole programme dataset). Legacy single-string entries normalise
// to arrays on the way through.
export function mergeProgrammeBlock(l, r) {
  if (!l) return r ?? null;
  if (!r) return l;
  const ln = l.number || 0, rn = r.number || 0;
  if (rn > ln) return r;
  if (ln > rn) return l;
  const lt = l.updatedAt || "", rt = r.updatedAt || "";
  const winner = rt >= lt ? r : l;
  const loser  = rt >= lt ? l : r;
  const toArr = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
  const history = {};
  const slots = new Set([
    ...Object.keys(winner.history || {}),
    ...Object.keys(loser.history || {}),
  ]);
  for (const k of slots) {
    const w = toArr(winner.history?.[k]);
    const lo = toArr(loser.history?.[k]);
    history[k] = [...w, ...lo.filter((n) => !w.includes(n))].slice(0, 3);
  }
  return { ...winner, history };
}

// Union by record id, sorted chronologically. Append-only — the one merge
// that was always race-safe (the server has run it per-PUT from the start).
export function mergeHistories(local, remote) {
  const byId = new Map();
  [...(local || []), ...(remote || [])].forEach((r) => {
    if (r && r.id) byId.set(r.id, r);
  });
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// Per-key stamped map merge (weights/reps). For every key in either map,
// the side with the newer stamp wins; a missing stamp reads as epoch, and
// ties go to remote — byte-identical to the legacy {...local, ...remote}
// for fully-unstamped data.
function mergeStampedMap(localMap = {}, remoteMap = {}, localStamps = {}, remoteStamps = {}) {
  const merged = {};
  const stamps = {};
  const keys = new Set([...Object.keys(localMap || {}), ...Object.keys(remoteMap || {})]);
  for (const key of keys) {
    const inL = key in (localMap || {});
    const inR = key in (remoteMap || {});
    if (!inR) { merged[key] = localMap[key]; if (localStamps?.[key]) stamps[key] = localStamps[key]; continue; }
    if (!inL) { merged[key] = remoteMap[key]; if (remoteStamps?.[key]) stamps[key] = remoteStamps[key]; continue; }
    const lt = localStamps?.[key] || "";
    const rt = remoteStamps?.[key] || "";
    if (rt >= lt) { merged[key] = remoteMap[key]; if (rt) stamps[key] = rt; }
    else          { merged[key] = localMap[key];  stamps[key] = lt; }
  }
  return { merged, stamps };
}

/**
 * Merge two meta documents. Direction convention: `remote` is the side that
 * wins ties — on the CLIENT that's the blob (pre-stamp legacy behaviour);
 * on the SERVER the incoming push is passed as `remote` (a push means "I
 * just did something").
 */
export function mergeMeta(localMeta = {}, remoteMeta = {}) {
  const w = mergeStampedMap(localMeta.weights, remoteMeta.weights,
    localMeta.weightStamps, remoteMeta.weightStamps);
  const r = mergeStampedMap(localMeta.reps, remoteMeta.reps,
    localMeta.repStamps, remoteMeta.repStamps);

  return {
    weights: w.merged,
    weightStamps: w.stamps,
    reps: r.merged,
    repStamps: r.stamps,
    // Streak (audit #18): higher count wins; EQUAL counts tie-break on the
    // LATER lastDate — the old blanket remote-wins-ties let a stale remote
    // copy regress lastDate (train today, sync before push lands → remote
    // same-count-older-date won, breaking next-day continuity).
    streak: (() => {
      const l = localMeta.streak, r = remoteMeta.streak;
      const lc = l?.count || 0, rc = r?.count || 0;
      if (rc !== lc) return rc > lc ? r : l;
      return ((r?.lastDate || "") >= (l?.lastDate || "")) ? (r || l) : l;
    })(),
    programmeBlock: mergeProgrammeBlock(localMeta.programmeBlock, remoteMeta.programmeBlock),
    userWeek: mergeScheduleHistory(localMeta.userWeek, remoteMeta.userWeek),
    // Focus: newer stamp wins; missing stamp = epoch → unstamped remote
    // still wins ties (legacy behaviour) but can no longer beat a STAMPED
    // newer local — the audit-S2 "offline focus change reverts" fix.
    ...(() => {
      const lt = localMeta.userFocusUpdatedAt || "";
      const rt = remoteMeta.userFocusUpdatedAt || "";
      const remoteHas = remoteMeta.userFocus !== undefined && remoteMeta.userFocus !== null;
      const localHas  = localMeta.userFocus !== undefined && localMeta.userFocus !== null;
      if (remoteHas && (!localHas || rt >= lt)) {
        return { userFocus: remoteMeta.userFocus, userFocusUpdatedAt: rt || null };
      }
      if (localHas) return { userFocus: localMeta.userFocus, userFocusUpdatedAt: lt || null };
      return { userFocus: null, userFocusUpdatedAt: null };
    })(),
    days: mergeDayEntries(localMeta.days, remoteMeta.days),
    bodyweightLog: mergeBwLog(localMeta.bodyweightLog, remoteMeta.bodyweightLog),
    bodyweight: (() => {
      const rb = remoteMeta.bodyweight, lb = localMeta.bodyweight;
      if (!rb) return lb ?? null;
      if (!lb) return rb;
      const rt = new Date(rb.updatedAt || 0).getTime();
      const lt = new Date(lb.updatedAt || 0).getTime();
      return rt >= lt ? rb : lb;
    })(),
    trainingState: (() => {
      const rt = remoteMeta.trainingState, lt = localMeta.trainingState;
      const richness = (s) =>
        (s?.lifts ? Object.keys(s.lifts).length : 0) +
        (s?.muscleAnchors ? Object.keys(s.muscleAnchors).length : 0);
      const rRich = richness(rt) > 0, lRich = richness(lt) > 0;
      if (rRich && lRich) {
        // Both real: newer updatedAt wins WHOLESALE (the engine's state is
        // internally consistent per write — splicing two states would not
        // be). Missing stamp = epoch → unstamped remote wins the tie,
        // preserving legacy behaviour; a STAMPED newer local survives the
        // pull — the audit-S2 "offline training regresses" fix.
        const rs = rt.updatedAt || "";
        const ls = lt.updatedAt || "";
        return rs >= ls ? rt : lt;
      }
      if (rRich) return rt;
      if (lRich) return lt;
      return rt ?? lt ?? null;
    })(),
    breaks: mergeBreaks(localMeta.breaks, remoteMeta.breaks),
    displayName: remoteMeta.displayName || localMeta.displayName,
  };
}

/**
 * Full profile merge — meta + history + change detection. Client-side
 * convention: local = this device, remote = blob.
 */
export function mergeProfileData(local, remote) {
  const localMeta = local.meta || {};
  const remoteMeta = remote.meta || {};
  const localHistory = local.history || [];
  const remoteHistory = remote.history || [];

  const mergedMeta = mergeMeta(localMeta, remoteMeta);
  const mergedHistory = mergeHistories(localHistory, remoteHistory);

  // Change detection (audit S4): the old length/key-count heuristic missed
  // every meta-only change (a day tick, a schedule edit, a resolved
  // breather), so pulls landed in localStorage without the UI hearing and
  // meta-only local changes were never pushed back. Stable deep-compare of
  // the merged result against each side is exact and future-proof: any
  // field a side didn't already have marks the other as "had more".
  // Each side is self-normalised through the same merge (mergeMeta(x, x)
  // is idempotent) so absent-vs-null field noise can't fake a difference —
  // only real data marks a side as having had more.
  // displayName is SERVER-managed identity (written at claim), never part
  // of the client snapshot — leaving it in the keying made every pull read
  // as "remote had more" forever (audit #15: perpetual re-persist churn).
  // Excluded from detection only; it still merges into mergedMeta above.
  const detectKey = (m, h) => {
    const { displayName, ...rest } = m || {};
    return stableStringify({ m: rest, h });
  };
  const mergedKey = detectKey(mergedMeta, mergedHistory);
  const remoteHadMore = mergedKey !==
    detectKey(mergeMeta(localMeta, localMeta), mergeHistories(localHistory, localHistory));
  const localHadMore = mergedKey !==
    detectKey(mergeMeta(remoteMeta, remoteMeta), mergeHistories(remoteHistory, remoteHistory));

  return { meta: mergedMeta, history: mergedHistory, remoteHadMore, localHadMore };
}

// Key-sorted JSON — object key insertion order must not fake a difference.
export function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted = {};
      for (const key of Object.keys(v).sort()) sorted[key] = v[key];
      return sorted;
    }
    return v;
  });
}
