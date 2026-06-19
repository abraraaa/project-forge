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
            (user-reported screenshot, 2026-06-19). A 60px linear fade from
            #131110 → transparent at the top of the viewport dissolves
            that seam: glow still reads as "warm light from above" but
            doesn't hit the very top edge. Also masks the grain layer from
            the Dynamic Island adjacency zone, since the fade sits above
            grain (zIndex 2 vs 1) and absorbs the screen-blended noise at
            its opaque end. Pointer-events: none keeps it cosmetic. */}
        <div aria-hidden="true" style={{
          position: "fixed",
          top: 0, left: 0, right: 0, height: 60,
          background: "linear-gradient(to bottom, #131110 0%, rgba(19,17,16,0) 100%)",
          pointerEvents: "none",
          zIndex: 2,
        }}/>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
