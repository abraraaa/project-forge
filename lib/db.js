// @ts-check
// lib/db.js
// ─────────────────────────────────────────────────────────────────────────────
// Postgres client (HTTP driver — serverless-native, no pooling to manage).
// Connection comes from the platform integration.
//
// The schema is defined by ensureSchema() below — read it there rather than
// duplicating it here, so the two can never drift.
//
// INVARIANTS:
//   · Session records are IMMUTABLE. Inserts must not overwrite an existing
//     row for the same key.
//   · Meta is stored as field-level rows, never one blob per profile. An
//     unrecognised field is just a row, so nothing is dropped in transit.
//   · Client-side stamps live inside the stored value and are the merge
//     authority. The row's own timestamp is a server-side cursor ONLY —
//     never resolve a conflict with it.
//   · Every query is a parameterised tagged template. No exceptions.
// ─────────────────────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { fieldClosure } from "./sync-merge.js";
import { createHash } from "node:crypto";

// Sign-in tokens are stored as SHA-256 hex, so a database read never yields a
// usable cookie. Rows minted before 2026-09-27 hold the raw token; reads and
// the single-token consume accept either form until those age out (90-day
// absolute cap). No stored row is rewritten.
const tokenKey = (token) => createHash("sha256").update(String(token)).digest("hex");
// The legacy raw lookup must never match a stored HASH, or a leaked table row
// would sign someone in. Minted tokens are 43-char base64url; a stored key is
// 64-char hex — only token-shaped values get the legacy lookup.
const legacyKey = (token) => (/^[0-9a-f]{64}$/.test(String(token)) ? null : String(token));

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
  // auth_at: the original passkey ceremony, carried through rotations so the
  // sliding cookies have an absolute ceiling. Additive and nullable — rows
  // minted before it read back without authAt and fall back to created_at.
  await q`ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS auth_at TIMESTAMPTZ`;
  // credential_id: which passkey performed the ceremony (ceremony tokens
  // only). Lets AI-connect consent bind to that passkey. Additive, nullable.
  await q`ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS credential_id TEXT`;
  await q`CREATE TABLE IF NOT EXISTS photos (
    profile TEXT NOT NULL,
    date TEXT NOT NULL,
    blob_path TEXT NOT NULL,
    bodyweight_at REAL,
    taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (profile, date)
  )`;
  // "Connect your AI" (OAuth 2.1, lib/oauth.js). Secrets are stored as SHA-256
  // hashes only. No row is ever deleted: codes and refresh tokens are spent
  // by stamping used_at, grants are revoked by stamping revoked_at.
  await q`CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris JSONB NOT NULL,
    created_at BIGINT NOT NULL
  )`;
  await q`CREATE TABLE IF NOT EXISTS oauth_codes (
    hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT
  )`;
  await q`CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT,
    revoked_at BIGINT
  )`;
  // Audience binding (MCP spec: a server accepts only tokens issued for it).
  // Additive and nullable: rows from before read as kind 'ai' for /mcp.
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS kind TEXT`;
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS resource TEXT`;
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS expires_at BIGINT`;
  await q`CREATE TABLE IF NOT EXISTS oauth_tokens (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT
  )`;
  await q`CREATE INDEX IF NOT EXISTS oauth_grants_profile ON oauth_grants (profile)`;
  // Shared rate-limit counters. Bounded (route × hashed bucket), overwritten
  // in place each window: rows never accumulate, so nothing ever deletes them.
  await q`CREATE TABLE IF NOT EXISTS rate_buckets (
    bucket TEXT PRIMARY KEY,
    window_start BIGINT NOT NULL,
    count INTEGER NOT NULL
  )`;
  // ── Identity core (phase 1). Additive only; nothing below is ever dropped or
  // rewritten. Rows in accounts/handles are never DELETEd: closure is
  // accounts.deleted_at, release is handles.released_at.
  await q`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY CHECK (id ~ '^hwa_[a-z2-7]{26}$'),
    storage_key TEXT NOT NULL UNIQUE,
    webauthn_user_id TEXT NOT NULL UNIQUE,
    roles TEXT[] NOT NULL DEFAULT ARRAY['lifter']::text[],
    plan TEXT NOT NULL DEFAULT 'free',
    consent JSONB,
    origin TEXT NOT NULL DEFAULT 'claim',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lapsed_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    CHECK (origin IN ('backfill','precutover_claim','claim','reclaim')),
    CHECK (storage_key = id OR origin IN ('backfill','precutover_claim')),
    CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['lifter','trainer']::text[])
  )`;
  await q`CREATE TABLE IF NOT EXISTS handles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handle TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    display TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary','alias')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    hold_until TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    CHECK (kind = 'primary' OR hold_until IS NOT NULL)
  )`;
  // One LIVE row per handle (a released row frees it); one live primary per account.
  await q`CREATE UNIQUE INDEX IF NOT EXISTS handles_live ON handles (handle) WHERE released_at IS NULL`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS handles_one_primary ON handles (account_id) WHERE released_at IS NULL AND kind = 'primary'`;
  await q`CREATE INDEX IF NOT EXISTS handles_account ON handles (account_id)`;
  await q`CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    transports JSONB NOT NULL DEFAULT '[]'::jsonb,
    rp_id TEXT NOT NULL,
    user_handle TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'register' CHECK (source IN ('register','backfill')),
    created_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
  )`;
  await q`CREATE INDEX IF NOT EXISTS credentials_account ON credentials (account_id)`;
  // Which account a token / code / grant was minted for. Null on legacy rows:
  // those resolve by storage key (their `profile` column), never by handle.
  await q`ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS account_id TEXT`;
  await q`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS account_id TEXT`;
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS account_id TEXT`;
  await q`CREATE INDEX IF NOT EXISTS oauth_grants_account ON oauth_grants (account_id)`;
  // Trainer Stage 1. Terms acceptance { version, at, adult } in its own column:
  // accounts.consent is overwritten whole (identity-store.js dbSetAccountConsent) and nulled on close.
  await q`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trainer_terms JSONB`;
  // kind='trainer' grants: account_id = the client (owner), trainer_account_id = who may read.
  // revoked_by: null = the client or legacy, 'trainer', 'replaced', 'closed'.
  // looks: the client's access log, newest first, at most 20 entries, rewritten in place.
  //   { k: 'v', at } is a full look; { k: 'r', d: 'YYYY-MM-DD', at } is a roster check-in.
  // look_count: every look ever logged on this grant (the ring forgets, the count does not).
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS trainer_account_id TEXT`;
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS consent_version TEXT`;
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS revoked_by TEXT`;
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS looks JSONB`;
  await q`ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS look_count INTEGER`;
  // One active trainer per client; also serves a trainer's live-clients lookup.
  await q`CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_one_trainer ON oauth_grants (account_id) WHERE kind = 'trainer' AND revoked_at IS NULL`;
  await q`CREATE INDEX IF NOT EXISTS oauth_grants_trainer ON oauth_grants (trainer_account_id) WHERE kind = 'trainer' AND revoked_at IS NULL`;
  // One invite slot per trainer, rewritten in place on each issue. The code is stored as SHA-256 only.
  await q`CREATE TABLE IF NOT EXISTS trainer_invites (
    trainer_account_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    issued_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT,
    grant_id TEXT
  )`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS trainer_invites_code ON trainer_invites (code_hash)`;
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

