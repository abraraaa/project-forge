import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { list } from "@vercel/blob";
import { readJsonDirect } from "@/lib/blob-utils";
import { probeDb } from "@/lib/db";

// DRY-RUN import report — READ ONLY, by design and by protocol.
// GET /api/diag/db-import   (Authorization: Bearer <CRON_SECRET>)
//
// Wipe-protocol step 1 for the blob→Neon migration: before any import code
// exists, the boss reads from the REAL store what the import WOULD insert.
// This route: (a) probes DB connectivity (SELECT version() — no DDL, no
// writes, no tables), (b) censuses the blob store per profile, (c) reports
// proposed row counts. It deletes nothing, creates nothing, writes nothing.

export async function GET(request) {
  // Whole-store census = the most expensive read in the app; throttle hard.
  const limited = rateLimit(request, "diag-census", 5);
  if (limited) return limited;
  // GATED 2026-07-26 (deep audit). The previous "deliberately ungated"
  // decision (2026-07-19) rested on audit #20/#21 — "no sensitive data" —
  // and that ruling carried its own expiry: *revisit if the data model
  // gains something private*. It has. Progress photos landed 2026-07-21
  // and the bodyweight journal rides sync meta.
  //
  // The decisive point is not what one profile's report reveals, though —
  // it is that this is the only route in the app that enumerates the WHOLE
  // namespace. Profile name IS the identity here, so a census hands over
  // every user's key at once; that is categorically different from serving
  // one already-known name, which is what the open-reads doctrine actually
  // licenses. Read-only by construction (no DDL, no writes, no deletes),
  // so the risk was always disclosure — but disclosure of the target list
  // is the precondition for every other attack on an open-read system.
  //
  // Fails closed when CRON_SECRET is unset, matching the cron routes: an
  // unconfigured deployment refuses rather than opens.
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await probeDb();

  // Census: every blob under forge/profiles/, grouped by profile dir.
  const profiles = {};
  let cursor;
  let totalBlobs = 0;
  try {
    do {
      const page = await list({ prefix: "forge/profiles/", cursor, limit: 1000 });
      for (const b of page.blobs) {
        totalBlobs++;
        const m = b.pathname.match(/^forge\/profiles\/([^/]+)\/(.+)$/);
        if (!m) continue;
        const [, prof, rest] = m;
        (profiles[prof] ||= { files: [], bytes: 0 }).files.push(rest);
        profiles[prof].bytes += b.size || 0;
      }
      cursor = page.cursor;
    } while (cursor);
  } catch (e) {
    return NextResponse.json({ db, error: `blob census failed: ${e.message}` }, { status: 500 });
  }

  // Per-profile proposed rows: history.json → sessions rows; meta.json →
  // meta field rows; credentials stay on blob (out of scope v1).
  const report = {};
  for (const [prof, info] of Object.entries(profiles)) {
    const entry = {
      blobFiles: info.files.sort(),
      blobBytes: info.bytes,
      proposed: { sessionRows: 0, metaFieldRows: 0 },
      notes: [],
    };
    if (info.files.includes("history.json")) {
      const hist = await readJsonDirect(`forge/profiles/${prof}/history.json`);
      if (Array.isArray(hist)) {
        entry.proposed.sessionRows = hist.length;
        const noId = hist.filter((r) => !r?.id).length;
        if (noId) entry.notes.push(`${noId} records missing id — would be skipped`);
      } else {
        entry.notes.push("history.json unreadable");
      }
    }
    if (info.files.includes("meta.json")) {
      const meta = await readJsonDirect(`forge/profiles/${prof}/meta.json`);
      if (meta && typeof meta === "object") {
        entry.proposed.metaFieldRows = Object.keys(meta).length;
        entry.metaFields = Object.keys(meta).sort();
      } else {
        entry.notes.push("meta.json unreadable");
      }
    }
    const legacy = info.files.filter((f) => /^(meta|history)-[^/]+\.json$/.test(f));
    if (legacy.length) entry.notes.push(`${legacy.length} legacy suffixed blobs (inert, not imported)`);
    report[prof] = entry;
  }

  return NextResponse.json({
    dryRun: true,
    writes: "none — census + connectivity probe only",
    db,
    totals: {
      profiles: Object.keys(report).length,
      blobs: totalBlobs,
      proposedSessionRows: Object.values(report).reduce((n, e) => n + e.proposed.sessionRows, 0),
      proposedMetaFieldRows: Object.values(report).reduce((n, e) => n + e.proposed.metaFieldRows, 0),
    },
    profiles: report,
  });
}
