import { NextResponse } from "next/server";
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
  // Auth: Bearer header, or ?key= for browser use (boss runs this from the
  // address bar, not a terminal). Acceptable for a READ-ONLY diag: the
  // operator-held secret grants no write path here, and HTTPS keeps the
  // query string off the wire in the clear.
  // Two accepted secrets: CRON_SECRET (machine path) or DIAG_KEY — a
  // separate operator-created var for browser use, because Vercel's
  // "Sensitive" flag makes CRON_SECRET unreadable after creation and the
  // boss shouldn't have to rotate a live cron secret just to read a diag.
  const cronSecret = process.env.CRON_SECRET;
  const diagKey = process.env.DIAG_KEY;
  const auth = request.headers.get("authorization") || "";
  const key = new URL(request.url).searchParams.get("key");
  const authorised =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (cronSecret && key === cronSecret) ||
    (diagKey && key === diagKey);
  if (!authorised) {
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
