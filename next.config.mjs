/** @type {import('next').NextConfig} */
const nextConfig = {
  // React Compiler (stable in Next 16, top-level config). Auto-memoises
  // components + hooks at build time — the highest-leverage win for our
  // shape: a hook-heavy monolith (ForgeApp.jsx, 171 hooks, 651 inline style
  // objects) where manual memoisation is patchy. Next configures the built-in
  // Babel automatically; the compiler runtime is vendored in next, so no
  // babel-plugin-react-compiler install is required.
  //
  // SPIKE STATUS (docs/frontend-audit.md F10): additive + reversible. If it
  // destabilises anything, delete this line. Verification is a real
  // `next build` (the compiler runs there, NOT in vitest) plus a deployed
  // smoke pass — vitest passing does NOT exercise the compiler transform.
  reactCompiler: true,
  // View Transitions (PR3 3f). Makes App Router navigations run as React
  // transitions so the <ViewTransition> boundary in app/layout.jsx animates
  // route changes (home ↔ /session ↔ /performance ↔ /profile) with the same
  // slide vocabulary the in-shell screens use. Experimental in Next 16 —
  // the React side (ViewTransition / addTransitionType) ships in the React
  // canary Next vendors for App Router bundles. If it destabilises,
  // deleting this flag reverts navigation to instant swaps; the boundary
  // and CSS degrade to no-ops.
  experimental: {
    viewTransition: true,
  },
  // ── THE FLIP (docs/heatwayve-flip.md, step 3) ────────────────────────────
  // The 2026-07-22 freeze (heatwayve→theforged 307) is DELETED; the reverse
  // PERMANENT 301 below sends theforged.fit → heatwayve.app, with two
  // carve-outs that must keep serving on the OLD origin:
  //   /.well-known/webauthn — the ROR document must stay fetchable at the
  //     rpId origin, or cross-origin passkey ceremonies break;
  //   /api/auth/*           — ceremonies are negotiated against the rpId
  //     origin. Everything else follows the redirect (clients re-request).
  // Bonus TLDs (.fit/.space/.life → .app) stay at the Vercel dashboard.
  // THIS PR MERGES ON FLIP DAY ONLY — the 301 is cached aggressively by
  // design; merging early strands users before DNS is ready.
  // Security headers. The CSP was previously three directives with no
  // default-src and no script-src, which meant scripts were entirely
  // unconstrained — it framed-blocked and nothing else (deep audit
  // 2026-07-26: "zero XSS containment").
  //
  // Now a real allow-list, written from what the app ACTUALLY loads rather
  // than from a template:
  //   · fonts are self-hosted by next/font at build time (.next/static/media)
  //   · Vercel Analytics + Speed Insights serve from same-origin /_vercel/*
  //   · the ONLY external resource in the whole app is the YouTube exercise
  //     embed, so frame-src names exactly that host and nothing else
  //   · buymeacoffee / doi.org / github are LINKS, not resources — CSP does
  //     not govern navigation targets, so they need no entry
  //   · img-src needs blob: (photo object URLs) and data: (canvas share card)
  //
  // 'unsafe-inline' on script-src is load-bearing for now: the App Router
  // inlines its hydration bootstrap, so removing it needs a nonce pipeline
  // through middleware — a real project, and a broken CSP is an outage. The
  // policy is still a large step up: an injected REMOTE script is now blocked
  // outright, and base-uri/form-action/object-src close the classic escapes.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "worker-src 'self'",
      "frame-src https://www.youtube.com",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // Asserted in-repo rather than relying on an unstated platform
        // default. Two years, subdomains included. NOT preloaded: preload is
        // effectively irreversible and both domains would need every
        // subdomain HTTPS-only forever.
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      ],
    }, {
      // Operational surfaces stay out of the index. A response HEADER rather
      // than page metadata: these routes are client components and cannot
      // export `metadata`, and the header applies to the response itself so
      // it holds however the page is rendered or linked.
      //
      // Paired with REMOVING them from robots.txt. Listing a path under
      // Disallow publishes it — robots.txt is world-readable, so it turns a
      // path nobody was looking for into a directory of exactly the routes
      // you would rather they skipped. noindex does the real job; the
      // Disallow line only advertised.
      // Regex param, NOT "/diag-:path*" — a repeat modifier has to own its
      // whole segment, so gluing it to a prefix fails path-to-regexp at build
      // time ("Can not repeat 'path' without a prefix and suffix").
      source: "/:diag(diag-.*)",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      ],
    }];
  },
  async redirects() {
    // Carve-out via negative lookahead in the path matcher: auth ceremony
    // routes + the ROR document never leave the rpId origin.
    const CARVE_OUT = "/:path((?!api/auth/|\\.well-known/webauthn).*)";
    return [
      {
        source: CARVE_OUT,
        has: [{ type: "host", value: "theforged.fit" }],
        destination: "https://heatwayve.app/:path",
        permanent: true, // 301 — the move is forever
      },
      {
        source: CARVE_OUT,
        has: [{ type: "host", value: "www.theforged.fit" }],
        destination: "https://heatwayve.app/:path",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
