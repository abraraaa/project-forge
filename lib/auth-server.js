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

import crypto from "crypto";
import { readJsonDirect } from "./blob-utils.js";

const normalise = (name) => String(name || "").trim().toLowerCase();

// ─── Stateless WebAuthn challenges ───────────────────────────────────────────
// The challenge used to be stored at forge/challenges/<id> by the options route
// and read back by the verify route — a write→read round-trip across two
// serverless invocations through an EVENTUALLY-CONSISTENT blob store. On the
// first attempt the read could beat the write's propagation → the challenge
// read as null → "No pending authentication" (the recurring gremlin; the
// verify succeeded on the second try once the write had landed).
//
// A signed challenge removes the round-trip entirely: it is an HMAC-signed
// token — nonce + expiry + ceremony, bound to the profile via the HMAC input —
// verified by recomputing the HMAC. No storage, nothing to race, so the bug
// class is structurally impossible.
//
// TRADE, on the record (accepted 2026-07-15): a stored challenge was deleted on
// use (single-use); a signed challenge is replayable until it expires (~2 min).
// For an optional destructive-op gate with no sensitive data behind it, and
// with HTTPS protecting the assertion in transit, that window is an acceptable
// cost for killing the consistency bug. Strict single-use would need a used-
// nonce store, which drags the blob dependency back in.
//
// Rollout: gated on CHALLENGE_SECRET. Absent → the routes keep the blob path,
// so merging changes nothing; setting the var (operator-held, like CRON_SECRET)
// activates stateless mode on the next deploy. A ceremony straddling that one
// deploy just retries with a fresh challenge.
const CHALLENGE_TTL_MS = 120000; // 2 minutes — matches the prior blob TTL

export function hasChallengeSecret() {
  return typeof process.env.CHALLENGE_SECRET === "string" && process.env.CHALLENGE_SECRET.length > 0;
}

function challengeSig(nonceHex, expiry, ceremony, profile) {
  return crypto
    .createHmac("sha256", String(process.env.CHALLENGE_SECRET || ""))
    .update(`${nonceHex}.${expiry}.${ceremony}.${normalise(profile)}`)
    .digest("base64url");
}

/**
 * Issue a signed, stateless challenge for a ceremony ("reg" | "auth"). Only
 * meaningful when hasChallengeSecret() is true. The returned base64url string
 * round-trips unchanged through clientDataJSON.challenge.
 * @param {string} profile
 * @param {"reg"|"auth"} ceremony
 */
export function issueChallenge(profile, ceremony) {
  const nonceHex = crypto.randomBytes(16).toString("hex");
  const expiry = Date.now() + CHALLENGE_TTL_MS;
  const sig = challengeSig(nonceHex, expiry, ceremony, profile);
  return Buffer.from(`${nonceHex}.${expiry}.${ceremony}.${sig}`).toString("base64url");
}

/**
 * Verify a signed challenge: HMAC matches (timing-safe), not expired, ceremony
 * and profile bound. Fail-closed on any parse error. Pass as simplewebauthn's
 * `expectedChallenge` function.
 * @param {string} challenge
 * @param {string} profile
 * @param {"reg"|"auth"} ceremony
 */
export function verifyChallenge(challenge, profile, ceremony) {
  try {
    const parts = Buffer.from(String(challenge), "base64url").toString().split(".");
    if (parts.length !== 4) return false;
    const [nonceHex, expiryStr, cer, sig] = parts;
    if (cer !== ceremony) return false;
    const expiry = Number(expiryStr);
    if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
    const expected = challengeSig(nonceHex, expiry, ceremony, profile);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

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

/**
 * Read a token's stored record (or null). Photos' sliding-window rotation
 * needs the record itself (scope, createdAt), not just a boolean.
 */
export async function readTokenData(authToken) {
  if (!authToken) return null;
  return readJsonDirect(`forge/tokens/${encodeURIComponent(authToken)}`);
}
