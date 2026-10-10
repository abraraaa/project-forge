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
//     only if the set id is new (a replay writes nothing). A plan set goes in
//     only while this client and trainer have sent fewer than 10 plan sets in
//     7 days (across every grant between them, so a re-share does not reset
//     it). A session (one row, kind 'session') has its own count instead,
//     fewer than 7 in 7 days between them, and goes in only while the client
//     has no standing session for that day and letter (one not withdrawn,
//     and waiting or kept; one with no delivery report on a grant since
//     revoked does not stand, see dbInsertChangeSet). It runs in one transaction behind
//     pg_advisory_xact_lock on 'tc:<client>:<trainer>', so two sends at once
//     cannot both take the last place or both log one letter. Never
//     overwrites a row.
//   · dbWithdrawChanges: the trainer takes a change or a whole set back.
//     UPDATE undone_at, undone_by = 'trainer' on their own rows not undone
//     that have not landed (outcome IS NULL), or landed (outcome 'applied'),
//     are not a week and are among the ids the route found still in force.
//     Never a row the client trained at or changed since, and never a
//     session once it has reached their device (delivered_at set).
//   · dbUndoChanges: the client takes a change or a set back. UPDATE undone_at,
//     undone_by = 'client', and reverted_at on a row their device has already
//     put back. Their own rows only, in any grant state. Never a session:
//     keeping one is final, and discarding is its refusal.
//   · dbAckChanges: the client's device reports what it did. UPDATE
//     delivered_at on their own session rows not withdrawn and not yet marked
//     (the first report stands; held between the row's created_at and the
//     server's now); UPDATE outcome and applied_at on their own rows with no
//     outcome yet (the first report stands; auto_kept only on a row marked
//     delivered); UPDATE reverted_at on their own undone rows, once.
//   · dbEditsOff: UPDATE oauth_grants.edits_off_at on the client's own live
//     trainer grant. Changes not yet landed stop being delivered.
//   · dbEditsOn: UPDATE oauth_grants.edits_at on the client's own live trainer
//     grant, only when changes are off and the grant is on the current share
//     consent. Changes sent before it never land.
// Reads: dbOpenChangesFor (the client's app, on its pull; at most DELIVER_MAX,
// 160, a week's budget of 10 sets of 16, oldest first; a session already on
// their device stays until they decide, even after sharing stops),
// dbOpenChangesForGrant and dbChangesForTrainer (the trainer),
// dbChangesForClient (the client), dbWipeReportTrainerChanges (the profile
// wipe's dry run: what it would clear).
// A change id is the set id, a dot and the op's index in two digits (set.00 to
// set.15), so text order is op order.
// ─────────────────────────────────────────────────────────────────────────────

import { sql, ensureSchema } from "./db.js";
import { publicName, DETAIL_DAYS } from "./trainer-view.js";
import { entitled } from "./entitlements.js";
import { isCurrentTrainerTerms } from "./trainer-terms.js";
import { editsLive } from "./trainer-store.js";
import {
  KINDS, OUTCOMES, SET_ID_RE, MAX_OPS, SETS_PER_WEEK, SESSION_KIND, SESSIONS_PER_WEEK, RECORD_MAX_BYTES, rowFromDb,
} from "./trainer-change.js";

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
/** A session row's target: the record's day and letter (sessionTarget). */
const SESSION_TARGET_RE = /^(\d{4}-\d{2}-\d{2}):[ABC]$/;

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
 * @typedef {{ used: number, freeAt: number | null }} Count
 * @typedef {Count & { sessions: Count }} Budget
 * used, freeAt: plan sets; sessions: coached sessions, a count of their own.
 */

/**
 * The budget: plan sets this client and trainer have had in the last 7 days
 * on any grant between them (withdrawn and undone ones count), and when the
 * oldest of them leaves the window; sessions the same, counted apart.
 * Keyed by one of their grants.
 * @param {any} q
 * @param {string} grantId
 * @param {number} now
 * @returns {Promise<Budget>}
 */
