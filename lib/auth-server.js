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
import { put } from "@vercel/blob";
import { readJsonDirect } from "./blob-utils.js";
import { NATIVE_RP_ID, LEGACY_RP_ID, acceptedRpIds, legacyRpRetired } from "./origin.js";
import { hasDb, dbInsertToken, dbReadToken } from "./db.js";

const normalise = (name) => String(name || "").trim().toLowerCase();

// ─── Stateless WebAuthn challenges ───────────────────────────────────────────
// An HMAC-signed token (nonce + expiry + ceremony, bound to the profile via the
// HMAC input), verified by recomputing the HMAC. Holding no server state is the
// point: there is no write→read round-trip to race.
//
// INVARIANTS:
//   · Keep the TTL short. It is the only bound on a signed challenge's life.
//   · The secret is operator-held and the HMAC fails closed without it.
//   · Never widen what the HMAC covers without re-checking every caller.
const CHALLENGE_TTL_MS = 120000;

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
// Heatwayve migration (challenge 1, 2026-07-22): TWO origins, ONE rpId.
// The allow-list below admits both domains as ceremony ORIGINS, but every
// credential keeps rpId "theforged.fit" for now — including ones created
// from heatwayve.app, which is legal via Related Origin Requests (the
// /.well-known/webauthn served on theforged.fit lists heatwayve.app).
// Why single-rpId: profiles stay single-lock (no mixed-rpId credential
// pools needing multiple ceremonies), and the deliberate switch to
// heatwayve-native rpIds happens post-flip with per-credential rpId
// storage — its own step in the migration map, not a side effect here.
// The allow-list is exact-match, never reflected from the request.
const ALLOWED_ORIGIN_HOSTS = new Set([
  "theforged.fit",
  "www.theforged.fit",
  "heatwayve.app",
  "www.heatwayve.app",
]);

export function rpConfigFromRequest(request, now = Date.now()) {
  const host = (request.headers.get("host") || "").toLowerCase();
  if (host.includes("localhost")) {
    return { rpId: "localhost", expectedOrigin: `http://${host}`, acceptedRpIds: ["localhost"] };
  }
  const origin = ALLOWED_ORIGIN_HOSTS.has(host)
    ? `https://${host}`
    : `https://${NATIVE_RP_ID}`; // unknown host: fail toward the live origin
  // WHICH rpId A NEW CREDENTIAL IS MINTED UNDER.
  //
  // An rpId must be a registrable suffix of the ceremony origin, or be
  // permitted by a Related Origin Requests document served at the rpId's own
  // origin. We serve one at theforged.fit listing the heatwayve origins, which
  // is what lets a heatwayve ceremony mint (and use) a theforged.fit
  // credential. There is NO document in the other direction, so a ceremony
  // that is genuinely on theforged.fit can only mint theforged.fit — minting
  // native from there would be rejected by the browser.
  const onLegacyOrigin = host === LEGACY_RP_ID || host === `www.${LEGACY_RP_ID}`;
  const rpId = onLegacyOrigin && !legacyRpRetired(now) ? LEGACY_RP_ID : NATIVE_RP_ID;
  // WHICH rpIds VERIFICATION MAY ACCEPT. Only this dimension is widened: the
  // credential's rpId is unknown until the library matches it, whereas the
  // origin is known exactly, so expectedOrigin stays pinned to one string.
  return { rpId, expectedOrigin: origin, acceptedRpIds: acceptedRpIds(now) };
}

/** The rpId a stored credential belongs to. Absent means the field predates
 *  this work, and every ceremony then declared the legacy rpId — so absent is
 *  a legacy credential, not an unknown one. */
export function credentialRpId(credential) {
  const v = credential?.rpId;
  return typeof v === "string" && v ? v : LEGACY_RP_ID;
}

/**
 * Plan a LOGIN ceremony. WebAuthn ceremonies are single-rpId, so offering a
 * credential from the other pool guarantees a prompt the authenticator cannot
 * satisfy. This picks ONE rpId and returns only the credentials that match it.
 *
 * Native is preferred whenever the profile holds one, so a user who has
 * already upgraded never touches the legacy path again. Keyless credentials
 * are never offered: no signature can be checked against them, so a ceremony
 * using one fails at verification after costing the user a Face ID prompt.
 *
 * @param {{ credentials?: any[] } | null} credData
 * @param {{ rpId: string, acceptedRpIds: string[] }} config
 * @returns {{ rpId: string, credentials: any[] } | null} null when nothing usable remains
 */
