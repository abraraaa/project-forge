# Frontend architecture audit — iOS 26 / Next 16

**Date:** 2026-06-24
**Purpose:** Map our frontend against current best practice (Next.js 16, Safari/iOS 26)
so we can take advantage of up-to-date APIs rather than crowbar bandaids over
unexpected behaviour. No code changes in this pass — this is the map we
prioritise from.

**Method:** Two cited web-research sweeps (Next 16 docs + release notes; WebKit
26 notes + Safari/PWA reports) cross-referenced against measured facts from our
own codebase. Sources listed at the foot.

---

## Measured current state

| Dimension | Value | Source |
|---|---|---|
| Next version | 16.2.9 | package.json |
| Real app routes | 1 (`/`) + 2 diag (`/diag-sync`, `/diag-vt`) + 7 API | `find app` |
| `app/page.jsx` | 4 lines, mounts `<ForgeApp/>` | read |
| `ForgeApp.jsx` | 5,688 lines · 38 components · 171 hooks · 1 `"use client"` | wc / grep |
| Inline `style={{}}` objects | 651 in ForgeApp alone | grep |
| `"use client"` files | 7 (incl. ForgeApp, both diag pages, PerformanceLab) | grep |
| Metadata | Metadata API + 2 manual `<meta>` in `<head>` | read |
| `-webkit-` prefixes | `WebkitBackdropFilter`×19, `WebkitFontSmoothing`×6, tap-highlight, overflow-scrolling, mask-image | grep |
| backdrop-filter surfaces | ForgeApp ×18, GlossarySheet ×1 | grep |
| View transitions | hand-rolled `document.startViewTransition` (28 refs) | grep |

---

## Findings

Each rated **[cosmetic]** / **[correctness]** / **[maintainability]** and given a
severity. Severity is "how much it costs us to leave it", not "how hard to fix".

### F1 — The single-route SPA · [maintainability + correctness] · HIGH

`app/page.jsx` mounts one 5,688-line `"use client"` component; every "screen"
is React state via `setScreen`, not a route. Next 16 docs frame state-driven
views explicitly as a **migration accommodation**, not the default — real
file-system routes + `<Link>`/`useRouter` are idiomatic, and layouts,
streaming, per-route metadata, and prefetch all key off the route tree.

Two concrete costs we're already paying:
- **The shimmer** (F7) exists *only* because `/diag-sync` is the one real
  cross-document navigation in the whole app. Every other transition is
  in-app state, so the OS back-gesture path is untuned.
- **Zero Server Component benefit.** One root `"use client"` forces the
  entire tree into the client bundle (see F2).

Next 16's documented middle path: `window.history.pushState/replaceState`,
which syncs with `usePathname`/`useSearchParams` — gives screens real URLs and
back-button behaviour *without* full document navigation. That's the
ballerina-lean move: keep the single-page render, gain real routing semantics.

**Recommendation:** Don't big-bang refactor the monolith (that violates
"ballerina lean / no speculative refactors"). DO consider moving the diag
pages to the `history.pushState` model or making them in-app screens, which
removes the only real-route-nav in the app and with it the shimmer.

### F2 — Root `"use client"` monolith · [maintainability] · MEDIUM

Marking `ForgeApp` `"use client"` at the root is the textbook anti-pattern per
the official Server/Client Components guide: it excludes the whole tree from
server rendering and ships all 5,688 lines as JS. The documented fix is the
`children`-composition pattern — pass Server Components as `children`/props
into Client Components so they render on the server.

**Tension with our principles:** "Ballerina-lean · incremental · no
speculative refactors · ForgeApp doesn't get split unless an extraction has a
concrete reason." Splitting for SC benefit alone is speculative TODAY because
the app is almost entirely interactive — there's little static content to
hoist to the server. So this is a **watch item, not an action**: if/when we add
genuinely static surfaces (marketing, a settings page, content), build them as
Server Components rather than bolting onto ForgeApp.

### F3 — 651 inline style objects · [maintainability + cosmetic-perf] · MEDIUM

