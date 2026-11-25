import { rateLimit } from "@/lib/rate-limit";
import { readTokenData, resolveTokenIdentity, isAdminIdentity } from "@/lib/auth-server";
import { dbNotices } from "@/lib/notices";
import { json, noStore } from "@/lib/trainer-session";
import { trainerDay } from "@/lib/server-time";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// What is new, for the dot on home. Under /api/sync so the hw_sync cookie
// (path-scoped there) authorises it, as for the trainer share.
//   GET /api/sync/notices?profile=N&today=YYYY-MM-DD -> { dots: { bugs?, applications?, application?, clients?, trainerChange?,
//       trainerSession? }, admin? }
//       Each key only when there is something; counts and booleans, never a name.
//       trainerSession: sessions a trainer logged with you, waiting for Keep or Discard.
//       today: the device's date, which the clients window reads on (trainerDay).
//       Read only: marks are written where each list is opened (lib/notices.js).

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

export async function GET(request) {
  const limited = rateLimit(request, "sync-notices-read", 60);
  if (limited) return noStore(limited);
  try {
    const params = new URL(request.url).searchParams;
    const profile = params.get("profile") || "";
    const identity = profile ? await gate(request, profile) : null;
    if (!identity) return json({ error: "Sign in to see what's new", requiresAuth: true }, 401);
    // The identity carries the account's roles and plan, read at sign-in resolution.
    const now = Date.now();
    const dots = await dbNotices(identity, identity, now, trainerDay(params.get("today"), now));
    if (!dots) return json({ error: "Unavailable" }, 503);
    return json(isAdminIdentity(identity) ? { dots, admin: true } : { dots });
  } catch (e) {
    return noStore(serverError(e, { label: "sync-notices-read" }));
  }
}
