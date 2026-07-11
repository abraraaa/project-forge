// Forge service worker — PR-B: app-shell precache + runtime caching.
//
// What this PR adds on top of PR-A's scaffold:
//   - Precache the tiny set of always-needed static assets at install
//     (manifest.json + the two icons).
//   - Cache-first for /_next/static/* (content-hashed, immutable).
//   - Cache-first for binary static assets at the root (.png, .ico, fonts).
//   - Network-first with cache fallback for HTML / navigation requests, so
//     the app shell still loads on a flaky gym wifi.
//   - Network-only for /api/* — auth/sync must never see stale responses.
//   - Cache versioning + cleanup of stale forge-* caches on activate.
//
// What this PR DOES NOT do (future PRs):
//   - IndexedDB queue for offline session logs (PR-D).
//   - Background-sync flush on reconnect (PR-E).
//   - Update-prompt UI when a new SW activates (PR-F).
//
// Bump SW_VERSION on every meaningful change so the activate handler cleans
// up older caches. Old caches are deleted by prefix match on every activate.

const SW_VERSION  = "0.5.0-static-routing";
const STATIC_CACHE = `forge-static-${SW_VERSION}`;
const HTML_CACHE   = `forge-html-${SW_VERSION}`;

// Precache list — must stay tiny. Anything else is added at runtime.
// Bumped to the Liquid Glass icon set; the legacy /icon-192.png and
// /icon-512.png paths still exist (as flat fallbacks) for any installed
// PWA that references them before the new manifest takes effect.
const PRECACHE_URLS = [
  "/manifest.json",
  "/forge-glass-192.png",
  "/forge-glass-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();

  // ── Static routing (Safari 27+ / spec'd addRoutes) ────────────────────
  // Routes the browser applies WITHOUT waking this worker. Scope is
  // deliberately limited to rules that are semantics-identical to the
  // fetch router below:
  //   - /api/*  → network. The router already early-returns for /api (auth
  //     + sync must always see fresh server state), so today the worker
  //     wakes only to decline. This removes the wake from every sync call.
  //   - The tiny PRECACHE set → cache (miss falls back to network per
  //     spec). These are install-time cached, so hits are guaranteed in
  //     steady state; on the rare miss the only delta vs cacheFirst is no
  //     re-population, acceptable for four stable files.
  // NOT routed: /_next/static/*. A "cache" route never runs the fetch
  // handler, so runtime caching would never populate — offline statics
  // would silently break after each deploy. That bypass needs precache-
  // manifest work first (parked). Feature-guarded: browsers without
  // addRoutes just use the fetch router for everything, as today.
  if ("addRoutes" in event) {
    try {
      event.addRoutes([
        { condition: { urlPattern: { pathname: "/api/*" } }, source: "network" },
        { condition: { urlPattern: { pathname: "/manifest.json" } }, source: "cache" },
        { condition: { urlPattern: { pathname: "/forge-glass-192.png" } }, source: "cache" },
        { condition: { urlPattern: { pathname: "/forge-glass-512.png" } }, source: "cache" },
        { condition: { urlPattern: { pathname: "/apple-touch-icon.png" } }, source: "cache" },
      ]).catch((err) => console.warn("[sw] addRoutes rejected:", err));
    } catch (err) {
      // Malformed-rule errors must never block install.
      console.warn("[sw] addRoutes failed:", err);
    }
  }

  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => {
        // Don't block install if a precache asset 404s on this deploy —
        // runtime caching will still pick it up on first request.
        console.warn("[sw] precache failed:", err);
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k.startsWith("forge-") && k !== STATIC_CACHE && k !== HTML_CACHE);
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ─── Strategy: cache-first ─────────────────────────────────────────────────
// Use for immutable assets (content-hashed bundles, icons). Returns cache
// hit immediately; populates cache on miss; falls through to network error
// if both cache and network fail.
async function cacheFirst(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    // Clone before consuming — Response bodies are single-use.
    cache.put(req, res.clone()).catch(() => { /* quota errors are non-fatal */ });
  }
  return res;
}

// ─── Strategy: network-first with cache fallback ───────────────────────────
// Use for HTML / navigation. Online users always get the freshest shell;
// offline users get the last-cached version so the PWA still opens at the
// gym when wifi is flaky.
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone()).catch(() => { /* quota errors are non-fatal */ });
    }
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

// ─── Fetch router ──────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET — POST/PUT/DELETE go straight to network.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only handle same-origin — cross-origin (Vercel blob, analytics, etc.)
  // is left to the browser cache.
  if (url.origin !== self.location.origin) return;

  // API routes: never cache. Auth + sync must always see fresh server state.
  if (url.pathname.startsWith("/api/")) return;

  // Content-hashed Next bundles: cache-first, immutable.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Root-level static binaries (icons, favicon, fonts). Path-based test
  // covers PWA assets that aren't fingerprinted.
  if (/\.(png|jpe?g|svg|webp|gif|ico|woff2?|otf|ttf)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Manifest: cache-first so PWA installability survives offline.
  if (url.pathname === "/manifest.json") {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // HTML / navigation: network-first.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(networkFirst(req, HTML_CACHE));
    return;
  }

  // Anything else (Next data fetches, server actions, etc.) — pass through.
});
