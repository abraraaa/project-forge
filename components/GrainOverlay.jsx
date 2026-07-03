// GrainOverlay — a Kodak Portra-style warm grain FIELD that sits BEHIND the
// app content (zIndex -1) and scrolls WITH the page. Pure-CSS / inline SVG;
// no asset to ship; mounted once inside the .forge-page wrapper in
// app/layout.jsx.
//
// Why behind, not on top: at zIndex 1 the screen-blended grain composited
// over EVERYTHING below the modal layer — including card faces, buttons and
// text — so the whole UI read as "one photo" and, worse, the grain's bright
// edge against the flat iOS-reserved status-bar zone produced a hard seam
// (see docs/parked.md). As a zIndex -1 field it screen-blends only with the
// page base (#131110 + the desktop ambient gradients) painted beneath it, so
// cards sit ON the texture as physical objects.
//
// Why position: absolute (inside .forge-page), NOT fixed: Safari 26 decides
// how to render its chrome from the fixed/sticky elements at the viewport
// edges. When any fixed element borders an edge, Safari paints an OPAQUE
// colour-extension slab behind the status bar / URL bar instead of the
// translucent scroll-under treatment (WebKit bug 301756; nasedk.in/blog/
// ios26-safari-toolbar-colors; jahir.dev/blog/safari-toolbar). As a
// full-viewport fixed layer this component bordered BOTH edges on every
// screen, opting the entire app out of chrome translucency — and because it
// had no background-color to sample, Safari's tint choice went unpredictable
// (observed: the toolbar adopting the peach Begin-session CTA scrolled near
// the bottom edge). Absolute inside the document-height .forge-page wrapper,
// the grain is ordinary scrolling page content: no fixed element at the
// edges, chrome tint falls back to body's solid #131110, and content slides
// under the translucent bars natively. Do NOT reintroduce position: fixed
// here — it silently reverts the whole app to opaque chrome slabs.
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
      className="forge-grain"
      style={{
        // NO background-color, deliberately: the layer screen-blends at 12%
        // opacity, so any backing colour would lift the whole field a couple
        // of RGB points against the masked-out edges — a faint band of the
        // seam class the mask below exists to remove.
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        // zIndex -1: behind all app content. .forge-page is isolation:
        // isolate (its own stacking context), so this paints AFTER the
        // wrapper's own background and before its in-flow content — i.e.
        // above the page substrate (#131110 + desktop gradients, both on
        // .forge-page), below the app. The isolation is load-bearing: in
        // the root stacking context a negative-z grandchild paints beneath
        // BODY's background, which occluded the grain for the first 100vh
        // of every page (the "blocking halfway down" band, found on
        // device). mix-blend-mode: screen blends with the substrate — not
        // the cards above — so the warm grain lift lands on the field only.
        zIndex: -1,
        opacity: 0.12,
        mixBlendMode: "screen",
        backgroundImage: `url("data:image/svg+xml,${GRAIN_SVG}")`,
        backgroundRepeat: "repeat",
        backgroundSize: "192px 192px",
        // Dissolve the grain over the first 80px of the DOCUMENT (the
        // wrapper is document-height, so this is the page top, not the
        // viewport edge). At rest in the installed PWA this reproduces the
        // previous env()-anchored fade exactly — body's standalone
        // padding-top already places the wrapper below the clock, so 0→80px
        // here lands where env(inset)→env(inset)+80px landed before.
        // Top-only, deliberately: an earlier symmetric fade at the document
        // END dissolved the texture over the last 80px of every page, which
        // read as a flat self-made "chin" at full scroll. Content now slides
        // under the translucent chrome, so the texture should run flush to
        // the page end; overscroll past it shows the flat body base, which
        // is the native rubber-band look.
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0, #000 80px)",
        maskImage:
          "linear-gradient(to bottom, transparent 0, #000 80px)",
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
