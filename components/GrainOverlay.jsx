// GrainOverlay — adds a Kodak Portra-style warm grain texture to the whole
// viewport. Pure-CSS / inline SVG; no asset to ship; mounted once in
// app/layout.jsx so every screen gets the same lived-in feel without any
// per-screen plumbing.
//
// Tuning: low frequency = chunkier grain (film-like); high numOctaves =
// more detail; opacity ~5% keeps it strictly textural — visible on a flat
// background, invisible behind any content. The colour matrix tints the
// noise warm rather than neutral grey so it blends into Forge's cream
// palette without going clinical.
//
// Pointer-events: none + zIndex 1 keeps it cosmetic — never intercepts
// taps, never sits above modals (which set zIndex >= 300).

const GRAIN_SVG = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'>
    <filter id='n'>
      <feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/>
      <feColorMatrix values='0 0 0 0 0.85
                             0 0 0 0 0.78
                             0 0 0 0 0.65
                             0 0 0 0.7 0'/>
    </filter>
    <rect width='100%' height='100%' filter='url(#n)' opacity='1'/>
  </svg>`
);

export default function GrainOverlay() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 1,
        opacity: 0.05,
        mixBlendMode: "overlay",
        backgroundImage: `url("data:image/svg+xml,${GRAIN_SVG}")`,
        backgroundRepeat: "repeat",
        backgroundSize: "256px 256px",
      }}
    />
  );
}
