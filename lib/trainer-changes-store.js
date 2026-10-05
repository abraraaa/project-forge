// @ts-check
// lib/trainer-changes-store.js
// ─────────────────────────────────────────────────────────────────────────────
// Neon reads, and the named writes, for a trainer's changes to a client's plan
// (table trainer_changes; schema in lib/db.js ensureSchema). The trainer never
// writes client data: a change waits here, the client's app applies it through
// its own stamped edits and reports what it did. Rows are kept for the life of
// the profile; nothing here deletes a row, and no job touches the table.
// Every function returns null when no DB is configured. Server-only.
//
// Writes here, named (all INSERT or UPDATE):
//   · dbInsertChangeSet: INSERTs one row per change in a set, in one statement,
//     only while this client and trainer have sent fewer than 10 sets in 7
//     days (across every grant between them, so a re-share does not reset
//     it) and only if the set id is new (a replay writes nothing). It runs in
//     one transaction behind pg_advisory_xact_lock on 'tc:<client>:<trainer>',
//     so two sends at once cannot both take the last set. Never overwrites a
//     row.
//   · dbWithdrawChanges: the trainer takes a change or a whole set back.
//     UPDATE undone_at, undone_by = 'trainer' on their own rows not undone
//     that have not landed (outcome IS NULL), or landed (outcome 'applied'),
//     are not a week and are among the ids the route found still in force.
//     Never a row the client trained at or changed since.
//   · dbUndoChanges: the client takes a change or a set back. UPDATE undone_at,
//     undone_by = 'client', and reverted_at on a row their device has already
//     put back. Their own rows only, in any grant state.
//   · dbAckChanges: the client's device reports what it did. UPDATE outcome and
//     applied_at on their own rows with no outcome yet (the first report
//     stands); UPDATE reverted_at on their own undone rows, once.
//   · dbEditsOff: UPDATE oauth_grants.edits_off_at on the client's own live
//     trainer grant. Changes not yet landed stop being delivered.
//   · dbEditsOn: UPDATE oauth_grants.edits_at on the client's own live trainer
//     grant, only when changes are off and the grant is on the current share
//     consent. Changes sent before it never land.
// Reads: dbOpenChangesFor (the client's app, on its pull; at most DELIVER_MAX,
// 160, a week's budget of 10 sets of 16, oldest first), dbOpenChangesForGrant and
// dbChangesForTrainer (the trainer), dbChangesForClient (the client),
// dbWipeReportTrainerChanges (the profile wipe's dry run: what it would clear).
// A change id is the set id, a dot and the op's index in two digits (set.00 to
// set.15), so text order is op order.
// ─────────────────────────────────────────────────────────────────────────────

import { sql, ensureSchema } from "./db.js";
import { publicName, DETAIL_DAYS } from "./trainer-view.js";
import { entitled } from "./entitlements.js";
import { isCurrentTrainerTerms } from "./trainer-terms.js";
import { editsLive } from "./trainer-store.js";
import { KINDS, OUTCOMES, SET_ID_RE, MAX_OPS, SETS_PER_WEEK, rowFromDb } from "./trainer-change.js";

const DAY_MS = 86_400_000;
/** The budget's window: rolling 7 days. */
export const BUDGET_WINDOW_MS = 7 * DAY_MS;
/** The lists show 24 weeks, plus anything not yet landed. */
export const LIST_WINDOW_MS = DETAIL_DAYS * DAY_MS;
/** At most this many changes in a list, newest first. */
export const LIST_MAX = 100;
/** At most this many acks, and reverts, in one report. */
export const ACKS_MAX = 64;
/** At most this many changes on one pull: a week's budget, 10 sets of 16. */
export const DELIVER_MAX = SETS_PER_WEEK * MAX_OPS;

/** A change id: the set id, a dot, the change's index in the set in two digits. */
const CHANGE_ID_MAX = 64;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A device's toISOString() instant, and nothing else. */
export const isIsoInstant = (v) => typeof v === "string" && ISO_INSTANT_RE.test(v) && new Date(v).toISOString() === v;

/** A change id or a set id as sent by a device: a short string. */
const isRef = (v) => typeof v === "string" && v.length > 0 && v.length <= CHANGE_ID_MAX;

