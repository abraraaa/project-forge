// @ts-check
// lib/passkey-upgrade.js
// ─────────────────────────────────────────────────────────────────────────────
// Client-side state for the passkey re-enrolment prompt.
//
// A login that verified against the LEGACY rpId is the only moment we know for
// certain that a person is holding a credential which stops working at the
// sunset — the server says so in the login response, from what it
// cryptographically matched. That fact is recorded here, per profile, and two
// surfaces read it: a quiet standing notice on the profile page, and — only in
// the closing stretch — a modal.
//
// The prompt is deliberately not relentless. Losing your lock is worth
// interrupting for, but an unskippable wall on every app open teaches people to
// dismiss without reading, which is how a real warning gets missed. So: the
// notice never goes away while the need stands, and the modal rests for
// SNOOZE_DAYS after each dismissal.
// ─────────────────────────────────────────────────────────────────────────────

import { LS } from "./storage.js";
import { NATIVE_RP_ID } from "./origin.js";

const key = (profile) => `forge:${profile}:passkeyUpgrade`;

// Long enough not to nag, short enough to land several times inside the final
// thirty days.
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

/**
 * Clear the need. Called ONLY when a registration actually minted a native
 * credential — the server reports the rpId it verified, so this is never
 * inferred from "a registration happened".
 */
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
 * Whether the MODAL should show. The standing notice is governed by
 * readUpgradeNeed alone — it does not snooze, because a quiet line on a page
 * the user chose to open is not an interruption.
 * @param {UpgradeState | null} state
 */
export function shouldInterrupt(state, now = Date.now()) {
  if (!state?.needed || !state.urgent) return false;
  return !state.snoozedUntil || now >= state.snoozedUntil;
}
