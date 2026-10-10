// The trainer changes store (lib/trainer-changes-store.js). The Neon driver is
// faked with small in-memory tables that answer only the pinned statements, so
// every function runs for real and any drift in its SQL fails here. The only
// writes: the change-set INSERT (behind its advisory lock, in one transaction),
// five UPDATEs of trainer_changes (withdraw, undo, delivered, acks, reverts)
// and two of oauth_grants (the changes switch). No DELETE.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = 1_800_000_000_000;
const id26 = (c) => "hwa_" + c.repeat(26);
const A = id26("a"); // the client
const B = id26("b"); // another client
const T = id26("t"); // their trainer, "tia"
const N = id26("n"); // another trainer, "nia"
const setId = (c) => "hws_" + c.repeat(26);
const S1 = setId("a");
const S2 = setId("b");
const AT = "2026-10-05T10:00:00.000Z";
const flat = (s) => s.replace(/\s+/g, " ").trim();

// ── The statements, as the store sends them (whitespace collapsed). ────────────
const LIVE_JOIN = "COALESCE(g.revoked_at IS NULL AND g.trainer_account_id = c.author_account_id"
  + " AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at) AND c.created_at > g.edits_at"
  + " AND EXISTS (SELECT 1 FROM accounts a JOIN credentials k ON k.account_id = a.id"
  + " WHERE a.id = g.account_id AND a.deleted_at IS NULL AND k.id = g.credential_id AND k.rp_id = 'heatwayve.app'), false) AS grant_live,"
  + " t.roles AS trainer_roles, t.plan AS trainer_plan, t.trainer_terms, t.deleted_at AS trainer_deleted_at, h.handle, h.display"
  + " FROM trainer_changes c LEFT JOIN oauth_grants g ON g.id = c.grant_id AND g.kind = 'trainer'"
  + " LEFT JOIN accounts t ON t.id = c.author_account_id"
  + " LEFT JOIN LATERAL (SELECT handle, display FROM handles WHERE account_id = c.author_account_id AND kind = 'primary'"
  + " ORDER BY released_at DESC NULLS FIRST LIMIT 1) h ON true";
// A session standing for its day and letter: not withdrawn, and waiting or kept; never one
// that did not reach their device on a grant since revoked.
const STANDING = "SELECT 1 FROM trainer_changes d WHERE d.client_account_id = ?::text AND d.kind = 'session'"
  + " AND d.target = o.op->>'target' AND d.undone_at IS NULL AND (d.outcome IS NULL OR d.outcome IN ('kept', 'auto_kept'))"
  + " AND NOT (d.outcome IS NULL AND d.delivered_at IS NULL"
  + " AND EXISTS (SELECT 1 FROM oauth_grants dg WHERE dg.id = d.grant_id AND dg.revoked_at IS NOT NULL))";
const BUDGET = "SELECT count(DISTINCT set_id)::int AS used, min(created_at) AS oldest FROM trainer_changes"
  + " WHERE grant_id IN (SELECT g.id FROM oauth_grants g JOIN oauth_grants r"
  + " ON r.account_id = g.account_id AND r.trainer_account_id = g.trainer_account_id WHERE r.id = ?)";
const SQL = {
  lock: "SELECT pg_advisory_xact_lock(hashtext('tc:' || ?::text || ':' || ?::text))",
  insert: "INSERT INTO trainer_changes (id, set_id, grant_id, profile, client_account_id, author_account_id, source, status, kind, target,"
    + " old_value, new_value, basis, warnings, effective_from, created_at)"
    + " SELECT ?::text || '.' || lpad((o.i - 1)::text, 2, '0'), ?::text, ?::text, ?::text, ?::text, ?::text, 'trainer', 'sent', o.op->>'kind', o.op->>'target',"
    + " NULLIF(o.op->'before', 'null'::jsonb), NULLIF(o.op->'after', 'null'::jsonb), NULLIF(o.op->'basis', 'null'::jsonb),"
    + " NULLIF(o.op->'warnings', 'null'::jsonb), o.op->>'from', ?::bigint"
    + " FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS o(op, i)"
    + " WHERE NOT EXISTS (SELECT 1 FROM trainer_changes x WHERE x.set_id = ?::text)"
    + " AND EXISTS (SELECT 1 FROM oauth_grants r WHERE r.id = ?::text AND r.account_id = ?::text AND r.trainer_account_id = ?::text)"
    + " AND (o.op->>'kind' = 'session' OR (SELECT count(DISTINCT b.set_id) FROM trainer_changes b"
    + " WHERE b.grant_id IN (SELECT g.id FROM oauth_grants g WHERE g.account_id = ?::text AND g.trainer_account_id = ?::text)"
    + " AND b.source = 'trainer' AND b.kind <> 'session' AND b.created_at > ?::bigint) < ?::int)"
    + " AND (o.op->>'kind' <> 'session' OR ((SELECT count(DISTINCT s.set_id) FROM trainer_changes s"
    + " WHERE s.grant_id IN (SELECT g.id FROM oauth_grants g WHERE g.account_id = ?::text AND g.trainer_account_id = ?::text)"
    + " AND s.source = 'trainer' AND s.kind = 'session' AND s.created_at > ?::bigint) < ?::int"
    + " AND NOT EXISTS (" + STANDING + ")))"
    + " ON CONFLICT (id) DO NOTHING RETURNING id",
  standing: "SELECT EXISTS (" + STANDING.replace("o.op->>'target'", "?::text") + ") AS standing",
  seen: "SELECT EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ? AND grant_id = ? AND author_account_id = ?) AS mine,"
    + " EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ?) AS taken,"
    + " EXISTS (SELECT 1 FROM oauth_grants WHERE id = ? AND account_id = ? AND trainer_account_id = ?) AS fits,"
    + " (SELECT count(*) FROM trainer_changes WHERE set_id = ?) = jsonb_array_length(?::jsonb)"
    + " AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS o(op, i)"
    + " WHERE NOT EXISTS (SELECT 1 FROM trainer_changes t WHERE t.id = ?::text || '.' || lpad((o.i - 1)::text, 2, '0')"
    + " AND t.kind = o.op->>'kind' AND t.target = o.op->>'target'"
    + " AND t.new_value IS NOT DISTINCT FROM NULLIF(o.op->'after', 'null'::jsonb)"
    + " AND t.effective_from IS NOT DISTINCT FROM o.op->>'from')) AS same",
  budget: BUDGET + " AND source = 'trainer' AND kind <> 'session' AND created_at > ?::bigint",
  sessionBudget: BUDGET + " AND source = 'trainer' AND kind = 'session' AND created_at > ?::bigint",
  withdraw: "UPDATE trainer_changes SET undone_at = ?, undone_by = 'trainer'"
    + " WHERE (id = ? OR set_id = ?) AND grant_id = ? AND author_account_id = ? AND undone_at IS NULL"
    + " AND (outcome IS NULL"
    + " OR (outcome = 'applied' AND kind <> 'week' AND id IN (SELECT jsonb_array_elements_text(?::jsonb))))"
    + " AND (kind <> 'session' OR delivered_at IS NULL) RETURNING id",
  undo: "UPDATE trainer_changes SET undone_at = ?, undone_by = 'client',"
    + " reverted_at = CASE WHEN outcome = 'applied' THEN COALESCE(reverted_at, ?::text) ELSE reverted_at END"
    + " WHERE (id = ? OR set_id = ?) AND client_account_id = ? AND undone_at IS NULL AND kind <> 'session' RETURNING id",
  delivered: "UPDATE trainer_changes t SET delivered_at = GREATEST(LEAST(d.at COLLATE \"C\", ?::text),"
    + " to_char(timestamp 'epoch' + t.created_at * interval '1 millisecond', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))"
    + " FROM (SELECT e->>'id' AS id, e->>'at' AS at FROM jsonb_array_elements(?::jsonb) AS e) d"
    + " WHERE t.id = d.id AND t.client_account_id = ? AND t.kind = 'session' AND t.undone_at IS NULL AND t.delivered_at IS NULL RETURNING t.id",
  ack: "UPDATE trainer_changes t SET outcome = a.outcome, applied_at = CASE WHEN a.outcome IN ('applied', 'kept', 'auto_kept') THEN a.at ELSE NULL END"
    + " FROM (SELECT e->>'id' AS id, e->>'outcome' AS outcome, e->>'at' AS at FROM jsonb_array_elements(?::jsonb) AS e) a"
    + " WHERE t.id = a.id AND t.client_account_id = ? AND t.outcome IS NULL"
    + " AND (a.outcome <> 'auto_kept' OR t.delivered_at IS NOT NULL) RETURNING t.id",
  revert: "UPDATE trainer_changes t SET reverted_at = r.at"
    + " FROM (SELECT e->>'id' AS id, e->>'at' AS at FROM jsonb_array_elements(?::jsonb) AS e) r"
    + " WHERE t.id = r.id AND t.client_account_id = ? AND t.undone_at IS NOT NULL AND t.reverted_at IS NULL RETURNING t.id",
  undelivered: "SELECT id FROM trainer_changes WHERE id IN (SELECT jsonb_array_elements_text(?::jsonb)) AND client_account_id = ?"
    + " AND kind = 'session' AND outcome IS NULL AND undone_at IS NULL AND delivered_at IS NULL",
  editsOff: "UPDATE oauth_grants SET edits_off_at = GREATEST(?::bigint, edits_at)"
    + " WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL AND edits_at IS NOT NULL RETURNING id",
  editsOn: "UPDATE oauth_grants SET edits_at = GREATEST(?::bigint, COALESCE(edits_off_at, 0) + 1)"
    + " WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL AND consent_version = ?"
    + " AND NOT (edits_at IS NOT NULL AND (edits_off_at IS NULL OR edits_off_at < edits_at)) RETURNING id",
  editsState: "SELECT consent_version, edits_at, edits_off_at FROM oauth_grants WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL",
  deliver: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.basis,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.delivered_at, c.author_account_id, " + LIVE_JOIN
    + " WHERE c.profile = ? AND c.source = 'trainer' AND c.status = 'sent' AND c.cleared_at IS NULL"
    + " AND ((c.outcome IS NULL AND c.undone_at IS NULL AND g.revoked_at IS NULL AND g.trainer_account_id = c.author_account_id"
    + " AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at) AND c.created_at > g.edits_at)"
    + " OR (c.undone_at IS NOT NULL AND c.outcome = 'applied' AND c.reverted_at IS NULL AND c.kind <> 'week')"
    + " OR (c.kind = 'session' AND c.outcome IS NULL AND c.undone_at IS NULL AND c.delivered_at IS NOT NULL))"
    + " ORDER BY c.created_at, c.id LIMIT ?",
  openGrant: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at, c.delivered_at,"
    + " (SELECT count(*) FROM trainer_changes s WHERE s.set_id = c.set_id)::int AS set_size"
    + " FROM trainer_changes c JOIN oauth_grants g ON g.id = c.grant_id"
    + " WHERE c.grant_id = ? AND c.author_account_id = ? AND c.source = 'trainer' AND c.status = 'sent'"
    + " AND c.outcome IS NULL AND c.undone_at IS NULL AND c.created_at > COALESCE(g.edits_at, 0) ORDER BY c.created_at, c.id",
  trainerList: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at, c.delivered_at,"
    + " COALESCE(g.revoked_at IS NULL AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at)"
    + " AND c.created_at > g.edits_at, false) AS edits_live"
    + " FROM trainer_changes c LEFT JOIN oauth_grants g ON g.id = c.grant_id"
    + " WHERE c.grant_id = ? AND c.author_account_id = ? AND c.source = 'trainer' AND c.status = 'sent'"
    + " AND (c.created_at > ?::bigint OR (c.outcome IS NULL AND c.undone_at IS NULL)) ORDER BY c.created_at DESC, c.id LIMIT ?",
  trainerGrant: "SELECT g.id, g.profile, g.scope, g.created_at, g.last_used_at, g.edits_at, g.edits_off_at, g.consent_version, h.handle, h.display"
    + " FROM oauth_grants g JOIN accounts a ON a.id = g.account_id AND a.deleted_at IS NULL"
    + " JOIN credentials c ON c.id = g.credential_id AND c.account_id = g.account_id AND c.rp_id = 'heatwayve.app'"
    + " LEFT JOIN handles h ON h.account_id = g.account_id AND h.kind = 'primary' AND h.released_at IS NULL"
    + " WHERE g.kind = 'trainer' AND g.trainer_account_id = ? AND g.revoked_at IS NULL AND g.id = ? ORDER BY g.created_at DESC",
  clientGrant: "SELECT edits_at, edits_off_at FROM oauth_grants WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL",
  clientList: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.basis, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at, c.delivered_at, " + LIVE_JOIN
    + " WHERE c.client_account_id = ? AND c.source = 'trainer' AND c.status = 'sent'"
    + " AND (c.created_at > ?::bigint OR (c.outcome IS NULL AND c.undone_at IS NULL)) ORDER BY c.created_at DESC, c.id LIMIT ?",
};

