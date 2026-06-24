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
        // mix-blend-mode: overlay at 5% opacity on a near-black background
        // (#131110) is mathematically near-invisible — the dark base
        // dominates and the texture vanishes. mix-blend-mode: screen lifts
        // the grain on dark surfaces (light grain becomes visible noise);
        // opacity raised from 0.05 to 0.12 so it actually reads on a
        // high-density display. Still textural — visible on flat fields,
        // recedes against any content. Smaller tile (192px → richer
        // density) so the noise pattern doesn't read as wallpaper.
        opacity: 0.12,
        mixBlendMode: "screen",
        backgroundImage: `url("data:image/svg+xml,${GRAIN_SVG}")`,
        backgroundRepeat: "repeat",
        backgroundSize: "192px 192px",
        // Fade the grain to zero through the top status-bar safe-area and the
        // bottom home-indicator chin. screen-blend at 12% lifts the body's
        // luminance, so where grain stops abruptly against the flat #131110
        // reserved zones it reads as a hard band-seam (see docs/parked.md).
        // Masking the grain out across env(safe-area-inset-*) (+24px of
        // easing) means the texture dissolves into the flat zones instead of
        // butting against them — no edge to perceive. env() resolves to real
        // insets only in standalone w/ viewport-fit:cover; in-browser it's 0,
        // so the mask is a near-full-height pass-through there (no visual
        // change to the Safari layout, which already looked fine).
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0, transparent env(safe-area-inset-top, 0px), #000 calc(env(safe-area-inset-top, 0px) + 24px), #000 calc(100% - env(safe-area-inset-bottom, 0px) - 24px), transparent calc(100% - env(safe-area-inset-bottom, 0px)))",
        maskImage:
          "linear-gradient(to bottom, transparent 0, transparent env(safe-area-inset-top, 0px), #000 calc(env(safe-area-inset-top, 0px) + 24px), #000 calc(100% - env(safe-area-inset-bottom, 0px) - 24px), transparent calc(100% - env(safe-area-inset-bottom, 0px)))",
        // Opt the grain layer out of the root view-transition capture by
        // naming it. Without this, the screen-blended grain gets baked
        // into BOTH the old and new root snapshots; the cross-fade then
        // plus-lighter-composites them, doubling effective grain density
        // at midpoint and reading as a perceived dim ("Performance Lab
        // dimming"). Naming it pulls it out of the root group so the root
        // cross-fade composites cleanly; the grain itself just stays put
        // across the transition (paired no-op animation in globals.css).
        viewTransitionName: "forge-grain",
      }}
    />
  );
}
