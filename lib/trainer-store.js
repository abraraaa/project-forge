// @ts-check
// lib/trainer-store.js
// ─────────────────────────────────────────────────────────────────────────────
// Neon reads, and the named writes, for the trainer surfaces (schema in
// lib/db.js ensureSchema).
// Every function returns null when no DB is configured. Server-only.
//
// Writes here, named:
//   · dbIssueInvite: the trainer's one invite slot, overwritten in place.
//   · dbCancelInvite: UPDATE trainer_invites.expires_at on that slot.
//   · dbApproveTrainer: one transaction that marks the invite used (UPDATE
//     used_at, grant_id), ends the client's current trainer grant when the
//     route says it may (UPDATE revoked_at, revoked_by = 'replaced') and
//     INSERTs the new kind='trainer' grant.
// The trainer role write is dbGrantTrainerRole (lib/identity-store.js); token
// expiry is dbExpireToken and dbExpireTrainerSessions (lib/db.js).
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { sql, ensureSchema } from "./db.js";
import { hashSecret, newSecret, TRAINER_RESOURCE } from "./oauth.js";
import { crockford, normaliseCode, CODE_LENGTH } from "./trainer-code.js";
import { publicName } from "./trainer-view.js";
import { entitled } from "./entitlements.js";
import { isCurrentTrainerTerms } from "./trainer-terms.js";
import { trainerOpenFor } from "./auth-server.js";
import { dbPrimaryHandle } from "./identity-store.js";

/**
 * @typedef {{ roles: string[], plan: string, trainerTerms: any, deletedAt: string | null, credLive: boolean }} TrainerAccount
 */

/**
 * One account's roles, plan, Trainer Terms and closure, plus whether the given
 * passkey is in the credentials index under heatwayve.app. One SELECT: the
 * index row is what sign-in stamps with the verified rpId, so a legacy or
 * Blob-only passkey reads as not live.
 * @param {string} accountId
 * @param {string | null | undefined} credentialId
 * @returns {Promise<TrainerAccount | null>}
 */
export async function dbTrainerAccount(accountId, credentialId) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT a.roles, a.plan, a.trainer_terms, a.deleted_at,
         EXISTS (SELECT 1 FROM credentials c WHERE c.id = ${credentialId ?? null} AND c.account_id = a.id AND c.rp_id = 'heatwayve.app') AS cred_live
  FROM accounts a WHERE a.id = ${accountId}`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    roles: Array.isArray(r.roles) ? r.roles : [],
    plan: r.plan,
    trainerTerms: r.trainer_terms ?? null,
    deletedAt: r.deleted_at == null ? null : r.deleted_at instanceof Date ? r.deleted_at.toISOString() : String(r.deleted_at),
    credLive: r.cred_live === true,
  };
}

// ── Invite codes ────────────────────────────────────────────────────────────

export const INVITE_TTL_MS = 60 * 60 * 1000;

/** 8 random bytes give 12 full 5-bit characters: 60 uniform bits. */
export const newInviteCode = () => crockford(randomBytes(8)).slice(0, CODE_LENGTH);

/**
 * SHA-256 hex of the canonical code: the only form stored. Null for anything
 * that is not a code.
 * @param {unknown} code
 */
export function codeHash(code) {
  const c = normaliseCode(code);
  return c ? hashSecret(c) : null;
}

/**
 * OVERWRITES the trainer's one invite slot in place: a new code hash, a fresh
 * 60 minutes, used_at and grant_id cleared. The previous code dies with it.
 * A clash on the code index (23505) throws to the caller.
 * @param {string} trainerId
 * @param {string} hash  codeHash of the new code
 * @param {number} [now]
 * @returns {Promise<{ expiresAt: number } | null>}
 */
export async function dbIssueInvite(trainerId, hash, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const expiresAt = now + INVITE_TTL_MS;
  await q`INSERT INTO trainer_invites (trainer_account_id, code_hash, issued_at, expires_at, used_at, grant_id)
  VALUES (${trainerId}, ${hash}, ${now}, ${expiresAt}, NULL, NULL)
  ON CONFLICT (trainer_account_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, issued_at = EXCLUDED.issued_at,
    expires_at = EXCLUDED.expires_at, used_at = NULL, grant_id = NULL`;
  return { expiresAt };
}

/**
 * Mint a code and write it to the trainer's slot (dbIssueInvite), minting once
 * more if the first one clashes with another trainer's live hash.
 * @param {string} trainerId
 * @param {number} [now]
 * @param {() => string} [mint]  injectable for tests
 * @returns {Promise<{ code: string, expiresAt: number } | null>}
 */
export async function issueInvite(trainerId, now = Date.now(), mint = newInviteCode) {
  for (let attempt = 0; ; attempt++) {
    const code = mint();
    try {
      const r = await dbIssueInvite(trainerId, hashSecret(code), now);
      return r && { code, expiresAt: r.expiresAt };
    } catch (e) {
      if (attempt > 0 || /** @type {any} */ (e)?.code !== "23505") throw e;
    }
  }
}

/**
 * Ends the trainer's pending code now: UPDATE expires_at, the row stays.
 * @param {string} trainerId
 * @param {number} [now]
 * @returns {Promise<boolean | null>} whether a pending code was ended
 */
export async function dbCancelInvite(trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE trainer_invites SET expires_at = ${now}
  WHERE trainer_account_id = ${trainerId} AND used_at IS NULL AND expires_at > ${now} RETURNING trainer_account_id`;
  return rows.length > 0;
}

