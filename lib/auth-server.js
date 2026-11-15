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
import { NATIVE_RP_ID, LEGACY_RP_ID, acceptedRpIds } from "./origin.js";
import { hasDb, dbInsertToken, dbReadToken } from "./db.js";
import { normaliseProfile } from "./profile-name.js";
import { dbGetAccount, dbAccountByStorageKey, dbResolveHandle } from "./identity-store.js";
import { matchTokenIdentity } from "./identity.js";
import { APPLICATIONS_OPEN, TRAINER_LIVE } from "./trainer-terms.js";

const normalise = normaliseProfile;

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
 * Issue a signed, stateless challenge for a ceremony ("reg" | "reclaim" |
 * "auth"; "reclaim" is a registration that makes a new account). Only
 * meaningful when hasChallengeSecret() is true. The returned base64url string
 * round-trips unchanged through clientDataJSON.challenge.
 * @param {string} profile
 * @param {"reg"|"reclaim"|"auth"} ceremony
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
 * @param {"reg"|"reclaim"|"auth"} ceremony
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
 * never match heatwayve.app, the same constraint that has always existed.
 * @param {Request} request
 * @returns {{ rpId: string, expectedOrigin: string, acceptedRpIds: string[] }}
 */
// Both domains are admitted as ceremony ORIGINS (exact match, never reflected
// from the request). The rpId is always the native one, for minting and for
// verification alike.
const ALLOWED_ORIGIN_HOSTS = new Set([
  "theforged.fit",
  "www.theforged.fit",
  "heatwayve.app",
  "www.heatwayve.app",
]);

export function rpConfigFromRequest(request) {
  const host = (request.headers.get("host") || "").toLowerCase();
  if (host.includes("localhost")) {
    return { rpId: "localhost", expectedOrigin: `http://${host}`, acceptedRpIds: ["localhost"] };
  }
  const origin = ALLOWED_ORIGIN_HOSTS.has(host)
    ? `https://${host}`
    : `https://${NATIVE_RP_ID}`; // unknown host: fail toward the live origin
  return { rpId: NATIVE_RP_ID, expectedOrigin: origin, acceptedRpIds: acceptedRpIds() };
}

/** The rpId a stored credential belongs to. Absent means the field predates
 *  this work, and every ceremony then declared the legacy rpId — so absent is
 *  a legacy credential, not an unknown one. */
export function credentialRpId(credential) {
  const v = credential?.rpId;
  return typeof v === "string" && v ? v : LEGACY_RP_ID;
}

/**
 * Plan a LOGIN ceremony. WebAuthn ceremonies are single-rpId, so only the
 * credentials bound to the config's rpId are offered: a legacy-domain
 * credential could never satisfy the prompt. Keyless credentials are never
 * offered: no signature can be checked against them, so a ceremony using one
 * fails at verification after costing the user a Face ID prompt.
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

  // localhost dev: one rpId, every verifiable credential.
  if (config.rpId === "localhost") {
    return { rpId: "localhost", credentials: verifiable };
  }

  if (!config.acceptedRpIds.includes(config.rpId)) return null;
  const matching = verifiable.filter((c) => credentialRpId(c) === config.rpId);
  return matching.length ? { rpId: config.rpId, credentials: matching } : null;
}

/**
 * Pure predicate over a stored token blob. Fail-closed: any missing field,
 * expiry, or profile mismatch is a rejection. Name-keyed: the gates use
 * resolveTokenIdentity instead.
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
 * Resolve a stored token (or grant) record to the account it was minted for.
 * Rows carrying an account id load that account; legacy rows (no account id)
 * load the account whose storage key is their `profile`, never via a handle,
 * since handles can move and storage keys cannot. When the caller names a
 * handle (the `profile` request param), it must resolve to that same account.
 * Fail-closed: null on any mismatch, expiry, deleted account or bad shape.
 * @param {any} tokenData  from readTokenData
 * @param {string | null | undefined} handle  null/undefined = no handle check (bugs gate)
 * @param {number} [now]
 * @returns {Promise<import("./identity.js").Identity | null>}
 */
export async function resolveTokenIdentity(tokenData, handle, now = Date.now()) {
  // Shape and expiry first: no lookups for a record that cannot pass.
  if (!tokenData || typeof tokenData !== "object") return null;
  if (typeof tokenData.expires !== "number" || now > tokenData.expires) return null;
  const account = tokenData.accountId
    ? await dbGetAccount(String(tokenData.accountId))
    : typeof tokenData.profile === "string" && tokenData.profile
      ? await dbAccountByStorageKey(tokenData.profile)
      : null;
  if (!account) return null;
  const handleRow = handle == null ? undefined : await dbResolveHandle(handle);
  return matchTokenIdentity(tokenData, account, handleRow, now);
}

/**
 * Verify a mint-time auth token WITHOUT consuming it (registration gating and
 * the delete gate both read it; the delete path consumes on success).
 * Fail-closed: a read error reads as null → invalid.
 * @param {string} profile  the handle the caller named
 * @param {string | null | undefined} authToken
 * @returns {Promise<import("./identity.js").Identity | null>}
 */
export async function verifyAuthToken(profile, authToken, { allowScope = null } = {}) {
  if (!authToken) return null;
  const tokenData = await readTokenData(authToken);
  const identity = await resolveTokenIdentity(tokenData, profile, Date.now());
  if (!identity) return null;
  // FAIL-CLOSED ON SCOPE (deep audit 2026-07-26). Token resolution is
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
  if (tokenData.scope && tokenData.scope !== allowScope) return null;
  return identity;
}