// ── The fake: each pinned statement, by hand, over in-memory rows. ─────────────
const db = { changes: [], grants: [], accounts: new Map(), credentials: [], handles: [] };
const calls = [];
const locks = [];
let txs = 0;
const big = (v) => (v == null ? null : String(v)); // BIGINT comes back as a string, as from Neon
const editsOn = (g) => g.edits_at != null && (g.edits_off_at == null || g.edits_off_at < g.edits_at);
const sortAsc = (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1);
const sortDesc = (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1);
const out = (c, cols) => Object.fromEntries(cols.map((k) => [k, ["created_at", "undone_at", "cleared_at"].includes(k) ? big(c[k]) : c[k] ?? null]));
const CORE = ["id", "set_id", "kind", "target", "effective_from", "old_value", "new_value"];
const TAIL = ["created_at", "applied_at", "outcome", "undone_at", "undone_by", "reverted_at", "delivered_at"];

function liveJoin(c) {
  const g = db.grants.find((x) => x.id === c.grant_id && x.kind === "trainer");
  const a = g && db.accounts.get(g.account_id);
  const grant_live = !!g && g.revoked_at == null && g.trainer_account_id === c.author_account_id && editsOn(g)
    && c.created_at > g.edits_at && !!a && a.deleted_at == null
    && db.credentials.some((k) => k.account_id === a.id && k.id === g.credential_id && k.rp_id === "heatwayve.app");
  const t = db.accounts.get(c.author_account_id);
  const h = db.handles.filter((x) => x.account_id === c.author_account_id && x.kind === "primary")
    .sort((x, y) => (x.released_at == null ? -1 : y.released_at == null ? 1 : y.released_at - x.released_at))[0];
  return { grant_live, trainer_roles: t?.roles ?? null, trainer_plan: t?.plan ?? null, trainer_terms: t?.trainer_terms ?? null,
    trainer_deleted_at: t?.deleted_at ?? null, handle: h?.handle ?? null, display: h?.display ?? null };
}
/** The budget over every grant between one client and one trainer: plan sets, or sessions. */
const budgetOf = (client, trainer, since, sessions = false) => {
  const grants = new Set(db.grants.filter((g) => g.account_id === client && g.trainer_account_id === trainer).map((g) => g.id));
  const rows = db.changes.filter((c) => grants.has(c.grant_id) && c.source === "trainer" && (c.kind === "session") === sessions && c.created_at > since);
  return [{ used: new Set(rows.map((c) => c.set_id)).size, oldest: rows.length ? big(Math.min(...rows.map((c) => c.created_at))) : null }];
};
const budget = (grant, since, sessions = false) => {
  const r = db.grants.find((g) => g.id === grant);
  return r ? budgetOf(r.account_id, r.trainer_account_id, since, sessions) : [{ used: 0, oldest: null }];
};
/** A standing session for the client's day and letter: not withdrawn, waiting or kept; not undelivered on a revoked grant. */
const standing = (client, target) => db.changes.some((d) => d.client_account_id === client && d.kind === "session" && d.target === target
  && d.undone_at == null && (d.outcome == null || ["kept", "auto_kept"].includes(d.outcome))
  && !(d.outcome == null && d.delivered_at == null && db.grants.some((g) => g.id === d.grant_id && g.revoked_at != null)));
/** An epoch-ms server time as the SQL's to_char writes it. */
const iso = (ms) => new Date(ms).toISOString();
const fits = (grant, client, trainer) => db.grants.some((g) => g.id === grant && g.account_id === client && g.trainer_account_id === trainer);
const pad = (i) => String(i).padStart(2, "0");
const liveWhere = (c) => {
  const g = db.grants.find((x) => x.id === c.grant_id && x.kind === "trainer");
  return !!g && g.revoked_at == null && g.trainer_account_id === c.author_account_id && editsOn(g) && c.created_at > g.edits_at;
};
const window = (c, since) => c.created_at > since || (c.outcome == null && c.undone_at == null);
const blank = (v) => (v === null || v === undefined ? null : v);

