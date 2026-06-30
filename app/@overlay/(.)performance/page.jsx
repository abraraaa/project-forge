"use client";

// app/@overlay/(.)performance/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Intercepting route (PR3 stage C). When the user navigates from Home to
// /performance via the client router, Next intercepts it into the @overlay
// parallel slot and renders Performance Lab as a full-screen overlay OVER a
// still-mounted Home — instead of unmounting Home for a sibling route. Result:
// Home's scroll position is preserved natively (no remount, no mount-guard
// collapse, no restore-then-jump flicker). The URL still becomes /performance,
// and a direct visit / hard reload falls through to app/performance/page.jsx
// (the non-intercepted full page).
//
// The overlay is position:fixed + opaque app background + high z-index so it
// fully covers Home; it owns its own scroll. router.back() (back-link or iOS
// swipe) pops the interception, unmounts the overlay, and reveals Home exactly
// as it was left.
// ─────────────────────────────────────────────────────────────────────────────

import PerformanceLabView from "@/components/PerformanceLabView";

export default function PerformanceOverlay() {
  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 300,
      background: "#131110",
      overflowY: "auto",
      overscrollBehavior: "contain",
    }}>
      <PerformanceLabView />
    </div>
  );
}
