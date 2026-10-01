import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { planIdentityBackfill } from "@/lib/identity-backfill";
import { gatherBackfillInputs, backfillLogLine, requireAdminCeremony } from "@/lib/identity-backfill-inputs";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// IDENTITY BACKFILL DRY-RUN, OWNER VIEW — READ ONLY.
// GET /api/diag/identity-backfill/admin   (X-HW-Auth: <passkey ceremony token>)
//
// The same report as the CRON_SECRET route, for the admin signed in on
// /diag-sync. Gate: a full-scope ceremony token held by ADMIN_PROFILE (fails
// closed when that is unset). `applyEnabled` tells the page whether to offer
// apply. Imports no writer; asserted by tests/identity-backfill-routes.test.js.

export async function GET(request) {
  const limited = rateLimit(request, "diag-identity-backfill-admin", 3);
  if (limited) return limited;

  const gate = await requireAdminCeremony(request);
  if ("error" in gate) return gate.error;

  try {
    const { db, input } = await gatherBackfillInputs(new Date().toISOString());
    const plan = planIdentityBackfill(input);
    console.log(backfillLogLine(plan));
    return NextResponse.json({
      dryRun: true,
      writes: "none — enumeration, reads and SELECTs only",
      db,
      applyEnabled: process.env.IDENTITY_BACKFILL_APPLY === "1",
      ...plan,
    });
  } catch (e) {
    return NextResponse.json({ error: `backfill dry-run failed: ${e.message}` }, { status: 500 });
  }
}
