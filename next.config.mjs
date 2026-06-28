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
};

export default nextConfig;
