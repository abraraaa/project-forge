// app/api/cron/cleanup/route.js
// ─────────────────────────────────────────────────────────────────────────────
// Scheduled cleanup of orphaned blobs in the forge/profiles/ namespace.
// Triggered by Vercel Cron Jobs (see vercel.json) — runs daily at 03:00 UTC.
//
// Why this exists:
// Pre-migration, the API used `addRandomSuffix: true` on every PUT, which
// appended a random suffix to each blob URL. The cleanup-before-write logic
// in route.js attempted to delete old blobs before each new write, but races
// and silent failures meant blobs accumulated over time — beta testers saw
// "dozens of files per user" instead of the expected 2 (meta.json + history.json).
//
// Post-migration (allowOverwrite: true), every write goes to the deterministic
// path and overwrites in place. This cron is the safety net that cleans up
// any suffixed legacy blobs left over from the pre-migration era. Once all
// legacy data is gone, this cron is a no-op — but it stays as defence-in-depth.
//
// Auth: Bearer CRON_SECRET — a user-configured env var that Vercel attaches
// to cron-triggered requests (it is NOT auto-generated; the job fails loud
// until the operator sets it). Manual invocations without it are rejected.
//
// Cost shape: list() is paginated 250-per-call; del() supports batch delete.
// At realistic scale (~10 users × ~2 canonical blobs + occasional legacy
// orphans), single-digit calls per run.
// ─────────────────────────────────────────────────────────────────────────────

import { list, del } from "@vercel/blob";
import { NextResponse } from "next/server";

// Deletion is ALLOW-LISTED TO KNOWN GARBAGE, never "anything unexpected".
// The previous model deleted every blob whose basename wasn't meta.json /
// history.json — and on the first night CRON_SECRET was configured
// (2026-07-09) that wiped every profile's credentials.json, i.e. all
// registered passkeys, because the canonical set predated WebAuthn and was
// never updated. A cleanup job must enumerate the garbage it was built to
// remove; an unknown basename is someone's data and gets KEPT.
//
// The only known garbage: suffixed meta/history blobs from the
// addRandomSuffix era (same shapes app/api/sync/route.js migrates from).
const LEGACY_ORPHAN_RES = [/\/meta-[^/]+\.json$/, /\/history-[^/]+\.json$/];
export const isLegacyOrphan = (pathname) => LEGACY_ORPHAN_RES.some((re) => re.test(pathname));

export async function GET(request) {
  // ── Auth: require Bearer CRON_SECRET ────────────────────────────────────
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // No CRON_SECRET configured — fail loud so operators notice. The env
    // var must be set by the operator (Vercel attaches it to cron requests
    // but never generates it); missing means misconfigured project.
    console.error("[forge:cron-cleanup] CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const stats = { scanned: 0, kept: 0, deleted: 0, errors: 0 };
  const deletedPaths = []; // collected for the response, capped to avoid huge JSON
  const MAX_DELETED_REPORTED = 50;

  try {
    let cursor;

    do {
      const result = await list({
        prefix: "forge/profiles/",
        cursor,
        limit: 250,
      });

      stats.scanned += result.blobs.length;

      // Only blobs matching the known legacy-orphan shapes are deletable.
      // Everything else — canonical files, credentials.json, anything a
      // future feature writes — is kept unconditionally.
      const orphans = result.blobs.filter(b => isLegacyOrphan(b.pathname));

      stats.kept += result.blobs.length - orphans.length;

      // Batch delete orphans. del() accepts an array of URLs.
      if (orphans.length > 0) {
        try {
          await del(orphans.map(b => b.url));
          stats.deleted += orphans.length;
          // Collect a sample of deleted paths for the response (capped)
          for (const o of orphans) {
            if (deletedPaths.length < MAX_DELETED_REPORTED) {
              deletedPaths.push(o.pathname);
            }
          }
        } catch (e) {
          console.error("[forge:cron-cleanup] del() failed for batch", e?.message || e);
          stats.errors += orphans.length;
        }
      }

      cursor = result.cursor;
    } while (cursor);

    const elapsedMs = Date.now() - startedAt;
    console.log(`[forge:cron-cleanup] complete in ${elapsedMs}ms`, stats);

    return NextResponse.json({
      ok: true,
      elapsedMs,
      ...stats,
      // Truncate deletedPaths in response if there were many
      deletedSample: deletedPaths,
      truncated: stats.deleted > deletedPaths.length,
    });
  } catch (e) {
    console.error("[forge:cron-cleanup] fatal", e);
    return NextResponse.json(
      { error: e.message || "cleanup failed", ...stats },
      { status: 500 }
    );
  }
}
