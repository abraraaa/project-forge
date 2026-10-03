import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { trainerOpenFor } from "@/lib/auth-server";
import { dbExpireToken } from "@/lib/db";
import { dbGrantTrainerRole, dbPrimaryHandle } from "@/lib/identity-store";
import { acceptedTrainerTermsVersion, TRAINER_TERMS_VERSION } from "@/lib/trainer-terms";
import { publicName } from "@/lib/trainer-view";
import { freshCeremony, mintTrainerSession, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// POST /api/trainer/upgrade  { authToken, profile, terms: { version }, adult: true }
//   -> { ok, name } + the trainer cookie.
// A fresh heatwayve.app Face ID, 18+ and the current Trainer Terms make the
// caller a trainer. Free; plan is never written.
export async function POST(request) {
  const limited = rateLimit(request, "trainer-upgrade", 5) || await rateLimitShared(request, "trainer-upgrade", 10);
  if (limited) return noStore(limited);
  try {
    const body = await request.json().catch(() => ({}));
    const { authToken, profile, terms, adult } = body && typeof body === "object" ? body : {};
    const c = await freshCeremony({ authToken, profile });
    if ("fail" in c) return c.fail;
    if (!trainerOpenFor(c.identity)) return json({ error: "Not open yet." }, 503);
    const version = acceptedTrainerTermsVersion(terms);
    if (version !== TRAINER_TERMS_VERSION || adult !== true) {
      return json({ error: "Accept the Trainer Terms to continue." }, 400);
    }

    // Writes: UPDATE accounts.roles / trainer_terms (the caller's own row; terms
    // overwritten in place on re-acceptance), INSERT auth_tokens (the session),
    // UPDATE auth_tokens.expires on the ceremony token.
    const granted = await dbGrantTrainerRole(c.identity.accountId, { version, at: new Date().toISOString(), adult: true });
    if (!granted) return json({ error: "Face ID didn't go through. Try again.", requiresAuth: true }, 401);
    const session = await mintTrainerSession(c.identity, c);
    await dbExpireToken(authToken);
    const name = publicName(await dbPrimaryHandle(c.identity.accountId));
    return setTrainerCookie(json({ ok: true, name }), session);
  } catch (e) {
    return noStore(serverError(e, { label: "trainer-upgrade" }));
  }
}
