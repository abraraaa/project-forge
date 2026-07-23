// @ts-check
// lib/auth-session.js
// ─────────────────────────────────────────────────────────────────────────────
// In-memory auth-token session (boss call, 2026-07-21): one passkey ceremony
// per visit, not per action. Any successful ceremony caches its token for the
// token's server lifetime (1h, minus safety margin); photo flows reuse a live
// token and only run Face ID when none exists.
//
// DELIBERATELY memory-only. Never localStorage, never a cookie — a persisted
// plaintext token is exactly the "key thrown around" the house law bans. The
// cache dies with the tab; the trust model is unchanged, only the repetition.
// The wipe path does NOT use this cache — destructive ops keep their own
// fresh-ceremony semantics.
// ─────────────────────────────────────────────────────────────────────────────

import { authenticatePasskey } from "./webauthn.js";

const TTL_MS = 55 * 60 * 1000; // server mints 1h; refresh a little early
const _cache = new Map(); // normalised profile -> { token, expiresAt }

const norm = (p) => String(p || "").trim().toLowerCase();

/** Store a token minted elsewhere (e.g. sign-in) so later flows reuse it. */
export function cacheAuthToken(profile, token, { admin = false } = {}) {
  if (!profile || !token) return;
  _cache.set(norm(profile), { token, admin: !!admin, expiresAt: Date.now() + TTL_MS });
}

/** UI hint only — every admin surface re-verifies server-side. True when
 *  the live cached session for this profile was minted as the admin. */
export function isAdminSession(profile) {
  const hit = _cache.get(norm(profile));
  return !!(hit && Date.now() <= hit.expiresAt && hit.admin);
}

/** A live cached token, or null. */
export function getCachedAuthToken(profile) {
  const hit = _cache.get(norm(profile));
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { _cache.delete(norm(profile)); return null; }
  return hit.token;
}

/** Drop a profile's cached token (sign-out, wipe, 401 recovery). */
export function clearAuthToken(profile) {
  _cache.delete(norm(profile));
}

/**
 * The one call photo flows use: live cached token, or run the ceremony and
 * cache the result. Returns token string or null (cancelled/failed).
 */
export async function getAuthTokenWithCeremony(profile) {
  const cached = getCachedAuthToken(profile);
  if (cached) return cached;
  try {
    const auth = await authenticatePasskey(profile);
    if (auth?.verified && auth?.authToken) {
      cacheAuthToken(profile, auth.authToken, { admin: !!auth.admin });
      return auth.authToken;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Cookie-first photo access (2026-07-21): try the operation with whatever we
 * have — a cached token or nothing (the sliding 7-day httpOnly cookie rides the
 * request invisibly). Only if the server says requiresAuth do we run the
 * ceremony and retry. On most visits this means ZERO prompts.
 * @param {string} profile
 * @param {(token: string|null) => Promise<any>} probe  op returning {ok, requiresAuth?}
 */
export async function ensurePhotoAccess(profile, probe) {
  const cached = getCachedAuthToken(profile);
  const first = await probe(cached);
  if (first?.ok || !first?.requiresAuth) return { token: cached, result: first };
  const t = await getAuthTokenWithCeremony(profile);
  if (!t) return { token: null, result: first };
  return { token: t, result: await probe(t) };
}
