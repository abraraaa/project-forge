// app/robots.js → served as /robots.txt by Next.
export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Diagnostic surfaces and the sync API are operational, not content.
        disallow: ["/diag-sync", "/diag-vt", "/diag-bugs", "/api/", "/session"],
      },
    ],
    sitemap: "https://heatwayve.app/sitemap.xml",
  };
}
