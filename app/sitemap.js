// app/sitemap.js → served as /sitemap.xml by Next.
// Only the public, state-independent routes. /session is app-state-dependent
// (bounces without an intent/draft, and is marked noindex); /diag-* and /api
// are excluded here and disallowed in robots.js.
import { LIBRARY } from "@/lib/library";

const BASE = "https://theforged.fit";

export default function sitemap() {
  return [
    { url: `${BASE}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${BASE}/performance`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE}/profile`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${BASE}/library`, changeFrequency: "monthly", priority: 0.7 },
    ...LIBRARY.map((e) => ({
      url: `${BASE}/library/${e.slug}`,
      changeFrequency: "monthly",
      priority: 0.5,
    })),
  ];
}
