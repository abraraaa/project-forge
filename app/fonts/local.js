import localFont from "next/font/local";

// Build-time fallback for google.js, used only when the Google Fonts fetch
// fails during the build (scripts/build.mjs). These are the latin-subset
// variable files Google serves for the same families, so extended-Latin
// glyphs fall back to the system face on this path. See google.js for the
// type system itself. Variable weights are given as "min max" ranges.
// Licence: OFL.txt.

export const bodoni = localFont({
  src: "./bodoni-moda-latin.woff2",
  weight: "400 500",
  style: "normal",
  display: "swap",
  variable: "--font-bodoni",
  preload: true,
  adjustFontFallback: "Times New Roman",
});

export const familjen = localFont({
  src: "./familjen-grotesk-latin.woff2",
  weight: "400 600",
  style: "normal",
  display: "swap",
  variable: "--font-familjen",
  preload: true,
});

export const spline = localFont({
  src: "./spline-sans-mono-latin.woff2",
  weight: "300 500",
  style: "normal",
  display: "swap",
  variable: "--font-spline",
  preload: true,
});
