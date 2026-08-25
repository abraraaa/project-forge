import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { list } from "@vercel/blob";
import { readJsonDirect } from "@/lib/blob-utils";
import { censusPasskeys, photosAtRisk, censusLogLine } from "@/lib/passkey-census";

// PASSKEY CENSUS — READ ONLY.
// GET /api/diag/passkey-census   (Authorization: Bearer <CRON_SECRET>)
//
// Imports no writer; asserted by tests/passkey-census.test.js. Gated as
// /api/diag/db-import is — a whole-namespace enumeration, and profile name is
// the identity. Fails closed when CRON_SECRET is unset.

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export async function GET(request) {
  // Whole-store enumeration plus a read per profile.
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
        // Photos, counted not read — this pass already walks the namespace.
        const ph = b.pathname.match(/^forge\/profiles\/([^/]+)\/photos\/[^/]+$/);
        if (ph) photos.push({ profile: decode(ph[1]), pathname: b.pathname, size: b.size || 0 });
      }
      cursor = page.cursor;
    } while (cursor);
  } catch (e) {
    return NextResponse.json({ error: `credential census failed: ${e.message}` }, { status: 500 });
  }

  // Only the newest doc per profile — the one a real ceremony resolves.
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
  console.log(censusLogLine(census, photoExposure));
  return NextResponse.json({
    dryRun: true,
    writes: "none — enumeration and reads only",
    scanned: { prefix: "forge/profiles/", matched: ["credentials*.json", "photos/*"] },
    ...census,
    photoExposure,
  });
}
