// @ts-check
// lib/origin.js
// ─────────────────────────────────────────────────────────────────────────────
// Origin recognition for the Heatwayve flip (docs/heatwayve-flip.md). The
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
export const FLIP_DATE = null; // ISO "YYYY-MM-DD"
export const MIGRATION_WINDOW_DAYS = 60;

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
