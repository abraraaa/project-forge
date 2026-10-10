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
//     INSERTs the new kind='trainer' grant, with plan changes on (edits_at).
//   · dbLogFullLook: the client's look ring on the grant row, rewritten in
//     place (at most 20 entries; the oldest is pushed out), look_count and
//     last_used_at. Runs before any of the client's data is read.
//   · dbRosterSignals: a roster look on each listed client's ring (once per
//     London day, same ring and overwrite as above) and look_count, in one
//     transaction before the roster's read.
//   · dbRemoveByTrainer: UPDATE revoked_at, revoked_by = 'trainer'.
//   · dbSeenEndedNotice: UPDATE notice_seen_at on the client's own ended
//     trainer grant, once, when they dismiss the ended notice.
//   · dbApplyTrainer: the account's one application row, INSERTed or
//     overwritten in place (about, link, terms, status 'applied', applied_at;
//     decided_at and seen_at cleared), only over a withdrawn row or a denial
//     at least 30 days old.
//   · dbWithdrawApplication: UPDATE status 'withdrawn', decided_at on the
//     applicant's own waiting row.
//   · dbSeenApplication: UPDATE seen_at on the applicant's own decided row, once.
//   · dbDenyApplication: UPDATE status 'denied', decided_at on a waiting row
//     (the admin's "Not this time").
// Approval is dbApproveApplication (lib/identity-store.js).
// The trainer role write is dbGrantTrainerRole (lib/identity-store.js); token
// expiry is dbExpireToken and dbExpireTrainerSessions (lib/db.js).
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { sql, ensureSchema } from "./db.js";
import { hashSecret, newSecret, TRAINER_RESOURCE } from "./oauth.js";
import { crockford, normaliseCode, CODE_LENGTH } from "./trainer-code.js";
import { publicName, ROSTER_RECENT_DAYS, TREND_DAYS, LOOK_RING } from "./trainer-view.js";
import { addDaysIso } from "./dates.js";
import { entitled } from "./entitlements.js";
import { isCurrentTrainerTerms } from "./trainer-terms.js";
import { trainerOpenFor } from "./auth-server.js";
import { dbPrimaryHandle } from "./identity-store.js";
import { REAPPLY_AFTER_MS } from "./trainer-apply.js";

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
 *      scope 'trainer:read' (TRAINER_SCOPE), empty look ring, count 0, and
 *      edits_at = now: the share consent the route checked includes plan changes.
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
      q`INSERT INTO oauth_grants (id, client_id, account_id, profile, credential_id, scope, created_at, kind, resource, expires_at, trainer_account_id, consent_version, looks, look_count, edits_at)
        SELECT ${gid}, 'hw:trainer', ${clientId}, ${storageKey}, ${credentialId}, 'trainer:read', ${now}, 'trainer', ${TRAINER_RESOURCE}, NULL, i.trainer_account_id, ${consentVersion}, '[]'::jsonb, 0, ${now}
        FROM trainer_invites i JOIN accounts t ON t.id = i.trainer_account_id AND t.deleted_at IS NULL WHERE i.grant_id = ${gid} RETURNING id`,
    ]);
  } catch (e) {
    if (/** @type {any} */ (e)?.code === "23505") return { conflict: true };
    throw e;
  }
  return results?.[2]?.length ? { grantId: gid } : { miss: true };
}

// ── The trainer's clients ───────────────────────────────────────────────────

/**
 * @typedef {{ ref: string, profile: string, scope: string, since: number,
 *   lastLooked: number | null, name: string | null, edits: boolean, editsAt: number | null,
 *   consentVersion: string | null }} TrainerGrant
 * edits: the client has the trainer's changes on (editsLive); editsAt: when they last turned them on.
 * consentVersion: the share consent the client approved (a session needs the current one).
 */

/**
 * Whether a grant's changes are on: edits_at set and edits_off_at not later
 * (epoch ms). The grant's own liveness is the caller's predicate.
 * @param {unknown} editsAt
 * @param {unknown} editsOffAt
 */
export function editsLive(editsAt, editsOffAt) {
  if (editsAt == null) return false;
  return editsOffAt == null || Number(editsOffAt) < Number(editsAt);
}

