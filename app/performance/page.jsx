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
  // ssr:false shell — a crawler receives an empty document (~70 chars of
  // body, measured 2026-08-17). Indexing it would publish a blank result and
  // spend crawl budget on an app surface, so we ask for neither. `follow`
  // stays on: nothing is hidden, it simply is not a page to rank.
  // Same reasoning that already excludes /session. The readable version of
  // this story lives on /volume-landmarks and /anatomy.
  robots: { index: false, follow: true },
};

import { PerformanceLabShell } from "@/components/client-shells";

export default function PerformancePage() {
  return <PerformanceLabShell />;
}
