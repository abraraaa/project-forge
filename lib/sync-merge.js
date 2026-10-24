// @ts-check
// lib/sync-merge.js
// ─────────────────────────────────────────────────────────────────────────────
// THE merge. One implementation of every cross-device merge rule, imported by
// BOTH the client sync layer and the server write path.
//
// INVARIANTS — do not change these without reading tests/sync-merge.test.js:
//   · This module stays PURE — no localStorage, no fetch, no window. It has
//     to run on the server; that is the whole point of it existing.
//   · Both sides must import it. A second merge implementation anywhere means
//     one side can clobber the other, which is the class this replaced.
//   · Values that change IN PLACE resolve by stamp, newer wins. A missing
//     stamp reads as epoch. EQUAL stamps are broken by content (the greater
//     stableStringify), never by which side a value arrived on: the result
//     must not depend on the order writes land in (tests/sync-merge-order).
//   · Append-only or already-keyed stores need no stamps: union IS the merge.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_WEEK_TYPES = new Set(["strength", "zone2", "cardio", "hiit", "rest"]);
const POSITION_INITIAL = ["M", "T", "W", "T", "F", "S", "S"];
// A day's default label, by type. Exported for the trainer's day labels.
export const TYPE_LABEL = Object.freeze({
  strength: "Strength", zone2: "Zone 2", cardio: "Cardio", hiit: "HIIT", rest: "Rest",
});
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const content = (v) => stableStringify(v) ?? "";

// THE register rule: true when `a` beats `b`. The newer stamp wins; equal (or
// incomparable) stamps fall to content, the greater stableStringify winning.
// One total order, so a merge built on it is commutative and associative.
function firstWins(a, aStamp, b, bStamp) {
  if (aStamp > bStamp) return true;
  if (bStamp > aStamp) return false;
  return content(a) >= content(b);
}

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

// The schedule in force on `iso`: the LATEST-EDITED entry whose effectiveFrom
// ≤ iso. A save replaces the plan from its effectiveFrom onward, so an older
// edit dated later (a mid-week save from before edits applied from Monday, or
// a peer's collapsed entry resurrected by the union below) can't outrank it.
// Read-time only; the log itself is never rewritten.
/**
 * @param {any[] | null} history  normalised log (ensureScheduleHistory)
 * @param {string} iso
 */
export function scheduleEntryOn(history, iso) {
  let best = null;
  for (const e of history || []) {
    if (e.effectiveFrom > iso) continue;
    if (!best || e.editedAt > best.editedAt ||
       (e.editedAt === best.editedAt && e.effectiveFrom > best.effectiveFrom)) best = e;
  }
  return best;
}

// Union by editedAt — each edit is a fact; concurrent edits on two devices
// produce two entries. Two entries at one editedAt: the greater content wins.
export function mergeScheduleHistory(localUserWeek, remoteUserWeek) {
  const localArr  = ensureScheduleHistory(localUserWeek)  || [];
  const remoteArr = ensureScheduleHistory(remoteUserWeek) || [];
  if (localArr.length === 0 && remoteArr.length === 0) return null;
  const byEditedAt = new Map();
  for (const e of [...localArr, ...remoteArr]) {
    const prior = byEditedAt.get(e.editedAt);
    if (!prior || content(e) > content(prior)) byEditedAt.set(e.editedAt, e);
  }
  return [...byEditedAt.values()].sort((a, b) => a.editedAt.localeCompare(b.editedAt));
}

// Union by id (confirmation timestamp — a fact). For a shared id, a resolved
// endedAt beats an open one; two resolutions collapse to the EARLIER. Any
// other field the two copies disagree on goes to the greater content, so the
// result does not depend on which copy arrived second.
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
    const next = { ...prior };
    for (const [k, v] of Object.entries(b)) {
      if (!(k in next) || content(v) > content(next[k])) next[k] = v;
    }
    byId.set(b.id, { ...next, endedAt });
  }
  return Array.from(byId.values()).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// Day entries carry a stamp per field: stamps[k] is when field k was last
