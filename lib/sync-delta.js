// @ts-check
// lib/sync-delta.js
// ─────────────────────────────────────────────────────────────────────────────
// Client-side delta bookkeeping (#2 family — docs/delta-sync.md, PR B).
//
// Two tiny per-profile stores:
//   forge:<p>:syncCursor     — the server timestamp of the last PULL. Only
//                              pulls advance it (a push response's cursor
//                              predates our own write; adopting it could
//                              skip a concurrent device's earlier write).
//   forge:<p>:syncPushState  — { fieldHashes: {field: hash}, lastRecordId }.
//                              What the server already has, so a push can
//                              diff instead of shipping the world.
//
// The diff NEVER builds payloads — it only decides WHICH fields of the ONE
// payload builder's output (getLocalProfile) get shipped. Hand-rolled
// subsets are the #1/S1 bug class; this keeps the single-source rule.
//
// Records are append-only with ISO ids. TWO different orderings live on a
// record and conflating them cost us a P0 (deep audit 2026-07-26):
//
//   · id       — the RECORD ordering key. Where this session sits in your
//                training history, so for a retro log it is anchored to the
//                DATE TRAINED, not the moment it was typed in.
//   · pushKey  — the PUSH ordering key. When THIS DEVICE created the row.
//
// They coincide for live sessions (the id IS the creation instant) and
// diverge for retro ones. The watermark is about "what has this device
// already sent", so it must use pushKey. The old code used the raw id, so a
// session logged for last Tuesday sorted BELOW a watermark set by today's
// workout and was silently never pushed — for good. The header here used to
// assert the opposite ("retro-logged sessions still mint now() ids and are
// never missed"), and that false invariant is what hid the bug.
// ─────────────────────────────────────────────────────────────────────────────

import { stableStringify } from "./sync-merge.js";

const LSget = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
};
const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota — delta degrades to fat push */ } };

// djb2 over the stable serialisation — collision risk is irrelevant here
// (a false "unchanged" self-heals on the next mutation of that field; a
// false "changed" is one redundant field on the wire).
export function hashValue(value) {
  const s = stableStringify(value);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

/**
 * The PUSH-ordering key: when this device created the row.
 *
 * `loggedAt` is stamped only on retro records (the moment the user actually
 * typed it in); live records have none, so they fall back to `id`, which for
 * them IS the creation instant. max() rather than `loggedAt ?? id` so a
 * malformed or backdated loggedAt can never drag the key BACKWARDS and
 * re-strand a record below the watermark.
 * @param {{id?: string, loggedAt?: string}} r
 */
export function pushKey(r) {
  const id = r?.id || "";
  const logged = r?.loggedAt || "";
  return logged > id ? logged : id;
}

// Bumped when the watermark's MEANING changes. v2 (2026-07-26) switched it
// from raw id to pushKey. Devices carrying a v1 watermark may hold retro
// records that the old code silently never pushed; those records are still
// in local history, so one full push per device recovers them. Without this,
// the fix would only protect FUTURE retro logs and quietly leave the
// already-lost ones stranded on the device that made them.
export const PUSH_STATE_VERSION = 2;

/** True when this device's push-state predates the pushKey watermark and
 *  therefore needs one reconciling full push. */
export function needsReconcile(pushState) {
  return (pushState?.v || 1) < PUSH_STATE_VERSION;
}

export const DeltaSync = {
  cursorKey: (profile) => `forge:${profile}:syncCursor`,
  pushStateKey: (profile) => `forge:${profile}:syncPushState`,

  getCursor: (profile) => (profile ? LSget(DeltaSync.cursorKey(profile), null) : null),
  // Pulls only — see header.
  setCursor: (profile, cursor) => { if (profile && typeof cursor === "string" && cursor) LSset(DeltaSync.cursorKey(profile), cursor); },
  clearCursor: (profile) => { try { localStorage.removeItem(DeltaSync.cursorKey(profile)); } catch {} },

  getPushState: (profile) => LSget(DeltaSync.pushStateKey(profile), { fieldHashes: {}, lastRecordId: "" }),

  /** Which meta fields changed since the last acknowledged push, plus the
   *  hashes to commit if this push succeeds. displayName never ships — it
   *  is server-managed identity (audit #15). */
  diffMeta: (meta, fieldHashes) => {
    const dirty = {};
    const newHashes = {};
    for (const [field, value] of Object.entries(meta || {})) {
      if (value === undefined || field === "displayName") continue;
      const h = hashValue(value);
      newHashes[field] = h;
      if (fieldHashes?.[field] !== h) dirty[field] = value;
    }
    return { dirty, newHashes };
  },

  /** Records this device has not yet pushed (ISO strings order lexically).
   *  Keyed on pushKey, NEVER the raw id — see the header. */
  newRecords: (history, lastRecordId) =>
    (Array.isArray(history) ? history : []).filter(
      (r) => r?.id && pushKey(r) > (lastRecordId || ""),
    ),

  /** Acknowledge a successful push of `data` (delta OR full — a full push
   *  also brings the server current, so both commit the same way). */
  commitPushState: (profile, { meta, history }) => {
    if (!profile) return;
    const prior = DeltaSync.getPushState(profile);
    const { newHashes } = DeltaSync.diffMeta(meta, {});
    let lastRecordId = prior.lastRecordId || "";
    for (const r of Array.isArray(history) ? history : []) {
      if (r?.id && pushKey(r) > lastRecordId) lastRecordId = pushKey(r);
    }
    LSset(DeltaSync.pushStateKey(profile), {
      fieldHashes: { ...prior.fieldHashes, ...newHashes },
      lastRecordId,
      // Schema marker. Bumping it makes needsReconcile() true once per
      // device, which forces ONE full push — see below.
      v: PUSH_STATE_VERSION,
    });
  },
};
