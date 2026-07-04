// app/robots.js → served as /robots.txt by Next.
export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Diagnostic surfaces and the sync API are operational, not content.
        disallow: ["/diag-sync", "/diag-vt", "/api/", "/session"],
      },
    ],
    sitemap: "https://theforged.fit/sitemap.xml",
  };
}
