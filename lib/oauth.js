// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/oauth.js
// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.1 core for "Connect your AI" (MCP authorization). Pure logic over an
// injected store, so the rules are testable without a database.
//
// INVARIANTS:
//   · Tokens and codes are stored as SHA-256 hashes only. The raw value exists
//     once, in the response that issues it.
//   · PKCE S256 is mandatory; "plain" is refused.
//   · A grant binds to the passkey credential that consented, not the profile
//     name — a renamed or reclaimed name must not inherit an AI's access.
//   · Refresh tokens rotate on every use. Presenting a used one revokes the
//     whole grant (theft signal).
//   · Revocation sets revoked_at; nothing is deleted. Expired rows are inert.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { normaliseProfile } from "./profile-name.js";

export const MCP_RESOURCE = "https://heatwayve.app/mcp";
export const SCOPE_READ = "training:read";
export const ACCESS_TTL_MS = 60 * 60 * 1000;            // 1 hour
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const CODE_TTL_MS = 10 * 60 * 1000;              // 10 minutes

const b64url = (buf) => Buffer.from(buf).toString("base64url");
export const newSecret = () => b64url(randomBytes(32));
export const hashSecret = (s) => createHash("sha256").update(String(s)).digest("hex");

/** RFC 7636 S256: base64url(sha256(verifier)) === challenge, constant time. */
export function pkceMatches(verifier, challenge) {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const a = Buffer.from(b64url(createHash("sha256").update(verifier).digest()));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Redirect URIs: https anywhere, http only for loopback (desktop clients). */
export function isAllowedRedirectUri(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/**
 * The store contract (lib/oauth-store.js implements it on Neon; tests use a
 * Map). All methods async.
 * @typedef {{
 *   putClient(c: object): Promise<void>, getClient(id: string): Promise<object|null>,
 *   putCode(c: object): Promise<void>, takeCode(hash: string): Promise<object|null>,
 *   putGrant(g: object): Promise<void>, getGrant(id: string): Promise<object|null>,
 *   revokeGrant(id: string, at: number): Promise<void>, touchGrant(id: string, at: number): Promise<void>,
 *   listGrants(profile: string): Promise<object[]>,
 *   putToken(t: object): Promise<void>, getToken(hash: string): Promise<object|null>,
 *   markTokenUsed(hash: string, at: number): Promise<boolean>,
 * }} OAuthStore
 */

/**
 * Dynamic client registration (RFC 7591).
 * @param {OAuthStore} store
 * @param {{client_name?: string, redirect_uris?: string[]}} [body]
 * @param {number} [now]
 */
export async function registerClient(store, { client_name, redirect_uris } = {}, now = Date.now()) {
  const uris = Array.isArray(redirect_uris) ? redirect_uris : [];
  if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirectUri)) {
    return { error: "invalid_redirect_uri" };
  }
  const name = String(client_name || "AI assistant").slice(0, 80);
  const client = { id: `hwc_${newSecret()}`, name, redirectUris: uris, createdAt: now };
  await store.putClient(client);
  return { client };
}

/** After consent: mint a single-use authorization code. */
export async function issueCode(store, { clientId, profile, credentialId, redirectUri, codeChallenge, codeChallengeMethod, scope = SCOPE_READ, resource = MCP_RESOURCE }, now = Date.now()) {
  const client = await store.getClient(clientId);
  if (!client) return { error: "invalid_client" };
  if (!client.redirectUris.includes(redirectUri)) return { error: "invalid_redirect_uri" };
  if (codeChallengeMethod !== "S256" || !codeChallenge) return { error: "invalid_request" };
  if (scope !== SCOPE_READ) return { error: "invalid_scope" };
  if (resource !== MCP_RESOURCE) return { error: "invalid_target" };
  if (!profile || !credentialId) return { error: "access_denied" };
  const code = newSecret();
  await store.putCode({ hash: hashSecret(code), clientId, profile: normaliseProfile(profile), credentialId, redirectUri, codeChallenge, scope, resource, expiresAt: now + CODE_TTL_MS });
  return { code };
}

async function mintPair(store, grant, now) {
  const access = newSecret(), refresh = newSecret();
  await store.putToken({ hash: hashSecret(access), grantId: grant.id, kind: "access", expiresAt: now + ACCESS_TTL_MS, usedAt: null });
  await store.putToken({ hash: hashSecret(refresh), grantId: grant.id, kind: "refresh", expiresAt: now + REFRESH_TTL_MS, usedAt: null });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: grant.scope };
}

