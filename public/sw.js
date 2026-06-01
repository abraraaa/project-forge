// Forge service worker — PR-A scaffold.
//
// This is intentionally MINIMAL: it installs and activates so the SW
// lifecycle is wired up, but it does NOT register a `fetch` event handler,
// so it does not intercept any requests yet. The app behaves identically
// to a no-SW build. Future PRs layer caching, IndexedDB queueing, and
// background sync on top of this foundation.
//
// Versioning: bump SW_VERSION on every meaningful change. The activate
// handler currently does nothing with it, but cache-prefixing future
// stores by version is how we'll handle clean upgrades.

const SW_VERSION = "0.1.0-scaffold";

self.addEventListener("install", () => {
  // skipWaiting so a freshly-installed SW takes control immediately on
  // first deploy, rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // clients.claim() makes the SW control all open tabs immediately on
  // activation. Without it, the SW only controls tabs opened AFTER
  // activation, which makes incremental work harder to verify.
  event.waitUntil(self.clients.claim());
});

// NO fetch handler yet. The SW is installed and active, but every fetch
// goes directly to the network — same as before. PR-B adds the first
// caching strategy (app-shell precache).
