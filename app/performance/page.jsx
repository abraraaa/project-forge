// app/performance/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Full-page Performance Lab — the NON-intercepted route, hit on a direct visit
// / deep-link / hard reload of /performance (no Home to overlay). In-app
// navigation from Home is intercepted by app/@overlay/(.)performance and
// rendered as an overlay instead (Home stays mounted underneath — PR3 stage C).
// Both render the same PerformanceLabView.
// ─────────────────────────────────────────────────────────────────────────────

export const metadata = {
  title: "Performance Lab",
  description:
    "Per-muscle volume against MEV/MAV/MRV, 8-week sparklines, a consistency grid, and 1RM trends. See exactly where your training is working.",
};

import PerformanceLabView from "@/components/PerformanceLabView";

export default function PerformancePage() {
  return <PerformanceLabView />;
}
