// scripts/indexnow.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Submit our published URLs to IndexNow.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: ChatGPT, Copilot and Meta AI retrieve
// through Bing's index (Vercel's LLM-search runbook, 2026). IndexNow is the
// push channel into that index — new library pages land in hours instead of
// waiting for a crawl. It is the highest-leverage lever we have on AI search.
//
// DELIBERATE, NOT AUTOMATIC. This is not wired into postbuild and there is no
// cron for it. Two reasons:
//   1. IndexNow is for URLs that CHANGED. Re-submitting 172 unchanged pages on
//      every deploy is freshness-stuffing — the same dishonesty we refused
//      when we declined to stamp sitemap lastmod from build time — and it is
//      what earns a 429.
//   2. The house rule against standing authority: a scheduled job that fires
//      outward requests unattended is a thing that misfires later, quietly.
// Run it when you bump LIBRARY_REVISED. That constant IS the "content
// changed" signal, so the two go together.
//
//   npm run indexnow -- --dry-run     # print the payload, send nothing
//   npm run indexnow                  # submit
//   npm run indexnow -- --only-library
//
// THE KEY IS PUBLIC BY DESIGN. IndexNow verifies ownership by fetching
// https://heatwayve.app/<key>.txt, so the value lives in the repo on purpose.
// It is not a credential and must not be treated as one.
// ─────────────────────────────────────────────────────────────────────────────

import sitemap, { BASE } from "../app/sitemap.js";

const KEY = "b918388220f54edba64cc5d31103d35e";
const HOST = new URL(BASE).host;                       // heatwayve.app
const KEY_LOCATION = `${BASE}/${KEY}.txt`;
const ENDPOINT = "https://api.indexnow.org/IndexNow";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const onlyLibrary = args.has("--only-library");

const urlList = sitemap()
  .map((e) => e.url)
  .filter((u) => (onlyLibrary ? u.includes("/library") : true));

// Every URL must be on the host we're claiming, or IndexNow rejects the whole
// batch with a 422. Cheaper to catch here than to read it in a response code.
const foreign = urlList.filter((u) => new URL(u).host !== HOST);
if (foreign.length) {
  console.error(`[indexnow] ${foreign.length} URL(s) are not on ${HOST}:\n${foreign.join("\n")}`);
  process.exit(1);
}

const payload = { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList };

console.log(`[indexnow] host=${HOST} urls=${urlList.length} keyLocation=${KEY_LOCATION}`);
if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  console.log("[indexnow] dry run — nothing sent.");
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(payload),
});

// IndexNow's codes are specific and worth reading back plainly rather than
// dumping a status number: 200 accepted, 202 accepted but the key file has
// not been verified yet, 403 key rejected, 422 URLs don't match the host,
// 429 submitting too often.
const meaning = {
  200: "accepted",
  202: "accepted — key file not yet validated (check it is reachable at keyLocation)",
  400: "bad request — malformed payload",
  403: "key rejected — the file at keyLocation does not match the key",
  422: "URLs do not belong to the host, or the key does not match the host",
  429: "too many requests — submitting more often than the content changes",
};
const note = meaning[res.status] || "unexpected status";
const body = await res.text().catch(() => "");

console.log(`[indexnow] ${res.status} ${note}${body ? ` · ${body.slice(0, 300)}` : ""}`);
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