async function budgetFor(q, grantId, now) {
  const since = now - BUDGET_WINDOW_MS;
  const [plan, sessions] = await Promise.all([
    q`SELECT count(DISTINCT set_id)::int AS used, min(created_at) AS oldest FROM trainer_changes
WHERE grant_id IN (SELECT g.id FROM oauth_grants g JOIN oauth_grants r
    ON r.account_id = g.account_id AND r.trainer_account_id = g.trainer_account_id WHERE r.id = ${grantId})
  AND source = 'trainer' AND kind <> 'session' AND created_at > ${since}::bigint`,
    q`SELECT count(DISTINCT set_id)::int AS used, min(created_at) AS oldest FROM trainer_changes
WHERE grant_id IN (SELECT g.id FROM oauth_grants g JOIN oauth_grants r
    ON r.account_id = g.account_id AND r.trainer_account_id = g.trainer_account_id WHERE r.id = ${grantId})
  AND source = 'trainer' AND kind = 'session' AND created_at > ${since}::bigint`,
  ]);
  /** @returns {Count} */
  const count = (row) => {
    const oldest = msOrNull(row?.oldest);
    return { used: Number(row?.used) || 0, freeAt: oldest == null ? null : oldest + BUDGET_WINDOW_MS };
  };
  return { ...count(plan[0]), sessions: count(sessions[0]) };
}

