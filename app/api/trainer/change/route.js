import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { dbReadProfile } from "@/lib/db";
import { dbAccountByStorageKey } from "@/lib/identity-store";
import { dbTrainerGrants, dbLogFullLook } from "@/lib/trainer-store";
import { dbInsertChangeSet, dbWithdrawChanges, dbOpenChangesForGrant, dbChangesForTrainer, BUDGET_WINDOW_MS } from "@/lib/trainer-changes-store";
import { validateChangeSet, changeStatus, SETS_PER_WEEK } from "@/lib/trainer-change";
import { TYPE_LABEL } from "@/lib/sync-merge";
import { trainerToday, SELF_REF } from "@/lib/trainer-view";
import { trainerGate, faceIdFresh, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const LABEL = "trainer-change";
/** A change id or a set id to take back. */
const WITHDRAW_MAX = 64;

/** Carry the gate's daily slide, if any, on whatever the route answers. */
const slid = (gate, res) => (gate.refresh ? setTrainerCookie(res, gate.refresh) : res);
// One answer for revoked, closed, a dead passkey, another trainer's client, unknown and "me".
const notShared = () => json({ error: "Not shared with you now." }, 404);
const unavailable = (e) => noStore(serverError(e, { status: 503, label: LABEL }));
const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const stale = () => json({ stale: true, error: "They've trained or changed it since you looked. Refresh." }, 409);
// The set id was sent before with other changes: the pane mints a new id.
const mismatch = () => json({ error: "That didn't send. Try again.", code: "replay_mismatch" }, 409);

/** The leading whole number of a stored rep value: 8, "8", "8/leg" -> 8. */
const repCount = (v) => (typeof v === "number" ? v : typeof v === "string" && /^\d+/.test(v) ? parseInt(v, 10) : null);
/** A week day as stored: the label only when it is not the type's own. */
const weekDay = (d) => (d && typeof d === "object" ? `${d.type}|${d.label && d.label !== TYPE_LABEL[d.type] ? d.label : ""}` : "");

/**
 * Whether an op as the pane sends it is the change a stored row records:
 * same kind, target, value and start. Read without the client's data, so a
 * resend after they have trained still matches.
 * @param {any} op
 * @param {{ kind: string, target: string, after: any, from: string | null }} row
 */
function sameOp(op, row) {
  if (!op || typeof op !== "object" || op.kind !== row.kind || (op.from ?? null) !== (row.from ?? null)) return false;
  if (row.kind === "weight") return op.lift === row.target && op.kg === Number(row.after);
  if (row.kind === "reps") return op.lift === row.target && op.reps === repCount(row.after);
  if (row.kind === "mainLift") return op.canonical === row.target && op.choice === row.after;
  return Array.isArray(op.week) && Array.isArray(row.after) && op.week.length === row.after.length
    && op.week.every((d, i) => weekDay(d) === weekDay(row.after[i]));
}

/**
 * Log the look before anything of the client's is read. Null when logged;
 * otherwise the answer (503 when it can't be logged, 404 when the grant
 * ended in between).
 */
async function logLook(ref, me, now) {
  let logged;
  try {
    logged = await dbLogFullLook(ref, me, now);
  } catch (e) {
    return unavailable(e);
  }
  if (logged === null) return unavailable(new Error("look log unavailable"));
  return logged ? null : notShared();
}

/**
 * POST /api/trainer/change. The trainer never writes the client's plan: a
 * change set waits in trainer_changes and the client's app applies it.
 *   { ref, today, set: { id, ops }, basis, dryRun? }
 *     dryRun (any value but false) -> { preview: { ops, warnings }, budget },
 *     and writes nothing besides the look; else -> { sent: { set, ids }, budget }.
 *     A set id this trainer already sent and still waiting answers as a replay
 *     before it is checked again, so a retry after a lost reply is not "stale";
 *     the same id with other changes is 409 replay_mismatch and writes nothing.
 *     A dry run never answers as a replay.
 *   { ref, withdraw: changeId | setId, today? } -> { withdrawn: ids }
 * Gates, in order: per-IP limit, the trainer cookie, a Face ID within 24
 * hours, a real grant ref, the per-grant burst guard, a live grant with
 * changes on. A set is checked against the client's data, so the look is
 * logged first; if it can't be logged, nothing is read. Taking back changes
 * that have not landed reads nothing of theirs and logs no look; taking back
 * one that landed goes only while it is in force, which their training
 * tells, so then the look is logged and their profile read first.
 * Writes, named: dbLogFullLook (the look ring, before any read);
 * dbInsertChangeSet (one INSERT per set, refused past 10 sets a week);
 * dbWithdrawChanges (UPDATE undone_at on the trainer's own rows).
 */
export async function POST(request) {
  const limited = rateLimit(request, LABEL, 10);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    const now = Date.now();
    // Sending or taking back a change needs a Face ID in the last day; the
    // pane signs in again to get one.
    if (!faceIdFresh(g.authAt, now)) return slid(g, json({ needsFaceId: true }, 403));
    const body = await request.json().catch(() => ({}));
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const ref = typeof b.ref === "string" && b.ref.length <= 128 && b.ref !== SELF_REF ? b.ref : null;
    if (!ref) return slid(g, notShared());
    const shared = await rateLimitShared(request, LABEL, 200, { windowMs: DAY_MS, id: ref });
    if (shared) return slid(g, noStore(shared));

    const me = g.identity.accountId;
    const grants = await dbTrainerGrants(me, ref);
    if (!grants) return slid(g, unavailable(new Error("no store")));
    const [grant] = grants;
    if (!grant) return slid(g, notShared());
    if (!grant.edits) return slid(g, json({ editsOff: true }, 403));

    if ("withdraw" in b) {
      const x = b.withdraw;
      if (typeof x !== "string" || !x || x.length > WITHDRAW_MAX) return slid(g, json({ error: "Nothing to take back." }, 400));
      // Their own rows, as their list shows them. One that landed goes back
      // only while in force: never once they trained at it or changed it.
      let mine;
      try {
        mine = await dbChangesForTrainer(ref, me, now);
      } catch (e) {
        return slid(g, unavailable(e));
      }
      if (!mine) return slid(g, unavailable(new Error("no store")));
      const landed = mine.rows.filter((r) => (r.id === x || r.set === x) && r.outcome === "applied" && r.kind !== "week" && r.undoneAt == null);
      /** @type {string[]} */
      let inForce = [];
      if (landed.length) {
        const failed = await logLook(ref, me, now);
        if (failed) return slid(g, failed);
        let data;
        try {
          data = await dbReadProfile(grant.profile);
        } catch (e) {
          return slid(g, unavailable(e));
        }
        const state = { meta: data?.meta, history: data?.history ?? [], todayIso: trainerToday(b.today, now) };
        if (data) inForce = landed.filter((r) => changeStatus(r, state).status === "in_force").map((r) => r.id);
      }
      const ids = await dbWithdrawChanges(ref, me, x, inForce, now);
      if (!ids) return slid(g, unavailable(new Error("no store")));
      return slid(g, json({ withdrawn: ids }));
    }

    const failed = await logLook(ref, me, now);
    if (failed) return slid(g, failed);

    let data;
    let open;
    try {
      [data, open] = await Promise.all([dbReadProfile(grant.profile), dbOpenChangesForGrant(ref, me, now)]);
    } catch (e) {
      return slid(g, unavailable(e));
    }
    // The budget is counted from the log: no count, no change.
    if (!open) return slid(g, unavailable(new Error("no store")));
    const budget = { used: open.used, of: SETS_PER_WEEK, freeAt: open.freeAt };
    // Only an explicit false (or no key) sends: a malformed preview never writes.
    const dryRun = "dryRun" in b && b.dryRun !== false;
    const set = b.set && typeof b.set === "object" ? b.set : null;
    // A resend of a set still waiting: compared op for op (ids are set.00, set.01, ...).
    const sent = !dryRun && typeof set?.id === "string" ? open.open.filter((r) => r.set === set.id) : [];
    if (sent.length) {
      const ops = Array.isArray(set.ops) ? set.ops : [];
      const at = (r) => Number(r.id.slice(set.id.length + 1));
      const same = ops.length === sent[0].setSize && sent.every((r) => sameOp(ops[at(r)], r));
      if (!same) return slid(g, mismatch());
      return slid(g, json({ sent: { set: set.id, ids: [] }, replay: true, budget }));
    }
    // Nothing on the server to check against: the pane's view is out of date.
    if (!data) return slid(g, stale());
    const v = validateChangeSet(set, {
      meta: data.meta, history: data.history, todayIso: trainerToday(b.today, now),
      phase: "write", basis: b.basis && typeof b.basis === "object" ? b.basis : {},
    });
    // Refused: the pane names each code. Stale: it showed something that has moved since.
    if (!v.ok) {
      return slid(g, v.refusals.length ? json({ refusals: v.refusals }, 422) : stale());
    }

    // Never the basis: it is for the client's device only.
    const preview = v.ops.map(({ i, kind, target, from, before, after, warnings }) => ({ i, kind, target, from, before, after, warnings }));
    if (dryRun) return slid(g, json({ preview: { ops: preview, warnings: v.warnings }, budget }));

    const client = await dbAccountByStorageKey(grant.profile);
    if (!client) return slid(g, unavailable(new Error("client account unavailable")));
    if (client.deletedAt) return slid(g, notShared());
    const res = await dbInsertChangeSet({
      setId: set.id, grantId: ref, profile: grant.profile, clientId: client.id, authorId: me,
      ops: v.ops.map((o) => ({ kind: o.kind, target: o.target, before: o.before, after: o.after, basis: o.basis,
        warnings: o.warnings.length ? o.warnings : null, from: o.from })),
    }, now);
    if (!res) return slid(g, unavailable(new Error("no store")));
    if ("inserted" in res) {
      // The first set in the window frees up a week from now.
      const after = { ...budget, used: budget.used + 1, freeAt: budget.freeAt ?? now + BUDGET_WINDOW_MS };
      return slid(g, json({ sent: { set: set.id, ids: res.inserted }, budget: after }));
    }
    if ("replay" in res) return slid(g, json({ sent: { set: set.id, ids: [] }, replay: true, budget }));
    if ("mismatch" in res) return slid(g, mismatch());
    if ("taken" in res) return slid(g, json({ error: "That didn't send. Try again.", taken: true }, 409));
    const who = grant.name || "this client";
    const more = res.freeAt == null ? "" : ` More from ${DAY_LABEL.format(new Date(res.freeAt))}.`;
    return slid(g, json({
      error: `That's this week's changes for ${who}.${more}`,
      budget: { used: res.used, of: SETS_PER_WEEK, freeAt: res.freeAt },
    }, 429));
  } catch (e) {
    return noStore(serverError(e, { label: LABEL }));
  }
}
