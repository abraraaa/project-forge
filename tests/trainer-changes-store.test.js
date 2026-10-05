// The trainer changes store (lib/trainer-changes-store.js). The Neon driver is
// faked with small in-memory tables that answer only the pinned statements, so
// every function runs for real and any drift in its SQL fails here. The only
// writes: the change-set INSERT (behind its advisory lock, in one transaction),
// four UPDATEs of trainer_changes (withdraw, undo, acks, reverts) and two of
// oauth_grants (the changes switch). No DELETE.
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
    + " AND (SELECT count(DISTINCT b.set_id) FROM trainer_changes b"
    + " WHERE b.grant_id IN (SELECT g.id FROM oauth_grants g WHERE g.account_id = ?::text AND g.trainer_account_id = ?::text)"
    + " AND b.source = 'trainer' AND b.created_at > ?::bigint) < ?::int"
    + " ON CONFLICT (id) DO NOTHING RETURNING id",
  seen: "SELECT EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ? AND grant_id = ? AND author_account_id = ?) AS mine,"
    + " EXISTS (SELECT 1 FROM trainer_changes WHERE set_id = ?) AS taken,"
    + " EXISTS (SELECT 1 FROM oauth_grants WHERE id = ? AND account_id = ? AND trainer_account_id = ?) AS fits,"
    + " (SELECT count(*) FROM trainer_changes WHERE set_id = ?) = jsonb_array_length(?::jsonb)"
    + " AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS o(op, i)"
    + " WHERE NOT EXISTS (SELECT 1 FROM trainer_changes t WHERE t.id = ?::text || '.' || lpad((o.i - 1)::text, 2, '0')"
    + " AND t.kind = o.op->>'kind' AND t.target = o.op->>'target'"
    + " AND t.new_value IS NOT DISTINCT FROM NULLIF(o.op->'after', 'null'::jsonb)"
    + " AND t.effective_from IS NOT DISTINCT FROM o.op->>'from')) AS same",
  budget: "SELECT count(DISTINCT set_id)::int AS used, min(created_at) AS oldest FROM trainer_changes"
    + " WHERE grant_id IN (SELECT g.id FROM oauth_grants g JOIN oauth_grants r"
    + " ON r.account_id = g.account_id AND r.trainer_account_id = g.trainer_account_id WHERE r.id = ?)"
    + " AND source = 'trainer' AND created_at > ?::bigint",
  withdraw: "UPDATE trainer_changes SET undone_at = ?, undone_by = 'trainer'"
    + " WHERE (id = ? OR set_id = ?) AND grant_id = ? AND author_account_id = ? AND undone_at IS NULL"
    + " AND (outcome IS NULL"
    + " OR (outcome = 'applied' AND kind <> 'week' AND id IN (SELECT jsonb_array_elements_text(?::jsonb)))) RETURNING id",
  undo: "UPDATE trainer_changes SET undone_at = ?, undone_by = 'client',"
    + " reverted_at = CASE WHEN outcome = 'applied' THEN COALESCE(reverted_at, ?::text) ELSE reverted_at END"
    + " WHERE (id = ? OR set_id = ?) AND client_account_id = ? AND undone_at IS NULL RETURNING id",
  ack: "UPDATE trainer_changes t SET outcome = a.outcome, applied_at = CASE WHEN a.outcome = 'applied' THEN a.at ELSE NULL END"
    + " FROM (SELECT e->>'id' AS id, e->>'outcome' AS outcome, e->>'at' AS at FROM jsonb_array_elements(?::jsonb) AS e) a"
    + " WHERE t.id = a.id AND t.client_account_id = ? AND t.outcome IS NULL RETURNING t.id",
  revert: "UPDATE trainer_changes t SET reverted_at = r.at"
    + " FROM (SELECT e->>'id' AS id, e->>'at' AS at FROM jsonb_array_elements(?::jsonb) AS e) r"
    + " WHERE t.id = r.id AND t.client_account_id = ? AND t.undone_at IS NOT NULL AND t.reverted_at IS NULL RETURNING t.id",
  editsOff: "UPDATE oauth_grants SET edits_off_at = GREATEST(?::bigint, edits_at)"
    + " WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL AND edits_at IS NOT NULL RETURNING id",
  editsOn: "UPDATE oauth_grants SET edits_at = GREATEST(?::bigint, COALESCE(edits_off_at, 0) + 1)"
    + " WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL AND consent_version = ?"
    + " AND NOT (edits_at IS NOT NULL AND (edits_off_at IS NULL OR edits_off_at < edits_at)) RETURNING id",
  editsState: "SELECT consent_version, edits_at, edits_off_at FROM oauth_grants WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL",
  deliver: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.basis,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, " + LIVE_JOIN
    + " WHERE c.profile = ? AND c.source = 'trainer' AND c.status = 'sent' AND c.cleared_at IS NULL"
    + " AND ((c.outcome IS NULL AND c.undone_at IS NULL AND g.revoked_at IS NULL AND g.trainer_account_id = c.author_account_id"
    + " AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at) AND c.created_at > g.edits_at)"
    + " OR (c.undone_at IS NOT NULL AND c.outcome = 'applied' AND c.reverted_at IS NULL AND c.kind <> 'week'))"
    + " ORDER BY c.created_at, c.id LIMIT ?",
  openGrant: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at,"
    + " (SELECT count(*) FROM trainer_changes s WHERE s.set_id = c.set_id)::int AS set_size"
    + " FROM trainer_changes c JOIN oauth_grants g ON g.id = c.grant_id"
    + " WHERE c.grant_id = ? AND c.author_account_id = ? AND c.source = 'trainer' AND c.status = 'sent'"
    + " AND c.outcome IS NULL AND c.undone_at IS NULL AND c.created_at > COALESCE(g.edits_at, 0) ORDER BY c.created_at, c.id",
  trainerList: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at,"
    + " COALESCE(g.revoked_at IS NULL AND g.edits_at IS NOT NULL AND (g.edits_off_at IS NULL OR g.edits_off_at < g.edits_at)"
    + " AND c.created_at > g.edits_at, false) AS edits_live"
    + " FROM trainer_changes c LEFT JOIN oauth_grants g ON g.id = c.grant_id"
    + " WHERE c.grant_id = ? AND c.author_account_id = ? AND c.source = 'trainer' AND c.status = 'sent'"
    + " AND (c.created_at > ?::bigint OR (c.outcome IS NULL AND c.undone_at IS NULL)) ORDER BY c.created_at DESC, c.id LIMIT ?",
  trainerGrant: "SELECT g.id, g.profile, g.scope, g.created_at, g.last_used_at, g.edits_at, g.edits_off_at, h.handle, h.display"
    + " FROM oauth_grants g JOIN accounts a ON a.id = g.account_id AND a.deleted_at IS NULL"
    + " JOIN credentials c ON c.id = g.credential_id AND c.account_id = g.account_id AND c.rp_id = 'heatwayve.app'"
    + " LEFT JOIN handles h ON h.account_id = g.account_id AND h.kind = 'primary' AND h.released_at IS NULL"
    + " WHERE g.kind = 'trainer' AND g.trainer_account_id = ? AND g.revoked_at IS NULL AND g.id = ? ORDER BY g.created_at DESC",
  clientGrant: "SELECT edits_at, edits_off_at FROM oauth_grants WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL",
  clientList: "SELECT c.id, c.set_id, c.kind, c.target, c.effective_from, c.old_value, c.new_value, c.basis, c.warnings,"
    + " c.created_at, c.applied_at, c.outcome, c.undone_at, c.undone_by, c.reverted_at, " + LIVE_JOIN
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
const TAIL = ["created_at", "applied_at", "outcome", "undone_at", "undone_by", "reverted_at"];

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
/** The budget over every grant between one client and one trainer. */
const budgetOf = (client, trainer, since) => {
  const grants = new Set(db.grants.filter((g) => g.account_id === client && g.trainer_account_id === trainer).map((g) => g.id));
  const rows = db.changes.filter((c) => grants.has(c.grant_id) && c.source === "trainer" && c.created_at > since);
  return [{ used: new Set(rows.map((c) => c.set_id)).size, oldest: rows.length ? big(Math.min(...rows.map((c) => c.created_at))) : null }];
};
const budget = (grant, since) => {
  const r = db.grants.find((g) => g.id === grant);
  return r ? budgetOf(r.account_id, r.trainer_account_id, since) : [{ used: 0, oldest: null }];
};
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
  [flat(SQL.insert)]: ([id1, set, grant, profile, client, author, now, ops, set2, grant2, client2, author2, client3, author3, since, cap]) => {
    expect([id1, set2, grant2, client2, author2, client3, author3]).toEqual([set, set, grant, client, author, client, author]);
    if (db.changes.some((c) => c.set_id === set)) return [];
    if (!fits(grant, client, author)) return [];
    if (budgetOf(client, author, since)[0].used >= cap) return [];
    const made = [];
    JSON.parse(ops).forEach((op, i) => {
      const id = `${set}.${pad(i)}`;
      if (db.changes.some((c) => c.id === id)) return;
      db.changes.push({ id, set_id: set, grant_id: grant, profile, client_account_id: client, author_account_id: author,
        source: "trainer", status: "sent", kind: op.kind, target: op.target, old_value: blank(op.before), new_value: blank(op.after),
        basis: blank(op.basis), warnings: blank(op.warnings), effective_from: op.from ?? null, created_at: now,
        applied_at: null, outcome: null, undone_at: null, undone_by: null, reverted_at: null, cleared_at: null });
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
  [flat(SQL.budget)]: ([grant, since]) => budget(grant, since),
  [flat(SQL.withdraw)]: ([now, x, x2, ref, me, inForce]) => db.changes
    .filter((c) => (c.id === x || c.set_id === x2) && c.grant_id === ref && c.author_account_id === me && c.undone_at == null
      && (c.outcome == null || (c.outcome === "applied" && c.kind !== "week" && JSON.parse(inForce).includes(c.id))))
    .map((c) => { Object.assign(c, { undone_at: now, undone_by: "trainer" }); return { id: c.id }; }),
  [flat(SQL.undo)]: ([now, reverted, x, x2, me]) => db.changes
    .filter((c) => (c.id === x || c.set_id === x2) && c.client_account_id === me && c.undone_at == null)
    .map((c) => {
      Object.assign(c, { undone_at: now, undone_by: "client", reverted_at: c.outcome === "applied" ? c.reverted_at ?? reverted : c.reverted_at });
      return { id: c.id };
    }),
  [flat(SQL.ack)]: ([json, me]) => JSON.parse(json).flatMap((a) => {
    const c = db.changes.find((x) => x.id === a.id && x.client_account_id === me && x.outcome == null);
    if (!c) return [];
    Object.assign(c, { outcome: a.outcome, applied_at: a.outcome === "applied" ? a.at : null });
    return [{ id: c.id }];
  }),
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
        || (c.undone_at != null && c.outcome === "applied" && c.reverted_at == null && c.kind !== "week")))
    .sort(sortAsc).slice(0, limit)
    .map((c) => ({ ...out(c, [...CORE, "basis", "created_at", "applied_at", "outcome", "undone_at"]), ...liveJoin(c) })),
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
      edits_at: big(g.edits_at), edits_off_at: big(g.edits_off_at), handle: "abe", display: "Abe" })),
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
  reverted_at: null, cleared_at: null, ...extra,
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
    expect(calls[1].v).toEqual([S1, S1, "hwg_1", "sk-a", A, T, NOW, JSON.stringify(ops), S1, "hwg_1", A, T, A, T, NOW - WEEK, 10]);
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
    expect(cleanAcks(undefined, undefined)).toEqual({ acks: [], reverts: [] });
    expect(cleanAcks([{ id: "a.0", outcome: "applied", at: AT }, { id: "a.0", outcome: "limits", at: AT }], [{ id: "a.1", at: AT }]))
      .toEqual({ acks: [{ id: "a.0", outcome: "applied", at: AT }], reverts: [{ id: "a.1", at: AT }] });
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
    expect(await dbAckChanges(A, { acks })).toEqual({ acked: [`${S1}.0`, `${S1}.1`], reverted: [] });
    expect(calls[0]).toEqual({ q: flat(SQL.ack), v: [JSON.stringify(acks), A] });
    expect(await dbAckChanges(A, { acks: [{ id: `${S1}.0`, outcome: "limits", at: "2026-10-06T10:00:00.000Z" }] })).toEqual({ acked: [], reverted: [] });
    expect(db.changes.map((c) => [c.outcome, c.applied_at])).toEqual([["applied", AT], ["superseded", null], [null, null]]);
    expect(txs).toBe(0);
  });

  it("a put-back lands once, only on an undone row; with acks it is one transaction; nothing to report sends nothing", async () => {
    db.changes = [row(`${S1}.0`, { outcome: "applied", applied_at: AT, undone_at: NOW, undone_by: "client" }), row(`${S1}.1`, { outcome: "applied", applied_at: AT }), row(`${S2}.0`)];
    const r = await dbAckChanges(A, { acks: [{ id: `${S2}.0`, outcome: "deload", at: AT }], reverts: [{ id: `${S1}.0`, at: AT }, { id: `${S1}.1`, at: AT }] });
    expect(r).toEqual({ acked: [`${S2}.0`], reverted: [`${S1}.0`] });
    expect(txs).toBe(1);
    expect(calls.map((c) => c.q)).toEqual([flat(SQL.ack), flat(SQL.revert)]);
    expect(db.changes.map((c) => c.reverted_at)).toEqual([AT, null, null]);
    expect((await dbAckChanges(A, { reverts: [{ id: `${S1}.0`, at: "2026-10-07T10:00:00.000Z" }] })).reverted).toEqual([]);
    calls.length = 0;
    expect(await dbAckChanges(A, {})).toEqual({ acked: [], reverted: [] });
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
      name: "Abe", edits: true, editsAt: GRANT.edits_at });
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
        basis: { anchorId: "r1", w: 100, r: 5 }, at: NOW - 2000, appliedAt: null, undone: false, by: "Tia" },
      { id: `${S2}.0`, set: S2, kind: "weight", target: "Back Squat", from: null, before: 100, after: 105,
        basis: { anchorId: "r1", w: 100, r: 5 }, at: NOW - 1000, appliedAt: null, undone: false, by: "Tia" },
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
    expect(r).toEqual({ open: [expect.objectContaining({ id: `${S1}.1`, set: S1, before: 100, after: 105, basis: null, setSize: 2 })], used: 2, freeAt: NOW - 4 * DAY + WEEK });
    expect(calls.map((c) => [c.q, c.v])).toEqual([[flat(SQL.openGrant), ["hwg_1", T]], [flat(SQL.budget), ["hwg_1", NOW - WEEK]]]);
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

