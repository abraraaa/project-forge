// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/sync-delta.js
// ─────────────────────────────────────────────────────────────────────────────
// Client-side delta bookkeeping. Two small per-profile stores track what the
// server already has, so a push can diff instead of shipping everything.
//
// INVARIANTS — do not change these without reading tests/sync-delta.test.js:
//   · Only PULLS advance the cursor. Never adopt a cursor from a push response.
//   · The diff decides WHICH fields of getLocalProfile()'s output ship. It
//     never builds a payload itself; hand-rolled subsets are a known bug class.
//   · Push ordering uses pushKey, NEVER the raw record id. The two diverge for
//     retro-logged records, and using id there loses them silently.
// ─────────────────────────────────────────────────────────────────────────────

import { stableStringify } from "./sync-merge.js";

const LSget = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
};
const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota — delta degrades to fat push */ } };

// djb2 over the stable serialisation. Collisions are tolerable here: either
// outcome self-corrects on the next mutation.
export function hashValue(value) {
  const s = stableStringify(value);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

/**
  * The push-ordering key. max() rather than a fallback, so a malformed value
  * can never drag the key backwards.
  * @param {{id?: string, loggedAt?: string}} r
  */
export function pushKey(r) {
  const id = r?.id || "";
  const logged = r?.loggedAt || "";
  return logged > id ? logged : id;
}

// Bump when the watermark's meaning changes. Each bump costs every device one
// reconciling full push, which is what repairs state written under the old
// meaning. Do not bump casually, and do not skip it when the meaning moves.
export const PUSH_STATE_VERSION = 2;

/** True when this device's push-state predates the current version and needs
  *  one reconciling full push. */
export function needsReconcile(pushState) {
  return (pushState?.v || 1) < PUSH_STATE_VERSION;
}

export const DeltaSync = {
  cursorKey: (profile) => `forge:${profile}:syncCursor`,
  pushStateKey: (profile) => `forge:${profile}:syncPushState`,

  getCursor: (profile) => (profile ? LSget(DeltaSync.cursorKey(profile), null) : null),
  // Pulls only — see header invariants.
  setCursor: (profile, cursor) => { if (profile && typeof cursor === "string" && cursor) LSset(DeltaSync.cursorKey(profile), cursor); },
  clearCursor: (profile) => { try { localStorage.removeItem(DeltaSync.cursorKey(profile)); } catch {} },

  getPushState: (profile) => LSget(DeltaSync.pushStateKey(profile), { fieldHashes: {}, lastRecordId: "" }),

  /** Meta fields changed since the last acknowledged push, plus the hashes to
   *  commit on success. displayName never ships — it is server-managed. */
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

  /** Records this device has not yet pushed. Keyed on pushKey, never the raw
   *  id — see the header invariants. */
  newRecords: (history, lastRecordId) =>
    (Array.isArray(history) ? history : []).filter(
      (r) => r?.id && pushKey(r) > (lastRecordId || ""),
    ),

  /** Acknowledge a successful push. Delta and full commit identically. */
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
      // Schema marker — see PUSH_STATE_VERSION.
      v: PUSH_STATE_VERSION,
    });
  },
};
