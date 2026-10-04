// @ts-check
// lib/identity-store.js
// ─────────────────────────────────────────────────────────────────────────────
// Neon reads and writes for accounts, handles and credentials (schema in
// lib/db.js ensureSchema). Every function returns null when no DB is
// configured. Every handle goes through normaliseProfile before it reaches SQL.
//
// Writes here, named: INSERT into credentials; UPDATE of credentials.counter /
// rp_id / last_used_at; UPDATE of accounts.consent; the claim transaction
// (INSERT into accounts and handles, UPDATE of handles.released_at on an
// expired alias only); the reclaim transaction (UPDATE of the lapsed holder's
// handles.released_at; INSERT into accounts, handles and credentials); the
// close transaction run by the user's own profile wipe (UPDATE of the
// account's oauth_grants.revoked_at, handles.released_at, accounts.deleted_at
// and consent; UPDATE of oauth_grants.revoked_at / revoked_by on the trainer
// grants that name the account as trainer; UPDATE of a waiting
// trainer_applications row to 'withdrawn' and clears what any application said; and
// the one DELETE here: the closed account's credentials rows); the trainer
// upgrade (UPDATE of the caller's own accounts.roles, adding 'trainer', and
// accounts.trainer_terms, overwritten in place on re-acceptance); the
// admin's approval of an application (one transaction: the same roles UPDATE
// with trainer_terms taken from the application, and UPDATE of the
// application to 'approved' with decided_at).
// ─────────────────────────────────────────────────────────────────────────────

import { sql, ensureSchema } from "./db.js";
import { normaliseProfile } from "./profile-name.js";
import { newAccountId, newWebauthnUserId, RESERVED_HANDLE_RE } from "./identity.js";

/** @param {unknown} v */
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * @typedef {{ id: string, storageKey: string, webauthnUserId: string, roles: string[], plan: string,
 *   consent: any, trainerTerms: any, origin: string, createdAt: string | null, lapsedAt: string | null,
 *   deletedAt: string | null }} AccountRow
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
    trainerTerms: r.trainer_terms ?? null,
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

/**
 * An account's live primary handle, or null. Read only. Feeds publicName
 * (lib/trainer-view.js), the name a trainer or client is shown by.
 * @param {string} accountId
 * @returns {Promise<{ handle: string, display: string } | null>}
 */
