// @ts-check
// lib/trainer-session.js
// ─────────────────────────────────────────────────────────────────────────────
// The trainer dashboard's session, server-only. Two gates:
//   · freshCeremony: a full-scope ceremony token from a Face ID in the last
//     few minutes, made with a heatwayve.app passkey that is in the index.
//     Used by sign-in, the trainer upgrade and (later) share approval.
//   · trainerGate: the __Host-hw_trainer cookie, scope "trainer", bound to the
//     passkey that signed it in. 14 days, sliding daily, never sliding past
//     30 days from that Face ID.
// Account and passkey come only from the server's token record.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { readTokenData, resolveTokenIdentity, mintAuthToken } from "./auth-server.js";
import { consentFromToken } from "./oauth-http.js";
import { dbTrainerAccount } from "./trainer-store.js";
import { entitled } from "./entitlements.js";
import { isCurrentTrainerTerms } from "./trainer-terms.js";

const DAY_MS = 86400000;
export const TRAINER_COOKIE = "__Host-hw_trainer";
export const TRAINER_TTL_MS = 14 * DAY_MS;
export const TRAINER_ROTATE_AFTER_MS = DAY_MS;
export const TRAINER_CAP_MS = 30 * DAY_MS;
// __Host- requires Secure, Path=/ and no Domain. Every other gate reads its
// own cookie by name and refuses the trainer scope.
export const TRAINER_COOKIE_OPTS = Object.freeze({
  httpOnly: true, secure: true, sameSite: /** @type {"strict"} */ ("strict"), path: "/", maxAge: 14 * 86400,
});

/** JSON that is never cached. */
export const json = (body, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Mark a response from elsewhere (rate limit, serverError) as never cached.
 * @template {Response} R
 * @param {R} res
 * @returns {R}
 */
export const noStore = (res) => {
  res.headers.set("Cache-Control", "no-store");
  return res;
};

/** @param {NextResponse} res @param {string} token */
export const setTrainerCookie = (res, token) => {
  res.cookies.set(TRAINER_COOKIE, token, TRAINER_COOKIE_OPTS);
  return res;
};

/** The named browser-side removal: sign-out sends Max-Age=0. @param {NextResponse} res */
export const clearTrainerCookie = (res) => {
  res.cookies.set(TRAINER_COOKIE, "", { ...TRAINER_COOKIE_OPTS, maxAge: 0 });
  return res;
};

const faceIdFailed = () => ({ fail: json({ error: "Face ID didn't go through. Try again.", requiresAuth: true }, 401) });

/**
 * A fresh, native, indexed passkey ceremony.
 * @param {{ authToken?: unknown, profile?: unknown }} body
 * @param {number} [now]
 * @returns {Promise<{ fail: NextResponse } | { identity: import("./identity.js").Identity,
 *   credentialId: string, authAt: string | null, account: import("./trainer-store.js").TrainerAccount }>}
 */
export async function freshCeremony({ authToken, profile }, now = Date.now()) {
  if (typeof authToken !== "string" || !authToken || typeof profile !== "string" || !profile) return faceIdFailed();
  const tokenData = await readTokenData(authToken);
  // The handle must resolve to the token's own account; closed accounts never resolve.
  const identity = await resolveTokenIdentity(tokenData, profile, now);
  // Unscoped, names its passkey, Face ID within the last 5 minutes.
  const consent = consentFromToken(tokenData, now);
  if (!identity || !consent) return faceIdFailed();
  // The passkey must be in the index under heatwayve.app. A legacy or
  // Blob-only passkey needs a native one first.
  const account = await dbTrainerAccount(identity.accountId, consent.credentialId);
  if (!account || account.deletedAt) return faceIdFailed();
  if (!account.credLive) return { fail: json({ needsNativePasskey: true }, 409) };
  return { identity, credentialId: consent.credentialId, authAt: tokenData.authAt ?? null, account };
}

/**
 * Mint a trainer session for a verified identity and passkey.
 * @param {import("./identity.js").Identity} identity
 * @param {{ credentialId: string, authAt: string | null }} bound  the Face ID it is bound to
 */
export function mintTrainerSession(identity, { credentialId, authAt }, now = Date.now()) {
  return mintAuthToken({ identity, ttlMs: trainerSessionTtl(authAt, now), scope: "trainer", authAt, credentialId });
}

/**
 * How long a session minted now may live: 14 days, but never past 30 days
 * from the Face ID it is bound to (the passkey is asked for again monthly).
 * @param {string | null | undefined} authAt
 * @param {number} now
 */
export function trainerSessionTtl(authAt, now) {
  const authMs = authAt ? new Date(authAt).getTime() : NaN;
  if (!Number.isFinite(authMs)) return TRAINER_TTL_MS;
  return Math.max(0, Math.min(TRAINER_TTL_MS, authMs + TRAINER_CAP_MS - now));
}

const signIn = () => ({ fail: json({ error: "Sign in to see your clients", requiresAuth: true }, 401) });

/**
 * The only gate on trainer-side routes. Reads the trainer cookie and nothing
 * else (never x-hw-auth).
 * @param {Request & { cookies?: any }} request
 * @param {number} [now]
 * @returns {Promise<{ fail: NextResponse } | { identity: import("./identity.js").Identity,
 *   account: import("./trainer-store.js").TrainerAccount, refresh: string | null }>}
 */
export async function trainerGate(request, now = Date.now()) {
  const token = request.cookies?.get?.(TRAINER_COOKIE)?.value || null;
  const data = await readTokenData(token);
  if (!data || data.scope !== "trainer" || !data.credentialId) return signIn();
  const identity = await resolveTokenIdentity(data, null, now);
  if (!identity) return signIn();
  const account = await dbTrainerAccount(identity.accountId, data.credentialId);
  if (!account || account.deletedAt || !entitled(account, "trainer.dashboard")) return signIn();
  // The passkey that signed this session in must still be live and native.
  if (!account.credLive) return signIn();
  if (!isCurrentTrainerTerms(account.trainerTerms)) return { fail: json({ needsTerms: true }, 403) };
  // Slide once a day, carrying the original Face ID and its passkey, until
  // 30 days from that Face ID; then the cookie lapses on its own.
  let refresh = null;
  const age = now - new Date(data.createdAt || 0).getTime();
  const authAge = now - new Date(data.authAt || data.createdAt || 0).getTime();
  const withinCap = Number.isFinite(authAge) && authAge < TRAINER_CAP_MS;
  if ((!Number.isFinite(age) || age > TRAINER_ROTATE_AFTER_MS) && withinCap) {
    refresh = await mintTrainerSession(identity, { credentialId: data.credentialId, authAt: data.authAt || data.createdAt || null }, now);
  }
  return { identity, account, refresh };
}
