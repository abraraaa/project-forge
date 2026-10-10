import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { dbReadProfile } from "@/lib/db";
import { dbPrimaryHandle } from "@/lib/identity-store";
import { dbTrainerGrants, dbLogFullLook } from "@/lib/trainer-store";
import { dbChangesForTrainer } from "@/lib/trainer-changes-store";
import { trainerToday, publicName, SELF_REF } from "@/lib/trainer-view";
import { projectForTrainer, editsStatus } from "@/lib/trainer-plan";
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
// view.edits says where the trainer's changes stand: on, off, fresh (the
// grant predates the current consent) or unavailable (changes on, but the
// trainer's own changes could not be read: the failure is logged and the view
// answers without a plan). When on, view.plan carries what the trainer may
// change, with their own changes and budget (read after the look, like the
// profile). Otherwise view.ran carries only the sessions they ran with the
// client and the session count, so a session on the client's phone still
// shows after changes stop.
// { ref: "me" } -> { client: { name }, view, self: true }: the trainer's own
// training, from their own storage key, through the same projection. No
// grant and no look: it is their own data.
export async function POST(request) {
  const limited = rateLimit(request, LABEL, 60);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    const body = await request.json().catch(() => ({}));
    const ref = body && typeof body === "object" && typeof body.ref === "string" && body.ref.length <= 128 ? body.ref : null;
    if (!ref) return slid(g, notShared());
    const me = g.identity.accountId;
    const self = ref === SELF_REF;
    // Per grant, or per trainer for their own: "me" is never one shared bucket.
    const shared = await rateLimitShared(request, LABEL, 300, { windowMs: DAY_MS, id: self ? me : ref });
    if (shared) return slid(g, noStore(shared));

    const now = Date.now();
    let profile, client, grant = null;
    if (self) {
      profile = g.identity.storageKey;
      client = { name: publicName(await dbPrimaryHandle(me)) };
    } else {
      grant = ((await dbTrainerGrants(me, ref)) ?? [])[0] ?? null;
      if (!grant) return slid(g, notShared());
      let logged;
      try {
        logged = await dbLogFullLook(ref, me, now);
      } catch (e) {
        return slid(g, noStore(serverError(e, { status: 503, label: LABEL })));
      }
      if (logged === null) return slid(g, noStore(serverError(new Error("look log unavailable"), { status: 503, label: LABEL })));
      if (!logged) return slid(g, notShared());
      // Keyed by the grant's storage key: the client's own profile.
      profile = grant.profile;
      client = { name: grant.name, since: grant.since };
    }

    const data = await dbReadProfile(profile);
    let changes = null;
    // The trainer's own rows on a live grant, whatever the edits status: plan
    // changes stay gated on edits (projectForTrainer), sessions do not.
    if (grant) {
      try {
        changes = await dbChangesForTrainer(ref, me, now);
      } catch (e) {
        serverError(e, { label: `${LABEL}-plan` }); // logged; the view still answers
      }
    }
    // The trainer's own training has no grant: no edits status, no plan.
    const status = grant ? editsStatus(grant, changes) : null;
    const view = projectForTrainer(data, { todayIso: trainerToday(body.today, now), edits: changes, status });
    return slid(g, json(self ? { client, view, self: true } : { client, view }));
  } catch (e) {
    return noStore(serverError(e, { label: LABEL }));
  }
}
