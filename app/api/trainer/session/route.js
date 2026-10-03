import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { trainerOpenFor } from "@/lib/auth-server";
import { dbExpireToken } from "@/lib/db";
import { dbPrimaryHandle } from "@/lib/identity-store";
import { entitled } from "@/lib/entitlements";
import { isCurrentTrainerTerms } from "@/lib/trainer-terms";
import { publicName } from "@/lib/trainer-view";
import { freshCeremony, mintTrainerSession, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// POST /api/trainer/session  { authToken, profile } -> { ok, name } + the trainer cookie.
// authToken is a quiet sign-in's ceremony token. It is expired once exchanged,
// and only then: a 403 leaves it usable for the upgrade, still inside its 5 minutes.
export async function POST(request) {
  const limited = rateLimit(request, "trainer-session", 10) || await rateLimitShared(request, "trainer-session", 20);
  if (limited) return noStore(limited);
  try {
    const body = await request.json().catch(() => ({}));
    const { authToken, profile } = body && typeof body === "object" ? body : {};
    const c = await freshCeremony({ authToken, profile });
    if ("fail" in c) return c.fail;
    if (!entitled(c.account, "trainer.dashboard")) return json({ notTrainer: true }, 403);
    if (!trainerOpenFor(c.identity)) return json({ error: "Not open yet." }, 503);
    if (!isCurrentTrainerTerms(c.account.trainerTerms)) return json({ needsTerms: true }, 403);

    // Writes: INSERT auth_tokens (the session), then UPDATE auth_tokens.expires on the ceremony token.
    const session = await mintTrainerSession(c.identity, c);
    await dbExpireToken(authToken);
    const name = publicName(await dbPrimaryHandle(c.identity.accountId));
    return setTrainerCookie(json({ ok: true, name }), session);
  } catch (e) {
    return noStore(serverError(e, { label: "trainer-session" }));
  }
}
