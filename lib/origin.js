// @ts-check
// lib/origin.js
// ─────────────────────────────────────────────────────────────────────────────
// Origin recognition for the Heatwayve flip (docs/heatwayve-flip.md). The
// dormant-UX pattern: migration-aware surfaces are BUILT and shipped before
// the flip, gated on this predicate, so they sleep on theforged.fit and
// wake by themselves the moment the primary domain moves. Flip day reviews
// nothing under pressure — it watches pre-reviewed code come alive.
// ─────────────────────────────────────────────────────────────────────────────

export const HEATWAYVE_HOSTS = new Set(["heatwayve.app", "www.heatwayve.app"]);

/** True when running on the post-flip origin. SSR-safe (false on server). */
export function isHeatwayveOrigin(
  hostname = typeof location !== "undefined" ? location.hostname : "",
) {
  return HEATWAYVE_HOSTS.has(String(hostname || "").toLowerCase());
}