/** Insert session records (immutable: ON CONFLICT DO NOTHING). Never deletes.
 *  One statement for the whole batch: a first sync of a long history is one
 *  round trip, not hundreds. */
export async function dbInsertRecords(q, profile, history) {
  const recs = (Array.isArray(history) ? history : []).filter((rec) => rec?.id);
  if (!recs.length) return;
  await q`INSERT INTO sessions (profile, id, record)
          SELECT ${profile}, r->>'id', r FROM jsonb_array_elements(${JSON.stringify(recs)}::jsonb) AS r
          ON CONFLICT (profile, id) DO NOTHING`;
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

// ─── Delta sync (#2 family) ────────────────────────────

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
  // Paired fields are written as separate rows with their own updated_at, so
  // a pull can land between them. Return both halves of any pair that moved.
  const meta = assembleMeta(metaRows);
  const missing = [...fieldClosure(Object.keys(meta))].filter((f) => !(f in meta));
  if (missing.length) {
    const extra = await q`SELECT field, value FROM meta WHERE profile = ${profile} AND field = ANY(${missing})`;
    Object.assign(meta, assembleMeta(extra));
  }
  return { meta, history: sessRows.map((r) => r.record), cursor };
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

/** One photo's index row, or null. GET reads the stored blob_path from here
 *  rather than recomputing it — a recomputed path is guessable. */
export async function dbGetPhoto(profile, date) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT date, blob_path, bodyweight_at, taken_at
                       FROM photos WHERE profile = ${profile} AND date = ${date} LIMIT 1`;
  return rows?.[0] || null;
}

// Retiring a lapsed profile's photos. NOT a delete: this rewrites the profile
// key on the index rows so the new holder cannot list or fetch them, while
// every row and blob survives. Recovery is the same statement in reverse.
// The retired key contains "/", which no profile name may hold.
export const retiredPhotoKey = (profile, marker) => `${profile}/retired/${marker}`;

/** MUTATES rows (UPDATE, never DELETE). Returns how many were retired. */
export async function dbRetirePhotos(profile, marker) {
  const q = sql();
  if (!q) return 0;
  await ensureSchema(q);
  const rows = await q`UPDATE photos SET profile = ${retiredPhotoKey(profile, marker)}
                       WHERE profile = ${profile} RETURNING date`;
  return rows?.length || 0;
}

/** Whether earlier photos are held under this name. left(), not LIKE — a name
 *  may legally contain % or _, which LIKE would read as wildcards. */
export async function dbHasRetiredPhotos(profile) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  const prefix = `${profile}/retired/`;
  const rows = await q`SELECT 1 FROM photos
                       WHERE left(profile, ${prefix.length}) = ${prefix} LIMIT 1`;
  return (rows?.length || 0) > 0;
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
export async function dbInsertToken(token, { profile, expires, scope = null, createdAt, authAt = null, credentialId = null, accountId = null }) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await q`INSERT INTO auth_tokens (token, profile, expires, scope, created_at, auth_at, credential_id, account_id)
          VALUES (${tokenKey(token)}, ${profile}, ${expires}, ${scope}, ${createdAt || new Date().toISOString()}, ${authAt}, ${credentialId}, ${accountId})
          ON CONFLICT (token) DO NOTHING`;
  return true;
}

/** Token record in the blob shape ({ profile, expires, scope?, createdAt, authAt?, accountId? })
 *  or null. Expiry is enforced by callers (isTokenValid), same as before. */
export async function dbReadToken(token) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT profile, expires, scope, created_at, auth_at, credential_id, account_id FROM auth_tokens
                       WHERE token = ${tokenKey(token)} OR token = ${legacyKey(token)} LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    profile: r.profile,
    expires: Number(r.expires),
    ...(r.scope ? { scope: r.scope } : {}),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    ...(r.auth_at ? { authAt: r.auth_at instanceof Date ? r.auth_at.toISOString() : String(r.auth_at) } : {}),
    ...(r.credential_id ? { credentialId: String(r.credential_id) } : {}),
    // Null on legacy rows: those resolve by `profile` as a storage key.
    ...(r.account_id ? { accountId: String(r.account_id) } : {}),
  };
}

/** DESTRUCTIVE (relocated, not new): consume ONE used ceremony token — the
 *  wipe path has always deleted its token on success; this is that same
 *  announced behaviour moved from blob del to a row delete. */
export async function dbDeleteToken(token) {
  const q = sql();
  if (!q) return false;
  await ensureSchema(q);
  await q`DELETE FROM auth_tokens WHERE token = ${tokenKey(token)} OR token = ${legacyKey(token)}`;
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
 *  tables, no glob — photo BLOBS are deleted by the wipe (sync DELETE) from
 *  these rows, read before this runs. */
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
