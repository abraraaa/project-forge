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
    // black-translucent is the spec-correct choice for an edge-to-edge
    // iOS PWA on iOS 26.2+. The iOS 26.1 regression (negative viewport
    // offset producing a bottom chin gap) was fixed in iOS 26.2 beta 3;
    // our baseline is current iOS. Paired with viewport-fit: cover below,
    // env(safe-area-inset-*) resolves to real values and we can layout
    // around the system status bar / Dynamic Island properly. See
    // https://gist.github.com/fozzedout/5e77925381991a9570151550992baf14
    // and https://danielpietzsch.com/articles/how-to-create-a-blurry-status-bar-for-pwas-on-ios
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
  // viewport-fit: cover is MANDATORY for env(safe-area-inset-*) to return
  // non-zero values on iOS. Without it, every safe-area-inset query
  // resolves to 0px and Safari letterboxes landscape with black bars.
  // This unblocks the body::before status-bar blur recipe in globals.css.
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
