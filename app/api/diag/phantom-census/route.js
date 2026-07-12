// app/api/diag/phantom-census/route.js
// ─────────────────────────────────────────────────────────────────────────────
// DRY-RUN census of phantom completion entries — READ-ONLY, deliberately.
// This route reports what a repair WOULD overwrite and changes nothing:
// the wipe protocol (CLAUDE.md) requires the boss to read the actual kill
// list from the real store before any destructive path exists. Note the
// imports: list + get only. There is no delete, no put, and no code path
// that acquires one here — the overwrite ships separately, gated on the
// census being read and approved.
//
// WHAT A PHANTOM IS: the retired legacy P.markDayDone write in the session-
// finalise path resolved the record's weekday in the CURRENT week at wall-
// clock time, so a session started Sunday and finished after midnight
// marked a dayDone date SIX DAYS in the future. Days._foldLegacy then
// minted that key into a full Day entry with completedType set — a day
// showing "complete" that the user never trained. The write is deleted and
// the fold now refuses future dates; entries already minted remain, and
// this census finds them.
//
// SIGNATURE — a Day entry is phantom-shaped when ALL of:
//   · completedType is set (it claims completion)
//   · sessionId is null    (no real session backs it)
//   · entry.date is ≥ 2 days AFTER updatedAt's date part — an entry
//     written before its own date happened. Impossible through the UI
//     (ticks are today-or-past, so updatedAt ≥ date); the straddle
//     phantom is written exactly +6 days ahead. The 2-day margin keeps
//     clear of the timezone edge where a legit tick just after local
//     midnight carries a UTC updatedAt dated the previous day.
//
// Legacy meta.dayDone keys (pre-cutover payloads, boolean-only, no
// timestamps) can only be judged against NOW: keys dated in the future
// are reported too.
//
// Auth: Bearer CRON_SECRET — same operator-configured secret as the sync
// self-test. Usage:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//        https://theforged.fit/api/diag/phantom-census
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
import { readJsonDirect } from "@/lib/blob-utils";

export const dynamic = "force-dynamic";

const DAY_MS = 86400000;

// Days between two ISO date strings (b - a), judged at UTC noon.
const daysAfter = (a, b) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const findings = [];
  let profilesScanned = 0;
  let entriesScanned = 0;

  // Walk every profile meta blob (cursor loop — list() paginates).
  let cursor;
  do {
    const page = await list({ prefix: "forge/profiles/", cursor });
    cursor = page.cursor;
    for (const blob of page.blobs) {
      if (!blob.pathname.endsWith("/meta.json")) continue;
      profilesScanned += 1;
      const profile = decodeURIComponent(
        blob.pathname.slice("forge/profiles/".length, -"/meta.json".length),
      );
      const meta = await readJsonDirect(blob.pathname);
      if (!meta) continue;

      // Day-entity phantoms.
      for (const [date, entry] of Object.entries(meta.days || {})) {
        if (!entry || typeof entry !== "object" || !ISO_DATE.test(date)) continue;
        entriesScanned += 1;
        if (!entry.completedType || entry.sessionId) continue;
        const writtenDate = String(entry.updatedAt || "").slice(0, 10);
        if (!ISO_DATE.test(writtenDate)) continue;
        if (daysAfter(writtenDate, date) >= 2) {
          findings.push({
            profile,
            store: "days",
            date,
            entry, // full fields — the boss reads the real record, not a summary
            wouldOverwrite: { completedType: null },
          });
        }
      }

      // Legacy dayDone phantoms (boolean-only — future-dated keys only).
      for (const [date, done] of Object.entries(meta.dayDone || {})) {
        if (!done || !ISO_DATE.test(date)) continue;
        if (date > todayIso) {
          findings.push({ profile, store: "legacy dayDone", date, entry: { [date]: done } });
        }
      }
    }
  } while (cursor);

  return NextResponse.json({
    dryRun: true,
    generatedAt: new Date().toISOString(),
    profilesScanned,
    daysEntriesScanned: entriesScanned,
    phantoms: findings.length,
    findings,
  });
}
