// @ts-check
// lib/db.js
// ─────────────────────────────────────────────────────────────────────────────
// Neon Postgres client (HTTP driver — serverless-native, no pooling to manage).
// The DB replaces blob-as-database for structured data (audit Root 1); blobs
// stay for nothing new. Connection comes from the Vercel↔Neon integration
// (DATABASE_URL; POSTGRES_URL accepted for older integration installs).
//
// LIVE SCHEMA (v1 — created idempotently by ensureSchema below on first
// use; the dry-run diag era ended when step 2 shipped in PR #229):
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
//          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//          PRIMARY KEY (profile, field) )
//     · field-level rows end the mergeMeta whitelist class (#8): unknown
//       fields are just rows. Client stamps live INSIDE value (unchanged
//       merge algebra); updated_at is the server-side delta cursor only.
//       (Header previously described a `stamp` column that never shipped —
//       research Rec 11a, fixed 2026-07-25.)
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
  // The Neon↔Vercel integration was installed with a custom "forge" domain
  // prefix (boss-confirmed, 2026-07-18) — forge_DATABASE_URL etc. Unprefixed
  // names kept as fallback for a future re-install without the prefix.
  return (
    process.env.forge_DATABASE_URL ||
    process.env.forge_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    null
  );
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

// ─── Schema + profile store (step 2) ────────────────────────────────────────
// ensureSchema is idempotent (IF NOT EXISTS) and cached per warm instance.
let _schemaEnsured = false;
export async function ensureSchema(q) {
  if (_schemaEnsured) return;
  await q`CREATE TABLE IF NOT EXISTS sessions (
    profile TEXT NOT NULL,
    id TEXT NOT NULL,
    record JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (profile, id)
  )`;
  await q`CREATE TABLE IF NOT EXISTS meta (
    profile TEXT NOT NULL,
    field TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (profile, field)
  )`;
  // Bug reports (boss flow, parked 2026-07-24, built 2026-07-26): rows are
  // NEVER deleted — triage is status-only (new → in_scope → filled|killed),
  // so "kill" closes a report without destroying the record. No delete verb
  // exists for this table anywhere in the codebase.
  await q`CREATE TABLE IF NOT EXISTS bug_reports (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile TEXT,
    message TEXT NOT NULL,
    context JSONB,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Progress photos (P1). `date` is the LOCAL calendar day (lib/dates.js
  // doctrine) — one photo per day, same-day retake overwrites. The image
  // bytes live in a PRIVATE blob at blob_path; this row is the index.
  // No EXIF is retained anywhere; a future opt-in "where you've been"
  // captures location explicitly into a column at upload time instead.
  // Auth tokens (research Rec 11b — replaces forge/tokens/* blobs). Expiry
  // enforced at read; scope carries the photo-cookie marker; created_at
  // drives the sliding-window rotation math.
  await q`CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    expires BIGINT NOT NULL,
    scope TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS photos (
    profile TEXT NOT NULL,
    date TEXT NOT NULL,
    blob_path TEXT NOT NULL,
    bodyweight_at REAL,
    taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (profile, date)
  )`;
  _schemaEnsured = true;
}

/** Meta object ⇄ field rows (pure; exported for tests). null/undefined fields skipped. */
export function metaRowsFrom(metaObj) {
  return Object.entries(metaObj || {})
    .filter(([, v]) => v !== undefined)
    .map(([field, value]) => ({ field, value }));
}
export function assembleMeta(rows) {
  const out = {};
  for (const r of rows || []) out[r.field] = r.value;
  return out;
}

/** Read a profile from the DB: { meta, history, cursor } | null if no rows.
 *  The cursor is taken BEFORE the row reads (see dbNowCursor) so a client
 *  hydrating from this full read can immediately switch to delta pulls. */
export async function dbReadProfile(profile) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const cursor = await dbNowCursor(q);
  const [metaRows, sessRows] = await Promise.all([
    q`SELECT field, value FROM meta WHERE profile = ${profile}`,
    q`SELECT record FROM sessions WHERE profile = ${profile} ORDER BY id`,
  ]);
  if (!metaRows.length && !sessRows.length) return null;
  return { meta: assembleMeta(metaRows), history: sessRows.map((r) => r.record), cursor };
}

/** Insert session records (immutable: ON CONFLICT DO NOTHING). Never deletes. */
export async function dbInsertRecords(q, profile, history) {
  for (const rec of Array.isArray(history) ? history : []) {
    if (!rec?.id) continue;
    await q`INSERT INTO sessions (profile, id, record) VALUES (${profile}, ${rec.id}, ${JSON.stringify(rec)}::jsonb)
            ON CONFLICT (profile, id) DO NOTHING`;
  }
}

/** Upsert meta field rows (caller already ran the stamp-aware merge).
 *  updated_at advances on every write — it is the delta cursor. */
export async function dbUpsertMetaFields(q, profile, meta) {
  for (const { field, value } of metaRowsFrom(meta)) {
    await q`INSERT INTO meta (profile, field, value, updated_at) VALUES (${profile}, ${field}, ${JSON.stringify(value)}::jsonb, now())
            ON CONFLICT (profile, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
}

/** Upsert a full profile snapshot (merged upstream). Never deletes. */
export async function dbUpsertProfile(profile, { meta, history }) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await dbInsertRecords(q, profile, history);
  await dbUpsertMetaFields(q, profile, meta);
  return true;
}

