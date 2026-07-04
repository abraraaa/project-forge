"use client";

// app/@overlay/(.)performance/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Intercepting route (PR3 stage C). When the user navigates from Home to
// /performance via the client router, Next intercepts it into the @overlay
// parallel slot and renders Performance Lab as a full-screen overlay OVER a
// still-mounted Home — preserving Home's scroll natively. A direct visit /
// hard reload falls through to app/performance/page.jsx.
//
// Structure matters for Safari 26 chrome (same doctrine as .forge-scrim):
// the FIXED container paints nothing — a fixed edge element carrying a
// background re-tints Safari's chrome (the Lab chin report). All paint
// lives on an inner .forge-page wrapper, which also reconstitutes the full
// substrate (base + grain via GrainOverlay) inside the overlay, so the
// Lab looks identical whether it arrives intercepted or as the real route.
// The wrapper is in-flow inside the internal scroller, so it grows with
// the content and the grain covers the whole scrollable height.
//
// Known, accepted: an overlay's internal scroller can never get Safari's
// status-bar scroll-under (root-scroller-only behaviour). The unlock is
// parked as "instant home hydration" — see docs/parked.md.
// ─────────────────────────────────────────────────────────────────────────────

import PerformanceLabView from "@/components/PerformanceLabView";
import GrainOverlay from "@/components/GrainOverlay";

export default function PerformanceOverlay() {
  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 300,
      overflowY: "auto",
      overscrollBehavior: "contain",
    }}>
      <div className="forge-page">
        <GrainOverlay />
        <PerformanceLabView />
      </div>
    </div>
  );
}