// written (Days.set). These keys are the entry's own bookkeeping, not fields.
const DAY_META_KEYS = new Set(["date", "updatedAt", "marks", "stamps"]);
const DAY_FIELDS = ["scheduledType", "completedType", "sessionId"];
const plainObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

// The stamp each non-null field of a day entry reads at: its own stamps[k],
// else the entry's updatedAt — so an entry from before per-field stamps reads
// every field as written at its updatedAt, and stored data needs no
// migration. An entry with no updatedAt reads at epoch, a real (losing) stamp
// that the merge then stores, so a later merge cannot promote it to the
// merged updatedAt. Null fields carry no stamp: null is "nothing written".
const EPOCH = "1970-01-01T00:00:00.000Z";
/** @param {any} entry @returns {Record<string, string>} */
export function dayFieldStamps(entry) {
  /** @type {Record<string, string>} */
  const out = {};
  const e = plainObject(entry);
  if (!e) return out;
  const own = plainObject(e.stamps) || {};
  const at = typeof e.updatedAt === "string" && e.updatedAt ? e.updatedAt : EPOCH;
  for (const [k, v] of Object.entries(e)) {
    if (DAY_META_KEYS.has(k) || v === null || v === undefined) continue;
    out[k] = typeof own[k] === "string" && own[k] ? own[k] : at;
  }
  return out;
}

// The stamps a day entry stores: only those that differ from its updatedAt
// (the rest are implied by it), and no stamps key when none do — so an entry
// whose fields were all written at once keeps the plain shape.
/** @param {Record<string, string>} stamps @param {string} [updatedAt] */
export function explicitDayStamps(stamps, updatedAt) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, s] of Object.entries(stamps)) if (s !== updatedAt) out[k] = s;
  return Object.keys(out).length ? out : null;
}

// One date, two entries (or one entry with itself: the normal form). Per
// field, the non-null value with the newer stamp wins (equal stamps: content);
// null never beats a value. Marks are a grow-only union. updatedAt is the max.
function mergeDayEntry(x, y) {
  const a = plainObject(x) || {}, b = plainObject(y) || {};
  const sa = dayFieldStamps(a), sb = dayFieldStamps(b);
  /** @type {Record<string, any>} */
  const out = {};
  const dates = [a.date, b.date].filter((d) => d !== undefined).map(String).sort();
  if (dates.length) out.date = dates[dates.length - 1];
  /** @type {Record<string, string>} */
  const stamps = {};
  const keys = new Set([...DAY_FIELDS, ...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (DAY_META_KEYS.has(k)) continue;
    const av = a[k] ?? null, bv = b[k] ?? null;
    const useA = av !== null && (bv === null || firstWins(av, sa[k], bv, sb[k]));
    out[k] = useA ? av : bv;
    if (out[k] !== null) stamps[k] = useA ? sa[k] : sb[k];
  }
  const am = plainObject(a.marks) || {}, bm = plainObject(b.marks) || {};
  const marks = {};
  for (const k of new Set([...Object.keys(am), ...Object.keys(bm)])) {
    if (!(k in bm)) marks[k] = am[k];
    else if (!(k in am)) marks[k] = bm[k];
    // A set mark beats an unset one; two set marks fall to content.
    else if (!!am[k] !== !!bm[k]) marks[k] = am[k] ? am[k] : bm[k];
    else marks[k] = content(am[k]) >= content(bm[k]) ? am[k] : bm[k];
  }
  out.marks = marks;
  const ua = typeof a.updatedAt === "string" ? a.updatedAt : "";
  const ub = typeof b.updatedAt === "string" ? b.updatedAt : "";
  if (ua || ub) out.updatedAt = ua > ub ? ua : ub;
  const explicit = explicitDayStamps(stamps, out.updatedAt);
  if (explicit) out.stamps = explicit;
  return out;
}

// Per-date merge by field stamp (mergeDayEntry). Nothing un-completes or
// un-marks a day, so a null never needs to win. Normalises on EVERY path, not
// just the conflict path: the merge must be idempotent (mergeX(x, x) ===
// normalised x) or the exact change detection in mergeProfileData reads
// shape noise as data.
export function mergeDayEntries(localDays, remoteDays) {
  const l = plainObject(localDays) || {};
  const r = plainObject(remoteDays) || {};
  const out = {};
  for (const date of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const a = l[date], b = r[date];
    out[date] = mergeDayEntry(a ?? b, b ?? a);
  }
  return out;
}

// ─── Delta sync (#2 family) ─────────────────
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
  mainLifts: ["mainLiftStamps"],
  mainLiftStamps: ["mainLifts"],
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
    out[date] = firstWins(b, b.updatedAt || "", a, a.updatedAt || "") ? b : a;
  }
  return out;
}

