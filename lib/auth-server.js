// @ts-check
// lib/auth-server.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side WebAuthn/token helpers shared by the auth routes and the sync
// DELETE gate. The passkey layer's job is narrow and deliberate: it is an
// OPTIONAL lock on destructive operations, not an account system. There is no
// sensitive training data behind it — the point is simply that the lock, once
// a user sets it, actually latches. Before 2026-07-15 it did not: login-verify
// minted a token without checking the assertion signature, and login-options
// handed out the credential id needed to forge one. This module carries the
// pieces that make the lock real.
//
// DOCTRINE, load-bearing: a credential only COUNTS as protection if it can be
// cryptographically verified — i.e. it carries a stored `publicKey`. Legacy
// credentials written by the pre-verification code stored only an id + raw
// (unverified) attestation, never a usable key. Treating those as protection
// would lock their owners out (a signature can never be checked against them),
// so `hasRealPasskey` ignores them: `check` reports no passkey, the UI re-offers
// setup, and re-registration heals the profile into a verifiable credential.
// ─────────────────────────────────────────────────────────────────────────────

import { readJsonDirect } from "./blob-utils.js";

const normalise = (name) => String(name || "").trim().toLowerCase();

/**
 * Relying-Party config derived from the request host. `rpId` must be the
 * registrable domain the passkey was scoped to; `expectedOrigin` must equal
 * `clientDataJSON.origin` byte-for-byte. Prod is the real domain; localhost
 * keeps its port for dev. Preview (*.vercel.app) hosts are intentionally
 * unsupported — a platform passkey created there carries an rpId that can
 * never match theforged.fit, the same constraint that has always existed.
 * @param {Request} request
 * @returns {{ rpId: string, expectedOrigin: string }}
 */
export function rpConfigFromRequest(request) {
  const host = request.headers.get("host") || "";
  if (host.includes("localhost")) {
    return { rpId: "localhost", expectedOrigin: `http://${host}` };
  }
  return { rpId: "theforged.fit", expectedOrigin: "https://theforged.fit" };
}

/**
 * Pure predicate over a stored token blob. Fail-closed: any missing field,
 * expiry, or profile mismatch is a rejection.
 * @param {{ profile?: string, expires?: number } | null} tokenData
 * @param {string} profile
 * @param {number} now
 */
export function isTokenValid(tokenData, profile, now) {
  if (!tokenData || typeof tokenData !== "object") return false;
  if (typeof tokenData.expires !== "number" || now > tokenData.expires) return false;
  if (tokenData.profile !== normalise(profile)) return false;
  return true;
}

/**
 * Verify a mint-time auth token WITHOUT consuming it (registration gating and
 * the delete gate both read it; the delete path consumes on success). Tokens
 * are written at `forge/tokens/<token>` with no random suffix, so read direct.
 * Fail-closed: a read error reads as null → invalid.
 * @param {string} profile
 * @param {string | null | undefined} authToken
 * @returns {Promise<boolean>}
 */
export async function verifyAuthToken(profile, authToken) {
  if (!authToken) return false;
  const tokenData = await readJsonDirect(`forge/tokens/${encodeURIComponent(authToken)}`);
  return isTokenValid(tokenData, profile, Date.now());
}

/**
 * Whether a credentials document contains at least one VERIFIABLE credential
 * (one carrying a stored public key). Keyless legacy credentials do not count.
 * @param {{ credentials?: Array<{ publicKey?: string }> } | null} credData
 */
export function hasRealPasskey(credData) {
  return !!credData?.credentials?.some((c) => c && typeof c.publicKey === "string" && c.publicKey.length > 0);
}