describe("source", () => {
  const src = readFileSync(resolve(__dirname, "../lib/trainer-changes-store.js"), "utf8");

  it("writes only the named statements and never deletes", () => {
    expect([...src.matchAll(/q`\s*(INSERT INTO \w+|UPDATE \w+|DELETE\b)/g)].map((m) => m[1])).toEqual([
      "INSERT INTO trainer_changes", "UPDATE trainer_changes", "UPDATE trainer_changes", "UPDATE trainer_changes",
      "UPDATE trainer_changes", "UPDATE oauth_grants", "UPDATE oauth_grants",
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
      "(outcome IS NULL)", "(outcome 'applied')", "still in force", "set.00 to set.15"]) expect(h, s).toContain(s);
  });

  it("the budget count and the INSERT are one transaction, the lock first, keyed by client and trainer", () => {
    const fn = src.slice(src.indexOf("export async function dbInsertChangeSet"), src.indexOf("export async function dbWithdrawChanges"));
    const tx = fn.slice(fn.indexOf("await q.transaction(["));
    expect(tx.indexOf("pg_advisory_xact_lock(hashtext('tc:' || ${clientId}::text || ':' || ${authorId}::text))")).toBeGreaterThan(0);
    expect(tx.indexOf("pg_advisory_xact_lock")).toBeLessThan(tx.indexOf("INSERT INTO trainer_changes"));
    expect(fn.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it("the kinds, outcomes, set id format and limits are lib/trainer-change.js's, not copies", () => {
    expect(src).toContain('import { KINDS, OUTCOMES, SET_ID_RE, MAX_OPS, SETS_PER_WEEK, rowFromDb } from "./trainer-change.js";');
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