/**
 * A trainer's live grants: not revoked, the client's account open, and the
 * passkey that approved it still in the index under heatwayve.app. With a
 * ref, only that grant. The list and the client view share this predicate;
 * a grant that fails it is filtered out, never written.
 * @param {string} trainerId
 * @param {string} [ref]
 * @returns {Promise<TrainerGrant[] | null>}
 */
export async function dbTrainerGrants(trainerId, ref) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = ref === undefined
    ? await q`SELECT g.id, g.profile, g.scope, g.created_at, g.last_used_at, g.edits_at, g.edits_off_at, g.consent_version, h.handle, h.display
  FROM oauth_grants g
  JOIN accounts a ON a.id = g.account_id AND a.deleted_at IS NULL
  JOIN credentials c ON c.id = g.credential_id AND c.account_id = g.account_id AND c.rp_id = 'heatwayve.app'
  LEFT JOIN handles h ON h.account_id = g.account_id AND h.kind = 'primary' AND h.released_at IS NULL
  WHERE g.kind = 'trainer' AND g.trainer_account_id = ${trainerId} AND g.revoked_at IS NULL
  ORDER BY g.created_at DESC`
    : await q`SELECT g.id, g.profile, g.scope, g.created_at, g.last_used_at, g.edits_at, g.edits_off_at, g.consent_version, h.handle, h.display
  FROM oauth_grants g
  JOIN accounts a ON a.id = g.account_id AND a.deleted_at IS NULL
  JOIN credentials c ON c.id = g.credential_id AND c.account_id = g.account_id AND c.rp_id = 'heatwayve.app'
  LEFT JOIN handles h ON h.account_id = g.account_id AND h.kind = 'primary' AND h.released_at IS NULL
  WHERE g.kind = 'trainer' AND g.trainer_account_id = ${trainerId} AND g.revoked_at IS NULL AND g.id = ${ref}
  ORDER BY g.created_at DESC`;
  return rows.map((r) => ({
    ref: r.id,
    profile: r.profile,
    scope: r.scope,
    since: Number(r.created_at),
    lastLooked: r.last_used_at == null ? null : Number(r.last_used_at),
    name: publicName({ handle: r.handle, display: r.display }),
    edits: editsLive(r.edits_at, r.edits_off_at),
    editsAt: r.edits_at == null ? null : Number(r.edits_at),
    consentVersion: typeof r.consent_version === "string" ? r.consent_version : null,
  }));
}

/**
 * Log a full look on the grant before any data is read. OVERWRITES the
 * client's access-log ring in place: a full look within 15 minutes of a
 * newest full look refreshes that entry's time and counts nothing; otherwise
 * { k: 'v', at } is prepended and the ring keeps its newest 20 (the oldest
 * entry is pushed out; look_count keeps the total). Every SET reads the row
 * as it was, so looks and look_count take the same branch. nextLooks in
 * lib/trainer-view.js mirrors it.
 * @param {string} ref
 * @param {string} trainerId
 * @param {number} [now]
 * @returns {Promise<boolean | null>} false when the grant is no longer live for this trainer
 */
export async function dbLogFullLook(ref, trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE oauth_grants SET
  looks = CASE
    WHEN looks->0->>'k' = 'v' AND (looks->0->>'at')::bigint > ${now}::bigint - 900000
      THEN jsonb_set(looks, '{0,at}', to_jsonb(${now}::bigint))
    ELSE jsonb_path_query_array(
      jsonb_build_array(jsonb_build_object('k', 'v', 'at', ${now}::bigint)) || COALESCE(looks, '[]'::jsonb),
      '$[0 to 19]')
  END,
  look_count = CASE
    WHEN looks->0->>'k' = 'v' AND (looks->0->>'at')::bigint > ${now}::bigint - 900000
      THEN COALESCE(look_count, 0)
    ELSE COALESCE(look_count, 0) + 1
  END,
  last_used_at = ${now}
WHERE id = ${ref} AND kind = 'trainer' AND trainer_account_id = ${trainerId} AND revoked_at IS NULL
RETURNING id`;
  return rows.length > 0;
}

/**
 * The trainer stops seeing a client: UPDATE revoked_at, revoked_by = 'trainer'.
 * The row stays (the client sees who ended it).
 * @param {string} ref
 * @param {string} trainerId
 * @param {number} [now]
 * @returns {Promise<boolean | null>} whether a live grant of this trainer's was ended
 */
export async function dbRemoveByTrainer(ref, trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE oauth_grants SET revoked_at = ${now}, revoked_by = 'trainer'
  WHERE id = ${ref} AND kind = 'trainer' AND trainer_account_id = ${trainerId} AND revoked_at IS NULL RETURNING id`;
  return rows.length > 0;
}