/**
 * INSERTs a validated change set as one row per change, in one statement:
 * id = setId + "." + the index in two digits, source 'trainer', status 'sent',
 * created_at = now. It runs in one transaction behind an advisory lock on
 * this client and trainer, so the counts, the session guard and the INSERT
 * are one step. Nothing is written when the set id already exists (a
 * replay), the grant is not this client and trainer's, or the count for its
 * kind is spent: 10 plan sets, or 7 sessions, in the last 7 days. A session
 * (a set of exactly one op of kind "session", target "<date>:<letter>",
 * from the record's date) is also refused while the client has a standing
 * session for that target: not withdrawn, and waiting or kept. A row never
 * delivered and not decided, on a grant since revoked, does not stand:
 * otherwise it would hold that day for good. This narrows a gap, it does not
 * close it: delivered_at is the device's own report, which can still be in its
 * outbox, so a device that pulled the row before the revoke may hold that card
 * and later get a second session for the same day and letter. The caller
 * has run the gates and the validator; malformed input throws.
 * @param {NewChangeSet} set
 * @param {number} [now]
 * @returns {Promise<{ inserted: string[] } | { replay: true } | { mismatch: true } | { taken: true } | { alreadySent: true, used: number, freeAt: number | null } | { full: true, used: number, freeAt: number | null } | null>}
 *   replay: this grant and trainer already sent this set, the same changes;
 *   mismatch: they sent this set id with other changes; taken: the set id
 *   belongs to someone else's set; alreadySent: a session for this day and
 *   letter stands (409 already_sent), with the session count; full: the
 *   count for this kind (plan sets, or sessions) is spent until freeAt.
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
  const session = rows.some((o) => o.kind === SESSION_KIND);
  // A session travels alone, as one record for one day and letter, within the size bound.
  if (session) {
    const [o] = rows;
    const day = SESSION_TARGET_RE.exec(o.target);
    if (rows.length !== 1 || !day || o.from !== day[1] || o.before !== null || o.basis !== null || o.warnings !== null) throw new Error("bad change");
    if (!o.after || typeof o.after !== "object" || new TextEncoder().encode(JSON.stringify(o.after)).length > RECORD_MAX_BYTES) throw new Error("bad change");
  }
  if (!Number.isFinite(now)) throw new Error("bad change set");
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const opsJson = JSON.stringify(rows);
  const since = now - BUDGET_WINDOW_MS;
  // Held to commit: a second send for this pair waits, then counts this one
  // (and, for a session, sees it standing for its day and letter).
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
  AND (o.op->>'kind' = 'session' OR (SELECT count(DISTINCT b.set_id) FROM trainer_changes b
       WHERE b.grant_id IN (SELECT g.id FROM oauth_grants g WHERE g.account_id = ${clientId}::text AND g.trainer_account_id = ${authorId}::text)
         AND b.source = 'trainer' AND b.kind <> 'session' AND b.created_at > ${since}::bigint) < ${SETS_PER_WEEK}::int)
  AND (o.op->>'kind' <> 'session' OR ((SELECT count(DISTINCT s.set_id) FROM trainer_changes s
       WHERE s.grant_id IN (SELECT g.id FROM oauth_grants g WHERE g.account_id = ${clientId}::text AND g.trainer_account_id = ${authorId}::text)
         AND s.source = 'trainer' AND s.kind = 'session' AND s.created_at > ${since}::bigint) < ${SESSIONS_PER_WEEK}::int
    AND NOT EXISTS (SELECT 1 FROM trainer_changes d WHERE d.client_account_id = ${clientId}::text AND d.kind = 'session'
      AND d.target = o.op->>'target' AND d.undone_at IS NULL AND (d.outcome IS NULL OR d.outcome IN ('kept', 'auto_kept'))
      AND NOT (d.outcome IS NULL AND d.delivered_at IS NULL
        AND EXISTS (SELECT 1 FROM oauth_grants dg WHERE dg.id = d.grant_id AND dg.revoked_at IS NOT NULL)))))
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
  if (session) {
    // The guard of the INSERT above, read again after it: a standing session for this day and letter.
    const [dup] = await q`SELECT EXISTS (SELECT 1 FROM trainer_changes d WHERE d.client_account_id = ${clientId}::text AND d.kind = 'session'
  AND d.target = ${rows[0].target}::text AND d.undone_at IS NULL AND (d.outcome IS NULL OR d.outcome IN ('kept', 'auto_kept'))
  AND NOT (d.outcome IS NULL AND d.delivered_at IS NULL
    AND EXISTS (SELECT 1 FROM oauth_grants dg WHERE dg.id = d.grant_id AND dg.revoked_at IS NOT NULL))) AS standing`;
    const { sessions } = await budgetFor(q, grantId, now);
    return dup?.standing === true ? { alreadySent: true, ...sessions } : { full: true, ...sessions };
  }
  const { used, freeAt } = await budgetFor(q, grantId, now);
  return { full: true, used, freeAt };
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
 * A week goes back only before its date. A session goes back only before it
 * reaches their device (delivered_at null): after that the decision is theirs.
 * This narrows the race with a keep but does not close it: delivered_at is the
 * device's own report, which can land after the device first has the record
 * (offline, or a report still in its outbox), so a withdraw in that gap goes
 * through while the device can still keep it. A keep that follows a withdraw
 * stands in their history and reads as kept (sessionStatus reads a keep first).
 * The same gap lets a resend after a revoke through (see dbInsertChangeSet).
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
  AND (kind <> 'session' OR delivered_at IS NULL)
RETURNING id`;
  return rows.map((r) => r.id).sort();
}

/**
 * The client takes back a change or a set: UPDATE undone_at, undone_by =
 * 'client' on their own rows not yet undone, whatever the grant's state.
 * reverted (their device's instant, when it has already written the old
 * value back) is kept on rows that had landed, once. Calling it again changes
 * nothing. Never a session: keeping one is final, and discarding is the
 * client's refusal of it.
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
WHERE (id = ${x} OR set_id = ${x}) AND client_account_id = ${clientId} AND undone_at IS NULL AND kind <> 'session'
RETURNING id`;
  return rows.map((r) => r.id).sort();
}

/**
 * A device's report, checked: acks [{ id, outcome, at }] with outcome one of
 * OUTCOMES (a session's kept, auto_kept and discarded among them), reverts
 * [{ id, at }], delivered [{ id, at }] (a session first on this device), at
 * most 64 each, every at an ISO instant. The first entry per id in each list
 * is kept. Null when anything is malformed.
 * @param {unknown} acks
 * @param {unknown} reverts
 * @param {unknown} [delivered]
 * @returns {{ acks: { id: string, outcome: string, at: string }[], reverts: { id: string, at: string }[], delivered: { id: string, at: string }[] } | null}
 */