export async function dbPrimaryHandle(accountId) {
  const q = await db();
  if (!q) return null;
  const rows = await q`SELECT handle, display FROM handles
                       WHERE account_id = ${accountId} AND kind = 'primary' AND released_at IS NULL`;
  return rows.length ? { handle: rows[0].handle, display: rows[0].display } : null;
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

/**
 * Make the caller a trainer: one UPDATE on their own live account row that adds
 * 'trainer' to roles (idempotent) and OVERWRITES accounts.trainer_terms with the
 * accepted { version, at, adult }. plan is never written, and no handle is
 * touched: never-lapse follows from the role.
 * @param {string} accountId
 * @param {{ version: string, at: string, adult: true }} terms
 * @returns {Promise<boolean | null>} whether a live row matched
 */
export async function dbGrantTrainerRole(accountId, terms) {
  const q = await db();
  if (!q) return null;
  if (!accountId || typeof terms?.version !== "string" || typeof terms.at !== "string" || terms.adult !== true) {
    throw new Error("incomplete trainer terms");
  }
  const rec = { version: terms.version, at: terms.at, adult: true };
  // array_append, not roles || 'trainer': the untyped literal can resolve as an array.
  const rows = await q`UPDATE accounts SET roles = CASE WHEN 'trainer' = ANY(roles) THEN roles ELSE array_append(roles, 'trainer') END,
                         trainer_terms = ${JSON.stringify(rec)}::jsonb
                       WHERE id = ${accountId} AND deleted_at IS NULL RETURNING id`;
  return rows.length > 0;
}

/**
 * The admin approves an application to coach. One transaction, all or
 * nothing, on a live account with a waiting application:
 *   - UPDATE accounts: add 'trainer' to roles (idempotent) and OVERWRITE
 *     trainer_terms with the terms accepted on the application;
 *   - UPDATE trainer_applications: status 'approved', decided_at.
 * plan is never written. Before the first approval in production, the owner
 * reads who already holds the role (read only):
 *   SELECT id FROM accounts WHERE 'trainer' = ANY(roles)
 * @param {string} accountId
 * @param {number} [now]
 * @returns {Promise<boolean | null>} whether a waiting application was approved
 */
export async function dbApproveApplication(accountId, now = Date.now()) {
  const q = await db();
  if (!q) return null;
  if (!accountId) throw new Error("incomplete approval");
  const [role, app] = await q.transaction([
    q`UPDATE accounts SET roles = CASE WHEN 'trainer' = ANY(roles) THEN roles ELSE array_append(roles, 'trainer') END,
        trainer_terms = ta.terms
      FROM trainer_applications ta
      WHERE accounts.id = ${accountId} AND accounts.deleted_at IS NULL AND ta.account_id = accounts.id AND ta.status = 'applied'
      RETURNING accounts.id`,
    q`UPDATE trainer_applications SET status = 'approved', decided_at = ${now}
      WHERE account_id = ${accountId} AND status = 'applied'
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = ${accountId} AND a.deleted_at IS NULL)
      RETURNING account_id`,
  ]);
  return Array.isArray(role) && role.length > 0 && Array.isArray(app) && app.length > 0;
}

/**
 * The mode the sync claim route creates accounts in. "claim" keys a new
 * account by its id; "precutover" keyed it by its handle, so a rollback to
 * the name-keyed routes would still find it. dbClaimHandle accepts both. A
 * name that still keys a closed or lapsed account is claimed by id in either
 * mode (sync POST).
 * @type {"precutover" | "claim"}
 */
export const CLAIM_MODE = "claim";

/**
 * Claim a handle: one transaction that releases an expired alias of it (no-op
 * until renames exist), creates the account and inserts its live handle. A
 * live holder trips the unique index (23505) and the whole transaction rolls
 * back, account included.
 * Mode "precutover": the storage key is the handle (routes still key by name).
 * Mode "claim": the storage key is the new account id.
 * @param {{ handle: unknown, display: string, mode: "precutover" | "claim" }} args
 * @returns {Promise<null | { taken: true } | { taken: false, accountId: string, storageKey: string, webauthnUserId: string }>}
 */
export async function dbClaimHandle({ handle, display, mode }) {
  const q = await db();
  if (!q) return null;
  const h = normaliseProfile(handle);
  // The handle may become a storage key, and paths are built from it; it must
  // also be a fixed point of normaliseProfile, or it could alias another key.
  if (!h || RESERVED_HANDLE_RE.test(h) || /^\.+$|[/\\]/.test(h) || normaliseProfile(h) !== h) throw new Error("handle not claimable");
  if (mode !== "precutover" && mode !== "claim") throw new Error("unknown claim mode");
  const id = newAccountId();
  const uid = newWebauthnUserId();
  const [sk, origin] = mode === "claim" ? [id, "claim"] : [h, "precutover_claim"];
  try {
    await q.transaction([
      q`UPDATE handles SET released_at = now()
        WHERE handle = ${h} AND kind = 'alias' AND hold_until <= now() AND released_at IS NULL`,
      q`INSERT INTO accounts (id, storage_key, webauthn_user_id, origin) VALUES (${id}, ${sk}, ${uid}, ${origin})`,
      q`INSERT INTO handles (handle, account_id, display) VALUES (${h}, ${id}, ${display})`,
    ]);
  } catch (e) {
    // A live handle, or (pre-cutover) a storage key already held: taken either way.
    if (/** @type {any} */ (e)?.code === "23505") return { taken: true };
    throw e;
  }
  return { taken: false, accountId: id, storageKey: sk, webauthnUserId: uid };
}

/**
 * Reclaim a lapsed handle: one transaction that releases the previous
 * holder's live handle row (an UPDATE of released_at; the row and its history
 * stay), creates a NEW account keyed by its own id, gives it the handle and
 * indexes the passkey that proved the claim. The previous account and every
 * row keyed to it are left exactly as they were: nothing is inherited.
 * A concurrent claimant trips the live-handle index (23505) and the whole
 * transaction rolls back.
 * @param {{ handle: unknown, display: string, fromAccountId: string, webauthnUserId: string,
 *   consent: { version: string, at: string } | null | undefined,
 *   credential: { id: string, publicKey: string, counter?: number, transports?: string[], rpId: string, createdAt?: string | null } }} args
 * @returns {Promise<null | { taken: true } | { taken: false, accountId: string, storageKey: string, webauthnUserId: string }>}
 */
export async function dbReclaimHandle({ handle, display, fromAccountId, webauthnUserId, consent, credential }) {
  const q = await db();
  if (!q) return null;
  const h = normaliseProfile(handle);
  if (!h || RESERVED_HANDLE_RE.test(h)) throw new Error("handle not claimable");
  if (!fromAccountId || !webauthnUserId || !credential?.id) throw new Error("incomplete reclaim");
  const id = newAccountId();
  const c = credential;
  try {
    await q.transaction([
      q`UPDATE handles SET released_at = now()
        WHERE handle = ${h} AND account_id = ${fromAccountId} AND released_at IS NULL`,
      q`INSERT INTO accounts (id, storage_key, webauthn_user_id, consent, origin)
        VALUES (${id}, ${id}, ${webauthnUserId}, ${consent ? JSON.stringify(consent) : null}::jsonb, 'reclaim')`,
      q`INSERT INTO handles (handle, account_id, display) VALUES (${h}, ${id}, ${display})`,
      q`INSERT INTO credentials (id, account_id, public_key, counter, transports, rp_id, user_handle, source, created_at)
        VALUES (${c.id}, ${id}, ${c.publicKey}, ${c.counter || 0}, ${JSON.stringify(c.transports || [])}::jsonb,
                ${c.rpId}, ${webauthnUserId}, 'register', ${c.createdAt || null})`,
    ]);
  } catch (e) {
    if (/** @type {any} */ (e)?.code === "23505") return { taken: true };
    throw e;
  }
  return { taken: false, accountId: id, storageKey: id, webauthnUserId };
}

/**
 * Close an account, as the last step of its holder's own passkey-gated
 * profile wipe. One transaction, all or nothing:
 *   - REVOKES its grants, AI and any trainer share it gave (UPDATE
 *     revoked_at): rows minted for the account, and legacy rows (no account
 *     id) whose profile is its storage key;
 *   - RELEASES its live handles (UPDATE released_at), so the name is free;
 *   - CLOSES the account (UPDATE deleted_at) and CLEARS its consent record
 *     (consent = NULL): withdrawing consent is deleting the profile;
 *   - DELETES its credentials rows, so the passkey is gone from our servers;
 *   - REVOKES the trainer grants that name it as trainer (UPDATE revoked_at,
 *     revoked_by = 'closed'), so its clients' shares end with it;
 *   - WITHDRAWS a waiting application to coach and CLEARS what it said
 *     (UPDATE status 'withdrawn', about and link NULL).
 * Nothing else is touched; account, handle and grant rows stay as history.
 * @param {string} accountId
 * @param {string} storageKey
 * @returns {Promise<boolean | null>}
 */
export async function dbCloseAccount(accountId, storageKey) {
  const q = await db();
  if (!q) return null;
  if (!accountId || !storageKey) throw new Error("incomplete close");
  const nowMs = Date.now();
  await q.transaction([
    q`UPDATE oauth_grants SET revoked_at = ${nowMs}
      WHERE (account_id = ${accountId} OR (account_id IS NULL AND profile = ${storageKey})) AND revoked_at IS NULL`,
    q`UPDATE handles SET released_at = now()
      WHERE account_id = ${accountId} AND released_at IS NULL`,
    q`UPDATE accounts SET deleted_at = now(), consent = NULL
      WHERE id = ${accountId}`,
    q`DELETE FROM credentials WHERE account_id = ${accountId}`,
    q`UPDATE oauth_grants SET revoked_at = ${nowMs}, revoked_by = 'closed'
      WHERE kind = 'trainer' AND trainer_account_id = ${accountId} AND revoked_at IS NULL`,
    q`UPDATE trainer_applications SET status = CASE WHEN status = 'applied' THEN 'withdrawn' ELSE status END, decided_at = CASE WHEN status = 'applied' THEN ${nowMs} ELSE decided_at END, about = NULL, link = NULL
      WHERE account_id = ${accountId}`,
  ]);
  return true;
}
