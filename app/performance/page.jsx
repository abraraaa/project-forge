// app/performance/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Full-page Performance Lab — the NON-intercepted route, hit on a direct visit
// / deep-link / hard reload of /performance (no Home to overlay). In-app
// navigation from Home is intercepted by app/@overlay/(.)performance and
// rendered as an overlay instead (Home stays mounted underneath — PR3 stage C).
// Both render the same PerformanceLabView.
// ─────────────────────────────────────────────────────────────────────────────

import PerformanceLabView from "@/components/PerformanceLabView";

export default function PerformancePage() {
  return <PerformanceLabView />;
}