export function cleanAcks(acks, reverts, delivered) {
  const a = acks ?? [];
  const r = reverts ?? [];
  const d = delivered ?? [];
  if (!Array.isArray(a) || !Array.isArray(r) || !Array.isArray(d)) return null;
  if (a.length > ACKS_MAX || r.length > ACKS_MAX || d.length > ACKS_MAX) return null;
  const outAcks = [];
  const seenA = new Set();
  for (const e of a) {
    if (!e || !isRef(e.id) || !OUTCOMES.includes(e.outcome) || !isIsoInstant(e.at)) return null;
    if (seenA.has(e.id)) continue;
    seenA.add(e.id);
    outAcks.push({ id: e.id, outcome: e.outcome, at: e.at });
  }
  /** @param {unknown[]} list */
  const marks = (list) => {
    const out = [];
    const seen = new Set();
    for (const e of /** @type {any[]} */ (list)) {
      if (!e || !isRef(e.id) || !isIsoInstant(e.at)) return null;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, at: e.at });
    }
    return out;
  };
  const outReverts = marks(r);
  const outDelivered = marks(d);
  if (!outReverts || !outDelivered) return null;
  return { acks: outAcks, reverts: outReverts, delivered: outDelivered };
}

/**
 * The client's device reports what it did, on their own rows only (one
 * transaction when more than one statement runs), in this order:
 *   delivered: UPDATE delivered_at on session rows not withdrawn and not yet
 *     marked. The first report stands. The device's instant is held between
 *     the row's created_at and now, so a clock behind cannot start the five
 *     hours before the send, nor a clock ahead after the server's now.
 *   acks: UPDATE outcome, and applied_at for 'applied', 'kept' and
 *     'auto_kept', where no outcome is recorded yet. The first report stands.
 *     'auto_kept' lands only on a row marked delivered (this report's
 *     delivered list counts); undelivered lists the ones it did not.
 *   reverts: UPDATE reverted_at where the row was undone and not yet put back.
 * Malformed input throws; cleanAcks is the route's check.
 * @param {string} clientId
 * @param {{ acks?: unknown, reverts?: unknown, delivered?: unknown }} report
 * @param {number} [now]
 * @returns {Promise<{ acked: string[], reverted: string[], delivered: string[], undelivered: string[] } | null>}
 */
export async function dbAckChanges(clientId, { acks, reverts, delivered }, now = Date.now()) {
  const clean = cleanAcks(acks, reverts, delivered);
  if (!clean || typeof clientId !== "string" || !clientId || !Number.isFinite(now)) throw new Error("bad ack");
  const q = sql();
  if (!q) return null;
  /** @type {{ acked: string[], reverted: string[], delivered: string[], undelivered: string[] }} */
  const none = { acked: [], reverted: [], delivered: [], undelivered: [] };
  if (!clean.acks.length && !clean.reverts.length && !clean.delivered.length) return none;
  await ensureSchema(q);
  const nowIso = new Date(now).toISOString();
  const autoKept = clean.acks.filter((a) => a.outcome === "auto_kept").map((a) => a.id);
  /** @type {[keyof typeof none, any][]} */
  const steps = [];
  // Instants compare as text in C order: every one is a toISOString() of the same width.
  if (clean.delivered.length) steps.push(["delivered", q`UPDATE trainer_changes t SET delivered_at = GREATEST(LEAST(d.at COLLATE "C", ${nowIso}::text),
    to_char(timestamp 'epoch' + t.created_at * interval '1 millisecond', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
FROM (SELECT e->>'id' AS id, e->>'at' AS at FROM jsonb_array_elements(${JSON.stringify(clean.delivered)}::jsonb) AS e) d
WHERE t.id = d.id AND t.client_account_id = ${clientId} AND t.kind = 'session' AND t.undone_at IS NULL AND t.delivered_at IS NULL
RETURNING t.id`]);
  if (clean.acks.length) steps.push(["acked", q`UPDATE trainer_changes t SET outcome = a.outcome,
  applied_at = CASE WHEN a.outcome IN ('applied', 'kept', 'auto_kept') THEN a.at ELSE NULL END
FROM (SELECT e->>'id' AS id, e->>'outcome' AS outcome, e->>'at' AS at FROM jsonb_array_elements(${JSON.stringify(clean.acks)}::jsonb) AS e) a
WHERE t.id = a.id AND t.client_account_id = ${clientId} AND t.outcome IS NULL
  AND (a.outcome <> 'auto_kept' OR t.delivered_at IS NOT NULL)
RETURNING t.id`]);
  if (clean.reverts.length) steps.push(["reverted", q`UPDATE trainer_changes t SET reverted_at = r.at
FROM (SELECT e->>'id' AS id, e->>'at' AS at FROM jsonb_array_elements(${JSON.stringify(clean.reverts)}::jsonb) AS e) r
WHERE t.id = r.id AND t.client_account_id = ${clientId} AND t.undone_at IS NOT NULL AND t.reverted_at IS NULL
RETURNING t.id`]);
  // Read only: the auto-keeps refused above because the row was never marked delivered.
  if (autoKept.length) steps.push(["undelivered", q`SELECT id FROM trainer_changes
WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(autoKept)}::jsonb)) AND client_account_id = ${clientId}
  AND kind = 'session' AND outcome IS NULL AND undone_at IS NULL AND delivered_at IS NULL`]);
  const results = steps.length > 1 ? await q.transaction(steps.map(([, s]) => s)) : [await steps[0][1]];
  const out = { ...none };
  steps.forEach(([key], i) => { out[key] = results[i].map((x) => x.id).sort(); });
  return out;
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
 *   after: any, basis: any, at: number, appliedAt: string | null, undone: boolean, by: string | null,
 *   deliveredAt: string | null, editsLive: boolean, authorId?: string | null }} DeliveredChange
 * deliveredAt: a session row's first arrival on any of the client's devices.
 * editsLive: the grant still delivers it (a session auto-keeps only then).
 * authorId: a session row's trainer account (loggedBy.accountId at Keep);
 * absent on every other kind.
 */

