import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { trainerOpenFor } from "@/lib/auth-server";
import { dbGrantTrainerRole } from "@/lib/identity-store";
import { acceptedTrainerTermsVersion, TRAINER_TERMS_VERSION } from "@/lib/trainer-terms";
import { trainerGate, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

const LABEL = "trainer-terms";

/** Carry the gate's daily slide, if any, on whatever the route answers. */
const slid = (gate, res) => (gate.refresh ? setTrainerCookie(res, gate.refresh) : res);

// POST /api/trainer/terms  { version } -> { ok: true, termsChanged: null }
// Continue on the roster's Terms notice: a trainer signed in (the cookie) who
// accepted an older version accepts the current one. No Face ID: the session
// already carries one. A trainer who never accepted gets the gate's 403
// needsTerms; the first acceptance stays with /api/trainer/upgrade.
export async function POST(request) {
  const limited = rateLimit(request, LABEL, 5) || await rateLimitShared(request, LABEL, 10);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    if (!trainerOpenFor(g.identity)) return slid(g, json({ error: "Not open yet." }, 503));
    const body = await request.json().catch(() => ({}));
    const version = acceptedTrainerTermsVersion(body);
    if (version !== TRAINER_TERMS_VERSION) return slid(g, json({ error: "Accept the Trainer Terms to continue." }, 400));

    // Write: UPDATE accounts.trainer_terms in place on the caller's own row
    // (version, at, adult). The gate already holds the trainer role, so roles
    // stay as they are.
    const granted = await dbGrantTrainerRole(g.identity.accountId, { version, at: new Date().toISOString(), adult: true });
    if (!granted) return json({ error: "Sign in to see your clients", requiresAuth: true }, 401);
    return slid(g, json({ ok: true, termsChanged: null }));
  } catch (e) {
    return noStore(serverError(e, { label: LABEL }));
  }
}
