import { rateLimit } from "@/lib/rate-limit";
import { readTokenData, resolveTokenIdentity, shareOpenFor, trainerOpenFor } from "@/lib/auth-server";
import { neonOAuthStore } from "@/lib/oauth-store";
import { revokeGrantFor } from "@/lib/oauth";
import { entitled } from "@/lib/entitlements";
import { dbClientShare, dbSeenApplication, dbSeenEndedNotice, dbTrainerApplication, dbWithdrawApplication } from "@/lib/trainer-store";
import { applicationView } from "@/lib/trainer-apply";
import { json, noStore } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// The client's trainer share, for Profile. Under /api/sync so the hw_sync
// cookie (path-scoped there) authorises it, as for connected AIs.
//   GET  /api/sync/trainer?profile=N       -> { open, trainerOpen, trainer, trainerRole, sharing, ended, application }
//        application: null | { status, at, decidedAt, nextAt, seen }, the caller's own
//        application to coach (never what they wrote).
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
    const [share, app] = await Promise.all([dbClientShare(identity.accountId), dbTrainerApplication(identity.accountId)]);
    const trainer = entitled(identity, "trainer.dashboard");
    return json({
      open: shareOpenFor(identity),
      trainerOpen: trainerOpenFor(identity),
      trainer,
      // The role itself, whatever the launch switch says.
      trainerRole: trainer,
      sharing: share?.sharing ?? null,
      ended: share?.ended ?? null,
      application: applicationView(app, Date.now()),
    });
  } catch (e) {
    return noStore(serverError(e, { label: "sync-trainer-read" }));
  }
}

export async function POST(request) {
  const limited = rateLimit(request, "sync-trainer-write", 20);
  if (limited) return noStore(limited);
  try {
    const { profile, stop, seen, seenApplication, withdrawApplication } = await request.json().catch(() => ({}));
    const identity = typeof profile === "string" && profile ? await gate(request, profile) : null;
    if (!identity) return denied();
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
