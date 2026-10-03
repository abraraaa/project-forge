import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { dbReadProfile } from "@/lib/db";
import { dbTrainerGrants, dbLogFullLook } from "@/lib/trainer-store";
import { projectForTrainer, trainerToday } from "@/lib/trainer-view";
import { trainerGate, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const LABEL = "trainer-client";

/** Carry the gate's daily slide, if any, on whatever the route answers. */
const slid = (gate, res) => (gate.refresh ? setTrainerCookie(res, gate.refresh) : res);
// One answer for revoked, closed, a dead passkey, another trainer's client and unknown.
const notShared = () => json({ error: "Not shared with you now." }, 404);

// POST /api/trainer/client { ref, today } -> { client: { name, since }, view }
// POST keeps the grant id out of URLs and logs. The look is logged on the
// grant before the client's data is read; if it can't be logged, nothing is read.
export async function POST(request) {
  const limited = rateLimit(request, LABEL, 60);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    const body = await request.json().catch(() => ({}));
    const ref = body && typeof body === "object" && typeof body.ref === "string" && body.ref.length <= 128 ? body.ref : null;
    if (!ref) return slid(g, notShared());
    const shared = await rateLimitShared(request, LABEL, 300, { windowMs: DAY_MS, id: ref });
    if (shared) return slid(g, noStore(shared));

    const me = g.identity.accountId;
    const [grant] = (await dbTrainerGrants(me, ref)) ?? [];
    if (!grant) return slid(g, notShared());

    const now = Date.now();
    let logged;
    try {
      logged = await dbLogFullLook(ref, me, now);
    } catch (e) {
      return slid(g, noStore(serverError(e, { status: 503, label: LABEL })));
    }
    if (logged === null) return slid(g, noStore(serverError(new Error("look log unavailable"), { status: 503, label: LABEL })));
    if (!logged) return slid(g, notShared());

    // Keyed by the grant's storage key: the client's own profile.
    const data = await dbReadProfile(grant.profile);
    const view = projectForTrainer(data, { todayIso: trainerToday(body.today, now) });
    return slid(g, json({ client: { name: grant.name, since: grant.since }, view }));
  } catch (e) {
    return noStore(serverError(e, { label: LABEL }));
  }
}
