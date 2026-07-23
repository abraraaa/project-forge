// app/api/cron/sync-snapshot/route.js
// ─────────────────────────────────────────────────────────────────────────────
// Daily blob snapshot of every DB profile (PR C — docs/delta-sync.md).
//
// WRITE-ONLY BY CONSTRUCTION. This job holds zero delete authority — no
// delete calls, no sweeping, ever (wipe protocol rule 4: a scheduled job with
// delete permissions is a wipe waiting for a config change to arm it; the
// 2026-07-09 incident is why). Two deterministic generations per profile,
// overwrite-in-place, so nothing accumulates and nothing ever needs
// cleaning:
//
//   forge/snapshots/daily/<profile>.json    — overwritten every run (≤24h)
//   forge/snapshots/weekly/<profile>.json   — overwritten on Sundays (≤7d)
//
// Purpose: a restore point for the disaster class where we somehow bypass
// every control and issue an invasive wipe against the DB (boss, 2026-07-25:
// Neon is durable enough; the blob snap exists for the unlubed-peg
// scenario). Snapshot blobs for a wiped profile are removed by the
// user-initiated profile DELETE (enumerated exact paths there), never here.
//
// Auth: Bearer CRON_SECRET, same contract as sync-selftest.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { hasDb, sql, ensureSchema, dbReadProfile } from "@/lib/db";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[forge:cron-snapshot] CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasDb()) {
    return NextResponse.json({ error: "No DB configured" }, { status: 500 });
  }

  try {
    const q = sql();
    await ensureSchema(q);
    const rows = await q`SELECT profile FROM meta UNION SELECT profile FROM sessions`;
    const profiles = [...new Set(rows.map((r) => r.profile))];
    // Weekly generation refreshes on Sundays (UTC — cadence, not user data;
    // the lib/dates local-day doctrine governs user-facing calendar math).
    const isWeeklyDay = new Date().getUTCDay() === 0;

    const written = [];
    for (const profile of profiles) {
      const data = await dbReadProfile(profile);
      if (!data) continue;
      const body = JSON.stringify({
        profile,
        snappedAt: new Date().toISOString(),
        meta: data.meta,
        history: data.history,
      });
      await put(`forge/snapshots/daily/${encodeURIComponent(profile)}.json`, body,
        { access: "private", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false });
      if (isWeeklyDay) {
        await put(`forge/snapshots/weekly/${encodeURIComponent(profile)}.json`, body,
          { access: "private", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false });
      }
      written.push(profile);
    }
    return NextResponse.json({ ok: true, profiles: written.length, weekly: isWeeklyDay });
  } catch (e) {
    console.error("[forge:cron-snapshot] FAILED:", e?.message || e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
