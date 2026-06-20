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
    // No statusBarStyle. The legacy "black-translucent" value has a
    // well-documented iOS WebKit bug: it shifts the viewport upward by
    // ~59px behind the status bar without growing the viewport, leaving
    // a chin gap at the bottom AND making fixed overlays (e.g. our grain
    // layer) bleed into the Dynamic Island area with mismatched contrast.
    // Without it, iOS reserves the status bar zone, fills it with the
    // manifest's background_color (#131110 — matches the page), and lays
    // content cleanly underneath. See:
    // https://gist.github.com/fozzedout/5e77925381991a9570151550992baf14
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
  themeColor: "#131110",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${dmSans.variable}`}>
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Deliberately NO apple-mobile-web-app-status-bar-style: see the
            metadata.appleWebApp block above for the WebKit-bug rationale. */}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
        <ServiceWorkerRegistrar />
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
        {/* Kodak Portra-flavour grain texture. Mounted last in the body so
            it composites on top via mix-blend overlay; pointer-events none
            and zIndex 1 keep it strictly cosmetic. */}
        <GrainOverlay />
        {/* Status-bar continuity fade. The iOS status-bar zone is filled
            by the manifest's background_color (#131110), but the home /
            Performance Lab day-type radial glows bloom at the very top of
            the content area, painting warm tints right against the dark
            status bar — visible as a hard horizontal seam at the boundary
            (user-reported screenshot, 2026-06-19).

            Two jobs:

            1. AT SCROLL-TOP: dissolve the seam. The linear gradient is
               solid #131110 at the very top (matching the status-bar zone
               directly above) and tapers to transparent at the bottom of
               the band, so the day-type glow blooms below it cleanly.

            2. WHILE SCROLLING: handle content sliding into the top edge
               iOS-natively. backdrop-filter blur(20px) + saturate(180%)
               is the standard frosted-glass treatment Safari, Apple's
               own apps, and most native nav bars use — content scrolling
               UP into this band gets blurred + slightly more saturated
               rather than just darkening to dead grey. The user asked
               whether content "should slide along"; this is the iOS
               idiom for that behaviour.

            Named for its own view-transition group so root cross-fades
            (Home ↔ Performance Lab) don't bake it into both snapshots
            and brighten the fade region mid-transition — see globals.css
            for the pinned-pseudo treatment.

            Pointer-events: none keeps it strictly cosmetic. zIndex 2 sits
            above grain (1) so the fade also masks grain noise out of the
            Dynamic Island adjacency zone. */}
        <div aria-hidden="true" style={{
          position: "fixed",
          top: 0, left: 0, right: 0, height: 60,
          // The top of the gradient is intentionally NOT opaque #131110 —
          // matching the status bar exactly created a perceptually
          // isolated dark band ("transparency too low, status bar still a
          // black hole"). Starting at 55% alpha lets the underlying page
          // (with day-type glow above the fold) bleed through, so the
          // fade reads as a single continuous surface with the content
          // below rather than a second distinct band stacked on it. Mid
          // band stays partially opaque to give backdrop-filter material
          // to act on; bottom is transparent so the glow blooms below.
          background: "linear-gradient(to bottom, rgba(19,17,16,0.55) 0%, rgba(19,17,16,0.25) 55%, rgba(19,17,16,0) 100%)",
          // Softened blur + saturate. Safari has to bake backdrop-filter
          // into view-transition snapshots, and the snapshot's backdrop
          // doesn't always match the live element's backdrop on resume
          // — visible as a small "flicker" the user caught on Performance
          // Lab arrival. Less aggressive values (blur 14 vs 20, saturate
          // 160 vs 180) keep the iOS frosted feel while making the
          // snapshot↔live handoff less perceptible.
          backdropFilter: "blur(14px) saturate(160%)",
          WebkitBackdropFilter: "blur(14px) saturate(160%)",
          pointerEvents: "none",
          zIndex: 2,
          viewTransitionName: "forge-top-fade",
        }}/>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
