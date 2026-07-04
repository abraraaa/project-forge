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
};

export default nextConfig;