/**
 * @typedef {{ recent: any[], lastDate: string | null, userWeek: unknown, breaks: unknown }} RosterRow
 */

/**
 * The roster: log, then read, as one transaction. If the log throws, the
 * transaction fails and nothing is read.
 *   1. A roster look { k: 'r', d: day, at } on every listed grant whose ring
 *      holds no roster entry for that London day. OVERWRITES the client's
 *      access-log ring in place (newest 20 kept; the oldest is pushed out),
 *      look_count + 1. nextLooks in lib/trainer-view.js mirrors it.
 *   2. One aggregate SELECT over the same grants: per client the sessions
 *      dated in the last 35 days (id, date, session, letter only), the latest
 *      session date within 12 months, and the schedule and breathers. These
 *      stay on the server; rosterSignal turns them into five values.
 * refs is the live set from dbTrainerGrants; an empty set runs nothing.
 * @param {string} trainerId
 * @param {string[]} refs
 * @param {{ day: string, today: string, now?: number }} opts  day: rosterDay(now); today: trainerToday
 * @returns {Promise<Map<string, RosterRow> | null>}
 */
export async function dbRosterSignals(trainerId, refs, { day, today, now = Date.now() }) {
  const q = sql();
  if (!q) return null;
  if (!refs.length) return new Map();
  await ensureSchema(q);
  const recentFrom = addDaysIso(today, -ROSTER_RECENT_DAYS);
  const trendFrom = addDaysIso(today, -TREND_DAYS);
  const [, rows] = await q.transaction([
    q`UPDATE oauth_grants SET
  looks = jsonb_path_query_array(
    jsonb_build_array(jsonb_build_object('k', 'r', 'd', ${day}::text, 'at', ${now}::bigint)) || COALESCE(looks, '[]'::jsonb),
    '$[0 to 19]'),
  look_count = COALESCE(look_count, 0) + 1
WHERE id = ANY(${refs}) AND kind = 'trainer' AND trainer_account_id = ${trainerId} AND revoked_at IS NULL
  AND NOT COALESCE(looks @> jsonb_build_array(jsonb_build_object('k', 'r', 'd', ${day}::text)), false)`,
    q`SELECT g.id AS ref,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'date', s.record->>'date',
            'session', s.record->'session', 'scheduledLetter', s.record->'scheduledLetter') ORDER BY s.id), '[]'::jsonb)
     FROM sessions s WHERE s.profile = g.profile AND s.record->>'date' BETWEEN ${recentFrom} AND ${today}) AS recent,
  (SELECT max(s.record->>'date') FROM sessions s
     WHERE s.profile = g.profile AND s.record->>'date' BETWEEN ${trendFrom} AND ${today}) AS last_date,
  (SELECT m.value FROM meta m WHERE m.profile = g.profile AND m.field = 'userWeek') AS user_week,
  (SELECT m.value FROM meta m WHERE m.profile = g.profile AND m.field = 'breaks') AS breaks
FROM oauth_grants g
WHERE g.id = ANY(${refs}) AND g.kind = 'trainer' AND g.trainer_account_id = ${trainerId} AND g.revoked_at IS NULL`,
  ]);
  /** @type {Map<string, RosterRow>} */
  const out = new Map();
  for (const r of rows ?? []) {
    out.set(r.ref, {
      recent: Array.isArray(r.recent) ? r.recent : [],
      lastDate: typeof r.last_date === "string" ? r.last_date : null,
      userWeek: r.user_week ?? null,
      breaks: r.breaks ?? null,
    });
  }
  return out;
}

