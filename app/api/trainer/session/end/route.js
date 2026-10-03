import { rateLimit } from "@/lib/rate-limit";
import { readTokenData, resolveTokenIdentity } from "@/lib/auth-server";
import { dbExpireToken, dbExpireTrainerSessions } from "@/lib/db";
import { TRAINER_COOKIE, json, noStore, clearTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// POST /api/trainer/session/end  { everywhere?: boolean } -> { ok } + the cookie cleared.
// Ends the session this cookie carries (UPDATE expires; the row stays). With
// everywhere, ends every trainer session of that account, only when the
// cookie still signs in. The cookie is cleared whatever it held.
export async function POST(request) {
  const limited = rateLimit(request, "trainer-session-end", 20);
  if (limited) return noStore(limited);
  try {
    const body = await request.json().catch(() => ({}));
    const everywhere = !!body && typeof body === "object" && body.everywhere === true;
    const token = request.cookies?.get?.(TRAINER_COOKIE)?.value || null;
    const data = await readTokenData(token);
    if (data?.scope === "trainer") {
      const now = Date.now();
      const identity = everywhere ? await resolveTokenIdentity(data, null, now) : null;
      await dbExpireToken(token, now);
      if (identity) await dbExpireTrainerSessions(identity.accountId, now);
    }
    return clearTrainerCookie(json({ ok: true }));
  } catch (e) {
    return clearTrainerCookie(noStore(serverError(e, { label: "trainer-session-end" })));
  }
}
