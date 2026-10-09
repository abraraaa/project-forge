import { rateLimit } from "@/lib/rate-limit";
import { applyOpenFor, readTokenData, resolveTokenIdentity, shareOpenFor, trainerOpenFor } from "@/lib/auth-server";
import { neonOAuthStore } from "@/lib/oauth-store";
import { revokeGrantFor } from "@/lib/oauth";
import { entitled } from "@/lib/entitlements";
import { dbClientShare, dbSeenApplication, dbSeenEndedNotice, dbTrainerApplication, dbWithdrawApplication } from "@/lib/trainer-store";
import { applicationView } from "@/lib/trainer-apply";
import { freshCeremony, json, noStore } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";
import { dbReadProfile, dbExpireToken } from "@/lib/db";
import { dbMarkSeen } from "@/lib/notices";
import { trainerToday } from "@/lib/trainer-view";
import { SHARE_CONSENT_VERSION } from "@/lib/trainer-terms";
import { changeStatus, isUndoable } from "@/lib/trainer-change";
import { dbChangesForClient, dbUndoChanges, dbAckChanges, dbEditsOff, dbEditsOn, cleanAcks, isIsoInstant } from "@/lib/trainer-changes-store";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// The client's trainer share, for Profile. Under /api/sync so the hw_sync
// cookie (path-scoped there) authorises it, as for connected AIs.
//   GET  /api/sync/trainer?profile=N[&today=YYYY-MM-DD]
//        -> { open, trainerOpen, applyOpen, trainer, trainerRole, sharing, ended, application, edits, changes }
//        applyOpen: whether they may apply to coach (applyOpenFor); trainerOpen gates the dashboard.
//        application: null | { status, at, decidedAt, nextAt, seen }, the caller's own
//        application to coach (never what they wrote).
//        edits: null | { on, since }, whether their live trainer may change their plan.
//        changes: their trainer changes (24 weeks and anything not landed, newest first,
//        at most 100), each with the status it reads as now (lib/trainer-change.js
//        changeStatus over their synced training). Never the basis. Read only: the
//        notice's seen mark is a POST.
//   POST /api/sync/trainer { profile, stop } -> { ok }. Stop is revokeGrantFor, an UPDATE of
//        revoked_at on the client's own trainer grant (revoked_by stays null: the client
//        ended it). It only reduces access, so it needs no Face ID. Nothing is deleted.
//   POST /api/sync/trainer { profile, seen } -> { ok }. "Got it" on the ended notice:
//        dbSeenEndedNotice, an UPDATE of notice_seen_at on the client's own ended
//        trainer grant. Nothing is deleted.
//   POST /api/sync/trainer { profile, seenApplication: true } -> { ok }. dbSeenApplication,
//        an UPDATE of seen_at on the caller's own decided application, once.
//   POST /api/sync/trainer { profile, withdrawApplication: true } -> { ok }.
//        dbWithdrawApplication, an UPDATE of status 'withdrawn' on the caller's own
//        waiting application. It only takes something back, so no Face ID, as for stop.
// A trainer's changes to the client's plan (lib/trainer-changes-store.js). The
// trainer never writes client data: the client's app applies a change, and puts
// one back, through its own stamped edits on its next pull.
//   POST { profile, undo, reverted? } -> { ok, undone }. undo: a change id or a set
//        id. dbUndoChanges, an UPDATE of undone_at, undone_by 'client' (and
//        reverted_at with reverted, the device's instant) on each of the caller's
//        own changes that is undoable now: not landed, or in their plan and not
//        yet trained at. One that landed stays undone-not-put-back until their
//        app writes the old value back and reports it. A week in their plan only
//        with reverted (their app put it back first). No Face ID, any grant state.
//   POST { profile, acks?, reverts? } -> { ok, acked, reverted }. Their app's
//        report: dbAckChanges, an UPDATE of outcome and applied_at (first report
//        stands), and of reverted_at on undone rows, their own rows only.
//   POST { profile, seenChanges: true } -> { ok }. dbMarkSeen, the account's
//        'trainerChange' mark in notice_marks, overwritten in place.
//   POST { profile, edits: false } -> { ok }. dbEditsOff, an UPDATE of
//        edits_off_at on their live trainer grant. It only reduces access, so no
//        Face ID; changes not yet landed stop being delivered.
//   POST { profile, edits: true, authToken } -> { ok } | 409 { fresh }. A fresh
//        Face ID first (freshCeremony), then dbEditsOn, an UPDATE of edits_at on
//        their live grant on the current share consent, then the ceremony token
//        expires (dbExpireToken, an UPDATE of auth_tokens.expires).

