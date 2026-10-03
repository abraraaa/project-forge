import { rateLimit, rateLimitShared, failureGate } from "@/lib/rate-limit";
import { dbExpireToken } from "@/lib/db";
import { dbPrimaryHandle } from "@/lib/identity-store";
import { peekInvite, dbActiveTrainerGrant, dbApproveTrainer } from "@/lib/trainer-store";
import { acceptedShareConsentVersion, SHARE_CONSENT_VERSION } from "@/lib/trainer-terms";
import { publicName } from "@/lib/trainer-view";
import { freshCeremony, json, noStore } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

const HOUR_MS = 3_600_000;
const MISS = { error: "That code didn't work. Check it, or ask your trainer for a fresh one." };
const TOO_MANY = "Too many tries. Ask your trainer for a fresh code, then try again in an hour.";
const UNAVAILABLE = "Sharing is unavailable right now. Try again in a bit.";

// POST /api/share/approve  { code, authToken, profile, consent: { version }, replace? }
//   -> { ok, trainer: { name }, replaced: { name } | null }
// The client approves the trainer a code names, with a fresh heatwayve.app
// Face ID. What is shared is fixed by the consent version; any other key in
// the body is ignored. A current trainer is never replaced unless the client
// confirmed it (replace: true after a 409 { replaces }).
// Writes: the approve transaction (UPDATE trainer_invites used_at/grant_id;
// UPDATE oauth_grants revoked_at/revoked_by on the replaced grant; INSERT
// oauth_grants), one failure count per miss (rate_buckets, in place), and
// UPDATE auth_tokens.expires on the ceremony token after a success only.
export async function POST(request) {
  const limited = rateLimit(request, "share-approve", 10) || await rateLimitShared(request, "share-approve", 20);
  if (limited) return noStore(limited);
  try {
    const now = Date.now();
    const body = await request.json().catch(() => ({}));
    const { code, authToken, profile, consent, replace } = body && typeof body === "object" ? body : {};
    const c = await freshCeremony({ authToken, profile }, now);
    if ("fail" in c) return c.fail;
    const me = c.identity.accountId;

    // 10 misses an hour per signed-in client. Fails closed.
    const gate = await failureGate("share-approve-fail", me, 10, { windowMs: HOUR_MS, now, limited: TOO_MANY, unavailable: UNAVAILABLE });
    if (gate.blocked) return noStore(gate.blocked);
    const miss = async () => {
      try {
        await gate.strike();
      } catch {
        return json({ error: UNAVAILABLE }, 503);
      }
      return json(MISS, 404);
    };

    const hit = await peekInvite(code, now);
    if (!hit) return miss();
    if (hit.trainerId === me) return json({ self: true, error: "That's your own code." }, 409);
    const consentVersion = acceptedShareConsentVersion(consent);
    if (consentVersion !== SHARE_CONSENT_VERSION) {
      return json({ stale: true, error: "This page is out of date. Reload and try again." }, 400);
    }

    const current = await dbActiveTrainerGrant(me);
    const switching = !!current && current.trainerId !== hit.trainerId;
    const oldName = switching ? publicName(await dbPrimaryHandle(current.trainerId)) : null;
    if (switching && replace !== true) return json({ replaces: { name: oldName } }, 409);

    // A grant with the same trainer is renewed without asking; a different
    // one only after the client confirmed.
    const r = await dbApproveTrainer({
      hash: hit.hash, clientId: me, storageKey: c.identity.storageKey, credentialId: c.credentialId,
      consentVersion, replacing: current?.id ?? null,
    }, now);
    if (!r) throw new Error("share store unavailable");
    if ("conflict" in r) return json({ error: "Something changed. Try again." }, 409);
    if ("miss" in r) return miss();

    // The grant is live; the ceremony token dies with its 5-minute window if this UPDATE fails.
    try { await dbExpireToken(authToken); } catch (e) { console.error("[share-approve] expire ceremony token", e?.message || e); }
    return json({ ok: true, trainer: { name: hit.name }, replaced: switching ? { name: oldName } : null });
  } catch (e) {
    return noStore(serverError(e, { label: "share-approve" }));
  }
}