/** The trainer's side of a grant is live: open, a trainer, on the current terms (as dbClientShare). */
const trainerLive = (r) => r.trainer_deleted_at == null
  && entitled({ roles: Array.isArray(r.trainer_roles) ? r.trainer_roles : [], plan: r.trainer_plan }, "trainer.dashboard")
  && isCurrentTrainerTerms(r.trainer_terms);

/** Delivery and the client's list: the row's grant still delivers it (SQL part) and the trainer is live. */
const deliverable = (r) => r.grant_live === true && trainerLive(r);

const msOrNull = (v) => (v == null ? null : Number(v));

/**
 * @typedef {{ kind: string, target: string, before?: unknown, after?: unknown, basis?: unknown,
 *   warnings?: unknown, from?: string | null }} NewChange
 * @typedef {{ setId: string, grantId: string, profile: string, clientId: string, authorId: string,
 *   ops: NewChange[] }} NewChangeSet
 * @typedef {{ used: number, freeAt: number | null }} Budget
 */

/**
 * The budget: change sets this client and trainer have had in the last 7 days
 * on any grant between them (withdrawn and undone ones count), and when the
 * oldest of them leaves the window. Keyed by one of their grants.
 * @param {any} q
 * @param {string} grantId
 * @param {number} now
 * @returns {Promise<Budget>}
 */
async function budgetFor(q, grantId, now) {
  const rows = await q`SELECT count(DISTINCT set_id)::int AS used, min(created_at) AS oldest FROM trainer_changes
WHERE grant_id IN (SELECT g.id FROM oauth_grants g JOIN oauth_grants r
    ON r.account_id = g.account_id AND r.trainer_account_id = g.trainer_account_id WHERE r.id = ${grantId})
  AND source = 'trainer' AND created_at > ${now - BUDGET_WINDOW_MS}::bigint`;
  const used = Number(rows[0]?.used) || 0;
  const oldest = msOrNull(rows[0]?.oldest);
  return { used, freeAt: oldest == null ? null : oldest + BUDGET_WINDOW_MS };
}

/**
 * INSERTs a validated change set as one row per change, in one statement:
 * id = setId + "." + the index in two digits, source 'trainer', status 'sent',
 * created_at = now. It runs in one transaction behind an advisory lock on
 * this client and trainer, so the budget count and the INSERT are one step.
 * Nothing is written when the set id already exists (a replay), the grant is
 * not this client and trainer's, or they have had 10 sets in the last 7
 * days. The caller has run the gates and the validator; malformed input
 * throws.
 * @param {NewChangeSet} set
 * @param {number} [now]
 * @returns {Promise<{ inserted: string[] } | { replay: true } | { mismatch: true } | { taken: true } | { full: true, used: number, freeAt: number | null } | null>}
 *   replay: this grant and trainer already sent this set, the same changes;
 *   mismatch: they sent this set id with other changes; taken: the set id
 *   belongs to someone else's set; full: the budget is spent until freeAt.
 */
