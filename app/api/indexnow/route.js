// app/api/indexnow/route.js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/indexnow   (Authorization: Bearer <CRON_SECRET>)
//
// Submits our published URLs to IndexNow from the deployment itself. Exists
// because the operator's laptop is not the only place this should be runnable
// from — and because a 187-URL payload is a miserable thing to paste into a
// terminal. From here it is one short request.
//
// Same list as the sitemap, so the two can never disagree about what we
// publish. Same auth as the other operator routes (Bearer CRON_SECRET, fails
// closed when unset) — this is an operator action, not a user one.
//
// WHY POST, AND WHY NOT A CRON:
//   · POST because it has an outward effect. A GET can be fired by a
//     prefetcher or a link scanner if the URL ever leaks; a POST behind a
//     bearer token cannot be triggered by accident.
//   · No cron, no build hook — deliberately, and there is a test that keeps
//     it that way. IndexNow is for URLs that CHANGED; re-submitting an
//     unchanged catalogue on a schedule is what earns a 429, and a scheduled
//     job making outward requests unattended is the standing-authority
//     pattern the house avoids. A human decides when the content moved.
//
// The key is public by design: Bing verifies ownership by fetching
// /<key>.txt, so it is not a credential and is not read from the environment.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import sitemap, { BASE } from "@/app/sitemap";

export const dynamic = "force-dynamic";

const KEY = "b918388220f54edba64cc5d31103d35e";
const ENDPOINT = "https://api.indexnow.org/IndexNow";

// IndexNow's status codes are specific; report them in words so a 202 isn't
// mistaken for a failure (it means "queued, key not yet validated" and is
// normal on a first submission).
const MEANING = {
  200: "accepted",
  202: "accepted — key file not yet validated; normal on a first submission",
  400: "bad request — malformed payload",
  403: "key rejected — the file at keyLocation does not match the key",
  422: "URLs do not belong to the host, or the key does not match the host",
  429: "too many requests — submitting more often than the content changes",
};

export async function POST(request) {
  // Ahead of the auth check, per the coverage class lock: an unauthenticated
  // caller must not get an unmetered oracle for whether CRON_SECRET is set.
  // Deliberately tight — IndexNow itself 429s a chatty submitter, so there is
  // no legitimate reason to call this more than a handful of times an hour.
  const limited = rateLimit(request, "indexnow", 5);
  if (limited) return limited;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const host = new URL(BASE).host;
  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get("dryRun") === "1";
  const onlyLibrary = searchParams.get("onlyLibrary") === "1";

  const urlList = sitemap()
    .map((e) => e.url)
    .filter((u) => (onlyLibrary ? u.includes("/library") : true));

  // A single foreign URL makes IndexNow reject the entire batch with a 422 —
  // cheaper to catch here than to decode from a status code.
  const foreign = urlList.filter((u) => new URL(u).host !== host);
  if (foreign.length) {
    return NextResponse.json({ error: "URLs outside the submitting host", foreign }, { status: 400 });
  }

  const payload = {
    host,
    key: KEY,
    keyLocation: `${BASE}/${KEY}.txt`,
    urlList,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, host, urls: urlList.length, keyLocation: payload.keyLocation, sample: urlList.slice(0, 5) });
  }

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[forge:indexnow]", e);
    return NextResponse.json({ error: "IndexNow unreachable", detail: String(e?.message || e) }, { status: 502 });
  }

  const body = await res.text().catch(() => "");
  const ok = res.status === 200 || res.status === 202;
  return NextResponse.json(
    {
      ok,
      status: res.status,
      meaning: MEANING[res.status] || "unexpected status",
      submitted: urlList.length,
      keyLocation: payload.keyLocation,
      ...(body ? { response: body.slice(0, 500) } : {}),
    },
    { status: ok ? 200 : 502 },
  );
}