// Added load on pure bodyweight lifts: { [liftName]: { kg, updatedAt } }.
// Union of lifts; per lift the newer updatedAt wins the whole entry, ties to
// content, missing stamp = epoch. Must stay a pure union: kg 0 ("none") is a
// value, and no key may ever be dropped here — a dropped key is a delete.
export function mergeAddedLoads(localMap, remoteMap) {
  const l = (localMap && typeof localMap === "object" && !Array.isArray(localMap)) ? localMap : {};
  const r = (remoteMap && typeof remoteMap === "object" && !Array.isArray(remoteMap)) ? remoteMap : {};
  const out = {};
  for (const lift of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const a = l[lift], b = r[lift];
    if (!a) { out[lift] = b; continue; }
    if (!b) { out[lift] = a; continue; }
    out[lift] = firstWins(b, b.updatedAt || "", a, a.updatedAt || "") ? b : a;
  }
  return out;
}

// programmeBlock: higher block number wins wholesale (a rotation happened).
// EQUAL numbers = two devices mutated the same block (re-pick race, a
// concurrent rotation, a reset): the config of the newer updatedAt wins (equal
// stamps: content of the block outside its history), and the per-slot
// exclusion memory merges without loss. history[slot] is a map
// { name: stamp }, merged per name by the max stamp; the reader takes the
// three newest (lib/programme.js recentNamesFor). An array or single-string
// slot from older data reads as names stamped at the block's updatedAt.
//
// "Cleared" is a stamp, never an absence: a block whose history has no slots
// at all (PB.reset writes {}) reads as cleared at its updatedAt, and the merge
// keeps only names stamped after the latest clear it has seen. That cut rides
// on the merged block as historyClearedAt when the block itself no longer
// implies it, so a stale copy merged later can't bring cleared names back.
function blockMemory(b) {
  const at = typeof b.updatedAt === "string" ? b.updatedAt : "";
  const raw = plainObject(b.history) || {};
  /** @type {Record<string, Record<string, string>>} */
  const slots = {};
  for (const [slot, v] of Object.entries(raw)) {
    /** @type {Record<string, string>} */
    const names = {};
    if (Array.isArray(v)) { for (const n of v) if (typeof n === "string") names[n] = at; }
    else if (typeof v === "string") names[v] = at;
    else if (plainObject(v)) for (const [n, s] of Object.entries(v)) names[n] = typeof s === "string" ? s : "";
    slots[slot] = names;
  }
  const own = typeof b.historyClearedAt === "string" ? b.historyClearedAt : "";
  const implied = Object.keys(slots).length === 0 ? at : "";
  return { slots, cut: own > implied ? own : implied };
}

function mergeSameBlock(l, r) {
  const L = blockMemory(l), R = blockMemory(r);
  const cut = L.cut > R.cut ? L.cut : R.cut;
  /** @type {Record<string, Record<string, string>>} */
  const history = {};
  for (const slot of new Set([...Object.keys(L.slots), ...Object.keys(R.slots)])) {
    /** @type {Record<string, string>} */
    const names = {};
    for (const side of [L.slots[slot] || {}, R.slots[slot] || {}]) {
      for (const [n, s] of Object.entries(side)) {
        if ((cut === "" || s > cut) && !(names[n] >= s)) names[n] = s;
      }
    }
    history[slot] = names;
  }
  const rest = (b) => {
    const { history: _h, historyClearedAt: _c, ...others } = b;
    return others;
  };
  const lr = rest(l), rr = rest(r);
  const winner = firstWins(rr, rr.updatedAt || "", lr, lr.updatedAt || "") ? rr : lr;
  const out = { ...winner, history };
  const implied = Object.keys(history).length === 0 && typeof winner.updatedAt === "string" ? winner.updatedAt : "";
  if (cut && cut !== implied) out.historyClearedAt = cut;
  return out;
}

