// app/robots.js → served as /robots.txt by Next.
export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // The sync API and the two state-dependent routes are operational,
        // not content. /locker-room joins /session here because it is a
        // client component and cannot export `robots: { index: false }`.
        //
        // /diag-* is deliberately ABSENT. This file is world-readable, so a
        // Disallow line publishes the very paths it asks crawlers to skip.
        // Those routes are kept out of the index by an X-Robots-Tag response
        // header (next.config.mjs) instead — which does the job without
        // handing anyone a list.
        disallow: ["/api/", "/session", "/locker-room"],
      },
    ],
    sitemap: "https://heatwayve.app/sitemap.xml",
  };
}