Every `style={{}}` is a fresh object literal each render — no memoization,
defeats React's prop-diff, inflates the bundle, and skips the static
extraction Tailwind/CSS Modules get. On a monolith that re-renders on every
mutation, that's real allocation churn. Confirmed perf smell (sound React/CSS
theory; not a single cited doc line).

**Recommendation:** NOT a rip-and-replace. The `T` design-token object already
centralises values. Two low-risk, incremental wins: (a) hoist truly-static
style objects to module-scope constants (one allocation, not N), starting with
the hottest re-rendering components (SessionScreen, HomeScreen); (b) when a
component is touched for other reasons, migrate its styles then. Tailwind
migration is a bigger bet — park it unless we decide the maintainability win
justifies the churn.

### F4 — Manual `<meta>` tags in `<head>` · [correctness] · LOW

Two manual tags: `apple-mobile-web-app-capable` and `color-scheme`. Next 16
discourages hand-written `<meta>` when the Metadata/Viewport API covers it
(it dedupes + warns). `apple-mobile-web-app-capable` has a documented reason to
stay (Next doesn't emit it; iOS splash needs it). `color-scheme` should move to
the `viewport` export (`colorScheme` is a supported field) OR — per F7 — be
reconsidered entirely since it didn't fix the shimmer.

**Recommendation:** Move `color-scheme` into the `viewport` export. Keep the
apple-capable manual tag with its existing justification comment.

### F5 — theme-color no longer honoured on Safari 26 · [correctness] · MEDIUM

**New, important.** Safari 26 **stopped honouring `theme-color`** for the
toolbar. It now samples the `background-color` of a fixed/sticky edge element,
falling back to `<body>`, *at first paint* — JS background changes don't update
it. Our whole status-bar approach leans on `themeColor: "#131110"` in the
viewport export.

**Why it still looks right for us:** our `<body>` background IS `#131110`, so
the sampled colour matches what theme-color used to set. We get the correct
result by accident of the colours matching.

**Recommendation:** Keep `themeColor` (harmless, still used by other
browsers/PWA chrome) but ADD a comment that on Safari 26 the body bg is what
actually drives the toolbar tint, so nobody "cleans up" the body bg thinking
theme-color covers it. (This is exactly the trap that bit us when v0 removed
the body bg.)

### F6 — iOS 26 viewport model · [correctness] · LOW (already handled)

iOS 26's floating Liquid Glass toolbar means the layout viewport can end
*above* the bottom safe area **without** `viewport-fit=cover`, breaking
bottom-anchored layouts. We already set `viewport-fit: cover` + pad with
`env(safe-area-inset-bottom)`, so we're on the right side of this. No action —
recorded so we don't regress it.

### F7 — The PWA back-swipe shimmer · [cosmetic] · RESOLVED (won't-fix)

**The chase is over.** Research confirms: the iOS standalone-PWA interactive
back-swipe paints a **system backdrop that is NOT derived from your CSS or
manifest**. Known, long-standing behaviour (reported across PWA/Ionic for
years), not new to 26, with **no definitive solution** documented. That's why
`color-scheme`, `html/body` background, AND manifest `background_color` — all
correctly set to `#131110` — left it unchanged. We weren't missing a knob;
there is no knob.

The one documented mitigation is "handle routing in-app so the OS gesture isn't
the transition driver" — i.e. **F1**. Make `/diag-sync` an in-app screen and
the shimmer disappears because there's no document navigation to swipe.

**Recommendation:** Stop treating it as a CSS bug. Either accept it (it only
appears on the diag route, which users never see) or fold it into the F1
routing decision. Do NOT ship more `<meta>`/background bandaids.

### F8 — `-webkit-` prefixes · [maintainability] · LOW

Audit against Safari 26: `-webkit-backdrop-filter` (KEEP — unprefixed not fully
shipped), `-webkit-tap-highlight-color` (KEEP — no standard equivalent) are
load-bearing. `-webkit-` on transforms/transitions/animations/flex/filter/mask
is now redundant on 26. We don't appear to carry the redundant ones heavily,
but `WebkitOverflowScrolling: touch` is a no-op since iOS 13 (momentum scroll
is default) — safe to drop where found.

**Recommendation:** Low-priority cleanup. Drop `WebkitOverflowScrolling` on
sight; keep backdrop-filter + tap-highlight prefixes.

### F9 — Hand-rolled view transitions · [maintainability] · LOW

We call `document.startViewTransition` directly (the pre-React-19.2 approach).
Next 16 + React 19.2 ship a first-class `<ViewTransition>` component
(`experimental.viewTransition: true`) that coordinates with Suspense and fires
on route navigations automatically. Our hand-rolled version works and is well-
tuned (the slide, the back-type, the grain opt-out) — but it's bespoke
infrastructure the framework now provides.

**Recommendation:** Park. Only worth migrating if we adopt real routes (F1) —
the built-in component shines on route navigations, which we mostly don't have.
Bespoke-but-working beats a migration with no payoff today.

### F10 — Missing Next 16 platform wins · [maintainability] · INFORMATIONAL

Not bugs — capabilities a 2024-era app shape isn't using:
- **Turbopack** is default for dev+build in 16 (no flag) — we likely already
  get this; confirm build uses it (our Vercel logs showed `bundler: turbopack`,
  so ✅).
- **React Compiler** stable — auto-memoization could relieve some of the F3
  inline-object churn and the 171 manual hooks. Worth a spike.
- **Cache Components / `'use cache'`** — irrelevant while the app is one
  client component with no server data fetching. Becomes relevant if F1/F2
  introduce server surfaces.
- **`proxy.ts`** replaces `middleware.ts` — we have no middleware; N/A.

**Recommendation:** Spike the **React Compiler** — it's the highest-leverage
"current API" win for our specific shape (a hook-heavy monolith), and it's
additive (a config flag + verification), not a refactor.

---

## Prioritised shortlist

Ordered by leverage-per-unit-churn, biased toward ballerina-lean (additive or
incremental, not big-bang):

1. **React Compiler spike** (F10) — config flag, could auto-fix F3's churn +
   reduce manual memoization. Additive, reversible. Highest leverage.
2. **theme-color comment** (F5) — 2-line guard against the body-bg trap that
   already bit us once. Trivial, high-value-for-cost.
3. **Move `color-scheme` to viewport export + drop redundant webkit prefixes**
   (F4, F8) — small correctness/tidy, aligns with Metadata API.
4. **Decide the diag-route question** (F1/F7) — make diag pages in-app screens
   (or `history.pushState`), which kills the shimmer for free and removes the
   one untuned nav path. Medium effort, real payoff.
5. **Static-style hoisting in hot components** (F3) — incremental, do-on-touch.
6. **Watch items** (F2, F9): build new static surfaces as Server Components;
   adopt `<ViewTransition>` only alongside real routes. No action now.

Nothing here is "stop everything and refactor." The monolith stays until an
extraction has a concrete reason — consistent with our stated principles. The
wins are additive (React Compiler), corrective (theme-color comment), or
incremental (style hoisting, the diag-route call).

---

## Sources

**Next 16:**
- nextjs.org/blog/next-16 · /docs/app/getting-started/server-and-client-components
- /docs/app/api-reference/directives/use-client · /docs/app/guides/single-page-applications
- /docs/app/getting-started/metadata-and-og-images · /docs/app/api-reference/functions/generate-viewport
- /docs/app/getting-started/css · /docs/app/guides/view-transitions

**iOS / Safari 26:**
- webkit.org/blog/17333/webkit-features-in-safari-26-0/
- webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- webkit.org/blog/17101/a-guide-to-scroll-driven-animations-with-just-css/
- nasedk.in/blog/ios26-safari-toolbar-colors/ (theme-color sampling change)
- github.com/ionic-team/ionic-framework/issues/29733 (PWA back-swipe backdrop)
- css-tricks.com/touring-new-css-features-in-safari-26/
