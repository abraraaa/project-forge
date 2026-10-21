import { Bodoni_Moda, Familjen_Grotesk, Spline_Sans_Mono } from "next/font/google";

// Bone & Ember type system — two families and an instrument.
// Display: Bodoni Moda, corrected cut. The face is ALWAYS set with
// font-optical-sizing none + 'opsz' 11 + kern normal + +0.004em tracking
// (the DISPLAY object in lib/tokens.js) — never the free optical axis,
// which is what dropped the t's hairlines below a pixel. 400 default,
// 500 ceremony-only. Roman only — no italic cut ships (italic-serif mood
// fragments are on the never-list).
export const bodoni = Bodoni_Moda({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal"],
  display: "swap",
  variable: "--font-bodoni",
  preload: true,
});

// Text: Familjen Grotesk — every word of interface. Sentence case, never
// all-caps.
export const familjen = Familjen_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-familjen",
  preload: true,
});

// Measured: Spline Sans Mono — measured values only. If it isn't a
// number, it isn't mono.
export const spline = Spline_Sans_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  display: "swap",
  variable: "--font-spline",
  preload: true,
});
