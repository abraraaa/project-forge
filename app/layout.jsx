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
  themeColor: "#131110",
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
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${dmSans.variable}`}>
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
