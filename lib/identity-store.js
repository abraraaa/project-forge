// @ts-check
// lib/identity-store.js
// ─────────────────────────────────────────────────────────────────────────────
// Neon reads and writes for accounts, handles and credentials (schema in
// lib/db.js ensureSchema). Every function returns null when no DB is
// configured. Every handle goes through normaliseProfile before it reaches SQL.
//
// Writes here, named: INSERT into credentials; UPDATE of credentials.counter /
// rp_id / last_used_at; UPDATE of accounts.consent. Nothing here deletes.
// The claim, reclaim and close transactions land with the routes that use them.
// ─────────────────────────────────────────────────────────────────────────────

import { sql, ensureSchema } from "./db.js";
import { normaliseProfile } from "./profile-name.js";

/** @param {unknown} v */
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * @typedef {{ id: string, storageKey: string, webauthnUserId: string, roles: string[], plan: string,
 *   consent: any, origin: string, createdAt: string | null, lapsedAt: string | null, deletedAt: string | null }} AccountRow
 */

/** @returns {AccountRow} */
function accountFrom(r) {
  return {
    id: r.id,
    storageKey: r.storage_key,
    webauthnUserId: r.webauthn_user_id,
    roles: Array.isArray(r.roles) ? r.roles : [],
    plan: r.plan,
    consent: r.consent ?? null,
    origin: r.origin,
    createdAt: iso(r.created_at),
    lapsedAt: iso(r.lapsed_at),
    deletedAt: iso(r.deleted_at),
  };
}

async function db() {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  return q;
}

/**
 * The live account holding `name`: a primary handle, or an alias still in its
 * hold. Deleted accounts and released handles never resolve.
 * Returns the account plus `{ accountId, handle, display, kind, claimedAt, holdUntil }`.
 * @param {unknown} name
 */
export async function dbResolveHandle(name) {
  const q = await db();
  if (!q) return null;
  const h = normaliseProfile(name);
  const rows = await q`SELECT a.*, h.handle, h.display, h.kind, h.claimed_at, h.hold_until
                       FROM handles h JOIN accounts a ON a.id = h.account_id
                       WHERE h.handle = ${h} AND h.released_at IS NULL AND a.deleted_at IS NULL
                         AND (h.kind = 'primary' OR h.hold_until > now())
                       LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    ...accountFrom(r),
    accountId: r.id,
    handle: r.handle,
    display: r.display,
    kind: r.kind,
    claimedAt: iso(r.claimed_at),
    holdUntil: iso(r.hold_until),
  };
}

/** @param {string} id */
export async function dbGetAccount(id) {
  const q = await db();
  if (!q) return null;
  const rows = await q`SELECT * FROM accounts WHERE id = ${id} LIMIT 1`;
  return rows.length ? accountFrom(rows[0]) : null;
}

/** Storage keys are frozen and never reassigned, so this is how a legacy
 *  token or grant (no account_id) finds its account.
 *  @param {string} sk */
export async function dbAccountByStorageKey(sk) {
  const q = await db();
  if (!q) return null;
  const rows = await q`SELECT * FROM accounts WHERE storage_key = ${sk} LIMIT 1`;
  return rows.length ? accountFrom(rows[0]) : null;
}

/** An account's credentials in the Blob doc shape (plus source, lastUsedAt).
 *  @param {string} accountId */
export async function dbListCredentials(accountId) {
  const q = await db();
  if (!q) return null;
  const rows = await q`SELECT id, public_key, counter, transports, rp_id, user_handle, source, created_at, last_used_at
                       FROM credentials WHERE account_id = ${accountId} ORDER BY created_at NULLS FIRST, id`;
  return rows.map((r) => ({
    id: r.id,
    publicKey: r.public_key,
    counter: Number(r.counter) || 0,
    transports: Array.isArray(r.transports) ? r.transports : [],
    rpId: r.rp_id,
    userHandle: r.user_handle,
    source: r.source,
    createdAt: iso(r.created_at),
    lastUsedAt: iso(r.last_used_at),
  }));
}

/**
 * INSERT one credential. Idempotent for the same account; a credential id
 * already held by a DIFFERENT account throws (never re-pointed).
 * @param {{ id: string, accountId: string, publicKey: string, counter?: number, transports?: string[],
 *   rpId: string, userHandle: string, source?: "register" | "backfill", createdAt?: string | null }} row
 * @returns {Promise<boolean | null>} true inserted, false already present on this account
 */
export async function dbInsertCredential(row) {
  const q = await db();
  if (!q) return null;
  const inserted = await q`INSERT INTO credentials (id, account_id, public_key, counter, transports, rp_id, user_handle, source, created_at)
          VALUES (${row.id}, ${row.accountId}, ${row.publicKey}, ${row.counter || 0}, ${JSON.stringify(row.transports || [])}::jsonb,
                  ${row.rpId}, ${row.userHandle}, ${row.source || "register"}, ${row.createdAt || null})
          ON CONFLICT (id) DO NOTHING RETURNING id`;
  if (inserted.length) return true;
  const existing = await q`SELECT account_id FROM credentials WHERE id = ${row.id} LIMIT 1`;
  if (existing.length && existing[0].account_id !== row.accountId) {
    throw new Error("credential id belongs to another account");
  }
  return false;
}

/**
 * OVERWRITES counter, rp_id (when given) and last_used_at on one credential of
 * one account: the Neon twin of the sign-in counter write.
 * @param {string} accountId
 * @param {string} id
 * @param {{ counter?: number | null, rpId?: string | null }} [patch]
 * @returns {Promise<boolean | null>} whether a row matched
 */
export async function dbTouchCredential(accountId, id, { counter = null, rpId = null } = {}) {
  const q = await db();
  if (!q) return null;
  const rows = await q`UPDATE credentials
                       SET counter = COALESCE(${counter}, counter), rp_id = COALESCE(${rpId}, rp_id), last_used_at = now()
                       WHERE id = ${id} AND account_id = ${accountId} RETURNING id`;
  return rows.length > 0;
}

/**
 * OVERWRITES accounts.consent for one account: the twin of the credentials-doc
 * consent write.
 * @param {string} accountId
 * @param {{ version: string, at: string } | null} consent
 * @returns {Promise<boolean | null>} whether a row matched
 */
export async function dbSetAccountConsent(accountId, consent) {
  const q = await db();
  if (!q) return null;
  const rows = await q`UPDATE accounts SET consent = ${consent == null ? null : JSON.stringify(consent)}::jsonb
                       WHERE id = ${accountId} RETURNING id`;
  return rows.length > 0;
}
