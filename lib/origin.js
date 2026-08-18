// @ts-check
// lib/origin.js
// ─────────────────────────────────────────────────────────────────────────────
// Origin recognition for the Heatwayve flip (flip package). The
// dormant-UX pattern: migration-aware surfaces are BUILT and shipped before
// the flip, gated on this predicate, so they sleep on theforged.fit and
// wake by themselves the moment the primary domain moves. Flip day reviews
// nothing under pressure — it watches pre-reviewed code come alive.
// ─────────────────────────────────────────────────────────────────────────────

import { parseLocalDate } from "./dates.js";

export const HEATWAYVE_HOSTS = new Set(["heatwayve.app", "www.heatwayve.app"]);

// Set by the rename-sweep PR ON FLIP DAY (runbook step 2). While null, every
// migration-voiced surface is double-locked off — even on the new origin.
// The window keeps the move's copy self-retiring: two months of warmth,
// then it's just history nobody narrates any more.
export const FLIP_DATE = "2026-07-26"; // ARMED flip day (was null pre-flip)
export const MIGRATION_WINDOW_DAYS = 60;

// ─── Passkey rpId migration (boss ruling, 2026-08-18) ────────────────────────
// Every credential minted before this work is scoped to rpId "theforged.fit",
// including ones created from heatwayve.app (legal via Related Origin
// Requests). An rpId is fixed at credential creation and cannot be rewritten
// server-side, so clearing the dependency is a RE-ENROLMENT, not a migration:
// each holder registers a fresh passkey under the native rpId.
//
// theforged.fit is not being renewed. After the sunset its credentials cannot
// complete a ceremony at all — the browser can no longer fetch the ROR
// document at the rpId origin — so they stop being protection whether or not
// anything is deleted. That is why the sunset needs no sweeper: it is a date
// and a predicate, and the stored records simply stop counting.
export const NATIVE_RP_ID = "heatwayve.app";
export const LEGACY_RP_ID = "theforged.fit";

// 90 days from the ruling. Passkeys minted from here on are native; holders of
// a legacy credential are prompted on login, quietly at first and then
// insistently for the final PASSKEY_NUDGE_DAYS.
export const PASSKEY_SUNSET = "2026-11-16";
export const PASSKEY_NUDGE_DAYS = 30;

/** True once the legacy rpId can no longer complete a ceremony. */
export function legacyRpRetired(now = Date.now(), sunset = PASSKEY_SUNSET) {
  if (!sunset) return false;
  return now >= parseLocalDate(sunset).getTime();
}

/** rpIds a ceremony may verify against right now. Ordered: native first. */
export function acceptedRpIds(now = Date.now(), sunset = PASSKEY_SUNSET) {
  return legacyRpRetired(now, sunset) ? [NATIVE_RP_ID] : [NATIVE_RP_ID, LEGACY_RP_ID];
}

/** True in the closing stretch, when the upgrade prompt stops being quiet. */
export function passkeyNudgeUrgent(now = Date.now(), sunset = PASSKEY_SUNSET) {
  if (!sunset || legacyRpRetired(now, sunset)) return false;
  return now >= parseLocalDate(sunset).getTime() - PASSKEY_NUDGE_DAYS * 86400000;
}

/** Whole days left before legacy credentials stop working (0 once retired). */
export function daysUntilPasskeySunset(now = Date.now(), sunset = PASSKEY_SUNSET) {
  if (!sunset) return Infinity;
  return Math.max(0, Math.ceil((parseLocalDate(sunset).getTime() - now) / 86400000));
}

/** True only between the flip and flip+window. Null flip date = never. */
export function migrationWindowOpen(now = Date.now(), flipDate = FLIP_DATE) {
  if (!flipDate) return false;
  const start = parseLocalDate(flipDate).getTime();
  return now >= start && now <= start + MIGRATION_WINDOW_DAYS * 86400000;
}

/** True when this history contains life from BEFORE the flip — the
 *  distinction between "Forge veteran arriving home" and "first-timer who
 *  never knew the old name" (boss catch, 2026-07-27: telling a stranger to
 *  add something BACK is gaslighting). */
export function hasPreFlipStory(history, flipDate = FLIP_DATE) {
  if (!flipDate || !Array.isArray(history)) return false;
  return history.some((r) => r?.date && r.date < flipDate);
}

/** True when running on the post-flip origin. SSR-safe (false on server). */
export function isHeatwayveOrigin(
  hostname = typeof location !== "undefined" ? location.hostname : "",
) {
  return HEATWAYVE_HOSTS.has(String(hostname || "").toLowerCase());
}
