import { NextResponse } from "next/server";
import { rateLimit, failureGate } from "@/lib/rate-limit";
import { dbReadProfile } from "@/lib/db";
import { dbPrimaryHandle } from "@/lib/identity-store";
import { normaliseProfile } from "@/lib/profile-name";
import { dbTrainerGrants, dbLogFullLook } from "@/lib/trainer-store";
import { dbChangesForTrainer } from "@/lib/trainer-changes-store";
import { trainerToday, publicName, SELF_REF } from "@/lib/trainer-view";
import { projectForTrainer, editsStatus } from "@/lib/trainer-plan";
import { csvFromView, exportFilename } from "@/lib/trainer-export";
import { trainerGate, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const LABEL = "trainer-export";
/** Downloads per grant (or per trainer, for their own) per UTC day. */
export const EXPORTS_PER_DAY = 10;
/** Excel reads a CSV as UTF-8 only with this mark first. */
const BOM = "\uFEFF";

/** Carry the gate's daily slide, if any, on whatever the route answers. */
const slid = (gate, res) => (gate.refresh ? setTrainerCookie(res, gate.refresh) : res);
// The client route's one answer for revoked, closed, a dead passkey, another trainer's client and unknown.
const notShared = () => json({ error: "Not shared with you now." }, 404);

// POST /api/trainer/export { ref: <grant ref | "me">, today?: YYYY-MM-DD } -> text/csv
// The same gates and view as POST /api/trainer/client, and POST for the same
// reason: the grant id stays out of URLs and logs. A download is a look,
// logged on the grant before the client's data is read (coalesced the same
// way). Writes: one count on the day's rate bucket (failureGate's upsert),
// taken only once the grant is found live, then the look ring UPDATE
// (dbLogFullLook), both before any read. The count fails closed: no
// database, no download. The body starts with a UTF-8 BOM so Excel reads it
// as UTF-8.
export async function POST(request) {
  const limited = rateLimit(request, LABEL, 30);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    const body = await request.json().catch(() => ({}));
    const ref = body && typeof body === "object" && typeof body.ref === "string" && body.ref && body.ref.length <= 128 ? body.ref : null;
    if (!ref) return slid(g, notShared());
    const me = g.identity.accountId;
    const self = ref === SELF_REF;
    const now = Date.now();

    let grant = null;
    if (!self) {
      grant = ((await dbTrainerGrants(me, ref)) ?? [])[0] ?? null;
      if (!grant) return slid(g, notShared());
    }

    // Per grant, or per trainer for their own: "me" is never one shared bucket.
    // failureGate hashes ids into 1024 buckets per route and checks before it
    // counts, so two grants can share a day's 10 and a burst can pass 10 by a
    // few. Accepted: it only ever refuses early. The day is the UTC day.
    const gate = await failureGate(LABEL, self ? me : ref, EXPORTS_PER_DAY, {
      windowMs: DAY_MS, now, limited: "That's today's downloads. Try again tomorrow.",
    });
    if (gate.blocked) return slid(g, noStore(gate.blocked));
    try {
      await gate.strike();
    } catch (e) {
      return slid(g, noStore(serverError(e, { status: 503, label: LABEL })));
    }

    const trainerName = publicName(await dbPrimaryHandle(me));
    let profile, clientName, handle;
    if (self) {
      profile = g.identity.storageKey;
      clientName = trainerName;
      handle = trainerName ? normaliseProfile(trainerName) : null;
    } else {
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
      clientName = grant.name;
      // publicName's display always normalises to the handle.
      handle = grant.name ? normaliseProfile(grant.name) : null;
    }

    const data = await dbReadProfile(profile);
    // With changes on, the plan comes too, so set_by can name the trainer's changes.
    let changes = null;
    if (grant?.edits === true) {
      try {
        changes = await dbChangesForTrainer(ref, me, now);
      } catch (e) {
        serverError(e, { label: `${LABEL}-plan` }); // logged; the file still comes, without set_by
      }
    }
    const status = grant ? editsStatus(grant, changes) : null;
    const todayIso = trainerToday(body.today, now);
    const view = projectForTrainer(data, { todayIso, edits: changes, status });
    const csv = csvFromView(view, { name: clientName, trainer: self ? null : trainerName, date: todayIso });

    // The file is named by the handle; with none usable, "me" or "client", never the grant ref.
    const res = new NextResponse(BOM + csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(handle, self ? SELF_REF : "", todayIso)}"`,
        "Cache-Control": "no-store",
      },
    });
    return slid(g, res);
  } catch (e) {
    return noStore(serverError(e, { label: LABEL }));
  }
}
