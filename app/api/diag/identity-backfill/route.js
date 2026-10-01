import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { planIdentityBackfill } from "@/lib/identity-backfill";
import { gatherBackfillInputs, backfillLogLine } from "@/lib/identity-backfill-inputs";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// IDENTITY BACKFILL DRY-RUN — READ ONLY.
// GET /api/diag/identity-backfill   (Authorization: Bearer <CRON_SECRET>)
//
// The report the owner reads before apply: counts, rows (no public keys, no
// full credential ids) and the planHash apply must be given back. The same
// report is on /diag-sync for the signed-in admin (./admin). Not a cron.
// Imports no writer; asserted by tests/identity-backfill-routes.test.js.

export async function GET(request) {
  const limited = rateLimit(request, "diag-identity-backfill", 3);
  if (limited) return limited;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { db, input } = await gatherBackfillInputs(new Date().toISOString());
    const plan = planIdentityBackfill(input);
    console.log(backfillLogLine(plan));
    return NextResponse.json({ dryRun: true, writes: "none — enumeration, reads and SELECTs only", db, ...plan });
  } catch (e) {
    return NextResponse.json({ error: `backfill dry-run failed: ${e.message}` }, { status: 500 });
  }
}
