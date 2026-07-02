// @ts-check
// lib/profile-actions.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure (non-React) cores of the profile actions, extracted from ForgeApp so
// the /profile route and ForgeApp's in-place gate share ONE implementation
// (PR3 3d-route, storage-as-store decision — see docs/decomposition-map.md).
//
// The React halves stay with their hosts: ForgeApp wraps these with setState
// calls for the in-place path; the /profile route calls them then navigates
// home, where ForgeApp re-hydrates from localStorage naturally (local is
// canonical — the shared-state layer IS the storage).
// ─────────────────────────────────────────────────────────────────────────────

import { LS, P, F, PB, claimProfile, pushNow } from "./storage.js";
import { rotateAccessories, rotationDiff, computeRotationStimulusDelta } from "./programme.js";

/**
 * Activate a profile: validate → (optionally) claim → persist as active.
 * No React state — callers reflect the result themselves (ForgeApp via
 * setState; the /profile route via navigation + remount hydration).
 *
 * @param {string} name
 * @param {{claim?: boolean}} [opts]
 * @returns {Promise<{ok: true, name: string} | {ok: false, reason: "empty"|"taken"|"network"}>}
 */
export async function activateProfileCore(name, { claim = false } = {}) {
  const trimmed = String(name).trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // Claim path: first-time signup for a new name. The claim endpoint is
  // atomic — if someone else grabbed the name between the availability
  // check and now, we get a 409 here.
  if (claim) {
    const result = await claimProfile(trimmed, trimmed);
    if (result.taken) return { ok: false, reason: "taken" };
    if (!result.ok)   return { ok: false, reason: "network" };
  }

  P.add(trimmed);
  P.setActive(trimmed);
  return { ok: true, name: trimmed };
}

/**
 * Save a training focus and re-rotate accessories within the current block
 * (history untouched, so future blocks keep the 3-block exclusion memory).
 * Persists F + PB and pushes the snapshot; returns the rotation summary so
 * the caller can surface "what changed".
 *
 * @param {string} profile
 * @param {string} focus
 * @returns {{next: object, summary: {blockNumber: number, changes: any, stimulusDelta: any}}}
 */
export function saveFocusCore(profile, focus) {
  F.save(profile, focus);
  const pb = PB.get();
  const oldConfig = pb.config;
  const newConfig = rotateAccessories(pb.history, { focus });
  const next = { ...pb, config: newConfig };
  PB.save(next);
  const summary = {
    blockNumber: pb.number,
    changes: rotationDiff(oldConfig, newConfig),
    stimulusDelta: computeRotationStimulusDelta(oldConfig, newConfig),
  };
  pushNow(profile);
  return { next, summary };
}

// One-shot handoff for the rotation summary when focus is changed on the
// /profile route: the "here's what changed" modal lives on the home shell,
// which isn't mounted at that moment. The route stashes the summary here;
// ForgeApp's seed effect takes (reads + clears) it on the next mount and
// shows the modal. DEVICE-LOCAL by design (transient UI feedback, safe to
// lose on reinstall — the underlying F/PB changes are SYNCED separately).
const pendingSummaryKey = (profile) => `forge:${profile}:pendingRotationSummary`;

export function stashRotationSummary(profile, summary) {
  if (!profile || !summary) return;
  LS.set(pendingSummaryKey(profile), summary);
}

export function takePendingRotationSummary(profile) {
  if (!profile) return null;
  const summary = LS.get(pendingSummaryKey(profile), null);
  if (summary) LS.remove(pendingSummaryKey(profile));
  return summary;
}
