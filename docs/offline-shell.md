# Offline app-shell — design note (audit #36–#38, #43)

## The failure, precisely

The SW already has decent runtime strategies (network-first HTML, cache-first
statics). Offline still fails because of three precise gaps:

1. **Nothing is precached at install** (#36). The HTML fallback only serves
   routes the user happened to visit online. Offline cold-start on a
   never-visited route — or any route right after install — hits the browser
   error page.
2. **Every `SW_VERSION` bump wipes all caches** (#37). Cache names embed the
   version; activate deletes the old ones wholesale. After each deploy the
   shell is gone until every route is re-visited online.
3. **Client-side navigations bypass the fallback** (#38). Next's router
   fetches RSC payloads (`?_rsc=`), which aren't `mode: "navigate"` and don't
   accept `text/html` — they fall through the router and just fail offline.

## The fix

**A build-time precache manifest** (the parked prerequisite the static-routing
PR named), plus persistent caches pruned by manifest instead of wiped by
rename, plus an RSC fallback branch.

### Build step (`scripts/generate-sw-precache.mjs`, npm `postbuild`)

Reads `.next/BUILD_ID`, `.next/app-build-manifest.json` and
`.next/build-manifest.json`; emits `public/sw-precache.js`:

```js
self.__FORGE_PRECACHE = {
  version: "<BUILD_ID>",
  shellRoutes: ["/", "/session", "/profile", "/performance", "/library"],
  assets: ["/_next/static/chunks/…', …],   // union of the shell routes' JS+CSS
};
```

- The five shell routes are all statically prerendered (`○`) — their HTML is
  cacheable as-is. `/library/[slug]` (166 SSG pages) is deliberately NOT
  precached: offline library browsing is out of scope; visited pages still
  runtime-cache as today.
- `postbuild` runs automatically after `npm run build` on Vercel; files
  written to `public/` during it are deployed (same mechanism next-sitemap
  uses). `public/sw-precache.js` is gitignored.
- `sw.js` loads it via guarded `importScripts("/sw-precache.js")` — in dev
  (no build) the file is absent, the catch leaves precache empty, and the SW
  behaves exactly as today. Browsers byte-check imported scripts during SW
  update checks, so a new build (new manifest content) triggers the update
  cycle without touching `sw.js` itself.

### Cache model (replaces version-suffixed names)

- `forge-static-v1` (persistent): precached assets + runtime statics.
  On activate, **prune** `/_next/static/*` entries not in the current
  manifest (old build hashes) instead of deleting the cache (#37, #43).
  Non-`/_next` entries (icons, fonts) are left alone.
- `forge-shell-v1` (persistent): precached shell HTML + runtime-cached HTML +
  RSC payloads. Never wiped; re-fetched shell routes overwrite in place.
- Legacy `forge-*-<version>` caches from the old scheme are deleted on
  activate (one-time migration).
- `SW_VERSION` remains as a comment/log marker only — cache lifetime is now
  governed by build manifests, not by renaming.

### Fetch router changes

- **RSC payloads** (`?_rsc=` GETs): network-first into the shell cache; on
  offline, `cache.match(req, { ignoreSearch: true })` — the `_rsc` hash
  varies per build but the pathname identifies the route. No cached payload →
  fail as today, and Next falls back to a hard navigation, which hits:
- **Navigations**: network-first (unchanged), with a deeper fallback chain:
  exact match → same-pathname `ignoreSearch` match → cached `/` as
  last resort (best-effort: the client router recovers the real route).
- Everything else unchanged, including `/api/*` network-only and the
  Safari 27 `addRoutes` block. `/_next/static/*` stays fetch-handled (NOT
  `addRoutes`-cache-routed) — the manifest makes precache complete for the
  *current* build, but runtime population must still work mid-rollout.

### What this deliberately does not touch

Silent `skipWaiting` swap (#39), fetch timeouts (#40), `persist()` UX (#41),
auto-sync scope (#42) — separate concerns, unchanged behaviour.

## Verification

- Generator: unit-tested against fixture manifests (shape, union, prefixing).
- `npm run build` → `public/sw-precache.js` exists, lists real hashed assets.
- **Device pass (required before merge, boss):** install PWA → airplane mode →
  cold-start `/` and `/session` (both should render shell); deploy-then-
  offline-cold-start (old shell must survive the new SW's activate); `?nosw=1`
  hatch still unregisters everything.