/**
 * @typedef {{ status: "none" | "pending" | "used" | "expired", expiresAt: number | null, usedBy?: string }} InviteStatus
 */

/**
 * The state of the trainer's slot. usedBy names the client only while the
 * grant the code made is still live and names this trainer. One SELECT.
 * @param {string} trainerId
 * @param {number} [now]
 * @returns {Promise<InviteStatus | null>}
 */
export async function dbInviteStatus(trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT i.expires_at, i.used_at, h.handle, h.display
  FROM trainer_invites i
  LEFT JOIN oauth_grants g ON g.id = i.grant_id AND g.kind = 'trainer' AND g.trainer_account_id = i.trainer_account_id AND g.revoked_at IS NULL
  LEFT JOIN handles h ON h.account_id = g.account_id AND h.kind = 'primary' AND h.released_at IS NULL
  WHERE i.trainer_account_id = ${trainerId}`;
  if (!rows.length) return { status: "none", expiresAt: null };
  const r = rows[0];
  const expiresAt = Number(r.expires_at);
  if (r.used_at != null) {
    const usedBy = publicName({ handle: r.handle, display: r.display });
    return usedBy ? { status: "used", expiresAt, usedBy } : { status: "used", expiresAt };
  }
  return { status: expiresAt <= now ? "expired" : "pending", expiresAt };
}

// ── Peek and approve (the client's side of a code) ──────────────────────────

/**
 * @typedef {{ trainerId: string, storageKey: string, roles: string[], plan: string,
 *   trainerTerms: any, expiresAt: number }} PendingInvite
 */

/**
 * The pending invite with this code hash, and its trainer's account, if that
 * account is open. One SELECT; who may be named is peekInvite's check.
 * @param {string} hash
 * @param {number} [now]
 * @returns {Promise<PendingInvite | null>}
 */
export async function dbPeekInvite(hash, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT i.trainer_account_id, i.expires_at, a.id, a.storage_key, a.roles, a.plan, a.trainer_terms
  FROM trainer_invites i JOIN accounts a ON a.id = i.trainer_account_id AND a.deleted_at IS NULL
  WHERE i.code_hash = ${hash} AND i.used_at IS NULL AND i.expires_at > ${now}`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    trainerId: r.trainer_account_id,
    storageKey: r.storage_key,
    roles: Array.isArray(r.roles) ? r.roles : [],
    plan: r.plan,
    trainerTerms: r.trainer_terms ?? null,
    expiresAt: Number(r.expires_at),
  };
}

/**
 * A typed or pasted code, resolved to the trainer it names. Null for every
 * kind of miss alike: malformed, unknown, used, expired, a closed account,
 * not a trainer, terms not current, or the launch switch closed for them.
 * @param {unknown} code
 * @param {number} [now]
 * @returns {Promise<{ hash: string, trainerId: string, name: string | null, expiresAt: number } | null>}
 */