/**
 * What the client's app should do on its pull, for one profile. Read only.
 *   To apply: sent, not landed, not undone, on a grant that is live with
 *     changes on since before the change was sent (created_at > edits_at),
 *     from the grant's own trainer, who is still a live trainer.
 *   To put back: undone after it landed, not yet put back, not a week, in
 *     any grant state.
 *   A session already on their device (delivered_at set), not withdrawn and
 *     not decided: in any grant state, so the card stays until they decide.
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
  c.created_at, c.applied_at, c.outcome, c.undone_at, c.delivered_at, c.author_account_id,
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
    OR (c.undone_at IS NOT NULL AND c.outcome = 'applied' AND c.reverted_at IS NULL AND c.kind <> 'week')
    OR (c.kind = 'session' AND c.outcome IS NULL AND c.undone_at IS NULL AND c.delivered_at IS NOT NULL))
ORDER BY c.created_at, c.id
LIMIT ${DELIVER_MAX}`;
  /** @type {DeliveredChange[]} */
  const out = [];
  for (const r of rows) {
    const undone = r.undone_at != null;
    const live = deliverable(r);
    const onDevice = r.kind === SESSION_KIND && r.delivered_at != null;
    if (!undone && !live && !onDevice) continue;
    out.push({
      id: r.id, set: r.set_id, kind: r.kind, target: r.target, from: r.effective_from ?? null,
      before: r.old_value ?? null, after: r.new_value ?? null, basis: r.basis ?? null,
      at: Number(r.created_at), appliedAt: r.applied_at ?? null, undone,
      by: publicName({ handle: r.handle, display: r.display }),
      deliveredAt: r.delivered_at ?? null, editsLive: live,
      // A session only: who ran it, for the provenance the client's device
      // writes at Keep (loggedBy). It goes to the client's own app, never back
      // to a trainer.
      ...(r.kind === SESSION_KIND ? { authorId: typeof r.author_account_id === "string" ? r.author_account_id : null } : {}),
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
 * with how many changes its set holds, and the budget (plan sets, and
 * sessions apart). Never the basis. Read
 * only.
 * @param {string} ref  the grant id
 * @param {string} trainerId
 * @param {number} [now]
 * @returns {Promise<{ open: (ChangeRow & { setSize: number })[] } & Budget | null>}
 */
export async function dbOpenChangesForGrant(ref, trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const [rows, budget] = await Promise.all([
    q`SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,
  c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at, c.delivered_at,
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
 * @returns {Promise<{ rows: TrainerChangeRow[] } & Budget | null>}
 */
export async function dbChangesForTrainer(ref, trainerId, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const [rows, budget] = await Promise.all([
    q`SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,
  c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at, c.delivered_at,
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
  c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at, c.delivered_at,
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
