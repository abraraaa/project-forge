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

// --all: census mode — verify every id the library currently serves and
// report its true title + channel. This is how we learn, with ground truth
// rather than a model's attribution, which producers our catalogue actually
// leans on. Default mode reads the candidates file as before.
let candidates;
if (process.argv.includes("--all")) {
  const { LIBRARY } = await import("../lib/library.js");
  candidates = LIBRARY.filter((e) => e.vid).map((e) => ({ name: e.name, vid: e.vid }));
} else {
  candidates = JSON.parse(
    readFileSync(new URL("./video-candidates.json", import.meta.url), "utf8"),
  );
}

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
