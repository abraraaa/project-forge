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
  // Minimal SAFE security headers (audit #24). Deliberately NO script-src
  // CSP: Next App Router inlines bootstrap scripts, and a nonce pipeline is
  // its own project — a broken-CSP outage serves no one. These four are
  // pure win, zero breakage surface: no framing (also kills clickjacking on
  // the passkey ceremonies), no MIME sniffing, tight referrers, and no
  // camera/mic/geo access from any embedded context.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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