export async function dbInsertChangeSet({ setId, grantId, profile, clientId, authorId, ops }, now = Date.now()) {
  if (typeof setId !== "string" || !SET_ID_RE.test(setId)) throw new Error("bad change set");
  for (const v of [grantId, profile, clientId, authorId]) if (typeof v !== "string" || !v) throw new Error("bad change set");
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPS) throw new Error("bad change set");
  const rows = ops.map((o) => {
    if (!o || !KINDS.includes(o.kind) || typeof o.target !== "string" || !o.target || o.target.length > 128) throw new Error("bad change");
    const from = o.from ?? null;
    if (from !== null && !(typeof from === "string" && ISO_DATE_RE.test(from))) throw new Error("bad change");
    return { kind: o.kind, target: o.target, before: o.before ?? null, after: o.after ?? null,
      basis: o.basis ?? null, warnings: o.warnings ?? null, from };
  });
  if (!Number.isFinite(now)) throw new Error("bad change set");
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const opsJson = JSON.stringify(rows);
  // Held to commit: a second send for this pair waits, then counts this one.
  const [, inserted] = await q.transaction([
    q`SELECT pg_advisory_xact_lock(hashtext('tc:' || ${clientId}::text || ':' || ${authorId}::text))`,
    q`INSERT INTO trainer_changes (id, set_id, grant_id, profile, client_account_id, author_account_id,
  source, status, kind, target, old_value, new_value, basis, warnings, effective_from, created_at)
SELECT ${setId}::text || '.' || lpad((o.i - 1)::text, 2, '0'), ${setId}::text, ${grantId}::text, ${profile}::text, ${clientId}::text, ${authorId}::text,
  'trainer', 'sent', o.op->>'kind', o.op->>'target',
  NULLIF(o.op->'before', 'null'::jsonb), NULLIF(o.op->'after', 'null'::jsonb),
  NULLIF(o.op->'basis', 'null'::jsonb), NULLIF(o.op->'warnings', 'null'::jsonb),
  o.op->>'from', ${now}::bigint
FROM jsonb_array_elements(${opsJson}::jsonb) WITH ORDINALITY AS o(op, i)
WHERE NOT EXISTS (SELECT 1 FROM trainer_changes x WHERE x.set_id = ${setId}::text)
  AND EXISTS (SELECT 1 FROM oauth_grants r WHERE r.id = ${grantId}::text AND r.account_id = ${clientId}::text AND r.trainer_account_id = ${authorId}::text)
  AND (SELECT count(DISTINCT b.set_id) FROM trainer_changes b
       WHERE b.grant_id IN (SELECT g.id FROM oauth_grants g WHERE g.account_id = ${clientId}::text AND g.trainer_account_id = ${authorId}::text)
         AND b.source = 'trainer' AND b.created_at > ${now - BUDGET_WINDOW_MS}::bigint) < ${SETS_PER_WEEK}::int
ON CONFLICT (id) DO NOTHING
RETURNING id`,
  ]);
  if (inserted.length) return { inserted: inserted.map((r) => r.id).sort() };
  // same: the stored set is exactly these changes, op for op (kind, target, value, start).
  const [seen] = await q`SELECT
  EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ${setId} AND grant_id = ${grantId} AND author_account_id = ${authorId}) AS mine,
  EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ${setId}) AS taken,
  EXISTS (SELECT 1 FROM oauth_grants WHERE id = ${grantId} AND account_id = ${clientId} AND trainer_account_id = ${authorId}) AS fits,
  (SELECT count(*) FROM trainer_changes WHERE set_id = ${setId}) = jsonb_array_length(${opsJson}::jsonb)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${opsJson}::jsonb) WITH ORDINALITY AS o(op, i)
      WHERE NOT EXISTS (SELECT 1 FROM trainer_changes t WHERE t.id = ${setId}::text || '.' || lpad((o.i - 1)::text, 2, '0')
        AND t.kind = o.op->>'kind' AND t.target = o.op->>'target'
        AND t.new_value IS NOT DISTINCT FROM NULLIF(o.op->'after', 'null'::jsonb)
        AND t.effective_from IS NOT DISTINCT FROM o.op->>'from')) AS same`;
  if (seen?.mine === true) return seen.same === true ? { replay: true } : { mismatch: true };
  if (seen?.taken === true) return { taken: true };
  if (seen?.fits !== true) throw new Error("change set grant is not this client and trainer's");
  return { full: true, ...(await budgetFor(q, grantId, now)) };
}

/**
 * The trainer takes back a change (by change id) or a set (by set id): UPDATE
 * undone_at, undone_by = 'trainer'. Only their own rows on this grant, not yet
 * undone, and either
 *   not landed: outcome IS NULL (waiting, or stopped before it landed); or
 *   landed and in force: outcome = 'applied', not a week, and its id in
 *     inForce. Whether a landed change is still in force (not trained at,
 *     not changed since) is read from the client's training, so the route
 *     works it out with changeStatus and passes those ids.
 * A week goes back only before its date.
 * @param {string} ref  the grant id
 * @param {string} trainerId
 * @param {string} x  a change id or a set id
 * @param {string[]} inForce  ids of landed changes found still in force
 * @param {number} [now]
 * @returns {Promise<string[] | null>} the ids taken back (none: nothing to take back)
 */