export function mergeProgrammeBlock(l, r) {
  const a = plainObject(l), b = plainObject(r);
  // Normalised on every path (a block merged with itself is its normal form),
  // so a block that lands twice changes nothing the second time.
  if (!a) return b ? mergeSameBlock(b, b) : (r ?? null);
  if (!b) return mergeSameBlock(a, a);
  const ln = a.number || 0, rn = b.number || 0;
  if (rn > ln) return mergeSameBlock(b, b);
  if (ln > rn) return mergeSameBlock(a, a);
  return mergeSameBlock(a, b);
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
// ties go to content (firstWins). null is a value (an unset): it wins or loses by
// its stamp like a number and is carried, never dropped — keys are read
// with `in`, so a null entry still counts as present.
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
    if (firstWins(remoteMap[key], rt, localMap[key], lt)) { merged[key] = remoteMap[key]; if (rt) stamps[key] = rt; }
    else { merged[key] = localMap[key]; if (lt) stamps[key] = lt; }
  }
  return { merged, stamps };
}

/**
 * Merge two meta documents. Direction convention: `remote` is the blob on the
 * CLIENT and the incoming push on the SERVER. Ties no longer depend on it
 * (firstWins); only displayName, which the server manages, still prefers
 * remote.
 */
// Every key mergeMeta rules on explicitly. Anything OUTSIDE this set is an
// UNKNOWN field — see the passthrough below.
const MERGE_RULED_KEYS = new Set([
  "weights", "weightStamps", "reps", "repStamps", "streak", "programmeBlock",
  "userWeek", "userFocus", "userFocusUpdatedAt", "days", "bodyweightLog",
  "bodyweight", "trainingState", "breaks", "displayName", "syncedAt", "claimedAt",
  "mainLifts", "mainLiftStamps", "addedLoads",
]);

