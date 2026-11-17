// @ts-check
// lib/origin.js
// ─────────────────────────────────────────────────────────────────────────────
// The relying-party ids passkeys are scoped to, and the day the app moved
// from theforged.fit to heatwayve.app. Ceremonies verify against the native
// rpId only. A credential minted on the old domain keeps its rpId for life
// (it cannot be rewritten server-side), so it stays on file and is never
// usable: its holder sets up a new passkey through the ordinary flow.
// ─────────────────────────────────────────────────────────────────────────────

// The census splits credentials minted before and after this day.
export const FLIP_DATE = "2026-07-26";

export const NATIVE_RP_ID = "heatwayve.app";
export const LEGACY_RP_ID = "theforged.fit";

/** rpIds a ceremony may verify against. */
export function acceptedRpIds() {
  return [NATIVE_RP_ID];
}