// ── The client's side ───────────────────────────────────────────────────────

/** An ended notice shows for this long after the trainer's side ended it. */
export const ENDED_NOTICE_MS = 30 * 86_400_000;

/**
 * @typedef {{ kind: "view" | "roster", at: number, day?: string }} ClientLook
 * @typedef {{ ref: string, name: string | null, since: number, live: boolean, consentVersion: string | null,
 *   looks: ClientLook[], lookCount: number }} ClientSharing
 * @typedef {{ ref: string, name: string | null, at: number, by: "trainer" | "closed" }} ClientEnded
 */

/**
 * The client's ring entries as the client is shown them: kind, time, and the
 * London day for a roster check-in. Nothing else on an entry is passed on.
 * @param {unknown} looks
 * @returns {ClientLook[]}
 */
function clientLooks(looks) {
  if (!Array.isArray(looks)) return [];
  /** @type {ClientLook[]} */
  const out = [];
  for (const e of looks.slice(0, LOOK_RING)) {
    const at = Number(e?.at);
    if (!Number.isFinite(at)) continue;
    if (e.k === "r") out.push(typeof e.d === "string" ? { kind: "roster", at, day: e.d } : { kind: "roster", at });
    else if (e.k === "v") out.push({ kind: "view", at });
  }
  return out;
}

/**
 * The client's trainer share, for Profile. One SELECT of the client's newest
 * trainer grant (the live one first), with:
 *   · live: the client's account open and the approving passkey still in the
 *     index under heatwayve.app (the same join as dbTrainerGrants), and the
 *     trainer open, a trainer, and on the current terms. Not live reads as
 *     paused; nothing is written.
 *   · the trainer's name: their live primary handle, or for a closed trainer
 *     the one they had (close releases it; it never names a later holder).
 *   · the look ring and its total, straight from the row.
 * `ended` is set only when there is no live share and the newest grant was
 * ended by the trainer or their account closing, within 30 days, and the
 * client has not dismissed it (notice_seen_at). A share the client stopped,
 * or one replaced by a new trainer, has no notice.
 * @param {string} clientId
 * @param {number} [now]
 * @returns {Promise<{ sharing: ClientSharing | null, ended: ClientEnded | null, noticeSeenAt: number | null } | null>}
 */
export async function dbClientShare(clientId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT g.id, g.created_at, g.revoked_at, g.revoked_by, g.consent_version, g.looks, g.look_count, g.notice_seen_at,
  EXISTS (SELECT 1 FROM accounts a JOIN credentials c ON c.account_id = a.id
          WHERE a.id = g.account_id AND a.deleted_at IS NULL AND c.id = g.credential_id AND c.rp_id = 'heatwayve.app') AS client_live,
  t.roles AS trainer_roles, t.plan AS trainer_plan, t.trainer_terms, t.deleted_at AS trainer_deleted_at,
  h.handle, h.display
FROM oauth_grants g
LEFT JOIN accounts t ON t.id = g.trainer_account_id
LEFT JOIN LATERAL (SELECT handle, display FROM handles
  WHERE account_id = g.trainer_account_id AND kind = 'primary'
  ORDER BY released_at DESC NULLS FIRST LIMIT 1) h ON true
WHERE g.account_id = ${clientId} AND g.kind = 'trainer'
ORDER BY (g.revoked_at IS NULL) DESC, g.created_at DESC
LIMIT 1`;
  if (!rows.length) return { sharing: null, ended: null, noticeSeenAt: null };
  const r = rows[0];
  const noticeSeenAt = r.notice_seen_at == null ? null : Number(r.notice_seen_at);
  const name = publicName({ handle: r.handle, display: r.display });
  if (r.revoked_at == null) {
    const trainer = { roles: Array.isArray(r.trainer_roles) ? r.trainer_roles : [], plan: r.trainer_plan };
    const live = r.client_live === true && r.trainer_deleted_at == null
      && entitled(trainer, "trainer.dashboard") && isCurrentTrainerTerms(r.trainer_terms);
    return {
      sharing: {
        ref: r.id,
        name,
        since: Number(r.created_at),
        live,
        consentVersion: typeof r.consent_version === "string" ? r.consent_version : null,
        looks: clientLooks(r.looks),
        lookCount: Number(r.look_count) || 0,
      },
      ended: null,
      noticeSeenAt,
    };
  }
  const at = Number(r.revoked_at);
  const by = r.revoked_by;
  const ended = (by === "trainer" || by === "closed") && at > now - ENDED_NOTICE_MS && noticeSeenAt == null
    ? { ref: r.id, name, at, by } : null;
  return { sharing: null, ended, noticeSeenAt };
}

/**
 * The client dismisses the ended notice ("Got it"). A named UPDATE of
 * notice_seen_at on their own ended trainer grant, once; the grant row and
 * its look log stay as they are. False when there is no such notice (already
 * seen, still live, someone else's, or not a trainer grant).
 * @param {string} clientId
 * @param {string} grantId
 * @param {number} [now]
 * @returns {Promise<boolean | null>}
 */
export async function dbSeenEndedNotice(clientId, grantId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE oauth_grants SET notice_seen_at = ${now}
WHERE id = ${grantId} AND account_id = ${clientId} AND kind = 'trainer' AND revoked_at IS NOT NULL AND notice_seen_at IS NULL
RETURNING id`;
  return rows.length > 0;
}

