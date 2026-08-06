// scripts/verify-videos.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Prove candidate YouTube ids exist before they touch the dataset. Candidate
// batches arrive from an LLM video-sourcing pass, and LLM-supplied ids are
// exactly the kind of data that arrives half-real — a dead id becomes a dead
// embed on a public page. YouTube's oEmbed endpoint answers without an API
// key: 200 + title/author when the video exists and is embeddable, an error
// status otherwise.
//
// A REPORT, not a gate: always exits 0 and prints one line per candidate.
// The reviewer reads titles and channels against the exercise names — an id
// that RESOLVES can still be the wrong video, and only the title says so.
// Run from CI (workflow_dispatch) because the authoring sandbox has no
// egress to youtube.com.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const candidates = JSON.parse(
  readFileSync(new URL("./video-candidates.json", import.meta.url), "utf8"),
);

console.log(`[verify-videos] ${candidates.length} candidate(s)`);
let ok = 0;
for (const { name, vid } of candidates) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://youtu.be/${vid}`)}&format=json`;
  let line;
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      const meta = await res.json();
      ok += 1;
      line = `OK      ${name} | ${vid} | "${meta.title}" — ${meta.author_name}`;
    } else {
      line = `DEAD    ${name} | ${vid} | http ${res.status}`;
    }
  } catch (e) {
    line = `ERROR   ${name} | ${vid} | ${String(e?.message || e).slice(0, 80)}`;
  }
  console.log(line);
}
console.log(`[verify-videos] ${ok}/${candidates.length} resolve`);
