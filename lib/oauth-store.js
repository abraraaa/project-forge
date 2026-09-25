// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/oauth-store.js — the Neon implementation of lib/oauth.js's store.
// Single-use is enforced in SQL (UPDATE … WHERE used_at IS NULL RETURNING), so
// two concurrent exchanges of one code cannot both succeed.

import { sql, ensureSchema } from "./db.js";

const n = (v) => (v == null ? null : Number(v));

/** @returns {Promise<import("./oauth.js").OAuthStore | null>} */
export async function neonOAuthStore() {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  return {
    async putClient(c) {
      await q`INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
              VALUES (${c.id}, ${c.name}, ${JSON.stringify(c.redirectUris)}, ${c.createdAt})`;
    },
    // Metadata-document clients (lib/oauth-cimd.js): the fetched copy is
    // overwritten in place on each daily re-check.
    async upsertClient(c) {
      await q`INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
              VALUES (${c.id}, ${c.name}, ${JSON.stringify(c.redirectUris)}, ${c.createdAt})
              ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, created_at = EXCLUDED.created_at`;
    },
    async getClient(id) {
      const [r] = await q`SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ${id}`;
      return r ? { id: r.id, name: r.name, redirectUris: r.redirect_uris, createdAt: n(r.created_at) } : null;
    },
    async putCode(c) {
      await q`INSERT INTO oauth_codes (hash, client_id, profile, credential_id, redirect_uri, code_challenge, scope, resource, expires_at)
              VALUES (${c.hash}, ${c.clientId}, ${c.profile}, ${c.credentialId}, ${c.redirectUri}, ${c.codeChallenge}, ${c.scope}, ${c.resource}, ${c.expiresAt})`;
    },
    async takeCode(hash) {
      const [r] = await q`UPDATE oauth_codes SET used_at = ${Date.now()}
                          WHERE hash = ${hash} AND used_at IS NULL RETURNING *`;
      return r ? { clientId: r.client_id, profile: r.profile, credentialId: r.credential_id, redirectUri: r.redirect_uri,
        codeChallenge: r.code_challenge, scope: r.scope, resource: r.resource, expiresAt: n(r.expires_at) } : null;
    },
    async putGrant(g) {
      await q`INSERT INTO oauth_grants (id, client_id, profile, credential_id, scope, created_at)
              VALUES (${g.id}, ${g.clientId}, ${g.profile}, ${g.credentialId}, ${g.scope}, ${g.createdAt})`;
    },
    async getGrant(id) {
      const [r] = await q`SELECT * FROM oauth_grants WHERE id = ${id}`;
      return r ? { id: r.id, clientId: r.client_id, profile: r.profile, credentialId: r.credential_id, scope: r.scope,
        createdAt: n(r.created_at), lastUsedAt: n(r.last_used_at), revokedAt: n(r.revoked_at) } : null;
    },
    async revokeGrant(id, at) {
      await q`UPDATE oauth_grants SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL`;
    },
    async touchGrant(id, at) {
      await q`UPDATE oauth_grants SET last_used_at = ${at} WHERE id = ${id}`;
    },
    async listGrants(profile) {
      const rows = await q`SELECT g.*, c.name AS client_name FROM oauth_grants g
                           LEFT JOIN oauth_clients c ON c.id = g.client_id
                           WHERE g.profile = ${profile} AND g.revoked_at IS NULL ORDER BY g.created_at DESC`;
      return rows.map((r) => ({ id: r.id, clientName: r.client_name, createdAt: n(r.created_at), lastUsedAt: n(r.last_used_at) }));
    },
    async putToken(t) {
      await q`INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at) VALUES (${t.hash}, ${t.grantId}, ${t.kind}, ${t.expiresAt})`;
    },
    async getToken(hash) {
      const [r] = await q`SELECT * FROM oauth_tokens WHERE hash = ${hash}`;
      return r ? { hash: r.hash, grantId: r.grant_id, kind: r.kind, expiresAt: n(r.expires_at), usedAt: n(r.used_at) } : null;
    },
    async markTokenUsed(hash, at) {
      const rows = await q`UPDATE oauth_tokens SET used_at = ${at} WHERE hash = ${hash} AND used_at IS NULL RETURNING hash`;
      return rows.length === 1;
    },
  };
}
