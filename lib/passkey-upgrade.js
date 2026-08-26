// @ts-check
// lib/passkey-upgrade.js
// Per-profile state for the re-enrolment prompt. Recorded from the rpId the
// server verified at login. The notice stands while needed; the modal snoozes.

import { LS } from "./storage.js";
import { NATIVE_RP_ID } from "./origin.js";

const key = (profile) => `forge:${profile}:passkeyUpgrade`;

export const SNOOZE_DAYS = 3;

/**
 * @typedef {object} UpgradeState
 * @property {boolean} needed
 * @property {boolean} urgent    server's read at last login
 * @property {number} [daysLeft]
 * @property {string} [notedAt]
 * @property {number} [snoozedUntil]
 */

/** Record what the server reported on a successful login. */
export function recordUpgradeNeed(profile, upgrade) {
  if (!profile) return;
  if (!upgrade?.needed) return;
  const prev = readUpgradeNeed(profile);
  LS.set(key(profile), {
    ...prev,
    needed: true,
    urgent: !!upgrade.urgent,
    daysLeft: typeof upgrade.daysLeft === "number" ? upgrade.daysLeft : prev?.daysLeft,
    notedAt: new Date().toISOString(),
  });
}

/** @returns {UpgradeState | null} */
export function readUpgradeNeed(profile) {
  if (!profile) return null;
  const v = LS.get(key(profile), null);
  return v && v.needed ? v : null;
}

/** Clear the need. Only when the server confirms a NATIVE mint. */
export function clearUpgradeNeed(profile, mintedRpId) {
  if (!profile) return;
  if (mintedRpId && mintedRpId !== NATIVE_RP_ID) return;
  LS.remove(key(profile));
}

/** Rest the modal (not the standing notice) for SNOOZE_DAYS. */
export function snoozePrompt(profile, now = Date.now()) {
  const prev = readUpgradeNeed(profile);
  if (!prev) return;
  LS.set(key(profile), { ...prev, snoozedUntil: now + SNOOZE_DAYS * 86400000 });
}

/**
 * Whether the MODAL should show. The standing notice does not snooze.
 * @param {UpgradeState | null} state
 */
export function shouldInterrupt(state, now = Date.now()) {
  if (!state?.needed || !state.urgent) return false;
  return !state.snoozedUntil || now >= state.snoozedUntil;
}
