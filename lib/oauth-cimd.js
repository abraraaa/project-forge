// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/oauth-cimd.js — Client ID Metadata Documents (MCP authorization,
// 2025-11-25; draft-ietf-oauth-client-id-metadata-document). An AI may
// identify itself by an https URL instead of registering first; we fetch that
// document, check it, and keep it in oauth_clients (overwrite in place,
// re-checked daily) so every other step treats it like a registered client.
//
// The fetch is outbound to a URL a stranger chose, so it is fenced: https
// only, no IP literals or local/internal names, no redirects, 5s, 16KB.

import { isAllowedRedirectUri } from "./oauth.js";

export const CIMD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024;

/** Is this client_id a metadata-document URL we're willing to fetch? */
export function isCimdClientId(id) {
  if (typeof id !== "string" || !id.startsWith("https://") || id.length > 512) return false;
  let u;
  try { u = new URL(id); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.port) return false;
  if (!u.pathname || u.pathname === "/") return false; // the spec requires a path
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h.startsWith("[") || /^\d+(\.\d+){3}$/.test(h)) return false; // IP literals, single labels
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h)) return false;
  return true;
}

/**
 * Validate a fetched document against the URL it came from.
 * @returns {{ id: string, name: string, redirectUris: string[] } | null}
 */
export function clientFromDocument(url, doc) {
  if (!doc || typeof doc !== "object" || doc.client_id !== url) return null;
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) return null;
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none") return null; // public clients with PKCE only
  const name = typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 80) : new URL(url).hostname;
  return { id: url, name, redirectUris: uris };
}

/** @param {string} url @param {typeof fetch} fetchImpl */
async function fetchDocument(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return null;
  const text = await res.text();
  if (text.length > MAX_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * The client for this id: registered, or fetched from its metadata document.
 * A failed re-check keeps serving the last good copy.
 * @param {import("./oauth.js").OAuthStore & { upsertClient?: (c: object) => Promise<void> }} store
 * @param {string} clientId
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [opts]
 */
export async function resolveClient(store, clientId, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!clientId) return null;
  if (!isCimdClientId(clientId)) return store.getClient(clientId);
  const known = await store.getClient(clientId);
  if (known && now - (known.createdAt || 0) < CIMD_TTL_MS) return known;
  let client = null;
  try { client = clientFromDocument(clientId, await fetchDocument(clientId, fetchImpl)); } catch { client = null; }
  if (!client) return known || null;
  const row = { ...client, createdAt: now };
  if (store.upsertClient) await store.upsertClient(row); else await store.putClient(row);
  return row;
}
