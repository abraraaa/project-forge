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
// --playlist <id>: read a YouTube playlist's entries straight off its page
// (ytInitialData is server-rendered into the HTML — no API key), then run
// every id through the same oEmbed check for canonical title + channel.
// Exists because a hand-curated playlist is the boss's preferred sourcing
// surface, and the authoring sandbox cannot reach youtube.com at all.
// Playlists render their first 100 entries without continuation - larger
// lists would need the continuation token dance this deliberately skips.
async function playlistEntries(listId) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en",
    "Cookie": "SOCS=CAI",   // pre-accepted consent — the consent wall otherwise strips content
  };
  const res = await fetch(`https://www.youtube.com/playlist?list=${listId}&hl=en`, { headers });
  console.log(`[verify-videos] playlist page http ${res.status}`);
  const html = await res.text();

  const seen = new Set();
  const out = [];
  const push = (vid, title) => {
    if (!vid || seen.has(vid)) return;
    seen.add(vid);
    out.push({ name: title || "(untitled)", vid });
  };

  // Strategy A — classic markup: playlistVideoRenderer objects.
  {
    const re = /"playlistVideoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,600}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(html))) push(m[1], JSON.parse(`"${m[2]}"`));
    if (out.length) { console.log(`[verify-videos] strategy A (playlistVideoRenderer): ${out.length}`); return out; }
  }

  // Strategy B — lockup view-model markup (the newer component system).
  {
    const re = /"lockupViewModel":\{"contentImage"[\s\S]{0,3000}?"contentId":"([\w-]{11})"[\s\S]{0,3000}?"title":\{"content":"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(html))) push(m[1], JSON.parse(`"${m[2]}"`));
    if (out.length) { console.log(`[verify-videos] strategy B (lockupViewModel): ${out.length}`); return out; }
  }

  // Strategy C — the innertube browse API the page itself uses. The key is
  // printed in the page; the browse call returns the playlist as JSON.
  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (keyMatch) {
    const browse = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${keyMatch[1]}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20260101.00.00", hl: "en" } },
        browseId: `VL${listId}`,
      }),
    });
    console.log(`[verify-videos] innertube browse http ${browse.status}`);
    if (browse.ok) {
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const x of node) walk(x); return; }
        const vid = node.videoId || (typeof node.contentId === "string" && /^[\w-]{11}$/.test(node.contentId) ? node.contentId : null);
        if (vid && node.title) {
          const t = node.title;
          const title = t.simpleText || t.content || (t.runs && t.runs.map((r) => r.text).join("")) || null;
          if (title) push(vid, title);
        }
        for (const v of Object.values(node)) walk(v);
      };
      walk(await browse.json());
      if (out.length) { console.log(`[verify-videos] strategy C (innertube): ${out.length}`); return out; }
    }
  } else {
    console.log("[verify-videos] no INNERTUBE_API_KEY in page");
  }

  // Diagnostics so a zero is explainable rather than mute.
  for (const probe of ["playlistVideoRenderer", "lockupViewModel", "videoRenderer", "ytInitialData", "consent.youtube.com", "contentId"]) {
    console.log(`[verify-videos] diag "${probe}": ${html.split(probe).length - 1}`);
  }
  return out;
}

let candidates;
const plIdx = process.argv.indexOf("--playlist");
if (plIdx !== -1 && process.argv[plIdx + 1]) {
  candidates = await playlistEntries(process.argv[plIdx + 1]);
  console.log(`[verify-videos] playlist entries found: ${candidates.length}`);
} else if (process.argv.includes("--all")) {
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
