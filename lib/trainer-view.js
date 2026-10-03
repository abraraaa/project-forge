// @ts-check
// lib/trainer-view.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for what a trainer and their clients are shown of each other.
// ─────────────────────────────────────────────────────────────────────────────

import { normaliseProfile } from "./profile-name.js";

/**
 * The name a trainer or client is shown by: the display form of their live
 * primary handle when it normalises to that handle, otherwise the handle
 * itself. display is not bound to the handle at claim, so a crafted display
 * can never stand in for someone else's name. meta.displayName is never used.
 * @param {{ handle?: string | null, display?: string | null } | null | undefined} row  dbPrimaryHandle's result
 * @returns {string | null}
 */
export function publicName(row) {
  const handle = row?.handle;
  if (typeof handle !== "string" || !handle) return null;
  const display = row?.display;
  return typeof display === "string" && normaliseProfile(display) === handle ? display : handle;
}
