// app/sitemap.js → served as /sitemap.xml by Next.
// Only the public, state-independent routes. /session is app-state-dependent
// (bounces without an intent/draft, and is marked noindex); /diag-* and /api
// are excluded here and disallowed in robots.js.
// Relative import, not the @/ alias: scripts/indexnow.mjs loads this module
// under plain node to submit exactly the URLs we publish, and the alias only
// resolves inside Next's bundler. One list, two consumers, no drift.
import { LIBRARY, LIBRARY_REVISED } from "../lib/library.js";

export const BASE = "https://heatwayve.app";

// lastmod on the library URLs only, and only from LIBRARY_REVISED — the one
// date we can state truthfully. The app routes are behind client state and
// have no honest content-revision date, so they carry none: an absent lastmod
// is a smaller lie than a fresh one.
export default function sitemap() {
  return [
    { url: `${BASE}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${BASE}/performance`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE}/profile`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${BASE}/library`, changeFrequency: "monthly", priority: 0.7, lastModified: LIBRARY_REVISED },
    // The concept piece. Higher priority than a single exercise page: it is
    // the thing the library pages cite, and the query it answers ("how many
    // sets per week") is asked far more often than any one movement.
    { url: `${BASE}/volume-landmarks`, changeFrequency: "yearly", priority: 0.8 },
    ...LIBRARY.map((e) => ({
      url: `${BASE}/library/${e.slug}`,
      changeFrequency: "monthly",
      priority: 0.5,
      lastModified: LIBRARY_REVISED,
    })),
  ];
}