// The caller's identity, or null. The connections gate, verbatim: a
// full-scope ceremony token or the sync-scope cookie, never another scope.
async function gate(request, profile) {
  const header = request.headers.get("x-hw-auth") || null;
  const cookie = request.cookies.get("hw_sync")?.value || null;
  const data = await readTokenData(header || cookie);
  const identity = await resolveTokenIdentity(data, profile, Date.now());
  if (!identity) return null;
  return !data.scope || data.scope === "sync" ? identity : null;
}

const denied = () => json({ error: "Sign in to see your trainer", requiresAuth: true }, 401);

export async function GET(request) {
  const limited = rateLimit(request, "sync-trainer-read", 30);
  if (limited) return noStore(limited);
  try {
    const profile = new URL(request.url).searchParams.get("profile") || "";
    const identity = profile ? await gate(request, profile) : null;
    if (!identity) return denied();
    const now = Date.now();
    const [share, app, list] = await Promise.all([
      dbClientShare(identity.accountId), dbTrainerApplication(identity.accountId), dbChangesForClient(identity.accountId, now),
    ]);
    const trainer = entitled(identity, "trainer.dashboard");
    const today = trainerToday(new URL(request.url).searchParams.get("today"), now);
    const changes = list?.rows.length ? await clientChanges(list.rows, identity.storageKey, today) : [];
    return json({
      open: shareOpenFor(identity),
      trainerOpen: trainerOpenFor(identity),
      applyOpen: applyOpenFor(identity),
      trainer,
      // The role itself, whatever the launch switch says.
      trainerRole: trainer,
      sharing: share?.sharing ?? null,
      ended: share?.ended ?? null,
      application: applicationView(app, now),
      edits: list?.edits ?? null,
      changes,
    });
  } catch (e) {
    return noStore(serverError(e, { label: "sync-trainer-read" }));
  }
}

export async function POST(request) {
  const limited = rateLimit(request, "sync-trainer-write", 20);
  if (limited) return noStore(limited);
  try {
    const raw = await request.json().catch(() => ({}));
    const body = raw && typeof raw === "object" ? raw : {};
    const { profile, stop, seen, seenApplication, withdrawApplication } = body;
    const identity = typeof profile === "string" && profile ? await gate(request, profile) : null;
    if (!identity) return denied();
    const verbs = /** @type {("undo" | "acks" | "seenChanges" | "edits")[]} */ (["undo", "acks", "seenChanges", "edits"]).filter((k) => body[k] !== undefined || (k === "acks" && body.reverts !== undefined));
    if (verbs.length) {
      // One verb per request, and never beside another branch's key.
      if (verbs.length > 1 || [stop, seen, seenApplication, withdrawApplication].some((v) => v !== undefined)) {
        return json({ error: "Not found" }, 404);
      }
      return await changesWrite(verbs[0], body, identity, request);
    }
    if (stop === undefined && seen === undefined && (seenApplication === true || withdrawApplication === true)) {
      if (seenApplication === true && withdrawApplication === true) return json({ error: "Not found" }, 404);
      // Only the caller's own row: a decided one for seen, a waiting one for withdraw.
      const done = seenApplication === true
        ? await dbSeenApplication(identity.accountId, Date.now())
        : await dbWithdrawApplication(identity.accountId, Date.now());
      if (done === null) return json({ error: "Unavailable" }, 503);
      return done ? json({ ok: true }) : json({ error: "Not found" }, 404);
    }
    if (stop === undefined && seen !== undefined) {
      if (typeof seen !== "string" || !seen || seen.length > 128) return json({ error: "Not found" }, 404);
      // Only the owner's own ended trainer grant, once.
      const done = await dbSeenEndedNotice(identity.accountId, seen, Date.now());
      if (done === null) return json({ error: "Unavailable" }, 503);
      return done ? json({ ok: true }) : json({ error: "Not found" }, 404);
    }
    if (typeof stop !== "string" || !stop || stop.length > 128) return json({ error: "Not found" }, 404);
    const store = await neonOAuthStore();
    if (!store) return json({ error: "Unavailable" }, 503);
    // Only the owner's own trainer grant: an AI grant id, or anyone else's, is not found.
    const ok = await revokeGrantFor(store, identity, stop, Date.now(), { kind: "trainer" });
    return ok ? json({ ok: true }) : json({ error: "Not found" }, 404);
  } catch (e) {
    return noStore(serverError(e, { label: "sync-trainer-write" }));
  }
}

// ─── A trainer's changes ─────────────────────────────────────────────────────

