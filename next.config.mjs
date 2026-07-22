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
  // ── Heatwayve migration freeze (2026-07-22) ─────────────────────────────
  // heatwayve.app is attached to this project as the 301 TARGET of the bonus
  // TLDs (.fit/.space/.life), so Vercel's dashboard can't also redirect it.
  // The freeze therefore lives HERE: any request arriving on a heatwayve
  // host gets a 307 (temporary — never 301, which caches would hold against
  // next week's flip) to theforged.fit, preserving the path. This stops
  // anyone accruing per-origin state (localStorage/passkeys/cookies) on the
  // new domain before the migration map is fully executed.
  // AT FLIP TIME: delete this block (heatwayve.app goes primary) and add the
  // reverse 301 on theforged.fit — with the /.well-known/webauthn + auth-API
  // carve-outs per docs/audit ledger / migration map.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "heatwayve.app" }],
        destination: "https://theforged.fit/:path*",
        permanent: false, // 307
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.heatwayve.app" }],
        destination: "https://theforged.fit/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