export async function dbWithdrawChanges(ref, trainerId, x, inForce, now = Date.now()) {
  if (!isRef(x) || typeof ref !== "string" || !ref || typeof trainerId !== "string" || !trainerId) throw new Error("bad withdraw");
  if (!Array.isArray(inForce) || inForce.length > MAX_OPS || !inForce.every(isRef)) throw new Error("bad withdraw");
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE trainer_changes SET undone_at = ${now}, undone_by = 'trainer'
WHERE (id = ${x} OR set_id = ${x}) AND grant_id = ${ref} AND author_account_id = ${trainerId} AND undone_at IS NULL
  AND (outcome IS NULL
    OR (outcome = 'applied' AND kind <> 'week' AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(inForce)}::jsonb))))
RETURNING id`;
  return rows.map((r) => r.id).sort();
}

/**
 * The client takes back a change or a set: UPDATE undone_at, undone_by =
 * 'client' on their own rows not yet undone, whatever the grant's state.
 * reverted (their device's instant, when it has already written the old
 * value back) is kept on rows that had landed, once. Calling it again changes
 * nothing.
 * @param {string} clientId
 * @param {string} x  a change id or a set id
 * @param {string | null} reverted
 * @param {number} [now]
 * @returns {Promise<string[] | null>} the ids taken back by this call
 */
export async function dbUndoChanges(clientId, x, reverted, now = Date.now()) {
  if (!isRef(x) || typeof clientId !== "string" || !clientId) throw new Error("bad undo");
  if (reverted != null && !isIsoInstant(reverted)) throw new Error("bad undo");
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`UPDATE trainer_changes SET undone_at = ${now}, undone_by = 'client',
  reverted_at = CASE WHEN outcome = 'applied' THEN COALESCE(reverted_at, ${reverted ?? null}::text) ELSE reverted_at END
WHERE (id = ${x} OR set_id = ${x}) AND client_account_id = ${clientId} AND undone_at IS NULL
RETURNING id`;
  return rows.map((r) => r.id).sort();
}

/**
 * A device's report, checked: acks [{ id, outcome, at }] with outcome one of
 * OUTCOMES, reverts [{ id, at }], at most 64 each, every at an ISO instant.
 * The first entry per id is kept. Null when anything is malformed.
 * @param {unknown} acks
 * @param {unknown} reverts
 * @returns {{ acks: { id: string, outcome: string, at: string }[], reverts: { id: string, at: string }[] } | null}
 */
export function cleanAcks(acks, reverts) {
  const a = acks ?? [];
  const r = reverts ?? [];
  if (!Array.isArray(a) || !Array.isArray(r) || a.length > ACKS_MAX || r.length > ACKS_MAX) return null;
  const outAcks = [];
  const outReverts = [];
  const seenA = new Set();
  const seenR = new Set();
  for (const e of a) {
    if (!e || !isRef(e.id) || !OUTCOMES.includes(e.outcome) || !isIsoInstant(e.at)) return null;
    if (seenA.has(e.id)) continue;
    seenA.add(e.id);
    outAcks.push({ id: e.id, outcome: e.outcome, at: e.at });
  }
  for (const e of r) {
    if (!e || !isRef(e.id) || !isIsoInstant(e.at)) return null;
    if (seenR.has(e.id)) continue;
    seenR.add(e.id);
    outReverts.push({ id: e.id, at: e.at });
  }
  return { acks: outAcks, reverts: outReverts };
}

/**
 * The client's device reports what it did, on their own rows only (one
 * transaction when both lists are set):
 *   acks: UPDATE outcome, and applied_at for 'applied', where no outcome is
 *     recorded yet. The first report stands.
 *   reverts: UPDATE reverted_at where the row was undone and not yet put back.
 * Malformed input throws; cleanAcks is the route's check.
 * @param {string} clientId
 * @param {{ acks?: unknown, reverts?: unknown }} report
 * @returns {Promise<{ acked: string[], reverted: string[] } | null>}
 */
export async function dbAckChanges(clientId, { acks, reverts }) {
  const clean = cleanAcks(acks, reverts);
  if (!clean || typeof clientId !== "string" || !clientId) throw new Error("bad ack");
  const q = sql();
  if (!q) return null;
  if (!clean.acks.length && !clean.reverts.length) return { acked: [], reverted: [] };
  await ensureSchema(q);
  const ackQ = () => q`UPDATE trainer_changes t SET outcome = a.outcome,
  applied_at = CASE WHEN a.outcome = 'applied' THEN a.at ELSE NULL END