const HANDLERS = {
  [flat(SQL.lock)]: ([client, trainer]) => { locks.push(`tc:${client}:${trainer}`); return [{ pg_advisory_xact_lock: "" }]; },
  [flat(SQL.insert)]: ([id1, set, grant, profile, client, author, now, ops, set2, grant2, client2, author2, client3, author3, since, cap,
    client4, author4, since2, sessionCap, client5]) => {
    expect([id1, set2, grant2, client2, author2, client3, author3, client4, author4, since2, client5])
      .toEqual([set, set, grant, client, author, client, author, client, author, since, client]);
    if (db.changes.some((c) => c.set_id === set)) return [];
    if (!fits(grant, client, author)) return [];
    // Every op is judged against the table as it stood before the statement.
    const planFull = budgetOf(client, author, since)[0].used >= cap;
    const sessionsFull = budgetOf(client, author, since, true)[0].used >= sessionCap;
    const list = JSON.parse(ops);
    const stands = list.map((op) => standing(client, op.target));
    const made = [];
    list.forEach((op, i) => {
      const id = `${set}.${pad(i)}`;
      if (db.changes.some((c) => c.id === id)) return;
      if (op.kind === "session" ? sessionsFull || stands[i] : planFull) return;
      db.changes.push({ id, set_id: set, grant_id: grant, profile, client_account_id: client, author_account_id: author,
        source: "trainer", status: "sent", kind: op.kind, target: op.target, old_value: blank(op.before), new_value: blank(op.after),
        basis: blank(op.basis), warnings: blank(op.warnings), effective_from: op.from ?? null, created_at: now,
        applied_at: null, outcome: null, undone_at: null, undone_by: null, reverted_at: null, cleared_at: null, delivered_at: null });
      made.push({ id });
    });
    return made;
  },
  [flat(SQL.seen)]: ([set, grant, author, set2, grant3, client3, author3, set4, ops, ops2, set5]) => {
    expect([set2, set4, set5, ops2]).toEqual([set, set, set, ops]);
    const list = JSON.parse(ops);
    const stored = db.changes.filter((c) => c.set_id === set);
    const same = stored.length === list.length && list.every((o, i) => stored.some((c) => c.id === `${set}.${pad(i)}` && c.kind === o.kind
      && c.target === o.target && JSON.stringify(c.new_value ?? null) === JSON.stringify(o.after ?? null) && (c.effective_from ?? null) === (o.from ?? null)));
    return [{
      mine: db.changes.some((c) => c.set_id === set && c.grant_id === grant && c.author_account_id === author),
      taken: db.changes.some((c) => c.set_id === set2),
      fits: fits(grant3, client3, author3),
      same,
    }];
  },
  [flat(SQL.standing)]: ([client, target]) => [{ standing: standing(client, target) }],
  [flat(SQL.budget)]: ([grant, since]) => budget(grant, since),
  [flat(SQL.sessionBudget)]: ([grant, since]) => budget(grant, since, true),
  [flat(SQL.withdraw)]: ([now, x, x2, ref, me, inForce]) => db.changes
    .filter((c) => (c.id === x || c.set_id === x2) && c.grant_id === ref && c.author_account_id === me && c.undone_at == null
      && (c.outcome == null || (c.outcome === "applied" && c.kind !== "week" && JSON.parse(inForce).includes(c.id)))
      && (c.kind !== "session" || c.delivered_at == null))
    .map((c) => { Object.assign(c, { undone_at: now, undone_by: "trainer" }); return { id: c.id }; }),
  [flat(SQL.undo)]: ([now, reverted, x, x2, me]) => db.changes
    .filter((c) => (c.id === x || c.set_id === x2) && c.client_account_id === me && c.undone_at == null && c.kind !== "session")
    .map((c) => {
      Object.assign(c, { undone_at: now, undone_by: "client", reverted_at: c.outcome === "applied" ? c.reverted_at ?? reverted : c.reverted_at });
      return { id: c.id };
    }),
  [flat(SQL.delivered)]: ([nowIso, json, me]) => JSON.parse(json).flatMap((d) => {
    const c = db.changes.find((x) => x.id === d.id && x.client_account_id === me && x.kind === "session" && x.undone_at == null && x.delivered_at == null);
    if (!c) return [];
    const upper = d.at < nowIso ? d.at : nowIso;
    c.delivered_at = upper > iso(c.created_at) ? upper : iso(c.created_at);
    return [{ id: c.id }];
  }),
  [flat(SQL.ack)]: ([json, me]) => JSON.parse(json).flatMap((a) => {
    const c = db.changes.find((x) => x.id === a.id && x.client_account_id === me && x.outcome == null
      && (a.outcome !== "auto_kept" || x.delivered_at != null));
    if (!c) return [];
    Object.assign(c, { outcome: a.outcome, applied_at: ["applied", "kept", "auto_kept"].includes(a.outcome) ? a.at : null });
    return [{ id: c.id }];
  }),
  [flat(SQL.undelivered)]: ([json, me]) => db.changes
    .filter((c) => JSON.parse(json).includes(c.id) && c.client_account_id === me && c.kind === "session" && c.outcome == null
      && c.undone_at == null && c.delivered_at == null)
    .map((c) => ({ id: c.id })),
  [flat(SQL.revert)]: ([json, me]) => JSON.parse(json).flatMap((r) => {
    const c = db.changes.find((x) => x.id === r.id && x.client_account_id === me && x.undone_at != null && x.reverted_at == null);
    if (!c) return [];
    c.reverted_at = r.at;
    return [{ id: c.id }];
  }),
  [flat(SQL.editsOff)]: ([now, me]) => db.grants
    .filter((g) => g.account_id === me && g.kind === "trainer" && g.revoked_at == null && g.edits_at != null)
    .map((g) => { g.edits_off_at = Math.max(now, g.edits_at); return { id: g.id }; }),
  [flat(SQL.editsOn)]: ([now, me, version]) => db.grants
    .filter((g) => g.account_id === me && g.kind === "trainer" && g.revoked_at == null && g.consent_version === version && !editsOn(g))
    .map((g) => { g.edits_at = Math.max(now, (g.edits_off_at ?? 0) + 1); return { id: g.id }; }),
  [flat(SQL.editsState)]: ([me]) => db.grants
    .filter((g) => g.account_id === me && g.kind === "trainer" && g.revoked_at == null)
    .map((g) => ({ consent_version: g.consent_version, edits_at: big(g.edits_at), edits_off_at: big(g.edits_off_at) })),
  [flat(SQL.deliver)]: ([profile, limit]) => db.changes
    .filter((c) => c.profile === profile && c.source === "trainer" && c.status === "sent" && c.cleared_at == null
      && ((c.outcome == null && c.undone_at == null && liveWhere(c))
        || (c.undone_at != null && c.outcome === "applied" && c.reverted_at == null && c.kind !== "week")
        || (c.kind === "session" && c.outcome == null && c.undone_at == null && c.delivered_at != null)))
    .sort(sortAsc).slice(0, limit)
    .map((c) => ({ ...out(c, [...CORE, "basis", "created_at", "applied_at", "outcome", "undone_at", "delivered_at", "author_account_id"]), ...liveJoin(c) })),
  [flat(SQL.openGrant)]: ([ref, me]) => db.changes
    .filter((c) => {
      const g = db.grants.find((x) => x.id === c.grant_id);
      return g && c.grant_id === ref && c.author_account_id === me && c.source === "trainer" && c.status === "sent"
        && c.outcome == null && c.undone_at == null && c.created_at > (g.edits_at ?? 0);
    })
    .sort(sortAsc)
    .map((c) => ({ ...out(c, [...CORE, "warnings", ...TAIL]), set_size: db.changes.filter((x) => x.set_id === c.set_id).length })),
  [flat(SQL.trainerList)]: ([ref, me, since, limit]) => db.changes
    .filter((c) => c.grant_id === ref && c.author_account_id === me && c.source === "trainer" && c.status === "sent" && window(c, since))
    .sort(sortDesc).slice(0, limit)
    .map((c) => {
      const g = db.grants.find((x) => x.id === c.grant_id);
      return { ...out(c, [...CORE, "warnings", ...TAIL]), edits_live: !!g && g.revoked_at == null && editsOn(g) && c.created_at > g.edits_at };
    }),
  [flat(SQL.trainerGrant)]: ([me, ref]) => db.grants
    .filter((g) => g.kind === "trainer" && g.trainer_account_id === me && g.revoked_at == null && g.id === ref)
    .map((g) => ({ id: g.id, profile: g.profile, scope: g.scope, created_at: big(g.created_at), last_used_at: null,
      edits_at: big(g.edits_at), edits_off_at: big(g.edits_off_at), consent_version: g.consent_version ?? null, handle: "abe", display: "Abe" })),
  [flat(SQL.clientGrant)]: ([me]) => db.grants
    .filter((g) => g.account_id === me && g.kind === "trainer" && g.revoked_at == null)
    .map((g) => ({ edits_at: big(g.edits_at), edits_off_at: big(g.edits_off_at) })),
  [flat(SQL.clientList)]: ([me, since, limit]) => db.changes
    .filter((c) => c.client_account_id === me && c.source === "trainer" && c.status === "sent" && window(c, since))
    .sort(sortDesc).slice(0, limit)
    .map((c) => ({ ...out(c, [...CORE, "basis", "warnings", ...TAIL]), ...liveJoin(c) })),
};

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const q = async (strings, ...v) => {
      const text = strings.join("?");
      if (/^\s*(CREATE|ALTER)\b/.test(text)) return [];
      calls.push({ q: flat(text), v });
      const h = HANDLERS[flat(text)];
      if (!h) throw new Error(`unexpected SQL: ${flat(text)}`);
      return h(v);
    };
    q.transaction = async (list) => { txs++; return Promise.all(list); };
    return q;
  },
}));

const store = await import("../lib/trainer-changes-store.js");
const trainerStore = await import("../lib/trainer-store.js");
const change = await import("../lib/trainer-change.js");
const { TRAINER_TERMS_VERSION } = await import("../lib/trainer-terms.js");
const {
  dbInsertChangeSet, dbWithdrawChanges, dbUndoChanges, dbAckChanges, cleanAcks, dbEditsOff, dbEditsOn,
  dbOpenChangesFor, dbOpenChangesForGrant, dbChangesForTrainer, dbChangesForClient, isIsoInstant, DELIVER_MAX,
} = store;

const TERMS = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const GRANT = {
  id: "hwg_1", client_id: "hw:trainer", account_id: A, profile: "sk-a", credential_id: "cred-a", scope: "trainer:read",
  kind: "trainer", trainer_account_id: T, consent_version: "v1", created_at: NOW - 30 * DAY, revoked_at: null,
  edits_at: NOW - 20 * DAY, edits_off_at: null,
};
const writes = () => calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/.test(c.q));
const weightOp = (target = "Back Squat", after = 105, extra = {}) => ({
  kind: "weight", target, before: 100, after, basis: { anchorId: "2026-10-01T09:00:00.000Z", w: 100, r: 5 }, warnings: null, from: null, ...extra,
});
const send = (set, ops = [weightOp()], now = NOW, extra = {}) => dbInsertChangeSet(
  { setId: set, grantId: "hwg_1", profile: "sk-a", clientId: A, authorId: T, ops, ...extra }, now);
/** A stored row, as the INSERT would make it, for state the test sets up directly. */
const row = (id, extra = {}) => ({
  id, set_id: id.split(".")[0], grant_id: "hwg_1", profile: "sk-a", client_account_id: A, author_account_id: T, source: "trainer",
  status: "sent", kind: "weight", target: "Back Squat", old_value: 100, new_value: 105, basis: { anchorId: "r1", w: 100, r: 5 },
  warnings: null, effective_from: null, created_at: NOW - DAY, applied_at: null, outcome: null, undone_at: null, undone_by: null,
  reverted_at: null, cleared_at: null, delivered_at: null, ...extra,
});

let savedUrl;
beforeEach(() => {
  savedUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://fake";
  calls.length = 0;
  locks.length = 0;
  txs = 0;
  db.changes = [];
  db.grants = [{ ...GRANT }];
  db.accounts = new Map([
    [A, { id: A, roles: ["lifter"], plan: "free", trainer_terms: null, deleted_at: null }],
    [B, { id: B, roles: ["lifter"], plan: "free", trainer_terms: null, deleted_at: null }],
    [T, { id: T, roles: ["lifter", "trainer"], plan: "free", trainer_terms: TERMS, deleted_at: null }],
    [N, { id: N, roles: ["lifter", "trainer"], plan: "free", trainer_terms: TERMS, deleted_at: null }],
  ]);
  db.credentials = [{ id: "cred-a", account_id: A, rp_id: "heatwayve.app" }];
  db.handles = [
    { handle: "tia", display: "Tia", account_id: T, kind: "primary", released_at: null },
    { handle: "nia", display: "Nia", account_id: N, kind: "primary", released_at: null },
  ];
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
});

