// app/api/cron/sync-selftest/route.js
// ─────────────────────────────────────────────────────────────────────────────
// Nightly sync round-trip self-test — runs INSIDE Vercel, where
// BLOB_READ_WRITE_TOKEN already lives, so the credential is never copied
// into a second tool (this replaced a GitHub Actions nightly that needed a
// hand-synced secret — the copy was the bug: it goes stale the moment
// Vercel rotates the token or you paste from the wrong store).
//
// It exercises the REAL sync handlers (app/api/sync/route.js) against the
// REAL Blob store — the addRandomSuffix class of bug (writer + reader agree
// on a broken path, everything 200s, cross-device returns empty) is
// invisible to the unit suite and only a live PUT-then-GET catches it.
// Writes under a unique throwaway profile and deletes it in `finally`.
//
// Auth: Bearer CRON_SECRET — a user-configured env var that Vercel attaches
// to cron-triggered requests (it is NOT auto-generated; the job fails loud
// until the operator sets it). Visibility: Vercel cron logs + monitoring;
// a failing run returns 500 with the failed check names and logs them.
//
// Triggered by Vercel Cron (see vercel.json), daily. No GitHub involvement.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { GET as syncGET, PUT as syncPUT, POST as syncPOST, DELETE as syncDELETE } from "@/app/api/sync/route";

// Host is irrelevant — the handlers only parse the URL's search params.
const BASE = "https://theforged.fit/api/sync";
const getReq  = (params) => new Request(`${BASE}?${new URLSearchParams(params)}`);
const jsonReq = (method, body) => new Request(BASE, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[forge:cron-selftest] CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Unique per run so concurrent/retried runs never collide with each other
  // or a real profile. Passes validateProfile (no path seps / control chars).
  const profile = `selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: !!ok });

  try {
    check("unwritten profile GET 404s", (await syncGET(getReq({ profile }))).status === 404);

    const before = await (await syncGET(getReq({ profile, check: "1" }))).json();
    check("check=1 free before claim", before.exists === false);
    check("POST claims the name", (await syncPOST(jsonReq("POST", { profile, displayName: profile }))).status === 200);
    check("re-claim 409s", (await syncPOST(jsonReq("POST", { profile, displayName: profile }))).status === 409);

    const meta = { displayName: profile, weights: { "Hex Bar Deadlift": 110 }, reps: {}, streak: { count: 3, lastDate: "2026-07-04" } };
    const history = [{ id: "2026-07-01T10:00:00.000Z", date: "2026-07-01", type: "strength" }];
    check("PUT returns 200", (await syncPUT(jsonReq("PUT", { profile, data: { meta, history } }))).status === 200);

    const got = await (await syncGET(getReq({ profile }))).json();
    check("GET round-trips meta exactly", got?.meta?.weights?.["Hex Bar Deadlift"] === 110);
    check("GET round-trips history", Array.isArray(got?.history) && got.history.length === 1);

    const upper = await (await syncGET(getReq({ profile: profile.toUpperCase() }))).json();
    check("case-insensitive resolution", upper?.meta?.displayName === profile);

    const merged = await (await syncPUT(jsonReq("PUT", { profile, data: { history: [
      { id: "2026-07-01T10:00:00.000Z", date: "2026-07-01", type: "strength" }, // dup id
      { id: "2026-07-05T10:00:00.000Z", date: "2026-07-05", type: "strength" }, // new
    ] } }))).json();
    check("history merges by id (no clobber, no dup)", merged?.history?.count === 2);

    // Server-side META merge (sync audit S3): a second PUT carrying a
    // PARTIAL meta payload — the S1 bug class — must not delete fields the
    // blob already holds. Before the fix this overwrote meta wholesale.
    const dayKey = "2026-07-02";
    await syncPUT(jsonReq("PUT", { profile, data: { meta: {
      ...meta,
      days: { [dayKey]: { date: dayKey, scheduledType: "cardio", completedType: "cardio", sessionId: null, marks: {}, updatedAt: new Date().toISOString() } },
    } } }));
    await syncPUT(jsonReq("PUT", { profile, data: { meta: { weights: { "Hex Bar Deadlift": 112.5 }, reps: {}, streak: { count: 3, lastDate: "2026-07-04" }, programmeBlock: { number: 1 } } } }));
    const afterPartial = await (await syncGET(getReq({ profile }))).json();
    check("partial meta PUT merges — existing days survive", afterPartial?.meta?.days?.[dayKey]?.completedType === "cardio");
    check("partial meta PUT merges — incoming change lands", afterPartial?.meta?.weights?.["Hex Bar Deadlift"] === 112.5);
  } catch (e) {
    check(`threw: ${e?.message || e}`, false);
  } finally {
    // Always release the throwaway profile — no passkey, so no authToken needed.
    try { await syncDELETE(getReq({ profile })); } catch { /* best effort */ }
  }

  const failures = checks.filter((c) => !c.ok).map((c) => c.name);
  const ok = failures.length === 0;
  if (!ok) console.error("[forge:cron-selftest] FAILURES:", failures.join(" | "));
  return NextResponse.json({ ok, profile, checks, failures }, { status: ok ? 200 : 500 });
}
