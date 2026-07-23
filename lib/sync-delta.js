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
// Records are append-only with creation-instant ISO ids ("an ordering key,
// not a date"), so "new since last push" is simply id > lastRecordId —
// retro-logged sessions still mint now() ids and are never missed.
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

  /** Records newer than the last acknowledged push (ISO ids order lexically). */
  newRecords: (history, lastRecordId) =>
    (Array.isArray(history) ? history : []).filter((r) => r?.id && r.id > (lastRecordId || "")),

  /** Acknowledge a successful push of `data` (delta OR full — a full push
   *  also brings the server current, so both commit the same way). */
  commitPushState: (profile, { meta, history }) => {
    if (!profile) return;
    const prior = DeltaSync.getPushState(profile);
    const { newHashes } = DeltaSync.diffMeta(meta, {});
    let lastRecordId = prior.lastRecordId || "";
    for (const r of Array.isArray(history) ? history : []) {
      if (r?.id && r.id > lastRecordId) lastRecordId = r.id;
    }
    LSset(DeltaSync.pushStateKey(profile), {
      fieldHashes: { ...prior.fieldHashes, ...newHashes },
      lastRecordId,
    });
  },
};