describe("no database", () => {
  it("every function returns null and sends nothing", async () => {
    delete process.env.DATABASE_URL;
    expect(await send(S1)).toBeNull();
    expect(await dbWithdrawChanges("hwg_1", T, S1, [], NOW)).toBeNull();
    expect(await dbUndoChanges(A, S1, null, NOW)).toBeNull();
    expect(await dbAckChanges(A, { acks: [{ id: `${S1}.0`, outcome: "applied", at: AT }] })).toBeNull();
    expect(await dbEditsOff(A, NOW)).toBeNull();
    expect(await dbEditsOn(A, "v1", NOW)).toBeNull();
    expect(await dbOpenChangesFor("sk-a")).toBeNull();
    expect(await dbOpenChangesForGrant("hwg_1", T, NOW)).toBeNull();
    expect(await dbChangesForTrainer("hwg_1", T, NOW)).toBeNull();
    expect(await dbChangesForClient(A, NOW)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("dbInsertChangeSet", () => {
  it("one INSERT behind the client and trainer's lock, in one transaction: a row per change, id = set.index in two digits, JSON null stored as no value", async () => {
    const ops = [weightOp(), { kind: "reps", target: "Back Squat", before: null, after: "8/leg", basis: null, warnings: ["double_progression"], from: null }];
    expect(await send(S1, ops)).toEqual({ inserted: [`${S1}.00`, `${S1}.01`] });
    expect(writes()).toHaveLength(1);
    expect(txs).toBe(1);
    expect(calls.map((c) => c.q)).toEqual([flat(SQL.lock), flat(SQL.insert)]);
    expect(calls[0].v).toEqual([A, T]);
    expect(locks).toEqual([`tc:${A}:${T}`]);
    expect(calls[1].v).toEqual([S1, S1, "hwg_1", "sk-a", A, T, NOW, JSON.stringify(ops), S1, "hwg_1", A, T, A, T, NOW - WEEK, 10,
      A, T, NOW - WEEK, 7, A]);
    expect(db.changes.map((r) => [r.id, r.kind, r.old_value, r.new_value, r.warnings, r.source, r.status, r.created_at])).toEqual([
      [`${S1}.00`, "weight", 100, 105, null, "trainer", "sent", NOW],
      [`${S1}.01`, "reps", null, "8/leg", ["double_progression"], "trainer", "sent", NOW],
    ]);
  });

  it("16 changes are set.00 to set.15: text order is op order", async () => {
    const ops = Array.from({ length: 16 }, (_, i) => weightOp(`Lift ${i}`));
    const { inserted } = /** @type {any} */ (await send(S1, ops));
    expect(inserted).toEqual(ops.map((_, i) => `${S1}.${String(i).padStart(2, "0")}`));
    expect([...inserted].sort()).toEqual(inserted);
    expect([...db.changes].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => c.target)).toEqual(ops.map((o) => o.target));
    // The stored ids still read through rowFromDb, and the set id is still the validator's.
    expect(change.rowFromDb(db.changes[15])).toMatchObject({ id: `${S1}.15`, set: S1 });
    expect(change.SET_ID_RE.test(db.changes[15].set_id)).toBe(true);
  });

  it("only the change's fields travel: anything else on an op (a note) is dropped before the SQL", async () => {
    await send(S1, [{ ...weightOp(), note: "free text", lift: "Back Squat" }]);
    expect(JSON.parse(calls[1].v[7])).toEqual([{ kind: "weight", target: "Back Squat", before: 100, after: 105,
      basis: { anchorId: "2026-10-01T09:00:00.000Z", w: 100, r: 5 }, warnings: null, from: null }]);
  });

  it("a replay of the same set writes nothing and reads as a replay; the same id with other changes is a mismatch; someone else's set id reads as taken", async () => {
    await send(S1);
    expect(await send(S1, [weightOp()], NOW + 1000)).toEqual({ replay: true });
    for (const ops of [[weightOp("Back Squat", 107.5)], [weightOp("Deadlift")], [weightOp(), weightOp("Deadlift", 140)],
      [weightOp("Back Squat", 105, { from: "2026-10-12" })], [{ ...weightOp(), kind: "reps", after: 105 }]]) {
      expect(await send(S1, ops, NOW + 1000), JSON.stringify(ops)).toEqual({ mismatch: true });
    }
    expect(db.changes).toHaveLength(1);
    db.grants.push({ ...GRANT, id: "hwg_2", account_id: B, profile: "sk-b", trainer_account_id: N });
    const other = await dbInsertChangeSet({ setId: S1, grantId: "hwg_2", profile: "sk-b", clientId: B, authorId: N, ops: [weightOp()] }, NOW);
    expect(other).toEqual({ taken: true });
    const seen = calls.filter((c) => c.q === flat(SQL.seen)).map((c) => c.v);
    const ops1 = JSON.stringify([weightOp()]);
    expect(seen[0]).toEqual([S1, "hwg_1", T, S1, "hwg_1", A, T, S1, ops1, ops1, S1]);
    expect(seen.at(-1)).toEqual([S1, "hwg_2", N, S1, "hwg_2", B, N, S1, ops1, ops1, S1]);
  });

  it("a grant that is not this client and trainer's writes nothing and throws", async () => {
    db.grants.push({ ...GRANT, id: "hwg_2", account_id: B, profile: "sk-b", trainer_account_id: N });
    await expect(send(S1, [weightOp()], NOW, { grantId: "hwg_2" })).rejects.toThrow();
    await expect(send(S1, [weightOp()], NOW, { authorId: N })).rejects.toThrow();
    expect(db.changes).toEqual([]);
  });

  it("the 11th set in 7 days is refused, with when the next one is free; withdrawn and undone sets count, older ones and other trainers' do not", async () => {
    for (let i = 0; i < 10; i++) {
      const id = `hws_${String.fromCharCode(99 + i).repeat(26)}`;
      db.changes.push(row(`${id}.00`, { created_at: NOW - 6 * DAY + i * 1000, undone_at: i < 3 ? NOW - DAY : null, undone_by: i < 3 ? "trainer" : null }));
    }
    db.changes.push(row(`${setId("z")}.00`, { created_at: NOW - WEEK })); // exactly 7 days old: out of the window
    db.grants.push({ ...GRANT, id: "hwg_2", trainer_account_id: N });
    db.changes.push(row(`${setId("y")}.00`, { grant_id: "hwg_2", author_account_id: N })); // another trainer's grant
    expect(await send(S1)).toEqual({ full: true, used: 10, freeAt: NOW - 6 * DAY + WEEK });
    expect(db.changes.filter((c) => c.set_id === S1)).toEqual([]);
    expect(calls.find((c) => c.q === flat(SQL.budget)).v).toEqual(["hwg_1", NOW - WEEK]);
    // One leaves the window: room for exactly one more.
    expect(await send(S1, [weightOp()], NOW + DAY)).toEqual({ inserted: [`${S1}.00`] });
    expect(await send(S2, [weightOp()], NOW + DAY)).toMatchObject({ full: true, used: 10 });
  });

  it("a re-share does not reset it: the count runs across every grant between this client and trainer", async () => {
    // Six sets on a grant since stopped, four on the share that replaced it.
    db.grants = [{ ...GRANT, id: "hwg_0", revoked_at: NOW - 2 * DAY }, { ...GRANT, created_at: NOW - 2 * DAY }];
    for (let i = 0; i < 10; i++) {
      const id = `hws_${String.fromCharCode(99 + i).repeat(26)}`;
      db.changes.push(row(`${id}.00`, { grant_id: i < 6 ? "hwg_0" : "hwg_1", created_at: NOW - 3 * DAY + i }));
    }
    expect(await send(S1)).toEqual({ full: true, used: 10, freeAt: NOW - 3 * DAY + WEEK });
    expect(db.changes.filter((c) => c.set_id === S1)).toEqual([]);
    // The trainer's lists read the same count from either grant.
    expect(await dbOpenChangesForGrant("hwg_1", T, NOW)).toMatchObject({ used: 10 });
    expect(await dbOpenChangesForGrant("hwg_0", T, NOW)).toMatchObject({ used: 10 });
    // Another client of the same trainer has a budget of their own.
    db.grants.push({ ...GRANT, id: "hwg_b", account_id: B, profile: "sk-b" });
    expect(await dbInsertChangeSet({ setId: S2, grantId: "hwg_b", profile: "sk-b", clientId: B, authorId: T, ops: [weightOp()] }, NOW))
      .toEqual({ inserted: [`${S2}.00`] });
    expect(locks.at(-1)).toBe(`tc:${B}:${T}`);
  });

  it("malformed input throws before any SQL", async () => {
    const bad = [
      { setId: "hws_short" }, { setId: S1.toUpperCase() }, { ops: [] }, { ops: Array.from({ length: 17 }, () => weightOp()) },
      { ops: [{ ...weightOp(), kind: "note" }] }, { ops: [{ ...weightOp(), target: "" }] }, { ops: [{ ...weightOp(), from: "13 Oct" }] },
      { grantId: "" }, { authorId: null },
    ];
    for (const b of bad) {
      await expect(dbInsertChangeSet({ setId: S1, grantId: "hwg_1", profile: "sk-a", clientId: A, authorId: T, ops: [weightOp()], ...b }, NOW))
        .rejects.toThrow();
    }
    expect(await send(S1, Array.from({ length: 16 }, (_, i) => weightOp(`Lift ${i}`)))).toMatchObject({ inserted: expect.any(Array) });
    expect(calls.filter((c) => c.q === flat(SQL.insert))).toHaveLength(1);
  });
});

describe("dbWithdrawChanges (the trainer)", () => {
  it("takes back their own changes that have not landed, and landed ones only when the route found them in force; never a week; by change or by set", async () => {
    db.changes = [
      row(`${S1}.00`), row(`${S1}.01`, { kind: "reps", outcome: "applied", applied_at: AT }),
      row(`${S1}.02`, { kind: "week", target: "week", outcome: "applied", applied_at: AT }),
      row(`${S1}.03`, { outcome: "superseded" }), row(`${S1}.04`, { undone_at: NOW - 5, undone_by: "client" }),
      row(`${S1}.05`, { outcome: "applied", applied_at: AT }), // landed, then trained at or changed: not in force
    ];
    const inForce = [`${S1}.01`, `${S1}.02`];
    expect(await dbWithdrawChanges("hwg_1", T, S1, inForce, NOW)).toEqual([`${S1}.00`, `${S1}.01`]);
    expect(calls[0]).toEqual({ q: flat(SQL.withdraw), v: [NOW, S1, S1, "hwg_1", T, JSON.stringify(inForce)] });
    expect(db.changes.map((c) => [c.undone_at, c.undone_by])).toEqual([
      [NOW, "trainer"], [NOW, "trainer"], [null, null], [null, null], [NOW - 5, "client"], [null, null],
    ]);
    expect(await dbWithdrawChanges("hwg_1", T, S1, inForce, NOW + 1)).toEqual([]);
    // Nothing passed as in force: a landed change stays, whatever the id names.
    expect(await dbWithdrawChanges("hwg_1", T, `${S1}.05`, [], NOW + 2)).toEqual([]);
    expect(db.changes[5].undone_at).toBeNull();
  });

  it("never another trainer's or another grant's; a malformed in-force list throws before any SQL", async () => {
    db.changes = [row(`${S1}.00`), row(`${S2}.00`, { grant_id: "hwg_2", author_account_id: N })];
    expect(await dbWithdrawChanges("hwg_1", N, S1, [], NOW)).toEqual([]);
    expect(await dbWithdrawChanges("hwg_1", T, S2, [], NOW)).toEqual([]);
    expect(await dbWithdrawChanges("hwg_1", T, `${S1}.00`, [], NOW)).toEqual([`${S1}.00`]);
    calls.length = 0;
    await expect(dbWithdrawChanges("hwg_1", T, "", [], NOW)).rejects.toThrow();
    for (const bad of [undefined, null, "x", [""], [7], Array.from({ length: 17 }, (_, i) => `${S1}.${i}`)]) {
      await expect(dbWithdrawChanges("hwg_1", T, S1, /** @type {any} */ (bad), NOW), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
});

describe("dbUndoChanges (the client)", () => {
  it("their own rows, any grant state; a put-back time only on rows that had landed; a second call changes nothing", async () => {
    db.grants[0].revoked_at = NOW - DAY; // sharing stopped: undo still works
    db.changes = [row(`${S1}.0`, { outcome: "applied", applied_at: AT }), row(`${S1}.1`), row(`${S2}.0`, { client_account_id: B })];
    const back = "2026-10-05T11:00:00.000Z";
    expect(await dbUndoChanges(A, S1, back, NOW)).toEqual([`${S1}.0`, `${S1}.1`]);
    expect(calls[0]).toEqual({ q: flat(SQL.undo), v: [NOW, back, S1, S1, A] });
    expect(db.changes.map((c) => [c.undone_at, c.undone_by, c.reverted_at])).toEqual([
      [NOW, "client", back], [NOW, "client", null], [null, null, null],
    ]);
    expect(await dbUndoChanges(A, S1, null, NOW + 1)).toEqual([]);
    expect(await dbUndoChanges(A, S2, null, NOW)).toEqual([]);
    expect(db.changes[0].undone_at).toBe(NOW);
  });

  it("a malformed id or put-back time throws", async () => {
    await expect(dbUndoChanges(A, "x".repeat(65), null, NOW)).rejects.toThrow();
    await expect(dbUndoChanges(A, S1, "2026-10-05", NOW)).rejects.toThrow();
    await expect(dbUndoChanges(A, S1, "2026-10-05T11:00:00Z", NOW)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("acks and reverts (the client's device)", () => {
  it("cleanAcks: outcomes from the one list, device instants only, at most 64 each, first per id", () => {
    expect(cleanAcks(undefined, undefined)).toEqual({ acks: [], reverts: [], delivered: [] });
    expect(cleanAcks([{ id: "a.0", outcome: "applied", at: AT }, { id: "a.0", outcome: "limits", at: AT }], [{ id: "a.1", at: AT }]))
      .toEqual({ acks: [{ id: "a.0", outcome: "applied", at: AT }], reverts: [{ id: "a.1", at: AT }], delivered: [] });
    for (const o of change.OUTCOMES) expect(cleanAcks([{ id: "a.0", outcome: o, at: AT }], [])).not.toBeNull();
    for (const bad of [
      [[{ id: "a.0", outcome: "done", at: AT }], []], [[{ id: "a.0", outcome: "applied", at: "yesterday" }], []],
      [[{ id: "a.0", outcome: "applied", at: "2026-02-30T10:00:00.000Z" }], []], [[], [{ id: "", at: AT }]],
      [{ id: "a.0" }, []], [Array.from({ length: 65 }, (_, i) => ({ id: `a.${i}`, outcome: "applied", at: AT })), []],
    ]) expect(cleanAcks(...bad)).toBeNull();
    expect(isIsoInstant(new Date(NOW).toISOString())).toBe(true);
  });

  it("the first report stands; applied_at only for applied; their own rows only", async () => {
    db.changes = [row(`${S1}.0`), row(`${S1}.1`), row(`${S2}.0`, { client_account_id: B })];
    const acks = [{ id: `${S1}.0`, outcome: "applied", at: AT }, { id: `${S1}.1`, outcome: "superseded", at: AT }, { id: `${S2}.0`, outcome: "applied", at: AT }];
    expect(await dbAckChanges(A, { acks })).toEqual({ acked: [`${S1}.0`, `${S1}.1`], reverted: [], delivered: [], undelivered: [] });
    expect(calls[0]).toEqual({ q: flat(SQL.ack), v: [JSON.stringify(acks), A] });
    expect(await dbAckChanges(A, { acks: [{ id: `${S1}.0`, outcome: "limits", at: "2026-10-06T10:00:00.000Z" }] }))
      .toEqual({ acked: [], reverted: [], delivered: [], undelivered: [] });
    expect(db.changes.map((c) => [c.outcome, c.applied_at])).toEqual([["applied", AT], ["superseded", null], [null, null]]);
    expect(txs).toBe(0);
  });

  it("a put-back lands once, only on an undone row; with acks it is one transaction; nothing to report sends nothing", async () => {
    db.changes = [row(`${S1}.0`, { outcome: "applied", applied_at: AT, undone_at: NOW, undone_by: "client" }), row(`${S1}.1`, { outcome: "applied", applied_at: AT }), row(`${S2}.0`)];
    const r = await dbAckChanges(A, { acks: [{ id: `${S2}.0`, outcome: "deload", at: AT }], reverts: [{ id: `${S1}.0`, at: AT }, { id: `${S1}.1`, at: AT }] });
    expect(r).toEqual({ acked: [`${S2}.0`], reverted: [`${S1}.0`], delivered: [], undelivered: [] });
    expect(txs).toBe(1);
    expect(calls.map((c) => c.q)).toEqual([flat(SQL.ack), flat(SQL.revert)]);
    expect(db.changes.map((c) => c.reverted_at)).toEqual([AT, null, null]);
    expect((await dbAckChanges(A, { reverts: [{ id: `${S1}.0`, at: "2026-10-07T10:00:00.000Z" }] })).reverted).toEqual([]);
    calls.length = 0;
    expect(await dbAckChanges(A, {})).toEqual({ acked: [], reverted: [], delivered: [], undelivered: [] });
    expect(calls).toEqual([]);
    await expect(dbAckChanges(A, { acks: [{ id: "a.0", outcome: "landed", at: AT }] })).rejects.toThrow();
  });
});

describe("the changes switch (the client's grant)", () => {
  it("off: edits_off_at on their live grant, never earlier than edits_at", async () => {
    expect(await dbEditsOff(A, NOW)).toBe(true);
    expect(calls[0]).toEqual({ q: flat(SQL.editsOff), v: [NOW, A] });
    expect(db.grants[0].edits_off_at).toBe(NOW);
    db.grants[0].edits_at = NOW + 5;
    db.grants[0].edits_off_at = null;
    await dbEditsOff(A, NOW);
    expect(db.grants[0].edits_off_at).toBe(NOW + 5);
    db.grants[0].edits_at = null;
    expect(await dbEditsOff(A, NOW)).toBe(false);
    expect(await dbEditsOff(B, NOW)).toBe(false);
  });

  it("on: only while off and on the current consent; already on, an older consent and no grant say so", async () => {
    expect(await dbEditsOn(A, "v1", NOW)).toBe("already");
    expect(calls.map((c) => c.q)).toEqual([flat(SQL.editsOn), flat(SQL.editsState)]);
    expect(calls[0].v).toEqual([NOW, A, "v1"]);
    expect(db.grants[0].edits_at).toBe(GRANT.edits_at); // unchanged: turning on again must not cancel waiting changes
    await dbEditsOff(A, NOW);
    expect(await dbEditsOn(A, "v2", NOW + 1)).toBe("fresh");
    expect(await dbEditsOn(A, "v1", NOW)).toBe("on");
    expect(db.grants[0].edits_at).toBe(NOW + 1); // after the off, even at the same instant
    expect(await dbEditsOn(B, "v1", NOW)).toBe("none");
  });
});

describe("the grant's changes switch, as the trainer routes read it", () => {
  it("editsLive: set, and not turned off since", () => {
    const { editsLive } = trainerStore;
    expect(editsLive(null, null)).toBe(false);
    expect(editsLive(5, null)).toBe(true);
    expect(editsLive("5", "4")).toBe(true);
    expect(editsLive(5, 5)).toBe(false);
    expect(editsLive(5, 6)).toBe(false);
  });

  it("dbTrainerGrants carries edits and editsAt; the live predicate is unchanged", async () => {
    const [g] = await trainerStore.dbTrainerGrants(T, "hwg_1");
    expect(g).toEqual({ ref: "hwg_1", profile: "sk-a", scope: "trainer:read", since: GRANT.created_at, lastLooked: null,
      name: "Abe", edits: true, editsAt: GRANT.edits_at, consentVersion: "v1" });
    db.grants[0].edits_off_at = NOW;
    expect((await trainerStore.dbTrainerGrants(T, "hwg_1"))[0]).toMatchObject({ edits: false, editsAt: GRANT.edits_at });
    db.grants[0].edits_at = null;
    expect((await trainerStore.dbTrainerGrants(T, "hwg_1"))[0]).toMatchObject({ edits: false, editsAt: null });
  });
});

describe("dbOpenChangesFor (delivery to the client's app)", () => {
  it("delivers open rows on a live grant with changes on, oldest first, in the sync payload's shape, with the trainer's name", async () => {
    db.changes = [row(`${S2}.0`, { created_at: NOW - 1000 }), row(`${S1}.0`, { created_at: NOW - 2000, effective_from: "2026-10-12" })];
    const rows = await dbOpenChangesFor("sk-a");
    expect(calls[0]).toEqual({ q: flat(SQL.deliver), v: ["sk-a", 160] });
    expect(rows).toEqual([
      { id: `${S1}.0`, set: S1, kind: "weight", target: "Back Squat", from: "2026-10-12", before: 100, after: 105,
        basis: { anchorId: "r1", w: 100, r: 5 }, at: NOW - 2000, appliedAt: null, undone: false, by: "Tia", deliveredAt: null, editsLive: true },
      { id: `${S2}.0`, set: S2, kind: "weight", target: "Back Squat", from: null, before: 100, after: 105,
        basis: { anchorId: "r1", w: 100, r: 5 }, at: NOW - 1000, appliedAt: null, undone: false, by: "Tia", deliveredAt: null, editsLive: true },
    ]);
    expect(writes()).toEqual([]);
    // The row is exactly what the status and the device plan read.
    expect(change.changeStatus(rows[0], { meta: {}, history: [], todayIso: "2026-10-05", editsLive: true }).status).toBe("waiting");
  });

  it("a change not yet landed is never delivered once sharing stopped, changes went off, were turned on after it, or the trainer is no longer live", async () => {
    const cases = {
      stopped: () => { db.grants[0].revoked_at = NOW - 10; },
      off: () => { db.grants[0].edits_off_at = NOW - 10; },
      neverOn: () => { db.grants[0].edits_at = null; },
      reOn: () => { db.grants[0].edits_off_at = NOW - 3 * DAY; db.grants[0].edits_at = NOW - 2 * DAY + 1; },
      clientClosed: () => { db.accounts.get(A).deleted_at = "2026-10-01"; },
      passkeyGone: () => { db.credentials = []; },
      trainerClosed: () => { db.accounts.get(T).deleted_at = "2026-10-01"; },
      trainerOldTerms: () => { db.accounts.get(T).trainer_terms = { ...TERMS, version: "old" }; },
      notATrainer: () => { db.accounts.get(T).roles = ["lifter"]; },
      otherAuthor: () => { db.changes[0].author_account_id = N; },
    };
    for (const [name, arrange] of Object.entries(cases)) {
      db.grants = [{ ...GRANT }];
      db.accounts.get(A).deleted_at = null;
      db.accounts.set(T, { id: T, roles: ["lifter", "trainer"], plan: "free", trainer_terms: TERMS, deleted_at: null });
      db.credentials = [{ id: "cred-a", account_id: A, rp_id: "heatwayve.app" }];
      db.changes = [row(`${S1}.0`, { created_at: NOW - 2 * DAY })];
      expect(await dbOpenChangesFor("sk-a"), "control").toHaveLength(1);
      arrange();
      expect(await dbOpenChangesFor("sk-a"), name).toEqual([]);
    }
  });

  it("an undone change that landed is delivered to be put back in any grant state, once; never a week, a cleared, a proposed or an AI row", async () => {
    db.changes = [
      row(`${S1}.0`, { outcome: "applied", applied_at: AT, undone_at: NOW - 5, undone_by: "trainer" }),
      row(`${S1}.1`, { outcome: "applied", applied_at: AT, undone_at: NOW - 5, undone_by: "client", reverted_at: AT }),
      row(`${S1}.2`, { kind: "week", target: "week", outcome: "applied", applied_at: AT, undone_at: NOW - 5 }),
      row(`${S1}.3`, { outcome: "superseded", undone_at: NOW - 5 }),
      row(`${S2}.0`, { cleared_at: NOW }),
      row(`${S2}.1`, { status: "proposed" }),
      row(`${S2}.2`, { source: "ai" }),
    ];
    const rows = await dbOpenChangesFor("sk-a");
    expect(rows.map((r) => [r.id, r.undone, r.appliedAt])).toEqual([[`${S1}.0`, true, AT]]);
    db.grants[0].revoked_at = NOW - 10;
    expect((await dbOpenChangesFor("sk-a")).map((r) => r.id)).toEqual([`${S1}.0`]);
  });

  it("at most 160 a pull (a week's budget), oldest first; a change its grant can no longer deliver never takes a place", async () => {
    expect(DELIVER_MAX).toBe(change.SETS_PER_WEEK * change.MAX_OPS);
    expect(DELIVER_MAX).toBe(160);
    // 200 waiting on a share since stopped, older than everything live: never selected.
    db.grants.push({ ...GRANT, id: "hwg_0", revoked_at: NOW - 5 * DAY });
    const dead = Array.from({ length: 200 }, (_, i) => row(`hws_${"d".repeat(26)}.${i}`, { grant_id: "hwg_0", created_at: NOW - 10 * DAY + i }));
    const live = Array.from({ length: 170 }, (_, i) => row(`hws_${"l".repeat(26)}.${i}`, { created_at: NOW - 2 * DAY + i }));
    db.changes = [...dead, ...live];
    const rows = await dbOpenChangesFor("sk-a");
    expect(rows).toHaveLength(160);
    expect(rows.map((r) => r.id)).toEqual(live.slice(0, 160).map((r) => r.id));
    // Once those are reported, the rest come on the next pull.
    for (const c of db.changes.slice(200, 360)) c.outcome = "applied";
    expect((await dbOpenChangesFor("sk-a")).map((r) => r.id)).toEqual(live.slice(160).map((r) => r.id));
  });

  it("the trainer's name is their handle as it was when their profile closed, never a later holder's", async () => {
    db.changes = [row(`${S1}.0`, { outcome: "applied", applied_at: AT, undone_at: NOW - 5 })];
    db.handles = [
      { handle: "tia", display: "Tia", account_id: T, kind: "primary", released_at: NOW - 10 * DAY },
      { handle: "tia", display: "Tia", account_id: N, kind: "primary", released_at: null },
    ];
    expect((await dbOpenChangesFor("sk-a"))[0].by).toBe("Tia");
    db.handles = [];
    expect((await dbOpenChangesFor("sk-a"))[0].by).toBeNull();
  });
});

describe("the lists", () => {
  it("the trainer's open changes on a grant: not landed, not undone, sent since changes were last turned on; with the budget; never the basis", async () => {
    db.grants[0].edits_at = NOW - 3 * DAY;
    db.changes = [
      row(`${S1}.0`, { created_at: NOW - 4 * DAY }), // before changes were turned on again: will never land
      row(`${S1}.1`, { created_at: NOW - 2 * DAY }),
      row(`${S2}.0`, { created_at: NOW - DAY, outcome: "applied", applied_at: AT }),
      row(`${S2}.1`, { created_at: NOW - DAY, undone_at: NOW - 5 }),
    ];
    const r = await dbOpenChangesForGrant("hwg_1", T, NOW);
    expect(r).toEqual({ open: [expect.objectContaining({ id: `${S1}.1`, set: S1, before: 100, after: 105, basis: null, setSize: 2 })], used: 2,
      freeAt: NOW - 4 * DAY + WEEK, sessions: { used: 0, freeAt: null } });
    expect(calls.map((c) => [c.q, c.v])).toEqual([
      [flat(SQL.openGrant), ["hwg_1", T]], [flat(SQL.budget), ["hwg_1", NOW - WEEK]], [flat(SQL.sessionBudget), ["hwg_1", NOW - WEEK]],
    ]);
    expect(await dbOpenChangesForGrant("hwg_1", N, NOW)).toMatchObject({ open: [] });
  });

  it("the trainer's list: 24 weeks and anything still open, newest first, at most 100, each saying whether it can still land", async () => {
    db.changes = [
      row(`${setId("c")}.0`, { created_at: NOW - 200 * DAY }), // old but still open
      row(`${setId("d")}.0`, { created_at: NOW - 200 * DAY, outcome: "applied", applied_at: AT }), // old and landed: out
      ...Array.from({ length: 105 }, (_, i) => row(`${S1}.${String(i).padStart(3, "0")}`, { created_at: NOW - DAY + i })),
    ];
    const r = await dbChangesForTrainer("hwg_1", T, NOW);
    expect(calls[0]).toEqual({ q: flat(SQL.trainerList), v: ["hwg_1", T, NOW - 168 * DAY, 100] });
    expect(r.rows).toHaveLength(100);
    expect(r.rows[0].id).toBe(`${S1}.104`);
    expect(r.rows.every((x) => x.basis === null && x.editsLive === true)).toBe(true);
    db.changes = db.changes.slice(0, 2);
    expect((await dbChangesForTrainer("hwg_1", T, NOW)).rows.map((x) => [x.id, x.editsLive])).toEqual([[`${setId("c")}.0`, false]]);
  });

  it("the client's list: every trainer's changes, newest first, the trainer's name and the switch; nothing when there is no grant", async () => {
    db.changes = [
      row(`${S1}.0`, { created_at: NOW - 2 * DAY, outcome: "applied", applied_at: AT }),
      row(`${S2}.0`, { created_at: NOW - DAY }),
      row(`${setId("c")}.0`, { grant_id: "hwg_old", author_account_id: N, created_at: NOW - 40 * DAY, undone_at: NOW - 39 * DAY, undone_by: "trainer" }),
      row(`${setId("d")}.0`, { client_account_id: B }),
    ];
    const r = await dbChangesForClient(A, NOW);
    expect(calls.map((c) => [c.q, c.v])).toEqual([[flat(SQL.clientGrant), [A]], [flat(SQL.clientList), [A, NOW - 168 * DAY, 100]]]);
    expect(r.edits).toEqual({ on: true, since: GRANT.edits_at });
    expect(r.rows.map((x) => [x.id, x.by, x.editsLive])).toEqual([
      [`${S2}.0`, "Tia", true], [`${S1}.0`, "Tia", true], [`${setId("c")}.0`, "Nia", false],
    ]);
    expect(r.rows[1]).toMatchObject({ outcome: "applied", appliedAt: AT, basis: { anchorId: "r1", w: 100, r: 5 } });
    db.grants[0].edits_off_at = NOW;
    expect((await dbChangesForClient(A, NOW)).edits).toEqual({ on: false, since: null });
    expect((await dbChangesForClient(B, NOW)).edits).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("coached sessions", () => {
  const day = (n) => `2026-10-${String(n).padStart(2, "0")}`;
  const record = (date, letter = "A") => ({ id: `${date}T09:00:00.000Z`, date, session: `strength-${letter.toLowerCase()}`, scheduledLetter: letter });
  const sessionOp = (target = `${day(5)}:A`, extra = {}) => {
    const [date, letter] = target.split(":");
    return { kind: "session", target, before: null, after: { record: record(date, letter), drum: { "Back Squat": 100 } },
      basis: null, warnings: null, from: date, ...extra };
  };
  /** A stored session row, for state the test sets up directly. */
  const sessionRow = (id, target = `${day(5)}:A`, extra = {}) => {
    const [date, letter] = target.split(":");
    return row(id, { kind: "session", target, old_value: null, new_value: { record: record(date, letter), drum: {} }, basis: null,
      effective_from: date, ...extra });
  };
  const sid = (i) => `hws_${String.fromCharCode(99 + i).repeat(26)}`;

  it("a session goes in as one row behind the same lock, and is read back as the device and lists read it", async () => {
    const op = sessionOp();
    expect(await send(S1, [op])).toEqual({ inserted: [`${S1}.00`] });
    expect(calls.map((c) => c.q)).toEqual([flat(SQL.lock), flat(SQL.insert)]);
    expect(locks).toEqual([`tc:${A}:${T}`]);
    expect(txs).toBe(1);
    expect(db.changes[0]).toMatchObject({ kind: "session", target: `${day(5)}:A`, old_value: null, new_value: op.after, basis: null,
      warnings: null, effective_from: day(5), delivered_at: null });
    expect(change.rowFromDb(db.changes[0])).toMatchObject({ kind: "session", deliveredAt: null, from: day(5) });
  });

  it("sessions have their own count, 7 in 7 days between this client and trainer; plan sets neither spend it nor are spent by it", async () => {
    // A full week of plan sets: a session still goes in.
    for (let i = 0; i < 10; i++) db.changes.push(row(`${sid(i)}.00`, { created_at: NOW - 5 * DAY + i }));
    expect(await send(S1)).toMatchObject({ full: true, used: 10 });
    expect(await send(S1, [sessionOp(`${day(5)}:A`)])).toEqual({ inserted: [`${S1}.00`] });
    // Six more sessions (withdrawn ones count, as plan sets do), on a share since stopped too: the eighth is refused.
    db.grants.push({ ...GRANT, id: "hwg_0", revoked_at: NOW - 3 * DAY });
    for (let i = 0; i < 6; i++) {
      db.changes.push(sessionRow(`${sid(10 + i)}.00`, `${day(6 + i)}:B`, { grant_id: i < 3 ? "hwg_0" : "hwg_1",
        created_at: NOW - 6 * DAY + i, undone_at: i === 0 ? NOW - DAY : null, undone_by: i === 0 ? "trainer" : null }));
    }
    db.changes.push(sessionRow(`${setId("y")}.00`, `${day(20)}:C`, { created_at: NOW - WEEK })); // exactly 7 days old: out
    expect(await send(S2, [sessionOp(`${day(12)}:C`)])).toEqual({ full: true, used: 7, freeAt: NOW - 6 * DAY + WEEK });
    expect(db.changes.filter((c) => c.set_id === S2)).toEqual([]);
    // The lists carry both counts, apart.
    expect(await dbOpenChangesForGrant("hwg_1", T, NOW)).toMatchObject({ used: 10, sessions: { used: 7, freeAt: NOW - 6 * DAY + WEEK } });
    // Two days on, one plan set has left the window: a plan set goes in, and only the plan count moves.
    expect(await send(S2, [weightOp()], NOW + 2 * DAY)).toEqual({ inserted: [`${S2}.00`] });
    expect(await dbChangesForTrainer("hwg_1", T, NOW + 2 * DAY)).toMatchObject({ used: 10, sessions: { used: 1, freeAt: NOW + WEEK } });
  });

  it("one standing session per client, day and letter: waiting, kept or auto-kept refuse a second; withdrawn, discarded, superseded and limits do not", async () => {
    const T5 = `${day(5)}:A`;
    for (const [extra, blocks] of [
      [{}, true], [{ delivered_at: AT }, true], [{ outcome: "kept", applied_at: AT }, true], [{ outcome: "auto_kept", applied_at: AT }, true],
      [{ undone_at: NOW - 5, undone_by: "trainer" }, false], [{ outcome: "discarded" }, false], [{ outcome: "superseded" }, false],
      [{ outcome: "limits" }, false],
    ]) {
      db.changes = [sessionRow(`${S1}.00`, T5, { created_at: NOW - DAY, ...extra })];
      const res = await send(S2, [sessionOp(T5)]);
      expect(res, JSON.stringify(extra)).toEqual(blocks ? { alreadySent: true, used: 1, freeAt: NOW - DAY + WEEK } : { inserted: [`${S2}.00`] });
    }
    // Another letter, or another day, goes in.
    db.changes = [sessionRow(`${S1}.00`, T5)];
    expect(await send(S2, [sessionOp(`${day(5)}:B`)])).toEqual({ inserted: [`${S2}.00`] });
    expect(await send(setId("c"), [sessionOp(`${day(4)}:A`)])).toEqual({ inserted: [`${setId("c")}.00`] });
    // The guard is the client's, whoever sent the standing one.
    db.changes = [sessionRow(`${S1}.00`, T5, { grant_id: "hwg_n", author_account_id: N })];
    expect(await send(S2, [sessionOp(T5)])).toMatchObject({ alreadySent: true });
    const read = calls.filter((c) => c.q === flat(SQL.standing)).at(-1);
    expect(read.v).toEqual([A, T5]);
  });

  it("a session that never reached their device, on a grant since revoked, no longer holds its day and letter", async () => {
    const T5 = `${day(5)}:A`;
    // Sent on an earlier grant, which then ended; the client shared again (hwg_1).
    db.grants.push({ ...GRANT, id: "hwg_old", revoked_at: NOW - 2 * DAY });
    for (const [extra, blocks] of [
      [{}, false],
      // Once on their device it stands until they decide, whatever the grant (the card stays).
      [{ delivered_at: AT }, true],
      [{ delivered_at: AT, outcome: "kept", applied_at: AT }, true],
      // Kept without a delivery report still stands: it is in their training.
      [{ outcome: "kept", applied_at: AT }, true],
    ]) {
      db.changes = [sessionRow(`${S1}.00`, T5, { grant_id: "hwg_old", created_at: NOW - 3 * DAY, ...extra })];
      const res = await send(S2, [sessionOp(T5)]);
      expect(res, JSON.stringify(extra)).toEqual(blocks ? { alreadySent: true, used: 1, freeAt: NOW - 3 * DAY + WEEK } : { inserted: [`${S2}.00`] });
    }
    // On a live grant, one not yet delivered still holds it.
    db.changes = [sessionRow(`${S1}.00`, T5, { created_at: NOW - DAY })];
    expect(await send(S2, [sessionOp(T5)])).toMatchObject({ alreadySent: true });
  });

  it("two sends at once for one client, day and letter: one row, the other reads as already sent", async () => {
    const T5 = `${day(5)}:A`;
    const [a, b] = await Promise.all([send(S1, [sessionOp(T5)]), send(S2, [sessionOp(T5)])]);
    expect([a, b]).toEqual([{ inserted: [`${S1}.00`] }, { alreadySent: true, used: 1, freeAt: NOW + WEEK }]);
    expect(db.changes.map((c) => c.target)).toEqual([T5]);
    expect(locks).toEqual([`tc:${A}:${T}`, `tc:${A}:${T}`]);
  });

  it("a resend of the same session is a replay; the same set id with another record is a mismatch", async () => {
    await send(S1, [sessionOp()]);
    expect(await send(S1, [sessionOp()], NOW + 1000)).toEqual({ replay: true });
    const other = sessionOp();
    other.after = { ...other.after, drum: { "Back Squat": 102.5 } };
    expect(await send(S1, [other], NOW + 1000)).toEqual({ mismatch: true });
    expect(db.changes).toHaveLength(1);
  });

  it("a malformed session set throws before any SQL", async () => {
    const big = sessionOp();
    big.after = { record: { ...big.after.record, pad: "x".repeat(change.RECORD_MAX_BYTES) }, drum: {} };
    const bad = [
      [sessionOp(), weightOp()], [sessionOp(), sessionOp(`${day(5)}:B`)], [weightOp(), sessionOp()],
      [sessionOp("2026-10-05:D")], [sessionOp("2026-10-05")], [sessionOp(`${day(5)}:A`, { from: day(4) })], [sessionOp(`${day(5)}:A`, { from: null })],
      [sessionOp(`${day(5)}:A`, { before: 1 })], [sessionOp(`${day(5)}:A`, { basis: {} })], [sessionOp(`${day(5)}:A`, { warnings: ["x"] })],
      [sessionOp(`${day(5)}:A`, { after: null })], [sessionOp(`${day(5)}:A`, { after: "record" })], [big],
    ];
    for (const ops of bad) await expect(send(S1, ops), JSON.stringify(ops).slice(0, 120)).rejects.toThrow();
    expect(calls).toEqual([]);
    // Exactly at the bound goes in.
    const at = sessionOp();
    const room = change.RECORD_MAX_BYTES - new TextEncoder().encode(JSON.stringify({ ...at.after, record: { ...at.after.record, pad: "" } })).length;
    at.after = { ...at.after, record: { ...at.after.record, pad: "x".repeat(room) } };
    expect(new TextEncoder().encode(JSON.stringify(at.after)).length).toBe(change.RECORD_MAX_BYTES);
    expect(await send(S1, [at])).toEqual({ inserted: [`${S1}.00`] });
  });

  it("the trainer withdraws a session only before it reaches their device", async () => {
    db.changes = [sessionRow(`${S1}.00`), sessionRow(`${S2}.00`, `${day(5)}:B`, { delivered_at: AT })];
    expect(await dbWithdrawChanges("hwg_1", T, S2, [], NOW)).toEqual([]);
    expect(await dbWithdrawChanges("hwg_1", T, `${S2}.00`, [`${S2}.00`], NOW)).toEqual([]);
    expect(db.changes[1].undone_at).toBeNull();
    expect(await dbWithdrawChanges("hwg_1", T, S1, [], NOW)).toEqual([`${S1}.00`]);
    expect(db.changes[0]).toMatchObject({ undone_at: NOW, undone_by: "trainer" });
  });

  it("the client's undo never touches a session, kept or not", async () => {
    db.changes = [sessionRow(`${S1}.00`, `${day(5)}:A`, { outcome: "kept", applied_at: AT, delivered_at: AT }), sessionRow(`${S1}.01`, `${day(5)}:B`)];
    expect(await dbUndoChanges(A, S1, AT, NOW)).toEqual([]);
    expect(await dbUndoChanges(A, `${S1}.00`, AT, NOW)).toEqual([]);
    expect(db.changes.map((c) => [c.undone_at, c.reverted_at])).toEqual([[null, null], [null, null]]);
  });

  it("cleanAcks: the session outcomes ride the acks; delivered is its own list of device instants, at most 64, first per id", () => {
    for (const o of ["kept", "auto_kept", "discarded", "superseded", "limits"]) {
      expect(cleanAcks([{ id: "a.0", outcome: o, at: AT }], [])?.acks, o).toEqual([{ id: "a.0", outcome: o, at: AT }]);
    }
    expect(cleanAcks([], [], [{ id: "a.0", at: AT }, { id: "a.0", at: "2026-10-06T10:00:00.000Z" }]))
      .toEqual({ acks: [], reverts: [], delivered: [{ id: "a.0", at: AT }] });
    for (const d of [{ id: "a.0" }, [{ id: "a.0", at: "2026-10-05T10:00:00Z" }], [{ id: "", at: AT }], [null],
      Array.from({ length: 65 }, (_, i) => ({ id: `a.${i}`, at: AT }))]) {
      expect(cleanAcks([], [], d), JSON.stringify(d).slice(0, 80)).toBeNull();
    }
  });

  it("delivered: once, on their own session rows not withdrawn; the first report stands, held between the send and the server's now", async () => {
    const sent = Date.parse("2026-10-05T08:00:00.000Z");
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    db.changes = [
      sessionRow(`${S1}.00`, `${day(5)}:A`, { created_at: sent }),
      sessionRow(`${S1}.01`, `${day(5)}:B`, { created_at: sent }),
      sessionRow(`${S1}.02`, `${day(5)}:C`, { created_at: sent }),
      row(`${S2}.00`), // a plan change: never marked
      sessionRow(`${setId("c")}.00`, `${day(4)}:A`, { client_account_id: B }), // not theirs
      sessionRow(`${setId("d")}.00`, `${day(4)}:B`, { undone_at: NOW - 5, undone_by: "trainer" }), // withdrawn
    ];
    const delivered = [
      { id: `${S1}.00`, at: "2026-10-05T10:00:00.000Z" }, // in range: as reported
      { id: `${S1}.01`, at: "2026-10-05T07:00:00.000Z" }, // a clock behind: the send
      { id: `${S1}.02`, at: "2026-10-05T19:00:00.000Z" }, // a clock ahead: the server's now
      { id: `${S2}.00`, at: AT }, { id: `${setId("c")}.00`, at: AT }, { id: `${setId("d")}.00`, at: AT },
    ];
    expect(await dbAckChanges(A, { delivered }, now)).toEqual({ acked: [], reverted: [], delivered: [`${S1}.00`, `${S1}.01`, `${S1}.02`], undelivered: [] });
    expect(calls[0]).toEqual({ q: flat(SQL.delivered), v: [new Date(now).toISOString(), JSON.stringify(delivered), A] });
    expect(txs).toBe(0);
    expect(db.changes.map((c) => c.delivered_at)).toEqual([
      "2026-10-05T10:00:00.000Z", "2026-10-05T08:00:00.000Z", "2026-10-05T12:00:00.000Z", null, null, null,
    ]);
    // A second report, from another device, changes nothing.
    expect((await dbAckChanges(A, { delivered: [{ id: `${S1}.00`, at: "2026-10-05T09:00:00.000Z" }] }, now)).delivered).toEqual([]);
    expect(db.changes[0].delivered_at).toBe("2026-10-05T10:00:00.000Z");
    await expect(dbAckChanges(A, { delivered: [{ id: `${S1}.00`, at: "soon" }] }, now)).rejects.toThrow();
  });

  it("auto_kept lands only on a row marked delivered (this report's mark counts); kept and auto_kept set applied_at, discarded does not", async () => {
    db.changes = [
      sessionRow(`${S1}.00`, `${day(5)}:A`), // never marked
      sessionRow(`${S1}.01`, `${day(5)}:B`), // marked in this report
      sessionRow(`${S1}.02`, `${day(5)}:C`, { delivered_at: AT }),
      sessionRow(`${S2}.00`, `${day(4)}:A`, { delivered_at: AT }),
      sessionRow(`${S2}.01`, `${day(4)}:B`, { delivered_at: AT, outcome: "discarded" }), // decided: the first report stands
    ];
    const at = "2026-10-05T15:00:00.000Z";
    const acks = [
      { id: `${S1}.00`, outcome: "auto_kept", at }, { id: `${S1}.01`, outcome: "auto_kept", at },
      { id: `${S1}.02`, outcome: "kept", at }, { id: `${S2}.00`, outcome: "discarded", at }, { id: `${S2}.01`, outcome: "auto_kept", at },
    ];
    const delivered = [{ id: `${S1}.01`, at: "2026-10-05T10:00:00.000Z" }];
    const r = await dbAckChanges(A, { acks, delivered }, NOW);
    expect(r).toEqual({ acked: [`${S1}.01`, `${S1}.02`, `${S2}.00`], reverted: [], delivered: [`${S1}.01`], undelivered: [`${S1}.00`] });
    // One transaction: the mark first, then the outcomes, then the read of what was refused.
    expect(txs).toBe(1);
    expect(calls.map((c) => c.q)).toEqual([flat(SQL.delivered), flat(SQL.ack), flat(SQL.undelivered)]);
    expect(calls[2].v).toEqual([JSON.stringify([`${S1}.00`, `${S1}.01`, `${S2}.01`]), A]);
    expect(db.changes.map((c) => [c.outcome, c.applied_at])).toEqual([
      [null, null], ["auto_kept", at], ["kept", at], ["discarded", null], ["discarded", null],
    ]);
  });

  it("delivery: a session on their device stays until they decide, even after sharing stops (no auto-keep then); never before it arrived, never once decided or withdrawn", async () => {
    db.changes = [
      sessionRow(`${S1}.00`, `${day(5)}:A`, { created_at: NOW - 3000, delivered_at: AT }),
      sessionRow(`${S1}.01`, `${day(5)}:B`, { created_at: NOW - 2000 }),
      sessionRow(`${S1}.02`, `${day(5)}:C`, { created_at: NOW - 1000, delivered_at: AT, outcome: "kept", applied_at: AT }),
      sessionRow(`${S2}.00`, `${day(4)}:A`, { created_at: NOW - 900, undone_at: NOW - 5, undone_by: "trainer" }),
    ];
    const live = await dbOpenChangesFor("sk-a");
    expect(live.map((r) => [r.id, r.deliveredAt, r.editsLive])).toEqual([[`${S1}.00`, AT, true], [`${S1}.01`, null, true]]);
    expect(live[0]).toMatchObject({ kind: "session", target: `${day(5)}:A`, from: day(5), before: null, undone: false, by: "Tia",
      after: { record: record(day(5), "A"), drum: {} } });
    // Who ran it, for loggedBy at Keep: on session rows only.
    expect(live.map((r) => r.authorId)).toEqual([T, T]);
    expect(change.sessionStatus(live[0], { editsLive: live[0].editsLive })).toMatchObject({ status: "seen", keepsAt: Date.parse(AT) + change.AUTO_KEEP_MS });
    for (const stop of [() => { db.grants[0].revoked_at = NOW - 10; }, () => { db.grants[0].edits_off_at = NOW - 10; },
      () => { db.accounts.get(T).trainer_terms = { ...TERMS, version: "old" }; }]) {
      db.grants = [{ ...GRANT }];
      db.accounts.get(T).trainer_terms = TERMS;
      stop();
      const after = await dbOpenChangesFor("sk-a");
      expect(after.map((r) => [r.id, r.deliveredAt, r.editsLive])).toEqual([[`${S1}.00`, AT, false]]);
      expect(change.sessionStatus(after[0], { editsLive: after[0].editsLive })).toMatchObject({ status: "seen", reason: "stopped", keepsAt: null });
    }
    // A wiped profile's rows are never served.
    db.changes[0].cleared_at = NOW;
    expect(await dbOpenChangesFor("sk-a")).toEqual([]);
  });

  it("the lists carry deliveredAt for the session statuses", async () => {
    db.changes = [sessionRow(`${S1}.00`, `${day(5)}:A`, { delivered_at: AT })];
    const t = await dbChangesForTrainer("hwg_1", T, NOW);
    expect(t.rows[0]).toMatchObject({ kind: "session", deliveredAt: AT, editsLive: true });
    expect(change.changeStatus(t.rows[0], { editsLive: true })).toMatchObject({ status: "seen" });
    const c = await dbChangesForClient(A, NOW);
    expect(c.rows[0]).toMatchObject({ deliveredAt: AT, by: "Tia" });
    const o = await dbOpenChangesForGrant("hwg_1", T, NOW);
    expect(o.open[0]).toMatchObject({ deliveredAt: AT, setSize: 1 });
    expect(writes()).toEqual([]);
  });

  it("the trainer's grant carries the share consent the client approved", async () => {
    expect((await trainerStore.dbTrainerGrants(T, "hwg_1"))[0].consentVersion).toBe("v1");
    db.grants[0].consent_version = null;
    expect((await trainerStore.dbTrainerGrants(T, "hwg_1"))[0].consentVersion).toBeNull();
  });
});

describe("source", () => {
  const src = readFileSync(resolve(__dirname, "../lib/trainer-changes-store.js"), "utf8");

  it("writes only the named statements and never deletes", () => {
    expect([...src.matchAll(/q`\s*(INSERT INTO \w+|UPDATE \w+|DELETE\b)/g)].map((m) => m[1])).toEqual([
      "INSERT INTO trainer_changes", "UPDATE trainer_changes", "UPDATE trainer_changes", "UPDATE trainer_changes",
      "UPDATE trainer_changes", "UPDATE trainer_changes", "UPDATE oauth_grants", "UPDATE oauth_grants",
    ]);
    expect(src).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bdel\(|removeItem/);
  });

  it("the header names every exported write, the lock, the delivery bound and the withdraw predicate", () => {
    const header = src.slice(0, src.indexOf("// ───", src.indexOf("Writes here")));
    for (const fn of ["dbInsertChangeSet", "dbWithdrawChanges", "dbUndoChanges", "dbAckChanges", "dbEditsOff", "dbEditsOn"]) {
      expect(header, fn).toContain(`· ${fn}:`);
    }
    for (const fn of ["dbOpenChangesFor", "dbOpenChangesForGrant", "dbChangesForTrainer", "dbChangesForClient"]) expect(header).toContain(fn);
    const h = flat(header.replace(/\/\/ ?/g, " "));
    for (const s of ["pg_advisory_xact_lock on 'tc:<client>:<trainer>'", "across every grant between them", "DELIVER_MAX, 160",
      "(outcome IS NULL)", "(outcome 'applied')", "still in force", "set.00 to set.15",
      "fewer than 7 in 7 days", "no standing session for that day and letter", "never a session once it has reached their device",
      "Never a session: keeping one is final", "UPDATE delivered_at", "auto_kept only on a row marked delivered",
      "stays until they decide, even after sharing stops"]) expect(h, s).toContain(s);
  });

  it("the budget count and the INSERT are one transaction, the lock first, keyed by client and trainer", () => {
    const fn = src.slice(src.indexOf("export async function dbInsertChangeSet"), src.indexOf("export async function dbWithdrawChanges"));
    const tx = fn.slice(fn.indexOf("await q.transaction(["));
    expect(tx.indexOf("pg_advisory_xact_lock(hashtext('tc:' || ${clientId}::text || ':' || ${authorId}::text))")).toBeGreaterThan(0);
    expect(tx.indexOf("pg_advisory_xact_lock")).toBeLessThan(tx.indexOf("INSERT INTO trainer_changes"));
    expect(fn.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it("the session guard is one predicate: the INSERT's and the read that names a refusal", () => {
    const fn = flat(src.slice(src.indexOf("export async function dbInsertChangeSet"), src.indexOf("export async function dbWithdrawChanges")));
    const END = "dg.revoked_at IS NOT NULL)";
    const guard = (from) => from.slice(from.indexOf("SELECT 1 FROM trainer_changes d"), from.indexOf(END, from.indexOf("SELECT 1 FROM trainer_changes d")) + END.length);
    const ins = fn.slice(fn.indexOf("INSERT INTO"));
    const read = fn.slice(fn.indexOf("AS standing") - 400);
    expect(guard(ins).replace("o.op->>'target'", "T")).toBe(guard(read).replace("${rows[0].target}::text", "T"));
    expect(guard(ins)).toContain("d.client_account_id = ${clientId}::text AND d.kind = 'session'");
  });

  it("the kinds, outcomes, set id format and limits are lib/trainer-change.js's, not copies", () => {
    expect(flat(src)).toContain('import { KINDS, OUTCOMES, SET_ID_RE, MAX_OPS, SETS_PER_WEEK, SESSION_KIND, SESSIONS_PER_WEEK, RECORD_MAX_BYTES, rowFromDb, } from "./trainer-change.js";');
    expect(src).not.toMatch(/"superseded"|"already_there"|hws_\[|=\s*16\b|=\s*10\b/);
  });

  it("the delivery and client-list liveness are one predicate, and it is dbClientShare's join plus the changes switch", () => {
    const fns = ["dbOpenChangesFor", "dbChangesForClient"].map((n) => src.slice(src.indexOf(`export async function ${n}`)));
    const live = (f) => flat(f.slice(f.indexOf("COALESCE(g.revoked_at"), f.indexOf("AS grant_live")));
    expect(live(fns[0])).toBe(live(fns[1]));
    const share = readFileSync(resolve(__dirname, "../lib/trainer-store.js"), "utf8");
    expect(flat(share)).toContain("WHERE a.id = g.account_id AND a.deleted_at IS NULL AND c.id = g.credential_id AND c.rp_id = 'heatwayve.app'");
    expect(live(fns[0])).toContain("WHERE a.id = g.account_id AND a.deleted_at IS NULL AND k.id = g.credential_id AND k.rp_id = 'heatwayve.app'");
    expect(live(fns[0])).toContain("g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at) AND c.created_at > g.edits_at");
  });
});
