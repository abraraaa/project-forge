import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { list } from "@vercel/blob";
import { readJsonDirect } from "@/lib/blob-utils";
import { censusPasskeys, photosAtRisk, censusLogLine } from "@/lib/passkey-census";

// PASSKEY CENSUS — READ ONLY, by design and by protocol.
// GET /api/diag/passkey-census   (Authorization: Bearer <CRON_SECRET>)
//
// Wipe-protocol step 2 for the credential store: before any re-enrolment or
// cleanup work is designed, read the REAL store and report what is actually
// there. This route lists and reads. It imports no writer — no put, no del —
// and that absence is asserted by tests/passkey-census.test.js, because the
// 2026-07-09 incident was a read-shaped job that had grown teeth.
//
// Gated exactly as /api/diag/db-import is, and for the same reason: this is a
// WHOLE-NAMESPACE enumeration, and profile name IS the identity here, so an
// open census would hand over every user's key at once. Fails closed when
// CRON_SECRET is unset.
//
// The counting lives in lib/passkey-census.js (pure, tested). This file is
// only the gate and the I/O.

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export async function GET(request) {
  // Whole-store enumeration plus a read per profile — the most expensive
  // request in the app. Throttle harder than the blob census.
  const limited = rateLimit(request, "diag-passkey-census", 3);
  if (limited) return limited;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Enumerate credential blobs only — prefix-scoped to forge/profiles/, then
  // matched on the credentials filename the auth routes write. Nothing else
  // in the namespace is touched or reported.
  const found = [];
  const photos = [];
  let cursor;
  try {
    do {
      const page = await list({ prefix: "forge/profiles/", cursor, limit: 1000 });
      for (const b of page.blobs) {
        const m = b.pathname.match(/^forge\/profiles\/([^/]+)\/credentials[^/]*\.json$/);
        if (m) {
          found.push({
            profile: decode(m[1]),
            pathname: b.pathname,
            // The SDK hands back a Date; the census works in ISO strings so the
            // report is JSON-stable and the pure function stays string-only.
            uploadedAt: b.uploadedAt ? new Date(b.uploadedAt).toISOString() : "",
            size: b.size || 0,
            doc: null,
          });
          continue;
        }
        // Progress photos, for the sunset kill list. Enumerated here because
        // this pass is already walking the namespace — no extra listing, and
        // no read: a photo's bytes are never opened, only counted.
        const ph = b.pathname.match(/^forge\/profiles\/([^/]+)\/photos\/[^/]+$/);
        if (ph) photos.push({ profile: decode(ph[1]), pathname: b.pathname, size: b.size || 0 });
      }
      cursor = page.cursor;
    } while (cursor);
  } catch (e) {
    return NextResponse.json({ error: `credential census failed: ${e.message}` }, { status: 500 });
  }

  // Read ONLY the authoritative document per profile — the newest, which is
  // the one readJsonByPrefix resolves for a real ceremony. Older siblings are
  // counted as strays without being read: they are invisible to auth, so
  // reading them would cost a request per stray to report a number that means
  // nothing.
  const newest = new Map();
  for (const f of found) {
    const t = Date.parse(f.uploadedAt || "") || 0;
    const cur = newest.get(f.profile);
    if (!cur || t >= cur.t) newest.set(f.profile, { f, t });
  }
  for (const { f } of newest.values()) {
    f.doc = await readJsonDirect(f.pathname);
  }

  const census = censusPasskeys(found);
  const photoExposure = photosAtRisk(census, photos);
  // Aggregates to the runtime log on every run, so the daily cron leaves a
  // readable time series without anyone opening a dashboard. Names never go
  // here — see censusLogLine.
  console.log(censusLogLine(census, photoExposure));
  return NextResponse.json({
    dryRun: true,
    writes: "none — enumeration and reads only",
    scanned: { prefix: "forge/profiles/", matched: ["credentials*.json", "photos/*"] },
    ...census,
    // What a sunset photo wipe WOULD remove. Reported, never executed: no
    // delete path exists yet, and per protocol it does not get written until
    // these numbers have been read off the real store.
    photoExposure,
  });
}