FROM (SELECT e->>'id' AS id, e->>'outcome' AS outcome, e->>'at' AS at FROM jsonb_array_elements(${JSON.stringify(clean.acks)}::jsonb) AS e) a
WHERE t.id = a.id AND t.client_account_id = ${clientId} AND t.outcome IS NULL
RETURNING t.id`;
  const revertQ = () => q`UPDATE trainer_changes t SET reverted_at = r.at
FROM (SELECT e->>'id' AS id, e->>'at' AS at FROM jsonb_array_elements(${JSON.stringify(clean.reverts)}::jsonb) AS e) r
WHERE t.id = r.id AND t.client_account_id = ${clientId} AND t.undone_at IS NOT NULL AND t.reverted_at IS NULL
RETURNING t.id`;
  let acked = [];
  let reverted = [];
  if (clean.acks.length && clean.reverts.length) [acked, reverted] = await q.transaction([ackQ(), revertQ()]);
  else if (clean.acks.length) acked = await ackQ();
  else reverted = await revertQ();
  return { acked: acked.map((x) => x.id).sort(), reverted: reverted.map((x) => x.id).sort() };
}

/**
 * The client turns their trainer's changes off: UPDATE edits_off_at on their
 * own live trainer grant. It only reduces access. Changes not yet landed stop
 * being delivered; landed ones stay, each undoable.
 * @param {string} clientId
 * @param {number} [now]
 * @returns {Promise<boolean | null>} whether a grant with changes was found
 */
export async function dbEditsOff(clientId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  // Never earlier than edits_at, so the switch reads off even across a clock step.
  const rows = await q`UPDATE oauth_grants SET edits_off_at = GREATEST(${now}::bigint, edits_at)
WHERE account_id = ${clientId} AND kind = 'trainer' AND revoked_at IS NULL AND edits_at IS NOT NULL
RETURNING id`;
  return rows.length > 0;
}

/**
 * The client turns their trainer's changes on (the route has run a fresh Face
 * ID): UPDATE edits_at on their own live trainer grant, only while changes are
 * off and the grant is on the current share consent. Changes sent before now
 * never land.
 * @param {string} clientId
 * @param {string} consentVersion  SHARE_CONSENT_VERSION
 * @param {number} [now]
 * @returns {Promise<"on" | "already" | "fresh" | "none" | null>}
 *   fresh: the grant predates this consent (ask for a fresh code); none: no live grant.
 */
export async function dbEditsOn(clientId, consentVersion, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  // Always later than edits_off_at, so the switch reads on.
  const rows = await q`UPDATE oauth_grants SET edits_at = GREATEST(${now}::bigint, COALESCE(edits_off_at, 0) + 1)
WHERE account_id = ${clientId} AND kind = 'trainer' AND revoked_at IS NULL AND consent_version = ${consentVersion}
  AND NOT (edits_at IS NOT NULL AND (edits_off_at IS NULL OR edits_off_at < edits_at))
RETURNING id`;
  if (rows.length) return "on";
  const [g] = await q`SELECT consent_version, edits_at, edits_off_at FROM oauth_grants
