import "./globals.css";
import { Fraunces, DM_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import ErrorBoundary from "@/components/ErrorBoundary";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import GrainOverlay from "@/components/GrainOverlay";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["300", "400"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-fraunces",
  preload: true,
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
  variable: "--font-dm-sans",
  preload: true,
});

export const metadata = {
  title: "Forge",
  description: "Train with intention.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    // black-translucent is the ONLY value that makes the status bar
    // transparent so the page draws underneath it — i.e. the immersive
    // "blend" we want. "default" and "black" both render an OPAQUE system
    // bar that content cannot extend under, which reads as a detached band.
    // Pair with viewport-fit: cover (viewport export) + an env(safe-area-
    // inset-top) padding on the top content so it isn't hidden under the
    // clock. NOTE: iOS reads this only at install time — you must remove and
    // re-add the Home Screen app to see any change here.
    statusBarStyle: "black-translucent",
    title: "Forge",
  },
  icons: {
    apple: "/apple-touch-icon.png",
    icon: [
      { url: "/forge-glass-192.png", sizes: "192x192", type: "image/png" },
      { url: "/forge-glass-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
};

export const viewport = {
  // themeColor: kept for non-Safari browsers + PWA chrome that still read it.
  // IMPORTANT (Safari 26): Safari STOPPED honouring theme-color for the
  // toolbar tint. It now samples the background-color of a fixed/sticky edge
  // element, falling back to <body>, at FIRST PAINT (JS bg changes don't
  // update it). Our status bar reads correctly only because body bg is also
  // #131110 — the two happen to match. DO NOT remove `background: #131110`
  // from html/body in globals.css thinking themeColor covers it; on Safari
  // 26 the body bg IS what tints the toolbar. (This exact trap already
  // caused a regression once.) See docs/frontend-audit.md F5.
  themeColor: "#131110",
  // colorScheme via the viewport API rather than a manual <meta> in <head>
  // — Next dedupes/manages it and warns on hand-written viewport meta.
  // Controls UA form controls, scrollbars, and the default canvas colour.
  // (NB: does NOT fix the PWA back-swipe shimmer — that's a platform-level
  // system backdrop with no CSS hook; see docs/frontend-audit.md F7.)
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // viewport-fit: cover is REQUIRED for the immersive status-bar look.
  // Without it, iOS paints the safe-area zones (top status bar + bottom
  // home-indicator "chin") with theme-color as flat opaque bands, and —
  // critically — every env(safe-area-inset-*) value in the app resolves
  // to 0. The app already relies on those insets (toast top offsets,
  // bottom-sheet home-indicator padding); cover is what makes them work.
  // With cover, the page background extends edge-to-edge so the status
  // bar reads as part of the app instead of a detached black band.
  // iOS 26 note: without cover, the floating Liquid Glass toolbar makes the
  // layout viewport end ABOVE the bottom safe area — cover is now doubly
  // load-bearing. See docs/frontend-audit.md F6.
  viewportFit: "cover",
};

// `overlay` is the @overlay parallel-route slot (app/@overlay/*). It renders
// alongside `children` so an intercepted route (e.g. (.)performance) can
// appear OVER the current page without unmounting it — see
// app/@overlay/(.)performance for the rationale (preserving Home's scroll).
export default function RootLayout({ children, overlay }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${dmSans.variable}`}
      // Inline colorScheme + background on <html> so the dark surface exists at
      // HTML-PARSE time, before globals.css (an external stylesheet) loads. The
      // gap between first paint and stylesheet application is when the browser
      // paints the UA-default canvas — WHITE in light-mode — which is the
      // white flash on load/navigation AND, on iOS standalone, the swipe-back
      // "shimmer" (it tracks device appearance precisely because it's the UA
      // canvas). color-scheme:dark darkens the UA canvas; backgroundColor pins
      // our exact #131110. Must stay in sync with html/body bg in globals.css
      // and T.bg0. This is the parse-time layer the meta tag + CSS couldn't
      // cover. See docs/frontend-audit.md F5/F7.
      style={{ colorScheme: "dark", backgroundColor: "#131110" }}
    >
      <head>
        {/* Build-output-verified manual tags. Next 16's Metadata API
            emits apple-mobile-web-app-status-bar-style (from
            appleWebApp.statusBarStyle), apple-mobile-web-app-title
            (from appleWebApp.title), apple-touch-icon (from icons.apple),
            and the cross-platform mobile-web-app-capable automatically
            — all four were duplicated previously and the duplicates were
            silently disabling viewport-fit cover + black-translucent on
            iOS Safari (chin + letterbox + opaque status bar).

            What Next does NOT emit, and what iOS still requires for
            splash screens + full standalone PWA behaviour, is
            apple-mobile-web-app-capable (the Apple-prefixed legacy tag —
            deprecated but still required by iOS Safari per
            https://github.com/vercel/next.js/issues/74524). That's the
            single tag that stays here. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <ServiceWorkerRegistrar />
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
        {/* Intercepted-route overlay slot. Renders nothing (default.jsx → null)
            unless a route is intercepted into it; an interception paints over
            `children` above, keeping the underlying page mounted. */}
        {overlay}
        {/* Kodak Portra-flavour grain texture. It is a zIndex -1 FIELD that
            sits BEHIND the app (see GrainOverlay.jsx) — cards paint on top of
            it, the status-bar zone stays plain. pointer-events none keeps it
            cosmetic. Mount order in the body no longer matters for stacking
            since z-index drives it. */}
        <GrainOverlay />
        {/* Status-bar handling lives entirely in CSS now: viewport-fit:
            cover + statusBarStyle: black-translucent let the page background
            (#131110) flow under a transparent system bar, and a standalone-
            only env(safe-area-inset-top) padding on body keeps content clear
            of the clock. There is NO body::before overlay element (an earlier
            comment here claimed there was — it was stale). */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