// ── Applications to coach ───────────────────────────────────────────────────

/** @param {unknown} v */
const msOrNull = (v) => (v == null ? null : Number(v));

/**
 * @typedef {{ status: string, about: string | null, link: string | null, terms: any,
 *   appliedAt: number | null, decidedAt: number | null, seenAt: number | null, createdAt: number | null }} TrainerApplication
 */

/** @returns {TrainerApplication} */
function applicationFrom(r) {
  return {
    status: r.status,
    about: r.about ?? null,
    link: r.link ?? null,
    terms: r.terms ?? null,
    appliedAt: msOrNull(r.applied_at),
    decidedAt: msOrNull(r.decided_at),
    seenAt: msOrNull(r.seen_at),
    createdAt: msOrNull(r.created_at),
  };
}

/**
 * The account's application, or null when it has never applied. Read only.
 * @param {string} accountId
 * @returns {Promise<TrainerApplication | null>}
 */
export async function dbTrainerApplication(accountId) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT status, about, link, terms, applied_at, decided_at, seen_at, created_at
  FROM trainer_applications WHERE account_id = ${accountId}`;
  return rows.length ? applicationFrom(rows[0]) : null;
}

/**
 * How many applications are waiting. Read only; the cap's count.
 * @returns {Promise<number | null>}
 */
export async function dbOpenApplicationCount() {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT count(*)::int AS n FROM trainer_applications WHERE status = 'applied'`;
  return Number(rows[0]?.n) || 0;
}

/**
 * Apply to coach. INSERTs the account's one row, or OVERWRITES it in place
 * (no history is kept): about, link, terms, status 'applied', applied_at, with
 * decided_at and seen_at cleared. created_at keeps the first apply. The
 * overwrite only replaces a withdrawn row or a denial at least 30 days old,
 * so a waiting or decided application is never replaced.
 * @param {string} accountId
 * @param {{ about: string, link: string | null, terms: { version: string, at: string, adult: true } }} app
 * @param {number} [now]
 * @returns {Promise<boolean | null>} whether the row was written
 */
export async function dbApplyTrainer(accountId, { about, link, terms }, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  if (!accountId || typeof about !== "string" || !about || typeof terms?.version !== "string" || terms.adult !== true) {
    throw new Error("incomplete application");
  }
  await ensureSchema(q);
  const rec = { version: terms.version, at: terms.at, adult: true };
  const rows = await q`INSERT INTO trainer_applications (account_id, status, about, link, terms, applied_at, decided_at, seen_at, created_at)
  VALUES (${accountId}, 'applied', ${about}, ${link ?? null}, ${JSON.stringify(rec)}::jsonb, ${now}, NULL, NULL, ${now})
  ON CONFLICT (account_id) DO UPDATE SET status = 'applied', about = EXCLUDED.about, link = EXCLUDED.link, terms = EXCLUDED.terms,
    applied_at = EXCLUDED.applied_at, decided_at = NULL, seen_at = NULL
  WHERE trainer_applications.status = 'withdrawn'
    OR (trainer_applications.status = 'denied' AND trainer_applications.decided_at <= ${now - REAPPLY_AFTER_MS})
  RETURNING account_id`;
  return rows.length > 0;
}