WHERE account_id = ${clientId} AND kind = 'trainer' AND revoked_at IS NULL`;
  if (!g) return "none";
  if (g.consent_version !== consentVersion) return "fresh";
  return "already";
}

/**
 * @typedef {{ id: string, set: string, kind: string, target: string, from: string | null, before: any,
 *   after: any, basis: any, at: number, appliedAt: string | null, undone: boolean, by: string | null }} DeliveredChange
 */

/**
 * What the client's app should do on its pull, for one profile. Read only.
 *   To apply: sent, not landed, not undone, on a grant that is live with
 *     changes on since before the change was sent (created_at > edits_at),
 *     from the grant's own trainer, who is still a live trainer.
 *   To put back: undone after it landed, not yet put back, not a week, in
 *     any grant state.
 * Cleared rows (a wiped profile) are never delivered. Oldest first, at most
 * DELIVER_MAX; the rest come on a later pull once these are reported. A
 * change whose grant can no longer deliver it is left out in the SQL, so it
 * never takes a place in the limit.
 * @param {string} profile  the client's storage key
 * @returns {Promise<DeliveredChange[] | null>}
 */
export async function dbOpenChangesFor(profile) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.basis,
  c.created_at, c.applied_at, c.outcome, c.undone_at,
  COALESCE(g.revoked_at IS NULL AND g.trainer_account_id = c.author_account_id
    AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at) AND c.created_at > g.edits_at
    AND EXISTS (SELECT 1 FROM accounts a JOIN credentials k ON k.account_id = a.id
      WHERE a.id = g.account_id AND a.deleted_at IS NULL AND k.id = g.credential_id AND k.rp_id = 'heatwayve.app'), false) AS grant_live,
  t.roles AS trainer_roles, t.plan AS trainer_plan, t.trainer_terms, t.deleted_at AS trainer_deleted_at, h.handle, h.display
FROM trainer_changes c
LEFT JOIN oauth_grants g ON g.id = c.grant_id AND g.kind = 'trainer'
LEFT JOIN accounts t ON t.id = c.author_account_id
LEFT JOIN LATERAL (SELECT handle, display FROM handles
  WHERE account_id = c.author_account_id AND kind = 'primary'
  ORDER BY released_at DESC NULLS FIRST LIMIT 1) h ON true
WHERE c.profile = ${profile} AND c.source = 'trainer' AND c.status = 'sent' AND c.cleared_at IS NULL
  AND ((c.outcome IS NULL AND c.undone_at IS NULL AND g.revoked_at IS NULL AND g.trainer_account_id = c.author_account_id
      AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at) AND c.created_at > g.edits_at)
    OR (c.undone_at IS NOT NULL AND c.outcome = 'applied' AND c.reverted_at IS NULL AND c.kind <> 'week'))
ORDER BY c.created_at, c.id
LIMIT ${DELIVER_MAX}`;
  /** @type {DeliveredChange[]} */
  const out = [];
  for (const r of rows) {
    const undone = r.undone_at != null;
    if (!undone && !deliverable(r)) continue;
    out.push({
      id: r.id, set: r.set_id, kind: r.kind, target: r.target, from: r.effective_from ?? null,
      before: r.old_value ?? null, after: r.new_value ?? null, basis: r.basis ?? null,
      at: Number(r.created_at), appliedAt: r.applied_at ?? null, undone,
      by: publicName({ handle: r.handle, display: r.display }),
    });
  }
  return out;
}

/**
 * @typedef {import("./trainer-change.js").ChangeRow} ChangeRow
 * @typedef {ChangeRow & { editsLive: boolean }} TrainerChangeRow
 * @typedef {ChangeRow & { editsLive: boolean, by: string | null }} ClientChangeRow
 */

/**
 * The trainer's changes on one grant that have not landed and are still
 * waiting to (sent after changes were last turned on), oldest first, each
 * with how many changes its set holds, and the budget. Never the basis. Read
 * only.
 * @param {string} ref  the grant id
 * @param {string} trainerId
 * @param {number} [now]
 * @returns {Promise<{ open: (ChangeRow & { setSize: number })[], used: number, freeAt: number | null } | null>}
 */
export async function dbOpenChangesForGrant(ref, trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const [rows, budget] = await Promise.all([
    q`SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,
  c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at,
  (SELECT count(*) FROM trainer_changes s WHERE s.set_id = c.set_id)::int AS set_size
FROM trainer_changes c JOIN oauth_grants g ON g.id = c.grant_id
WHERE c.grant_id = ${ref} AND c.author_account_id = ${trainerId} AND c.source = 'trainer' AND c.status = 'sent'
  AND c.outcome IS NULL AND c.undone_at IS NULL AND c.created_at > COALESCE(g.edits_at, 0)
ORDER BY c.created_at, c.id`,
    budgetFor(q, ref, now),
  ]);
  return { open: rows.map((r) => ({ ...rowFromDb(r), setSize: Number(r.set_size) || 0 })), ...budget };
}

/**
 * The trainer's list for one grant: the last 24 weeks and anything not yet
 * landed, newest first, at most 100 changes, with the grant's budget. Each
 * row says whether its grant would still deliver it (editsLive). Never the
 * basis. Read only.
 * @param {string} ref  the grant id
 * @param {string} trainerId
 * @param {number} [now]
 * @returns {Promise<{ rows: TrainerChangeRow[], used: number, freeAt: number | null } | null>}
 */