const isRef = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;
const codes = (w) => (Array.isArray(w) ? w.filter((c) => typeof c === "string" && c.length <= 32) : []);

/** What a change needs to be judged against: their synced plan and training. */
async function trainingState(storageKey, todayIso) {
  const prof = await dbReadProfile(storageKey);
  return { meta: prof?.meta ?? {}, history: Array.isArray(prof?.history) ? prof.history : [], todayIso };
}

/** Each change as the client's list shows it: what changed, and where it stands now. */
async function clientChanges(rows, storageKey, todayIso) {
  const state = await trainingState(storageKey, todayIso);
  return rows.map((r) => {
    const st = changeStatus(r, { ...state, editsLive: r.editsLive });
    return {
      id: r.id, set: r.set, kind: r.kind, target: r.target, before: r.before, after: r.after, from: r.from,
      status: st.status, reason: st.reason, date: st.date, ...(st.cooked ? { cooked: true } : {}),
      at: r.at, undoable: isUndoable(r, st, state), warnings: codes(r.warnings), by: r.by ?? null,
    };
  });
}

/**
 * The client's writes on their trainer's changes, one verb per request. Every
 * write is to the caller's own rows or grant.
 * @param {"undo" | "acks" | "seenChanges" | "edits"} verb
 * @param {any} body
 * @param {import("@/lib/identity").Identity} identity
 * @param {Request} request
 */
async function changesWrite(verb, body, identity, request) {
  const me = identity.accountId;
  const now = Date.now();
  if (verb === "seenChanges") {
    if (body.seenChanges !== true) return json({ error: "Not found" }, 404);
    const done = await dbMarkSeen(me, "trainerChange", now);
    return done ? json({ ok: true }) : json({ error: "Unavailable" }, 503);
  }
  if (verb === "acks") {
    if (!cleanAcks(body.acks, body.reverts)) return json({ error: "Bad report" }, 400);
    const r = await dbAckChanges(me, { acks: body.acks, reverts: body.reverts });
    return r ? json({ ok: true, ...r }) : json({ error: "Unavailable" }, 503);
  }
  if (verb === "edits") {
    if (body.edits === false) {
      const done = await dbEditsOff(me, now);
      if (done === null) return json({ error: "Unavailable" }, 503);
      return done ? json({ ok: true }) : json({ error: "Not found" }, 404);
    }
    if (body.edits !== true) return json({ error: "Not found" }, 404);
    const c = await freshCeremony({ authToken: body.authToken, profile: body.profile }, now);
    if ("fail" in c) return c.fail;
    // The Face ID must be the signed-in account's own.
    if (c.identity.accountId !== me) return json({ error: "Face ID didn't go through. Try again.", requiresAuth: true }, 401);
    const r = await dbEditsOn(me, SHARE_CONSENT_VERSION, now);
    if (r === null) return json({ error: "Unavailable" }, 503);
    if (r === "fresh") return json({ fresh: true, error: "Ask your trainer for a fresh code" }, 409);
    if (r === "none") return json({ error: "Not found" }, 404);
    try { await dbExpireToken(body.authToken); } catch (e) { console.error("[sync-trainer] expire ceremony token", e?.message || e); }
    return json({ ok: true });
  }
  // Undo: a change, or every undoable change in a set.
  const { undo, reverted } = body;
  if (!isRef(undo)) return json({ error: "Not found" }, 404);
  if (reverted != null && !isIsoInstant(reverted)) return json({ error: "Bad report" }, 400);
  const list = await dbChangesForClient(me, now);
  if (!list) return json({ error: "Unavailable" }, 503);
  const targets = list.rows.filter((r) => r.id === undo || r.set === undo);
  if (!targets.length) return json({ error: "Not found" }, 404);
  const open = targets.filter((r) => r.undoneAt == null);
  // Undone already: nothing to do, and that's fine.
  if (!open.length) return json({ ok: true, undone: [] });
  const state = await trainingState(identity.storageKey, trainerToday(new URL(request.url).searchParams.get("today"), now));
  const ids = open.filter((r) => {
    const st = changeStatus(r, { ...state, editsLive: r.editsLive });
    // A week in their plan goes back through their own week editor first.
    if (r.kind === "week" && st.status === "in_force" && reverted == null) return false;
    return isUndoable(r, st, state);
  }).map((r) => r.id);
  if (!ids.length) return json({ error: "Not undoable" }, 409);
  const undone = [];
  for (const id of ids) {
    const r = await dbUndoChanges(me, id, reverted ?? null, now);
    if (r === null) return json({ error: "Unavailable" }, 503);
    undone.push(...r);
  }
  return json({ ok: true, undone: undone.sort() });
}
