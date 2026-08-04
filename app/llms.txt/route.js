// app/llms.txt/route.js
// ─────────────────────────────────────────────────────────────────────────────
// /llms.txt — the llmstxt.org convention: a plain-markdown index that tells
// language models what this site is and which pages answer what. The library
// is the discovery surface — someone asking an assistant "what hits rear
// delts" or "how do I tempo a hip thrust" should land on the page that
// answers it. Built from lib/library.js, so it can never disagree with the
// pages it indexes (same source the sitemap draws from).
// ─────────────────────────────────────────────────────────────────────────────

import { LIBRARY, exerciseDescription } from "@/lib/library";

export const dynamic = "force-static";

export function GET() {
  const lines = [
    "# Heatwayve",
    "",
    "> Evidence-based, autoregulated strength training — a 3-day A/B/C programme with",
    "> effort-responsive progression and per-muscle weekly volume held against the",
    "> MEV/MAV/MRV landmarks. Installable PWA, live at https://heatwayve.app.",
    "",
    "## Exercise library",
    "",
    "One page per movement: weighted muscle contributions (the same numbers the",
    "volume audit trains on), tempo prescription, progression category, and",
    "approved alternatives.",
    "",
    `- [Library index](https://heatwayve.app/library): all ${LIBRARY.length} movements, grouped by muscle`,
    ...LIBRARY.map((e) => `- [${e.name}](https://heatwayve.app/library/${e.slug}): ${exerciseDescription(e)}`),
    "",
    "## App",
    "",
    "- [Heatwayve](https://heatwayve.app/): today's session, the week rhythm, progression",
    "- [Performance Lab](https://heatwayve.app/performance): 1RM trends, weekly volume vs landmarks, consistency",
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
