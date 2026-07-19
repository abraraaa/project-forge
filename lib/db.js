// @ts-check
// lib/db.js
// ─────────────────────────────────────────────────────────────────────────────
// Neon Postgres client (HTTP driver — serverless-native, no pooling to manage).
// The DB replaces blob-as-database for structured data (audit Root 1); blobs
// stay for nothing new. Connection comes from the Vercel↔Neon integration
// (DATABASE_URL; POSTGRES_URL accepted for older integration installs).
//
// PROPOSED SCHEMA (v1 — nothing is created until the import PR ships; the
// dry-run diag only ever SELECT 1s):
//
//   sessions ( profile TEXT NOT NULL,            -- normalised name
//              id      TEXT NOT NULL,            -- record id (ISO instant)
//              record  JSONB NOT NULL,           -- full v3 session record
//              updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//              PRIMARY KEY (profile, id) )
//     · a finished session is ONE ~2KB INSERT ... ON CONFLICT DO NOTHING
//       (records are immutable); delta pull = WHERE updated_at > $since.
//
//   meta ( profile TEXT NOT NULL,
//          field   TEXT NOT NULL,                -- weights | trainingState | …
//          value   JSONB NOT NULL,
//          stamp   TEXT NOT NULL,                -- client field stamp (merge key)
//          PRIMARY KEY (profile, field) )
//     · field-level rows end the mergeMeta whitelist class (#8): unknown
//       fields are just rows; server upsert keeps the newer stamp.
//
//   auth_tokens ( token TEXT PRIMARY KEY, profile TEXT NOT NULL,
//                 expires BIGINT NOT NULL )
//     · replaces forge/tokens/* blobs; expiry enforced in the query.
//
// Client-side stamps + offline merge are unchanged — the DB fixes the server
// half of the algebra only.
// ─────────────────────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";

export function dbUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
}

export function hasDb() {
  return !!dbUrl();
}

/** Tagged-template SQL executor, or null when no DB is configured. */
export function sql() {
  const url = dbUrl();
  return url ? neon(url) : null;
}

/** Read-only connectivity probe: { ok, version } | { ok:false, error }. */
export async function probeDb() {
  const q = sql();
  if (!q) return { ok: false, error: "no DATABASE_URL configured" };
  try {
    const rows = await q`SELECT version() AS v`;
    return { ok: true, version: rows[0]?.v || "unknown" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
