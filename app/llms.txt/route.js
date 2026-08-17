// app/llms.txt/route.js
// ─────────────────────────────────────────────────────────────────────────────
// /llms.txt — the llmstxt.org convention: a plain-markdown index that tells
// language models what this site is and which pages answer what. The library
// is the discovery surface — someone asking an assistant "what hits rear
// delts" or "how do I tempo a hip thrust" should land on the page that
// answers it. Built from lib/library.js, so it can never disagree with the
// pages it indexes (same source the sitemap draws from).
// ─────────────────────────────────────────────────────────────────────────────

import { LIBRARY, exerciseDescription, allTrainedMuscles, contributorsFor, muscleSlug } from "@/lib/library";

export const dynamic = "force-static";

export function GET() {
  const lines = [
    "# Heatwayve",
    "",
    "> Evidence-based, autoregulated strength training — a 3-day A/B/C programme with",
    "> effort-responsive progression and per-muscle weekly volume held against the",
    "> MEV/MAV/MRV landmarks. Installable PWA, live at https://heatwayve.app.",
    "",
    "## Training volume",
    "",
    "- [Volume landmarks](https://heatwayve.app/volume-landmarks): what MEV, MAV and",
    "  MRV mean, the per-muscle weekly set targets Heatwayve audits against, and how a",
    "  single set is apportioned across the muscles that did the work.",
    "",
    "## Anatomy — what trains each muscle",
    "",
    "One page per muscle, ranking every movement by the SHARE OF A SET it credits",
    "to that muscle (1.00 = a full set, 0.30 = three-tenths). This is the question",
    "the training literature cannot answer for you: meta-analyses give weekly set",
    "targets, not per-exercise apportionment.",
    "",
    `- [Anatomy index](https://heatwayve.app/anatomy): all ${allTrainedMuscles().length} muscles`,
    ...allTrainedMuscles().map((m) =>
      `- [What trains ${m.toLowerCase()}](https://heatwayve.app/anatomy/${muscleSlug(m)}): ${contributorsFor(m).length} movements, ranked by contribution`),
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
