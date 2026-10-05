import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { dbExpireToken } from "@/lib/db";
import { entitled } from "@/lib/entitlements";
import { dbApplyTrainer, dbOpenApplicationCount, dbTrainerApplication } from "@/lib/trainer-store";
import { acceptedTrainerTermsVersion, TRAINER_LIVE, TRAINER_TERMS_VERSION } from "@/lib/trainer-terms";
import { APPLY_BODY_MAX, APPLY_COPY, applyBlock, cleanAbout, cleanLink, queueFull } from "@/lib/trainer-apply";
import { freshCeremony, json, noStore } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// POST /api/trainer/apply  { authToken, profile, about, link?, terms: { version }, adult: true }
//   -> { ok, status: "applied" }
// A fresh heatwayve.app Face ID, 18+ and the current Trainer Terms send an
// application to coach; the admin decides at /diag-trainers. Closed until
// launch (the admin self-grants through /api/trainer/upgrade).
export async function POST(request) {
  const limited = rateLimit(request, "trainer-apply", 5) || await rateLimitShared(request, "trainer-apply", 10);
  if (limited) return noStore(limited);
  try {
    if (!TRAINER_LIVE) return json({ error: APPLY_COPY.notOpen }, 503);
    // Measured before parsing, as bug reports are.
    const raw = await request.text();
    if (raw.length > APPLY_BODY_MAX) return json({ error: APPLY_COPY.aboutLong }, 400);
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const { authToken, profile, about, link, terms, adult } = body && typeof body === "object" ? body : {};
    const c = await freshCeremony({ authToken, profile });
    if ("fail" in c) return c.fail;
    if (entitled(c.account, "trainer.dashboard")) return json({ trainer: true }, 403);
    const version = acceptedTrainerTermsVersion(terms);
    if (version !== TRAINER_TERMS_VERSION || adult !== true) {
      return json({ error: "Accept the Trainer Terms to continue." }, 400);
    }
    const a = cleanAbout(about);
    if ("error" in a) return json({ error: a.error }, 400);
    const l = cleanLink(link);
    if ("error" in l) return json({ error: l.error }, 400);

    const now = Date.now();
    const blocked = applyBlock(await dbTrainerApplication(c.identity.accountId), now);
    if (blocked) return json(blocked, 409);
    const open = await dbOpenApplicationCount();
    if (open === null) return json({ error: "Unavailable" }, 503);
    if (queueFull(open)) return json({ error: APPLY_COPY.paused }, 503);

    // Writes: INSERT trainer_applications, or the named overwrite of the
    // caller's own withdrawn or long-denied row; then UPDATE
    // auth_tokens.expires on the ceremony token.
    const written = await dbApplyTrainer(c.identity.accountId,
      { about: a.about, link: l.link, terms: { version, at: new Date(now).toISOString(), adult: true } }, now);
    if (!written) {
      // Another request got there first.
      return json(applyBlock(await dbTrainerApplication(c.identity.accountId), now) || { status: "applied" }, 409);
    }
    await dbExpireToken(authToken);
    return json({ ok: true, status: "applied" });
  } catch (e) {
    return noStore(serverError(e, { label: "trainer-apply" }));
  }
}
