import { rateLimit } from "@/lib/rate-limit";
import { requireAdminCeremony, BACKFILL_FRESH_MS } from "@/lib/identity-backfill-inputs";
import { dbDenyApplication, dbListApplications } from "@/lib/trainer-store";
import { dbApproveApplication } from "@/lib/identity-store";
import { json, noStore } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// Applications to coach, for the admin at /diag-trainers.
//   GET  (X-HW-Auth: an admin ceremony token)  -> { open, decided }
//        Read only: name (the live handle), accountAge (days), about, link,
//        appliedAt. about and link are strangers' text: the page shows them
//        as text, never as a link.
//   POST { decision: "approve" | "deny", accountId }  (X-HW-Auth: an admin
//        ceremony from the last 5 minutes) -> { ok, status }
//        approve: dbApproveApplication, one transaction (the role and
//        trainer_terms UPDATE on accounts, the application UPDATE to
//        'approved'). deny: dbDenyApplication, an UPDATE to 'denied'.
//        Only a waiting application is decided; anything else is 404.
// Before the first approval in production, the owner reads (read only):
//   SELECT id FROM accounts WHERE 'trainer' = ANY(roles)

const ACCOUNT_ID = /^hwa_[a-z2-7]{26}$/;

export async function GET(request) {
  const limited = rateLimit(request, "diag-trainers-read", 20);
  if (limited) return noStore(limited);
  try {
    const gate = await requireAdminCeremony(request);
    if ("error" in gate) return noStore(gate.error);
    const list = await dbListApplications();
    if (!list) return json({ error: "Unavailable" }, 503);
    return json(list);
  } catch (e) {
    return noStore(serverError(e, { label: "diag-trainers-read" }));
  }
}

export async function POST(request) {
  const limited = rateLimit(request, "diag-trainers-decide", 20);
  if (limited) return noStore(limited);
  try {
    const gate = await requireAdminCeremony(request, { freshMs: BACKFILL_FRESH_MS });
    if ("error" in gate) return noStore(gate.error);
    const body = await request.json().catch(() => ({}));
    const { decision, accountId } = body && typeof body === "object" ? body : {};
    if ((decision !== "approve" && decision !== "deny") || typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
      return json({ error: "Not found" }, 404);
    }
    const now = Date.now();
    const done = decision === "approve" ? await dbApproveApplication(accountId, now) : await dbDenyApplication(accountId, now);
    if (done === null) return json({ error: "Unavailable" }, 503);
    if (!done) return json({ error: "Not found" }, 404);
    return json({ ok: true, status: decision === "approve" ? "approved" : "denied" });
  } catch (e) {
    return noStore(serverError(e, { label: "diag-trainers-decide" }));
  }
}
