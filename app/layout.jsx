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
    // No statusBarStyle. black-translucent has been deprecated by WebKit
    // for multiple releases — it can't semantically work with dark mode
    // or across different webpage styles, AND Home Screen web apps don't
    // support drawing arbitrary content below the status bar regardless
    // of what value is set (confirmed by a WebKit dev response, 2026-06).
    // Without this key, the status bar automatically renders in the same
    // colour as the webpage (matches our theme-color: #131110, which is
    // also our body bg). The body::before backdrop-filter recipe we used
    // to bolt on was based on a misread of what PWAs allow; removed.
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
  // viewport-fit: cover retained for landscape Dynamic Island handling
  // (lets content extend past the notch zone horizontally). With the
  // status bar back to its native rendering, env(safe-area-inset-top)
  // typically returns 0 in portrait PWA — but the landscape edge cases
  // still benefit from cover. Harmless when the right-hand side of the
  // recipe is gone.
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
        {/* Kodak Portra-flavour grain texture. Mounted last in the body so
            it composites on top via mix-blend overlay; pointer-events none
            and zIndex 1 keep it strictly cosmetic. */}
        <GrainOverlay />
        {/* Status-bar handling: NO fixed overlay element. The blur is
            applied via body::before in globals.css, with its height
            pinned to env(safe-area-inset-top) so it occupies ONLY the
            system status-bar zone — it can never mask content scrolling
            below it. This is the documented iOS PWA recipe; the prior
            fixed-pixel fade was a workaround for missing viewport-fit
            and is now removed. */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
