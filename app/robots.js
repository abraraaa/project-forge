// app/robots.js → served as /robots.txt by Next.
export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Diagnostic surfaces and the sync API are operational, not content.
        // /locker-room joins them: it bounces without an active profile and
        // gates photos behind a ceremony, exactly like /session — but it is a
        // client component, so it cannot export `robots: { index: false }`
        // the way /session does. Disallowing here is the equivalent.
        disallow: ["/diag-sync", "/diag-vt", "/diag-bugs", "/api/", "/session", "/locker-room"],
      },
    ],
    sitemap: "https://heatwayve.app/sitemap.xml",
  };
}