// ─── Delta sync (#2 family — docs/delta-sync.md) ────────────────────────────

/** Server clock as the delta cursor. Taken BEFORE the row queries so a row
 *  written mid-read lands after the handed-out cursor and is re-sent next
 *  pull — at-least-once, and the merge algebra makes re-application a no-op. */
export async function dbNowCursor(q) {
  const rows = await q`SELECT now() AS t`;
  const t = rows[0]?.t;
  return t instanceof Date ? t.toISOString() : String(t);
}

/** Rows changed after `since`. Returns { meta, history, cursor } — possibly
 *  both empty (a quiet delta is the common case). */
export async function dbReadProfileSince(profile, since) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const cursor = await dbNowCursor(q);
  const [metaRows, sessRows] = await Promise.all([
    q`SELECT field, value FROM meta WHERE profile = ${profile} AND updated_at > ${since}`,
    q`SELECT record FROM sessions WHERE profile = ${profile} AND updated_at > ${since} ORDER BY id`,
  ]);
  return { meta: assembleMeta(metaRows), history: sessRows.map((r) => r.record), cursor };
}

/** Cursor with self-managed connection — for callers without a q in hand.
 *  Taken BEFORE a write so the client's next delta pull re-sees its own
 *  write (idempotent echo) rather than ever missing a concurrent one. */
export async function dbCursorNow() {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  return dbNowCursor(q);
}

/** Existing values for a specific field set (the delta PUT's merge base). */
export async function dbReadMetaFields(profile, fields) {
  const q = sql();
  if (!q) return {};
  await ensureSchema(q);
  const list = [...fields];
  if (!list.length) return {};
  const rows = await q`SELECT field, value FROM meta WHERE profile = ${profile} AND field = ANY(${list})`;
  return assembleMeta(rows);
}

/** Upsert one photo index row (same-day retake overwrites — deterministic,
 *  matches the blob's overwrite-in-place path). Never deletes. */
export async function dbUpsertPhoto(profile, { date, blobPath, bodyweightAt }) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await q`INSERT INTO photos (profile, date, blob_path, bodyweight_at, taken_at)
          VALUES (${profile}, ${date}, ${blobPath}, ${bodyweightAt ?? null}, now())
          ON CONFLICT (profile, date) DO UPDATE
            SET blob_path = EXCLUDED.blob_path,
                bodyweight_at = EXCLUDED.bodyweight_at,
                taken_at = now()`;
  return true;
}

/** Photo index for a profile, oldest first (scrubber order). No blob paths
 *  leak to clients — callers select what to expose. */
export async function dbListPhotos(profile) {
  const q = sql();
  if (!q) return [];
  await ensureSchema(q);
  return q`SELECT date, blob_path, bodyweight_at, taken_at
           FROM photos WHERE profile = ${profile} ORDER BY date ASC`;
}