/** grant_type=authorization_code */
export async function exchangeCode(store, { code, clientId, redirectUri, codeVerifier, resource = MCP_RESOURCE }, now = Date.now()) {
  const row = code ? await store.takeCode(hashSecret(code)) : null; // takeCode is single-use
  if (!row || row.expiresAt < now) return { error: "invalid_grant" };
  if (row.clientId !== clientId || row.redirectUri !== redirectUri || row.resource !== resource) return { error: "invalid_grant" };
  if (!pkceMatches(codeVerifier, row.codeChallenge)) return { error: "invalid_grant" };
  const grant = { id: `hwg_${newSecret()}`, clientId, profile: row.profile, credentialId: row.credentialId, scope: row.scope, createdAt: now, lastUsedAt: null, revokedAt: null };
  await store.putGrant(grant);
  return { tokens: await mintPair(store, grant, now) };
}

/** grant_type=refresh_token — rotates; a reused refresh token revokes the grant. */
export async function refreshTokens(store, { refreshToken, clientId }, now = Date.now()) {
  const hash = refreshToken ? hashSecret(refreshToken) : null;
  const tok = hash ? await store.getToken(hash) : null;
  if (!tok || tok.kind !== "refresh" || tok.expiresAt < now) return { error: "invalid_grant" };
  const grant = await store.getGrant(tok.grantId);
  if (!grant || grant.revokedAt || grant.clientId !== clientId) return { error: "invalid_grant" };
  const first = await store.markTokenUsed(hash, now);
  if (!first) {
    await store.revokeGrant(grant.id, now);
    return { error: "invalid_grant" };
  }
  return { tokens: await mintPair(store, grant, now) };
}

/**
 * Bearer check for the MCP route. `credentialExists` answers whether the
 * consenting passkey still belongs to the profile — a removed passkey ends
 * the grant.
 */
/**
 * @param {OAuthStore} store
 * @param {string|null|undefined} token
 * @param {{credentialExists?: (profile: string, credentialId: string) => Promise<boolean>}} [opts]
 * @param {number} [now]
 */
export async function verifyAccessToken(store, token, { credentialExists = async (_p, _c) => true } = {}, now = Date.now()) {
  if (!token) return null;
  const tok = await store.getToken(hashSecret(token));
  if (!tok || tok.kind !== "access" || tok.expiresAt < now) return null;
  const grant = await store.getGrant(tok.grantId);
  if (!grant || grant.revokedAt) return null;
  if (!(await credentialExists(grant.profile, grant.credentialId))) return null;
  await store.touchGrant(grant.id, now);
  return { profile: grant.profile, grantId: grant.id, clientId: grant.clientId, scope: grant.scope };
}

/** Disconnect from the profile page. Only the owning profile may revoke. */
export async function revokeGrantFor(store, profile, grantId, now = Date.now()) {
  const grant = await store.getGrant(grantId);
  if (!grant || grant.profile !== normaliseProfile(profile)) return false;
  if (!grant.revokedAt) await store.revokeGrant(grantId, now);
  return true;
}

/** In-memory store for tests. */
export function memoryStore() {
  const clients = new Map(), codes = new Map(), grants = new Map(), tokens = new Map();
  return {
    async putClient(c) { clients.set(c.id, c); },
    async getClient(id) { return clients.get(id) || null; },
    async putCode(c) { codes.set(c.hash, c); },
    async takeCode(h) { const c = codes.get(h) || null; codes.delete(h); return c; },
    async putGrant(g) { grants.set(g.id, { ...g }); },
    async getGrant(id) { return grants.get(id) || null; },
    async revokeGrant(id, at) { const g = grants.get(id); if (g && !g.revokedAt) g.revokedAt = at; },
    async touchGrant(id, at) { const g = grants.get(id); if (g) g.lastUsedAt = at; },
    async listGrants(p) { return [...grants.values()].filter((g) => g.profile === p); },
    async putToken(t) { tokens.set(t.hash, { ...t }); },
    async getToken(h) { return tokens.get(h) || null; },
    async markTokenUsed(h, at) { const t = tokens.get(h); if (!t || t.usedAt) return false; t.usedAt = at; return true; },
    _tokens: tokens,
  };
}
