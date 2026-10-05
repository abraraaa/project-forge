// @ts-check
// lib/notices.js
// ─────────────────────────────────────────────────────────────────────────────
// The home dot, derived. There is no notices table: every kind is a read of
// rows that already exist (a bug report, an application, a client's synced
// session) against the account's "seen" mark for that kind. Nothing grows,
// so nothing ever needs sweeping. Server-only; null when no DB is configured.
//
// Writes here, named:
//   · dbMarkSeen: the account's one mark per kind in notice_marks, INSERTed
//     or overwritten in place (seen_at). Written after a successful admin bug
//     list (kind bugs) and a successful roster list (kind clients).
// The applicant's "application" kind clears through dbSeenApplication and the
// admin's "applications" kind by deciding (lib/trainer-store.js,
// lib/identity-store.js).
// ─────────────────────────────────────────────────────────────────────────────

import { sql, ensureSchema } from "./db.js";
import { isAdminIdentity, trainerOpenFor } from "./auth-server.js";
import { entitled } from "./entitlements.js";
import { DETAIL_DAYS, trainerToday } from "./trainer-view.js";
import { addDaysIso } from "./dates.js";

/** Every kind the dot reads. No CHECK on notice_marks.kind, so the list lives here. */
export const NOTICE_KINDS = Object.freeze(["bugs", "applications", "application", "clients"]);
/** The kinds with a mark row. "application" is seen_at on the row itself; "applications" is a queue. */
export const MARKED_KINDS = Object.freeze(["bugs", "clients"]);

/**
 * @typedef {{ bugs?: number, applications?: number, application?: "approved" | "denied", clients?: true }} NoticeDots
 */

/**
 * The account has seen this kind now. INSERTs its mark, or OVERWRITES the
 * one row for (account, kind) in place. Nothing else writes notice_marks.
 * @param {string} accountId
 * @param {string} kind  one of MARKED_KINDS
 * @param {number} [now]  epoch ms, taken before the read it marks
 * @returns {Promise<boolean | null>}
 */
export async function dbMarkSeen(accountId, kind, now = Date.now()) {
  if (!accountId || !MARKED_KINDS.includes(kind) || !Number.isFinite(now)) throw new Error("bad notice mark");
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  await q`INSERT INTO notice_marks (account_id, kind, seen_at) VALUES (${accountId}, ${kind}, ${now})
  ON CONFLICT (account_id, kind) DO UPDATE SET seen_at = EXCLUDED.seen_at`;
  return true;
}

/**
 * What is new for this account, as the dots object: a key only when there is
 * something, never a name or content. Read only.
 *   bugs, applications: the admin's (isAdminIdentity, server-side).
 *   application: the caller's own decided row, until they have seen it.
 *   clients: a trainer (entitled trainer.dashboard, trainerOpenFor) with any
 *     live grant whose client has a session that arrived after both the mark
 *     and the grant, dated within the 24-week share window.
 * @param {import("./identity.js").Identity} identity
 * @param {{ roles?: unknown, plan?: string }} account  roles and plan, for entitled()
 * @param {number} [now]
 * @returns {Promise<NoticeDots | null>}
 */
export async function dbNotices(identity, account, now = Date.now()) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const me = identity.accountId;
  const admin = isAdminIdentity(identity);
  const trainer = entitled(account, "trainer.dashboard") && trainerOpenFor(identity);
  // The share window, by the server's UTC day; a day of slack ahead for a client east of UTC.
  const today = trainerToday(null, now);
  const from = addDaysIso(today, -DETAIL_DAYS);
  const to = addDaysIso(today, 1);
  const none = Promise.resolve(null);
  const [bugs, applications, application, clients] = await Promise.all([
    admin
      ? q`SELECT count(*)::int AS n FROM bug_reports
  WHERE status = 'new'
    AND created_at > to_timestamp(COALESCE((SELECT m.seen_at FROM notice_marks m WHERE m.account_id = ${me} AND m.kind = 'bugs'), 0) / 1000.0)`
      : none,
    admin
      ? q`SELECT count(*)::int AS n FROM trainer_applications ta
  JOIN accounts a ON a.id = ta.account_id AND a.deleted_at IS NULL
  WHERE ta.status = 'applied'`
      : none,
    q`SELECT status FROM trainer_applications
  WHERE account_id = ${me} AND status IN ('approved', 'denied') AND seen_at IS NULL`,
    // The live-grant predicate is dbTrainerGrants' (lib/trainer-store.js), verbatim.
    trainer
      ? q`SELECT EXISTS (SELECT 1 FROM oauth_grants g
  JOIN accounts a ON a.id = g.account_id AND a.deleted_at IS NULL
  JOIN credentials c ON c.id = g.credential_id AND c.account_id = g.account_id AND c.rp_id = 'heatwayve.app'
  WHERE g.kind = 'trainer' AND g.trainer_account_id = ${me} AND g.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM sessions s
      WHERE s.profile = g.profile
        AND s.updated_at > to_timestamp(GREATEST(COALESCE((SELECT m.seen_at FROM notice_marks m WHERE m.account_id = ${me} AND m.kind = 'clients'), 0), g.created_at) / 1000.0)
        AND s.record->>'date' BETWEEN ${from} AND ${to})) AS lit`
      : none,
  ]);
  /** @type {NoticeDots} */
  const dots = {};
  const nBugs = Number(bugs?.[0]?.n) || 0;
  const nApps = Number(applications?.[0]?.n) || 0;
  const decided = application?.[0]?.status;
  if (nBugs > 0) dots.bugs = nBugs;
  if (nApps > 0) dots.applications = nApps;
  if (decided === "approved" || decided === "denied") dots.application = decided;
  if (clients?.[0]?.lit === true) dots.clients = true;
  return dots;
}