// ─── Bug reports (fill-or-kill triage; status-only, never deleted) ──────────

export const BUG_STATUSES = new Set(["new", "in_scope", "filled", "killed"]);

export async function dbInsertBug({ profile, message, context }) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await q`INSERT INTO bug_reports (profile, message, context)
          VALUES (${profile || null}, ${message}, ${JSON.stringify(context || {})}::jsonb)`;
  return true;
}

export async function dbListBugs({ limit = 200 } = {}) {
  const q = sql();
  if (!q) return [];
  await ensureSchema(q);
  return q`SELECT id, profile, message, context, status, created_at
           FROM bug_reports ORDER BY created_at DESC LIMIT ${limit}`;
}

/** Status-only transition — the ONLY write the review flow has. */
export async function dbUpdateBugStatus(id, status) {
  const q = sql();
  if (!q || !BUG_STATUSES.has(status)) return false;
  await ensureSchema(q);
  await q`UPDATE bug_reports SET status = ${status} WHERE id = ${id}`;
  return true;
}

// ─── Auth tokens (Rec 11b) ──────────────────────────────────────────────────

/** Mint-side insert. The record mirrors the old blob shape exactly so the
 *  read side is interchangeable during the transition. */
export async function dbInsertToken(token, { profile, expires, scope = null, createdAt }) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await q`INSERT INTO auth_tokens (token, profile, expires, scope, created_at)
          VALUES (${token}, ${profile}, ${expires}, ${scope}, ${createdAt || new Date().toISOString()})
          ON CONFLICT (token) DO NOTHING`;
  return true;
}

/** Token record in the blob shape ({ profile, expires, scope?, createdAt })
 *  or null. Expiry is enforced by callers (isTokenValid), same as before. */
export async function dbReadToken(token) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT profile, expires, scope, created_at FROM auth_tokens WHERE token = ${token}`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    profile: r.profile,
    expires: Number(r.expires),
    ...(r.scope ? { scope: r.scope } : {}),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** DESTRUCTIVE (relocated, not new): consume ONE used ceremony token — the
 *  wipe path has always deleted its token on success; this is that same
 *  announced behaviour moved from blob del to a row delete. */
export async function dbDeleteToken(token) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await q`DELETE FROM auth_tokens WHERE token = ${token}`;
  return true;
}

/** DESTRUCTIVE (announced with the scrubber delete, 2026-07-21): remove ONE
 *  photo's index row. User-initiated from the scrubber, token-gated at the
 *  route, single (profile, date) — the metro clause. */
export async function dbDeletePhoto(profile, date) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await q`DELETE FROM photos WHERE profile = ${profile} AND date = ${date}`;
  return true;
}

/** DESTRUCTIVE (wipe-protocol: announced 2026-07-19; photos table added to
 *  the same scope 2026-07-20, announced with Photos P1): delete a profile's
 *  DB rows. Rides the existing passkey-gated profile wipe ONLY. Enumerated
 *  tables, no glob — photo BLOBS are covered by the wipe's existing
 *  profile-prefix blob deletion. */
export async function dbDeleteProfile(profile) {
  const q = sql();
  if (!q) return 0;
  await ensureSchema(q);
  const a = await q`DELETE FROM sessions WHERE profile = ${profile}`;
  const b = await q`DELETE FROM meta WHERE profile = ${profile}`;
  const c = await q`DELETE FROM photos WHERE profile = ${profile}`;
  // Announced with Rec 11b (2026-07-26): outstanding auth tokens die WITH
  // their profile. Blob-era tokens lived outside the wiped prefix, so a
  // 7-day photo cookie could survive its profile's deletion — and grant
  // photo access if the name was re-claimed. Enumerated table, same
  // user-initiated passkey-gated scope as every row above.
  const d = await q`DELETE FROM auth_tokens WHERE profile = ${profile}`;
  return (a.length || 0) + (b.length || 0) + (c.length || 0) + (d.length || 0);
}
