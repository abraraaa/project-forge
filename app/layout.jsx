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
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
