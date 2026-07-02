// GrainOverlay — a Kodak Portra-style warm grain FIELD that sits BEHIND the
// app content (zIndex -1), not a layer composited on top of it. Pure-CSS /
// inline SVG; no asset to ship; mounted once in app/layout.jsx.
//
// Why behind, not on top: at zIndex 1 the screen-blended grain composited
// over EVERYTHING below the modal layer — including card faces, buttons and
// text — so the whole UI read as "one photo" and, worse, the grain's bright
// edge against the flat iOS-reserved status-bar zone produced a hard seam
// (see docs/parked.md). As a zIndex -1 field it screen-blends only with the
// page base (#131110 + the desktop ambient gradients) painted beneath it, so
// cards (T.bg2, opaque) sit ON the texture as physical objects and the
// status-bar zone stays plain #131110 — no seam. The 6 secondary screens
// that previously painted an opaque T.bg0 background are now transparent
// (T.bg0 === the page base, so visually identical) so the field shows
// through them too; the main screens were already transparent.
//
// Tuning: low frequency = chunkier grain (film-like); the warm colour matrix
// tints the noise toward Forge's cream palette. opacity 0.12 + screen blend
// is what makes it read on a high-density dark display.
//
// Pointer-events: none + zIndex -1 keeps it cosmetic — never intercepts
// taps, always behind content and modals.

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
        // NO background-color here, deliberately. Safari 26 tints its
        // toolbar from the background-color of fixed/sticky elements at the
        // viewport edges; background-image is ignored, and elements without
        // a background-color are skipped entirely — the sampler falls
        // through to body's #131110, which is the correct brand colour.
        // Adding one would be redundant for the sampler and, through the
        // screen blend below, would lift the whole content field a couple
        // of RGB points against the masked-out safe-area zones — recreating
        // the seam this component's mask exists to remove. Refs:
        // nasedk.in/blog/ios26-safari-toolbar-colors, WebKit bug 301756.
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        // zIndex -1: behind all app content. A negative z-index on a direct
        // child of <body> paints above the page base background but below the
        // in-flow app, so transparent screens reveal it and opaque cards
        // cover it. mix-blend-mode: screen blends with the page base painted
        // beneath this layer (#131110 + desktop gradients) — NOT with the
        // cards above it — so the warm grain lift lands on the field only.
        zIndex: -1,
        opacity: 0.12,
        mixBlendMode: "screen",
        backgroundImage: `url("data:image/svg+xml,${GRAIN_SVG}")`,
        backgroundRepeat: "repeat",
        backgroundSize: "192px 192px",
        // Fade the grain to zero through the top status-bar safe-area and the
        // bottom home-indicator chin, ramping over a long 80px easing band so
        // the texture DISSOLVES into the flat #131110 reserved zones instead
        // of butting against them. The earlier 24px ramp was too short — the
        // luminance step still read as an abrupt line right under the clock
        // (the seam the user reported). 80px makes the transition perceptually
        // gradient-free. env() resolves to real insets only in standalone w/
        // viewport-fit:cover; in-browser it's 0, so the top stop collapses to
        // a 0→80px fade from the very top — harmless, since in-browser there's
        // no reserved zone to blend against anyway.
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0, transparent env(safe-area-inset-top, 0px), #000 calc(env(safe-area-inset-top, 0px) + 80px), #000 calc(100% - env(safe-area-inset-bottom, 0px) - 80px), transparent calc(100% - env(safe-area-inset-bottom, 0px)))",
        maskImage:
          "linear-gradient(to bottom, transparent 0, transparent env(safe-area-inset-top, 0px), #000 calc(env(safe-area-inset-top, 0px) + 80px), #000 calc(100% - env(safe-area-inset-bottom, 0px) - 80px), transparent calc(100% - env(safe-area-inset-bottom, 0px)))",
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