export function mergeMeta(localMeta = {}, remoteMeta = {}) {
  const w = mergeStampedMap(localMeta.weights, remoteMeta.weights,
    localMeta.weightStamps, remoteMeta.weightStamps);
  const r = mergeStampedMap(localMeta.reps, remoteMeta.reps,
    localMeta.repStamps, remoteMeta.repStamps);
  // Main lifts: per-lift stamps, newer wins (defaults are explicit entries,
  // so "back to Back Squat" is a newer value, not a missing key).
  const ml = mergeStampedMap(localMeta.mainLifts, remoteMeta.mainLifts,
    localMeta.mainLiftStamps, remoteMeta.mainLiftStamps);

  // Unknown-field passthrough (audit #8): the old behaviour DROPPED any
  // field without an explicit rule — a client one release ahead lost its
  // new store on every round-trip through an older peer/server (exactly
  // how dayDone data died once). Unknowns now survive: union; where both
  // carry the field, the value whose own updatedAt (a string inside it) is
  // newer wins, else content (new fields should ship that stamp and
  // graduate to an explicit rule, like bodyweightLog and addedLoads did).
  const ownStamp = (v) => (v && typeof v === "object" && typeof v.updatedAt === "string" ? v.updatedAt : "");
  /** @type {Record<string, any>} */
  const unknowns = {};
  for (const src of [localMeta, remoteMeta]) {
    for (const [k, v] of Object.entries(src || {})) {
      if (MERGE_RULED_KEYS.has(k) || v === undefined) continue;
      if (!(k in unknowns) || firstWins(v, ownStamp(v), unknowns[k], ownStamp(unknowns[k]))) unknowns[k] = v;
    }
  }

  return {
    ...unknowns,
    weights: w.merged,
    weightStamps: w.stamps,
    reps: r.merged,
    repStamps: r.stamps,
    // Only when a side carries it: an app that predates the field must not
    // turn "never synced" into an empty map ("programme defaults").
    ...((localMeta.mainLifts != null || remoteMeta.mainLifts != null)
      ? { mainLifts: ml.merged, mainLiftStamps: ml.stamps }
      : {}),
    // Streak (audit #18): higher count wins; EQUAL counts tie-break on the
    // LATER lastDate, then content — the old blanket remote-wins-ties let a
    // stale remote copy regress lastDate (train today, sync before push
    // lands → remote same-count-older-date won, breaking next-day continuity).
    streak: (() => {
      const l = localMeta.streak, r = remoteMeta.streak;
      const lc = l?.count || 0, rc = r?.count || 0;
      if (rc !== lc) return rc > lc ? r : l;
      const rd = r?.lastDate || "", ld = l?.lastDate || "";
      if (rd !== ld) return rd > ld ? r : l;
      // Same count and lastDate: content, not arrival side.
      if (!r || !l) return r || l;
      return firstWins(r, "", l, "") ? r : l;
    })(),
    programmeBlock: mergeProgrammeBlock(localMeta.programmeBlock, remoteMeta.programmeBlock),
    userWeek: mergeScheduleHistory(localMeta.userWeek, remoteMeta.userWeek),
    // Focus: newer stamp wins; missing stamp = epoch, so an unstamped value
    // can't beat a STAMPED newer one — the audit-S2 "offline focus change
    // reverts" fix. Equal stamps: content.
    ...(() => {
      const lt = localMeta.userFocusUpdatedAt || "";
      const rt = remoteMeta.userFocusUpdatedAt || "";
      const remoteHas = remoteMeta.userFocus !== undefined && remoteMeta.userFocus !== null;
      const localHas  = localMeta.userFocus !== undefined && localMeta.userFocus !== null;
      if (remoteHas && (!localHas || firstWins(remoteMeta.userFocus, rt, localMeta.userFocus, lt))) {
        return { userFocus: remoteMeta.userFocus, userFocusUpdatedAt: rt || null };
      }
      if (localHas) return { userFocus: localMeta.userFocus, userFocusUpdatedAt: lt || null };
      return { userFocus: null, userFocusUpdatedAt: null };
    })(),
    days: mergeDayEntries(localMeta.days, remoteMeta.days),
    bodyweightLog: mergeBwLog(localMeta.bodyweightLog, remoteMeta.bodyweightLog),
    // Optional added load on pure bodyweight lifts (mergeAddedLoads). Always
    // emitted, like the journal: absent and empty both mean "no vest".
    addedLoads: mergeAddedLoads(localMeta.addedLoads, remoteMeta.addedLoads),
    bodyweight: (() => {
      const rb = remoteMeta.bodyweight, lb = localMeta.bodyweight;
      if (!rb) return lb ?? null;
      if (!lb) return rb;
      const rt = new Date(rb.updatedAt || 0).getTime() || 0;
      const lt = new Date(lb.updatedAt || 0).getTime() || 0;
      return firstWins(rb, rt, lb, lt) ? rb : lb;
    })(),
    trainingState: (() => {
      const rt = remoteMeta.trainingState, lt = localMeta.trainingState;
      const richness = (s) =>
        (s?.lifts ? Object.keys(s.lifts).length : 0) +
        (s?.muscleAnchors ? Object.keys(s.muscleAnchors).length : 0);
      const rRich = richness(rt) > 0, lRich = richness(lt) > 0;
      // Both real (or both empty): newer updatedAt wins WHOLESALE (the
      // engine's state is internally consistent per write — splicing two
      // states would not be). Missing stamp = epoch, so a STAMPED newer local
      // survives the pull — the audit-S2 "offline training regresses" fix.
      // Equal stamps: content.
      if (rt && lt && rRich === lRich) {
        return firstWins(rt, rt.updatedAt || "", lt, lt.updatedAt || "") ? rt : lt;
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
