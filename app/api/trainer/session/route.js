import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { trainerOpenFor, isAdminIdentity } from "@/lib/auth-server";
import { dbExpireToken } from "@/lib/db";
import { dbPrimaryHandle } from "@/lib/identity-store";
import { dbTrainerApplication } from "@/lib/trainer-store";
import { applicationView } from "@/lib/trainer-apply";
import { entitled } from "@/lib/entitlements";
import { isCurrentTrainerTerms } from "@/lib/trainer-terms";
import { publicName } from "@/lib/trainer-view";
import { freshCeremony, mintTrainerSession, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// POST /api/trainer/session  { authToken, profile } -> { ok, name } + the trainer cookie;
//   403 { notTrainer, name, admin, application } or { needsTerms, name } (name: the live primary handle).
// authToken is a quiet sign-in's ceremony token. It is expired once exchanged,
// and only then: a 403 leaves it usable for the upgrade or an application, still inside its 5 minutes.
export async function POST(request) {
  const limited = rateLimit(request, "trainer-session", 10) || await rateLimitShared(request, "trainer-session", 20);
  if (limited) return noStore(limited);
  try {
    const body = await request.json().catch(() => ({}));
    const { authToken, profile } = body && typeof body === "object" ? body : {};
    const c = await freshCeremony({ authToken, profile });
    if ("fail" in c) return c.fail;
    // The name rides the 403s too: the apply and terms panels say who is signing.
    const nameNow = async () => publicName(await dbPrimaryHandle(c.identity.accountId));
    if (!entitled(c.account, "trainer.dashboard")) {
      // The admin self-grants; everyone else is shown Apply, already knowing where they stand.
      const [name, app] = await Promise.all([nameNow(), dbTrainerApplication(c.identity.accountId)]);
      return json({ notTrainer: true, name, admin: isAdminIdentity(c.identity), application: applicationView(app, Date.now()) }, 403);
    }
    if (!trainerOpenFor(c.identity)) return json({ error: "Not open yet." }, 503);
    if (!isCurrentTrainerTerms(c.account.trainerTerms)) return json({ needsTerms: true, name: await nameNow() }, 403);

    // Writes: INSERT auth_tokens (the session), then UPDATE auth_tokens.expires on the ceremony token.
    const session = await mintTrainerSession(c.identity, c);
    await dbExpireToken(authToken);
    return setTrainerCookie(json({ ok: true, name: await nameNow() }), session);
  } catch (e) {
    return noStore(serverError(e, { label: "trainer-session" }));
  }
}