/**
 * Mint an auth token into the DB (auth_tokens, stored hashed). Throws when
 * no DB is configured. Returns the token string. The row carries the
 * account id and the account's storage key.
 *
 * A call naming `profile` instead of `identity` mints for the account that
 * holds that handle, and throws when none does.
 * @param {{ identity?: { accountId: string, storageKey: string } | null, profile?: string, ttlMs: number,
 *   scope?: string | null, authAt?: string | null, credentialId?: string | null }} opts
 */
export async function mintAuthToken({ identity = null, profile, ttlMs, scope = null, authAt = null, credentialId = null }) {
  // The DB is the only token store. No DB configured → no sign-in: fail
  // closed rather than fall back to a second store.
  if (!hasDb()) throw new Error("Token store unavailable");
  let owner = identity;
  if (!owner) {
    const held = await dbResolveHandle(profile);
    if (!held) throw new Error("No account holds this name");
    owner = { accountId: held.id, storageKey: held.storageKey };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const record = {
    profile: owner.storageKey,
    accountId: owner.accountId,
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
    // Which passkey did the ceremony — set on ceremony tokens only.
    ...(credentialId ? { credentialId } : {}),
  };
  await dbInsertToken(token, record);
  return token;
}

/**
 * Single-admin recognition by profile name. Superseded by isAdminIdentity;
 * kept for callers that have no resolved identity yet.
 * @param {string | null | undefined} profile
 * @param {string | undefined} [adminEnv]  injectable for tests
 */
export function isAdminProfile(profile, adminEnv = process.env.ADMIN_PROFILE) {
  if (!profile || !adminEnv) return false;
  return normalise(profile) === normalise(adminEnv);
}

/**
 * Single-admin recognition (boss, 2026-07-26). NOT a role system — one env
 * var names WHICH account is the boss; the passkey ceremony remains the
 * actual authentication. ADMIN_ACCOUNT_ID matches the account id. Without
 * it, ADMIN_PROFILE matches the STORAGE KEY, never the handle, so whoever
 * later holds the admin's handle (a fresh, id-keyed storage key) is never
 * admin. Neither set = no admin exists.
 * @param {{ accountId?: string, storageKey?: string } | null | undefined} identity
 * @param {Record<string, string | undefined>} [env]  injectable for tests
 */
export function isAdminIdentity(identity, env = process.env) {
  if (!identity) return false;
  if (env.ADMIN_ACCOUNT_ID) return identity.accountId === env.ADMIN_ACCOUNT_ID;
  if (env.ADMIN_PROFILE) return !!identity.storageKey && identity.storageKey === normalise(env.ADMIN_PROFILE);
  return false;
}

/**
 * Launch switch for trainer sign-in, the first Terms acceptance, invites and new
 * shares: everyone once TRAINER_LIVE, until then the admin only. The dashboard
 * routes check only trainerGate, so turning TRAINER_LIVE off leaves a trainer
 * already signed in with the dashboard until their cookie lapses (up to 30 days).
 * @param {{ accountId?: string, storageKey?: string } | null | undefined} identity
 * @param {Record<string, string | undefined>} [env]  injectable for tests
 */
export function trainerOpenFor(identity, env = process.env) {
  return TRAINER_LIVE || isAdminIdentity(identity, env);
}

/**
 * Switch for applying to coach: everyone while APPLICATIONS_OPEN, otherwise the
 * admin only. Independent of TRAINER_LIVE, so it can close applications on its own.
 * @param {{ accountId?: string, storageKey?: string } | null | undefined} identity
 * @param {Record<string, string | undefined>} [env]  injectable for tests
 */
export function applyOpenFor(identity, env = process.env) {
  return APPLICATIONS_OPEN || isAdminIdentity(identity, env);
}

/**
 * Launch switch for the client's "Add a trainer" row: as trainerOpenFor.
 * TRAINER_PREVIEW_ACCOUNTS is no longer read; the owner deletes it from the
 * environment. Peek and approve still check trainerOpenFor against the
 * invite's trainer.
 * @param {{ accountId?: string, storageKey?: string } | null | undefined} identity
 * @param {Record<string, string | undefined>} [env]  injectable for tests
 */
export function shareOpenFor(identity, env = process.env) {
  return trainerOpenFor(identity, env);
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
 * @param {string[]} [accepted] rpIds a ceremony may use
 */
export function hasUsablePasskey(credData, accepted = acceptedRpIds()) {
  return !!credData?.credentials?.some((c) => isUsableCredential(c, accepted));
}

/**
 * One credential that can still complete a ceremony: verifiable AND bound to
 * a servable rpId. localhost dev credentials carry rpId "localhost" and stay
 * usable in dev.
 * @param {{ publicKey?: string, rpId?: string } | null | undefined} c
 * @param {string[]} [accepted] rpIds a ceremony may use
 */
export function isUsableCredential(c, accepted = acceptedRpIds()) {
  return !!c && typeof c.publicKey === "string" && c.publicKey.length > 0
    && (accepted.includes(credentialRpId(c)) || credentialRpId(c) === "localhost");
}

/**
 * True only when a profile holds credential records but none can still
 * complete a ceremony — so the registrant could not have proved control.
 *
 * FALSE for a first claim and for adding a passkey to a profile that holds a
 * usable one. A false positive moves that holder onto a new, empty account.
 *
 * @param {{ credentials?: any[] } | null} existing credentials doc BEFORE this registration
 * @param {string[]} [accepted] rpIds a ceremony may use
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
  // The DB is the only token store (blob-era tokens all expired by
  // 2026-08-22). No DB → no token reads as valid.
  if (!hasDb()) return null;
  return (await dbReadToken(authToken)) || null;
}
