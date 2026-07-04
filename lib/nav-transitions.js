// lib/nav-transitions.js
// ─────────────────────────────────────────────────────────────────────────────
// Directional navigation transitions (PR3 3f). One tiny helper so every
// screen/route change flows through React's sanctioned transition machinery
// instead of the old hand-rolled document.startViewTransition + flushSync
// wrapper (which forced sync commits and bypassed concurrent rendering).
//
// How it works: Next's experimental.viewTransition flag makes App Router
// navigations run as React transitions, and the <ViewTransition> boundary in
// app/layout.jsx animates whenever its children change inside one. Untyped
// transitions (any plain router.push, or Next's own nav marking) fall through
// to the boundary's `default` class → forward slide. Call sites that mean
// "going back" wrap the navigation with type "nav-back" → the back class →
// slide-down. CSS lives in globals.css (::view-transition-*(.forge-vt-*)).
//
// Guarded against non-canary React: `addTransitionType` ships in the React
// canary that Next vendors for App Router bundles, but vitest resolves the
// stable `react` package (19.2.x), which doesn't export it. Optional-chaining
// keeps unit tests and any future stable-React context working — the
// transition still commits, it just goes untyped (forward).
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";

// Cast through `any`: addTransitionType exists in the React canary Next
// vendors for App Router bundles, but the stable @types/react the build's
// type-checker sees doesn't know it yet.
const R = /** @type {any} */ (React);

export function withNavTransition(fn, type) {
  const start = R.startTransition ?? ((cb) => cb());
  start(() => {
    if (type) {
      try { R.addTransitionType?.(type); } catch { /* stable React: untyped */ }
    }
    fn();
  });
}