/**
 * The applicant takes back a waiting application: UPDATE status 'withdrawn'
 * and decided_at on their own row. What they wrote stays until they apply
 * again or close their profile.
 * @param {string} accountId
 * @param {number} [now]
 * @returns {Promise<boolean | null>} whether a waiting row was withdrawn
 */
export async function dbWithdrawApplication(accountId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE trainer_applications SET status = 'withdrawn', decided_at = ${now}
  WHERE account_id = ${accountId} AND status = 'applied' RETURNING account_id`;
  return rows.length > 0;
}

/**
 * The applicant has seen the decision: UPDATE seen_at on their own approved
 * or denied row, once.
 * @param {string} accountId
 * @param {number} [now]
 * @returns {Promise<boolean | null>}
 */
export async function dbSeenApplication(accountId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE trainer_applications SET seen_at = ${now}
  WHERE account_id = ${accountId} AND status IN ('approved', 'denied') AND seen_at IS NULL RETURNING account_id`;
  return rows.length > 0;
}

/**
 * The admin's "Not this time": UPDATE status 'denied' and decided_at on a
 * waiting row. No reason is stored.
 * @param {string} accountId
 * @param {number} [now]
 * @returns {Promise<boolean | null>} whether a waiting row was denied
 */
export async function dbDenyApplication(accountId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE trainer_applications SET status = 'denied', decided_at = ${now}
  WHERE account_id = ${accountId} AND status = 'applied' RETURNING account_id`;
  return rows.length > 0;
}

/** Decided rows the admin page lists, newest first. */
export const DECIDED_LIST = 50;

/**
 * @typedef {{ accountId: string, name: string | null, accountAge: number | null, status: string,
 *   about: string | null, link: string | null, appliedAt: number | null, decidedAt: number | null }} AdminApplication
 */

/**
 * The admin's view: every waiting application (oldest first) and the last
 * 50 decided or withdrawn ones. The name is the live primary handle, read
 * now (null once the profile closed); accountAge is whole days since the
 * account was made. Read only.
 * @param {number} [now]
 * @returns {Promise<{ open: AdminApplication[], decided: AdminApplication[] } | null>}
 */
export async function dbListApplications(now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const [open, decided] = await Promise.all([
    q`SELECT ta.account_id, ta.status, ta.about, ta.link, ta.applied_at, ta.decided_at, a.created_at AS account_created_at, h.handle, h.display
  FROM trainer_applications ta
  JOIN accounts a ON a.id = ta.account_id
  LEFT JOIN handles h ON h.account_id = ta.account_id AND h.kind = 'primary' AND h.released_at IS NULL
  WHERE ta.status = 'applied'
  ORDER BY ta.applied_at`,
    q`SELECT ta.account_id, ta.status, ta.about, ta.link, ta.applied_at, ta.decided_at, a.created_at AS account_created_at, h.handle, h.display
  FROM trainer_applications ta
  JOIN accounts a ON a.id = ta.account_id
  LEFT JOIN handles h ON h.account_id = ta.account_id AND h.kind = 'primary' AND h.released_at IS NULL
  WHERE ta.status <> 'applied'
  ORDER BY ta.decided_at DESC NULLS LAST
  LIMIT ${DECIDED_LIST}`,
  ]);
  /** @returns {AdminApplication} */
  const row = (r) => {
    const made = r.account_created_at == null ? NaN : new Date(r.account_created_at).getTime();
    return {
      accountId: r.account_id,
      name: publicName({ handle: r.handle, display: r.display }),
      accountAge: Number.isFinite(made) ? Math.max(0, Math.floor((now - made) / 86_400_000)) : null,
      status: r.status,
      about: r.about ?? null,
      link: r.link ?? null,
      appliedAt: msOrNull(r.applied_at),
      decidedAt: msOrNull(r.decided_at),
    };
  };
  return { open: open.map(row), decided: decided.map(row) };
}