export async function dbChangesForTrainer(ref, trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const [rows, budget] = await Promise.all([
    q`SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,
  c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at,
  COALESCE(g.revoked_at IS NULL AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at)
    AND c.created_at > g.edits_at, false) AS edits_live
FROM trainer_changes c LEFT JOIN oauth_grants g ON g.id = c.grant_id
WHERE c.grant_id = ${ref} AND c.author_account_id = ${trainerId} AND c.source = 'trainer' AND c.status = 'sent'
  AND (c.created_at > ${now - LIST_WINDOW_MS}::bigint OR (c.outcome IS NULL AND c.undone_at IS NULL))
ORDER BY c.created_at DESC, c.id
LIMIT ${LIST_MAX}`,
    budgetFor(q, ref, now),
  ]);
  return { rows: rows.map((r) => ({ ...rowFromDb(r), editsLive: r.edits_live === true })), ...budget };
}

/**
 * The client's list: changes to their plan from any trainer, the last 24
 * weeks and anything not yet landed, newest first, at most 100, each with the
 * trainer's public name and whether it would still be delivered (editsLive:
 * the delivery predicate of dbOpenChangesFor). edits: the switch on their
 * live trainer grant, null with none. Read only.
 * @param {string} clientId
 * @param {number} [now]
 * @returns {Promise<{ edits: { on: boolean, since: number | null } | null, rows: ClientChangeRow[] } | null>}
 */
export async function dbChangesForClient(clientId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const [grants, rows] = await Promise.all([
    q`SELECT edits_at, edits_off_at FROM oauth_grants WHERE account_id = ${clientId} AND kind = 'trainer' AND revoked_at IS NULL`,
    q`SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.basis, c.warnings,
  c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at,
  COALESCE(g.revoked_at IS NULL AND g.trainer_account_id = c.author_account_id
    AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at) AND c.created_at > g.edits_at
    AND EXISTS (SELECT 1 FROM accounts a JOIN credentials k ON k.account_id = a.id
      WHERE a.id = g.account_id AND a.deleted_at IS NULL AND k.id = g.credential_id AND k.rp_id = 'heatwayve.app'), false) AS grant_live,
  t.roles AS trainer_roles, t.plan AS trainer_plan, t.trainer_terms, t.deleted_at AS trainer_deleted_at, h.handle, h.display
FROM trainer_changes c
LEFT JOIN oauth_grants g ON g.id = c.grant_id AND g.kind = 'trainer'
LEFT JOIN accounts t ON t.id = c.author_account_id
LEFT JOIN LATERAL (SELECT handle, display FROM handles
  WHERE account_id = c.author_account_id AND kind = 'primary'
  ORDER BY released_at DESC NULLS FIRST LIMIT 1) h ON true
WHERE c.client_account_id = ${clientId} AND c.source = 'trainer' AND c.status = 'sent'
  AND (c.created_at > ${now - LIST_WINDOW_MS}::bigint OR (c.outcome IS NULL AND c.undone_at IS NULL))
ORDER BY c.created_at DESC, c.id
LIMIT ${LIST_MAX}`,
  ]);
  const g = grants[0];
  const on = g ? editsLive(g.edits_at, g.edits_off_at) : false;
  return {
    edits: g ? { on, since: on ? msOrNull(g.edits_at) : null } : null,
    rows: rows.map((r) => ({
      ...rowFromDb(r),
      editsLive: deliverable(r),
      by: publicName({ handle: r.handle, display: r.display }),
    })),
  };
}

/**
 * The profile wipe's dry run: the rows whose numbers (old_value, new_value,
 * basis, warnings) a wipe of this profile would clear. Exactly the rows of
 * this storage key not cleared yet; no prefix, any source or status. Read
 * only: nothing here clears anything. The clearing, when it comes, must use
 * this same WHERE so it clears exactly the list that was read.
 * @param {string} profile  the wiped account's storage key
 * @returns {Promise<{ count: number, ids: string[] } | null>}
 */
export async function dbWipeReportTrainerChanges(profile) {
  if (typeof profile !== "string" || !profile) throw new Error("bad profile");
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT id FROM trainer_changes WHERE profile = ${profile} AND cleared_at IS NULL ORDER BY created_at, id`;
  const ids = rows.map((r) => r.id);
  return { count: ids.length, ids };
}
