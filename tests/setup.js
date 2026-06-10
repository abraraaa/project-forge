// tests/setup.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-test-run setup. Loads on every file regardless of environment.
//
// Currently:
//   - Stubs the localStorage API for component tests that touch lib/storage.js
//     under jsdom (jsdom has localStorage but our reset between tests needs
//     a clean slate every time).
//   - Shimmed window.matchMedia (some focus-related styles read it; jsdom
//     doesn't implement it by default).
//
// Library tests (default node env) skip both shims via the typeof guards —
// `window` isn't defined there.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach } from "vitest";

if (typeof window !== "undefined") {
  // jsdom has localStorage but we want a clean store between tests.
  afterEach(() => {
    try { window.localStorage.clear(); } catch { /* noop */ }
    try { window.sessionStorage.clear(); } catch { /* noop */ }
  });

  // matchMedia shim — jsdom doesn't implement it. Components that read it
  // (e.g. prefers-reduced-motion checks) would otherwise throw on mount.
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
}