export function planLoginCeremony(credData, config) {
  const verifiable = (credData?.credentials || []).filter(
    (c) => c && typeof c.publicKey === "string" && c.publicKey.length > 0,
  );
  if (!verifiable.length) return null;

  // localhost dev: one rpId, no migration semantics.
  if (config.rpId === "localhost") {
    return { rpId: "localhost", credentials: verifiable };
  }

  const usable = config.acceptedRpIds.filter((id) => id !== "localhost");
  // Native first — the order in acceptedRpIds is the preference order.
  for (const id of usable) {
    const matching = verifiable.filter((c) => credentialRpId(c) === id);
    // A ceremony on the legacy origin cannot declare the native rpId.
    if (matching.length && (id === config.rpId || id === LEGACY_RP_ID || config.rpId === NATIVE_RP_ID)) {
      return { rpId: id, credentials: matching };
    }
  }
  return null;
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
export async function verifyAuthToken(profile, authToken, { allowScope = null } = {}) {
  if (!authToken) return false;
  const tokenData = await readTokenData(authToken);
  if (!isTokenValid(tokenData, profile, Date.now())) return false;
  // FAIL-CLOSED ON SCOPE (deep audit 2026-07-26). isTokenValid is
  // deliberately scope-blind, and every privileged gate was expected to
  // re-check scope itself — but register-verify's anti-stuffing check
  // forgot, so a 7-day photo-scope cookie satisfied ADDING A NEW PASSKEY to
  // an already-protected profile: a narrow read-only credential escalating
  // to permanent account takeover. Blocked in practice only because the
  // cookie is path-scoped away from that route, which is luck, not design.
  //
  // The default is now "full-scope ceremony token only". A caller that
  // genuinely wants a scoped token must name it, so the next gate added
  // inherits the safe behaviour instead of the bug.
  if (tokenData.scope && tokenData.scope !== allowScope) return false;
  return true;
}

/**
 * Mint an auth token (Rec 11b: DB rows replace forge/tokens/* blobs).
 * Record shape is identical to the blob era, so readers are interchangeable
 * during the transition. Blob minting survives only as the no-DB dev
 * fallback. Returns the token string.
 * @param {{ profile: string, ttlMs: number, scope?: string | null, authAt?: string | null }} opts
 */
export async function mintAuthToken({ profile, ttlMs, scope = null, authAt = null }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const record = {
    profile: normalise(profile),
    expires: Date.now() + ttlMs,
    ...(scope ? { scope } : {}),
    // authAt is the ORIGINAL ceremony instant and is carried forward
    // unchanged through every rotation (createdAt is per-token and resets).
    // A sliding credential can therefore be capped absolutely: rotation
    // refuses past the ceiling, so "used daily forever" still comes back to
    // a passkey eventually. Deep audit 2026-07-26 — a rotating token with no
    // ceiling is a credential that never dies.
    authAt: authAt || new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  if (hasDb()) {
    await dbInsertToken(token, record);
  } else {
    await put(`forge/tokens/${token}`, JSON.stringify(record), {
      access: "private", contentType: "application/json",
      addRandomSuffix: false, allowOverwrite: true,
    });
  }
  return token;
}

/**
 * Single-admin recognition (boss, 2026-07-26). NOT a role system — one env
 * var names WHICH profile is the boss; the passkey ceremony remains the
 * actual authentication. Unset env = no admin exists (gates fall back to
 * their documented pre-admin behaviour, keeping dev environments usable).
 * @param {string | null | undefined} profile
 * @param {string | undefined} [adminEnv]  injectable for tests
 */
export function isAdminProfile(profile, adminEnv = process.env.ADMIN_PROFILE) {
  if (!profile || !adminEnv) return false;
  return normalise(profile) === normalise(adminEnv);
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
 * Holds a passkey that can still complete a ceremony: verifiable AND bound to
 * a servable rpId. Use for "can this person get in".
 *
 * NOT for the wipe gate, which keeps hasRealPasskey — a profile that was ever
 * protected must not become deletable because its lock expired.
 *
 * @param {{ credentials?: Array<{ publicKey?: string, rpId?: string }> } | null} credData
 * @param {string[]} [accepted] rpIds a ceremony may use now
 */
export function hasUsablePasskey(credData, accepted = acceptedRpIds()) {
  // localhost dev credentials carry rpId "localhost" and are never part of the
  // domain migration.
  const ok = new Set([...accepted, "localhost"]);
  return !!credData?.credentials?.some(
    (c) => c && typeof c.publicKey === "string" && c.publicKey.length > 0 && ok.has(credentialRpId(c)),
  );
}

/**
 * True only when a profile holds credential records but none can still
 * complete a ceremony — so the registrant could not have proved control.
 *
 * FALSE for a first claim, for adding a second passkey, and for the rpId
 * upgrade. A false positive retires the photos of everyone who upgrades.
 *
 * @param {{ credentials?: any[] } | null} existing credentials doc BEFORE this registration
 * @param {string[]} [accepted] rpIds a ceremony may use now
 */
export function isReclaimOfLapsedProfile(existing, accepted = acceptedRpIds()) {
  const records = existing?.credentials;
  if (!Array.isArray(records) || records.length === 0) return false;
  return !hasUsablePasskey(existing, accepted);
}

/**
 * Read a token's stored record (or null). Photos' sliding-window rotation
 * needs the record itself (scope, createdAt), not just a boolean.
 */
export async function readTokenData(authToken) {
  if (!authToken) return null;
  // ONE TOKEN STORE PER DEPLOYMENT — mint and read are symmetric.
  //
  // This used to be DB-first with an UNCONDITIONAL blob fallback, which made
  // the DB non-authoritative: dbDeleteProfile drops a profile's auth_tokens
  // rows, but the wipe never sweeps `forge/tokens/`, so a surviving blob
  // token still authenticated. Worse, since the profile key is a low-entropy
  // NAME, once a wiped name was re-claimed that stale token read the NEW
  // profile's photos — and the photos route would rotate it into a fresh DB
  // token, resurrecting a dead credential as a live, self-renewing one
  // (deep audit 2026-07-26, "#78 is only half-closed").
  //
  // Now the fallback exists ONLY where there is no DB to be authoritative —
  // i.e. a local checkout with no DATABASE_URL, which is also the only mode
  // where mintAuthToken writes a blob. Wherever a DB is configured (all
  // production), the DB is the single source and a deleted row is genuinely
  // deleted. That closes the finding without breaking no-DB development.
  //
  // Straggler cost, stated honestly: the Rec 11b migration landed
  // 2026-07-23, so a pre-migration 7-day photo cookie could still be live
  // until 2026-07-29. Those now 401 and cost one re-auth — which is the
  // point, since that token class is precisely the unrevocable one.
  if (hasDb()) {
    return (await dbReadToken(authToken)) || null;
  }
  return readJsonDirect(`forge/tokens/${encodeURIComponent(authToken)}`);
}