export async function peekInvite(code, now = Date.now()) {
  const hash = codeHash(code);
  if (!hash) return null;
  const row = await dbPeekInvite(hash, now);
  if (!row) return null;
  if (!entitled(row, "trainer.invite") || !isCurrentTrainerTerms(row.trainerTerms)) return null;
  if (!trainerOpenFor({ accountId: row.trainerId, storageKey: row.storageKey })) return null;
  const name = publicName(await dbPrimaryHandle(row.trainerId));
  return { hash, trainerId: row.trainerId, name, expiresAt: row.expiresAt };
}

/**
 * The client's current trainer grant, live or paused (no liveness join): the
 * one the partial unique index allows. One SELECT.
 * @param {string} clientId
 * @returns {Promise<{ id: string, trainerId: string } | null>}
 */
export async function dbActiveTrainerGrant(clientId) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT id, trainer_account_id FROM oauth_grants WHERE account_id = ${clientId} AND kind = 'trainer' AND revoked_at IS NULL`;
  return rows.length ? { id: rows[0].id, trainerId: rows[0].trainer_account_id } : null;
}

/**
 * Approve a trainer: one transaction, in order.
 *   S1 marks the invite used and stamps it with the new grant id. It matches
 *      only a pending code that is not the client's own.
 *   S2 ends the client's current trainer grant (revoked_by = 'replaced'), but
 *      only the one the route passed as `replacing`: the grant the client
 *      confirmed switching from, or a grant with the same trainer. Null ends
 *      nothing, so a grant that appeared since the check trips the index.
 *   S3 INSERTs the grant, owned by the client, naming the trainer:
 *      scope 'trainer:read' (TRAINER_SCOPE), empty look ring, count 0.
 * S2 and S3 run only if S1 stamped this grant id, so a lost race writes
 * nothing. A second live trainer grant trips oauth_grants_one_trainer (23505)
 * and the whole transaction rolls back.
 * @param {{ hash: string, clientId: string, storageKey: string, credentialId: string,
 *   consentVersion: string, replacing: string | null }} args
 * @param {number} [now]
 * @returns {Promise<{ grantId: string } | { miss: true } | { conflict: true } | null>}
 */
export async function dbApproveTrainer({ hash, clientId, storageKey, credentialId, consentVersion, replacing }, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const gid = `hwg_${newSecret()}`;
  let results;
  try {
    results = await q.transaction([
      q`UPDATE trainer_invites SET used_at = ${now}, grant_id = ${gid}
        WHERE code_hash = ${hash} AND used_at IS NULL AND expires_at > ${now} AND trainer_account_id <> ${clientId}`,
      q`UPDATE oauth_grants SET revoked_at = ${now}, revoked_by = 'replaced'
        WHERE account_id = ${clientId} AND kind = 'trainer' AND revoked_at IS NULL AND id = ${replacing ?? null}
        AND EXISTS (SELECT 1 FROM trainer_invites i JOIN accounts t ON t.id = i.trainer_account_id AND t.deleted_at IS NULL WHERE i.grant_id = ${gid})`,
      q`INSERT INTO oauth_grants (id, client_id, account_id, profile, credential_id, scope, created_at, kind, resource, expires_at, trainer_account_id, consent_version, looks, look_count)
        SELECT ${gid}, 'hw:trainer', ${clientId}, ${storageKey}, ${credentialId}, 'trainer:read', ${now}, 'trainer', ${TRAINER_RESOURCE}, NULL, i.trainer_account_id, ${consentVersion}, '[]'::jsonb, 0
        FROM trainer_invites i JOIN accounts t ON t.id = i.trainer_account_id AND t.deleted_at IS NULL WHERE i.grant_id = ${gid} RETURNING id`,
    ]);
  } catch (e) {
    if (/** @type {any} */ (e)?.code === "23505") return { conflict: true };
    throw e;
  }
  return results?.[2]?.length ? { grantId: gid } : { miss: true };
}
