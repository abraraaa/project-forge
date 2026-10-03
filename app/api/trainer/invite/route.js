import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { trainerOpenFor } from "@/lib/auth-server";
import { entitled } from "@/lib/entitlements";
import { issueInvite, dbCancelInvite, dbInviteStatus } from "@/lib/trainer-store";
import { trainerGate, json, noStore, setTrainerCookie } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

const HOUR_MS = 3_600_000;

/** Carry the gate's daily slide, if any, on whatever the route answers. */
const slid = (gate, res) => (gate.refresh ? setTrainerCookie(res, gate.refresh) : res);

// GET /api/trainer/invite -> { status: none|pending|used|expired, expiresAt, usedBy? }
// The invite sheet polls this every few seconds. Reads only.
export async function GET(request) {
  const limited = rateLimit(request, "trainer-invite-status", 60);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    const status = (await dbInviteStatus(g.identity.accountId)) ?? { status: "none", expiresAt: null };
    return slid(g, json(status));
  } catch (e) {
    return noStore(serverError(e, { label: "trainer-invite" }));
  }
}

// POST /api/trainer/invite
//   { action: "issue" }  -> { code, expiresAt }. The code is in this response only;
//                           the trainer's slot is overwritten in place and the old code dies.
//   { action: "cancel" } -> { ok }. Ends a pending code by UPDATE expires_at.
export async function POST(request) {
  const limited = rateLimit(request, "trainer-invite", 10);
  if (limited) return noStore(limited);
  try {
    const g = await trainerGate(request);
    if ("fail" in g) return g.fail;
    const me = g.identity.accountId;
    const shared = await rateLimitShared(request, "trainer-invite", 30, { windowMs: HOUR_MS, id: me });
    if (shared) return slid(g, noStore(shared));
    if (!entitled(g.account, "trainer.invite")) return slid(g, json({ notTrainer: true }, 403));
    if (!trainerOpenFor(g.identity)) return slid(g, json({ error: "Not open yet." }, 503));

    const body = await request.json().catch(() => ({}));
    const action = body && typeof body === "object" ? body.action : undefined;
    if (action === "issue") {
      const issued = await issueInvite(me);
      if (!issued) throw new Error("invite store unavailable");
      return slid(g, json({ code: issued.code, expiresAt: issued.expiresAt }));
    }
    if (action === "cancel") {
      await dbCancelInvite(me);
      return slid(g, json({ ok: true }));
    }
    return slid(g, json({ error: "Unknown action" }, 400));
  } catch (e) {
    return noStore(serverError(e, { label: "trainer-invite" }));
  }
}
