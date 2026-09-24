// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/oauth-http.js — the HTTP edge of lib/oauth.js: discovery documents,
// authorize-parameter checks, consent-token checks. Pure, so tested directly.

import { MCP_RESOURCE, SCOPE_READ, isAllowedRedirectUri } from "./oauth.js";

export const ISSUER = "https://heatwayve.app";
/** Consent needs a Face ID from the last few minutes, not any live token. */
export const CONSENT_FRESH_MS = 5 * 60 * 1000;

/** RFC 9728 protected-resource metadata. */
export const protectedResourceMetadata = () => ({
  resource: MCP_RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: [SCOPE_READ],
  bearer_methods_supported: ["header"],
  resource_name: "Heatwayve",
});

/** RFC 8414 authorization-server metadata. /connect is the authorize step. */
export const authorizationServerMetadata = () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/connect`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [SCOPE_READ],
  authorization_response_iss_parameter_supported: true,
});

/** JSON for OAuth endpoints: never cached, callable cross-origin. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function oauthJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

/** 204 carries no body. */
export const preflight = () => new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });

/** Token/register bodies arrive form-encoded (spec) or as JSON (some clients). */
export async function readParams(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return body && typeof body === "object" ? body : {};
  }
  const text = await request.text().catch(() => "");
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * Check /connect's query against the registered client.
 * `fatal` errors must NOT redirect (we can't trust where to send them);
 * `redirectError` goes back to the client's redirect_uri with state.
 * @param {Record<string, string | undefined>} q
 * @param {{ redirectUris: string[] } | null} client
 */
export function checkAuthorizeParams(q, client) {
  if (!client) return { fatal: "This app isn't registered with Heatwayve." };
  const redirectUri = q.redirect_uri || "";
  if (!redirectUri || !client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) {
    return { fatal: "This app asked to return somewhere it didn't register." };
  }
  if (q.response_type !== "code") return { redirectError: "unsupported_response_type" };
  if (!q.code_challenge || q.code_challenge_method !== "S256") return { redirectError: "invalid_request" };
  const scope = q.scope || SCOPE_READ;
  if (scope.split(" ").some((s) => s !== SCOPE_READ)) return { redirectError: "invalid_scope" };
  const resource = q.resource || MCP_RESOURCE;
  if (resource.replace(/\/$/, "") !== MCP_RESOURCE) return { redirectError: "invalid_target" };
  return { ok: { redirectUri, codeChallenge: q.code_challenge, scope: SCOPE_READ, resource: MCP_RESOURCE, state: q.state || null } };
}

/** Where to send the browser after consent (or refusal). RFC 9207 iss included. */
export function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries({ ...params, iss: ISSUER })) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * The consent gate: a full-scope ceremony token for this profile, minted by
 * Face ID within the last few minutes, that names its passkey.
 * @param {any} tokenData  readTokenData() output
 * @param {string} profile  normalised
 * @param {number} now
 * @returns {{ credentialId: string } | null}
 */
export function consentFromToken(tokenData, profile, now) {
  if (!tokenData || typeof tokenData !== "object") return null;
  if (typeof tokenData.expires !== "number" || now > tokenData.expires) return null;
  if (tokenData.profile !== profile) return null;
  if (tokenData.scope) return null;
  if (!tokenData.credentialId) return null;
  const at = Date.parse(tokenData.authAt || tokenData.createdAt || "");
  if (!Number.isFinite(at) || now - at > CONSENT_FRESH_MS) return null;
  return { credentialId: tokenData.credentialId };
}
