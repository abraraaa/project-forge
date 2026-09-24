import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { list } from "@vercel/blob";
import { sql } from "@/lib/db";
import { censusNameKeys } from "@/lib/name-census";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// NAME-KEY CENSUS — READ ONLY.
// GET /api/diag/name-census   (Authorization: Bearer <CRON_SECRET>; run 2026-09-24: divergent=0)
//
// Lists stored profile keys whose NFKC form differs from the key itself —
// the keys a shared name normaliser would move. Blob directory names under
// forge/profiles/ plus DISTINCT profile from each table; SELECTs only.
// Imports no writer; asserted by tests/name-census.test.js.

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export async function GET(request) {
  const limited = rateLimit(request, "diag-name-census", 3);
  if (limited) return limited;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /** @type {{ source: string, key: string }[]} */
  const entries = [];
  try {
    const dirs = new Set();
    let cursor;
    do {
      const page = await list({ prefix: "forge/profiles/", cursor, limit: 1000 });
      for (const b of page.blobs) {
        const m = b.pathname.match(/^forge\/profiles\/([^/]+)\//);
        if (m) dirs.add(decode(m[1]));
      }
      cursor = page.cursor;
    } while (cursor);
    for (const key of dirs) entries.push({ source: "blob", key });
  } catch (e) {
    return NextResponse.json({ error: `blob census failed: ${e.message}` }, { status: 500 });
  }

  const q = sql();
  if (q) {
    try {
      /** @type {[string, any[]][]} */
      const tables = [
        ["sessions", await q`SELECT DISTINCT profile FROM sessions`],
        ["meta", await q`SELECT DISTINCT profile FROM meta`],
        ["photos", await q`SELECT DISTINCT profile FROM photos`],
        ["auth_tokens", await q`SELECT DISTINCT profile FROM auth_tokens`],
      ];
      for (const [source, rows] of tables) {
        for (const r of rows) if (r.profile) entries.push({ source, key: String(r.profile) });
      }
    } catch (e) {
      return NextResponse.json({ error: `db census failed: ${e.message}` }, { status: 500 });
    }
  }

  const census = censusNameKeys(entries);
  // Vercel Cron calls this daily with the secret, so the log line is the
  // report: counts, plus the divergent keys only (usually none).
  console.log(`[forge:name-census] scanned=${census.scanned} distinct=${census.distinct} divergent=${census.divergent.length}` +
    census.divergent.map((d) => ` | ${JSON.stringify(d.key)}→${JSON.stringify(d.canonical)} [${d.sources.join(",")}]`).join(""));
  return NextResponse.json({ dryRun: true, writes: "none — enumeration and SELECTs only", db: !!q, ...census });
}
